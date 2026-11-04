/**
 * Whether a failed native browser grant ends the run or the run goes on without the browser.
 *
 * The grant is the app's own broker answering (observed in useZ, One conversation, codex: "native-browser-broker-timeout"
 * after 25 s). The browser is a baseline capability of a One turn and a selection's pick, not something the owner asked for in
 * every message, so a grant that cannot be made must not end a turn before any model ran ("mcp-runtime-config-unavailable").
 * A run that NEEDS the browser (the owner chose the browser tool mode, a graph or automation declared it required) keeps the
 * refusal, and the owner's own Stop is never turned into a degraded run. Pure; the same rule for every runtime and host.
 */
export function nativeBrowserGrantFailureDegrades(input: {
  /** The grant's signal was aborted: the owner's Stop (or the end of the run). */
  aborted: boolean;
  /** The owner's browser tool mode (`toolMode: "browser"`, the run's effective tool mode). */
  browserToolMode: boolean;
  /** Catalog ids the caller declared required (graph step, automation). */
  requiredToolCatalogIds?: readonly string[] | null;
}): boolean {
  if (input.aborted || input.browserToolMode) return false;
  return !(input.requiredToolCatalogIds ?? []).includes("agentlas-browser");
}
