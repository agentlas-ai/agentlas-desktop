/** 쓰기 실행 settings 에 붙일 런처 관문 훅 — 스크립트 위치와 명령 조립. 판단은 shared 에, 스크립트는 옆 파일에. */
import fs from "node:fs";
import path from "node:path";
import { nodeHookHandler, type ClaudeCommandHookHandler } from "../workflow/tool-broker-runtime";

export function writeSandboxLaunchGuardScriptPath(): string {
  return path.join(__dirname, "write-sandbox-launch-guard-hook.js");
}

export interface PreToolUseHookEntry { matcher: string; hooks: ClaudeCommandHookHandler[] }

/**
 * The shell tools the guard watches. macOS/Linux: Claude's shell is Bash. Windows: Claude's shell is Bash (Git Bash)
 * or its PowerShell tool when Git Bash is missing, so both go through the gate.
 */
export function writeSandboxLaunchGuardMatcher(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "Bash|PowerShell" : "Bash";
}

/** 스크립트가 없으면 null — 관문 없이 "걸었다"고 적지 않는다(호출부가 실행을 거부한다). */
export function writeSandboxLaunchGuardHook(): PreToolUseHookEntry | null {
  const script = writeSandboxLaunchGuardScriptPath();
  if (!fs.existsSync(script)) return null;
  return { matcher: writeSandboxLaunchGuardMatcher(), hooks: [nodeHookHandler(script)] };
}
