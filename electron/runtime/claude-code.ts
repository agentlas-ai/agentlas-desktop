import { recordClaudeCapabilityRequest, recordClaudeCapabilityInit } from "./capability-receipt";
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
  workforceObservedHostAuthorityEnforcement,
  workforceNativeToolEnforcement,
  workforceZeroToolsEnforcement,
  wrapSystemPrompt,
} from "./runner";
import { containsMcpStartupTransportFatal } from "./mcp-startup-fatal";
import { detectApprovalRequired } from "./runtime-refusal";
import { announceToolDenied } from "./tool-approval";
import { PERMISSION_ESCALATION_MARKER } from "../../shared/permission-escalation";
import {
  claudePoolKey,
  claudeResidentSessionAlive,
  claudeSessionPool,
  createNdjsonLineReader,
  openClaudeResidentSession,
  residencyDisabledFor,
  retireSupersededClaudeSessions,
  captureClaudeExecutableOwner,
  writeClaudeResidentTurn,
  type AcpSessionLease,
  type ClaudeResidentSession,
  type ClaudeStreamEvent,
  type ClaudeTurnSink,
} from "./claude-session";
import { isResidencyExemptAgent, resolveAgentResidencySource } from "./agent-residency";
import {
  CLI_HISTORY_CONTEXT_TOKENS,
  composeResumeTurnPrompt,
  renderConversationContext,
  renderGapContext,
  unseenHistoryGap,
} from "./continuity";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { agentRunCwd, detachedSpawnOpts, killCliTree, probeCliVersion, spawnCli, trackRunChild, withCliPath, writeStdin } from "./exec";
import { observeCliExecutableIdentity, type CliExecutableIdentity } from "./cli-executable-identity";
import { stageCliImageAttachments } from "./image-attachments";
import { createUntrustedRuntimeFailure } from "./untrusted-error";
import {
  clearRuntimeSession,
  getRuntimeSession,
  saveRuntimeSession,
} from "../store/runtime-sessions";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import { isAuthenticSystemTimeMcpLaunch } from "../mcp-tools/system-time-server";
import { createClaudeWorkforceObservation } from "./claude-workforce-observation";

/** Claude exposes file mutations as a typed tool_use input followed by a
 * tool_result. Admit only exact paths from known mutation tools; Main still
 * opens and seals every candidate before it can reach One Outputs. */
export function claudeArtifactPathsFromToolUse(name: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/iu.test(name)) {
    const candidates = [record.file_path, record.path];
    const paths = candidates.filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
    return [...new Set(paths)];
  }
  // A successful Read of an image is host evidence that the exact file exists
  // and was actually inspected. Preserve it as a durable One output instead of
  // relying on a model-authored Markdown path that can disappear on reload.
  if (/^Read$/iu.test(name)) {
    const candidate = typeof record.file_path === "string" ? record.file_path : record.path;
    if (typeof candidate === "string" && path.isAbsolute(candidate) && /\.(?:png|jpe?g|gif|webp|avif|svg)$/iu.test(candidate)) {
      return [candidate];
    }
  }
  // Bash가 만든 파일도 산출물이다 — 리다이렉트/tee/cp/mv의 목적지가 절대
  // 경로이고 확장자를 가진 경우만 보수적으로 등재한다(장치 파일·옵션 제외).
  // 이것 없이는 셸로 쓴 index.html이 결과 탭에 영영 안 올랐다
  // (U-D-1 범위 밖 3종 ②, 2026-08-25).
  if (/^Bash$/iu.test(name) && typeof record.command === "string") {
    const command = record.command;
    const paths = new Set<string>();
    const collect = (value: string | undefined) => {
      if (!value) return;
      const raw = value.replace(/^["']|["']$/g, "");
      if (!path.isAbsolute(raw)) return;
      if (raw.startsWith("/dev/") || raw.startsWith("/proc/")) return;
      if (!/\.[A-Za-z0-9]{1,8}$/.test(raw)) return;
      paths.add(raw);
    };
    for (const match of command.matchAll(/>{1,2}\s*("[^"]+"|'[^']+'|\S+)/gu)) collect(match[1]);
    for (const match of command.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|\S+)/gu)) collect(match[1]);
    for (const match of command.matchAll(/\b(?:cp|mv)\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|\S+)/gu)) collect(match[1]);
    return [...paths];
  }
  return [];
}

/**
 * Claude returns standard MCP rich content in the tool_result block. Computer
 * Use capture results include a Main-authored JSON metadata text block next to
 * the inline image; `savedPath` is the exact private capture that Main wrote.
 * Read only that typed host result for the two canonical capture tools. Model
 * prose and arbitrary MCP text never enter this boundary.
 */
export function claudeArtifactPathsFromToolResult(name: string, content: unknown): string[] {
  if (!/^mcp__cua-driver__(?:get_screen|get_app_state)$/u.test(name) || !Array.isArray(content)) return [];
  const paths = new Set<string>();
  for (const item of content.slice(0, 16)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string" || block.text.length > 32_000) continue;
    try {
      const metadata = JSON.parse(block.text) as { savedPath?: unknown };
      const savedPath = typeof metadata?.savedPath === "string" ? metadata.savedPath : "";
      if (path.isAbsolute(savedPath) && /\.(?:png|jpe?g)$/iu.test(savedPath)) paths.add(path.resolve(savedPath));
    } catch {
      // A malformed metadata block is not host evidence.
    }
  }
  return [...paths].slice(0, 4);
}

/**
 * 중지 사유를 그대로 전한다. 중지는 사람이 누른 것 외에도 무활동 워치독·단계 시간 초과·
 * 예산 소진으로 일어난다. 예전엔 전부 "사용자가 정지 버튼으로"라고 단정해,
 * 누른 적 없는 사람이 거짓 사유를 받았다(실사용 실측).
 */

const KIND = "claude-code";
const AGENT_APP_MCP_SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;

const CLAUDE_WORKSPACE_SANDBOX_SETTINGS = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      // Preserve the pre-existing write-mode network surface while keeping
      // filesystem writes inside the assigned cwd. Explicit loopback entries
      // plus local binding are required for Vite/browser QA on macOS.
      allowedDomains: ["*", "127.0.0.1", "localhost", "[::1]"],
      strictAllowlist: true,
      allowLocalBinding: true,
    },
  },
} as const;

/**
 * ★read 는 "플래그 없음"이 아니다.
 *
 * 예전에는 read 에 아무 인자도 주지 않고 "헤드리스면 위험한 도구는 알아서 거부된다"고
 * 가정했다. 실측으로 그 가정이 깨졌다: 읽기 권한으로 파일 생성을 시켰더니 claude 는
 * 그냥 만들었다(같은 요청에서 codex·antigravity·grok 은 셋 다 거절했다). 사용자가
 * 읽기를 골랐다는 것은 "내 파일을 바꾸지 마라"는 뜻인데, 그 약속이 지켜지지 않았다.
 *
 * 그래서 변경 수단을 이름으로 막는다. Bash 까지 막는 이유는 그것으로 파일을 쓸 수
 * 있기 때문이다 — Bash 를 열어 둔 채 "읽기 전용"이라고 말하면 그 경계는 거짓말이고,
 * 이 제품은 지킬 수 없는 경계를 조용히 통과시키지 않기로 했다.
 */
export const READ_ONLY_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell"];
// judgment-exempt: 관측된 이름을 **분류**하는 게 아니라, 이 런타임에 **줄 도구를
//   열거**하는 목록이다. 분류기는 이름을 받아 답할 뿐 열거를 못 한다.
//   그리고 이건 벤더 CLI 플래그라 이름도 그 벤더의 것이어야 한다.
/** write 모드에서 acceptEdits 가 여전히 묻는 내장 도구 — 헤드리스는 답할 수 없으니 미리 허용. */
export const WRITE_MODE_PRE_ALLOWED_TOOLS = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"];
/** Read permits public web retrieval; headless CLI cannot answer its own permission prompt. */
export function claudeBuiltinPreAllowedTools(
  permission: RunnerRequest["permission"],
  opts: { browserOnly?: boolean; untrustedNoTools?: boolean } = {},
): string[] {
  if (opts.browserOnly || opts.untrustedNoTools) return [];
  if (permission === "read") return ["WebFetch", "WebSearch"];
  return permission === "write" ? [...WRITE_MODE_PRE_ALLOWED_TOOLS] : [];
}


/**
 * 권한 칩 → claude 권한 플래그. **순수 함수다.**
 *
 * 모듈 밖으로 꺼내 둔 이유(2026-09-07): 이 판단이 러너 안쪽 지역 변수로만 살면,
 * "설치된 CLI 로 실제로 이 벡터가 아직 통하는가"를 재는 프로브가 그 벡터를 **베껴
 * 적을 수밖에 없다.** 베낀 사본은 러너가 바뀌어도 안 바뀌므로, 프로브가 초록인데
 * 제품은 막히는 상태가 만들어진다. 프로브는 이 함수를 그대로 부른다.
 */
/**
 * 이번 실행이 **실제로 쓴 모델 id** 를 result 이벤트에서 읽는다 — 순수 함수.
 *
 * ★왜 (오너 2026-09-07: "버전 바뀌어도 알아서 읽게 해라"). claude-code 에는 모델 목록
 *   명령이 없어(detect.ts `no-list-concept:cli-aliases`) 우리가 보낼 수 있는 것은 벤더
 *   별칭 `opus|sonnet|haiku|fable` 뿐이고, 화면에도 그것만 보였다. 버전을 코드에 적어
 *   두면 벤더가 세대를 올리는 순간 거짓이 된다.
 *
 *   그런데 CLI 는 이미 답을 주고 있었다. 실측(2.1.263)한 result 이벤트:
 *     "modelUsage": { "claude-opus-5[1m]": { …토큰… } }
 *   대괄호 뒤는 컨텍스트 창 표식(1m)이라 잘라낸다. 여러 모델이 섞이면(서브에이전트 등)
 *   토큰을 가장 많이 쓴 쪽이 이 턴의 주 모델이다.
 *
 * @returns 모델 id, 못 읽으면 null(짐작하지 않는다)
 */
export function observedClaudeModelId(modelUsage: unknown): string | null {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return null;
  let best: { id: string; tokens: number } | null = null;
  for (const [rawKey, value] of Object.entries(modelUsage as Record<string, unknown>)) {
    const id = String(rawKey).replace(/\[[^\]]*\]\s*$/, "").trim();
    if (!id || id.length > 128 || /[\s"']/.test(id)) continue;
    const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const tokens = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
      .reduce((sum, field) => sum + (typeof usage[field] === "number" ? usage[field] as number : 0), 0);
    if (!best || tokens > best.tokens) best = { id, tokens };
  }
  return best ? best.id : null;
}

export function claudePermissionArgs(
  permission: RunnerRequest["permission"],
  opts: { browserOnly?: boolean; untrustedNoTools?: boolean } = {},
): string[] {
  if (opts.browserOnly || opts.untrustedNoTools) return [];
  if (permission === "full") return ["--permission-mode", "bypassPermissions"];
  if (permission === "write") return ["--permission-mode", "acceptEdits"];
  return ["--disallowed-tools", ...READ_ONLY_DENIED_TOOLS];
}

/**
 * Claude merges sandbox paths from every settings source. A project or user
 * setting can therefore silently widen a task worker beyond its assigned cwd.
 * Write turns load no ambient settings and receive one Main-authored settings
 * object containing both the strict OS sandbox and, when present, the exact
 * PreToolUse hook. Passing two --settings flags is unsafe because Claude keeps
 * only the latter object.
 */
async function claudeExecutionSettings(req: RunnerRequest): Promise<string | null> {
  if (req.permission !== "write") return req.toolBrokerSettingsPath ?? null;

  let hooks: unknown;
  if (req.toolBrokerSettingsPath) {
    if (!path.isAbsolute(req.toolBrokerSettingsPath)) {
      throw new Error("claude_tool_broker_settings_invalid");
    }
    const before = await fs.lstat(req.toolBrokerSettingsPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32_768) {
      throw new Error("claude_tool_broker_settings_invalid");
    }
    const raw = await fs.readFile(req.toolBrokerSettingsPath, "utf8");
    const after = await fs.lstat(req.toolBrokerSettingsPath);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("claude_tool_broker_settings_changed");
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed)) !== JSON.stringify(["hooks"]) ||
      !parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)
    ) {
      throw new Error("claude_tool_broker_settings_invalid");
    }
    hooks = parsed.hooks;
  }

  const encoded = JSON.stringify({
    ...CLAUDE_WORKSPACE_SANDBOX_SETTINGS,
    ...(hooks ? { hooks } : {}),
  });
  if (Buffer.byteLength(encoded, "utf8") > 40_960) {
    throw new Error("claude_execution_settings_too_large");
  }
  return encoded;
}

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

// 구형 claude CLI가 --include-partial-messages를 거부하면 false로 전환해(관측한 실행 파일 세대마다
// 1회 학습) 이후 실행은 플래그 없이 — 메시지 덩어리 스트리밍으로 — 동작한다.

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

export interface ClaudeCodeProbe {
  path: string;
  version: string;
}

export async function probeClaudeCode(): Promise<ClaudeCodeProbe | null> {
  let found: CliExecutableIdentity | null;
  try { found = getExecutable(); } catch { return null; }
  if (!found) return null;
  const version = (await probeCliVersion(found.executable)) ?? "unknown";
  return { path: found.executable, version };
}

function getExecutable(source?: string, cwd = process.cwd(), env = process.env): CliExecutableIdentity | null {
  const childEnv = withCliPath(env);
  for (const bin of source ? [source] : CANDIDATES) {
    const identity = observeCliExecutableIdentity({ bin, cwd, env: childEnv });
    if (identity) return identity;
  }
  return null;
}

type ClaudeExecutableCapabilities = {
  includePartialMessagesSupported: boolean;
  residencySupported: boolean;
  efforts?: Array<{ id: string; label: string }>;
  effortRead?: Promise<Array<{ id: string; label: string }>>;
};
const executableCapabilities = new Map<string, ClaudeExecutableCapabilities>();
function capabilitiesFor(identity: CliExecutableIdentity): ClaudeExecutableCapabilities {
  let capabilities = executableCapabilities.get(identity.generation);
  if (!capabilities) {
    capabilities = { includePartialMessagesSupported: true, residencySupported: true };
    executableCapabilities.set(identity.generation, capabilities);
    if (executableCapabilities.size > 128) executableCapabilities.delete(executableCapabilities.keys().next().value!);
  }
  return capabilities;
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

function runClaudeHelp(bin: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (ok = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok ? out : null);
    };
    const child = spawnCli(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    const outDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (c: Buffer) => (out += outDecoder.write(c)));
    child.on("error", () => finish());
    child.on("close", (code) => finish(code === 0));
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

/** Cache successful help only for the measured executable generation. */
export async function probeClaudeEfforts(): Promise<Array<{ id: string; label: string }>> {
  let identity: CliExecutableIdentity | null;
  try { identity = getExecutable(); } catch { return []; }
  if (!identity) return [];
  const capabilities = capabilitiesFor(identity);
  if (capabilities.efforts) return capabilities.efforts.map((item) => ({ ...item }));
  if (capabilities.effortRead) return capabilities.effortRead;
  const started = (async () => {
    const help = await runClaudeHelp(identity.executable);
    let current: CliExecutableIdentity | null;
    try { current = getExecutable(); } catch { return []; }
    if (!help?.trim() || !current || current.generation !== identity.generation) return [];
    const efforts = parseEffortChoices(help).map((id) => ({ id, label: effortLabel(id) }));
    capabilities.efforts = efforts;
    return efforts.map((item) => ({ ...item }));
  })();
  capabilities.effortRead = started;
  try { return await started; }
  finally { if (capabilities.effortRead === started) capabilities.effortRead = undefined; }
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
/*
 * ★Owner decision 2026-09-07 — a conversation survives a model change.
 *
 * The model used to be part of session identity, on the reasoning that a session belongs to the
 * model that created it. The reasoning is sound and the result was not: a usage limit that moved
 * the run to another model, or the person simply picking a different one, threw the CLI session
 * away. A fresh session receives only the conversation text, so everything the CLI actually held
 * -- files it had read, what its tools returned, the plan it was working from -- was gone, while
 * the transcript on screen stayed continuous and hid it.
 *
 * These CLIs take the model as a per-call argument; the thread is not bound to it. So the model
 * leaves the identity. A different executable still starts a new session, because that genuinely
 * is a different conversation.
 */
function systemFingerprint(req: RunnerRequest, executableFingerprint: string): string {
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
      .update(executableFingerprint).update("\0")
      .update(req.sessionFingerprintSeed)
      .digest("hex");
  }
  return crypto
    .createHash("sha256")
    .update(executableFingerprint).update("\0")
    .update(req.systemPrompt)
    .update("\0")
    .update(req.locale)
    .update("\0")
    .update(req.permission ?? "")
    .update("\0")
    .update(req.forceSurface ? "force-surface" : "normal")
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
  ev: { type?: string; error?: unknown; is_error?: boolean; result?: unknown; terminal_reason?: string;
        api_error_status?: number; rate_limit_info?: { status?: string; resetsAt?: number } },
  finalText: string,
  prior: RunnerFailure | null,
): RunnerFailure | null {
  if (ev.error === "authentication_failed") {
    return {
      kind: "auth",
      message: "authentication_failed",
      runtime: "claude",
      source: "marker",
    };
  }
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

/**
 * 이 CLI 는 `--input-format stream-json` 을 모른다(구형) — 관측한 실행 파일 세대마다 1회 학습해
 * 해당 세대에서 1회성 `-p` 경로를 사용한다. `--include-partial-messages` 학습과 같은 모양.
 */

/** 구형 CLI 판별 — 상주 스폰이 아무 이벤트도 못 내고 죽었을 때 stderr 로만 판정한다. */
function looksLikeUnknownInputFormat(stderr: string): boolean {
  return /input-format/i.test(stderr);
}

const runClaudeTurn = async (
  req: RunnerRequest,
  events: RunnerEvents,
  allowResidency: boolean,
): Promise<RunnerResult> => {
  if (req.restrictedReadBoundary) {
    throw new Error(
      "Claude Code is not enabled for restricted read-only execution because its host filesystem boundary is not release-verified.",
    );
  }
  const executableIdentity = getExecutable(req.runtimeSource, req.cwd ?? agentRunCwd(), req.env ?? process.env);
  if (!executableIdentity) {
    throw new Error(tStatus(req.locale, "errCliMissingClaude"));
  }
  const bin = executableIdentity.executable;
  const executableState = capabilitiesFor(executableIdentity);

  const executableOwner = req.chatId ? {
    chatId: req.chatId,
    sessionOwnerId: req.runtimeSessionOwnerId ?? req.agentId ?? null,
    isolateOwner: req.runtimeSessionOwnerId != null,
    generation: executableIdentity.generation,
  } : null;
  const retainExecutableOwner = executableOwner && allowResidency
    && !req.untrustedNoTools && !req.workforceRuntimeToolGrant
    && !residencyDisabledFor(KIND, req.env ?? process.env)
    ? captureClaudeExecutableOwner(executableOwner) : () => true;

  const stagedImages = await stageCliImageAttachments(req);
  const runReq = stagedImages.images.length > 0 ? { ...req, userPrompt: stagedImages.userPrompt } : req;
  const runtimeSessionOwnerId = runReq.runtimeSessionOwnerId ?? runReq.agentId;
  const isolateRuntimeSessionOwner = runReq.runtimeSessionOwnerId != null;

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
  // Host-authority Workforce row (2026-09-05): the grant travels for the receipt, but the
  // run keeps the host's own MCP wiring and permission mode.
  const hostAuthorityWorkforce = Boolean(runReq.workforceRuntimeToolGrant) && !runReq.untrustedNoTools;
  const workforceGrantHasTools = Boolean(runReq.workforceRuntimeToolGrant?.grantedToolIds.length);
  if (workforceGrantHasTools && !hasExactWorkforceMcpGrant && !hostAuthorityWorkforce) {
    throw new Error("workforce_runtime_tool_grant_config_unverified");
  }
  if (
    runReq.workforceRuntimeToolGrant &&
    !hostAuthorityWorkforce &&
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
  const fingerprint = !runReq.untrustedNoTools && runReq.chatId ? systemFingerprint(runReq, executableIdentity.fingerprint) : null;
  const savedSession = !runReq.untrustedNoTools && runReq.chatId
    ? getRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  const storedSessionId =
    savedSession && fingerprint && savedSession.fingerprint === fingerprint
      ? savedSession.sessionId
      : null;
  if (runReq.chatId && savedSession && fingerprint && savedSession.fingerprint !== fingerprint) {
    events.onStatus(`[runtime-session] fingerprint_changed kind=${KIND}`);
    clearRuntimeSession(runReq.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
  }
  const resumeSessionId = runReq.untrustedNoTools ? null : (runReq.runtimeSessionId ?? storedSessionId);
  // gap-replay — 이 세션이 마지막으로 본 이후 다른 경로(스웜/다른 러너)로 진행된 턴을 메운다.
  // 호출자가 세션 수명을 직접 관리하는 runtimeSessionId(Build 등)에는 적용하지 않는다.
  const gapContext = !runReq.runtimeSessionId && storedSessionId && savedSession
    ? renderGapContext(unseenHistoryGap(runReq.history, savedSession.updatedAt), runReq.locale)
    : "";
  // resume 턴: 시스템 프롬프트가 재전송되지 않으므로 gap+턴 컨텍스트를 사용자 메시지에 싣는다.
  // 새 세션: 턴 컨텍스트를 시스템 프롬프트 뒤에 붙여 세션을 시드한다.
  const continuationPrompt = composeResumeTurnPrompt(
    runReq.userPrompt,
    [gapContext, runReq.turnContext ?? ""].filter(Boolean).join("\n\n"),
    runReq.locale,
  );
  const flatUser = resumeSessionId ? continuationPrompt : flattenHistory(runReq);
  /*
   * 읽기 전용 실행이면 그 사실을 말해 준다 — 도구를 조용히 빼기만 하면 모델은 그것을
   * 일시적 장애로 읽고 우회를 찾는다. 실측: 서브에이전트 위임 → 다른 도구 대체 →
   * 브라우저까지 시도하며 2분을 썼고, 결국 아무것도 못 했다. 경계는 숨길 이유가 없다.
   */
  const readOnlyToolNotice =
    !runReq.untrustedNoTools && req.permission !== "write" && req.permission !== "full"
      ? (runReq.locale === "ko"
        ? `\n\n[읽기 전용 실행] 이 세션에는 파일 쓰기·편집·셸 도구가 없다(제거됨). 서브에이전트 위임이나 다른 도구로 우회하지 마라. 작업에 쓰기·실행이 필요하면 무엇이 왜 필요한지 한 문장으로 말한 뒤, 답의 마지막 줄에 정확히 ${PERMISSION_ESCALATION_MARKER} 를 한 줄로 남겨라 — 앱이 사용자에게 전체 액세스 승격을 묻고, 승인되면 이어서 실행된다. 읽기·검색·분석은 평소대로 하면 된다.`
        : `\n\n[Read-only run] This session has no file write, edit, or shell tools — they were removed. Do not work around it by delegating to a subagent or substituting another tool. If the task needs writing or shell execution, say in one sentence what is needed and why, then put exactly ${PERMISSION_ESCALATION_MARKER} on its own final line — the app will ask the user to escalate to full access and resume. Reading, searching, and analysis work as usual.`)
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
  const permArgs = claudePermissionArgs(req.permission, {
    browserOnly: Boolean(runReq.browserOnly),
    untrustedNoTools: Boolean(runReq.untrustedNoTools),
  });
  const hostObservation = hostAuthorityWorkforce && runReq.workforceRuntimeToolGrant
    ? createClaudeWorkforceObservation({
        grant: runReq.workforceRuntimeToolGrant,
        expectedSessionId: resumeSessionId,
        expectedPermissionMode: runReq.browserOnly ? null
          : req.permission === "full" ? "bypassPermissions"
          : req.permission === "write" ? "acceptEdits" : null,
        deniedTools: !runReq.browserOnly && req.permission !== "write" && req.permission !== "full"
          ? READ_ONLY_DENIED_TOOLS : [],
      })
    : null;

  // 모델 선택 — opus/sonnet/haiku 별칭(또는 풀 ID). 미지정이면 Claude Code 설정 사용.
  const modelArgs = req.model && req.model.trim() ? ["--model", req.model.trim()] : [];
  // 작업량(reasoning effort) — installed CLI가 노출한 값을 그대로 전달. 미지정이면 CLI 기본.
  const effortArgs = req.effort && req.effort.trim() ? ["--effort", req.effort.trim()] : [];
  // 출력 형태 계약 — 실측 claude 2.1.234 `--json-schema <schema>`.
  const schemaArgs = req.outputSchema ? ["--json-schema", JSON.stringify(req.outputSchema.schema)] : [];

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
  // Keep the user's Claude Code tools and plugins available when Agentlas is
  // wrapping the CLI. The native runtime owns its own tool policy; Agentlas
  // must only add its MCP bridge and approval broker. `isolatedMcpConfig` is
  // retained as metadata for audit/replay, but must not silently erase the
  // runtime's settings or plugins.
  const isolatedMcpArgs: string[] = [];
  /*
   * 헤드리스에서 권한 프롬프트로 막히지 않도록 승인된 MCP 툴을 미리 허용한다.
   * ★읽기 실행 포함 — 오너 결정 2026-08-18. 읽기의 경계는 위 READ_ONLY_DENIED_TOOLS
   * (파일 변경·셸)이 이름으로 지키고, MCP 서버는 우리 승인 관문을 이미 통과한 것만
   * 이 목록에 온다. 예전엔 write/full 전용이라, 읽기 실행이 MCP 설정은 받았는데
   * 모든 호출이 승인 대기로 자동 거부되는 반배선 상태가 됐다.
   */
  const mcpPreAllowed =
    runReq.mcpConfigPath &&
    runReq.mcpAllowedTools &&
    runReq.mcpAllowedTools.length > 0 &&
    (!runReq.untrustedNoTools || hasExactUntrustedMcpGrant)
      ? runReq.mcpAllowedTools
      : [];
  /*
   * ★오너 결정(2026-08-15): 묻는 순간이 없는 헤드리스 실행은 **권한 범위 안의 도구를
   * 처음부터 풀어 둔다.** `acceptEdits` 는 파일 편집만 자동 허용하고 Bash·웹은 여전히
   * 물어보는데, `-p` 에는 답할 사람이 없어 런타임이 스스로 거부하고 지나갔다 — 그래서
   * "파일 편집은 되는데 npm test 만 조용히 안 되는" 실행이 나왔고, 그 뒤에 "다음부터
   * 허용?" 카드가 떴다. 사용자가 write 를 골랐다는 것은 프로젝트 안에서 일하라는 뜻이지
   * 셸을 막으라는 뜻이 아니다. 거부를 사후에 알리는 대신 거부가 생길 이유를 없앤다.
   * read 는 파일 변경·셸만 제거하고 웹 조회는 미리 허용한다. 정책 거절은 도구
   * 브로커 PreToolUse 훅이 계속 맡는다 — 허용 깃발은 켜기만 하고 거절은 훅만 한다.
   */
  const builtinPreAllowed = claudeBuiltinPreAllowedTools(req.permission, {
    browserOnly: runReq.browserOnly, untrustedNoTools: runReq.untrustedNoTools,
  });
  const preAllowedTools = [...builtinPreAllowed, ...mcpPreAllowed];
  recordClaudeCapabilityRequest({ permission: req.permission, browserOnly: Boolean(runReq.browserOnly),
    untrustedNoTools: Boolean(runReq.untrustedNoTools), allowedBuiltins: builtinPreAllowed });
  const allowedToolArgs = preAllowedTools.length > 0 ? ["--allowedTools", preAllowedTools.join(",")] : [];
  // ★C38 — 도구 호출 직전 관문. 실측(2026-08-04, claude 2.1.220): PreToolUse deny가
  // `--permission-mode bypassPermissions`를 이기고 Bash 호출을 실제로 막았다. 허용 깃발
  // (`--allowedTools`)은 켜기만 하므로, 선언되지 않은 호출을 거절하는 곳은 여기뿐이다.
  const executionSettings = await claudeExecutionSettings(runReq);
  const toolBrokerArgs = executionSettings ? ["--settings", executionSettings] : [];
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
  // Browser turns still expose Agentlas' approval-gated MCP bridge, while
  // Claude Code's own browser, shell, slash commands, and plugins remain
  // usable. Only the explicit untrustedNoTools path below disables tools.
  const browserOnlyArgs: string[] = [];

  // 시스템 프롬프트(Agentlas 헤더+스킬+프로토콜만 ~24KB)는 argv가 아니라 파일로 전달한다.
  // Windows에서 claude는 `.cmd` 심 → cmd.exe로 실행되고 커맨드라인은 ~8191자 한계라,
  // `--append-system-prompt`에 24KB를 실으면 잘려서 exit 1. `--append-system-prompt-file`은
  // 경로만 넘기므로 안전. 사용자 프롬프트(+히스토리)는 stdin으로 보낸다(`-p`는 stdin을 읽음).
  //
  // 캐시 계약(2026-08-18 A/B 실측, run-e.sh):
  //  - append를 턴1에만 보내면 재개 스폰의 요청 형상이 턴1과 달라져 세션 프리픽스가
  //    매 턴 전액 재작성된다. **같은 바이트를 매 스폰 다시 보내야** 턴2부터 캐시가 읽힌다
  //    (실측: no-fork+매 턴 동일 append = 턴2 write 373tok vs 현행 패턴 = 매 턴 26K+ 재작성).
  //  - 그래서 파일 경로·내용을 세션 수명 동안 고정한다: 키는 chatId|KIND|fingerprint.
  //    fingerprint가 바뀌면 storedSessionId도 함께 버려지므로(위 clearRuntimeSession)
  //    낡은 내용이 재사용될 수 없다. 앱 재시작 등으로 파일이 사라졌으면 append 없이
  //    재개한다(그 턴만 재작성, 다음 세션 생성 때 파일 재생성).
  const stableSysKey = runReq.chatId && fingerprint
    ? crypto.createHash("sha256").update(`${runReq.chatId}\0${KIND}\0${fingerprint}`).digest("hex").slice(0, 20)
    : null;
  const sysPromptFile = stableSysKey
    ? path.join(os.tmpdir(), `agentlas-claude-sys-${stableSysKey}.txt`)
    : path.join(os.tmpdir(), `agentlas-claude-sys-${process.pid}-${crypto.randomUUID()}.txt`);
  let resumeAppendArgs: string[] = [];
  if (!resumeSessionId) {
    try {
      await fs.writeFile(sysPromptFile, seededSystemPrompt, "utf8");
    } catch (error) {
      cleanupAgentAppMcpConfig();
      throw error;
    }
  } else if (stableSysKey) {
    try {
      await fs.access(sysPromptFile);
      resumeAppendArgs = ["--append-system-prompt-file", sysPromptFile];
    } catch {
      // 세션 생성 때의 파일이 없다 — append 없이 재개(레거시 형상). 이 턴만 재작성된다.
    }
  }
  const cleanupSysFile = () => {
    // 고정 파일은 다음 턴이 같은 바이트로 재사용해야 하므로 지우지 않는다(챗당 1개, ~24KB).
    if (!stableSysKey) void fs.unlink(sysPromptFile).catch(() => {});
  };

  // stream-json + verbose: tool_use / 텍스트 / 토큰(usage) 이벤트를 NDJSON으로 받아
  // Claude Code식 tool-use 블록 + 토큰 표시를 가능하게 한다.
  // --include-partial-messages: 텍스트를 메시지 블록 덩어리가 아니라 토큰 델타로 받아
  // 타자기 스트리밍을 가능하게 한다(미지원 구형 CLI는 close 핸들러에서 자동 폴백).
  const partialFlagArgs = executableState.includePartialMessagesSupported ? ["--include-partial-messages"] : [];
  const systemPromptFileFlag = runReq.untrustedNoTools
    ? "--system-prompt-file"
    : "--append-system-prompt-file";
  // --fork-session 제거(2026-08-18 실측): fork는 재개 스폰마다 요청 프리픽스를 바꿔
  // 세션 캐시를 영원히 못 잇게 한다(fork 재개 3턴 연속 write 8.6K+ vs no-fork 3턴째
  // write 360). `-p` 재개는 fork 없이도 매 스폰 새 세션 파일을 만들므로(D실측: 재개마다
  // 새 session_id 반환) 원본 세션 훼손·동시성 문제도 없다.
  const args = resumeSessionId
      ? [
          "--resume",
          resumeSessionId,
          ...resumeAppendArgs,
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          ...partialFlagArgs,
          ...modelArgs,
          ...effortArgs,
          ...schemaArgs,
          ...permArgs,
          ...noToolsArgs,
          ...browserOnlyArgs,
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
          ...schemaArgs,
          ...permArgs,
          ...noToolsArgs,
          ...browserOnlyArgs,
          ...isolatedMcpArgs,
          ...mcpArgs,
          ...allowedToolArgs,
          ...toolBrokerArgs,
        ];

  /*
   * ★상주 — 이 턴이 끝나도 프로세스를 죽이지 않는다(Phase 5, 오너 최우선 요구).
   *
   * 예전에는 매 턴이 `-p`(단발)로 새 프로세스를 띄우고 `--resume` 으로 문맥만 이었다.
   * `--input-format stream-json` 을 붙이면 같은 프로세스가 stdin 으로 여러 턴을 받는다
   * (실측: 두 턴이 같은 pid·같은 session_id). 키가 있는(=대화에 속한) 실행만 풀에서
   * 빌린다 — chatId 가 없는 일회성 실행은 이어 쓸 다음 턴이 정의상 없다.
   *
   * ★상주는 **속도·비용 최적화이지 연속성의 근거가 아니다**(오너 규칙 2026-08-20).
   * 프로세스가 사라져도 손실이 아니다: 연속성은 지금 그대로 세션 id(`--resume`)와
   * 대화 히스토리 재주입이 잇는다. 그래서 아래 모든 실패 경로가 조용히 1회성 경로로
   * 떨어지고, 사용자 화면에는 아무 차이도 남지 않는다.
   */
  const runCwd = req.cwd ?? agentRunCwd();
  const runEnv = req.env ?? process.env;
  const residencyEligible =
    allowResidency &&
    executableState.residencySupported &&
    !residencyDisabledFor(KIND, runEnv) &&
    !runReq.untrustedNoTools &&
    // A pooled process does not repeat system/init for each turn. This
    // Workforce call needs fresh native observations; existing pools stay intact.
    !hostAuthorityWorkforce &&
    Boolean(runReq.chatId) &&
    Boolean(fingerprint);
  const poolKey =
    residencyEligible && runReq.chatId && fingerprint
      ? claudePoolKey({
          chatId: runReq.chatId,
          sessionOwnerId: runtimeSessionOwnerId ?? null,
          isolateOwner: isolateRuntimeSessionOwner,
          fingerprint,
          executableGeneration: executableIdentity.generation,
          cwd: runCwd,
          bin,
          ...(runReq.mcpConfigPath ? { mcpConfigPath: runReq.mcpConfigPath } : {}),
          ...(runReq.toolBrokerSettingsPath ? { toolBrokerSettingsPath: runReq.toolBrokerSettingsPath } : {}),
          args,
          env: runEnv,
        })
      : null;
  const pool = claudeSessionPool();
  let lease: AcpSessionLease<ClaudeResidentSession> | null = null;
  /** 이 세션을 풀에 되돌리면 안 되는가(취소·오류·프로토콜 파손). */
  let broken = false;
  if (poolKey && executableOwner) {
    try {
      const current = getExecutable(req.runtimeSource, runCwd, runEnv);
      if (!retainExecutableOwner() || current?.generation !== executableIdentity.generation) {
        throw new Error("cli_executable_identity_changed_during_preparation");
      }
    } catch (error) {
      cleanupSysFile();
      cleanupAgentAppMcpConfig();
      throw error;
    }
    retireSupersededClaudeSessions(pool, executableOwner);
    try {
      lease = await pool.acquire(
        poolKey,
        {
          agentId: runReq.agentId ?? null,
          nodeId: runReq.orchestrationAgentId ?? runReq.agentId ?? null,
          chatId: runReq.chatId ?? null,
          runtimeKind: KIND,
          source: resolveAgentResidencySource(runReq.agentId),
          reaperExempt: isResidencyExemptAgent(runReq.agentId),
        },
        async () =>
          openClaudeResidentSession({
            executableOwner,
            bin,
            // `--input-format stream-json` 은 `--print` 와 함께만 동작한다(claude --help).
            // args 에는 `-p` 가 이미 들어 있다.
            args: [...args, "--input-format", "stream-json"],
            // 사용자가 워킹 폴더(프로젝트)를 지정했으면 거기서 실행 — 빌드/파일 생성이 프로젝트에 일어난다.
            // 미지정이면 쓰기 가능한 전용 폴더(packaged 앱은 cwd가 비쓰기/루트라 claude가 exit 1).
            cwd: runCwd,
            env: runEnv,
          }),
        retainExecutableOwner,
      );
    } catch {
      // 상주 세션을 못 열었으면 조용히 1회성 경로로 — 사용자에게 차이가 없어야 한다.
      lease = null;
    }
  }
  const session = lease?.session ?? null;

  try {
    return await new Promise<RunnerResult>((resolve, reject) => {
    const rejectRuntime = (error: unknown) => {
      reject(
        runReq.untrustedNoTools
          ? createUntrustedRuntimeFailure()
          : error instanceof Error
            ? error
            : new Error(String(error)),
      );
    };
    let child: ReturnType<typeof spawnCli>;
    if (session) {
      child = session.child;
    } else {
      try {
        child = spawnCli(bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: runEnv,
          cwd: runCwd,
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
    }
    // ★호스트 소유 생존 신호 — 러너 공통 규칙(runner.ts startCliHeartbeat 주석 참고).
    //   stream-json이라도 긴 생각/도구 구간은 수 분 침묵할 수 있고, 그 침묵은
    //   무활동 워치독에게 사망과 구별되지 않는다.
    const stopHeartbeat = startCliHeartbeat(child, events.onStatus, "claude");
    // ★죽은 자식이 close를 안 보내면 이 실행은 영영 안 끝난다 — runner.ts 주석 참고.
    // 상주 세션은 열 때 한 번만 건다(턴마다 걸면 리스너가 쌓인다).
    if (!session) {
      ensureChildCloseAfterExit(child, () => {
        events.onStatus("claude: process exited without closing its output — settling the run");
      });
    }

    // 취소 — 사용자가 Stop을 누르면 자식 프로세스 트리 종료. 병렬 세션 각각 독립 취소.
    // 상주 세션은 취소와 함께 버린다(상태를 모르는 세션을 다음 턴에 물려주지 않는다).
    const onAbort = () => { broken = true; killCliTree(child); };
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let acc = "";
    // 현재 메시지의 토큰 델타(stream_event) 누적분 — assistant 메시지 이벤트가 오면
    // 그 권위 전문으로 acc에 폴드되고 비워진다(델타 누락/중복이 있어도 자가 교정).
    let cur = "";
    let finalText = "";
    let tokens: number | undefined;
    let observedUsage: { inputTokens: number; outputTokens: number } | undefined;
    /** 이번 턴이 실제로 쓴 모델 id — 별칭(opus)이 어느 세대로 풀렸는지. */
    let observedModel: string | undefined;
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
    const toolInputById = new Map<string, unknown>();
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
        // MCP tool results use this array for more than prose. The old
        // compatibility shortcut joined only `text` fields, which silently
        // discarded standard `image`, `audio`, `resource`, and
        // `resource_link` content before it reached the Desktop surfaces.
        // Keep the readable shortcut for text-only arrays, but preserve the
        // typed envelope whenever a rich content item is present.
        const hasRichContent = payload.some((item) => (
          item && typeof item === "object" && !Array.isArray(item)
          && typeof (item as { type?: unknown }).type === "string"
          && (item as { type: string }).type !== "text"
        ));
        if (hasRichContent) {
          // Never place raw base64 media bytes in the live UI or run ledger.
          // Main binds a verified file artifact separately; the readable text
          // metadata remains available for status/debugging.
          const summary = payload.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return item;
            const block = item as Record<string, unknown>;
            const type = typeof block.type === "string" ? block.type : "unknown";
            if (type === "text") return { type, text: typeof block.text === "string" ? block.text : "" };
            if (type === "image" || type === "audio") {
              const mimeType = typeof block.mimeType === "string"
                ? block.mimeType
                : typeof block.mime_type === "string"
                  ? block.mime_type
                  : undefined;
              return { type, ...(mimeType ? { mimeType } : {}), mediaAvailable: true };
            }
            if (type === "resource") {
              const resource = block.resource && typeof block.resource === "object" && !Array.isArray(block.resource)
                ? block.resource as Record<string, unknown>
                : null;
              return {
                type,
                ...(typeof resource?.uri === "string" ? { uri: resource.uri } : {}),
                ...(typeof resource?.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
                mediaAvailable: Boolean(resource?.blob),
              };
            }
            if (type === "resource_link") {
              return {
                type,
                ...(typeof block.uri === "string" ? { uri: block.uri } : {}),
                ...(typeof block.name === "string" ? { name: block.name } : {}),
                ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
              };
            }
            return { type };
          });
          try { return JSON.stringify(summary); } catch { return "Rich MCP result"; }
        }
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
      /*
       * ★어느 모델이 실제로 돌았는지 — 벤더가 result 이벤트에 직접 싣는다.
       * 실측(claude 2.1.263): {"modelUsage":{"claude-opus-5[1m]":{…}}}.
       * 우리가 보낸 것은 별칭 `opus` 뿐이므로, 세대를 아는 유일한 길이 이 칸이다.
       */
      modelUsage?: Record<string, unknown>;
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
      if (hostObservation) {
        hostObservation.observe(ev);
        if (hostObservation.error) {
          killCliTree(child, 250);
          return;
        }
      }
      if (agentAppMcpInitFailed) return;
      const isAgentAppMcpInit = ev.type === "system" && ev.subtype === "init";
      if (isAgentAppMcpInit) recordClaudeCapabilityInit(ev.tools);
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
        runnerFailure = claudeFailureFromEvent(ev, finalText, runnerFailure);
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
              toolInputById.set(block.id, block.input);
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
            const artifactPaths = toolId && block.is_error !== true
              ? [
                  ...claudeArtifactPathsFromToolUse(toolName, toolInputById.get(toolId)),
                  ...claudeArtifactPathsFromToolResult(toolName, block.content),
                ]
              : [];
            events.onTool?.(toolName, undefined, result, toolId, block.is_error === true, artifactPaths);
            if (toolId) toolInputById.delete(toolId);
          }
        }
      } else if (ev.type === "user" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type !== "tool_result") continue;
          const toolId = block.tool_use_id;
          const toolName = toolId ? toolNameById.get(toolId) ?? "tool_result" : "tool_result";
          const result = truncateUi(stringifyToolPayload(block.content));
          if (block.is_error === true) announceApprovalBlock(result, toolId);
          const artifactPaths = toolId && block.is_error !== true
            ? [
                ...claudeArtifactPathsFromToolUse(toolName, toolInputById.get(toolId)),
                ...claudeArtifactPathsFromToolResult(toolName, block.content),
              ]
            : [];
          events.onTool?.(toolName, undefined, result, toolId, block.is_error === true, artifactPaths);
          if (toolId) toolInputById.delete(toolId);
        }
      } else if (ev.type === "rate_limit_event") {
        // ★한도 거절은 표식이다 — 예전에는 케이스가 없어 조용히 버려졌다(분류는 순수 함수 한 곳).
        runnerFailure = claudeFailureFromEvent(ev, finalText, runnerFailure);
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") finalText = ev.result;
        // 별칭이 어느 세대로 풀렸는지는 이 이벤트만 안다(위 observedClaudeModelId 주석).
        observedModel = observedClaudeModelId(ev.modelUsage) ?? observedModel;
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

    /** 이 턴은 한 번만 정산된다 — 상주 경로는 result 이벤트와 프로세스 사망 둘 다 올 수 있다. */
    let settled = false;
    /** 이 턴이 result 까지 갔는가(상주 세션을 되돌려도 되는가의 판정). */
    let sawResult = false;
    const detachTurn = () => {
      stopHeartbeat();
      if (session) {
        // 유휴 세션이 지난 턴의 events 로 상태를 흘리면 안 된다(ACP 와 같은 계약).
        if (session.active === turnSink) session.active = null;
      } else {
        // 프로세스 종료 시 stdout/stderr data 리스너를 제거해 누수 방지.
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
      }
      cleanupSysFile();
      cleanupAgentAppMcpConfig();
    };

    /** 줄 하나 → 이벤트 소비. 일회성/상주 두 경로가 같은 소비자를 쓴다. */
    const dispatchEvent = (ev: ClaudeStreamEvent): void =>
      handleEvent(ev as unknown as Parameters<typeof handleEvent>[0]);

    if (!session) {
      child.stdout?.on("data", createNdjsonLineReader(dispatchEvent));
      const stderrDecoder = new StringDecoder("utf8");
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += stderrDecoder.write(chunk);
      });
    }

    const onProcessError = (err: Error) => {
      if (settled) return;
      settled = true;
      broken = true;
      detachTurn();
      rejectRuntime(err);
    };
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (code !== 0) broken = true;
      detachTurn();
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        // 취소여도 CLI가 이미 세션을 디스크에 남겼으면 저장한다 → 사용자가 이어서 보내는
        // steering 메시지가 이 세션을 resume해 "실행 중 방향 전환"처럼 문맥을 유지한다.
        if (req.chatId && fingerprint && sessionId) {
          saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
        }
        rejectRuntime(abortReasonError(req));
        return;
      }
      if (hostObservation?.error) {
        rejectRuntime(new Error(hostObservation.error));
        return;
      }
      /*
       * ★상주 턴이 `result` 를 못 봤다 — 세션이 죽었거나 프로토콜이 깨졌다. 이건 사용자의
       * 문제가 아니라 우리가 물려준 세션의 문제다. 조용히 버리고 기존 1회성 `-p --resume`
       * 경로로 **한 번** 다시 간다(그 호출은 상주를 쓰지 않으므로 무한 재시도가 불가능하다).
       * 이미 본문이 나온 뒤라면 재시도가 화면에 답을 두 번 쓰게 되므로 하지 않는다.
       */
      if (session && !sawResult && !combined() && !finalText) {
        broken = true;
        const why = (stderr || session.stderrTail).slice(-500);
        if (session.completedTurns === 0 && looksLikeUnknownInputFormat(why)) {
          // 구형 CLI 는 `--input-format` 자체를 모른다 — 해당 실행 파일 세대에서 1회성 경로로 전환.
          executableState.residencySupported = false;
          console.warn(`[residency] claude-code degraded to one-shot: ${why.trim().slice(0, 200)}`);
          events.onStatus(`[residency] disabled kind=${KIND} reason=input-format-unsupported`);
        }
        void runClaudeTurn(req, events, false).then(resolve, reject);
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
        void runClaudeTurn({
          ...runReq,
          mcpConfigPath: undefined,
          mcpAllowedTools: undefined,
          untrustedAllowedMcpTools: undefined,
          env: stripAgentAppMcpSecretAliases(runReq.env),
          agentAppMcpFallbackAttempted: true,
        }, events, false).then(resolve, reject);
        return;
      }
      if (code === 0) {
        let observedHostEnforcement: RunnerResult["workforcePermissionEnforcement"];
        if (hostObservation && !runnerFailure && !structuredRuntimeError) {
          try {
            observedHostEnforcement = workforceObservedHostAuthorityEnforcement(runReq, KIND, hostObservation.finish());
          } catch (error) {
            rejectRuntime(error);
            return;
          }
        }
        // 표시 본문은 스트리밍 전사본(모든 assistant 메시지 \n-join) 우선 — result 이벤트의
        // finalText는 '마지막 메시지'만 담아, 이걸 우선하면 도구 사이 중간 해설이 완료 순간
        // 통째로 사라지고 인터리브 앵커가 전부 틀어진다. finalText는 델타 스트리밍이 전혀
        // 없었던 폴백(구형 CLI 등)에서만 쓴다.
        const streamed = combined();
        const display = streamed || finalText;
        if (display) events.onPartial(display);
        if (req.chatId && fingerprint && sessionId) {
          if (!saveRuntimeSession(req.chatId, KIND, sessionId, fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
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
          ...(observedModel ? { observedModel } : {}),
          workforcePermissionEnforcement: hostAuthorityWorkforce
            ? observedHostEnforcement
            : hasExactWorkforceMcpGrant
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
        // Provider markers are a completed typed outcome even when the CLI
        // exits non-zero. Returning RunnerResult.failure lets orchestrators
        // move to a different live provider without scraping a localized
        // error sentence or retrying the same signed-out account.
        if (runnerFailure) {
          resolve({
            text: (combined() || finalText || runnerFailure.message).trim(),
            failure: runnerFailure,
            tokens,
            observedUsage,
            ...(observedModel ? { observedModel } : {}),
            workforcePermissionEnforcement: hostAuthorityWorkforce
            ? undefined
            : hasExactWorkforceMcpGrant
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
          return;
        }
        if (structuredRuntimeError) {
          rejectRuntime(structuredRuntimeError);
          return;
        }
        if (hostAuthorityWorkforce) {
          // A failed host invocation has no completed observation. Replaying
          // automatically would create a different invocation and hide that gap.
          rejectRuntime(new Error(`workforce_claude_host_observation_process_failed:${code}`));
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
        if (executableState.includePartialMessagesSupported && /include-partial-messages/i.test(stderr)) {
          executableState.includePartialMessagesSupported = false;
          void runClaudeTurn(req, events, false).then(resolve, reject);
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
        if (resumeSessionId && req.chatId) clearRuntimeSession(req.chatId, KIND, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
        if (resumeSessionId) {
          events.onStatus(`[runtime-session] resume_failed kind=${KIND} exit=${code}`);
          if (req.unattended) {
            reject(new Error(`Automation runtime session resume failed for ${KIND}; refusing to create a fresh CLI session.`));
            return;
          }
          // Interactive chat may recover with full durable history after the receipt.
          void runClaudeTurn({ ...req, runtimeSessionId: undefined }, events, false).then(resolve, reject);
          return;
        }
        reject(new Error(`claude CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`));
      }
    };

    /**
     * 이번 턴의 수신자. 세션은 여러 턴을 살고 받는 사람은 턴마다 다르다 — 정산 신호가
     * close(종료코드)가 아니라 `result` 이벤트라는 점만 일회성 경로와 다르다.
     */
    const turnSink: ClaudeTurnSink = {
      onEvent: (ev) => {
        dispatchEvent(ev);
        if (ev.type === "result") {
          sawResult = true;
          if (session) session.completedTurns += 1;
          // 같은 청크에 뒤따라오는 줄까지 소비한 뒤 정산한다.
          queueMicrotask(() => settle(structuredRuntimeError ? 1 : 0));
        }
      },
      onStderr: (chunk) => { stderr += chunk; },
      onDeath: (code) => settle(code),
    };

    if (session) {
      /*
       * ★상주 턴 — 프로세스는 이미 살아 있고, 우리는 stdin 으로 한 줄을 보낸 뒤
       * 이 턴의 `result` 까지 읽는다.
       */
      session.active = turnSink;
      const turnText = lease && !lease.fresh ? continuationPrompt : flatUser;
      if (!claudeResidentSessionAlive(session) || !writeClaudeResidentTurn(session, turnText)) {
        // 빌린 순간과 쓰는 순간 사이에 죽었거나 stdin 이 닫혔다 — 조용히 1회성 경로로.
        settle(null);
      }
    } else {
      child.on("error", onProcessError);
      child.on("close", (code) => settle(typeof code === "number" ? code : null));
    }
    });
  } finally {
    if (lease) {
      // 취소·오류면 버리고, 아니면 반납한다(다음 턴이 이어 쓴다).
      if (broken || req.signal?.aborted) pool.discard(lease);
      else pool.release(lease);
    }
  }
};

/**
 * Claude Code 러너. 상주(프로세스 재사용)를 먼저 시도하고, 그 경로가 막히면 조용히
 * 기존 1회성 `-p --resume` 경로로 떨어진다 — 사용자에게는 아무 차이가 없어야 한다.
 */
export const runClaudeCode: Runner = (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> =>
  runClaudeTurn(req, events, true);
