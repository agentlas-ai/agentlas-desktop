/**
 * Typed causes OUTSIDE the app that end a dispatched turn without a terminal receipt and that time (not the owner, not a
 * different model) clears: the provider could not take the request mid-turn ("Selected model is at capacity", a server
 * failure, a lost response stream) or the host ended an attempt whose stream the provider left silent.
 *
 * observed in use (codex, 4 runs): the provider answered "at capacity" in the middle of a long Goal turn that had
 * already run 240-300 tool calls; the run ended `runtime_turn_unsettled` and the owner saw a failure card for a turn whose
 * work was in the session. Such a turn is exactly what the same-session continuation exists for (the session holds the work;
 * "repeat nothing done"), so it gets the same single continuation as an unsettled one, after a short wait.
 *
 * A closed list of machine codes from typed runner failures, never prose. Pure: no Electron, Node or renderer imports.
 */
import { PROVIDER_UNAVAILABLE_CODES } from "./run-failure-notice";

/** The code of a stream the host ended after the provider stayed silent (runtime/runner.ts RUNTIME_SILENT_TIMEOUT_CODE). */
export const TRANSIENT_HOST_ENDED_SILENCE_CODE = "runtime_silent_timeout";

const TRANSIENT_EXTERNAL_CODES: ReadonlySet<string> = new Set([...PROVIDER_UNAVAILABLE_CODES, TRANSIENT_HOST_ENDED_SILENCE_CODE]);

/** Wait before the one continuation: the provider's own client already retried; an immediate resend meets the same wall. */
export const TRANSIENT_CONTINUATION_DELAY_MS = 20_000;

/** Whether a typed runner failure is a transient cause outside the app (see the module comment). `source` must be a marker. */
export function isTransientExternalFailure(failure: { providerCode?: string | null; source?: string } | null | undefined): boolean {
  return Boolean(failure && failure.source === "marker" && typeof failure.providerCode === "string"
    && TRANSIENT_EXTERNAL_CODES.has(failure.providerCode));
}
