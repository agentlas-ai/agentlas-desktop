/** Main-only supervisor that re-attaches the Desktop <-> daemon native channel after it closes
 * while the app is running. One attach at a time, exponential backoff (1 s .. 30 s), and it
 * stops for good once the app begins quitting. Each attach is a new generation; this module
 * owns only scheduling. Rebinding controls/bridge and start availability live in the ports. */
export const NATIVE_REATTACH_BASE_MS = 1000;
export const NATIVE_REATTACH_MAX_MS = 30000;
type Closable = { onClose(listener: () => void): () => void };
export interface NativeChannelReattachPorts {
  /** Reads the daemon's current boot id (public ping); throws while the daemon is unreachable. */
  discoverBoot(): Promise<string>;
  /** One full attach for that boot (new channel, rebinds, refresh). Resolves only when starts are ready. */
  attach(bootId: string): Promise<void>;
  /** The channel currently owned by the enrollment; closes of any other channel are ignored. */
  currentChannel(): Closable | undefined;
  isQuitting(): boolean;
  log(line: string): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}
export function createNativeChannelReattacher(ports: NativeChannelReattachPorts) {
  const setTimer = ports.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
  const clearTimer = ports.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown, running = false, stopped = false, failures = 0, attempts = 0, closedWhileRunning = false, requestedWhileRunning = false;
  const watched = new WeakSet<object>();
  const unwatch = new Set<() => void>();
  const delay = () => Math.min(NATIVE_REATTACH_MAX_MS, NATIVE_REATTACH_BASE_MS * 2 ** Math.min(failures, 16));
  function schedule(reason: string): void {
    if (stopped || timer !== undefined || running) return;
    if (ports.isQuitting()) { ports.log(`[native-invocation] re-attach stopped for good: app quitting (${reason})`); stop(); return; }
    const ms = delay();
    ports.log(`[native-invocation] re-attach scheduled in ${ms}ms (${reason})`);
    timer = setTimer(() => { timer = undefined; void run(); }, ms);
  }
  async function run(): Promise<void> {
    if (stopped || running) return;
    if (ports.isQuitting()) { stop(); return; }
    running = true; const attempt = ++attempts;
    try {
      ports.log(`[native-invocation] re-attach attempt ${attempt} begin`);
      const bootId = await ports.discoverBoot();
      if (stopped || ports.isQuitting()) { stop(); ports.log(`[native-invocation] re-attach attempt ${attempt} abandoned: app quitting`); return; }
      await ports.attach(bootId);
      failures = 0;
      ports.log(`[native-invocation] re-attach attempt ${attempt} succeeded`);
    } catch (error) {
      failures++;
      ports.log(`[native-invocation] re-attach attempt ${attempt} failed: ${error instanceof Error ? error.message : "unknown_error"}`);
    } finally { running = false; }
    if (stopped) return;
    const requested = requestedWhileRunning; requestedWhileRunning = false;
    const channel = ports.currentChannel();
    if (channel && failures === 0) { watch(channel); if (closedWhileRunning || requested) { closedWhileRunning = false; schedule(requested ? "requested during attach" : "channel closed during attach"); } }
    else { closedWhileRunning = false; schedule("retry"); }
  }
  /** Watch a channel; its close (while it is still the current one) starts the loop. */
  function watch(channel: Closable): void {
    if (stopped || watched.has(channel)) return;
    watched.add(channel);
    let off: (() => void) | undefined;
    off = channel.onClose(() => {
      if (off) unwatch.delete(off);
      if (stopped || ports.currentChannel() !== channel) return;
      if (running) { closedWhileRunning = true; return; }
      schedule("channel closed");
    });
    if (off && !stopped) unwatch.add(off);
  }
  function trigger(reason = "requested"): void {
    if (stopped) return;
    if (ports.isQuitting()) { ports.log(`[native-invocation] re-attach stopped for good: app quitting (${reason})`); stop(); return; }
    // Availability can change after attach's final snapshot but before it
    // resolves. Preserve that source request; never overlap two attaches.
    if (running) { requestedWhileRunning = true; return; }
    schedule(reason);
  }
  function stop(): void {
    stopped = true; requestedWhileRunning = false; closedWhileRunning = false; if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    for (const off of unwatch) off(); unwatch.clear();
  }
  return Object.freeze({ watch, stop, trigger,
    get state() { return Object.freeze({ running, stopped, failures, attempts, scheduled: timer !== undefined }); } });
}
