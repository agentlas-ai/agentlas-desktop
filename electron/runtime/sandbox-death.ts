/**
 * 쓰기 실행 샌드박스 안에서 프로세스가 "시작하자마자 죽은" 흔적을 도구 결과에서 찾는다.
 *
 * 왜 따로 있나(페르소나 루프 라운드 2, 2026-09-14 실측): 안드로이드 에뮬레이터가 작업 폴더 샌드박스(seatbelt)
 * 안에서 가상화 엔진을 올리는 순간 SIGILL(exit 132)로 즉사했다. 권한 거절 문장("requires approval",
 * "Operation not permitted")이 하나도 없어서 승인 배너가 뜨지 않았고, 모델은 "이 컴퓨터엔 하이퍼바이저가 없다"
 * 고 15분 뒤 보고했다 — 같은 명령이 샌드박스 밖에서는 정상 부팅한다(오케스트레이터 실측). 즉 샌드박스 즉사는
 * 권한 경계의 한 형태인데, 문자열 판별(runtime-refusal.detectApprovalRequired)이 원리적으로 못 본다.
 *
 * 판별은 도구 결과 텍스트만 본다. 두 형태를 실측했다:
 *  - Claude Code Bash 도구가 붙이는 꼬리 "[exited with code 132]" (is_error 가 아니었다)
 *  - 모델이 스스로 붙인 "EXIT=132"
 * 이 판별은 쓰기 샌드박스가 실제로 켜진 실행에서만 부른다 — 전체 액세스(샌드박스 없음)의 132 는 진짜 기계 문제다.
 */
import { WRITE_SANDBOX_LAUNCH_DENIAL_CODE } from "../../shared/write-sandbox-launch-guard";

export interface SandboxDeathSignal {
  /** 무엇으로 죽었는가 — 화면 문장에 그대로 쓴다. */
  kind: "SIGILL" | "SIGTRAP" | "SIGSEGV" | "SIGABRT" | "hypervisor" | "gpu" | "refused";
  exitCode: number | null;
  /** 판별에 걸린 짧은 근거(한 줄). */
  evidence: string;
}

/** 종료 코드를 말하는 관용구들 — 숫자만 잡고 판정은 아래에서. */
const EXIT_CODE_RE =
  /(?:\[exited with code|\bexit(?:ed)?(?:\s+with)?(?:\s+code|\s+status)?\s*[:=]?|\bEXIT(?:_?CODE)?\s*=|\brc\s*=|\$\?\s*=|\bcode\s*=)\s*(\d{1,3})\b/gi;

const SIGNAL_TEXT: Array<{ re: RegExp; kind: SandboxDeathSignal["kind"] }> = [
  { re: /\billegal (?:hardware )?instruction\b|\bSIGILL\b/i, kind: "SIGILL" },
  { re: /\bTrace\/BPT trap\b|\bSIGTRAP\b/i, kind: "SIGTRAP" },
  { re: /\bHV_(?:ERROR|DENIED|UNSUPPORTED|NO_DEVICE)\b|\bhv_vm_create\b|\bHypervisor\.framework\b[^\n]{0,80}\b(?:denied|failed|unavailable|not permitted)\b|\bMAP_JIT\b[^\n]{0,60}\b(?:denied|failed|not permitted)\b/i, kind: "hypervisor" },
  // The GPU and window server a write sandbox denies (seatbelt iokit/mach denials as a tool prints them).
  { re: /\b(?:AGXDeviceUserClient|IOSurfaceRootUserClient)\b|\bcom\.apple\.windowserver(?:\.active)?\b[^\n]{0,40}\b(?:denied|deny)\b|\bdeny\(\d+\)\s+(?:iokit-open|mach-lookup)\b[^\n]{0,80}\b(?:AGX|IOSurface|windowserver)/i, kind: "gpu" },
];

/*
 * 139 (SIGSEGV) and 134 (SIGABRT) too: a GPU or window-server app started inside the write sandbox crashes this way as
 * soon as Metal is refused. Production 2026-10-07 and 10-12: teammates' Blender in Codex's workspace-write sandbox
 * died with exit 139 at start ("metal_is_supported", denied AGXDeviceUserClient / IOSurfaceRootUserClient /
 * com.apple.windowserver.active); nothing read it as the permission boundary, so the room never lifted the worker and
 * the worker noted "Metal crash, do not retry". The same Blender renders unsandboxed and in Agentlas's own seatbelt.
 */
const SIGNAL_BY_EXIT: Record<number, SandboxDeathSignal["kind"]> = { 132: "SIGILL", 133: "SIGTRAP", 134: "SIGABRT", 139: "SIGSEGV" };

export function detectSandboxDeath(toolResultText: string): SandboxDeathSignal | null {
  const text = String(toolResultText || "");
  if (!text) return null;
  for (const match of text.matchAll(EXIT_CODE_RE)) {
    const code = Number(match[1]);
    const kind = SIGNAL_BY_EXIT[code];
    if (kind) return { kind, exitCode: code, evidence: match[0].trim() };
  }
  for (const { re, kind } of SIGNAL_TEXT) {
    const found = re.exec(text);
    if (found) return { kind, exitCode: null, evidence: found[0].slice(0, 120) };
  }
  return null;
}

/*
 * An operation the sandbox refused is the same permission boundary as a command it killed, and it leaves no signal at all.
 * Observed in use (one room, codex gpt-6.1-terra, chip full, steps resolved to write): a teammate's
 * `ffmpeg ... -y /tmp/diffusion-review.jpg` ended "Could not open file : /tmp/... Operation not permitted" (exit 255) in
 * four runs; nothing read it as the boundary (the 132/133/134/139 table above needs a signal), so the step never asked the
 * room for the access the owner's chip already covered. Measured offline against the real codex seatbelt
 * (r4-step-sandbox/measure-tmpdir.cjs): a write to /tmp, to the real $TMPDIR or to a sibling of the project is refused with
 * EPERM; the same command is fine at full access.
 *
 * Only a FAILED shell command counts: the "[exited with code N]" trailer Codex and Claude Code append, Claude Code's
 * leading "Exit code N" line, or the leading "exit N" head of the API-lane bash tool (shared/builtin-tools.ts). A page, a
 * file or a log that merely mentions the phrase is not a refusal. The caller decides
 * where a refusal can happen at all (a run that really sits in a write sandbox); this function reads text only. The phrases
 * are the OS's own refusals: EPERM on macOS seatbelt and Linux (a write, but also nice(2) and the like), EROFS under a
 * read-only bind mount, ACCESS_DENIED on Windows.
 */
const FAILED_COMMAND_RES: readonly RegExp[] = [/\[exited with code ([1-9]\d{0,2})\]/, /^\s*Exit code ([1-9]\d{0,2})\b/m, /^exit ([1-9]\d{0,2})\b/];
const SANDBOX_REFUSAL_RE = /Operation not permitted|Read-only file system|Access is denied/i;

export function detectSandboxRefusal(toolResultText: string): SandboxDeathSignal | null {
  const text = String(toolResultText || "");
  if (!text) return null;
  let failed: RegExpExecArray | null = null;
  for (const re of FAILED_COMMAND_RES) { failed = re.exec(text); if (failed) break; }
  if (!failed) return null;
  const refusal = SANDBOX_REFUSAL_RE.exec(text);
  if (!refusal) return null;
  return { kind: "refused", exitCode: Number(failed[1]), evidence: refusal[0] };
}

export function sandboxDeathNotice(signal: SandboxDeathSignal, command: string | undefined, locale: "ko" | "en" | undefined): { ko: string; en: string; message: string } {
  const what = command ? `: ${command}` : "";
  if (signal.kind === "refused") {
    const ko = `이 명령이 샌드박스 밖으로 나가려다 거절됐습니다(${signal.evidence})${what}. 이 컴퓨터의 한계가 아니라 이 실행의 권한 경계입니다 — 아래 "전체 액세스로 진행할까요?"에서 허용하면 샌드박스 없이 여기서부터 이어집니다.`;
    const en = `This command tried to go outside the sandbox and was refused (${signal.evidence})${what}. That is this run's permission boundary, not a limit of this computer — allow it in "Continue with full access?" below and it resumes from here without the sandbox.`;
    return { ko, en, message: locale === "ko" ? ko : en };
  }
  const how = signal.exitCode !== null ? `${signal.kind}, exit ${signal.exitCode}` : signal.kind;
  const ko = `이 명령이 샌드박스 안에서 시작하자마자 죽었습니다(${how})${what}. 이 컴퓨터의 한계가 아니라 이 실행의 권한 경계입니다 — 아래 "전체 액세스로 진행할까요?"에서 허용하면 샌드박스 없이 여기서부터 이어집니다.`;
  const en = `This command died as soon as it started inside the sandbox (${how})${what}. That is this run's permission boundary, not a limit of this computer — allow it in "Continue with full access?" below and it resumes from here without the sandbox.`;
  return { ko, en, message: locale === "ko" ? ko : en };
}

/** 런처 관문(PreToolUse 훅)의 거절문이 도구 결과에 들어왔는가 — 그 거절은 곧 승격 요청이다. */
export function detectSandboxLaunchDenial(toolResultText: string): { launcher: string } | null {
  const text = String(toolResultText || "");
  const at = text.indexOf(WRITE_SANDBOX_LAUNCH_DENIAL_CODE);
  if (at < 0) return null;
  const launcher = text.slice(at).match(/'([^']{1,40})'/)?.[1] ?? "launcher";
  return { launcher };
}

export function sandboxLaunchDenialNotice(launcher: string, command: string | undefined, locale: "ko" | "en" | undefined): { ko: string; en: string; message: string } {
  const what = command ? `: ${command}` : "";
  const ko = `샌드박스 밖에서 프로세스를 띄우는 명령(${launcher})을 막았습니다${what}. 사용자는 파일 편집까지만 허용했습니다 — 아래 "전체 액세스로 진행할까요?"에서 허용하면 샌드박스 없이 여기서부터 이어집니다.`;
  const en = `Blocked a command that would start a process outside the sandbox (${launcher})${what}. Only file edits were allowed — allow it in "Continue with full access?" below and it resumes from here without the sandbox.`;
  return { ko, en, message: locale === "ko" ? ko : en };
}
