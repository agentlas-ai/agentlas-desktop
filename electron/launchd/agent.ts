// Legacy launchd cleanup boundary. Agentlas Desktop local work is app-scoped;
// this module retains only enough compatibility to detect and remove launchers
// installed by older builds.
import { app } from "electron";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { LaunchdStatus } from "../../shared/types";

const LABEL = "ai.agentlas.automations";

function plistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function isSupported(): boolean {
  return process.platform === "darwin";
}

function domainTarget(): string {
  return `gui/${userInfo().uid}`;
}

/** launchctl 서브커맨드 실행. 실패해도 throw하지 않고 stderr를 반환(상태 함수가 판정). */
function launchctl(args: string[]): { code: number; stderr: string } {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: res.status ?? -1, stderr: (res.stderr || "").trim() };
}

/** plist가 launchd에 로드돼 있는지(launchctl print로 확인). */
function isLoaded(): boolean {
  if (!isSupported()) return false;
  const res = launchctl(["print", `${domainTarget()}/${LABEL}`]);
  return res.code === 0;
}

export function launchdStatus(): LaunchdStatus {
  const supported = isSupported() && app.isPackaged;
  return {
    supported,
    installed: supported && existsSync(plistPath()),
    loaded: supported && isLoaded(),
    plistPath: plistPath(),
  };
}

/** Background local execution is retired; enabling also removes any legacy job. */
export function enableLaunchd(): LaunchdStatus {
  const disabled = disableLaunchd();
  return {
    ...disabled,
    error: disabled.error ?? "Desktop local execution is available only while the Agentlas app is open.",
  };
}

/** launchctl bootout + plist 삭제(opt-in 끄기). */
export function disableLaunchd(): LaunchdStatus {
  if (!isSupported()) return launchdStatus();
  if (isLoaded()) launchctl(["bootout", `${domainTarget()}/${LABEL}`]);
  const p = plistPath();
  try {
    if (existsSync(p)) rmSync(p);
  } catch (err) {
    return { ...launchdStatus(), error: `Failed to remove plist: ${String(err)}` };
  }
  return launchdStatus();
}
