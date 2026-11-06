/**
 * Finance source reads that do not change within a short window are made once.
 *
 * ReadCache: a bounded read-through cache for public GET reads, with one shared in-flight read per key. A failed read is never kept,
 * and a caller that gives up (its signal aborts) stops waiting without cancelling the read for the others; the read itself is
 * cancelled only when nobody is waiting for it any more. mapLimit runs independent reads side by side without changing their order.
 * Nothing here knows a provider, a credential or an owner: callers key the cache by the exact URL they were going to fetch.
 */
export interface ReadOptions {
  signal?: AbortSignal;
  /** Skip a stored answer (an explicit owner refresh). A read already in flight is joined: it started moments ago. */
  fresh?: boolean;
  /** This read's lifetime in the cache, when it differs from the cache's default. 0 stores nothing. */
  ttlMs?: number;
}
interface Flight<T> { promise: Promise<T>; controller: AbortController; waiters: number }
const cancelled = () => new Error('finance_read_cancelled');
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const bodyLength = (value: unknown): number => { const body = (value as { body?: unknown } | null)?.body; return typeof body === 'string' ? body.length : 0; };

export class ReadCache<T> {
  private readonly entries = new Map<string, { at: number; ttlMs: number; value: T; bytes: number }>();
  private readonly flights = new Map<string, Flight<T>>();
  private bytes = 0;
  /** `max` bounds the entry count and `maxBytes` (32 MiB unless given) the text they hold; `sizeOf` measures a value (the length of its `body` text unless given). */
  constructor(private readonly options: { ttlMs: number; max: number; maxBytes?: number; sizeOf?: (value: T) => number; now?: () => number }) {}
  private drop(key: string): void { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); } }
  private now(): number { return (this.options.now ?? Date.now)(); }
  /** What is stored for `key` and still fresh, without reading. */
  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= entry.ttlMs) { this.drop(key); return undefined; }
    return entry.value;
  }
  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  async get(key: string, load: (signal: AbortSignal) => Promise<T>, options: ReadOptions = {}): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) throw cancelled();
    if (!options.fresh) { const stored = this.peek(key); if (stored !== undefined) return stored; }
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController(), created: Flight<T> = { controller, waiters: 0, promise: undefined as unknown as Promise<T> };
      created.promise = (async () => {
        try {
          const value = await load(controller.signal);
          const ttlMs = options.ttlMs ?? this.options.ttlMs;
          // A read that was cancelled for lack of waiters stores nothing.
          if (ttlMs > 0 && !controller.signal.aborted) {
            const bytes = (this.options.sizeOf ?? bodyLength)(value), maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
            this.drop(key);
            // One answer larger than the whole byte bound is returned to its callers and not kept.
            if (bytes <= maxBytes) {
              this.entries.set(key, { at: this.now(), ttlMs, value, bytes }); this.bytes += bytes;
              while (this.entries.size > this.options.max || this.bytes > maxBytes) this.drop(this.entries.keys().next().value!);
            }
          }
          return value;
        } finally { if (this.flights.get(key) === created) this.flights.delete(key); }
      })();
      // An abandoned read can reject with nobody listening; the waiters below own the rejection.
      created.promise.catch(() => undefined);
      this.flights.set(key, created); flight = created;
    }
    const shared = flight; shared.waiters++;
    let release: (() => void) | undefined;
    try {
      const waiting = signal ? new Promise<never>((_, reject) => {
        const stop = () => reject(cancelled());
        signal.addEventListener('abort', stop, { once: true }); release = () => signal.removeEventListener('abort', stop);
      }) : null;
      return await (waiting ? Promise.race([shared.promise, waiting]) : shared.promise);
    } finally {
      release?.(); shared.waiters--;
      if (shared.waiters === 0 && this.flights.get(key) === shared) { shared.controller.abort(); this.flights.delete(key); }
    }
  }
}

/** `fn` over `items` with at most `limit` running at once; results keep the order of `items`. The first rejection stops new starts and is rethrown. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failure: { error: unknown } | null = null;
  const worker = async () => {
    for (;;) {
      if (failure) return;
      if (signal?.aborted) throw cancelled();
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await fn(items[index], index); } catch (error) { failure ??= { error }; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

/** A counting gate for concurrent requests to one provider: callers wait their turn instead of being refused. */
export class Slots {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly size: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw cancelled();
    // A queued caller is counted the moment its turn comes, so nobody arriving in between can take its place.
    if (this.active < this.size) this.active++;
    else await new Promise<void>((resolve, reject) => {
      const turn = () => { signal?.removeEventListener('abort', stop); this.active++; resolve(); };
      const stop = () => { const at = this.queue.indexOf(turn); if (at >= 0) this.queue.splice(at, 1); reject(cancelled()); };
      this.queue.push(turn); signal?.addEventListener('abort', stop, { once: true });
    });
    let released = false;
    return () => { if (released) return; released = true; this.active--; this.queue.shift()?.(); };
  }
}
