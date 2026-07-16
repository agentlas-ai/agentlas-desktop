// Each running Agentlas instance owns a separate browser approval capability.
// Production and dev builds commonly run side-by-side with different userData
// directories, so a single ~/.agentlas pointer can route approvals to the
// wrong window and database.
import path from "node:path";
import { app } from "electron";

export const BROWSER_APPROVAL_FILE_ENV = "AGENTLAS_BROWSER_APPROVAL_FILE";

export function browserApprovalInfoPath(userDataPath = app.getPath("userData")): string {
  return path.join(userDataPath, "browser", "approval.json");
}
