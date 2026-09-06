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
  legacyModelSelectionFromSession,
  modelConfigOptionFromSession,
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
import {
  getRuntimeToolPermissionArbiter,
  setRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
  type RuntimeToolPermissionArbiter,
  type RuntimeToolPermissionDecision,
} from "./tool-approval";
import { AcpSessionPool, type AcpSessionLease } from "./acp-session-pool";
import { resolveAgentResidencySource, isResidencyExemptAgent } from "./agent-residency";
import { classifyDiscovery, type DiscoveryOutcome } from "../../shared/model-discovery";
import { schemaFallbackInstruction } from "../../shared/runtime-capabilities";

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
  // gemini는 레지스트리에 `gemini --acp`로 선언돼 있지만 **아직 내장하지 않는다 —
  // 보류이지 기각이 아니고, 판단은 오너 몫이다.** 위 기준("구독 인증 자산이 있는가")에
  // 해당하는지가 열린 질문이기 때문이다:
  //   · 개인 Code Assist 티어가 2026-06-18 중단됐다고 알려져 있다(엔터프라이즈 전용).
  //     그렇다면 이 CLI가 우리에게 주는 것은 구독 자산이 아니라 사용자의 API 키이고,
  //     그건 OpenCode·Goose를 뺀 것과 정확히 같은 사유가 된다.
  //   · 실측 2026-08-18 (gemini-cli 0.55.1): initialize는 loadSession/image/http+sse를
  //     전부 광고하는데, 개인 Google 계정의 session/new는 "Gemini Code Assist for
  //     individuals는 더 이상 지원하지 않는다 — Antigravity로 옮겨라"로 거절한다.
  //     즉 이 기기에서는 프로토콜은 멀쩡하고 계정 자격만 없다.
  //   · Google 구독 경로는 이미 antigravity 런타임이 덮고 있다.
  // 열기로 결정한다면 세 곳을 함께 고쳐야 한다(runtime-surface-parity 계약):
  // ACP_KIND_BUILTINS · SUBSCRIPTION_RUNTIMES · 설정 CLI_DEFS/대시보드 ENGINES 표.
  // 그 전에 한쪽만 고치면 아무 데서도 연결할 수 없거나, 대다수에게 실패하는 연결
  // 버튼이 화면에 새로 생긴다.
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
 * Live approval hook (tool-approval contract, v1.0.16). ACP asks BEFORE
 * executing, so a real user decision can be attached here.
 *
 * ★The arbiter registry moved to electron/runtime/tool-approval.ts, because ACP
 * is no longer the only pre-execution ask: our own in-process tool loop
 * (local-tool-loop.ts) now goes through the same one. Two registries would mean
 * two policies, and the second one always drifts toward "run it without
 * asking" — which is exactly what the local loop had been doing. tool-approval
 * imports nothing but shared/types, so this file still runs without Electron.
 *
 * Without an arbiter the conservative default applies (never a silent allow of
 * a mutating tool on a read run).
 */
export type AcpPermissionAsk = RuntimeToolPermissionAsk;
export type AcpPermissionDecision = RuntimeToolPermissionDecision;
export type AcpPermissionArbiter = RuntimeToolPermissionArbiter;
export function setAcpPermissionArbiter(arbiter: AcpPermissionArbiter | null): void {
  setRuntimeToolPermissionArbiter(arbiter);
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
    private readonly approval: { runtime: string; sessionKey: string; cwd?: string; chatId?: string; agentId?: string; unattended?: boolean } = { runtime: "acp", sessionKey: "acp" },
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

    const permissionArbiter = getRuntimeToolPermissionArbiter();
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
          agentId: this.approval.agentId,
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

/**
 * 이번 턴의 수신자. ★세션이 여러 턴을 살아남게 되면서(acp-session-pool) 핸들러를
 * 생성 시점에 고정할 수 없게 됐다 — 턴마다 다른 client/events 가 받아야 하므로
 * 연결은 **지금 활성인 sink** 를 따라간다. active 가 없는 동안(유휴 세션) 들어오는
 * 알림은 버려진다(그 시점엔 볼 사람이 없다).
 */
export interface AcpTurnSink {
  onNotification?: (method: string, params: any) => void;
  onRequest?: (method: string, params: any) => any;
  onStatus?: (status: string) => void;
}

interface AcpSessionState {
  active: AcpTurnSink | null;
  /** 전송이 닫혔는가 — 죽은 세션을 재사용 후보로 세지 않기 위한 표식. */
  closed: boolean;
}

interface Session {
  child: ChildProcess;
  conn: AcpConnection;
  init: any;
  state: AcpSessionState;
  /** 이 세션이 들고 있는 ACP sessionId — 다음 턴이 그대로 이어 쓴다. */
  acpSessionId?: string;
  /** 생존 신호 정지 — 세션을 놓을 때 부른다. */
  stopHeartbeat: () => void;
}

async function openAcp(
  spec: AcpAgentSpec,
  opts: {
    command?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    label?: string;
    /**
     * grok 전용 도구 관문 — `grok agent --plugin-dir <DIR>`.
     *
     * ★실측 2026-08-19(grok 1.0.5): 이 플래그는 `grok agent` 하위 명령에만 있고
     * ("Highest-priority plugin scope; always trusted — hooks and MCP servers
     * activate without a prompt"), 최상위 `grok` 에 붙이면 실행이 아예 안 뜬다.
     * 그리고 grok 은 ACP_PREFERRED_KINDS 라 실제 실행이 바로 이 `agent stdio`
     * 경로다 — 레거시 헤드리스 러너가 아니라 여기가 관문을 걸 자리다.
     */
    toolBrokerPluginDir?: string;
  },
): Promise<Session> {
  const spawnArgs =
    opts.toolBrokerPluginDir && spec.args[0] === "agent"
      ? // `agent` 바로 뒤에 넣는다 — 하위 명령의 플래그이므로 자리를 지켜야 한다.
        ["agent", "--plugin-dir", opts.toolBrokerPluginDir, ...spec.args.slice(1)]
      : spec.args;
  const state: AcpSessionState = { active: null, closed: false };
  const child = spawnCli(opts.command ?? spec.command, spawnArgs, {
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
  // 생존 신호는 **지금 활성인 턴**으로 간다 — 세션이 여러 턴을 살기 때문이다.
  const heartbeatStatus = (status: string): void => { state.active?.onStatus?.(status); };
  const stopAcpHeartbeat = startCliHeartbeat(child, heartbeatStatus, opts.label ?? spec.id);
  ensureChildCloseAfterExit(child, () => {
    state.active?.onStatus?.(`${opts.label ?? spec.id}: agent exited without closing its output — settling the session`);
  });
  child.on("close", () => { state.closed = true; stopAcpHeartbeat(); });
  child.on("error", () => { state.closed = true; stopAcpHeartbeat(); });
  const conn = new AcpConnection(child, {
    onNotification: (method, params) => state.active?.onNotification?.(method, params),
    onRequest: (method, params) => {
      const handler = state.active?.onRequest;
      // 유휴 세션에 요청이 오면 답할 사람이 없다 — 조용히 삼키지 않고 규격 오류로 답한다.
      if (!handler) throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
      return handler(method, params);
    },
    onClose: () => { state.closed = true; },
  });
  const init = await conn.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "agentlas-desktop", version: "1.0" },
  }, { timeoutMs: opts.timeoutMs });
  if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    stopAcpHeartbeat();
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
  return { child, conn, init, state, stopHeartbeat: stopAcpHeartbeat };
}

/**
 * 이 세션은 아직 쓸 수 있는가. 프로세스가 죽었거나 전송이 닫혔으면 재사용 후보에서
 * 빠진다 — 죽은 세션을 물려주면 사용자에게 원인 없는 실패가 된다.
 */
function acpSessionAlive(session: Session): boolean {
  return !session.state.closed
    && !session.child.killed
    && session.child.exitCode === null
    && session.child.signalCode === null;
}

/** 세션을 놓는 유일한 경로 — 프로토콜 close + 프로세스 트리 종료 + 생존 신호 정지. */
function closeAcpSession(session: Session): void {
  session.state.active = null;
  session.state.closed = true;
  try { session.stopHeartbeat(); } catch { /* ignore */ }
  try { session.conn.close(); } catch { /* ignore */ }
  try { killCliTree(session.child); } catch { /* ignore */ }
}

/*
 * ★상주 세션 풀 — 이 파일의 핵심 변경.
 *
 * 예전에는 매 실행의 finally 가 conn.close() + killCliTree() 를 불렀다. ACP 는 여러 턴을
 * 살 수 있는 프로토콜인데, 우리가 매번 끊고 있었다는 뜻이다. 이제 실행이 끝나면 세션을
 * **풀에 반납**하고, 다음 턴이 같은 키(chatId × 런타임 × 지문 × cwd × MCP × 실행파일)면
 * 그대로 이어 쓴다. 수명·예산·리퍼는 acp-session-pool.ts + agent-residency.ts 가 맡는다.
 */
let sessionPool: AcpSessionPool<Session> | null = null;
export function acpSessionPool(): AcpSessionPool<Session> {
  if (!sessionPool) {
    sessionPool = new AcpSessionPool<Session>({
      alive: acpSessionAlive,
      close: closeAcpSession,
      /*
       * ★유휴 상주가 호스트의 종료를 막으면 안 된다. 자식의 stdio 파이프는 부모의
       * 이벤트 루프를 붙잡으므로, 붙들기만 하고 unref 하지 않으면 일을 끝낸 터미널·
       * 스크립트가 영영 안 끝난다(실측: 기존 ACP 게이트가 정확히 그렇게 멈췄다).
       * 창을 가진 앱/데몬은 어차피 계속 사는 프로세스라 차이가 없다.
       */
      // 파이프는 런타임에 Socket 이라 ref/unref 를 갖지만 타입(Readable/Writable)에는 없다.
      unref: (session) => {
        session.child.unref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { unref?: () => void } | null)?.unref?.();
        }
      },
      ref: (session) => {
        session.child.ref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { ref?: () => void } | null)?.ref?.();
        }
      },
    });
    /*
     * ★그리고 그 호스트가 나갈 때는 붙든 자식을 데려간다. unref 만 하고 여기를 비우면
     * 종료가 곧 고아 생성이 된다(스폰 원장 스위퍼가 최대 10분 뒤 치우는 좀비).
     * 'exit' 훅은 동기 구간이라 SIGTERM 만 보낸다 — 그거면 ACP 에이전트는 내려간다.
     */
    process.once("exit", () => {
      try { sessionPool?.disposeAll(); } catch { /* 종료 중이다 */ }
    });
  }
  return sessionPool;
}

/** 테스트/런타임 교체용 — 붙든 세션을 전부 놓는다. */
export function disposeAcpSessionPool(): void {
  sessionPool?.disposeAll();
  sessionPool = null;
}

/**
 * 재사용 키. 세션 지문(모델·시스템프롬프트·권한)은 기존 계약 그대로 쓰고, 그 위에
 * **프로세스 정체성**(cwd·MCP 설정·실행 파일·도구 관문)을 더한다 — 지문이 같아도 이
 * 넷 중 하나가 다르면 그 세션은 다른 프로세스여야 하기 때문이다(MCP 서버는 session/new
 * 때 붙으므로 나중에 바꿀 수 없다).
 */
export function acpPoolKey(input: {
  specId: string;
  chatId: string;
  fingerprint: string;
  cwd: string;
  mcpConfigPath?: string;
  runtimeSource?: string;
  toolBrokerPluginDir?: string;
  /**
   * 실행 환경변수. ★프로세스는 자기가 뜰 때의 env 를 평생 들고 산다 — 자격증명이 갱신돼도
   * 이미 떠 있는 에이전트는 옛 값을 쓴다. 그래서 env 가 바뀌면 이어 쓰지 않는다(다이제스트만
   * 쓰므로 값 자체는 어디에도 남지 않는다). env 에 매 실행 달라지는 값이 들어 있으면 재사용이
   * 안 될 뿐, 예전과 똑같이 동작한다 — 안전한 쪽으로 실패한다.
   */
  env?: NodeJS.ProcessEnv;
}): string {
  const envDigest = createHash("sha256");
  for (const name of Object.keys(input.env ?? {}).sort()) {
    envDigest.update(name).update("\0").update(String((input.env ?? {})[name] ?? "")).update("\0");
  }
  return createHash("sha256")
    .update("acp-pool-v1\0")
    .update(input.specId).update("\0")
    .update(input.chatId).update("\0")
    .update(input.fingerprint).update("\0")
    .update(input.cwd).update("\0")
    .update(input.mcpConfigPath ?? "").update("\0")
    .update(input.runtimeSource ?? "").update("\0")
    .update(input.toolBrokerPluginDir ?? "").update("\0")
    .update(envDigest.digest("hex"))
    .digest("hex");
}

/**
 * 재사용하려던 세션이 못 쓰게 됐다는 표식. 밖에서 조용히 새 세션으로 한 번 더 시도한다
 * (사용자에게는 아무 차이가 없어야 한다 — 새 문구도, 실패도 없다).
 */
class StaleAcpSessionError extends Error {
  constructor(readonly cause: unknown) {
    super("ACP pooled session was stale — retrying with a fresh session");
    this.name = "StaleAcpSessionError";
  }
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
    session = await openAcp(spec, { command: opts?.command, cwd: opts?.cwd ?? agentRunCwd(), env: opts?.env ?? process.env, timeoutMs });
    const created = await session.conn.request("session/new", { cwd: opts?.cwd ?? agentRunCwd(), mcpServers: [] }, { timeoutMs });
    const rows = modelOptionsFromNewSession(created);
    const outcome = classifyDiscovery({ stdout: rows.length ? rows.map((r) => r.id).join("\n") : "", models: rows.map((r) => r.id), source: "acp" });
    // A successful ACP session with no model config option is a valid fixed-model
    // provider, not a failed connection. Treating this as failed made every
    // startup emit a scary discovery error for GitHub Copilot CLI even though
    // the transport and session/new handshake had completed normally.
    if (rows.length === 0) {
      return {
        ...outcome,
        status: "unsupported",
        reason: "acp:no-model-config-option",
      };
    }
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
    // 탐지용 세션은 풀에 넣지 않는다 — 대화가 아니라 한 번의 질문이다.
    if (session) closeAcpSession(session);
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

/**
 * Cursor's source-owned `auto` row delegates model choice to Cursor itself.
 * It is not a generic alias: every other requested model needs the session's
 * advertised selection contract before any prompt can be sent.
 */
function isCursorAutomaticModel(spec: AcpAgentSpec, model: string): boolean {
  return spec.id === "cursor" && model === "auto";
}

/**
 * Select an explicitly requested model before prompting. ACP v1 configOptions
 * is the authoritative path; session/set_model remains only for the older
 * vendor `models.availableModels` envelope. A rejection or incomplete config
 * acknowledgement throws so the caller discards this session instead of
 * silently continuing on the provider default.
 */
export async function configureAcpSessionModel(
  spec: AcpAgentSpec,
  conn: Pick<AcpConnection, "request">,
  sessionId: string,
  response: unknown,
  requestedModel: string | undefined,
): Promise<void> {
  const model = typeof requestedModel === "string" && requestedModel.trim() ? requestedModel : undefined;
  if (!model) return;

  const config = modelConfigOptionFromSession(response);
  if (config) {
    if (!config.values.includes(model)) {
      throw new Error(`ACP model ${model} is not advertised by ${spec.id}`);
    }
    if (config.currentValue === model) return;
    const acknowledged = await conn.request(
      "session/set_config_option",
      { sessionId, configId: config.configId, value: model },
      { timeoutMs: 10_000 },
    );
    const confirmed = modelConfigOptionFromSession(acknowledged, config.configId);
    if (!confirmed || confirmed.currentValue !== model) {
      throw new Error(`ACP model selection for ${model} was not acknowledged by ${spec.id}`);
    }
    return;
  }

  const legacy = legacyModelSelectionFromSession(response);
  if (legacy) {
    if (!legacy.modelIds.includes(model)) {
      throw new Error(`ACP model ${model} is not advertised by ${spec.id}`);
    }
    if (legacy.currentModelId === model) return;
    await conn.request(
      "session/set_model",
      { sessionId, modelId: model },
      { timeoutMs: 10_000 },
    );
    return;
  }

  // Cursor's source-owned `auto` row delegates only when no ACP selection
  // contract was advertised. If an agent did advertise one, apply it above so
  // `auto` cannot silently leave an advertised current model unchanged.
  if (isCursorAutomaticModel(spec, model)) return;

  throw new Error(`ACP runtime ${spec.id} did not advertise a model selection contract for ${model}`);
}

/** Runner factory — one Runner per ACP agent spec. */
export function createAcpRunner(spec: AcpAgentSpec): Runner {
  /**
   * 한 턴. `allowStaleRetry` 가 true 인 첫 시도에서만, 재사용 세션이 아무 출력도 내지
   * 못하고 실패했을 때 StaleAcpSessionError 를 던진다 — 바깥이 새 세션으로 한 번 더
   * 시도한다(사용자에게는 차이가 없다). 두 번째 시도는 이 표식을 던지지 않으므로
   * 무한 재시도가 원천적으로 불가능하다.
   */
  const runTurn = async (req: RunnerRequest, events: RunnerEvents, allowStaleRetry: boolean): Promise<RunnerResult> => {
    const locale = pickLocale(req);
    events.onStatus(tStatus(locale, "callingBackend", { backend: req.backendLabel || spec.label }));
    const cwd = req.cwd ?? agentRunCwd();
    const client = new AcpSessionClient(events, req.permission, locale, {
      runtime: spec.id,
      sessionKey: `${spec.id}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`,
      cwd,
      chatId: req.approvalChatId ?? req.chatId,
      agentId: req.agentId,
      unattended: req.unattended === true,
    });
    const sessionKind = acpSessionKind(spec.id);
    const runtimeSessionOwnerId = req.runtimeSessionOwnerId ?? req.agentId;
    const isolateRuntimeSessionOwner = req.runtimeSessionOwnerId != null;
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
    const savedSession = req.chatId
      ? getRuntimeSession(req.chatId, sessionKind, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
      : null;
    const storedSessionId = savedSession && fingerprint && savedSession.fingerprint === fingerprint ? savedSession.sessionId : null;
    const resumeSessionId = req.runtimeSessionId ?? storedSessionId;

    /*
     * ★상주 — 이 턴이 끝나도 세션을 닫지 않는다.
     *
     * 키가 있는(=대화에 속한) 실행은 풀에서 빌린다. 같은 키의 다음 턴은 이미 떠 있는
     * 프로세스와 이미 열린 ACP 세션을 그대로 이어 쓴다. 키가 없으면(chatId 없는 일회성
     * 실행) 예전 그대로 열고 닫는다 — 이어 쓸 다음 턴이 정의상 없기 때문이다.
     */
    const pool = acpSessionPool();
    const poolKey = req.chatId && fingerprint
      ? acpPoolKey({
        specId: spec.id,
        chatId: req.chatId,
        fingerprint,
        cwd,
        ...(req.mcpConfigPath ? { mcpConfigPath: req.mcpConfigPath } : {}),
        ...(req.runtimeSource ? { runtimeSource: req.runtimeSource } : {}),
        ...(req.toolBrokerPluginDir ? { toolBrokerPluginDir: req.toolBrokerPluginDir } : {}),
        env: req.env ?? process.env,
      })
      : null;
    const turnSink: AcpTurnSink = {
      onNotification: (method, params) => { if (method === "session/update") client.onUpdate(params); },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return client.answerPermission(params);
        throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
      },
      onStatus: (s) => events.onStatus(s),
    };
    const openSession = () => openAcp(spec, {
      command: req.runtimeSource,
      cwd,
      env: req.env ?? process.env,
      timeoutMs: 60_000,
      label: req.backendLabel || spec.label,
      // 도구 관문 — grok 의 `agent` 하위 명령만 이 플래그를 받는다(openAcp 주석 참조).
      ...(req.toolBrokerPluginDir ? { toolBrokerPluginDir: req.toolBrokerPluginDir } : {}),
    });

    let session: Session | null = null;
    let lease: AcpSessionLease<Session> | null = null;
    /** 이 세션을 풀에 되돌리면 안 되는가(취소·오류·프로토콜 파손). */
    let broken = false;
    const onAbort = () => { broken = true; if (session) killCliTree(session.child); };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (poolKey) {
        lease = await pool.acquire(poolKey, {
          agentId: req.agentId ?? null,
          nodeId: req.orchestrationAgentId ?? req.agentId ?? null,
          chatId: req.chatId ?? null,
          runtimeKind: spec.id,
          source: resolveAgentResidencySource(req.agentId),
          reaperExempt: isResidencyExemptAgent(req.agentId),
        }, openSession);
        session = lease.session;
      } else {
        session = await openSession();
      }
      // 이번 턴의 수신자를 꽂는다 — 세션은 여러 턴을 살고, 받는 사람은 턴마다 다르다.
      session.state.active = turnSink;
      /** 살아 있는 세션을 이어 쓰는 턴인가(= 기존 resume 경로와 같은 의미). */
      const reusing = Boolean(lease && !lease.fresh && session.acpSessionId);
      /*
       * ★MCP — 예전에는 이 자리가 항상 `mcpServers: []` 였다.
       * 그래서 사용자가 승인한 MCP 서버는 ACP 경로(=cursor·grok·kimi 의 실제 실행 경로)로
       * 단 하나도 전달되지 않았고, "도구가 붙었다"고 알고 시작한 실행이 도구 0개로 돌았다.
       * 전송이 안 되는 서버는 조용히 버리지 않고 상태줄로 말한다.
       */
      const agentCaps = session.init?.agentCapabilities ?? {};
      // 이어 쓰는 턴에는 MCP 를 다시 붙이지 않는다 — 서버는 session/new 때 붙고, 설정이
      // 바뀌면 풀 키가 달라져 애초에 이 세션을 재사용하지 않는다.
      const mcp: AcpMcpTranslation = reusing
        ? { servers: [], unsupported: [], malformed: [] }
        : acpMcpServersFromConfig(
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
      let loaded: any = null;
      if (reusing) {
        /*
         * ★상주 세션을 이어 쓴다 — session/load 조차 필요 없다(그 세션이 이 프로세스
         * 메모리에 그대로 살아 있다). 상태줄 문구는 **기존 resume 경로와 같은 것**을
         * 쓴다: 사용자가 보는 화면에 새 단어를 만들지 않는 것이 이 기능의 계약이다.
         */
        sessionId = session.acpSessionId!;
        resumed = true;
        events.onStatus(`[runtime-session] resumed kind=${sessionKind}`);
      }
      if (!sessionId && resumeSessionId && canLoadSession) {
        client.beginReplay();
        try {
          loaded = await session.conn.request(
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
      } else if (!sessionId && resumeSessionId) {
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
      // 새 세션과 session/load 응답은 둘 다 현재 모델 계약을 광고할 수 있다. 응답을
      // 버리면 load 뒤에는 선택 실패를 감지할 방법이 없어 provider 기본 모델로 흘렀다.
      // 풀에서 이미 살아 있는 세션은 지문에 모델이 들어 있어 다시 선택하지 않는다.
      if (!reusing && req.model) {
        await configureAcpSessionModel(spec, session.conn, sessionId, created ?? loaded, req.model);
      }
      // 모델 선택을 확인한 세션만 다음 턴에 재사용할 수 있게 붙인다.
      session.acpSessionId = sessionId;
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

      /*
       * ★출력 형태 계약의 정직한 강등 — ACP 에는 구조화 출력 칸이 없다.
       *
       * claude·codex·grok·agy 는 스키마를 CLI 플래그로 강제하고 로컬 런타임은 제약
       * 디코딩을 걸지만, ACP 프로토콜에는 그 자리가 없고 어댑터가 대신 채워 줄 수도
       * 없다. 그래서 지시문으로 부탁하되 **조용히 넘어가지 않는다** — 소비자가 계약이
       * 강제된 줄 알고 파싱하다 빈손이 되는 것이 형식이 가끔 깨지는 것보다 나쁘다.
       */
      const schemaFallback = req.outputSchema ? schemaFallbackInstruction(req.outputSchema.schema) : "";
      if (schemaFallback) {
        events.onStatus(
          locale === "ko"
            ? "이 런타임은 출력 형식을 강제할 수 없어 지시문으로만 요청합니다."
            : "This runtime cannot enforce the output schema — asking for it in the prompt instead.",
        );
      }
      const promptText = resumed
        ? `${composeResumeTurnPrompt(userPrompt, req.turnContext, locale)}${schemaFallback}`
        : [
          wrapSystemPrompt(req.systemPrompt, locale, req.permission, userPrompt),
          req.history.length > 0 ? renderConversationContext(req.history, locale, CLI_HISTORY_CONTEXT_TOKENS).block : "",
          req.turnContext,
          userPrompt,
          schemaFallback,
        ].filter(Boolean).join("\n\n");
      const result = await session.conn.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: promptText }, ...imageBlocks] },
        { signal: req.signal },
      );
      client.finish();
      // 세션은 이제 실재한다 — 거절/빈 답이어도 다음 턴이 이어갈 수 있게 먼저 저장한다.
      if (req.chatId && fingerprint && !saveRuntimeSession(req.chatId, sessionKind, sessionId, fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
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
      // 실패한 세션은 풀에 되돌리지 않는다 — 상태를 모르는 세션을 물려주면 다음 턴이
      // 원인 없는 실패를 겪는다. 다시 여는 비용이 그보다 싸다.
      broken = true;
      if (req.signal?.aborted) throw abortReasonError(req);
      /*
       * ★재사용 세션이 아무 말도 못 하고 실패했으면, 그건 사용자의 문제가 아니라
       * 우리가 물려준 세션의 문제다(에이전트가 죽었거나 프로토콜이 깨졌다). 조용히
       * 버리고 새 세션으로 한 번 더 — 화면에는 아무 차이도 남기지 않는다.
       */
      if (allowStaleRetry && lease && !lease.fresh && client.text === "") {
        throw new StaleAcpSessionError(err);
      }
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
      // 수신자를 먼저 뗀다 — 유휴 세션이 지난 턴의 events 로 상태를 흘리면 안 된다.
      if (session) session.state.active = null;
      if (lease) {
        // 취소·오류면 버리고, 아니면 반납한다(다음 턴이 이어 쓴다).
        if (broken || req.signal?.aborted) pool.discard(lease);
        else pool.release(lease);
      } else if (session) {
        // 풀에 들어가지 않는 일회성 실행 — 예전 그대로 닫는다.
        closeAcpSession(session);
      }
    }
  };

  return async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
    try {
      return await runTurn(req, events, true);
    } catch (err) {
      // 죽은 상주 세션은 사용자에게 보이지 않는다 — 새 세션으로 조용히 다시 한 번.
      if (err instanceof StaleAcpSessionError) return runTurn(req, events, false);
      throw err;
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
