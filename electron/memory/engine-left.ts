// What an engine answer says it LEFT, and why (Agentlas 2.0, desktop repair 6; engine pair: Agentlas-OS `5759824d`, "W1").
//
// The engine's `forget`, `forget-agent`, `forget-project` and `one_pack import` / `purge` answer `left: ["views", ...]` when the derived view files could not be written again, and (engine 5759824d)
// `leftReasons: {views: <code>}` beside it: `views_path_too_long` (the path cannot be opened on this machine even with the extended prefix: the same call fails the same way every time, so trying again
// changes nothing), `views_file_busy` (another program holds a view file: it passes) or `views_retry` (anything else: tried again at the next write). An engine without the column gives no reasons and every
// code is retried as before.
//
// WHO READS: `store-delete.ts` (project forget), `agents/agent-forget.ts` (agent forget), `one/bundle.ts` (import, purge). WHAT IT STORES: nothing. The one thing it writes is an in-memory open code
// (`noteForgetCodes`, up to 16, the memory screen's existing list, gone when the app closes) for a left that ends here.
export const VIEWS_PATH_TOO_LONG = "views_path_too_long";
export type LeftReasons = Record<string, string>;

/** The engine's `leftReasons` map, kept only when it is a small object of lower-case machine codes; anything else is no answer. */
export function readLeftReasons(json: unknown): LeftReasons | undefined {
  const raw = json && typeof json === "object" ? (json as { leftReasons?: unknown }).leftReasons : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: LeftReasons = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (/^[a-z][a-z0-9_]{0,31}$/.test(key) && typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Is this left code one that no retry changes (the engine said so)? */
export function leftEndsHere(code: string, reasons: LeftReasons | undefined): boolean { return reasons?.[code] === VIEWS_PATH_TOO_LONG; }
/** The codes of `left` that a later try can still change (everything the engine did not say ends here). */
export function leftToRetry(left: readonly string[], reasons: LeftReasons | undefined): string[] { return left.filter((code) => !leftEndsHere(code, reasons)); }

/** Leaves the reason of a left that ends here where the memory screen already looks (an open code, in memory only). Never throws. */
export function noteLeftThatEndsHere(left: readonly string[], reasons: LeftReasons | undefined): void {
  const codes = [...new Set(left.filter((code) => leftEndsHere(code, reasons)).map((code) => reasons![code]))];
  if (!codes.length) return;
  try { (require("./forget-stores") as typeof import("./forget-stores")).noteForgetCodes(codes); } catch { /* the code is also in the answer */ } // eslint-disable-line @typescript-eslint/no-require-imports
}
