import type { Actuator } from "./actuator";
import type { Timers } from "./service";

// Holds the one driver process Reach uses: prepared (downloaded and verified) on request, started when something needs it, and let go again
// when nothing has used it for a while, so the driver is never left running for no reason. Concurrent callers share one start.
//
// The driver drives one screen, so only one holder works at a time: an agent's call and the background exploration queue behind each other
// (a waiting call gives up with `gui_busy` after a while instead of hanging). While someone holds the driver it is never released under
// them: an idle timer re-arms, and `release()` is carried out when the holder is done.

export interface ActuatorManagerPorts<Install> {
  provision(): Promise<Install>;
  start(install: Install): Promise<Actuator>;
  timers: Timers;
  idleReleaseMs?: number;
  // How long a caller waits for the driver while another holder works.
  waitMs?: number;
}

export type Ready = { ok: true; actuator: Actuator } | { ok: false; error: string };
export type Lease = { ok: true; actuator: Actuator; done(): Promise<void> } | { ok: false; error: string };

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
  return error instanceof Error ? error.name : "driver_unavailable";
}

export class ActuatorManager<Install> {
  private install: Install | null = null;
  private actuator: Actuator | null = null;
  private starting: Promise<Ready> | null = null;
  private preparing: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  private idle: unknown = null;
  private readonly idleMs: number;
  private readonly waitMs: number;
  // The queue of holders: each waits for the one before it.
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;
  private releaseWanted = false;

  constructor(private readonly p: ActuatorManagerPorts<Install>) {
    this.idleMs = p.idleReleaseMs ?? 3 * 60_000;
    this.waitMs = p.waitMs ?? 20_000;
  }

  prepare(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.install) return Promise.resolve({ ok: true });
    this.preparing ??= (async () => {
      try { this.install = await this.p.provision(); return { ok: true as const }; }
      catch (error) { return { ok: false as const, error: codeOf(error) }; }
      finally { this.preparing = null; }
    })();
    return this.preparing;
  }

  ensure(): Promise<Ready> {
    if (this.actuator) { this.armIdle(); return Promise.resolve({ ok: true, actuator: this.actuator }); }
    this.starting ??= (async (): Promise<Ready> => {
      try {
        const prepared = await this.prepare();
        if (!prepared.ok) return prepared;
        const actuator = await this.p.start(this.install as Install);
        this.actuator = actuator;
        this.armIdle();
        return { ok: true, actuator };
      } catch (error) {
        return { ok: false, error: codeOf(error) };
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  // Waits for its turn. null: another holder kept the driver for the whole wait.
  private takeTurn(): Promise<(() => void) | null> {
    const previous = this.tail;
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => { finish = resolve; });
    this.tail = previous.then(() => mine);
    return new Promise((resolve) => {
      let settled = false;
      const handle = this.p.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        // The place in the queue is still ours; pass it on as soon as it comes up.
        void previous.then(finish);
        resolve(null);
      }, this.waitMs);
      void previous.then(() => {
        if (settled) return;
        settled = true;
        this.p.timers.clearTimeout(handle);
        resolve(finish);
      });
    });
  }

  // The driver for one piece of work, started if needed. Call `done()` when finished.
  async acquire(): Promise<Lease> {
    const finish = await this.takeTurn();
    if (!finish) return { ok: false, error: "gui_busy" };
    this.holders += 1;
    this.disarmIdle();
    let ended = false;
    const end = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      this.holders -= 1;
      finish();
      if (this.holders === 0 && this.releaseWanted) await this.close();
      else if (this.actuator) this.armIdle();
    };
    const ready = await this.ensure();
    if (!ready.ok) { await end(); return ready; }
    this.disarmIdle();
    return { ok: true, actuator: ready.actuator, done: end };
  }

  // Run something with the driver and keep it alive a little longer afterwards.
  async use<T>(work: (actuator: Actuator) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const lease = await this.acquire();
    if (!lease.ok) return lease;
    try { return { ok: true, value: await work(lease.actuator) }; } finally { await lease.done(); }
  }

  get running(): boolean { return this.actuator !== null; }

  private disarmIdle(): void {
    if (this.idle !== null) { this.p.timers.clearTimeout(this.idle); this.idle = null; }
  }

  private armIdle(): void {
    this.disarmIdle();
    this.idle = this.p.timers.setTimeout(() => {
      this.idle = null;
      // Someone is working with it: look again later instead of closing it under them.
      if (this.holders > 0) { this.armIdle(); return; }
      void this.close();
    }, this.idleMs);
  }

  // Let the driver go: now if nobody works with it, otherwise when the one who does is done.
  async release(): Promise<void> {
    if (this.holders > 0) { this.releaseWanted = true; return; }
    await this.close();
  }

  // Quit: close it whatever is going on.
  async shutdown(): Promise<void> {
    await this.close();
  }

  private async close(): Promise<void> {
    this.releaseWanted = false;
    this.disarmIdle();
    const actuator = this.actuator;
    this.actuator = null;
    if (actuator) await actuator.close().catch(() => undefined);
  }
}
