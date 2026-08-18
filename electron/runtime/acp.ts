// Generic ACP runner — one client for every runtime that speaks the Agent Client
// Protocol (PRD 2026-08-15 D-5). Replaces the weak hand-coded drivers of the
// "B" grade runtimes (cursor: no tool display; grok: tool kind guessed from
// `type` strings; kimi: absent from the terminal). Claude Code and Codex stay
// on their native stream drivers on purpose: ACP's usage_update is context
// occupancy, not input/output tokens, and their adapters add a process hop.
//
// What every ACP agent gives us identically:
//   agent_message_chunk → onPartial     agent_thought_chunk → onThinking
//   plan                → onStatus      tool_call(_update)  → onTool (fixed vocabulary)
//   stopReason          → RunnerResult.failure (marker, never a text guess)
//
// Boundaries (PRD 2026-08-13 §8 round 2, coverage plan §1.3): the initialize
// self-report is a tool surface, not a trust surface; session/request_permission
// is not the approval chokepoint (claude-agent-acp runs bypassPermissions and
// never asks) — read-only runs still refuse mutating tools when asked, but the
// real gate lives elsewhere.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  AcpConnection,
  ACP_PROTOCOL_VERSION,
  AcpRpcError,
  acpMcpServersFromConfig,
  chooseAuthMethod,
  modeOptionsFromNewSession,
  modelOptionsFromNewSession,
  type AcpMcpTranslation,
} from "./acp-protocol";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { ensureChildCloseAfterExit, startCliHeartbeat, wrapSystemPrompt } from "./runner";
import { agentRunCwd, detachedSpawnOpts, killCliTree, spawnCli, trackRunChild } from "./exec";
import { pickLocale, tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { CLI_HISTORY_CONTEXT_TOKENS, composeResumeTurnPrompt, renderConversationContext } from "./continuity";
import { stageCliImageAttachments } from "./image-attachments";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { classifyDiscovery, type DiscoveryOutcome } from "../../shared/model-discovery";

/** How to spawn an ACP agent. Adding a runtime = one row (mirrors contracts/runtime-registry.json). */
export interface AcpAgentSpec {
  id: string;
  label: string;
  /** Executable; the detected absolute path (RuntimeStatus.source) replaces it at run time. */
  command: string;
  args: string[];
  /** Registry id in agentclientprotocol/registry, for drift monitoring. */
  registryId?: string;
}

export const ACP_AGENTS: Record<string, AcpAgentSpec> = {
  cursor: { id: "cursor", label: "Cursor Agent (ACP)", command: "cursor-agent", args: ["acp"], registryId: "cursor" },
  grok: { id: "grok", label: "Grok Build (ACP)", command: "grok", args: ["agent", "stdio"], registryId: "grok-build" },
  kimi: { id: "kimi", label: "Kimi CLI (ACP)", command: "kimi", args: ["acp"], registryId: "kimi" },
  // 오너 결정(2026-08-18): 내장 제공은 **구독 인증 자산이 있는 CLI만** 둔다.
  // OpenCode·Goose는 자체 모델도 구독도 없이 사용자의 API 키를 중개하는 껍데기라,
  // 우리가 BYOK로 직접 부르는 것과 결과가 같으면서 러너 계약(캐시·세션·usage)만 하나
  // 더 늘린다 — 내장 목록에서 제거했다. 사용자가 원하면 설정의 ACP 프로필로 직접
  // 등록할 수 있다(그 자리는 "사용자가 추가한 것"이지 우리가 제공하는 것이 아니다).
  "github-copilot-cli": { id: "github-copilot-cli", label: "GitHub Copilot CLI (ACP)", command: "npx", args: ["-y", "@github/copilot@1.0.80", "--acp"], registryId: "github-copilot-cli" },
  // gemini(레지스트리에 `gemini --acp` 로 선언돼 있다)는 일부러 내장하지 않는다.
  // 실측 2026-08-18 (gemini-cli 0.55.1): initialize 는 loadSession/image/http+sse 를
  // 전부 광고하지만, 개인 Google 계정의 session/new 가 "Gemini Code Assist for
  // individuals 는 더 이상 지원하지 않는다 — Antigravity 로 옮겨라"로 거절한다.
  // 그 계정의 답은 이미 있는 antigravity 런타임이고, 내장 목록을 늘리면 구독 패널·
  // 대시보드(runtime-surface-parity 계약)에도 연결 버튼이 생겨 대다수에게 실패하는
  // 길을 화면에 새로 여는 셈이 된다. Vertex/유료 계정용으로 열려면 오너 결정으로
  // ACP_KIND_BUILTINS·SUBSCRIPTION_RUNTIMES·설정/대시보드 표 세 곳을 함께 고칠 것.
};

/** Runtimes whose pickRunner path prefers ACP over the legacy hand driver. */
export const ACP_PREFERRED_KINDS = new Set(["cursor", "grok", "kimi"]);

/** `AGENTLAS_DISABLE_ACP=1` (or `=cursor,grok`) restores the legacy drivers. */
export function acpDisabledFor(kind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTLAS_DISABLE_ACP ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "1" || raw === "true" || raw === "all") return true;
  return raw.split(/[,\s]+/).includes(kind);
}

/** ACP tool-call kinds → label. Fixed by the protocol; identical across agents. */
const TOOL_KIND_LABEL: Record<string, string> = {
  read: "read", edit: "edit", delete: "delete", move: "move", search: "search",
  execute: "execute", think: "think", fetch: "fetch", other: "tool",
};
export function normalizeToolKind(kind: unknown): string {
  const k = String(kind ?? "other").toLowerCase();
  return TOOL_KIND_LABEL[k] ? k : "other";
}

interface ToolState { title?: string; kind?: string; status?: string; reported?: boolean }

/**
 * Live approval hook (tool-approval contract, v1.0.16). ACP is the only path
 * where the runtime asks BEFORE executing, so a real user decision can be
 * attached here. The arbiter is injected (not imported) so this file stays
 * standalone; electron/runtime/tool-approval.ts registers itself via
 * setAcpPermissionArbiter(...). Without an arbiter the conservative default
 * below applies (never a silent allow of a mutating tool on a read run).
 */
export interface AcpPermissionAsk {
  runtime: string;
  sessionKey: string;
  tool: string;
  kind: string;
  detail?: string;
  cwd?: string;
  permission: RunnerRequest["permission"];
  mutating: boolean;
  /** 이 실행이 붙어 있는 대화 — 승인 카드는 그 대화 안에서만 뜬다(오너 결정 2026-08-15). */
  chatId?: string;
  /** 자동화·그래프처럼 답할 사람이 없는 실행 — 묻지 않고 즉시 거부한다. */
  unattended?: boolean;
}
export type AcpPermissionDecision = "allow_once" | "allow_session" | "deny";
export type AcpPermissionArbiter = (ask: AcpPermissionAsk) => Promise<AcpPermissionDecision>;
let permissionArbiter: AcpPermissionArbiter | null = null;
export function setAcpPermissionArbiter(arbiter: AcpPermissionArbiter | null): void {
  permissionArbiter = arbiter;
}

/** Client-side handling of one session's stream. */
class AcpSessionClient {
  text = "";
  contextUsed?: number;
  contextSize?: number;
  private readonly tools = new Map<string, ToolState>();
  private thinking = false;
  private thinkingStartedAt = 0;
  /**
   * ★session/load 는 지난 대화 전체를 session/update 로 다시 흘려보낸다(스펙: 클라이언트가
   * UI를 복원하라는 뜻). 그걸 그대로 받으면 이번 턴의 답 앞에 옛 답변이 통째로 붙고 옛
   * 도구 호출이 다시 보고된다 — 재생 구간은 통째로 무시하고 세션 상태만 얻는다.
   */
  private replaying = false;

  constructor(
    private readonly events: RunnerEvents,
    private readonly permission: RunnerRequest["permission"],
    private readonly locale: "ko" | "en",
    private readonly approval: { runtime: string; sessionKey: string; cwd?: string; chatId?: string; unattended?: boolean } = { runtime: "acp", sessionKey: "acp" },
  ) {}

  /** Everything between these two calls is history replay, not this turn. */
  beginReplay(): void { this.replaying = true; }
  endReplay(): void {
    this.replaying = false;
    this.text = "";
    this.tools.clear();
    this.thinking = false;
  }

  onUpdate(params: any): void {
    if (this.replaying) return;
    const update = params?.update ?? params;
    switch (update?.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = textOf(update.content);
        if (chunk) {
          this.endThinking();
          this.text += chunk;
          this.events.onPartial(this.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (!this.thinking) {
          this.thinking = true;
          this.thinkingStartedAt = Date.now();
          this.events.onThinking?.("start");
        }
        // 생각 텍스트는 자기 행으로 — 본문(partial)에 섞지 않는다. Gemini CLI는
        // "**주제**\n\n본문" 꼴로 오므로 첫 줄이 곧 진행 헤드라인이 된다.
        const thought = textOf(update.content);
        if (thought) this.events.onThinking?.("delta", undefined, thought);
        break;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        if (entries.length) this.events.onStatus(this.locale === "ko" ? `계획 ${entries.length}단계` : `Plan · ${entries.length} steps`);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.endThinking();
        this.handleToolCall(update);
        break;
      }
      case "usage_update": {
        // Context occupancy, NOT tokens. Never forwarded as onUsage (it would lie).
        const used = numberOf(update.used);
        const size = numberOf(update.size);
        if (used !== undefined && size !== undefined) { this.contextUsed = used; this.contextSize = size; }
        break;
      }
      default:
        break;
    }
  }

  private handleToolCall(update: any): void {
    const id = String(update.toolCallId ?? update.tool_call_id ?? "");
    if (!id) return;
    const prev = this.tools.get(id) ?? {};
    const merged: ToolState = {
      title: update.title ?? prev.title,
      kind: update.kind ?? prev.kind,
      status: update.status ?? prev.status,
      reported: prev.reported,
    };
    this.tools.set(id, merged);
    const done = merged.status === "completed" || merged.status === "failed";
    if (!done || merged.reported) return;
    merged.reported = true;
    const kind = normalizeToolKind(merged.kind);
    const label = TOOL_KIND_LABEL[kind];
    this.events.onTool?.(merged.title ? `${label}: ${merged.title}` : label, undefined, undefined, id, merged.status === "failed");
  }

  /**
   * session/request_permission. With a registered arbiter (tool-approval
   * contract) the USER decides live — including read runs, where asking beats
   * a silent refusal. Without one: conservative default (read+mutating →
   * reject, else allow). Either way this is not the trust boundary — agents may
   * run with bypassPermissions and never ask.
   */
  async answerPermission(params: any): Promise<any> {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const readOnly = this.permission === "read" || this.permission === undefined;
    const kind = normalizeToolKind(params?.toolCall?.kind);
    const mutating = !["read", "search", "fetch", "think"].includes(kind);
    const find = (...kinds: string[]) => options.find((o) => kinds.includes(String(o?.kind)));
    const rejectOption = () => find("reject_once", "reject_always") ?? options.find((o) => /reject|deny/i.test(String(o?.optionId)));
    const allowOption = (session: boolean) =>
      (session ? find("allow_always", "allow_once") : find("allow_once", "allow_always")) ?? options.find((o) => /allow/i.test(String(o?.optionId)));
    const selected = (option: any) => (option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });

    if (permissionArbiter) {
      let decision: AcpPermissionDecision = "deny";
      try {
        decision = await permissionArbiter({
          runtime: this.approval.runtime,
          sessionKey: this.approval.sessionKey,
          tool: String(params?.toolCall?.title ?? kind),
          kind,
          detail: typeof params?.toolCall?.rawInput === "string" ? params.toolCall.rawInput : undefined,
          cwd: this.approval.cwd,
          permission: this.permission,
          mutating,
          chatId: this.approval.chatId,
          unattended: this.approval.unattended,
        });
      } catch {
        decision = "deny"; // an arbiter failure must never turn into an allow
      }
      if (decision === "deny") return selected(rejectOption());
      return selected(allowOption(decision === "allow_session"));
    }
    if (readOnly && mutating) return selected(rejectOption());
    return selected(allowOption(false));
  }

  private endThinking(): void {
    if (!this.thinking) return;
    this.thinking = false;
    this.events.onThinking?.("end", Date.now() - this.thinkingStartedAt);
  }

  finish(): void { this.endThinking(); }
}

function textOf(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  const c = content as Record<string, any>;
  return typeof c.text === "string" ? c.text : "";
}
function numberOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface Session {
  child: ChildProcess;
  conn: AcpConnection;
  init: any;
}

async function openAcp(
  spec: AcpAgentSpec,
  opts: {
    command?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    handlers: { onNotification?: (m: string, p: any) => void; onRequest?: (m: string, p: any) => any };
    timeoutMs: number;
    /** 있으면 생존 신호와 고아 stdio 통지를 이 채널로 낸다(실행 경로). */
    onStatus?: (status: string) => void;
    label?: string;
  },
): Promise<Session> {
  const child = spawnCli(opts.command ?? spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env,
    ...detachedSpawnOpts(),
  });
  trackRunChild(child);
  /*
   * ★ACP 러너도 자식을 띄운다 — 그러므로 같은 정산 계약이 필요하다.
   *
   * `pickRunner` 는 cursor·grok·kimi 를 이 러너로 보낸다(ACP_PREFERRED_KINDS).
   * 즉 그 세 런타임의 **실제 실행 경로가 여기**다. 손 드라이버 쪽에만 정산을 달고
   * 이 자리를 비워 두면, 고친 코드가 안 쓰이는 경로에만 있는 셈이 된다.
   *
   * Node 계약상 `close` 는 자식의 stdio 가 전부 닫혀야 오는데, 에이전트가 파이프를
   * 상속한 손자를 남기고 죽으면 영영 오지 않는다 — runner.ts 주석 참고.
   */
  const stopAcpHeartbeat = opts.onStatus
    ? startCliHeartbeat(child, opts.onStatus, opts.label ?? spec.id)
    : () => {};
  ensureChildCloseAfterExit(child, () => {
    opts.onStatus?.(`${opts.label ?? spec.id}: agent exited without closing its output — settling the session`);
  });
  child.on("close", () => stopAcpHeartbeat());
  child.on("error", () => stopAcpHeartbeat());
  const conn = new AcpConnection(child, opts.handlers);
  const init = await conn.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "agentlas-desktop", version: "1.0" },
  }, { timeoutMs: opts.timeoutMs });
  if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    killCliTree(child);
    throw new Error(`ACP protocolVersion ${String(init?.protocolVersion)} unsupported (client speaks v${ACP_PROTOCOL_VERSION} only)`);
  }
  const authMethods: any[] = Array.isArray(init?.authMethods) ? init.authMethods : [];
  if (authMethods.length > 0) {
    const chosen = chooseAuthMethod(authMethods, opts.env);
    if (chosen?.id) {
      try {
        await conn.request("authenticate", { methodId: chosen.id }, { timeoutMs: opts.timeoutMs });
      } catch {
        // Already-logged-in runtimes may reject authenticate yet accept
        // session/new; if not, session/new fails loudly right after.
      }
    }
  }
  return { child, conn, init };
}

/**
 * Model discovery through ACP: session/new configOptions[category=model].
 * Zero text parsing. Used by detect for kinds that speak ACP.
 */
export async function probeAcpModels(
  spec: AcpAgentSpec,
  opts?: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<DiscoveryOutcome & { init?: any }> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  let session: Session | null = null;
  try {
    session = await openAcp(spec, { command: opts?.command, cwd: opts?.cwd ?? agentRunCwd(), env: opts?.env ?? process.env, handlers: {}, timeoutMs });
    const created = await session.conn.request("session/new", { cwd: opts?.cwd ?? agentRunCwd(), mcpServers: [] }, { timeoutMs });
    const rows = modelOptionsFromNewSession(created);
    const outcome = classifyDiscovery({ stdout: rows.length ? rows.map((r) => r.id).join("\n") : "", models: rows.map((r) => r.id), source: "acp" });
    if (rows.length === 0) outcome.reason = "acp:no-model-config-option";
    // The agent's own current model is the right default — never the first row of
    // an alphabetical list (live E2E 2026-08-15: OpenCode's first row was a Vertex
    // model whose credential file was gone, so a fresh chat failed on auth).
    const current = rows.find((r) => r.current)?.id;
    return { ...outcome, ...(current ? { defaultModel: current } : {}), init: session.init };
  } catch (err) {
    // 여기서도 사유는 data 에 있다 — `acp:Internal error` 만 남기면 모델 탐지 실패를
    // 아무도 진단할 수 없다(실측: goose 의 provider 미설정이 정확히 그 모습이었다).
    const raw = err instanceof Error ? err.message : String(err);
    const data = err instanceof AcpRpcError ? err.data : undefined;
    const detail = data == null ? "" : (typeof data === "string" ? data : JSON.stringify(data));
    return { status: "failed", models: [], rawLineCount: 0, reason: `acp:${detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw}`, source: "acp" };
  } finally {
    if (session) {
      try { session.conn.close(); } catch { /* ignore */ }
      try { killCliTree(session.child, 500); } catch { /* ignore */ }
    }
  }
}

const acpProbeCache = new Map<string, { at: number; outcome: DiscoveryOutcome & { init?: any } }>();
export const ACP_PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * Cached ACP discovery for detect(): spawning a full agent per 10s detect tick
 * would be far too heavy, so one probe per (spec, command) is reused for 10
 * minutes; a failed probe is retried after 1 minute.
 */
export async function probeAcpModelsCached(
  spec: AcpAgentSpec,
  opts?: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; now?: number },
): Promise<DiscoveryOutcome & { init?: any }> {
  const key = `${spec.id}\u0000${opts?.command ?? spec.command}`;
  const now = opts?.now ?? Date.now();
  const hit = acpProbeCache.get(key);
  if (hit) {
    const ttl = hit.outcome.status === "ok" ? ACP_PROBE_TTL_MS : 60_000;
    if (now - hit.at < ttl) return hit.outcome;
  }
  const outcome = await probeAcpModels(spec, opts);
  acpProbeCache.set(key, { at: now, outcome });
  return outcome;
}

/** Test hook. */
export function resetAcpProbeCacheForTests(): void {
  acpProbeCache.clear();
}

/**
 * Session-mode policy. Mode ids are vendor words, so match on id AND name and
 * only send a mode we actually recognise — guessing into an unknown mode could
 * silently widen a read-only run. `read` is where the product's plan intent
 * lives: plan/ask modes are exactly "look, propose, do not change".
 */
const MODE_PREFERENCE: Record<"read" | "write" | "full", RegExp[]> = {
  read: [/^plan(ning)?$/i, /^(ask|chat|review)$/i, /^read[-_ ]?only$/i, /plan/i, /read[-_ ]?only/i, /\bask\b/i],
  write: [/^(code|edit|build|write|agent|default)$/i, /accept[-_ ]?edits/i, /^auto$/i],
  full: [/bypass/i, /yolo/i, /full[-_ ]?access/i, /danger/i, /^(code|edit|build|write|agent|default)$/i],
};

/** Which advertised mode does this run's permission ask for? undefined = leave the agent's default. */
export function chooseAcpModeId(
  permission: RunnerRequest["permission"],
  modes: Array<{ id: string; name?: string }>,
): string | undefined {
  if (modes.length === 0) return undefined;
  const key: "read" | "write" | "full" = permission === "write" || permission === "full" ? permission : "read";
  for (const rule of MODE_PREFERENCE[key]) {
    const hit = modes.find((m) => rule.test(m.id) || (m.name ? rule.test(m.name) : false));
    if (hit) return hit.id;
  }
  return undefined;
}

/**
 * Runtime-session key. ACP session ids are NOT interchangeable with the legacy
 * driver's ids (`grok --resume <id>` cannot load an ACP session), so the two
 * paths must never read each other's row — `AGENTLAS_DISABLE_ACP` flips the
 * runner mid-conversation and would otherwise resume the wrong kind of id.
 */
export function acpSessionKind(specId: string): string {
  return `acp:${specId}`;
}

/** Our MCP config file (or Main's inline JSON for restricted Agent Apps). */
async function readMcpConfig(mcpConfigPath: string | undefined): Promise<unknown | null> {
  const raw = mcpConfigPath?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith("{") ? raw : await fs.readFile(raw, "utf8"));
  } catch {
    return null;
  }
}

/** Runner factory — one Runner per ACP agent spec. */
export function createAcpRunner(spec: AcpAgentSpec): Runner {
  return async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
    const locale = pickLocale(req);
    events.onStatus(tStatus(locale, "callingBackend", { backend: req.backendLabel || spec.label }));
    const cwd = req.cwd ?? agentRunCwd();
    const client = new AcpSessionClient(events, req.permission, locale, {
      runtime: spec.id,
      sessionKey: `${spec.id}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`,
      cwd,
      chatId: req.chatId,
      unattended: req.unattended === true,
    });
    const sessionKind = acpSessionKind(spec.id);
    // 세션 정체성 — 모델/시스템 프롬프트가 바뀌면 이어갈 세션도 달라진다(형제 러너와 동일 규칙).
    const fingerprint = req.chatId
      ? createHash("sha256")
        .update("acp-session-v1\0")
        .update(spec.id)
        .update("\0")
        .update(req.sessionFingerprintSeed ?? req.systemPrompt ?? "")
        .update("\0")
        .update(req.model ?? "")
        .update("\0")
        // 권한은 세션 모드로 굳는다(session/set_mode 는 새 세션에서만 고를 수 있다).
        // 권한이 바뀌면 지문이 달라져 그 권한에 맞는 새 세션이 열린다.
        .update(req.permission ?? "")
        .digest("hex")
      : null;
    const savedSession = req.chatId ? getRuntimeSession(req.chatId, sessionKind) : null;
    const storedSessionId = savedSession && fingerprint && savedSession.fingerprint === fingerprint ? savedSession.sessionId : null;
    const resumeSessionId = req.runtimeSessionId ?? storedSessionId;
    let session: Session | null = null;
    const onAbort = () => { if (session) killCliTree(session.child); };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session = await openAcp(spec, {
        command: req.runtimeSource,
        cwd,
        env: req.env ?? process.env,
        timeoutMs: 60_000,
        onStatus: (s) => events.onStatus(s),
        label: req.backendLabel || spec.label,
        handlers: {
          onNotification: (method, params) => { if (method === "session/update") client.onUpdate(params); },
          onRequest: async (method, params) => {
            if (method === "session/request_permission") return client.answerPermission(params);
            throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
          },
        },
      });
      /*
       * ★MCP — 예전에는 이 자리가 항상 `mcpServers: []` 였다.
       * 그래서 사용자가 승인한 MCP 서버는 ACP 경로(=cursor·grok·kimi 의 실제 실행 경로)로
       * 단 하나도 전달되지 않았고, "도구가 붙었다"고 알고 시작한 실행이 도구 0개로 돌았다.
       * 전송이 안 되는 서버는 조용히 버리지 않고 상태줄로 말한다.
       */
      const agentCaps = session.init?.agentCapabilities ?? {};
      const mcp: AcpMcpTranslation = acpMcpServersFromConfig(
        await readMcpConfig(req.mcpConfigPath),
        agentCaps.mcpCapabilities ?? null,
      );
      if (mcp.servers.length > 0) {
        events.onStatus(locale === "ko" ? `MCP 서버 ${mcp.servers.length}개 연결됨` : `${mcp.servers.length} MCP server(s) attached`);
      }
      if (mcp.unsupported.length > 0) {
        const names = mcp.unsupported.map((s) => `${s.name}(${s.transport})`).join(", ");
        events.onStatus(locale === "ko"
          ? `이 에이전트가 지원하지 않는 MCP 전송이라 제외했습니다: ${names}`
          : `Skipped MCP servers whose transport this agent does not support: ${names}`);
      }
      if (mcp.malformed.length > 0) {
        events.onStatus(locale === "ko"
          ? `command 도 url 도 없어 해석하지 못한 MCP 항목을 제외했습니다: ${mcp.malformed.join(", ")}`
          : `Skipped MCP entries with neither command nor url: ${mcp.malformed.join(", ")}`);
      }

      /*
       * ★세션 — 예전에는 sessionId 를 받아만 두고 다음 턴에 쓰지 않아, 매 턴이 차가운
       * 새 세션이었다(히스토리도 안 실었으니 사실상 기억 없는 런타임이었다).
       * loadSession 을 광고하는 에이전트만 session/load 로 이어가고, 아니면 새 세션에
       * 대화 기록을 다시 실어 보낸다 — 없는 기능을 있는 척하지 않는다.
       */
      const canLoadSession = agentCaps.loadSession === true;
      let sessionId = "";
      let resumed = false;
      let created: any = null;
      if (resumeSessionId && canLoadSession) {
        client.beginReplay();
        try {
          await session.conn.request(
            "session/load",
            { sessionId: resumeSessionId, cwd, mcpServers: mcp.servers },
            { timeoutMs: 120_000, signal: req.signal },
          );
          sessionId = resumeSessionId;
          resumed = true;
          events.onStatus(`[runtime-session] resumed kind=${sessionKind}`);
        } catch (err) {
          if (req.signal?.aborted) throw abortReasonError(req);
          events.onStatus(`[runtime-session] resume_failed kind=${sessionKind}`);
          if (req.unattended) {
            throw new Error(`Automation runtime session resume failed for ${sessionKind}; refusing to create a fresh ACP session.`);
          }
        } finally {
          client.endReplay();
        }
      } else if (resumeSessionId) {
        events.onStatus(locale === "ko"
          ? "이 런타임은 세션 복원을 지원하지 않아 대화 기록을 다시 실어 새 세션으로 진행합니다"
          : "This runtime does not advertise session resume — starting a fresh session with the conversation re-attached");
      }
      if (!sessionId) {
        created = await session.conn.request("session/new", { cwd, mcpServers: mcp.servers }, { timeoutMs: 60_000, signal: req.signal });
        sessionId = String(created?.sessionId ?? "");
        if (!sessionId) throw new Error("ACP session/new returned no sessionId");
        events.onStatus(`[runtime-session] created kind=${sessionKind}`);
      }
      if (req.model) {
        // Best effort: not every agent implements session/set_model.
        try { await session.conn.request("session/set_model", { sessionId, modelId: req.model }, { timeoutMs: 10_000 }); } catch { /* optional */ }
      }
      /*
       * ★모드 — plan 모드는 ACP 로는 고를 방법이 아예 없었다(session/set_mode 미호출).
       * 모드는 세션을 만들 때 광고되므로 새 세션에서만 고른다. resume 턴에서는 세션이
       * 이미 그 모드를 갖고 있고, 권한이 바뀌면 지문이 달라져 새 세션이 열린다.
       */
      const modeId = created ? chooseAcpModeId(req.permission, modeOptionsFromNewSession(created)) : undefined;
      if (modeId) {
        try {
          await session.conn.request("session/set_mode", { sessionId, modeId }, { timeoutMs: 10_000 });
          events.onStatus(locale === "ko" ? `세션 모드: ${modeId}` : `Session mode: ${modeId}`);
        } catch { /* optional — the permission arbiter is still the live gate */ }
      }

      /*
       * ★이미지 — RunnerRequest.images 는 통째로 버려지고 있었다. promptCapabilities.image
       * 를 광고하는 에이전트에는 ACP 이미지 블록을 그대로 싣고, 아니면 기존 산문 폴백
       * (파일로 저장하고 경로를 알려주는 길)을 쓴다.
       */
      const images = req.images ?? [];
      const imageBlocks: Array<Record<string, unknown>> = [];
      let userPrompt = req.userPrompt;
      if (images.length > 0) {
        if (agentCaps.promptCapabilities?.image === true) {
          for (const image of images) imageBlocks.push({ type: "image", mimeType: image.mediaType, data: image.data });
          events.onStatus(locale === "ko"
            ? `첨부 이미지 ${images.length}개를 그대로 전송합니다`
            : `Sending ${images.length} attached image(s) inline`);
        } else {
          const staged = await stageCliImageAttachments({
            userPrompt: req.userPrompt,
            images,
            cwd,
            locale,
            chatId: req.chatId,
            runtimeSessionId: resumeSessionId ?? undefined,
          });
          userPrompt = staged.userPrompt;
          events.onStatus(tStatus(locale, "cliImageReady", {
            backend: req.backendLabel || spec.label,
            count: staged.images.length,
          }));
        }
      }

      const promptText = resumed
        ? composeResumeTurnPrompt(userPrompt, req.turnContext, locale)
        : [
          wrapSystemPrompt(req.systemPrompt, locale, req.permission, userPrompt),
          req.history.length > 0 ? renderConversationContext(req.history, locale, CLI_HISTORY_CONTEXT_TOKENS).block : "",
          req.turnContext,
          userPrompt,
        ].filter(Boolean).join("\n\n");
      const result = await session.conn.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: promptText }, ...imageBlocks] },
        { signal: req.signal },
      );
      client.finish();
      // 세션은 이제 실재한다 — 거절/빈 답이어도 다음 턴이 이어갈 수 있게 먼저 저장한다.
      if (req.chatId && fingerprint && !saveRuntimeSession(req.chatId, sessionKind, sessionId, fingerprint)) {
        events.onStatus(`[runtime-session] store_failed kind=${sessionKind}`);
      }
      if (req.signal?.aborted) throw abortReasonError(req);
      const stopReason = String(result?.stopReason ?? "");
      const text = client.text.trim();
      if (stopReason === "refusal") {
        return { text, failure: { kind: "refused", message: "ACP stopReason=refusal", runtime: spec.id, source: "marker" }, sessionId };
      }
      if (stopReason === "cancelled") throw abortReasonError(req);
      if (!text) {
        return { text: "", failure: { kind: "empty", message: session.conn.lastStderr.slice(-500) || `ACP stopReason=${stopReason || "unknown"}`, runtime: spec.id, source: "marker" }, sessionId };
      }
      if (client.contextUsed !== undefined && client.contextSize) {
        const pct = Math.round((client.contextUsed / client.contextSize) * 100);
        events.onStatus(locale === "ko" ? `컨텍스트 ${pct}% 사용` : `Context ${pct}% used`);
      }
      // observedUsage intentionally absent: ACP v1 gives context occupancy, not tokens.
      return { text, sessionId };
    } catch (err) {
      if (req.signal?.aborted) throw abortReasonError(req);
      /*
       * ★사유는 `message` 가 아니라 `data` 에 온다.
       *
       * JSON-RPC 는 규격 코드에 규격 문구를 쓰라고 하므로, 에이전트는 -32603 에
       * message="Internal error" 를 싣고 사람이 읽을 사유는 `data` 로 보낸다. 실측:
       * goose 는 provider 미설정일 때 정확히 그렇게 답한다
       * ("Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER").
       * `message` 만 읽으면 화면에 남는 말은 "Internal error" 한 마디뿐이고, 사용자는
       * 자기가 무엇을 해야 하는지 알 방법이 없다.
       */
      const raw = err instanceof Error ? err.message : String(err);
      const data = err instanceof AcpRpcError ? err.data : undefined;
      const detail = data == null ? "" : (typeof data === "string" ? data : JSON.stringify(data));
      const message = detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw;

      /*
       * 인증은 문장이 아니라 구조로 판정한다. 에이전트가 initialize 에서 광고한
       * `authMethods` 가 곧 "무엇을 해야 하는가"이고, 대개 명령까지 적어 준다
       * (goose: `goose configure`, opencode: `opencode auth login`). 단어 매칭은
       * 문구나 로케일이 바뀌는 순간 눈이 먼다 — 위 goose 사례가 이미 그랬다.
       */
      const advertised: any[] = Array.isArray(session?.init?.authMethods) ? session.init.authMethods : [];
      const prescription = advertised
        .map((m) => String(m?.description || m?.name || m?.id || "").trim())
        .filter(Boolean)
        .join(" / ");

      if (err instanceof AcpRpcError || /auth_required|not authenticated|login/i.test(message)) {
        /*
         * ★한도 소진은 인증 문제가 아니다.
         *
         * 로그인은 멀쩡한데 "로그인하라"고 말하면 틀린 처방이고, 사용자는 될 리 없는
         * 일을 하게 된다. 실측: grok 은 429 와 "free-usage-exhausted", 리셋 창까지
         * 그대로 실어 보낸다 — 그 원문이 이미 사용자가 알아야 할 전부다. 그래서 이
         * 경우에는 authMethods 안내를 **붙이지 않는다**.
         */
        const quota = /\b429\b|rate.?limit|too many requests|usage.?exhausted|quota/i.test(message);
        const authish = /auth_required|not authenticated|login/i.test(message);
        const help = prescription && !quota
          ? (locale === "ko"
            ? ` — 이 런타임은 먼저 로그인이나 설정이 필요하다: ${prescription}`
            : ` — this runtime needs sign-in or setup first: ${prescription}`)
          : "";
        // 인증 수단을 광고한 채 실패했으면 auth. 원인을 모르면 단정하지 않되 사유는
        // 그대로 들고 나간다 — 지어낸 이름보다 원문이 낫다.
        const kind = quota ? "quota" as const
          : (prescription || authish) ? "auth" as const
            : "exit" as const;
        return { text: "", failure: { kind, message: message + help, runtime: spec.id, source: "marker" } };
      }
      throw err;
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      if (session) {
        try { session.conn.close(); } catch { /* ignore */ }
        try { killCliTree(session.child); } catch { /* ignore */ }
      }
    }
  };
}

/**
 * Prefer the ACP runner for a kind; fall back to the legacy driver when ACP is
 * disabled by env. The decision is per call so a setting change needs no restart.
 */
export function acpOrLegacyRunner(kind: string, legacy: Runner): Runner {
  const spec = ACP_AGENTS[kind];
  if (!spec) return legacy;
  const acp = createAcpRunner(spec);
  return (req, events) => (acpDisabledFor(kind) ? legacy(req, events) : acp(req, events));
}
