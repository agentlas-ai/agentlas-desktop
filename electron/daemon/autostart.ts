// 데몬 자동 시작 — Phase 4.
//
// ★왜 필요한가. 데몬이 있어도 **사람이 켜 줘야 도는** 상태면 "앱을 닫아도 자동화가
// 돈다" 는 약속은 지켜지지 않는다. 컴퓨터를 껐다 켠 다음 폰에서 요청을 보냈을 때
// 아무 일도 안 일어나면, 사용자에게는 기능이 없는 것과 같다.
//
// 플랫폼마다 방식이 다르고 **여기만 3벌**이다(기획서 §6 Phase 4). 각각은 작다:
//   · macOS  — launchd LaunchAgent plist (~/Library/LaunchAgents)
//   · Windows — 시작프로그램 폴더의 .cmd
//   · Linux  — systemd --user 유닛
//
// 규칙:
//  - **쓰기 전에 무엇을 쓸지 만들어 보여 줄 수 있어야 한다**(plan). 자동 시작은 사용자
//    머신의 부팅 동작을 바꾸는 일이라, 조용히 설치하면 안 된다.
//  - 제거가 설치만큼 확실해야 한다. 끄는 길이 없는 자동 시작은 사용자가 되돌릴 수 없다.
//  - 설치 여부 판정은 **파일 실재**로 한다. 우리 기억이 아니라.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DAEMON_LABEL = "cloud.agentlas.daemon";

export interface AutostartPlan {
  /** 이 플랫폼에서 쓰는 방식. */
  mechanism: "launchd" | "windows-startup" | "systemd-user";
  /** 실제로 만들어질 파일. */
  filePath: string;
  /** 그 파일의 내용. 사용자가 설치 전에 그대로 읽을 수 있다. */
  contents: string;
}

export interface AutostartCommand {
  /** 데몬을 띄우는 실행 파일 — Electron 의 node(ABI 때문에, daemon/main.ts 주석 참조). */
  executable: string;
  /** 데몬 진입점 js 의 절대 경로. */
  entry: string;
}

function plistEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 이 플랫폼에서 무엇을 설치할지 **계산만** 한다. 파일은 만들지 않는다.
 * 설치 화면은 이 값을 그대로 보여 주고, 사용자가 승낙하면 `installAutostart` 를 부른다.
 */
export function planAutostart(
  command: AutostartCommand,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): AutostartPlan {
  if (platform === "darwin") {
    return {
      mechanism: "launchd",
      filePath: path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`),
      contents: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        `  <string>${DAEMON_LABEL}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        `    <string>${plistEscape(command.executable)}</string>`,
        `    <string>${plistEscape(command.entry)}</string>`,
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        // ELECTRON_RUN_AS_NODE 가 없으면 창을 띄우려 한다 — 자동 시작에서 그건 결함이다.
        "    <key>ELECTRON_RUN_AS_NODE</key>",
        "    <string>1</string>",
        // 부팅 데몬은 절대 마이그레이션 주인이 아니다 — 스키마 승급은 앱(GUI)이 한다.
        // 업데이트 직후 앱보다 먼저 뜬 데몬이 낡은/새 사다리를 돌리는 조합을 막는다.
        "    <key>AGENTLAS_STORE_MIGRATION_ROLE</key>",
        "    <string>follower</string>",
        "  </dict>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        // 죽으면 다시 띄운다. 데몬이 조용히 사라지면 자동화도 조용히 멈춘다.
        "  <key>KeepAlive</key>",
        "  <true/>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    };
  }
  if (platform === "win32") {
    const startup = path.join(
      process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
    );
    return {
      mechanism: "windows-startup",
      filePath: path.join(startup, "agentlas-daemon.cmd"),
      contents: [
        "@echo off",
        "set ELECTRON_RUN_AS_NODE=1",
        "set AGENTLAS_STORE_MIGRATION_ROLE=follower",
        `start "" /b "${command.executable}" "${command.entry}"`,
        "",
      ].join("\r\n"),
    };
  }
  return {
    mechanism: "systemd-user",
    filePath: path.join(
      process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
      "systemd", "user", "agentlas-daemon.service",
    ),
    contents: [
      "[Unit]",
      "Description=Agentlas daemon",
      "",
      "[Service]",
      "Environment=ELECTRON_RUN_AS_NODE=1",
      "Environment=AGENTLAS_STORE_MIGRATION_ROLE=follower",
      `ExecStart=${command.executable} ${command.entry}`,
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  };
}

/** 계획대로 파일을 만든다. 이미 있으면 덮어쓴다(경로가 바뀌었을 수 있다). */
export function installAutostart(plan: AutostartPlan): void {
  fs.mkdirSync(path.dirname(plan.filePath), { recursive: true });
  fs.writeFileSync(plan.filePath, plan.contents, { encoding: "utf8", mode: 0o644 });
}

/** 되돌린다. 파일이 없으면 조용히 성공한다 — 이미 원하는 상태다. */
export function removeAutostart(plan: AutostartPlan): void {
  try {
    fs.rmSync(plan.filePath, { force: true });
  } catch (error) {
    throw new Error(`could not remove ${plan.filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 지금 설치돼 있는가 — 파일 실재로 판정한다(우리 기억이 아니라). */
export function isAutostartInstalled(plan: AutostartPlan): boolean {
  return fs.existsSync(plan.filePath);
}
