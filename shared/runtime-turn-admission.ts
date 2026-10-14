/**
 * A prior turn's result is context for a new turn, not an admission lock.
 * Same-request replay is a separate contract owned by runtime/selection.
 * Keep the automatic no-progress loop stopped until a new owner decision.
 * This module stays independent of providers, Electron and durable stores.
 */
export function runtimeFailureBlocksNextAutomaticTurn(
  failure: { providerCode?: string } | null | undefined,
): boolean {
  return failure?.providerCode === "automation_no_progress_loop";
}
