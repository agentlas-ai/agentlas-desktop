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

export function shellDeleteGateScriptPath(): string {
  return path.join(__dirname, "shell-delete-gate-hook.js");
}

/**
 * The delete gate of a write run's shell (shell-delete-gate-hook.ts): the same shell tools as the launch guard, with a timeout that outlasts an
 * owner's card (the card closes unanswered after five minutes). Null when the script is missing - the run then does not start (never a gate that is
 * only said to be there).
 */
export function shellDeleteGateHook(): PreToolUseHookEntry | null {
  const script = shellDeleteGateScriptPath();
  if (!fs.existsSync(script)) return null;
  const handler = nodeHookHandler(script);
  return { matcher: writeSandboxLaunchGuardMatcher(), hooks: [{ ...handler, timeout: 340 }] };
}

export function osSchedulerGateScriptPath(): string {
  return path.join(__dirname, "os-scheduler-gate-hook.js");
}

/**
 * The OS scheduler gate (os-scheduler-gate-hook.ts) watches the shell tools and the file-edit tools: a job put in launchd / cron / systemd folders by a file write
 * is a registration like the command that loads it. The tool names are Claude Code's (and codex's shell); on Windows the PowerShell tool is a shell too.
 */
export function osSchedulerGateMatcher(platform: NodeJS.Platform = process.platform): string {
  return `${writeSandboxLaunchGuardMatcher(platform)}|Write|Edit|MultiEdit|NotebookEdit`;
}

/** Null when the script is missing: the run then does not start (never a gate that is only said to be there). */
export function osSchedulerGateHook(): PreToolUseHookEntry | null {
  const script = osSchedulerGateScriptPath();
  if (!fs.existsSync(script)) return null;
  return { matcher: osSchedulerGateMatcher(), hooks: [nodeHookHandler(script)] };
}
