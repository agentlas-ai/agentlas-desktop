import path from "node:path";
import { app } from "electron";

/** Exact per-app-instance capability pointer passed only to Agentlas Computer Use MCP. */
export const COMPUTER_USE_CONTROL_FILE_ENV = "AGENTLAS_COMPUTER_USE_CONTROL_FILE";

export function computerUseControlInfoPath(userDataPath = app.getPath("userData")): string {
  return path.join(userDataPath, "computer-use", "control.json");
}
