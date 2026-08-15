// Claude Code CLI — 감지 + 실호출.
// 사용자의 Claude Pro/Max 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: claude -p "<user prompt>" --append-system-prompt-file <system>
// 첫 턴은 full-context로 시작하고, 이후 턴은 Claude Code session_id로 resume한다.
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Runner, RunnerRequest, RunnerEvents, RunnerResult , RunnerFailure } from "./runner";
import {
  ensureChildCloseAfterExit,
  startCliHeartbeat,
  workforceNativeToolEnforcement,
  workforceZeroToolsEnforcement,
  wrapSystemPrompt,
} from "./runner";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import { detectApprovalRequired } from "./runtime-refusal";
import { announceToolDenied } from "./tool-approval";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, writeStdin } from "./exec";
import { stageCliImageAttachments } from "./image-attachments";
import { createUntrustedRuntimeFailure } from "./untrusted-error";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import { isAuthenticSystemTimeMcpLaunch } from "../mcp-tools/system-time-server";

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정해,
 * 누른 적 없는 사람이 거짓 사유를 받았다(실사용 실측).
 */

const KIND = "claude-code";
const AGENT_APP_MCP_SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;

function isCanonicalAgentAppInlineMcpConfig(value: string | undefined): boolean {
  if (!value || !value.startsWith('{"mcpServers":') || /[\r\n\0]/.test(value) ||
      Buffer.byteLength(value, "utf8") > 4_096) return false;
  try {
    const parsed = JSON.parse(value) as { mcpServers?: Record<string, unknown> };
    if (JSON.stringify(parsed) !== value || !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        JSON.stringify(Object.keys(parsed)) !== JSON.stringify(["mcpServers"]) ||
        !parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers) ||
        JSON.stringify(Object.keys(parsed.mcpServers)) !== JSON.stringify(["agentlas-time"])) return false;
    const entry = parsed.mcpServers["agentlas-time"] as {
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["args", "command", "env"]) ||
        typeof entry.command !== "string" || !Array.isArray(entry.args) ||
        entry.args.some((arg) => typeof arg !== "string") ||
        !entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) return false;
    const env = entry.env as Record<string, unknown>;
    return isAuthenticSystemTimeMcpLaunch(entry.command, entry.args as string[]) &&
      JSON.stringify(Object.keys(env)) === JSON.stringify(["ELECTRON_RUN_AS_NODE"]) &&
      env.ELECTRON_RUN_AS_NODE === "1";
  } catch {
    return false;
  }
}

async function inspectWorkforceMcpConfig(req: RunnerRequest): Promise<{
  bytes: string;
  serverConfigKeys: string[];
} | null> {
  const grant = req.workforceRuntimeToolGrant;
  if (!grant || grant.grantedToolIds.length === 0) return null;
  if (
    !req.untrustedNoTools ||
    !req.mcpConfigPath ||
    !path.isAbsolute(req.mcpConfigPath) ||
    req.mcpCodexConfigArgs?.length ||
    JSON.stringify(req.mcpAllowedTools) !== JSON.stringify(grant.grantedToolIds) ||
    JSON.stringify(req.untrustedAllowedMcpTools) !== JSON.stringify(grant.grantedToolIds)
  ) return null;
  try {
    const before = await fs.lstat(req.mcpConfigPath);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const bytes = await fs.readFile(req.mcpConfigPath, "utf8");
    const after = await fs.lstat(req.mcpConfigPath);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) return null;
    const digest = `sha256:${crypto.createHash("sha256").update(bytes, "utf8").digest("hex")}`;
    if (digest !== grant.canonicalConfigSha256) return null;
    const parsed = JSON.parse(bytes) as { mcpServers?: Record<string, unknown> };
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed)) !== JSON.stringify(["mcpServers"]) ||
      !parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)
    ) return null;
    const serverConfigKeys = Object.keys(parsed.mcpServers).sort();
    if (JSON.stringify(serverConfigKeys) !== JSON.stringify([...grant.expectedServerConfigKeys].sort())) return null;
    if (grant.grantedToolIds.some((toolId) => !serverConfigKeys.some((key) => toolId.startsWith(`mcp__${key}__`)))) {
      return null;
    }
    return { bytes, serverConfigKeys };
  } catch {
    return null;
  }
}

async function materializeWorkforceMcpConfig(bytes: string): Promise<{ arg: string; cleanup: () => void }> {
  const file = path.join(os.tmpdir(), `agentlas-workforce-mcp-${process.pid}-${crypto.randomUUID()}.json`);
  await fs.writeFile(file, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
  return {
    arg: file,
    cleanup: () => { void fs.unlink(file).catch(() => {}); },
  };
}

function stripAgentAppMcpSecretAliases(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return env;
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AGENT_APP_MCP_SECRET_ALIAS_RE.test(key)),
  );
}

async function materializeWindowsAgentAppMcpConfig(
  bin: string,
  inlineConfig: string,
): Promise<{ arg: string; cleanup: () => void }> {
  if (process.platform !== "win32" || !/\.cmd$/i.test(bin)) {
    return { arg: inlineConfig, cleanup: () => {} };
  }
  // cmd.exe has an 8,191-character command-line ceiling. JSON quoting can
  // exceed it even while the canonical config itself remains under 4 KiB.
  // Snapshot the already validated in-memory bytes into a new private folder;
  // never pass the mutable preflight path that Main originally re-opened.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-claude-mcp-"));
  const file = path.join(dir, "mcp.json");
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    // The init receipt and process close can both request cleanup. Let each
    // call retry independently so a transient Windows reader lock at init
    // cannot strand the snapshot after the CLI exits.
    void fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 2,
      retryDelay: 125,
    }).then(() => { removed = true; }).catch(() => {});
  };
  try {
    await fs.chmod(dir, 0o700).catch(() => {});
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(inlineConfig, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await fs.readFile(file, "utf8") !== inlineConfig) {
      throw new Error("Agent App MCP dispatch snapshot mismatch.");
    }
    return { arg: file, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// 구형 claude CLI가 --include-partial-messages를 거부하면 false로 전환해(프로세스 수명 동안
// 1회 학습) 이후 실행은 플래그 없이 — 메시지 덩어리 스트리밍으로 — 동작한다.
let includePartialMessagesSupported = true;

const CANDIDATES = [
  // Windows: `.cmd`/`.exe`를 bare `claude`보다 먼저 시도한다. bare `claude`는
  // cross-spawn이 PATHEXT로 해석하다 `claude.ps1`을 잡으면 PowerShell 실행정책
  // (Restricted/RemoteSigned)에 막혀 감지가 실패한다 — 정작 claude 자체는 정상(exit 0)인데도.
  // `.cmd` 심은 cmd.exe로 실행돼 실행정책과 무관하고, `.exe`는 네이티브 인스톨러 산출물이다.
  ...(process.platform === "win32"
    ? [
        "claude.cmd", // PATH의 npm .cmd 심 (실행정책 무관)
        "claude.exe", // 네이티브 인스톨러 exe
        path.join(process.env.APPDATA ?? "", "npm", "claude.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "claude.cmd"),
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude.cmd"),
      ]
    : []),
  "claude",
  path.join(os.homedir(), ".local/bin/claude"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".agentlas/npm/bin/claude"), // 앱이 설치한 유저 prefix (sudo 불필요)
  path.join(os.homedir(), ".claude/local/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
      if ((await probeCliVersion(p, 2000)) !== null) return p;
      continue;
    }
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ClaudeCodeProbe {
  path: string;
  version: string;
}

export async function probeClaudeCode(): Promise<ClaudeCodeProbe | null> {
  const found = await firstExisting(CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeClaudeCode();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

// ── 작업량(effort) 자동 동기화 ─────────────────────────────
// 하드코딩 대신 `claude --help`를 파싱해 이 CLI 버전이 실제 지원하는 --effort 레벨만 노출한다.
// CLI가 업데이트돼 레벨이 바뀌면 자동 반영. --effort 자체가 없으면 빈 배열(=작업량 미지원).
function effortLabel(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function runClaudeHelp(bin: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const child = spawnCli(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    const outDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (c: Buffer) => (out += outDecoder.write(c)));
    child.on("error", finish);
    child.on("close", finish);
  });
}

function parseEffortChoices(help: string): string[] {
  // Parse the choices printed by the installed CLI instead of assuming a version-specific set.
  const m = help.match(/--effort[\s\S]{0,240}?\(([a-z0-9, ]+)\)/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let cachedEfforts: Array<{ id: string; label: string }> | undefined;
/** 이 Claude Code 버전이 지원하는 작업량 레벨 — --help 파싱(1회 캐시). 미지원이면 []. */
export async function probeClaudeEfforts(): Promise<Array<{ id: string; label: string }>> {
  if (cachedEfforts !== undefined) return cachedEfforts;
  const bin = await getBin();
  if (!bin) {
    cachedEfforts = [];
    return cachedEfforts;
  }
  const help = await runClaudeHelp(bin);
  cachedEfforts = parseEffortChoices(help).map((id) => ({ id, label: effortLabel(id) }));
  return cachedEfforts;
}

function flattenHistory(req: RunnerRequest): string {
  // CLI는 단일 turn — 이전 대화를 연속성 프레이밍과 함께 user 메시지에 inline으로 prepend.
  // 컨텍스트 예산을 넘길 때만 오래된 턴이 다이제스트로 접힌다(그 외 원문 유지).
  if (req.history.length === 0) return req.userPrompt;
  const { block } = renderConversationContext(req.history, req.locale, CLI_HISTORY_CONTEXT_TOKENS);
  return [block, "", tStatus(req.locale, "histThis"), req.userPrompt].join("\n");
}

/**
 * 세션 지문 — 안정 시드(sessionFingerprintSeed)가 있으면 시드만 해시한다. 시드가 곧
 * 세션 정체성의 전부다: 모델/effort/권한은 매 호출 CLI 인자로 다시 적용되므로 세션을
 * 가를 이유가 없고, 지문에 섞으면 칩 하나 바꿀 때마다 대화 연속성이 끊긴다
 * (2026-07-16 세션유지 사고 — 턴마다 fingerprint_changed로 세션 전멸).
 * 시드가 없는 레거시 호출만 시스템 프롬프트 전체 해시로 폴백한다.
 * Build처럼 runtimeSessionId를 직접 넘기는 표면은 호출자가 세션 수명을 관리한다.
 */
function systemFingerprint(req: RunnerRequest): string {
  // The model is part of the session identity. A runtime session belongs to the
  // model that created it, so resuming it under a different model is a false
  // resume, not continuity. Leaving the model out made every BYOK model switch
  // reuse the previous model's session id.
  //
  // This does NOT reintroduce the 2026-07-16 세션유지 사고. That incident came
  // from hashing the whole system prompt and settings, so any unrelated setting
  // change severed the conversation; the seed exists to keep those out. The
  // model is different in kind — it genuinely cannot inherit another model's
  // session — and the user does not experience a cut, because the fresh-session
  // path reseeds the compacted conversation history with continuity framing
  // (renderConversationContext). The thread the user sees lives in Agentlas's
  // own store, not in the runtime session.
  if (req.sessionFingerprintSeed) {
    return crypto
      .createHash("sha256")
      .update("seed.v3\0")
      .update(req.sessionFingerprintSeed)
      .update("\0model\0")
      .update(req.model ?? "")
      .digest("hex");
  }
  return crypto
    .createHash("sha256")
    .update(req.systemPrompt)
    .update("\0")
    .update(req.locale)
    .update("\0")
    .update(req.permission ?? "")
    .update("\0")
    .update(req.forceSurface ? "force-surface" : "normal")
    .update("\0")
    .update(req.model ?? "")
    .update("\0")
    .update(req.effort ?? "")
    .digest("hex");
}


/**
 * claude stream-json 이벤트 하나에서 실패 표식을 읽는다 — 순수 함수(게이트가 픽스처 주입).
 * 실측 스트림(2026-08-06): rate_limit_event(status:rejected) → assistant(error:"rate_limit")
 * → result(is_error:true, api_error_status:429). 종료코드는 가변 — 이벤트가 진실.
 */
export function claudeFailureFromEvent(
  ev: { type?: string; is_error?: boolean; result?: unknown; terminal_reason?: string;
        api_error_status?: number; rate_limit_info?: { status?: string; resetsAt?: number } },
  finalText: string,
  prior: RunnerFailure | null,
): RunnerFailure | null {
  if (ev.type === "rate_limit_event" && ev.rate_limit_info?.status === "rejected") {
    return {
      kind: "quota", message: "Claude rate limit rejected", runtime: "claude", source: "marker",
      ...(typeof ev.rate_limit_info.resetsAt === "number"
        ? { retryAfterHint: new Date(ev.rate_limit_info.resetsAt * 1000).toISOString() }
        : {}),
    };
  }
  if (ev.type === "result" && ev.is_error === true) {
    const message = typeof ev.result === "string" && ev.result.trim()
      ? ev.result.trim().slice(0, 2000) : "claude error";
    return {
      kind: ev.api_error_status === 429 ? "quota"
        : /not logged in|please run \/login/i.test(finalText) ? "auth"
        : ev.terminal_reason === "api_error" ? "quota"
        : "exit",
      message, runtime: "claude", source: "marker",
      ...(prior?.retryAfterHint ? { retryAfterHint: prior.retryAfterHint } : {}),
    };
  }
  return prior;
}

export const runClaudeCode: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Claude Code is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingClaude"));
  }

  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;

  // Establish the exact one-run MCP authority before writing the system
  // prompt. A malformed config must not leave the model believing a tool is
  // available after the argv gate has already removed it.
  const hasExactAgentAppMcpGrant = Boolean(
    runReq.untrustedNoTools &&
    isCanonicalAgentAppInlineMcpConfig(runReq.mcpConfigPath) &&
    runReq.mcpAllowedTools?.length &&
    runReq.untrustedAllowedMcpTools?.length &&
    validSiteAgentAppMcpGrantTools(runReq.mcpAllowedTools) &&
    validSiteAgentAppMcpGrantTools(runReq.untrustedAllowedMcpTools) &&
    JSON.stringify(runReq.mcpAllowedTools) === JSON.stringify(runReq.untrustedAllowedMcpTools),
  );
  const workforceMcpConfig = await inspectWorkforceMcpConfig(runReq);
  const hasExactWorkforceMcpGrant = Boolean(workforceMcpConfig);
  const workforceGrantHasTools = Boolean(runReq.workforceRuntimeToolGrant?.grantedToolIds.length);
  if (workforceGrantHasTools && !hasExactWorkforceMcpGrant) {
    throw new Error("workforce_runtime_tool_grant_config_unverified");
  }
  if (
    runReq.workforceRuntimeToolGrant &&
    !workforceGrantHasTools &&
    (runReq.mcpConfigPath || runReq.mcpAllowedTools?.length || runReq.untrustedAllowedMcpTools?.length)
  ) {
    throw new Error("workforce_zero_tool_grant_contains_mcp_authority");
  }
  const hasExactUntrustedMcpGrant = hasExactAgentAppMcpGrant || hasExactWorkforceMcpGrant;
  if (
    runReq.untrustedNoTools && runReq.mcpConfigPath && !hasExactUntrustedMcpGrant &&
    !runReq.workforceRuntimeToolGrant
  ) {
    try { runReq.onAgentAppMcpRuntimeUnavailable?.(); } catch { /* receipt reconciliation is best effort */ }
  }

  const systemPrompt = wrapSystemPrompt(
    runReq.systemPrompt,
    runReq.locale,
    runReq.permission,
    runReq.userPrompt,
    runReq.forceSurface,
    runReq.restrictedReadBoundary,
    runReq.untrustedNoTools,
    runReq.untrustedNoTools
      ? (hasExactUntrustedMcpGrant ? runReq.untrustedAllowedMcpTools : undefined)
      : runReq.untrustedAllowedMcpTools,
    runReq.workforceRuntimeToolGrant,
  );
  const fingerprint = !runReq.untrustedNoTools && runReq.chatId ? systemFingerprint(runReq) : null;
  const savedSession = !runReq.untrustedNoTools && runReq.chatId ? getRuntimeSession(runReq.chatId, KIND) : null;
  const storedSessionId =
    savedSession && fingerprint && savedSession.fingerprint === fingerprint
      ? savedSession.sessionId
      : null;
  if (runReq.chatId && savedSession && fingerprint && savedSession.fingerprint !== fingerprint) {
    events.onStatus(`[runtime-session] fingerprint_changed kind=${KIND}`);
    clearRuntimeSession(runReq.chatId, KIND);
  }
  const resumeSessionId = runReq.untrustedNoTools ? null : (runReq.runtimeSessionId ?? storedSessionId);
  // gap-replay — 이 세션이 마지막으로 본 이후 다른 경로(스웜/다른 러너)로 진행된 턴을 메운다.
  // 호출자가 세션 수명을 직접 관리하는 runtimeSessionId(Build 등)에는 적용하지 않는다.
  const gapContext = !runReq.runtimeSessionId && storedSessionId && savedSession
    ? renderGapContext(unseenHistoryGap(runReq.history, savedSession.updatedAt), runReq.locale)
    : "";
  // resume 턴: 시스템 프롬프트가 재전송되지 않으므로 gap+턴 컨텍스트를 사용자 메시지에 싣는다.
  // 새 세션: 턴 컨텍스트를 시스템 프롬프트 뒤에 붙여 세션을 시드한다.
  const flatUser = resumeSessionId
    ? composeResumeTurnPrompt(
        runReq.userPrompt,
        [gapContext, runReq.turnContext ?? ""].filter(Boolean).join("\n\n"),
        runReq.locale,
      )
    : flattenHistory(runReq);
  /*
   * 읽기 전용 실행이면 그 사실을 말해 준다 — 도구를 조용히 빼기만 하면 모델은 그것을
   * 일시적 장애로 읽고 우회를 찾는다. 실측: 서브에이전트 위임 → 다른 도구 대체 →
   * 브라우저까지 시도하며 2분을 썼고, 결국 아무것도 못 했다. 경계는 숨길 이유가 없다.
   */
  const readOnlyToolNotice =
    !runReq.untrustedNoTools && req.permission !== "write" && req.permission !== "full"
      ? (runReq.locale === "ko"
        ? "\n\n[읽기 전용 실행] 이 세션에는 파일 쓰기·편집·셸 도구가 없다(제거됨). 서브에이전트 위임이나 다른 도구로 우회하지 마라. 작업에 쓰기가 필요하면 그 사실만 말하고, 사용자가 권한을 올리게 하라. 읽기·검색·분석은 평소대로 하면 된다."
        : "\n\n[Read-only run] This session has no file write, edit, or shell tools — they were removed. Do not work around it by delegating to a subagent or substituting another tool. If the task needs writing, say so and let the user raise the permission. Reading, searching, and analysis work as usual.")
      : "";
  const seededSystemPrompt = (!resumeSessionId && runReq.turnContext?.trim()
    ? `${systemPrompt}\n\n${runReq.turnContext.trim()}`
    : systemPrompt) + readOnlyToolNotice;

  if (stagedImages.images.length > 0) {
    events.onStatus(
      tStatus(runReq.locale, "cliImageReady", {
        backend: runReq.backendLabel,
        count: stagedImages.images.length,
      }),
    );
  } else if (resumeSessionId) {
    events.onStatus(
      runReq.locale === "ko"
        ? `${runReq.backendLabel} 세션 이어가는 중...`
        : `Resuming ${runReq.backendLabel} session...`,
    );
  } else {
    events.onStatus(tStatus(runReq.locale, "callingBackend", { backend: runReq.backendLabel }));
  }

  /*
   * 권한 칩 → claude 권한 모드. full=전체, write=편집 허용.
   *
   * ★read 는 "플래그 없음"이 아니다.
   *
   * 예전에는 read 에 아무 인자도 주지 않고 "헤드리스면 위험한 도구는 알아서 거부된다"고
   * 가정했다. 실측으로 그 가정이 깨졌다: 읽기 권한으로 파일 생성을 시켰더니 claude 는
   * 그냥 만들었다(같은 요청에서 codex·antigravity·grok 은 셋 다 거절했다). 사용자가
   * 읽기를 골랐다는 것은 "내 파일을 바꾸지 마라"는 뜻인데, 그 약속이 지켜지지 않았다.
   *
   * 그래서 변경 수단을 이름으로 막는다. Bash 까지 막는 이유는 그것으로 파일을 쓸 수
   * 있기 때문이다 — Bash 를 열어 둔 채 "읽기 전용"이라고 말하면 그 경계는 거짓말이고,
   * 이 제품은 지킬 수 없는 경계를 조용히 통과시키지 않기로 했다(kimi 는 플래그 자체가
   * 없어서 강제 불가를 사용자에게 말한다). 읽기·검색·분석은 그대로 가능하다.
   */
  const READ_ONLY_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell"];
  /** write 모드에서 acceptEdits 가 여전히 묻는 내장 도구 — 헤드리스는 답할 수 없으니 미리 허용. */
  const WRITE_MODE_PRE_ALLOWED_TOOLS = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"];
  const permArgs = runReq.untrustedNoTools
    ? []
    : req.permission === "full"
      ? ["--permission-mode", "bypassPermissions"]
      : req.permission === "write"
        ? ["--permission-mode", "acceptEdits"]
        : ["--disallowed-tools", ...READ_ONLY_DENIED_TOOLS];

  // 모델 선택 — opus/sonnet/haiku 별칭(또는 풀 ID). 미지정이면 구독 기본 모델.
  const modelArgs = req.model && req.model.trim() ? ["--model", req.model.trim()] : [];
  // 작업량(reasoning effort) — installed CLI가 노출한 값을 그대로 전달. 미지정이면 CLI 기본.
  const effortArgs = req.effort && req.effort.trim() ? ["--effort", req.effort.trim()] : [];

  // MCP 서버 구성 주입 — mcp/client.ts가 설치·활성 서버를 .mcp.json으로 직렬화해 경로를 넘긴다.
  // 이게 있어야 에이전트가 브라우저(Playwright) 등 실제 MCP 툴을 호출한다. (사용자 config와 병합)
  let agentAppMcpConfigArg = runReq.mcpConfigPath;
  let cleanupAgentAppMcpConfig = () => {};
  if (hasExactUntrustedMcpGrant && runReq.mcpConfigPath) {
    try {
      const materialized = hasExactWorkforceMcpGrant && workforceMcpConfig
        ? await materializeWorkforceMcpConfig(workforceMcpConfig.bytes)
        : await materializeWindowsAgentAppMcpConfig(bin, runReq.mcpConfigPath);
      agentAppMcpConfigArg = materialized.arg;
      cleanupAgentAppMcpConfig = materialized.cleanup;
    } catch (error) {
      if (runReq.workforceRuntimeToolGrant) throw new Error("workforce_runtime_tool_grant_materialization_failed");
      try { runReq.onAgentAppMcpRuntimeUnavailable?.(); } catch { /* receipt reconciliation is best effort */ }
      throw createUntrustedRuntimeFailure();
    }
  }
  const mcpArgs = agentAppMcpConfigArg && (!runReq.untrustedNoTools || hasExactUntrustedMcpGrant)
    ? ["--mcp-config", agentAppMcpConfigArg]
    : [];
  // Exact Agentlas Browser intent is an authority binding, not a preference.
  // Claude's user-level plugins can otherwise reintroduce generic Playwright
  // beside Main's approval-gated CDP host and silently execute browser_evaluate
  // without the native sheet. Isolate this turn to the exact Main config.
  const isolatedMcpArgs = runReq.isolatedMcpConfig
    ? ["--setting-sources", "", "--strict-mcp-config"]
    : [];
  // write/full 권한이면 헤드리스에서 권한 프롬프트로 막히지 않도록 MCP 툴을 미리 허용.
  const mcpPreAllowed =
    runReq.mcpConfigPath &&
    runReq.mcpAllowedTools &&
    runReq.mcpAllowedTools.length > 0 &&
    ((!runReq.untrustedNoTools && (req.permission === "write" || req.permission === "full")) ||
      hasExactUntrustedMcpGrant)
      ? runReq.mcpAllowedTools
      : [];
  /*
   * ★오너 결정(2026-08-15): 묻는 순간이 없는 헤드리스 실행은 **권한 범위 안의 도구를
   * 처음부터 풀어 둔다.** `acceptEdits` 는 파일 편집만 자동 허용하고 Bash·웹은 여전히
   * 물어보는데, `-p` 에는 답할 사람이 없어 런타임이 스스로 거부하고 지나갔다 — 그래서
   * "파일 편집은 되는데 npm test 만 조용히 안 되는" 실행이 나왔고, 그 뒤에 "다음부터
   * 허용?" 카드가 떴다. 사용자가 write 를 골랐다는 것은 프로젝트 안에서 일하라는 뜻이지
   * 셸을 막으라는 뜻이 아니다. 거부를 사후에 알리는 대신 거부가 생길 이유를 없앤다.
   * read 는 그대로 도구 자체를 제거하고(위 READ_ONLY_DENIED_TOOLS), 정책 거절은 도구
   * 브로커 PreToolUse 훅이 계속 맡는다 — 허용 깃발은 켜기만 하고 거절은 훅만 한다.
   */
  const builtinPreAllowed =
    !runReq.untrustedNoTools && req.permission === "write" ? WRITE_MODE_PRE_ALLOWED_TOOLS : [];
  const preAllowedTools = [...builtinPreAllowed, ...mcpPreAllowed];
  const allowedToolArgs = preAllowedTools.length > 0 ? ["--allowedTools", preAllowedTools.join(",")] : [];
  // ★C38 — 도구 호출 직전 관문. 실측(2026-08-04, claude 2.1.220): PreToolUse deny가
  // `--permission-mode bypassPermissions`를 이기고 Bash 호출을 실제로 막았다. 허용 깃발
  // (`--allowedTools`)은 켜기만 하므로, 선언되지 않은 호출을 거절하는 곳은 여기뿐이다.
  const toolBrokerArgs = runReq.toolBrokerSettingsPath
    ? ["--settings", runReq.toolBrokerSettingsPath]
    : [];
  const noToolsArgs = runReq.untrustedNoTools
    ? [
        // Claude's safe-mode disables even an explicit --mcp-config. Keep it
        // for the absolute no-tool path, but omit it for the exact System Time
        // grant; --tools "" still removes every built-in and --allowedTools
        // admits only the two audited read-only MCP tools.
        ...(hasExactUntrustedMcpGrant ? ["--setting-sources", ""] : ["--safe-mode"]),
        "--disable-slash-commands",
        "--no-chrome",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--tools",
        "",
      ]
    : [];

  // 시스템 프롬프트(Agentlas 헤더+스킬+프로토콜만 ~24KB)는 argv가 아니라 파일로 전달한다.
  // Windows에서 claude는 `.cmd` 심 → cmd.exe로 실행되고 커맨드라인은 ~8191자 한계라,
  // `--append-system-prompt`에 24KB를 실으면 잘려서 exit 1. `--append-system-prompt-file`은
  // 경로만 넘기므로 안전. 사용자 프롬프트(+히스토리)는 stdin으로 보낸다(`-p`는 stdin을 읽음).
  const sysPromptFile = path.join(
    os.tmpdir(),
    `agentlas-claude-sys-${process.pid}-${crypto.randomUUID()}.txt`,
  );
  try {
    await fs.writeFile(sysPromptFile, seededSystemPrompt, "utf8");
  } catch (error) {
    cleanupAgentAppMcpConfig();
    throw error;
  }
  const cleanupSysFile = () => {
    void fs.unlink(sysPromptFile).catch(() => {});
  };

  return new Promise<RunnerResult>((resolve, reject) => {
    const rejectRuntime = (error: unknown) => {
      reject(
        runReq.untrustedNoTools
          ? createUntrustedRuntimeFailure()
          : error instanceof Error
            ? error
            : new Error(String(error)),
      );
    };
    // stream-json + verbose: tool_use / 텍스트 / 토큰(usage) 이벤트를 NDJSON으로 받아
    // Claude Code식 tool-use 블록 + 토큰 표시를 가능하게 한다.
    // --include-partial-messages: 텍스트를 메시지 블록 덩어리가 아니라 토큰 델타로 받아
    // 타자기 스트리밍을 가능하게 한다(미지원 구형 CLI는 close 핸들러에서 자동 폴백).
    const partialFlagArgs = includePartialMessagesSupported ? ["--include-partial-messages"] : [];
    const systemPromptFileFlag = runReq.untrustedNoTools
      ? "--system-prompt-file"
      : "--append-system-prompt-file";
    const args = resumeSessionId
      ? [
          "--resume",
          resumeSessionId,
          "--fork-session",
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          ...partialFlagArgs,
          ...modelArgs,
          ...effortArgs,
          ...permArgs,
          ...noToolsArgs,
          ...isolatedMcpArgs,
          ...mcpArgs,
          ...allowedToolArgs,
          ...toolBrokerArgs,
        ]
      : [
          "-p",
          systemPromptFileFlag,
          sysPromptFile,
          "--output-format",
          "stream-json",
          "--verbose",
          ...partialFlagArgs,
          ...modelArgs,
          ...effortArgs,
          ...permArgs,
          ...noToolsArgs,
          ...isolatedMcpArgs,
          ...mcpArgs,
          ...allowedToolArgs,
          ...toolBrokerArgs,
        ];
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: req.env ?? process.env,
        // 사용자가 워킹 폴더(프로젝트)를 지정했으면 거기서 실행 — 빌드/파일 생성이 프로젝트에 일어난다.
        // 미지정이면 쓰기 가능한 전용 폴더(packaged 앱은 cwd가 비쓰기/루트라 claude가 exit 1).
        cwd: req.cwd ?? agentRunCwd(),
        // POSIX 그룹킬 대상 — 취소/앱종료 시 CLI가 띄운 MCP 서버·빌드 손자까지 정리.
        ...detachedSpawnOpts(),
      });
    } catch (error) {
      cleanupSysFile();
      cleanupAgentAppMcpConfig();
      rejectRuntime(error);
      return;
    }
    trackRunChild(child);
    writeStdin(child, flatUser);
    // ★호스트 소유 생존 신호 — 러너 공통 규칙(runner.ts startCliHeartbeat 주석 참고).
    //   stream-json이라도 긴 생각/도구 구간은 수 분 침묵할 수 있고, 그 침묵은
    //   무활동 워치독에게 사망과 구별되지 않는다.
    const stopHeartbeat = startCliHeartbeat(child, events.onStatus, "claude");
    // ★죽은 자식이 close를 안 보내면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    ensureChildCloseAfterExit(child, () => {
      events.onStatus("claude: process exited without closing its output — settling the run");
    });

    // 취소 — 사용자가 Stop을 누르면 자식 프로세스 트리 종료. 병렬 세션 각각 독립 취소.
    const onAbort = () => killCliTree(child);
    if (req.signal) {
      if (req.signal.aborted) killCliTree(child);
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let buffer = "";
    let acc = "";
    // 현재 메시지의 토큰 델타(stream_event) 누적분 — assistant 메시지 이벤트가 오면
    // 그 권위 전문으로 acc에 폴드되고 비워진다(델타 누락/중복이 있어도 자가 교정).
    let cur = "";
    let finalText = "";
    let tokens: number | undefined;
    let observedUsage: { inputTokens: number; outputTokens: number } | undefined;
    let stderr = "";
    let structuredRuntimeError: Error | null = null;
    /** 스트림 표식이 말한 실패 — 있으면 종료코드와 무관하게 이 턴은 답이 아니다. */
    let runnerFailure: import("./runner").RunnerFailure | null = null;
    let lastEmit = 0;
    let sessionId: string | undefined;
    let accCapped = false;
    // 런어웨이 출력(예: 장기 실행 GUI/서버 로그가 끝없이 스트리밍되는 명령)으로부터
    // 메모리를 보호한다. acc를 무제한 누적 + 매 partial마다 전체를 렌더러로 보내면
    // 메인 문자열과 렌더러 DOM이 동시에 폭주해 앱이 OOM된다(수십 GB). 2MB로 상한.
    const MAX_ACC = 2 * 1024 * 1024;
    const combined = () => (cur ? (acc ? acc + "\n" : "") + cur : acc);
    const capCombined = () => {
      if (accCapped || acc.length + cur.length < MAX_ACC) return;
      acc =
        combined().slice(0, MAX_ACC) +
        (req.locale === "ko"
          ? "\n\n[출력이 너무 길어 잘렸습니다 — 런어웨이 출력 메모리 보호]"
          : "\n\n[Output truncated — runaway output memory guard]");
      cur = "";
      accCapped = true;
    };
    // force: 도구 이벤트 직전 강제 플러시 — 스로틀로 밀린 본문 꼬리가 도구 카드 아래로
    // 밀리지 않게 앵커(anchorTextLen) 좌표를 최신으로 맞춘다. (중복 방출은 service의
    // 빈-델타 가드가 걸러낸다)
    const emitPartial = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit <= 60) return;
      events.onPartial(combined());
      lastEmit = now;
    };

    // ── 라이브 토큰 카운트 — 상태줄 "{N}s · {tokens} tokens" 실시간 갱신용 ──
    // message_delta의 usage.output_tokens(현재 메시지 누적 실측)를 우선하고, 실측이 아직
    // 없는 스트리밍 구간은 델타 문자 수/4로 추정한다. 렌더러 표시는 단조 증가만 허용.
    let usageBase = 0; // 완결된 메시지들의 output_tokens 합
    let curMsgUsage = 0; // 현재 메시지의 마지막 usage 실측
    let curMsgEstChars = 0; // 현재 메시지에서 스트리밍된 문자 수(텍스트+thinking) — 추정용
    let lastUsageEmit = 0;
    let lastUsageVal = 0;
    const emitUsage = (force = false) => {
      const val = usageBase + Math.max(curMsgUsage, Math.ceil(curMsgEstChars / 4));
      if (val <= lastUsageVal) return;
      const now = Date.now();
      if (!force && now - lastUsageEmit < 500) return;
      lastUsageVal = val;
      lastUsageEmit = now;
      events.onUsage?.(val);
    };

    // ── thinking 구간 추적 — 상태줄 "생각 중…" 회전과 "N초 동안 생각함"의 근거 ──
    const thinkingBlocks = new Set<number>();
    let thinkingStartedAt = 0;
    const endThinking = () => {
      if (thinkingBlocks.size === 0) return;
      thinkingBlocks.clear();
      events.onThinking?.("end", Date.now() - thinkingStartedAt);
    };

    const toolNameById = new Map<string, string>();
    /*
     * ★무엇이 막혔는지는 거부 문구가 아니라 **그 호출**이 안다.
     *
     * claude 의 거부 tool_result 는 "This command requires approval" 한 줄이고 명령을
     * 담지 않는다(실측). 그래서 이름 없이 "도구가 막혔다"고만 알리게 되는데, 그건
     * 사용자에게 아무 정보가 아니다. tool_use 는 같은 id 로 먼저 지나가므로, 그때 무엇을
     * 하려 했는지 적어 두면 거부가 왔을 때 정확히 이름을 붙일 수 있다 — 추측이 아니라 연결.
     */
    const toolCallById = new Map<string, { name: string; detail?: string }>();
    const detailOfToolInput = (input: unknown): string | undefined => {
      if (!input || typeof input !== "object") return undefined;
      const o = input as Record<string, unknown>;
      for (const key of ["command", "file_path", "path", "url", "pattern"]) {
        const v = o[key];
        if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
      }
      return undefined;
    };

    /*
     * ★승인이 없어 막힌 도구 호출을 사용자에게 말한다.
     *
     * 헤드리스에는 승인할 사람이 없어서 CLI가 그런 호출을 거부로 처리하고, 세션에는
     * `toolDenialKind: "user-rejected"` 로 남는다 — 사용자는 아무것도 거절한 적이 없는데도.
     * 예전에는 그 tool_result가 다른 도구 결과와 똑같이 흘러가 화면에 아무 표시도 남지
     * 않았다. 파일 편집은 되는데 `npm test`나 `git commit`만 조용히 안 되는 상태였다.
     *
     * 실행을 실패로 끝내지는 않는다(막힌 것이지 깨진 것이 아니다). 대신 대화에 남는
     * 사실로 올려서, 사용자가 권한을 올릴지 다시 시킬지 정할 수 있게 한다.
     */
    const announcedApprovalBlocks = new Set<string>();
    const announceApprovalBlock = (resultText: string, toolId?: string): void => {
      const blocked = detectApprovalRequired(resultText);
      if (!blocked) return;
      const call = toolId ? toolCallById.get(toolId) : undefined;
      const what0 = blocked.blocked ?? call?.detail;
      /*
       * 같은 tool_result 가 assistant 메시지와 user 메시지 두 경로로 들어온다(실측: 같은
       * 요청이 승인 카드에 두 번 떴다). 호출 id 를 열쇠에 넣어 한 호출은 한 번만 알린다.
       */
      const key = `${toolId ?? ""}|${what0 ?? blocked.message.slice(0, 120)}`;
      if (announcedApprovalBlocks.has(key)) return;
      announcedApprovalBlocks.add(key);
      announceToolDenied({
        runtime: KIND,
        // 선택("다음부터 허용")을 반영하려면 어느 세션의 결정인지 알아야 한다.
        sessionKey: `${KIND}:${runReq.chatId ?? runReq.cwd ?? "default"}`,
        tool: call?.name ?? (blocked.blocked ? "Bash" : "tool"),
        detail: what0,
        cwd: runReq.cwd,
        deniedBy: "runtime-headless",
      });
      const what = what0 ? `: ${what0}` : "";
      const ko = `승인이 필요해 중단된 단계가 있습니다${what}. 이 실행에는 승인할 사람이 붙어 있지 않아 자동으로 거부됐습니다 — 사용자가 거절한 것이 아닙니다. 권한을 올리거나 다시 요청해 주세요.`;
      const en = `A step was blocked because it needs approval${what}. This run has nobody to approve it, so it was auto-denied — you did not reject it. Raise the permission or ask again.`;
      events.onNotice?.({
        level: "warning",
        code: "approval-required",
        message: runReq.locale === "ko" ? ko : en,
        i18n: { ko, en },
      });
    };

    let agentAppMcpInitFailed = false;
    let agentAppMcpInitConnected = false;
    let agentAppMcpUnavailableNotified = false;
    const markAgentAppMcpUnavailable = () => {
      if (agentAppMcpUnavailableNotified) return;
      agentAppMcpUnavailableNotified = true;
      try { runReq.onAgentAppMcpRuntimeUnavailable?.(); } catch { /* receipt reconciliation is best effort */ }
    };

    const truncateUi = (s: string, max = 12000): string =>
      s.length > max ? `${s.slice(0, max)}…` : s;
    const stringifyToolPayload = (payload: unknown): string => {
      if (typeof payload === "string") return payload;
      if (Array.isArray(payload)) {
        const text = payload
          .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object" && "text" in item) {
              const text = (item as { text?: unknown }).text;
              return typeof text === "string" ? text : "";
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
      try {
        return JSON.stringify(payload ?? "", null, 2);
      } catch {
        return String(payload ?? "");
      }
    };

    function handleEvent(ev: {
      type?: string;
      subtype?: string;
      session_id?: string;
      mcp_servers?: Array<{ name?: string; status?: string }>;
      tools?: string[];
      message?: {
        content?: Array<{
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
          id?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
      };
      result?: unknown;
      // `result` 이벤트는 입력·출력·캐시 토큰을 **전부** 싣는다(실측 확인 2026-07-28).
      // 예전에는 output 만 읽고 나머지를 버려서, 할당 영수증의 `usage` 를 채울 수
      // 없었다 — 스키마가 non-null 일 때 입력·출력 둘 다를 요구하기 때문이다.
      usage?: {
        output_tokens?: number;
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      error?: unknown;
      is_error?: boolean;
      terminal_reason?: string;
      api_error_status?: number;
      rate_limit_info?: { status?: string; resetsAt?: number };
      event?: {
        type?: string;
        index?: number;
        content_block?: { type?: string };
        delta?: { type?: string; text?: string; thinking?: string };
        usage?: { output_tokens?: number };
      };
    }): void {
      if (agentAppMcpInitFailed) return;
      const isAgentAppMcpInit = ev.type === "system" && ev.subtype === "init";
      if (
        hasExactUntrustedMcpGrant &&
        !runReq.agentAppMcpFallbackAttempted &&
        !agentAppMcpInitConnected &&
        !isAgentAppMcpInit
      ) {
        // No model/tool/result event is trusted before Claude proves the exact
        // MCP inventory in system/init. Otherwise an init-less success could
        // leak a first answer before the no-tool replay starts.
        agentAppMcpInitFailed = true;
        markAgentAppMcpUnavailable();
        killCliTree(child, 250);
        return;
      }
      if (typeof ev.session_id === "string" && ev.session_id) {
        sessionId = ev.session_id;
      }
      if (ev.error === "authentication_failed") {
        structuredRuntimeError = new Error(
          runReq.locale === "ko"
            ? "Claude Code 로그인이 만료됐습니다. 설정에서 Claude를 다시 연결한 뒤 재시도해주세요."
            : "Claude Code is signed out. Reconnect Claude in Settings, then try again.",
        );
      }
      if (isAgentAppMcpInit && hasExactUntrustedMcpGrant &&
          !runReq.agentAppMcpFallbackAttempted) {
        // Claude has consumed the config and started the exact MCP inventory;
        // close the Windows pathname race before any model output is trusted.
        cleanupAgentAppMcpConfig();
        const expectedTools = [...(runReq.mcpAllowedTools ?? [])].sort();
        const expectedServers = hasExactWorkforceMcpGrant && workforceMcpConfig
          ? [...workforceMcpConfig.serverConfigKeys].sort()
          : ["agentlas-time"];
        const reportedTools = Array.isArray(ev.tools) && ev.tools.every((tool) => typeof tool === "string")
          ? [...ev.tools].sort()
          : [];
        const reportedServers = Array.isArray(ev.mcp_servers) && ev.mcp_servers.every((server) => (
          typeof server?.name === "string" && server.status === "connected"
        ))
          ? ev.mcp_servers.map((server) => server.name as string).sort()
          : [];
        agentAppMcpInitConnected = Boolean(
          JSON.stringify(reportedServers) === JSON.stringify(expectedServers) &&
          new Set(reportedTools).size === reportedTools.length &&
          JSON.stringify(reportedTools) === JSON.stringify(expectedTools)
        );
        if (!agentAppMcpInitConnected) {
          // Claude can omit, duplicate, or report a failed MCP bootstrap in
          // system/init and still exit 0. Stop before it answers under stale
          // tool authority, then replay once with the no-tool boundary.
          agentAppMcpInitFailed = true;
          markAgentAppMcpUnavailable();
          killCliTree(child, 250);
          return;
        }
      }
      // --include-partial-messages: 토큰 델타를 즉시 이어붙여 글자 단위 스트리밍을 만든다.
      // 본문은 text_delta만. thinking 블록은 본문에 싣지 않되 시작/종료 신호와 문자 수(토큰
      // 추정)는 소비한다 — 상태줄 "생각 중…" 회전의 근거 데이터.
      if (ev.type === "stream_event") {
        const se = ev.event;
        if (se?.type === "message_start") {
          curMsgUsage = 0;
          curMsgEstChars = 0;
        } else if (se?.type === "message_delta" && se.usage?.output_tokens != null) {
          curMsgUsage = se.usage.output_tokens;
          emitUsage(true);
        } else if (se?.type === "message_stop") {
          usageBase += Math.max(curMsgUsage, Math.ceil(curMsgEstChars / 4));
          curMsgUsage = 0;
          curMsgEstChars = 0;
          endThinking();
        } else if (se?.type === "content_block_start") {
          const blockType = se.content_block?.type;
          if ((blockType === "thinking" || blockType === "redacted_thinking") && se.index != null) {
            if (thinkingBlocks.size === 0) {
              thinkingStartedAt = Date.now();
              events.onThinking?.("start");
            }
            thinkingBlocks.add(se.index);
          }
        } else if (se?.type === "content_block_stop") {
          if (se.index != null && thinkingBlocks.has(se.index)) {
            thinkingBlocks.delete(se.index);
            if (thinkingBlocks.size === 0) {
              events.onThinking?.("end", Date.now() - thinkingStartedAt);
            }
          }
        } else if (se?.type === "content_block_delta") {
          const delta = se.delta;
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            curMsgEstChars += delta.thinking.length;
            // 생각 텍스트는 본문(partial)에 싣지 않는다 — 자기 행(reasoning delta)으로 흘린다.
            // 화면은 접힌 "N초 동안 생각함 ›" 아래에서만 보여 준다(Codex/Claude 앱과 같은 계약).
            if (delta.thinking) events.onThinking?.("delta", undefined, delta.thinking);
            emitUsage();
          } else if (delta?.type === "text_delta" && delta.text && !accCapped) {
            cur += delta.text;
            curMsgEstChars += delta.text.length;
            capCombined();
            emitPartial();
            emitUsage();
          }
        }
        return;
      }
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text) {
            if (!accCapped) {
              // 메시지 완결 — 델타 누적분(cur)을 권위 전문으로 대체해 acc에 폴드.
              cur = "";
              acc += (acc ? "\n" : "") + block.text;
              capCombined();
              emitPartial();
            }
          } else if (block.type === "tool_use" && block.name) {
            let argStr = "";
            try {
              argStr = JSON.stringify(block.input ?? {});
            } catch {
              argStr = "";
            }
            if (block.id) {
              toolNameById.set(block.id, block.name);
              toolCallById.set(block.id, { name: block.name, detail: detailOfToolInput(block.input) });
            }
            // 도구 이벤트 전에 본문을 강제 플러시 — 렌더러 인터리브 앵커가 최신 좌표를 본다.
            emitPartial(true);
            events.onTool?.(
              block.name,
              argStr.length > 2000 ? argStr.slice(0, 2000) + "…" : argStr,
              undefined,
              block.id,
              false,
            );
          } else if (block.type === "tool_result") {
            const toolId = block.tool_use_id;
            const toolName = toolId ? toolNameById.get(toolId) ?? "tool_result" : "tool_result";
            const result = truncateUi(stringifyToolPayload(block.content));
            if (block.is_error === true) announceApprovalBlock(result, toolId);
            events.onTool?.(toolName, undefined, result, toolId, block.is_error === true);
          }
        }
      } else if (ev.type === "user" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type !== "tool_result") continue;
          const toolId = block.tool_use_id;
          const toolName = toolId ? toolNameById.get(toolId) ?? "tool_result" : "tool_result";
          const result = truncateUi(stringifyToolPayload(block.content));
          if (block.is_error === true) announceApprovalBlock(result, toolId);
          events.onTool?.(toolName, undefined, result, toolId, block.is_error === true);
        }
      } else if (ev.type === "rate_limit_event") {
        // ★한도 거절은 표식이다 — 예전에는 케이스가 없어 조용히 버려졌다(분류는 순수 함수 한 곳).
        runnerFailure = claudeFailureFromEvent(ev, finalText, runnerFailure);
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") finalText = ev.result;
        if (ev.usage?.output_tokens != null) tokens = ev.usage.output_tokens;
        if (ev.usage) {
          // `inputTokens` 는 **모델에 실제로 들어간 토큰 전부**로 센다:
          // 새 입력 + 캐시에서 읽은 것 + 캐시에 쓴 것. 새 입력만 세면 실측상
          // 2 vs 52,518 처럼 실제 문맥 크기를 크게 과소보고한다. 청구 단가는
          // 셋이 다르지만 영수증 칸은 정수 하나뿐이므로, 과소보고보다 실제
          // 문맥 크기를 싣는 쪽을 택했다.
          const usage = ev.usage;
          const inputTotal =
            (usage.input_tokens ?? 0)
            + (usage.cache_read_input_tokens ?? 0)
            + (usage.cache_creation_input_tokens ?? 0);
          if (inputTotal > 0 || usage.output_tokens != null) {
            observedUsage = {
              inputTokens: inputTotal,
              outputTokens: usage.output_tokens ?? 0,
            };
          }
        }
        // ★모든 is_error가 표식이다 — 예전에는 로그인 만료 한 케이스만 집고 나머지를
        //   버려서, 성공 분기(exit 0)가 거절문을 정상 답으로 내보냈다.
        runnerFailure = claudeFailureFromEvent(ev, finalText, runnerFailure);
        if (
          ev.is_error === true
          && (ev.terminal_reason === "api_error" || /not logged in|please run \/login/i.test(finalText))
        ) {
          structuredRuntimeError = new Error(
            runReq.locale === "ko"
              ? "Claude Code 로그인이 만료됐습니다. 설정에서 Claude를 다시 연결한 뒤 재시도해주세요."
              : "Claude Code is signed out. Reconnect Claude in Settings, then try again.",
          );
        }
      }
    }

    const bufferDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += bufferDecoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // 비-JSON 라인은 무시
        }
      }
    });

    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupSysFile();
      cleanupAgentAppMcpConfig();
      rejectRuntime(err);
    });
    child.on("close", (code) => {
      // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
      stopHeartbeat();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      cleanupSysFile();
      cleanupAgentAppMcpConfig();
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        // 취소여도 CLI가 이미 세션을 디스크에 남겼으면 저장한다 → 사용자가 이어서 보내는
        // steering 메시지가 이 세션을 resume해 "실행 중 방향 전환"처럼 문맥을 유지한다.
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint);
        }
        rejectRuntime(abortReasonError(req));
        return;
      }
      if (
        hasExactUntrustedMcpGrant &&
        !runReq.agentAppMcpFallbackAttempted &&
        !agentAppMcpInitConnected
      ) {
        markAgentAppMcpUnavailable();
        if (runReq.workforceRuntimeToolGrant) {
          rejectRuntime(new Error("workforce_runtime_tool_inventory_init_unverified"));
          return;
        }
        void runClaudeCode({
          ...runReq,
          mcpConfigPath: undefined,
          mcpAllowedTools: undefined,
          untrustedAllowedMcpTools: undefined,
          env: stripAgentAppMcpSecretAliases(runReq.env),
          agentAppMcpFallbackAttempted: true,
        }, events).then(resolve, reject);
        return;
      }
      if (code === 0) {
        // 표시 본문은 스트리밍 전사본(모든 assistant 메시지 \n-join) 우선 — result 이벤트의
        // finalText는 '마지막 메시지'만 담아, 이걸 우선하면 도구 사이 중간 해설이 완료 순간
        // 통째로 사라지고 인터리브 앵커가 전부 틀어진다. finalText는 델타 스트리밍이 전혀
        // 없었던 폴백(구형 CLI 등)에서만 쓴다.
        const streamed = combined();
        const display = streamed || finalText;
        if (display) events.onPartial(display);
        if (req.chatId && fingerprint && sessionId) {
          if (!saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint)) {
            events.onStatus(`[runtime-session] store_failed kind=${KIND}`);
          }
        }
        events.onStatus(`[runtime-session] ${resumeSessionId ? "resumed" : "created"} kind=${KIND}`);
        resolve({
          text: display.trim(),
          // ★exit 0이어도 표식이 실패를 말했으면 그대로 싣는다 — 소비자는 이 칸으로 판정한다.
          //   (실측: 한도 거절은 exit 1이었지만 종료코드는 버전·경로 따라 가변 — 이벤트가 진실.)
          ...(runnerFailure ? { failure: runnerFailure } : {}),
          sessionId,
          tokens,
          observedUsage,
          workforcePermissionEnforcement: hasExactWorkforceMcpGrant
            ? workforceNativeToolEnforcement(
                runReq,
                KIND,
                ["builtins", "slash_commands", "chrome", "session_persistence"],
              )
            : workforceZeroToolsEnforcement(
                runReq,
                KIND,
                ["builtins", "mcp", "slash_commands", "chrome", "session_persistence"],
              ),
        });
      } else {
        if (structuredRuntimeError) {
          rejectRuntime(structuredRuntimeError);
          return;
        }
        if (runReq.untrustedNoTools) {
          // Pre-init failures already replay once through the exact init gate.
          // After a connected receipt, never issue a second model request: it
          // could duplicate output/cost after a later provider/runtime error.
          rejectRuntime(new Error("Agent App runtime process exited unsuccessfully."));
          return;
        }
        // 구형 CLI가 --include-partial-messages를 모르면 그 플래그만 빼고 즉시 재시도 —
        // 델타 스트리밍만 포기하고 채팅 자체는 살린다(전역 1회 학습).
        if (includePartialMessagesSupported && /include-partial-messages/i.test(stderr)) {
          includePartialMessagesSupported = false;
          void runClaudeCode(req, events).then(resolve, reject);
          return;
        }
        // Build continuation recovery is Main-owned and can change the exact
        // MCP config. Do not replay once here with the same fatal server first.
        if (
          resumeSessionId &&
          !req.chatId &&
          req.mcpConfigPath &&
          containsMcpStartupTransportFatal(stderr)
        ) {
          reject(new Error(`claude CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`));
          return;
        }
        if (resumeSessionId && req.chatId) clearRuntimeSession(req.chatId, KIND);
        if (resumeSessionId) {
          events.onStatus(`[runtime-session] resume_failed kind=${KIND} exit=${code}`);
          if (req.unattended) {
            reject(new Error(`Automation runtime session resume failed for ${KIND}; refusing to create a fresh CLI session.`));
            return;
          }
          // Interactive chat may recover with full durable history after the receipt.
          void runClaudeCode({ ...req, runtimeSessionId: undefined }, events).then(resolve, reject);
          return;
        }
        reject(new Error(`claude CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`));
      }
    });
  });
};
