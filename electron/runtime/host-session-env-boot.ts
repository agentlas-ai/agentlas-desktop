// First import of every Desktop host process (Main, daemon): a host agent session's own variables never reach a
// runtime Agentlas spawns (runtime-builtin-egress-policy.ts scrubHostSessionEnv). Runs before any module reads
// process.env; every runner env (buildRunnerEnv, spawnCli/envForCli) derives from it.
import { scrubHostSessionEnv } from "./runtime-builtin-egress-policy";

export const HOST_SESSION_ENV_DROPPED: readonly string[] = scrubHostSessionEnv(process.env);
if (HOST_SESSION_ENV_DROPPED.length > 0) {
  console.info(`[host-session-env] dropped=${HOST_SESSION_ENV_DROPPED.length} names=${HOST_SESSION_ENV_DROPPED.join(",")}`);
}
