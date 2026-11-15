import { cliSilenceWindowMs, cliToolSilenceWindowMs, RUNTIME_SILENT_TIMEOUT_CODE } from "../runtime/runner";

/*
 * The one silence limit of every layer that WAITS FOR a runner (a room's member turn, a discussion speaker, a team node, a borrowed
 * agent) — Agentlas 2.0 desktop values S2 (audit "values we set", wrong pairs da-1/da-2, found risks ga-2/ga-3/ga-12).
 *
 * Before, each of those layers had its own number (10 min, 6 min absolute, 30 min) shorter than the runner's own silence window
 * (20 min, 90 min while a tool call is in flight): the outer clock cut a turn the runner still held alive (a long render or build),
 * with no word. The runner is the one that sees the child process (heartbeat, silence guard, tool in flight, exit); an outer layer
 * only follows it. So the outer limit is DERIVED, never set: it is the runner's longest silence window plus the time the runner's
 * own guard needs to notice and settle. Inside that, the runner always ends the turn first and says why (`runtime_silent_timeout`);
 * the outer limit fires only for a runner that has no guard of its own (and then with the same word).
 *
 * basis: derived from runtime/runner.ts (cliToolSilenceWindowMs, cliSilenceWindowMs and the guard's own check interval).
 * on reaching it: the layer cancels the run and ends the turn failed with RUNTIME_SILENT_TIMEOUT_CODE (shown in the room line).
 * A heartbeat is not progress (the runner's rule), so it does not renew this limit either; a real event does.
 * The tests shorten it with AGENTLAS_CLI_TOOL_SILENCE_WINDOW_MS / AGENTLAS_CLI_SILENCE_WINDOW_MS, the runner's own environment values.
 */

/** The closed word of a turn the host ended for silence (the runner's own word; one spelling). */
export const OUTER_SILENCE_CODE = RUNTIME_SILENT_TIMEOUT_CODE;

/** The runner's guard checks every min(30 s, window / 4) (at least 20 ms): two checks plus its settle is the time it needs to speak first. */
function runnerGuardCheckMs(env: NodeJS.ProcessEnv): number {
  return Math.max(20, Math.min(30_000, Math.floor(cliSilenceWindowMs(env) / 4)));
}

export function outerSilenceLimitMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(cliSilenceWindowMs(env), cliToolSilenceWindowMs(env)) + 2 * runnerGuardCheckMs(env);
}
