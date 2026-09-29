/** Latest owner toggle wins while enabling awaits remote entitlement checks. Disable never waits. */
export class AliveOwnerIntentGate {
  private readonly pending = new Map<string, symbol>();

  async run<T>(scopeKey: string, enabled: boolean, actions: {
    refreshAccess: () => Promise<unknown>;
    read: () => T;
    apply: () => T;
  }): Promise<T> {
    const intent = Symbol();
    this.pending.set(scopeKey, intent);
    try {
      if (enabled) {
        await actions.refreshAccess();
        // A later toggle (including an already-completed disable) supersedes this enable.
        if (this.pending.get(scopeKey) !== intent) return actions.read();
      }
      return actions.apply();
    } finally {
      if (this.pending.get(scopeKey) === intent) this.pending.delete(scopeKey);
    }
  }
}
