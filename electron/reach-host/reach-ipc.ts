// IPC for the Agentlas Reach switch (Settings → "Explore this desktop's apps"). Main only: it reads the macOS permission grants.
//   reach:getExplore  ()         -> { enabled }
//   reach:setExplore  (enabled, consent?) -> { enabled }   (on needs consent === true: the owner's agreement from the dialog)
//   reach:status      ()         -> ReachStatusDto
// The model may read the first and the last through app-control, never write the switch (app-control/policy.ts DENIED).
import type { IpcMain } from "electron";
import { registerAppControlDomainIpc } from "../app-control/ipc-registry";
import { checkComputerUsePermissions } from "../mac-permissions";
import { getReachExploreEnabled, readReachStatus, setReachExploreEnabled } from "../store/reach-explore";
import type { ReachStatusDto } from "../../shared/reach";
import { notifyReachExploreChanged } from "./reach-hooks";

/** Accessibility and Screen Recording, read fresh and without prompting (mac-permissions passes prompt=false). Only macOS has these
 * grants; anywhere else, or when they cannot be read, they are unknown (null), never "missing". */
export function reachPermissions(): ReachStatusDto["permissions"] {
  if (process.platform !== "darwin") return { accessibility: null, screenRecording: null };
  try {
    const state = checkComputerUsePermissions();
    return { accessibility: state.accessibility, screenRecording: state.screenRecording };
  } catch {
    return { accessibility: null, screenRecording: null };
  }
}

export function reachStatus(): ReachStatusDto {
  return { ...readReachStatus(), permissions: reachPermissions() };
}

export function registerReachIpc(ipc: Pick<IpcMain, "handle">): void {
  registerAppControlDomainIpc(ipc, "reach:getExplore", () => ({ enabled: getReachExploreEnabled() }));
  registerAppControlDomainIpc(ipc, "reach:setExplore", (enabled: unknown, consent: unknown) => {
    if (typeof enabled !== "boolean") throw new TypeError("reach_switch_invalid");
    // Turning it on needs the agreement from the dialog; the screen sends it only after the owner pressed "Agree".
    setReachExploreEnabled(enabled, consent === true);
    notifyReachExploreChanged(enabled);
    // The value Main stored, read back, so the screen shows what is true rather than what was asked for.
    return { enabled: getReachExploreEnabled() };
  });
  registerAppControlDomainIpc(ipc, "reach:status", () => reachStatus());
}
