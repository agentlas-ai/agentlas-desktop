// launchd LaunchAgent(설계 §2.6) — 앱이 꺼져 있어도 자동화를 돌리는 macOS 영속성(opt-in).
// ~/Library/LaunchAgents/ai.agentlas.automations.plist를 쓰고, launchctl bootstrap/bootout으로
// 로드/언로드한다. plist는 패키지된 Electron 바이너리를 `--headless-automations`로 coarse
// 인터벌(StartInterval 300)마다 poke한다. DB가 스케줄 권위이고 plist는 poke만 하므로 자동화별
// plist 동기화가 필요 없다.
//
// 영속성은 의미 있는 escalation이라 opt-in 뒤에 둔다(기본 아님). macOS 전용 — Win/Linux는 후속.
import { app } from "electron";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

/**
 * 이 앱의 실행 바이너리 절대 경로. 패키지 빌드는 process.execPath가
 * `/Applications/Agentlas.app/Contents/MacOS/Agentlas`. dev(비패키지)에서는 Electron 바이너리라
 * 헤드리스 자동화 진입점이 없으므로 dev에선 설치를 막는다(supported=false 취급).
 */
function appBinaryPath(): string {
  return process.execPath;
}

function plistXml(): string {
  const bin = appBinaryPath();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${bin}</string>`,
    "    <string>--headless-automations</string>",
    "  </array>",
    "  <key>StartInterval</key>",
    "  <integer>300</integer>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>LowPriorityIO</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
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

/** plist 작성 + launchctl bootstrap으로 로드(opt-in "앱 꺼져도 실행" 켜기). */
export function enableLaunchd(): LaunchdStatus {
  if (!isSupported() || !app.isPackaged) {
    return { ...launchdStatus(), error: "Only supported on packaged macOS builds." };
  }
  const p = plistPath();
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, plistXml(), "utf8");
  } catch (err) {
    return { ...launchdStatus(), error: `Failed to write plist: ${String(err)}` };
  }
  // 이미 로드돼 있으면 먼저 bootout(멱등). bootstrap은 이미 로드 시 에러이므로 재로드로 안전.
  if (isLoaded()) launchctl(["bootout", `${domainTarget()}/${LABEL}`]);
  const res = launchctl(["bootstrap", domainTarget(), p]);
  if (res.code !== 0 && !isLoaded()) {
    return { ...launchdStatus(), error: res.stderr || "launchctl bootstrap failed." };
  }
  return launchdStatus();
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
