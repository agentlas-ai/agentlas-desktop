/*
 * "A road of this computer may have changed": the one in-process signal that makes desktop-paths measure again (decision; no timer anywhere).
 * Raised where the fact changes: a program installed, removed, enabled or disabled (mcp-tools/registry.ts), an OS permission or login import.
 * The listener (connectors/main-wiring.ts) re-measures and the places link reports only a CHANGED set. Pure; no imports, safe in every process (the background service loads the registry).
 * With nobody listening (the routing switch off) a signal does nothing.
 */
const listeners = new Set<() => void>();
export function onRoadsMaybeChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function signalRoadsMaybeChanged(): void { for (const listener of [...listeners]) { try { listener(); } catch { /* a listener never changes the registry's answer */ } } }
