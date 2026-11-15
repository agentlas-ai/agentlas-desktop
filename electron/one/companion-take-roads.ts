/**
 * Desktop E2E-1 (D3): which road takes a phone's work for THIS computer, as one closed word, and the one trace line when a switch is on and no road can take it.
 *
 * The roads (companion switches; a switch that is not exactly `enabled` is off):
 *   `main_intake`      WORK_V2, the personal domain is in Main (no background service, or not handed over yet): Main's own 5 s sweep takes the work and runs it (supervisor.ts, companion-direct-intake-runtime.ts).
 *   `gui_coordinator`  WORK_V2 + GUI_LEASE_V1, the domain is in the background service: Main takes the work (companion-gui-runtime.ts, after the home and pairing doors), asks the server for the start and hands the service a one-use lease;
 *                      the service runs it. The server sees this computer "on" by Main's signed poll only (web `directSeenAt`).
 *   `none_daemon_domain_without_gui_lease`
 *                      WORK_V2 with GUI_LEASE_V1 explicitly `disabled` while the background service holds the domain. Main's intake was stopped by the hand-over and the service never takes direct work (it cannot read the home or the pairing: companion-direct-intake-runtime.ts
 *                      throws `companion_intake_gui_only`), so NOTHING takes the work - and, because the server counts a computer as on only by a poll, the server's friend answers for it. This state used to be silent. It is a closed word now.
 * The front road (FRONT_GUI_V1) is Main's own and does not depend on where the domain is.
 * Nothing here asks the server, starts a timer or reads a text. One main.log line per change of the word.
 */
export type TakeRoadWord = "off" | "main_intake" | "gui_coordinator" | "none_daemon_domain_without_gui_lease";

/**
 * decision (coordinator): `AGENTLAS_COMPANION_WORK_V2` on means the road that works while the background service holds the personal domain (the GUI coordinator: Main takes, the service runs) is on too.
 * `AGENTLAS_COMPANION_GUI_LEASE_V1` is no longer a second switch to remember: `disabled` turns the road off (the way back), `enabled` still turns it on by itself (as before, even without WORK_V2), anything else follows WORK_V2.
 * The front road (`AGENTLAS_COMPANION_FRONT_GUI_V1`) is not touched. Read by main.ts (the coordinator) and supervisor.ts (the service builds its lease runtime instead of the direct intake).
 */
export function guiLeaseRoadOn(env: NodeJS.ProcessEnv): boolean {
  const v = env.AGENTLAS_COMPANION_GUI_LEASE_V1;
  return v === "enabled" || (env.AGENTLAS_COMPANION_WORK_V2 === "enabled" && v !== "disabled");
}

export function takeRoadWord(input: { env: NodeJS.ProcessEnv; domain: "main" | "daemon" }): TakeRoadWord {
  if (input.env.AGENTLAS_COMPANION_WORK_V2 !== "enabled") return "off";
  if (input.domain === "main") return "main_intake";
  return guiLeaseRoadOn(input.env) ? "gui_coordinator" : "none_daemon_domain_without_gui_lease";
}

let last: string | null = null;
/** Main calls this when the personal domain moves to the background service (supervisor-native-runtime.ts). "off" says nothing; an unchanged word says nothing again. */
export function noteTakeRoad(domain: "main" | "daemon", env: NodeJS.ProcessEnv = process.env): TakeRoadWord {
  const word = takeRoadWord({ env, domain });
  if (word !== "off" && word !== last) { try { console.info(`[companion-take-roads] work: ${word}`); } catch { /* a trace never changes the answer */ } }
  last = word;
  return word;
}
