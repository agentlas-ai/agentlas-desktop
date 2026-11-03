/** A bounded withdrawal fence for client-minted, connection-scoped video transfer IDs. */
export class VideoCancelFence {
  private readonly connections = new Map<string, { until: number; all: boolean; ids: Map<string, number> }>();
  private blockAllUntil = 0;
  constructor(private readonly now: () => number = Date.now) {}
  private key(principal: { deviceId: string; connectionId: string }): string {
    return `${principal.deviceId}\0${principal.connectionId}`;
  }
  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.connections) {
      if (record.until <= now) { this.connections.delete(key); continue; }
      for (const [id, until] of record.ids) if (until <= now) record.ids.delete(id);
    }
  }
  /** Reject new work until cancellation evidence for this exact owner/ID has expired. */
  assertOpen(principal: { deviceId: string; connectionId: string }, id: string): void {
    this.prune();
    if (!/^[0-9a-f]{64}$/.test(id) || this.blockAllUntil > this.now()) throw new Error("video_cancelled");
    const record = this.connections.get(this.key(principal));
    if (record && (record.all || record.ids.has(id))) throw new Error("video_cancelled");
  }
  cancel(principal: { deviceId: string; connectionId: string }, id: string): void {
    if (!/^[0-9a-f]{64}$/.test(id)) return;
    const record = this.record(principal);
    if (!record) return;
    if (record.ids.size >= 256 && !record.ids.has(id)) { record.all = true; record.ids.clear(); }
    if (!record.all) record.ids.set(id, this.now() + 10 * 60_000);
  }
  cancelConnection(principal: { deviceId: string; connectionId: string }): void {
    const record = this.record(principal);
    if (record) { record.all = true; record.ids.clear(); }
  }
  private record(principal: { deviceId: string; connectionId: string }): { until: number; all: boolean; ids: Map<string, number> } | null {
    this.prune();
    const until = this.now() + 10 * 60_000, key = this.key(principal);
    let record = this.connections.get(key);
    if (!record && this.connections.size >= 128) {
      // Capacity exhaustion fails closed for new opens, never for close/read of an existing transfer.
      this.blockAllUntil = Math.max(this.blockAllUntil, until);
      return null;
    }
    if (!record) { record = { until, all: false, ids: new Map() }; this.connections.set(key, record); }
    else record.until = Math.max(record.until, until);
    return record;
  }
}
