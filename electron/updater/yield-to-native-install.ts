import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**









 */
export const YIELD_TO_NATIVE_INSTALL_WINDOW_MS = 90_000;
const SHIPIT_SERVICE = "com.agentlas.desktop.ShipIt";
const LAUNCHCTL_ABSENT = 113;

export interface YieldToNativeInstallInput {
  platform: NodeJS.Platform;
  userDataPath: string;
  runningVersion: string;
  uid: number | null;
  now?: () => number;
  windowMs?: number;
  /** Returns launchctl's exit status; 0 means the job exists. */
  runLaunchctl?: (args: string[]) => number;
}

function defaultLaunchctl(args: string[]): number {
  try {
    execFileSync("launchctl", args, { stdio: "ignore", timeout: 3_000 });
    return 0;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : -1;
  }
}

export function shouldYieldToNativeInstall(input: YieldToNativeInstallInput): boolean {
  if (input.platform !== "darwin" || input.uid === null) return false;
  let journal: { phase?: unknown; requestedAt?: unknown; sourceVersion?: unknown; targetVersion?: unknown };
  try {
    journal = JSON.parse(fs.readFileSync(path.join(input.userDataPath, "updater", "install-journal.v1.json"), "utf8"));
  } catch {
    return false;
  }
  if (journal.phase !== "install-requested") return false;
  const requestedAt = typeof journal.requestedAt === "string" ? Date.parse(journal.requestedAt) : NaN;
  if (!Number.isFinite(requestedAt)) return false;
  const age = (input.now ?? Date.now)() - requestedAt;
  if (age < 0 || age >= (input.windowMs ?? YIELD_TO_NATIVE_INSTALL_WINDOW_MS)) return false;
  // ShipIt relaunches the freshly installed TARGET build; only a copy of the old build is in the way.
  if (typeof journal.sourceVersion !== "string" || journal.sourceVersion !== input.runningVersion) return false;
  if (typeof journal.targetVersion === "string" && journal.targetVersion === input.runningVersion) return false;
  // Only a job proven absent lets the launch continue; an unknown launchd answer inside the window yields too.
  return (input.runLaunchctl ?? defaultLaunchctl)(["print", `gui/${input.uid}/${SHIPIT_SERVICE}`]) !== LAUNCHCTL_ABSENT;
}
