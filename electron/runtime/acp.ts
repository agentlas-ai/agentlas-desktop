import { selectionFor } from "../capabilities/one-capabilities";
import { withForeignCliContext } from "./foreign-cli-context";
import { adoptCopilotSession, copilotSessionGone, realCliHome } from "./cli-product-homes";
import { attendedTurnStartsFresh, freshSessionReplacesStored, unattendedFreshSessionStatus, type UnattendedFreshSessionReason } from "./unattended-session-turns";
import { attestKimiTurn, kimiJournalCursor, kimiSessionGone, type KimiJournalCursor } from "./kimi-journal";
import { acpSpawnEnvWithoutMcpSecrets, resolveAcpMcpConfig, ACP_MCP_SECRET_ALIAS_RE } from "./acp-mcp-binding";
import { reportModelEffort, type ModelEffortApplication } from "./model-call-ledger";
import { appendTurnAsks } from "../turn-tools/ask";
import { parseAskFenceBody, type AgentlasAskQuestion } from "../../shared/ask-fence-flatten";
import { registerNativeApprovalChildSignal } from "./native-approval-provenance";
import { claimAttemptChild, releaseAttemptChild } from "./attempt-children";
import { beginAdapterEffectRun, type AdapterEffectReport } from "../invocation/adapter-effect-context";
import { assertScienceRecoveryAcpRequest } from "../science-host/recovery-authority";
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
import { preparedMcpBindings, preparedMcpTransport } from "../mcp-tools/prepared-transport";
import { createHash, randomUUID } from "node:crypto";
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
import { ensureChildCloseAfterExit, startCliHeartbeat, startCliSilenceGuard, runtimeSilentTimeoutFailure, cliToolSilenceWindowMs, type CliSilenceGuard, wrapSystemPrompt, RuntimeTurnUnsettledError, runnerFailureFromError, markRefusedBeforeDispatch, preDispatchRefusal, runnerRefusedBeforeDispatch } from "./runner";
import { agentRunCwd, detachedSpawnOpts, killCliTree, spawnCli, trackRunChild, waitForCliTreeTermination } from "./exec";
import { pickLocale, tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { cliHistoryContextTokens, composeResumeTurnPrompt, renderConversationContext,
  renderGapContext, unseenHistoryGap, dedupeStableTurnContext, acknowledgeStableTurnContext,
  invalidateStableTurnContext, type StableTurnContextDelivery } from "./continuity";
import { stageCliImageAttachments } from "./image-attachments";
import { createRuntimePlanEmitter, CursorTodoPlanTracker, planFromAcpPlanUpdate } from "./runtime-plan";
import type { RuntimeToolKind } from "../../shared/runtime-tool-kind";
import { normalEndToolEvidence, settleNormalEnd } from "../../shared/turn-settlement";
import type { InvocationPlan } from "../../shared/invocation-plan";
import { agentContextColdBootstrapForRequest, agentContextDeliveryForRequest, agentContextSessionKey } from "./agent-context";
import { clearRuntimeSession, getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
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
import { composeDeclaredPrompt } from "./prompt-order";
import { observeCliExecutableIdentity } from "./cli-executable-identity";
import { waitForRetiredCliExit } from "./retired-cli-exit";

/** How to spawn an ACP agent. Adding a runtime = one row (mirrors contracts/runtime-registry.json). */
export interface AcpAgentSpec {
  id: string;
  label: string;
  /** Executable; the detected absolute path (RuntimeStatus.source) replaces it at run time. */
  command: string;
  args: string[];
  /** Registry id in agentclientprotocol/registry, for drift monitoring. */
  registryId?: string;
  /**
   * Measured: `session/resume` of a session this same process holds rebinds its MCP servers (the old server processes
   * stop, the turn's table starts), so a resident process can carry each turn's own servers (acp-mcp-binding.ts).
   * Unset means unmeasured or measured not to (then a changed table needs a new process).
   */
  mcpRebindOnResume?: true;
}

export const ACP_AGENTS: Record<string, AcpAgentSpec> = {
  cursor: { id: "cursor", label: "Cursor Agent (ACP)", command: "cursor-agent", args: ["acp"], registryId: "cursor" },


  grok: { id: "grok", label: "Grok Build (ACP)", command: "grok", args: ["agent", "stdio"], registryId: "grok-build", mcpRebindOnResume: true },


  kimi: { id: "kimi", label: "Kimi CLI (ACP)", command: "kimi", args: ["acp"], registryId: "kimi" },





  "github-copilot-cli": { id: "github-copilot-cli", label: "GitHub Copilot CLI (ACP)", command: "npx", args: ["-y", "@github/copilot@1.0.95", "--acp"], registryId: "github-copilot-cli" },
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

interface ToolState { title?: string; kind?: string; status?: string; reported?: boolean; started?: boolean; rawInput?: unknown; rawOutput?: unknown; content?: unknown }

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

function closedAcpObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

/** Closed setup metadata is not inference evidence. Unknown extensions stay conservative. */
function isAcpSetupMetadata(params: unknown): boolean {
  let update = params;
  if (closedAcpObject(params, ["sessionId", "update"]) && typeof params.sessionId === "string") update = params.update;
  const optionalText = (value: Record<string, unknown>, key: string) => value[key] === undefined || typeof value[key] === "string";
  if (closedAcpObject(update, ["sessionUpdate", "currentModeId"]) && update.sessionUpdate === "current_mode_update") {
    return typeof update.currentModeId === "string";
  }
  if (closedAcpObject(update, ["sessionUpdate", "availableCommands"]) && update.sessionUpdate === "available_commands_update") {
    return Array.isArray(update.availableCommands) && update.availableCommands.every(command =>
      closedAcpObject(command, ["name", "description", "input"]) && typeof command.name === "string"
      && typeof command.description === "string" && (command.input === undefined
        || (closedAcpObject(command.input, ["hint"]) && typeof command.input.hint === "string")));
  }
  if (closedAcpObject(update, ["sessionUpdate", "configOptions"]) && update.sessionUpdate === "config_option_update") {
    const isValue = (value: unknown) => closedAcpObject(value, ["value", "name", "description"])
      && typeof value.value === "string" && typeof value.name === "string" && optionalText(value, "description");
    const isGroup = (group: unknown) => closedAcpObject(group, ["group", "name", "options"])
      && typeof group.group === "string" && typeof group.name === "string"
      && Array.isArray(group.options) && group.options.every(isValue);
    return Array.isArray(update.configOptions) && update.configOptions.every(option =>
      closedAcpObject(option, ["id", "name", "description", "category", "type", "currentValue", "options"])
      && typeof option.id === "string" && typeof option.name === "string"
      && optionalText(option, "description") && optionalText(option, "category")
      && option.type === "select" && typeof option.currentValue === "string"
      && Array.isArray(option.options) && (option.options.every(isValue) || option.options.every(isGroup)));
  }
  return false;
}

/** Client-side handling of one session's stream. */
export class AcpSessionClient {
  text = "";
  /** Non-metadata live activity makes execution uncertain, even without assistant text. */
  turnActivityObserved = false;
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
  /** Per-turn plan emitter: forwards the agent's checklist only when it changes. */
  private planEmitter: ((plan: InvocationPlan | null) => void) | null = null;
  private emitPlan(plan: InvocationPlan | null): void {
    (this.planEmitter ??= createRuntimePlanEmitter(this.events.onPlan))(plan);
  }

  constructor(
    private readonly events: RunnerEvents,
    private readonly permission: RunnerRequest["permission"],
    private readonly locale: "ko" | "en",
    private readonly approval: { runtime: string; sessionKey: string; cwd?: string; chatId?: string; agentId?: string; unattended?: boolean; planMode?: true; signal?: AbortSignal;
      /** A native question the agent asked (acpNativeQuestion): recorded for the owner on an attended run. */
      ownerQuestion?: (question: AgentlasAskQuestion) => void } = { runtime: "acp", sessionKey: "acp" },
  ) {}

  /** Cursor's `cursor/update_todos` / `cursor/create_plan` todo list, projected into the same checklist as ACP `plan`. */
  private cursorTodos: CursorTodoPlanTracker | null = null;
  cursorTodoUpdate(params: unknown, replace = false): void {
    if (this.replaying) return;
    const tracker = this.cursorTodos ??= new CursorTodoPlanTracker();
    this.emitPlan(tracker.update(replace && params && typeof params === "object" ? { ...(params as object), merge: false } : params));
  }

  /** Tool calls this turn reported (started or finished; replayed history excluded): settleNormalEnd evidence (R-065). */
  get turnToolCalls(): number { return this.tools.size; }

  /** Everything between these two calls is history replay, not this turn. */
  beginReplay(): void { this.replaying = true; }
  endReplay(): void {
    this.replaying = false;
    this.text = "";
    this.turnActivityObserved = false;
    this.tools.clear();
    this.thinking = false;
  }

  onUpdate(params: any, onLiveActivity?: () => void): void {
    if (this.replaying) return;
    if (isAcpSetupMetadata(params)) return;
    this.turnActivityObserved = true;
    onLiveActivity?.();
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
        // The agent's own checklist, typed (runtime-plan.ts) — not a status sentence. Each update is the full list.
        this.emitPlan(planFromAcpPlanUpdate(update));
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.endThinking();
        this.handleToolCall(update, update.sessionUpdate === "tool_call");
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

  private handleToolCall(update: any, starts: boolean): void {
    const id = String(update.toolCallId ?? update.tool_call_id ?? "");
    if (!id) return;
    const prev = this.tools.get(id) ?? {};
    const merged: ToolState = {
      title: update.title ?? prev.title,
      kind: update.kind ?? prev.kind,
      status: update.status ?? prev.status,
      reported: prev.reported,
      started: prev.started,
      rawInput: update.rawInput ?? prev.rawInput,
      rawOutput: update.rawOutput ?? prev.rawOutput,
      content: update.content ?? prev.content,
    };
    this.tools.set(id, merged);
    const kind = normalizeToolKind(merged.kind);
    const label = TOOL_KIND_LABEL[kind];
    const name = merged.title ? `${label}: ${merged.title}` : label;
    const text = (value: unknown) => typeof value === "string" ? value : value == null ? undefined : JSON.stringify(value);
    // A tool is reported to the host exactly once, at completion, like every
    // other runner (Claude Code, Codex, local). Emitting a second event at start
    // doubled every tool row and success counter downstream (2026-09-13). The
    // start is still recorded for the effect report.
    if (starts && !merged.started) merged.started = true;
    const done = merged.status === "completed" || merged.status === "failed";
    if (!done || merged.reported) return;
    merged.reported = true;
    this.events.onTool?.(name, text(merged.rawInput), text(merged.rawOutput ?? merged.content) ?? "", id, merged.status === "failed",
      undefined, undefined, undefined, kind as RuntimeToolKind);
  }

  effectReport(terminal: string | null): AdapterEffectReport {
    // ACP v1 tool updates are optional reporting, and end_turn does not certify
    // external/background job quiescence. Typed UI completion alone cannot upgrade this.
    return { schemaVersion: "agentlas.adapter-effect-coverage.v1", protocol: "acp-v1", complete: false, terminal,
      operationIds: [...this.tools.keys()].sort(), frameKinds: ["session/update"],
      reasons: ["acp-agent-quiescence-contract-unconfirmed", ...([...this.tools.values()].some(tool => !tool.started || !tool.reported || tool.status === "failed") ? ["tool-incomplete-or-failed"] : [])] };
  }

  /**
   * session/request_permission. With a registered arbiter (tool-approval
   * contract) the USER decides live — including read runs, where asking beats
   * a silent refusal. Without one: conservative default (read+mutating →
   * reject, else allow). Either way this is not the trust boundary — agents may
   * run with bypassPermissions and never ask.
   */
  async answerPermission(params: any): Promise<any> {
    if (this.approval.signal?.aborted) return { outcome: { outcome: "cancelled" } };
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const readOnly = this.permission === "read" || this.permission === undefined;
    const kind = normalizeToolKind(params?.toolCall?.kind);
    const mutating = !["read", "search", "fetch", "think"].includes(kind);
    // The provider's typed option kind is the authority contract, not its label
    // or array position. A once approval must never become a native session grant.
    const find = (kind: string) => options.find((o) => o?.kind === kind
      && typeof o.optionId === "string" && o.optionId.length > 0
      && options.filter((candidate) => candidate?.optionId === o.optionId).length === 1);
    const rejectOption = () => find("reject_once") ?? find("reject_always");
    const allowOption = (session: boolean) => session
      ? find("allow_always") ?? find("allow_once")
      : find("allow_once");
    const selected = (option: any) => (option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });

    // Kimi asks its AskUserQuestion through this same request; approving it used to select the first answer for the
    // owner. The question is dismissed now and, on an attended run, shown to the owner after the turn (ask_form's path).
    const question = this.approval.runtime === "kimi" ? kimiPermissionQuestion(params, options) : null;
    if (question) {
      if (question.ask) this.approval.ownerQuestion?.(question.ask);
      return selected(question.skip);
    }

    if (this.approval.planMode && mutating) return selected(rejectOption());

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
          // Structured input binds recipient/amount into the consent identity (docs native-harness 07 G04).
          ...(params?.toolCall?.rawInput && typeof params.toolCall.rawInput === "object" ? { arguments: params.toolCall.rawInput } : {}),
          cwd: this.approval.cwd,
          permission: this.permission,
          ...(this.approval.planMode ? { planMode: true as const } : {}),
          mutating,
          chatId: this.approval.chatId,
          agentId: this.approval.agentId,
          unattended: this.approval.unattended,
          ...(this.approval.signal ? { signal: this.approval.signal } : {}),
        });
      } catch {
        decision = "deny"; // an arbiter failure must never turn into an allow
      }
      // ACP: a client cancelling the turn answers pending permission requests with
      // the `cancelled` outcome, not a user rejection.
      if (this.approval.signal?.aborted) return { outcome: { outcome: "cancelled" } };
      if (decision !== "allow_once" && decision !== "allow_session") return selected(rejectOption());
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

/**




 */
function kimiPermissionQuestion(params: any, options: any[]): { skip: any; ask: AgentlasAskQuestion | null } | null {
  if (params?.toolCall?.title !== "AskUserQuestion" || options.length < 2) return null;
  if (!options.every((option) => typeof option?.optionId === "string" && /^q0_(?:opt_\d+|skip)$/.test(option.optionId))) return null;
  const skips = options.filter((option) => option.optionId === "q0_skip" && option.kind === "reject_once");
  const answers = options.filter((option) => option.optionId !== "q0_skip");
  if (skips.length !== 1 || answers.some((option) => option.kind !== "allow_once" || typeof option.name !== "string")) return null;
  const content = Array.isArray(params.toolCall.content) ? params.toolCall.content : [];
  const questionText = content.map((block: any) => typeof block?.content?.text === "string" ? block.content.text : "").join("\n").trim();
  const ask = parseAskFenceBody(JSON.stringify({ question: questionText, options: answers.map((option) => ({ label: option.name })) }));
  return { skip: skips[0], ask };
}

/** Cursor's `cursor/ask_question` params ({ title?, questions: [{ id, prompt, options: [{ id, label }], allowMultiple? }] })
 * as choice cards, through the same parser ask_form uses (2-8 labelled options, no templates). */
function cursorQuestions(params: any): AgentlasAskQuestion[] {
  const questions: unknown[] = Array.isArray(params?.questions) ? params.questions : [];
  return questions.flatMap((raw: any) => {
    const parsed = parseAskFenceBody(JSON.stringify({
      question: typeof raw?.prompt === "string" ? raw.prompt : "",
      ...(typeof params?.title === "string" ? { header: params.title } : {}),
      options: Array.isArray(raw?.options) ? raw.options.map((option: any) => ({ label: typeof option?.label === "string" ? option.label : "" })) : [],
      multiSelect: raw?.allowMultiple === true,
    }));
    return parsed ? [parsed] : [];
  });
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

interface AcpExecutableOwner {
  specId: string;
  chatId: string;
  sessionOwnerId: string | null;
  isolateOwner: boolean;
  generation: string;
}

interface Session {
  child: ChildProcess;
  conn: AcpConnection;
  init: any;
  state: AcpSessionState;
  /** The executable generation that created this resident child. */
  executableOwner?: AcpExecutableOwner;
  /** 이 세션이 들고 있는 ACP sessionId — 다음 턴이 그대로 이어 쓴다. */
  acpSessionId?: string;
  /** Latest acknowledged selection contract; used to change models without another CLI. */
  modelSelectionResponse?: unknown;
  requestedModel?: string;
  defaultModel?: string;
  /** Resolved MCP table this session's servers were bound from (acp-mcp-binding.ts); rebound when a reused turn differs. */
  mcpTable?: string;
  poolKey?: string;
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
    /** Present only for a resident session; preserves its exact executable generation. */
    executableOwner?: AcpExecutableOwner;
    /**







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
  let session: Session | undefined;
  let stopAcpHeartbeat = (): void => {};
  try {
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
    stopAcpHeartbeat = startCliHeartbeat(child, heartbeatStatus, opts.label ?? spec.id);
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
    session = { child, conn, init: null, state, ...(opts.executableOwner ? { executableOwner: opts.executableOwner } : {}), stopHeartbeat: stopAcpHeartbeat };
    const init = await conn.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agentlas-desktop", version: "1.0" },
    }, { timeoutMs: opts.timeoutMs });
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
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
    session.init = init;
    return session;
  } catch (error) {
    if (session) await closeAcpSession(session);
    else {
      const termination = waitForCliTreeTermination(child);
      state.active = null;
      state.closed = true;
      try { stopAcpHeartbeat(); } catch { /* already stopped */ }
      try { killCliTree(child); } catch { /* already closing */ }
      await termination;
    }
    throw error;
  }
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
const acpSessionTerminations = new WeakMap<Session, Promise<void>>();
function closeAcpSession(session: Session): Promise<void> {
  const existing = acpSessionTerminations.get(session);
  if (existing) return existing;
  const termination = waitForCliTreeTermination(session.child);
  acpSessionTerminations.set(session, termination);
  session.state.active = null;
  session.state.closed = true;
  try { session.stopHeartbeat(); } catch { /* ignore */ }
  try { session.conn.close(); } catch { /* ignore */ }
  try { killCliTree(session.child); } catch { /* ignore */ }
  return termination;
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

const executableOwners = new Map<string, { generation: string; current: boolean }>();

/**
 * Capture the selected executable before asynchronous setup. A later observation
 * for this exact ACP conversation owner invalidates the older turn on release.
 */
function captureAcpExecutableOwner(owner: AcpExecutableOwner): () => boolean {
  const key = JSON.stringify([owner.specId, owner.chatId, owner.sessionOwnerId, owner.isolateOwner]);
  let token = executableOwners.get(key);
  if (!token || token.generation !== owner.generation) {
    if (token) token.current = false;
    token = { generation: owner.generation, current: true };
  }
  executableOwners.delete(key);
  executableOwners.set(key, token);
  if (executableOwners.size > 128) {
    const oldest = executableOwners.keys().next().value!;
    executableOwners.get(oldest)!.current = false;
    executableOwners.delete(oldest);
  }
  return () => token.current;
}

/** Retire obsolete process configurations for the same ACP runtime and logical chat owner. */
async function retireSupersededAcpSessions(pool: AcpSessionPool<Session>, owner: AcpExecutableOwner, poolKey: string): Promise<void> {
  const retired = pool.retireIdleMatching((session) => session.executableOwner?.specId === owner.specId
    && session.executableOwner.chatId === owner.chatId
    && session.executableOwner.sessionOwnerId === owner.sessionOwnerId
    && session.executableOwner.isolateOwner === owner.isolateOwner
    && (session.executableOwner.generation !== owner.generation || session.poolKey !== poolKey
      || session.state.active !== null));
  if (retired.busy) throw new Error("runtime_session_owner_busy");
  await Promise.all(retired.retired.map(session => waitForRetiredCliExit(session.child)));
}

export function acpSessionPool(): AcpSessionPool<Session> {
  if (!sessionPool) {
    sessionPool = new AcpSessionPool<Session>({
      alive: acpSessionAlive,
      close: closeAcpSession,
      





      // 파이프는 런타임에 Socket 이라 ref/unref 를 갖지만 타입(Readable/Writable)에는 없다.
      unref: (session) => {
        releaseAttemptChild(session.child);
        session.child.unref?.();
        for (const pipe of [session.child.stdin, session.child.stdout, session.child.stderr]) {
          (pipe as unknown as { unref?: () => void } | null)?.unref?.();
        }
      },
      ref: (session) => {
        claimAttemptChild(session.child);
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
 * **프로세스 정체성**(cwd·MCP·실행 파일·도구 관문)을 더한다.
 *
 * MCP is `mcpIdentity` (acp-mcp-binding.ts), never the per-invocation config path: `grant:<names>` for an agent that
 * rebinds a resident session's servers with session/resume (the runner rebinds them before each reused turn),
 * `table:<resolved content>` for any other. The path alone changed on every invocation, and the MCP secret aliases in
 * the env carried per-run values, so every turn spawned a new process (W3a-F1, the defect codex had before 2f77db63).
 * Alias names whose values travel inline in the table leave the env digest; they also leave the spawned env.
 */
export function acpPoolKey(input: {
  specId: string;
  chatId: string;
  fingerprint: string;
  /** The logical chat owner is part of resident-session identity. */
  sessionOwnerId?: string | null;
  isolateOwner?: boolean;
  /** Filesystem-observed executable generation; unavailable callers remain compatible. */
  executableGeneration?: string;
  cwd: string;
  /** `grant:<digest>` or `table:<digest>` (acp-mcp-binding.ts); absent without MCP. */
  mcpIdentity?: string;
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
    if (ACP_MCP_SECRET_ALIAS_RE.test(name)) continue;
    envDigest.update(name).update("\0").update(String((input.env ?? {})[name] ?? "")).update("\0");
  }
  return createHash("sha256")
    .update("acp-pool-v2\0")
    .update(input.specId).update("\0")
    .update(input.chatId).update("\0")
    .update(input.fingerprint).update("\0")
    .update(JSON.stringify([input.sessionOwnerId ?? null, input.isolateOwner ?? false])).update("\0")
    .update(input.executableGeneration ?? "").update("\0")
    .update(input.cwd).update("\0")
    .update(input.mcpIdentity ?? "").update("\0")
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


    const raw = err instanceof Error ? err.message : String(err);
    const data = err instanceof AcpRpcError ? err.data : undefined;
    const detail = data == null ? "" : (typeof data === "string" ? data : JSON.stringify(stableAcpErrorData(data)));
    return { status: "failed", models: [], rawLineCount: 0, reason: `acp:${detail && !raw.includes(detail) ? `${raw}: ${detail}` : raw}`, source: "acp" };
  } finally {
    // 탐지용 세션은 풀에 넣지 않는다 — 대화가 아니라 한 번의 질문이다.
    if (session) await closeAcpSession(session);
  }
}

/**



 */
function stableAcpErrorData(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  return Object.fromEntries(Object.entries(data as Record<string, unknown>)
    .filter(([key]) => !/^(headers|request|date)$|request_?id$/i.test(key)));
}

const acpProbeCache = new Map<string, { at: number; outcome: DiscoveryOutcome & { init?: any }; failures: number }>();
const acpProbeInFlight = new Map<string, Promise<DiscoveryOutcome & { init?: any }>>();
export const ACP_PROBE_TTL_MS = 10 * 60 * 1000;
export const ACP_FAILED_PROBE_MAX_RETRY_MS = 30 * 60 * 1000;

/**
 * Cached ACP discovery for detect(): spawning a full agent per 10s detect tick
 * would be far too heavy, so one probe per (spec, command) is reused for 10
 * minutes. A failed probe is retried after 1 minute, doubling per consecutive
 * failure up to 30 minutes — a denied account stays denied, and every retry
 * spawns the agent (`npx -y @github/copilot` for Copilot). Concurrent detect()
 * calls share one probe instead of spawning one each.
 */
export async function probeAcpModelsCached(
  spec: AcpAgentSpec,
  opts?: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; now?: number },
): Promise<DiscoveryOutcome & { init?: any }> {
  const key = `${spec.id}\u0000${opts?.command ?? spec.command}`;
  const now = opts?.now ?? Date.now();
  const hit = acpProbeCache.get(key);
  if (hit) {
    const ttl = hit.outcome.status === "ok" ? ACP_PROBE_TTL_MS : Math.min(60_000 * 2 ** Math.max(0, hit.failures - 1), ACP_FAILED_PROBE_MAX_RETRY_MS);
    if (now - hit.at < ttl) return hit.outcome;
  }
  const pending = acpProbeInFlight.get(key);
  if (pending) return pending;
  const probe = probeAcpModels(spec, opts).then((outcome) => {
    const failures = outcome.status === "ok" ? 0 : (acpProbeCache.get(key)?.failures ?? 0) + 1;
    acpProbeCache.set(key, { at: now, outcome, failures });
    return outcome;
  }).finally(() => acpProbeInFlight.delete(key));
  acpProbeInFlight.set(key, probe);
  return probe;
}

/** Test hook. */
export function resetAcpProbeCacheForTests(): void {
  acpProbeCache.clear();
  acpProbeInFlight.clear();
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

/** Required native task browser configs are admitted by Main, never by file text. */
export function prepareNativeAcpMcpBinding(req: RunnerRequest): {
  fingerprint: string;
  config: { mcpServers: Record<string, unknown> };
  assertCurrent: () => void;
} | null {
  if (req.env?.AGENTLAS_NATIVE_BROWSER_SCOPE !== "task") return null;
  if (!req.mcpConfigPath) throw new Error("native_browser_mcp_config_required");
  req.signal?.throwIfAborted();
  const rows = preparedMcpBindings(req.mcpConfigPath);
  if (!rows.some((row) => row.configKey === "agentlas-browser" && row.server.catalogId === "agentlas-browser")) {
    throw new Error("native_browser_mcp_binding_required");
  }
  const mcpServers = Object.fromEntries(rows.map((row) => {
    const launch = preparedMcpTransport(row, row.server);
    return [row.configKey, launch.kind === "stdio"
      ? { command: launch.command, args: launch.args, env: launch.env }
      : { type: launch.kind, url: launch.url, headers: launch.headers }];
  }));
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex"),
    config: { mcpServers },
    assertCurrent: () => {
      req.signal?.throwIfAborted();
      for (const row of rows) preparedMcpTransport(row, row.server);
    },
  };
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
): Promise<unknown> {
  const model = typeof requestedModel === "string" && requestedModel.trim() ? requestedModel : undefined;
  if (!model) return response;

  const config = modelConfigOptionFromSession(response);
  if (config) {
    if (!config.values.includes(model)) {
      throw new Error(`ACP model ${model} is not advertised by ${spec.id}`);
    }
    if (config.currentValue === model) return response;
    const acknowledged = await conn.request(
      "session/set_config_option",
      { sessionId, configId: config.configId, value: model },
      { timeoutMs: 10_000 },
    );
    const confirmed = modelConfigOptionFromSession(acknowledged, config.configId);
    if (!confirmed || confirmed.currentValue !== model) {
      throw new Error(`ACP model selection for ${model} was not acknowledged by ${spec.id}`);
    }
    return acknowledged;
  }

  const legacy = legacyModelSelectionFromSession(response);
  if (legacy) {
    if (!legacy.modelIds.includes(model)) {
      throw new Error(`ACP model ${model} is not advertised by ${spec.id}`);
    }
    if (legacy.currentModelId === model) return response;
    await conn.request(
      "session/set_model",
      { sessionId, modelId: model },
      { timeoutMs: 10_000 },
    );
    return { models: { currentModelId: model, availableModels: legacy.modelIds.map(modelId => ({ modelId })) } };
  }

  // Cursor's source-owned `auto` row delegates only when no ACP selection
  // contract was advertised. If an agent did advertise one, apply it above so
  // `auto` cannot silently leave an advertised current model unchanged.
  if (isCursorAutomaticModel(spec, model)) return response;

  throw new Error(`ACP runtime ${spec.id} did not advertise a model selection contract for ${model}`);
}

/** An ACP `thought_level` select option (the protocol's reserved category for reasoning effort), if advertised. */
export function thoughtLevelConfigOptionFromSession(response: unknown): { configId: string; currentValue: string | null; values: string[] } | null {
  const options = (response as { configOptions?: unknown } | null)?.configOptions;
  if (!Array.isArray(options)) return null;
  for (const option of options) {
    if (!option || typeof option !== "object" || (option as any).category !== "thought_level" || (option as any).type !== "select") continue;
    const id = (option as any).id;
    if (typeof id !== "string" || !id) continue;
    const entries: unknown[] = Array.isArray((option as any).options) ? (option as any).options : [];
    const values = entries.flatMap((entry: any) => Array.isArray(entry?.options) ? entry.options : [entry])
      .map((entry: any) => entry?.value).filter((value: unknown): value is string => typeof value === "string" && value.length > 0);
    if (values.length === 0) continue;
    const current = (option as any).currentValue;
    return { configId: id, currentValue: typeof current === "string" ? current : null, values };
  }
  return null;
}

/**





 */
export async function configureAcpSessionEffort(
  spec: AcpAgentSpec,
  conn: Pick<AcpConnection, "request">,
  sessionId: string,
  response: unknown,
  requested: string | undefined,
): Promise<{ response: unknown; application: ModelEffortApplication }> {
  const want = typeof requested === "string" && requested.trim() ? requested.trim().toLowerCase() : null;
  if (!want) return { response, application: { status: "not_requested" } };
  const option = thoughtLevelConfigOptionFromSession(response);
  if (!option) return { response, application: { status: "unsupported", requested: want, reason: "acp_effort_option_unavailable" } };
  const value = option.values.find((candidate) => candidate.toLowerCase() === want);
  if (!value) return { response, application: { status: "unsupported", requested: want, reason: "acp_effort_level_not_advertised" } };
  const applied = { status: "applied" as const, applied: value, requested: want, wire: "session/set_config_option" };
  if (option.currentValue === value) return { response, application: applied };
  // An effort the agent refuses or does not confirm leaves the turn at the agent's own level, recorded as such; unlike a
  // model, it never changes who answers, so it does not stop the turn.
  let acknowledged: unknown;
  try {
    acknowledged = await conn.request("session/set_config_option", { sessionId, configId: option.configId, value }, { timeoutMs: 10_000 });
  } catch {
    return { response, application: { status: "unsupported", requested: want, reason: "acp_effort_refused" } };
  }
  const confirmed = thoughtLevelConfigOptionFromSession(acknowledged);
  if (!confirmed || confirmed.currentValue !== value) {
    return { response, application: { status: "unsupported", requested: want, reason: "acp_effort_not_acknowledged" } };
  }
  return { response: modelConfigOptionFromSession(acknowledged) ? acknowledged : response, application: applied };
}

/** Runner factory — one Runner per ACP agent spec. */
export function createAcpRunner(spec: AcpAgentSpec): Runner {
  /**
   * Only a host-proven stale resident session before prompt dispatch or live
   * protocol activity may be replaced once. Empty assistant text cannot prove
   * that the previous attempt did not infer or act.
   */
  const runTurn = async (req: RunnerRequest, events: RunnerEvents, allowStaleRetry: boolean): Promise<RunnerResult> => {
    const locale = pickLocale(req);
    const cwd = req.cwd ?? agentRunCwd();
    const configuredCommand = req.runtimeSource ?? spec.command;
    // Everything before the pool or a process is touched is a refusal before dispatch (RuntimeTurnDelivery
    // "not-dispatched", runner.ts preDispatchRefusal keeps the innermost machine code): a science-recovery transport
    // refusal, a task browser scope without its MCP binding, an executable that cannot be observed.
    const prepared = (() => {
      try {
        const recovery = assertScienceRecoveryAcpRequest(req, spec.id);
        const nativeMcp = prepareNativeAcpMcpBinding(req);
        events.onStatus(tStatus(locale, "callingBackend", { backend: req.backendLabel || spec.label }));
        // Other tools' personal context (Claude/Cursor folders) stays out unless One chose it (foreign-cli-context.ts).
        // MCP secret aliases never reach the agent process: the servers get their values inline (acp-mcp-binding.ts).
        const runEnv = withForeignCliContext(spec.id, req.env ?? process.env, selectionFor(req.agentId, undefined, req.chatId));
        const agentEnv = acpSpawnEnvWithoutMcpSecrets(runEnv);
        const executableIdentity = observeCliExecutableIdentity({ bin: configuredCommand, cwd, env: agentEnv });
        if (!executableIdentity) throw Object.assign(new Error(`ACP executable unavailable: ${configuredCommand}`), { code: "acp_executable_unavailable" });
        return { recovery, nativeMcp, runEnv, agentEnv, executableIdentity };
      } catch (error) {
        if (req.signal?.aborted || runnerRefusedBeforeDispatch(error)) throw error;
        throw preDispatchRefusal(error, "acp-prepare", "acp_pre_dispatch_refused");
      }
    })();
    const { recovery, nativeMcp, runEnv, agentEnv, executableIdentity } = prepared;
    /*
     * The turn's lifetime for pending permission cards: Stop or turn settle
     * withdraws the card (Paseo rejectAllPendingPermissions on interrupt/close,
     * getpaseo/paseo@da48803 providers/claude/agent.ts:4862). Before this, a Stop
     * killed the agent and left its card on screen for the 5-minute expiry.
     */
    const approvalTurn = new AbortController();
  registerNativeApprovalChildSignal(req.signal, approvalTurn.signal);
    const endApprovalTurn = () => approvalTurn.abort(req.signal?.reason ?? new Error("acp_turn_settled"));
    if (req.signal?.aborted) endApprovalTurn();
    else req.signal?.addEventListener("abort", endApprovalTurn, { once: true });
    /*
     * Native questions (Kimi's AskUserQuestion, Cursor's cursor/ask_question and cursor/create_plan) take the owner-ask
     * path ask_form takes: answered now as not answered, and on an attended run shown to the owner as the reply's
     * canonical choice card, whose pick arrives as the next message. Unattended runs and team workers never ask the
     * owner (unattendedNoAsk, 274ed968): their agent gets the typed refusal and nothing is shown.
     */
    const ownerCanAnswer = !req.unattended && !req.unattendedNoAsk;
    const turnAsks: AgentlasAskQuestion[] = [];
    let turnPlanText = "";
    const client = new AcpSessionClient(events, req.permission, locale, {
      ownerQuestion: (question) => { if (ownerCanAnswer) turnAsks.push(question); },
      signal: approvalTurn.signal,
      ...(req.planMode ? { planMode: true as const } : {}),
      runtime: spec.id,
      sessionKey: `${spec.id}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`,
      cwd,
      chatId: req.approvalChatId ?? req.chatId,
      agentId: req.agentId,
      unattended: req.unattended === true,
    });
    const sessionKind = acpSessionKind(spec.id);
    // Only the host's active delivery keys retained resources. Observable chat,
    // approval and effect ownership continue to use the actual task chat.
    const canonicalContextKey = req.agentContext && !recovery && !req.minimalObservation
      && !req.untrustedNoTools && !req.restrictedReadBoundary && !req.judgmentOnly
      && agentContextDeliveryForRequest(req) ? agentContextSessionKey(req.agentContext) : undefined;
    const contextChatId = canonicalContextKey ?? req.chatId;
    const runtimeSessionOwnerId = req.runtimeSessionOwnerId ?? req.agentId;
    const isolateRuntimeSessionOwner = req.runtimeSessionOwnerId != null;
    const executableOwner: AcpExecutableOwner | null = req.chatId ? {
      specId: spec.id,
      chatId: contextChatId!,
      sessionOwnerId: runtimeSessionOwnerId ?? null,
      isolateOwner: isolateRuntimeSessionOwner,
      generation: executableIdentity.generation,
    } : null;
    const retainExecutableOwner = executableOwner ? captureAcpExecutableOwner(executableOwner) : () => true;




    const identityHash = (mode: boolean, executableFingerprint = executableIdentity.fingerprint) => createHash("sha256")
      .update(mode ? "acp-session-v3\0" : "acp-conversation-v4\0")
      .update(spec.id)
      .update("\0")
      .update(req.sessionFingerprintSeed ?? req.systemPrompt ?? "")
      // The system `ask:` module is left out for RunnerRequest.unattendedNoAsk (team workers): a thread seeded with it is another conversation.
      .update(!req.sessionFingerprintSeed && req.unattendedNoAsk ? "\0unattended-no-ask" : "")
      .update("\0")
      // Model is selected and acknowledged on the held ACP session before every changed-model turn.
      .update(mode ? (req.permission ?? "") : "")
      .update(mode && req.planMode ? "\0plan-read-only" : "")
      .update(nativeMcp ? `\0native-mcp\0${nativeMcp.fingerprint}` : "")
      .update("\0executable\0")
      .update(executableFingerprint)
      .digest("hex");
    const fingerprint = req.chatId ? identityHash(true) : null;
    const conversationFingerprint = req.chatId ? identityHash(false) : null;
    // Read-only: a session an older build saved under the device-number fingerprint (no reboot since) resumes once and is
    // saved again under conversationFingerprint below (cli-executable-identity.ts).
    const legacyConversationFingerprint = req.chatId ? identityHash(false, executableIdentity.legacyFingerprint) : null;
    const savedSession = !recovery && req.chatId
      ? getRuntimeSession(req.chatId, sessionKind, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
      : null;
    const storedSessionId = savedSession && conversationFingerprint
      && (savedSession.fingerprint === conversationFingerprint || savedSession.fingerprint === legacyConversationFingerprint) ? savedSession.sessionId : null;
    const resumeSessionId = req.runtimeSessionId ?? storedSessionId;

    /*
     * ★상주 — 이 턴이 끝나도 세션을 닫지 않는다.
     *
     * 키가 있는(=대화에 속한) 실행은 풀에서 빌린다. 같은 키의 다음 턴은 이미 떠 있는
     * 프로세스와 이미 열린 ACP 세션을 그대로 이어 쓴다. 키가 없으면(chatId 없는 일회성
     * 실행) 예전 그대로 열고 닫는다 — 이어 쓸 다음 턴이 정의상 없기 때문이다.
     */
    const pool = acpSessionPool();
    // The turn's MCP servers, self-contained (acp-mcp-binding.ts): secrets resolved inline from the turn's env, keyed
    // by grant (an agent that rebinds a resident session's servers) or by resolved content (any other agent).
    const mcpBinding = resolveAcpMcpConfig(nativeMcp?.config ?? await readMcpConfig(req.mcpConfigPath), req.env ?? process.env);
    const mcpIdentity = mcpBinding.config ? (spec.mcpRebindOnResume ? `grant:${mcpBinding.grant}` : `table:${mcpBinding.table}`) : undefined;
    const poolKey = !req.singleUse && req.chatId && fingerprint
      ? acpPoolKey({
        specId: spec.id,
        chatId: contextChatId!,
        fingerprint,
        sessionOwnerId: runtimeSessionOwnerId ?? null,
        isolateOwner: isolateRuntimeSessionOwner,
        executableGeneration: executableIdentity.generation,
        cwd,
        ...(mcpIdentity ? { mcpIdentity } : {}),
        ...(req.runtimeSource ? { runtimeSource: req.runtimeSource } : {}),
        ...(req.toolBrokerPluginDir ? { toolBrokerPluginDir: req.toolBrokerPluginDir } : {}),
        env: req.env ?? process.env,
      })
      : null;
    const turnSink: AcpTurnSink = {
      onNotification: (method, params) => {
        silence?.touch();
        if (method === "session/update") {
          // Setup can produce live activity too; retain it without admitting replayed history.
          client.onUpdate(params, ensureEffectRun);
        } else if (method === "cursor/update_todos") {
          // Cursor's checklist arrives as its documented vendor notification instead of an ACP plan update.
          client.cursorTodoUpdate(params);
        }
      },
      onRequest: async (method, params) => {
        silence?.touch();
        agentRequestObserved = true;
        ensureEffectRun();
        if (method === "session/request_permission") {
          assertScienceRecoveryAcpRequest(req, spec.id);
          return client.answerPermission(params);
        }
        // Cursor's blocking vendor requests (cursor.com/docs/cli/acp). Answered with their own typed outcomes instead of
        // -32601; the reason is a machine code. The question or plan reaches an attended owner through the reply.
        if (method === "cursor/ask_question") {
          if (ownerCanAnswer) turnAsks.push(...cursorQuestions(params));
          return { outcome: { outcome: "skipped", reason: ownerCanAnswer ? "owner_answers_after_turn" : "unattended_no_owner" } };
        }
        if (method === "cursor/create_plan") {
          client.cursorTodoUpdate(params, true);
          const plan = typeof params?.plan === "string" ? params.plan.trim() : "";
          if (ownerCanAnswer && plan) turnPlanText = plan;
          return { outcome: { outcome: "rejected", reason: ownerCanAnswer ? "owner_reviews_after_turn" : "unattended_no_owner" } };
        }
        throw new AcpRpcError({ code: -32601, message: `Method not found: ${method}` });
      },
      onStatus: (s) => events.onStatus(s),
    };
    const openSession = () => {
      assertScienceRecoveryAcpRequest(req, spec.id);
      return openAcp(spec, {
        command: executableIdentity.executable,
        cwd,
        env: agentEnv,
        timeoutMs: 60_000,
        label: req.backendLabel || spec.label,
        ...(executableOwner ? { executableOwner } : {}),
        // 도구 관문 — grok 의 `agent` 하위 명령만 이 플래그를 받는다(openAcp 주석 참조).
        ...(req.toolBrokerPluginDir ? { toolBrokerPluginDir: req.toolBrokerPluginDir } : {}),
      });
    };

    let session: Session | null = null;
    let lease: AcpSessionLease<Session> | null = null;
    /** 이 세션을 풀에 되돌리면 안 되는가(취소·오류·프로토콜 파손). */
    let broken = false;
    /** Why a broken lease is closed (acp-session-pool.ts discard): a Stop or a healthy process retired is "shutdown". */
    let closeReason: "error" | "shutdown" | null = null;
    let contextSessionId: string | null = null;
    let stableContextDelivery: StableTurnContextDelivery | undefined;
    let stableContextAcknowledged = false;
    let promptDispatchAttempted = false;
    let agentRequestObserved = false;
    let effectRun: ReturnType<typeof beginAdapterEffectRun> = null, effectTerminal: string | null = null;
    let promptCancellation: AbortController | null = null;
    let cancelFallback: ReturnType<typeof setTimeout> | undefined;
    /** ★호스트 소유 침묵 한도: 에이전트가 낸 업데이트·요청만 센다(runner.ts startCliSilenceGuard). 프롬프트 전송 뒤에만 켠다. */
    let silence: CliSilenceGuard | null = null;
    const ensureEffectRun = (): ReturnType<typeof beginAdapterEffectRun> => {
      return effectRun ??= beginAdapterEffectRun({ adapterKind: "acp", chatId: req.chatId, agentId: req.agentId });
    };
    const onAbort = () => {
      broken = true;
      closeReason ??= "shutdown";
      if (!session) return;
      // ACP cancellation belongs to the active prompt. Retain its response
      // channel briefly so the agent can finish tool cancellation and persist
      // the native turn before Main retires this resident process.
      if (promptDispatchAttempted && promptCancellation && session.acpSessionId
        && session.state.active === turnSink && acpSessionAlive(session)) {
        session.conn.notify("session/cancel", { sessionId: session.acpSessionId });
        cancelFallback = setTimeout(() => {
          promptCancellation?.abort(req.signal?.reason);
          if (session) killCliTree(session.child);
        }, 3_000);
        cancelFallback.unref?.();
      } else killCliTree(session.child);
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (poolKey && executableOwner) {
        const current = observeCliExecutableIdentity({ bin: configuredCommand, cwd, env: agentEnv });
        if (!retainExecutableOwner() || current?.generation !== executableIdentity.generation) {
          throw new Error("cli_executable_identity_changed_during_preparation");
        }
        await retireSupersededAcpSessions(pool, executableOwner, poolKey);
        lease = await pool.acquire(poolKey, {
          agentId: req.agentId ?? null,
          nodeId: req.orchestrationAgentId ?? req.agentId ?? null,
          chatId: req.chatId ?? null,
          // The same journal key the pool key holds: the registry releases a shared session by it (agent-residency.ts).
          ...(canonicalContextKey ? { sessionScopeKey: canonicalContextKey } : {}),
          projectId: req.workProjectId ?? null,
          runtimeKind: spec.id,
          source: resolveAgentResidencySource(req.agentId),
          reaperExempt: isResidencyExemptAgent(req.agentId),
        }, openSession, retainExecutableOwner);
        session = lease.session;
        session.poolKey = poolKey;
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
      // The turn's own servers. A new process binds them with session/new or session/load. A reused process already
      // holds them when its bound table is this turn's (an agent keyed by table never differs); an agent keyed by
      // grant is rebound with session/resume below, before the prompt.
      const mcp: AcpMcpTranslation = acpMcpServersFromConfig(mcpBinding.config, agentCaps.mcpCapabilities ?? null);
      const rebindMcp = reusing && (session.mcpTable ?? "") !== mcpBinding.table;
      if (rebindMcp && !(spec.mcpRebindOnResume && agentCaps.sessionCapabilities?.resume)) {
        throw new StaleAcpSessionError(new Error("acp_mcp_rebind_unavailable"));
      }
      const bindingMcp = !reusing || rebindMcp;
      nativeMcp?.assertCurrent();
      if (nativeMcp && bindingMcp && !mcp.servers.some((server) => server.name === "agentlas-browser")) {
        throw new Error("native_browser_mcp_translation_required");
      }
      if (bindingMcp && mcpBinding.dropped.length > 0) {
        events.onStatus(locale === "ko"
          ? `이번 실행에 자격증명 값이 없어 제외한 MCP 항목: ${mcpBinding.dropped.join(", ")}`
          : `Skipped MCP entries whose credential this run does not carry: ${mcpBinding.dropped.join(", ")}`);
      }
      if (!bindingMcp) {
        // Same servers as the turn that bound them: nothing to report again.
      } else if (mcp.servers.length > 0) {
        events.onStatus(locale === "ko" ? `MCP 서버 ${mcp.servers.length}개 연결됨` : `${mcp.servers.length} MCP server(s) attached`);
      }
      if (bindingMcp && mcp.unsupported.length > 0) {
        const names = mcp.unsupported.map((s) => `${s.name}(${s.transport})`).join(", ");
        events.onStatus(locale === "ko"
          ? `이 에이전트가 지원하지 않는 MCP 전송이라 제외했습니다: ${names}`
          : `Skipped MCP servers whose transport this agent does not support: ${names}`);
      }
      if (bindingMcp && mcp.malformed.length > 0) {
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
        if (rebindMcp) {
          // This turn's servers replace the previous turn's in the live session (the agent stops the old server
          // processes and starts these); the previous invocation's handles are never used again.
          client.beginReplay();
          try {
            nativeMcp?.assertCurrent();
            const rebound = await session.conn.request("session/resume", { sessionId, cwd, mcpServers: mcp.servers },
              { timeoutMs: 60_000, signal: req.signal });
            session.mcpTable = mcpBinding.table;
            if (modelConfigOptionFromSession(rebound) || legacyModelSelectionFromSession(rebound)) {
              session.modelSelectionResponse = rebound;
              // Re-check the requested model against what the resumed session now reports.
              if (req.model?.trim()) session.requestedModel = undefined;
            }
            events.onStatus(`[runtime-session] mcp_rebound kind=${sessionKind}`);
          } catch (error) {
            if (req.signal?.aborted) throw abortReasonError(req);
            throw new StaleAcpSessionError(error);
          } finally {
            client.endReplay();
          }
        }
      }
      // A Copilot session an older install wrote into the person's own folder is copied into the product mirror first.
      if (!sessionId && resumeSessionId && spec.id === "github-copilot-cli") adoptCopilotSession(runEnv.COPILOT_HOME, resumeSessionId);
      if (!sessionId && resumeSessionId && canLoadSession) {
        client.beginReplay();
        try {
          nativeMcp?.assertCurrent();
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
          /*
           * session/load starts no turn (its history replay is ignored above), so a refused load did nothing external.
           * The rules every CLI runner keeps (unattended-session-turns.ts), from typed evidence only:
           *  - unattended (rule 2): the agent's own JSON-RPC refusal of the load, or a session the runtime proves gone,
           *    continues once in a fresh session that carries the automation's capsule, the chat history or the journal
           *    seed. An automation on Copilot, Grok, Kimi or Cursor used to stop here on every run once its stored
           *    session was gone. A dead or silent transport is not a refusal and still surfaces (not dispatched).
           *  - attended under the agent-context layer (rule 4): only a session the runtime proves gone (or a load the
           *    agent does not implement, -32601), and only when the journal can seed the new session.
           *  - an attended per-chat binding re-attaches the chat's own history to a fresh session, as before.
           * Never when the attempt already showed turn activity, a request or an effect.
           */
          const beforeEffects = !client.turnActivityObserved && !agentRequestObserved && !effectRun;
          const gone = beforeEffects && acpLoadedSessionGone(spec.id, err, runEnv, resumeSessionId);
          const refused = beforeEffects && (gone || err instanceof AcpRpcError);
          const freshReason: UnattendedFreshSessionReason = gone ? "session_not_found" : "resume_failed_before_turn";
          // The journal can seed the replacement (the same facts-bearing packet the fresh session below starts from).
          let carried = !req.runtimeSessionId;
          if (!carried && canonicalContextKey && !req.unattended && gone) {
            carried = (await agentContextColdBootstrapForRequest(req).catch(() => null)) !== null;
          }
          const fresh = req.unattended ? refused
            : canonicalContextKey ? attendedTurnStartsFresh(freshReason, carried)
              || (refused && err instanceof AcpRpcError && err.code === -32601)
              : beforeEffects;
          if (!fresh) throw err;
          events.onStatus(unattendedFreshSessionStatus(sessionKind, freshReason));
          // The dead binding never seeds a later turn, and context delivered to it is not counted as delivered.
          if (!req.runtimeSessionId && req.chatId && freshSessionReplacesStored(freshReason)) {
            clearRuntimeSession(req.chatId, sessionKind, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner });
          }
          invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: sessionKind, sessionId: resumeSessionId });
        } finally {
          client.endReplay();
        }
      } else if (!sessionId && resumeSessionId) {
        events.onStatus(locale === "ko"
          ? "이 런타임은 세션 복원을 지원하지 않아 대화 기록을 다시 실어 새 세션으로 진행합니다"
          : "This runtime does not advertise session resume — starting a fresh session with the conversation re-attached");
      }
      if (!sessionId) {
        nativeMcp?.assertCurrent();
        assertScienceRecoveryAcpRequest(req, spec.id);
        created = await session.conn.request("session/new", { cwd, mcpServers: mcp.servers }, { timeoutMs: 60_000, signal: req.signal });
        sessionId = String(created?.sessionId ?? "");
        if (!sessionId) throw new Error("ACP session/new returned no sessionId");
        events.onStatus(`[runtime-session] created kind=${sessionKind}`);
      }
      // 새 세션과 session/load 응답은 둘 다 현재 모델 계약을 광고할 수 있다. 응답을
      // 버리면 load 뒤에는 선택 실패를 감지할 방법이 없어 provider 기본 모델로 흘렀다.
      // Keep the latest acknowledgement, including its current model, so A -> B -> A cannot
      // mistake the initial session/new default for the model still running in the process.
      if (!reusing) {
        session.modelSelectionResponse = created ?? loaded;
        session.defaultModel = modelConfigOptionFromSession(session.modelSelectionResponse)?.currentValue
          ?? legacyModelSelectionFromSession(session.modelSelectionResponse)?.currentModelId ?? undefined;
      }
      const requestedModel = req.model?.trim() ?? "";
      if (!reusing || session.requestedModel !== requestedModel) {
        const targetModel = requestedModel || (reusing ? session.defaultModel : undefined);
        if (reusing && !targetModel) throw new StaleAcpSessionError(new Error("acp_model_default_requires_fresh_session"));
        session.modelSelectionResponse = await configureAcpSessionModel(spec, session.conn, sessionId,
          session.modelSelectionResponse, targetModel);
        session.requestedModel = requestedModel;
      }
      // Effort through the agent's own thought_level option (AS1 gap 5); the ledger records what was applied.
      const effort = await configureAcpSessionEffort(spec, session.conn, sessionId, session.modelSelectionResponse, req.effort);
      session.modelSelectionResponse = effort.response;
      reportModelEffort(effort.application);
      // 모델 선택을 확인한 세션만 다음 턴에 재사용할 수 있게 붙인다.
      session.acpSessionId = sessionId;
      if (!reusing) session.mcpTable = mcpBinding.table;
      contextSessionId = sessionId;
      /*
       * ★모드 — plan 모드는 ACP 로는 고를 방법이 아예 없었다(session/set_mode 미호출).
       * 모드는 세션을 만들거나 불러올 때 광고된다. 새 세션과 session/load 응답 모두에서 고르고,
       * 상주 세션을 그대로 이어 쓰는 턴에서는 세션이 이미 그 모드를 갖고 있다(권한이 바뀌면
       * 풀 키가 달라져 새 프로세스가 같은 대화를 session/load 로 불러온다).
       */
      const modeId = created || loaded ? chooseAcpModeId(req.permission, modeOptionsFromNewSession(created ?? loaded)) : undefined;
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
      // session/new is measured before resolving this immutable host packet.
      // A cold no-load carrier needs its own prior turns as well as foreign
      // deltas; the wrapper's retained-turn req.history is intentionally empty.
      // A session that did not load is seeded from the journal, with the host facts ahead of any summary (NH13).
      const bootstrap = !resumed ? await agentContextColdBootstrapForRequest(req) : null;
      const images = bootstrap?.images ?? req.images ?? [];
      const imageBlocks: Array<Record<string, unknown>> = [];
      let userPrompt = bootstrap?.currentPrompt ?? req.userPrompt;
      if (images.length > 0) {
        if (agentCaps.promptCapabilities?.image === true) {
          for (const image of images) imageBlocks.push({ type: "image", mimeType: image.mediaType, data: image.data });
          events.onStatus(locale === "ko"
            ? `첨부 이미지 ${images.length}개를 그대로 전송합니다`
            : `Sending ${images.length} attached image(s) inline`);
        } else {
          if (req.untrustedNoTools) {
            return { text: "", turnDelivery: "not-dispatched", failure: {
              kind: "unsupported", runtime: spec.id, source: "marker",
              providerCode: "acp_no_tools_images_unsupported", message: "acp_no_tools_images_unsupported",
            } };
          }
          const staged = await stageCliImageAttachments({
            userPrompt,
            images: [...images],
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
      // A restored ACP session has not seen turns from another backend. A caller
      // supplying its own native session also owns its history cursor.
      const gapContext = resumed && !req.runtimeSessionId && savedSession && sessionId === storedSessionId
        ? renderGapContext(unseenHistoryGap(req.history, savedSession.updatedAt), locale) : "";
      const contextFingerprint = createHash("sha256").update(JSON.stringify([fingerprint,
        runtimeSessionOwnerId ?? null, isolateRuntimeSessionOwner, req.systemPrompt, locale,
        req.permission, req.planMode, req.approvalsReviewer, req.model, req.effort,
        req.forceSurface, req.surfaceGate, req.untrustedNoTools, req.untrustedAllowedMcpTools,
        poolKey, cwd])).digest("hex");
      // session/new is a replacement even if a provider recycles an identifier.
      // Prepare delivery without committing it; init/load is never a prompt ACK.
      if (!resumed) invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: sessionKind, sessionId });
      const context = dedupeStableTurnContext({ chatId: contextChatId, runtimeKind: sessionKind,
        sessionId, contextFingerprint, turnContext: bootstrap?.turnContext ?? req.turnContext, stableBlocks: req.turnContextStable });
      stableContextDelivery = context.delivery;





      const promptText = resumed
        ? `${composeResumeTurnPrompt(userPrompt, composeDeclaredPrompt([
            { id: "transport.acp.resume.gap", revision: 1, stability: "turn-context", changeTriggers: ["owner-input", "checkpoint", "task"], order: 10, text: gapContext },
            { id: "transport.acp.resume.host-turn", revision: 1, stability: "turn-context", changeTriggers: ["owner-input", "checkpoint", "task"], order: 20, text: context.text },
          ], "\n\n"), locale)}${schemaFallback}`
        : [
          wrapSystemPrompt(
            req.systemPrompt, locale, req.permission, userPrompt,
            req.forceSurface, req.restrictedReadBoundary, req.untrustedNoTools,
            req.untrustedAllowedMcpTools, req.workforceRuntimeToolGrant,
            undefined, req.surfaceGate,
            spec.id,
            req.sciencePromptProfile,
            req.judgmentOnly === true ? "host-judgment" : undefined,
            undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
          ),
          (bootstrap?.history ?? req.history).length > 0 ? renderConversationContext([...(bootstrap?.history ?? req.history)], locale, cliHistoryContextTokens(spec.id, req.model)).block : "",
          context.text,
          userPrompt,
          schemaFallback,
        ].filter(Boolean).join("\n\n");
      nativeMcp?.assertCurrent();
      assertScienceRecoveryAcpRequest(req, spec.id);
      if (lease && !lease.fresh && !acpSessionAlive(session)) {
        throw new StaleAcpSessionError(new Error("acp_session_closed_before_prompt"));
      }
      effectRun = ensureEffectRun();
      req.signal?.throwIfAborted();
      promptCancellation = new AbortController();
      const promptAcknowledgementId = `acp-prompt-completed:${randomUUID()}`;
      // Kimi answers every turn end_turn, failed or not; its own session journal tells them apart (kimi-journal.ts).
      // The cursor marks where this turn's records start.
      const kimiTurn: KimiJournalCursor | null = spec.id === "kimi" || spec.registryId === "kimi"
        ? kimiJournalCursor(realCliHome("kimi", runEnv), sessionId) : null;
      // Mark before calling transport: an exception cannot prove nothing was sent.
      promptDispatchAttempted = true;
      {
        // 이 러너는 도구 시작/끝을 구분해 보고하지 않아, 긴 도구를 침묵으로 오인하지 않도록 한도를 도구 상한(90분)과 같게 둔다.
        const silenceLimitMs = cliToolSilenceWindowMs(req.env ?? process.env);
        const guardedSession = session;
        silence = startCliSilenceGuard(guardedSession.child, {
          label: spec.id, onStatus: events.onStatus, windowMs: silenceLimitMs, toolWindowMs: silenceLimitMs,
          // 트리를 죽이고 대기 중인 프롬프트 요청을 끊는다. 정산은 아래 catch 의 한 곳이다.
          kill: () => { try { killCliTree(guardedSession.child); } catch { /* the request abort still settles */ } promptCancellation?.abort(new Error("runtime_silent_timeout")); },
        });
      }
      const result = await session.conn.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: promptText }, ...imageBlocks] },
        { signal: promptCancellation.signal },
      );
      if (cancelFallback !== undefined) clearTimeout(cancelFallback);
      const wireStopReason = result?.stopReason;
      if (typeof wireStopReason !== "string" || !["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(wireStopReason)) {
        throw new RuntimeTurnUnsettledError(spec.id, locale, sessionId);
      }
      const isKimi = spec.id === "kimi" || spec.registryId === "kimi";
      // Kimi's end_turn becomes what its journal says: completed, cut at the output limit (max_tokens), failed, or
      // unattested (no journal of the measured layout: the conservative reading below).
      const kimiOutcome = isKimi && wireStopReason === "end_turn"
        ? (kimiTurn ? await attestKimiTurn(kimiTurn, { signal: req.signal }) : "unattested") : null;
      const stopReason = kimiOutcome === "truncated" ? "max_tokens" : wireStopReason;
      effectTerminal = stopReason;
      client.finish();
      // The RPC response is bound to this exact session/prompt request. Only a
      // confirmed ordinary terminal advances delivery; truncated/cancelled or
      // a Kimi turn its journal does not show completed never proves retained context.
      if (stopReason === "end_turn" && !req.signal?.aborted && (!isKimi || kimiOutcome === "completed")
        && session.acpSessionId === contextSessionId) {
        stableContextAcknowledged = acknowledgeStableTurnContext(stableContextDelivery,
          { sessionId, acknowledgementId: promptAcknowledgementId });
      }
      // Ordinary turns retain the session; fresh recovery must never seed a later resume.
      if (!recovery && req.chatId && fingerprint && !saveRuntimeSession(req.chatId, sessionKind, sessionId, conversationFingerprint ?? fingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner })) {
        events.onStatus(`[runtime-session] store_failed kind=${sessionKind}`);
      }
      if (req.signal?.aborted) throw abortReasonError(req);
      // Native questions and a proposed plan reach an attended owner through the reply (the choice card is canonical).
      const ownText = client.text.trim();
      const text = appendTurnAsks(turnPlanText && !ownText.includes(turnPlanText)
        ? [ownText, turnPlanText].filter(Boolean).join("\n\n") : ownText, turnAsks);
      // The session/prompt response is bound to this exact request: the agent acknowledged this turn (RuntimeTurnDelivery
      // "accepted"), so a continuation of an uncertain terminal (max_tokens, max_turn_requests, Kimi's end_turn) resumes
      // without re-sending it (team-step-settlement.ts, unsettled-continuation.ts).
      const turnDelivery = "accepted" as const;
      if (stopReason === "refusal") {
        return { text, failure: { kind: "refused", message: "ACP stopReason=refusal", runtime: spec.id, source: "marker" }, sessionId, turnDelivery };
      }
      if (stopReason === "cancelled") throw abortReasonError(req);
      // A Kimi turn whose last step began and never ended failed (Kimi's log has the provider error): a typed failure,
      // not an unsettled turn. Without a journal of the measured layout the old conservative reading stays.
      if (kimiOutcome === "failed") {
        return { text, sessionId, ownerControlTerminal: "uncertain", turnDelivery,
          failure: { kind: "exit", runtime: spec.id, source: "marker", providerCode: "kimi_turn_failed",
            message: locale === "ko"
              ? "Kimi가 이번 턴을 끝내지 못했습니다(세션 기록에 마지막 단계의 끝이 없습니다). 공급자 오류는 Kimi 로그에 있습니다."
              : "Kimi ended this turn without finishing it (its session journal has no end for the last step). The provider error is in Kimi's log." } };
      }
      if (kimiOutcome === "unattested") {
        return { text, sessionId, ownerControlTerminal: "uncertain", turnDelivery,
          failure: runnerFailureFromError(new RuntimeTurnUnsettledError(spec.id, locale), spec.id) };
      }
      // An ordinary end_turn (for Kimi: one its journal shows completed) is settled by the shared rule (R-065): a
      // tool-only turn completed with an empty text. max_tokens / max_turn_requests keep their own uncertain outcome.
      const normalEnd = stopReason === "end_turn" ? settleNormalEnd({ text, toolCalls: client.turnToolCalls }) : null;
      if (!text && (!normalEnd || normalEnd.outcome === "empty")) {
        return { text: "", failure: { kind: "empty", message: session.conn.lastStderr.slice(-500) || `ACP stopReason=${stopReason || "unknown"}`, runtime: spec.id, source: "marker" }, sessionId, turnDelivery };
      }
      if (client.contextUsed !== undefined && client.contextSize) {
        const pct = Math.round((client.contextUsed / client.contextSize) * 100);
        events.onStatus(locale === "ko" ? `컨텍스트 ${pct}% 사용` : `Context ${pct}% used`);
      }
      // observedUsage intentionally absent: ACP v1 gives context occupancy, not tokens. The occupancy IS the size of the
      // context the next request starts from, so it feeds the common 80% generation rule with the agent's own window.
      return { text, sessionId, ownerControlTerminal: stopReason === "end_turn" ? "completed" : "uncertain", turnDelivery,
        ...(normalEnd ? normalEndToolEvidence(normalEnd) : {}),
        ...(client.contextUsed !== undefined && client.contextUsed > 0 ? { contextInputTokens: client.contextUsed } : {}),
        ...(client.contextSize ? { contextWindowTokens: client.contextSize } : {}) };
    } catch (err) {
      // 실패한 세션은 풀에 되돌리지 않는다 — 상태를 모르는 세션을 물려주면 다음 턴이
      // 원인 없는 실패를 겪는다. 다시 여는 비용이 그보다 싸다.
      broken = true;
      closeReason ??= req.signal?.aborted || (err instanceof StaleAcpSessionError && session && acpSessionAlive(session))
        ? "shutdown" : "error";
      if (req.signal?.aborted) throw abortReasonError(req);
      // ★침묵 한도로 호스트가 끝낸 시도 — 이 catch 가 유일한 정산이다(취소는 위에서 처리했다).
      if (silence?.tripped && !effectTerminal) {
        return { text: client.text.trim(), sessionId: session?.acpSessionId ?? undefined, ownerControlTerminal: "uncertain",
          failure: runtimeSilentTimeoutFailure(spec.id, silence.trippedWith?.limitMs ?? cliToolSilenceWindowMs(req.env ?? process.env)) };
      }
      // Preserve the effect ledger in finally; missing text is never no-effect proof.
      if (!effectTerminal && (promptDispatchAttempted || client.turnActivityObserved || agentRequestObserved)) {
        // The agent's own final error (e.g. a JSON-RPC "model at capacity") leads the message; replay stays off.
        throw new RuntimeTurnUnsettledError(spec.id, locale, session?.acpSessionId, err instanceof Error ? err.message : null);
      }
      if (allowStaleRetry && lease && !lease.fresh && session
        && !promptDispatchAttempted && !client.turnActivityObserved && !agentRequestObserved
        && (err instanceof StaleAcpSessionError || !acpSessionAlive(session))) {
        throw new StaleAcpSessionError(err);
      }
      









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
        // Reached only when no prompt was dispatched and the agent showed no turn activity (the branch above throws
        // otherwise): a refusal before dispatch (RuntimeTurnDelivery), never an unsettled turn.
        return { text: "", failure: { kind, message: message + help, runtime: spec.id, source: "marker" },
          ...(!promptDispatchAttempted && !client.turnActivityObserved && !agentRequestObserved ? { turnDelivery: "not-dispatched" as const } : {}) };
      }
      throw !promptDispatchAttempted && !client.turnActivityObserved && !agentRequestObserved ? markRefusedBeforeDispatch(err) : err;
    } finally {
      if (cancelFallback !== undefined) clearTimeout(cancelFallback);
      if (contextSessionId && (broken || req.signal?.aborted || effectTerminal !== "end_turn"
        || (stableContextDelivery && !stableContextAcknowledged))) {
        invalidateStableTurnContext({ chatId: contextChatId, runtimeKind: sessionKind, sessionId: contextSessionId });
      }
      silence?.stop();
      effectRun?.complete(client.effectReport(req.signal?.aborted ? "cancelled" : effectTerminal));
      req.signal?.removeEventListener("abort", onAbort);
      req.signal?.removeEventListener("abort", endApprovalTurn);
      endApprovalTurn();
      // 수신자를 먼저 뗀다 — 유휴 세션이 지난 턴의 events 로 상태를 흘리면 안 된다.
      if (session) session.state.active = null;
      if (lease) {
        // 취소·오류면 버리고, 아니면 반납한다(다음 턴이 이어 쓴다).
        if (broken || req.signal?.aborted) {
          pool.discard(lease, closeReason ?? (req.signal?.aborted ? "shutdown" : "error"));
          if (session) await waitForRetiredCliExit(session.child);
        }
        else pool.release(lease);
      } else if (session) {
        // 풀에 들어가지 않는 일회성 실행 — 예전 그대로 닫는다.
        await closeAcpSession(session);
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
/**









 */
export function acpLoadedSessionGone(specId: string, error: unknown, env: NodeJS.ProcessEnv, sessionId: string): boolean {
  if (error instanceof AcpRpcError && error.code === -32002) return true;
  if (specId === "grok") {
    return error instanceof AcpRpcError && error.code === -32603
      && (error.data as { code?: unknown } | null | undefined)?.code === "FS_NOT_FOUND";
  }
  if (specId === "kimi") {
    const data = error instanceof AcpRpcError && error.code === -32602 ? error.data : null;
    if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1
      && (data as { sessionId?: unknown }).sessionId === sessionId) return true;
    return kimiSessionGone(realCliHome("kimi", env), sessionId);
  }
  if (specId === "github-copilot-cli") return copilotSessionGone(env.COPILOT_HOME, sessionId);
  return false;
}

export function acpOrLegacyRunner(kind: string, legacy: Runner): Runner {
  return (req, events) => {
    // Selection creates these adapters while cold ACP imports are still
    // initializing. Resolve the declared inventory at dispatch, not in that
    // module cycle; the same per-call transport/recovery gates still apply.
    const spec = ACP_AGENTS[kind];
    if (!spec) return legacy(req, events);
    const acp = createAcpRunner(spec);
    const recovery = assertScienceRecoveryAcpRequest(req, spec.id);
    if (acpDisabledFor(kind)) {
      // Respect the host transport setting; never downgrade a fresh recovery
      // into a legacy driver with different history/browser boundaries.
      if (recovery) throw new Error("science_recovery_acp_transport_disabled");
      return legacy(req, events);
    }
    return acp(req, events);
  };
}
