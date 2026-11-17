import { isAppWorkFolder } from "./session-cwd";
import { waitingForPerson } from "./run-slot-lease";
import { nativeApprovalSignalChain, withNativeApprovalAsk, stampNativeToolApproval, stampNativeDeniedApproval, nativeToolApprovalOwner, assertNativeToolApproval, assertNativeToolApprovalJoin } from "./native-approval-provenance";
/**
 * 도구 승인 계약 — 런타임이 제각각 말하는 "승인"을 한 모양으로 모은다.
 *
 * 전수 조사(2026-08-15)에서 나온 사실은 승인이 **두 종류**라는 것이다. 이 구분을
 * 지우고 하나로 만들면 "허용을 눌렀는데 아무 일도 일어나지 않는" UI가 나온다.
 *
 *  - live: 런타임이 **실행 전에** 물어보고 답을 기다린다. 사용자의 선택이 그대로
 *    이번 호출의 결과가 된다. (acp `session/request_permission`, 그리고 우리 코드가
 *    도구를 직접 도는 local-tool-loop 계열 — 둘 다 아래 중재자 등록소를 지난다)
 *
 * ★이 문서가 한동안 거짓이었다: local-tool-loop 은 여기 이름만 올라 있었을 뿐
 *   `runOneToolCall`이 승인을 한 번도 부르지 않았다(ollama/lmstudio/mlx 는 MCP 도구를
 *   무조건 실행했다). 그래서 중재자 등록소를 이 파일로 옮겨 **두 경로가 같은 한 벌**을
 *   쓰게 했다. 주석이 말한 관문이 실제로 걸려 있어야 이 문장이 사실이다.
 *
 *  - post-denial: 헤드리스라 물어볼 상대가 없어 런타임이 **이미 거부하고 지나갔다.**
 *    이번 호출은 되돌릴 수 없다. 사용자가 할 수 있는 건 다음 실행을 위해 허용 범위를
 *    넓히는 것뿐이다. (claude-code tool_result, antigravity tool 스텝 ERROR)
 *
 * 그리고 둘 다 공통으로 겪는 문제가 있다: 런타임이 그 거부를 **"사용자가 거절했다"**로
 * 기록한다(agy `User denied permission for …`, claude `user-rejected`). 사용자는 손도
 * 대지 않았다. 그래서 이 계약은 `deniedBy`를 명시적으로 들고 다닌다 — 화면이든 원장이든
 * 사람이 거절한 것과 런타임이 자동 거부한 것을 절대 같은 말로 적지 않게 하기 위해서다.
 */

import type {
  ToolApprovalRequestEvent,
  ToolApprovalDecision,
  ToolApprovalConsentBinding,
  ToolApprovalDurableConsentReceipt,
  ToolApprovalResolutionReceipt,
  SettledToolApproval,
} from "../../shared/types";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import {
  builtinToolByName,
  runBuiltinTool,
  type ToolPermission,
} from "../../shared/builtin-tools";
import { askUser } from "../confirm/ask-user";
import { APPROVAL_REFUSAL_RESULT_MODULE, approvalRefusalResultText, type ApprovalRefusal, type ApprovalToolAnnotations } from "./approval-rule";
import { registerDeclaredPromptModule } from "./prompt-order";
import type { AskAnswer, AskKind, CloseWhy, RemoteAsk } from "../one/plural-handoff-wire";
import { pluralRowAsker } from "../one/plural-remote-ask";
import { redactSecrets } from "../../shared/secret-patterns";

/** 승인 요청 하나 — 화면과 같은 정의를 쓴다(shared/types.ts). */
export type ToolApprovalRequest = ToolApprovalRequestEvent;

/** Host-owned approval/result scope. Keep the selected runtime in the identity. */
export function toolApprovalSessionKey(runtime: string, primaryIdentity?: string | null, cwd?: string | null): string {
  return `${runtime}:${primaryIdentity ?? cwd ?? "default"}`;
}

/*
 * ── 실행 전 중재자 등록소 ────────────────────────────────────────────────────
 *
 * 정책(무엇을 묻고 무엇을 바로 허용/거부할지)은 electron/ipc.ts 한 곳에서 정하고,
 * 그 한 벌을 **실행 전에 물을 수 있는 모든 경로**가 공유한다:
 *   · ACP `session/request_permission` (electron/runtime/acp.ts)
 *   · 우리 in-process 도구 루프 (electron/runtime/local-tool-loop.ts)
 *
 * 등록소를 이 파일에 두는 이유: 경로마다 자기 등록소를 들면 정책이 갈라지고,
 * 갈라진 쪽은 반드시 "묻지 않고 실행"으로 기운다. 이 파일은 shared/types 외에는
 * 아무것도 import 하지 않아서, 러너들이 Electron 없이도 그대로 테스트된다.
 */
export interface RuntimeToolPermissionAsk {
  /** Main-only lifetime; never serialized into the approval card or consent identity. */
  signal?: AbortSignal;
  /** The wire this ask came in on (a CLI hook's or the MCP proxy's connection): it aborts when the hook's time ran out or the CLI let go. Read only by a remote question (requestRemoteToolApproval), which closes as `timeout`. */
  closed?: AbortSignal;
  /** Main-authored hard read boundary, independent of existing capability grants. */
  planMode?: true;
  runtime: string;
  sessionKey: string;
  tool: string;
  /** ACP 도구 종류(read/edit/execute/…). 알 수 없으면 "other". */
  kind: string;
  detail?: string;
  /** Main-only parsed call arguments. Only their recipient/amount facts enter the consent identity; never serialized. */
  arguments?: unknown;
  /** Main-only: the app operation a host-raised ask stands for (harness/app-call-approval.ts); the approval rule reads the act from it. */
  hostOperation?: string;
  cwd?: string;
  /** 이번 실행의 권한(러너 계약과 같은 값). undefined 는 read 와 같게 취급한다. */
  permission: "read" | "write" | "full" | undefined;
  mutating: boolean;
  /** 이 실행이 붙어 있는 대화 — 승인 카드는 그 대화 안에서만 뜬다(오너 결정 2026-08-15). */
  chatId?: string;
  /** 실행 중인 에이전트 — 에이전트 스코프 능력 규칙(capability_grants)의 대상. */
  agentId?: string;
  /** Main-computed exact durable-consent identity for this request. */
  consentBinding?: ToolApprovalConsentBinding;
  /** 자동화·그래프처럼 답할 사람이 없는 실행 — 묻지 않고 즉시 거부한다. */
  unattended?: boolean;
  /** Main-only: the registry identity of the server this call goes to (never a name prefix). Read by the approval rule alone. */
  catalogId?: string | null;
  /** Main-only: what the tool says about itself in the server's tool list (MCP annotations). Read by the approval rule alone. */
  annotations?: ApprovalToolAnnotations | null;
  /** Main-only: the whole shell command line of a shell-tool ask (codex command approval, the in-process `bash`, an ACP execute call). Read by the approval rule alone; never serialized into a card or a consent identity. */
  command?: string;
  /**
   * Main-only: this ask is the GATEWAY tool's own (`harness_call` running `tool.call`). The tool.call port asks its own rule for the connector's tool right after
   * (harness/app-call-approval.ts approveConnectorToolCall, in every permission mode), so a run that can be asked is not asked a second, generic time for the gateway. It never widens
   * anything: with no conversation, an unattended run, or a stored/plan refusal the ask is decided exactly as before.
   */
  portAsksItsOwnRule?: true;
}

/**
 * 능력 클래스 — "항상 허용"이 영구 부여하는 단위(오너 결정 2026-08-20).
 * ACP 도구 kind 와 내장 도구 성격에서 도출한다. 모르면 other.
 */
export function capabilityClassFor(kind: string, tool: string): string {
  if (kind === "execute" || tool === "bash") return "execute";
  if (kind === "delete") return "delete";
  if (kind === "edit") return "edit";
  if (kind === "fetch" || kind === "network") return "network";
  return "other";
}

/**
 * Legacy helper retained for callers that imported it. Durable consent no
 * longer generalizes command tokens: an exact detail is returned unchanged so
 * callers cannot accidentally turn one approved resource into a wildcard.
 */
export function generalizeDetailPattern(detail: string | undefined): string | null {
  return detail === undefined ? null : detail;
}

export type RuntimeToolPermissionDecision = "allow_once" | "allow_session" | "deny";
export type RuntimeToolPermissionArbiter = (
  ask: RuntimeToolPermissionAsk,
) => Promise<RuntimeToolPermissionDecision>;

let runtimeToolPermissionArbiter: RuntimeToolPermissionArbiter | null = null;
/** A native relay selects by private provenance, never by a caller's label.
 * Selection is synchronous; a claimed request must not fall back after failure. */
export type RuntimeToolPermissionRelay = (
  ask: RuntimeToolPermissionAsk,
) => RuntimeToolPermissionArbiter | undefined;
const runtimeToolPermissionRelays = new Set<RuntimeToolPermissionRelay>();

export function registerRuntimeToolPermissionRelay(select: RuntimeToolPermissionRelay): () => void {
  runtimeToolPermissionRelays.add(select);
  return () => { runtimeToolPermissionRelays.delete(select); };
}

export function setRuntimeToolPermissionArbiter(arbiter: RuntimeToolPermissionArbiter | null): void {
  runtimeToolPermissionArbiter = arbiter;
}

/*
 * ── "항상 허용" 영속 훅 ──────────────────────────────────────────────────
 * 이 파일은 Electron/store 를 import 하지 않는다(러너 단독 테스트 계약). 그래서
 * allow_always 의 영구 기록은 ipc.ts 가 주입한 persister 가 맡는다. persister 가
 * 없으면 이번 호출만 허용하고 unavailable 영수증을 남긴다. 영속 승인은
 * 별도 세션 허용을 만들지 않아, 다음 호출이 철회 가능한 저장소 규칙을 다시 확인한다.
 */
export interface AlwaysAllowGrant {
  capability: string;
  pattern: string | null;
  scope: string;
  tool: string;
  consentBinding?: ToolApprovalConsentBinding;
  /** The card's kind (money | delete | send for the approval rule's cards) and its conversation: the persister keeps a delete / send
   * answer for the conversation's project (runtime/approval-scope.ts), not for the one exact call the request's binding names. */
  kind?: string;
  chatId?: string;
}
export type CapabilityGrantPersistenceResult =
  | { ok: true; id: number }
  | { ok: false; code?: string };
export type CapabilityGrantPersister = (grant: AlwaysAllowGrant) => CapabilityGrantPersistenceResult;

let capabilityGrantPersister: CapabilityGrantPersister | null = null;
/** Does a saved "always allow" cover this open card right now? Injected with the persister (this file knows no store). */
let alwaysAllowedNow: ((request: ToolApprovalRequestEvent) => boolean) | null = null;
export function setAlwaysAllowedReader(reader: ((request: ToolApprovalRequestEvent) => boolean) | null): void { alwaysAllowedNow = reader; }

export function setCapabilityGrantPersister(persister: CapabilityGrantPersister | null): void {
  capabilityGrantPersister = persister;
}

function persistAlwaysGrant(request: ToolApprovalRequest): ToolApprovalDurableConsentReceipt {
  if (!request.consentBinding) {
    return { status: "unavailable", code: "missing-binding" };
  }
  if (!capabilityGrantPersister) {
    return { status: "unavailable", code: "missing-persister" };
  }
  try {
    const result = capabilityGrantPersister({
      capability: `tool:${request.tool}`,
      // Exact resource identity is carried by the Main-owned binding.  Do not
      // generalize the detail into a wildcard: a later command must match the
      // same credential/resource digest and permission level.
      pattern: request.consentBinding.credentialResourceIdentity,
      scope: "consent:v1",
      tool: request.tool,
      consentBinding: request.consentBinding,
      ...(request.capability ? { kind: request.capability } : {}),
      ...(request.chatId ? { chatId: request.chatId } : {}),
    });
    if (!result?.ok) return { status: "failed", code: "storage-failure" };
    if (!Number.isInteger(result.id) || result.id <= 0) {
      return { status: "failed", code: "storage-receipt-missing" };
    }
    return { status: "persisted" };
  } catch {
    // The current invocation may still proceed as the user's explicit choice,
    // but the receipt keeps the durable failure visible to the UI and caller.
    return { status: "failed", code: "storage-failure" };
  }
}

/*
 * ── 영속 승인 장부 훅 ────────────────────────────────────────────────────
 * live 결정은 Main 이 주입한 장부(SQLite)에 **먼저** 기록되고, 그다음에 기다리던 실행이 듣는다.
 * 그래서 화면·폰이 응답을 잃거나 앱이 다시 떠도 같은 요청 id 로 실제 결정을 다시 읽는다.
 * 허용은 실행에 넘기기 직전에 장부에서 다시 꺼내며(consume) 그때 이 요청이 아직 살아 있는지를
 * 다시 본다 — 취소된 실행이나 이전 앱 세대의 결정은 허용이 되지 않는다(I07).
 * 장부에 남은 결정은 표시 근거일 뿐, 죽은 실행의 허용을 새 실행에 넘기지 않는다.
 * 장부가 없거나 기록에 실패하면 예전처럼 이 프로세스 안에서만 기다린다(승인이 막히지 않는다).
 */
export interface ToolApprovalLedger {
  persist(request: ToolApprovalRequest): void;
  decide(id: string, decision: ToolApprovalDecision, actionId: string,
    assertCurrent: (request: ToolApprovalRequest) => void, via?: ToolApprovalVia): ToolApprovalResolutionReceipt;
  /** BB-1a: one settled row for a delete / send call that went through with no card. False when the ledger refuses it (any other kind, no conversation). */
  recordAuto?(event: { runtime: string; tool: string; detail?: string; cwd?: string; chatId: string; capability: string; agentId?: string }, basis: ToolApprovalAutoBasis): boolean;
  /** BB-1a: names the device of an answer a host-held request got (only a resolved row with no device yet). */
  markHandler?(id: string, via: "desktop" | "phone"): boolean;
  consume(id: string, assertCurrent: (request: ToolApprovalRequest) => void):
    { decision: ToolApprovalDecision; decidedAt: string } | null;
  cancel(id: string): void;
  recordConsent(id: string, receipt: ToolApprovalDurableConsentReceipt): void;
  get(id: string): ToolApprovalResolutionReceipt;
  /** The answered or closed cards of these conversations (oldest first); a read of the ledger's own rows. */
  settled?(chatIds: readonly string[]): SettledToolApproval[];
}

let toolApprovalLedger: ToolApprovalLedger | null = null;

/** BB-1a: where a decision came from, written on the settled row: the owner's device, or (for the cards one "always allow" closes together) the saved rule. */
export type ToolApprovalVia = "desktop" | "phone" | "always_allow";
/** BB-1a: why a call went through with no card. `unattended` (BB-1c): a run with nobody to ask (no person is attending it) let a delete / send call through in write mode, as it always did. */
export type ToolApprovalAutoBasis = "always_allow" | "full_access" | "unattended";

/**
 * BB-1a: the one place a card-less pass is recorded. The host policy (host-tool-permission-policy.ts, the one arbiter every runtime, the local tool loop, the MCP proxy and the room teammates go through)
 * calls this where a saved "always allow" or full access let a delete / send call run without a card. A payment is never recorded here because it never passes without one; a call of no
 * kind, and a call with no conversation, are not recorded (no row per ordinary tool call). A record, never a gate: nothing here can change the decision, and a failing ledger changes nothing.
 */
export function recordAutoApprovedToolCall(input: { runtime: string; tool: string; detail?: string; cwd?: string; chatId?: string; capability: string; agentId?: string }, basis: ToolApprovalAutoBasis): void {
  if ((input.capability !== "delete" && input.capability !== "send") || !input.chatId) return;
  try { toolApprovalLedger?.recordAuto?.({ runtime: input.runtime, tool: input.tool, ...(input.detail ? { detail: input.detail } : {}), ...(input.cwd ? { cwd: input.cwd } : {}), chatId: input.chatId, capability: input.capability, ...(input.agentId ? { agentId: input.agentId } : {}) }, basis); } catch { /* the record is a courtesy */ }
}
/** BB-1a: the device of an answer the host holding the request gave back (the background service's approvals). No effect on the decision. */
export function noteToolApprovalHandler(id: string, via: "desktop" | "phone"): void {
  try { toolApprovalLedger?.markHandler?.(id, via); } catch { /* the record is a courtesy */ }
}

/** The answered or closed cards of these conversations; nothing when no ledger is installed (the line is a record, never a gate). */
export function listSettledToolApprovals(chatIds: readonly string[]): SettledToolApproval[] {
  try { return toolApprovalLedger?.settled?.(chatIds) ?? []; } catch { return []; }
}

export function setToolApprovalLedger(ledger: ToolApprovalLedger | null): void {
  toolApprovalLedger = ledger;
}

/**
 * Why the arbiter wrapper answered "deny" for an ask without any policy decision. Every such path used to be
 * silent (production 1.3.5/1.3.7: a native-provenance fault refused every full-access tool call and left no trace).
 * The code is a closed machine token, never an error message, so it is safe to show the model and the run record.
 */
const arbiterFaults = new WeakMap<object, string>();
export function toolApprovalFaultCode(ask: object): string | undefined { return arbiterFaults.get(ask); }

/**
 * Asks the arbiter answered "deny" because the owner's card expired unanswered (5 minutes, requestToolApproval), not
 * because the owner refused. Callers that remember a refusal (the room's access cards, borrowed-task-force.ts) read this
 * so an unanswered card never counts as the owner's "no" (W7 S-room-owner-folder, 2026-10-16).
 */
const expiredAsks = new WeakSet<object>();
export function markToolApprovalExpired(ask: object): void { expiredAsks.add(ask); }
export function toolApprovalExpired(ask: object): boolean { return expiredAsks.has(ask); }
/**
 * Why a call the approval rule asks about (money, delete, sending out) ended without a "yes": the owner said no, nobody answered
 * the card, or the run has nobody to ask. Written by the arbiter on the ask it refused; the surfaces that return text to the model
 * (MCP proxy, the in-process tool loop) add approvalRefusalResultText() to the refused result so the model can choose what to do
 * next instead of repeating the call (item 5).
 */
const refusedAsks = new WeakMap<object, ApprovalRefusal>();
export function markToolApprovalRefusal(ask: object, refusal: ApprovalRefusal): void { refusedAsks.set(ask, refusal); }
export function toolApprovalRefusal(ask: object): ApprovalRefusal | undefined { return refusedAsks.get(ask); }
/** The one model-facing line for a refused ask ("" when the rule did not refuse it): the registered module, rendered from typed host data. */
export function toolApprovalRefusalText(ask: object): string {
  const refusal = refusedAsks.get(ask);
  if (!refusal) return "";
  registerDeclaredPromptModule(APPROVAL_REFUSAL_RESULT_MODULE);
  return approvalRefusalResultText(refusal);
}
function faultCodeOf(error: unknown): string {
  // Only an identifier-shaped code or message is passed on; free text (paths, ids) never leaves the process.
  for (const raw of [(error as { code?: unknown } | null)?.code, (error as { message?: unknown } | null)?.message]) {
    if (typeof raw === "string" && /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(raw)) return raw.toLowerCase();
  }
  return "arbiter_threw";
}
function refuseAsFault(ask: RuntimeToolPermissionAsk, code: string): "deny" {
  arbiterFaults.set(ask, code);
  console.warn("[tool-approval] ask refused by a fault, not by a policy decision", JSON.stringify({ code, tool: ask.tool, runtime: ask.runtime, permission: ask.permission ?? null }));
  return "deny";
}

export function getRuntimeToolPermissionArbiter(): RuntimeToolPermissionArbiter | null {
  if (!runtimeToolPermissionArbiter && runtimeToolPermissionRelays.size === 0) return null;
  return async (ask) => {
    if ((ask.planMode && ask.mutating) || ask.signal?.aborted) return "deny";
    try {
      let selected: RuntimeToolPermissionArbiter | undefined;
      for (const select of runtimeToolPermissionRelays) {
        const claimed = select(ask);
        if (claimed === undefined) continue;
        if (selected || typeof claimed !== "function") return refuseAsFault(ask, "relay_claim_conflict");
        selected = claimed;
      }
      const arbiter = selected ?? runtimeToolPermissionArbiter;
      if (!arbiter) return refuseAsFault(ask, "arbiter_missing");
      const decision = await withNativeApprovalAsk(ask.signal, () => arbiter(ask));
      if (ask.signal?.aborted) return "deny";
      return decision === "allow_once" || decision === "allow_session" ? decision : "deny";
    } catch (error) { return refuseAsFault(ask, faultCodeOf(error)); }
  };
}

/**
 * 중재자가 없을 때의 보수적 기본값 — ACP 경로가 오래 써 온 규칙과 **같은** 문장이다.
 * read 실행에서 바깥을 바꾸는 호출은 거부하고, 나머지는 허용한다. 중재자가 던지면
 * 이 함수를 부르지 말고 곧장 deny 다(실패가 허용으로 바뀌면 안 된다).
 */
export function defaultRuntimeToolPermission(
  ask: Pick<RuntimeToolPermissionAsk, "permission" | "mutating" | "planMode">,
): RuntimeToolPermissionDecision {
  if (ask.planMode && ask.mutating) return "deny";
  const readOnly = ask.permission === "read" || ask.permission === undefined;
  return readOnly && ask.mutating ? "deny" : "allow_once";
}

export type { ToolApprovalDecision };

export interface ToolApprovalOutcome {
  decision: ToolApprovalDecision;
  decidedAt: string;
  /** "expired": nobody answered the card before it closed. A deny for the run, never the owner's answer. */
  reason?: "expired" | "row_refused";
  durableConsent?: ToolApprovalDurableConsentReceipt;
}

type ApprovalWaiter = {
  sessionKey: string;
  resolve: (outcome: ToolApprovalOutcome) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
};
type Pending = {
  request: ToolApprovalRequest;
  /** Absent for a remote question (it has no clock). */
  timer?: NodeJS.Timeout;
  /** A question of a Work handed over by a hand-off row (requestRemoteToolApproval). */
  remote?: { row: RemoteAsk; kind: AskKind; /** a local click is being taken to the row first */ answering?: true; /** the row's answer (or the fallback) is settling this card: do not go to the row again */ settling?: true; closeWhy?: CloseWhy };
  waiters: Set<ApprovalWaiter>;
  dedupeKey: string;
  /** The Main ledger holds this request, so its decision is committed there before any waiter hears it. */
  durable?: true;
};

const pending = new Map<string, Pending>();
const pendingByKey = new Map<string, string>();
let moneyCallSeq = 0;
const sessionGrants = new Map<string, Set<string>>();
const listeners = new Set<(request: ToolApprovalRequest) => void>();
const resolvedListeners = new Set<(id: string, outcome: ToolApprovalOutcome) => void>();
type ResolutionRecord = {
  requestId: string;
  decision: ToolApprovalDecision;
  actionId: string | null;
  status: "resolved" | "expired";
  decidedAt: string;
  durableConsent?: ToolApprovalDurableConsentReceipt;
};
const resolutions = new Map<string, ResolutionRecord>();
const RESOLUTION_LIMIT = 500;

function rememberResolution(record: ResolutionRecord): void {
  // Refresh insertion order when an exact replay finds the same request.
  resolutions.delete(record.requestId);
  resolutions.set(record.requestId, record);
  while (resolutions.size > RESOLUTION_LIMIT) {
    const oldest = resolutions.keys().next();
    if (oldest.done) break;
    resolutions.delete(oldest.value);
  }
}

function resolutionReceipt(
  record: ResolutionRecord,
  requestedDecision: ToolApprovalDecision | null,
  status: "resolved" | "replayed" | "expired" | "conflict",
): ToolApprovalResolutionReceipt {
  return {
    ok: status === "resolved" || status === "replayed",
    receiptVersion: 1,
    requestId: record.requestId,
    requestedDecision,
    resolvedDecision: record.decision,
    actionId: record.actionId,
    status,
    pending: false,
    decidedAt: record.decidedAt,
    ...(record.durableConsent ? { durableConsent: record.durableConsent } : {}),
  };
}

function unresolvedReceipt(
  requestId: string,
  requestedDecision: ToolApprovalDecision | null,
  status: "pending" | "not_found" | "invalid_action",
): ToolApprovalResolutionReceipt {
  return {
    ok: false,
    receiptVersion: 1,
    requestId,
    requestedDecision,
    resolvedDecision: null,
    actionId: null,
    status,
    pending: status === "pending",
    decidedAt: null,
  };
}

/** 같은 도구·대상을 한 세션에서 다시 묻지 않기 위한 키. */
function grantKey(request: Pick<ToolApprovalRequest, "tool" | "detail" | "consentBinding" | "capability">): string {
  // A delete / sending-out card asks about the TOOL ("for this task" keeps the tool quiet for the task, whatever the file or recipient).
  if (request.capability === "delete" || request.capability === "send") return `approval-rule::${request.capability}::${request.tool}`;
  const resource = request.detail ? `${request.tool}::${request.detail}` : request.tool;
  const binding = consentBindingKey(request.consentBinding);
  return binding ? `${resource}::${binding}` : resource;
}

function consentBindingKey(binding: ToolApprovalConsentBinding | undefined): string | null {
  if (!binding) return null;
  return [
    binding.userIdentity,
    binding.workspaceIdentity,
    binding.requesterIdentity,
    binding.credentialResourceIdentity,
    binding.permissionScope,
  ].join("\u0000");
}

/**
 * A pending request is a UI resource as well as a promise.  Requests with the
 * same exact binding in one visible chat share one card; unrelated chats keep
 * separate cards so the answer is shown where the user can see it.
 */
function approvalDedupeKey(
  sessionKey: string,
  request: Pick<ToolApprovalRequest, "tool" | "detail" | "chatId" | "consentBinding">,
): string {
  const binding = consentBindingKey(request.consentBinding);
  // The detail is part of the key: a broad binding (a tool asked about as a whole) must not let a second, different call join the first one's card.
  if (binding) return `binding\u0000${request.chatId ?? ""}\u0000${binding}\u0000${request.detail ?? ""}`;
  return `session\u0000${sessionKey}\u0000${grantKey(request)}`;
}

function settleApproval(
  request: ToolApprovalRequest,
  sessionKeys: Iterable<string>,
  outcome: ToolApprovalOutcome,
): ToolApprovalOutcome {
  // Money (a payment or a transfer) is asked every time: an "always" or "for this task" answer from any surface (the phone shows all
  // four buttons) is taken as "this once" and nothing is remembered (decision, runtime/approval-rule.ts).
  if (request.capability === "money" && (outcome.decision === "allow_session" || outcome.decision === "allow_always")) {
    outcome = { ...outcome, decision: "allow_once" };
  }
  for (const sessionKey of sessionKeys) {
    if (outcome.decision === "allow_session") {
      rememberSessionGrant(sessionKey, request);
    }
  }
  if (outcome.decision !== "allow_always") return outcome;
  return { ...outcome, durableConsent: persistAlwaysGrant(request) };
}

export function onToolApprovalRequested(fn: (request: ToolApprovalRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onToolApprovalResolved(fn: (id: string, outcome: ToolApprovalOutcome) => void): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}

export function listPendingToolApprovals(): ToolApprovalRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}

/** 세션 단위 허용이 이미 있는가. live 요청은 이걸 먼저 본다. */
export function hasSessionGrant(
  sessionKey: string,
  request: Pick<ToolApprovalRequest, "tool" | "detail" | "consentBinding" | "capability">,
): boolean {
  return sessionGrants.get(sessionKey)?.has(grantKey(request)) === true;
}

function rememberSessionGrant(sessionKey: string, request: ToolApprovalRequest): void {
  const set = sessionGrants.get(sessionKey) ?? new Set<string>();
  set.add(grantKey(request));
  sessionGrants.set(sessionKey, set);
}

export function clearSessionGrants(sessionKey: string): void {
  sessionGrants.delete(sessionKey);
}

/**
 * live 승인 요청 — 사용자의 답을 실제로 기다린다.
 *
 * 아무도 답하지 않으면 `deny`로 닫는다. **열어둔 채 실행을 매달아 두지 않는다** —
 * 이 제품에서 "끝나지 않는 실행"은 이미 한 번 비싼 대가를 치른 실패 모양이다.
 */
function detachPending(entry: Pending): void {
  clearTimeout(entry.timer);
  pending.delete(entry.request.id);
  if (pendingByKey.get(entry.dedupeKey) === entry.request.id) pendingByKey.delete(entry.dedupeKey);
}

/*
 * 승인 카드가 "아무도 안 눌러서" 닫힌 것을 폰이 말할 수 있게 짧게 기억한다 (Agentlas 2.0 desktop values S3 ⑤, 짝 시험대 2차).
 * 전에는 5분이 지나면 데스크탑 칩과 폰 카드가 말없이 사라졌다(폰의 "만료" 안내는 폰 시계가 expiresAt 을 지났을 때만 나온다 —
 * 폰 시계가 조금 느리면 안내 없이 사라진다). 그래서 시간 초과로 닫힌 카드의 id만(요청 본문은 버린다) 최근 것 몇 개를 메모리에 둔다.
 * 취소(실행이 멈춰 대기자가 모두 빠진 경우)는 시간 초과가 아니므로 넣지 않는다.
 * 크기: 8개 상한(정한 값 — 근거 없음: 한 컴퓨터에서 동시에 열리는 승인 카드는 한두 장이며, 넘치면 가장 오래된 것부터 잊는다 — 닿으면 그 폰은 지금과 같이
 * 시계 규칙으로 안내한다). 유지 시간 2분(정한 값 — 근거 없음: 폰이 끊겼다 바로 붙는 사이를 덮는다. 닿으면 폰의 시계 규칙으로 돌아간다 — 5분 뒤 폰은 어차피 expiresAt 을 지났다).
 * 파일·DB에 쓰지 않는다(재시작하면 비어 있고, 그 사이 폰은 시계 규칙을 쓴다).
 */
const EXPIRED_APPROVAL_MEMORY_MAX = 8;
const EXPIRED_APPROVAL_MEMORY_MS = 2 * 60_000;
const recentlyExpired: Array<{ id: string; at: number }> = [];

/** 시간이 지나 거절된 카드의 id (최근 2분, 최대 8개, 오래된 것부터). 폰 snapshot 의 `expiredToolApprovals` 가 읽는다. */
export function listRecentlyExpiredToolApprovalIds(now: number = Date.now()): string[] {
  while (recentlyExpired.length && now - recentlyExpired[0].at > EXPIRED_APPROVAL_MEMORY_MS) recentlyExpired.shift();
  return recentlyExpired.map((row) => row.id);
}

/**
 * L1 D6 (contracts/phone-long-ops.md 6): the background service (daemon) holds a card this process shows to the phone. When the daemon closes it because
 * nobody answered, the daemon's `invocation.approval.resolved` notice says so with `expiredByTimeout: true` and this process puts the id in the SAME memory
 * (8 ids, 2 minutes - no new value) so the snapshot's `expiredToolApprovals` names it. A cancel carries no such flag and is not put here.
 */
export function noteToolApprovalExpiredByTimeout(id: string, now: number = Date.now()): void {
  if (typeof id !== "string" || !id || id.length > 256) return;
  listRecentlyExpiredToolApprovalIds(now);
  if (recentlyExpired.some((row) => row.id === id)) return;
  recentlyExpired.push({ id, at: now });
  while (recentlyExpired.length > EXPIRED_APPROVAL_MEMORY_MAX) recentlyExpired.shift();
}

/**
 * R3-3: where a request that closed unanswered is kept in the conversation (runtime/approval-closure-notice.ts). Injected by the host that
 * installs the durable ledger (host-tool-permission-policy.ts), so this module stays free of the store. A failing recorder changes nothing.
 */
let closureRecorder: ((closure: { requestId: string; chatId: string | undefined; reason: "timed_out" | "cancelled"; at: string }) => void) | null = null;
export function setApprovalClosureRecorder(fn: typeof closureRecorder): void { closureRecorder = fn; }

function expirePending(entry: Pending, byTimeout = false): void {
  if (pending.get(entry.request.id) !== entry) return;
  detachPending(entry);
  // A remote question that ends with no person's answer is closed on the row, so the other screens read "request cancelled" (the row keeps no clock of its own).
  if (entry.remote && !entry.remote.settling) closeRemoteQuestion(entry, entry.remote.closeWhy ?? (byTimeout ? "timeout" : "work_stopped"));
  try { closureRecorder?.({ requestId: entry.request.id, chatId: entry.request.chatId, reason: byTimeout ? "timed_out" : "cancelled", at: new Date().toISOString() }); } catch { /* the record is a courtesy */ }
  if (byTimeout) {
    recentlyExpired.push({ id: entry.request.id, at: Date.now() });
    while (recentlyExpired.length > EXPIRED_APPROVAL_MEMORY_MAX) recentlyExpired.shift();
  }
  if (entry.durable) {
    try { toolApprovalLedger?.cancel(entry.request.id); } catch { /* the ledger's own expiry closes it */ }
  }
  const outcome: ToolApprovalOutcome = { decision: "deny", decidedAt: new Date().toISOString(), reason: "expired" };
  rememberResolution({ requestId: entry.request.id, decision: "deny", actionId: null,
    status: "expired", decidedAt: outcome.decidedAt });
  for (const waiter of entry.waiters) { waiter.cleanup(); waiter.resolve(outcome); }
  entry.waiters.clear();
  for (const fn of resolvedListeners) { try { fn(entry.request.id, outcome); } catch { /* UI cannot block settlement. */ } }
}

function joinApproval(entry: Pending, sessionKey: string, signal?: AbortSignal): Promise<ToolApprovalOutcome> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      if (!entry.waiters.delete(waiter)) return;
      waiter.cleanup();
      if (entry.remote) entry.remote.closeWhy = closeWhyOfAbort(signal?.reason);
      // Cancellation is not a user denial and cannot create a session/durable grant.
      reject(signal?.reason ?? new Error("tool_approval_cancelled"));
      if (!entry.waiters.size) expirePending(entry);
    };
    const waiter: ApprovalWaiter = { sessionKey, resolve, reject,
      cleanup: () => signal?.removeEventListener("abort", aborted) };
    entry.waiters.add(waiter);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export function requestToolApproval(
  input: Omit<ToolApprovalRequest, "id" | "requestedAt" | "expiresAt" | "mode"> & { sessionKey: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ToolApprovalOutcome> {
  const { sessionKey, timeoutMs = 5 * 60_000, signal, ...rest } = input;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("tool_approval_cancelled"));
  if (rest.capability !== "money" && hasSessionGrant(sessionKey, rest)) {
    return Promise.resolve({ decision: "allow_session", decidedAt: new Date().toISOString() });
  }
  // A money card belongs to ONE call (defect 2): two calls with the same recipient and amount are two payments, so a
  // single "yes" must not let both go. Its key is never shared; other cards keep merging a repeated request into one card.
  const dedupeKey = rest.capability === "money" ? `${approvalDedupeKey(sessionKey, rest)}\u0000money-call\u0000${++moneyCallSeq}` : approvalDedupeKey(sessionKey, rest);
  const existingId = pendingByKey.get(dedupeKey);
  if (existingId) {
    const existing = pending.get(existingId);
    if (existing) { assertNativeToolApprovalJoin(existing.request, signal); return waitingForPerson(joinApproval(existing, sessionKey, signal), signal && nativeApprovalSignalChain(signal)); }
    pendingByKey.delete(dedupeKey);
  }
  const requestedAt = new Date();
  const request: ToolApprovalRequest = {
    ...rest, id: `approval:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    ...(isAppWorkFolder(rest.cwd) ? { cwdIsAppFolder: true as const } : {}),
    mode: "live", requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + timeoutMs).toISOString(),
  };
  const entry: Pending = { request, dedupeKey, waiters: new Set(),
    timer: setTimeout(() => expirePending(entry, true), timeoutMs) };
  entry.timer?.unref?.();
  if (toolApprovalLedger && request.chatId) {
    try { toolApprovalLedger.persist(request); entry.durable = true; } catch { /* in-process only, as before */ }
  }
  try { stampNativeToolApproval(request, signal, toolApprovalLedger); }
  catch (error) { clearTimeout(entry.timer); if (entry.durable) { try { toolApprovalLedger?.cancel(request.id); } catch {} } throw error; }
  pending.set(request.id, entry);
  pendingByKey.set(dedupeKey, request.id);
  const promise = joinApproval(entry, sessionKey, signal);
  // N0b: the card is shown and a person decides - this turn's run slot is let go meanwhile and taken again with the answer.
  const waiting = waitingForPerson(promise, signal && nativeApprovalSignalChain(signal));
  if (pending.get(request.id) === entry) {
    for (const fn of listeners) { try { fn(request); } catch { /* UI cannot block settlement. */ } }
  }
  return waiting;
}


/*
 * ── 원격 물음 ───────────────────────────────────────────────────────────────
 * 다른 기기에서 맡긴 일(행)의 돈·삭제·전송 물음. 물음 = 이 요청 id(qid) 하나. 행이 정본이다:
 *   - 먼저 행에 올린다(`ask`): `allowed`(그 업무 동안 허용한 종류)면 카드 없이 지나가고, `refused`(행이 끝남)면 거절, `asked`면 이 데스크탑에도 같은 카드를 띄운다.
 *   - 시계 없음: 타이머를 걸지 않는다(Infinity 는 Node 에서 1ms 가 되므로 값을 넘기지 않고 가지를 따로 둔다). 끝내는 것은 답, 실행이 멈춤(abort), 훅·MCP 선이 끊김(`closed`)뿐이다.
 *   - 저장된 "항상 허용"·세션 허용은 읽지도 쓰지도 않는다. "이 업무 동안"은 행의 taskAllow 하나뿐이다(allow_task 는 삭제·전송만).
 *   - 이 화면의 클릭도 행에 먼저 쓰고, 행이 돌려준 첫 답으로 카드를 닫는다. 행에 못 닿으면 이 화면의 답으로 닫고 `close{answered_here}`.
 * 장부(SQLite)에는 만료를 7일로 적는다 - 사용자 시계가 아니라 낡은 행을 치우는 상한이다(HARD-LIMITS-20261117.md).
 */
const REMOTE_LEDGER_CEILING_MS = 7 * 24 * 3_600_000;
const REMOTE_TARGET_CHARS = 200;
const REMOTE_PREVIEW_CHARS = 2000;
/** The reason of an abort that comes from the wire a CLI's hook or MCP proxy asked on (its time ran out, or the CLI let go): the question closes as `timeout`. Any other abort is the run being stopped. */
export function approvalWireClosedReason(): Error { return new DOMException("approval_wire_closed", "AbortError"); }   // still an AbortError for every reader of the reason; only its message names the wire
function closeWhyOfAbort(reason: unknown): CloseWhy { return reason instanceof Error && reason.message === "approval_wire_closed" ? "timeout" : "work_stopped"; }
const decisionOfAnswer = (answer: AskAnswer): ToolApprovalDecision => (answer === "deny" ? "deny" : "allow_once");
const answerOfDecision = (decision: ToolApprovalDecision, kind: AskKind): AskAnswer =>
  decision === "deny" ? "deny" : decision === "allow_session" && kind !== "money" ? "allow_task" : "allow";

function closeRemoteQuestion(entry: Pending, why: CloseWhy, answer?: AskAnswer): void {
  if (!entry.remote) return;
  try { pluralRowAsker()?.close(entry.remote.row, entry.request.id, why, answer); } catch { /* the receiver repeats a close it could not send */ }
}

function remoteLocalAnswer(entry: Pending, decision: ToolApprovalDecision, via?: ToolApprovalVia): ToolApprovalResolutionReceipt {
  const id = entry.request.id, remote = entry.remote!;
  if (remote.answering) return unresolvedReceipt(id, decision, "pending");
  const mine = answerOfDecision(decision, remote.kind);
  remote.answering = true;
  const settle = (answer: AskAnswer, unreachable: boolean): void => {
    if (pending.get(id) !== entry) return;
    if (unreachable) closeRemoteQuestion(entry, "answered_here", answer);
    remote.settling = true;
    try { resolveToolApproval(id, decisionOfAnswer(answer), undefined, via); } finally {
      // a decision the ledger could not commit leaves the card open: it may be answered again
      if (pending.get(id) === entry) { delete remote.settling; delete remote.answering; }
    }
  };
  const asker = pluralRowAsker();
  if (!asker) queueMicrotask(() => settle(mine, true));
  else void asker.answer(remote.row, id, mine).then((first) => settle(first ?? mine, first === null), () => settle(mine, true));
  return unresolvedReceipt(id, decision, "pending");
}

/** The row's answer reached this process (the receiver reads it from `held[].approvals`): close the card with it, without asking the row again. null = no such open remote question here. */
export function resolveRemoteApprovalFromRow(id: string, answer: AskAnswer): ToolApprovalResolutionReceipt | null {
  const entry = pending.get(id);
  if (!entry?.remote) return null;
  entry.remote.settling = true;
  try { return resolveToolApproval(id, decisionOfAnswer(answer), undefined, "desktop"); } finally { if (pending.get(id) === entry) { delete entry.remote.settling; delete entry.remote.answering; } }
}

/** The row closed the question without an answer (ended, gone, answered elsewhere and over) or the runtime refused after the card opened: the card closes, the run gets a refusal. */
export function closeRemoteApproval(id: string, why: CloseWhy): boolean {
  const entry = pending.get(id);
  if (!entry?.remote) return false;
  entry.remote.closeWhy = why;
  expirePending(entry);
  return true;
}

/** Is this request a remote question still open here? (D's card and the bridge read the request's own `remoteAsk`; this is for the receiver.) */
export function isRemoteApprovalOpen(id: string): boolean { return pending.get(id)?.remote !== undefined; }

export type RemoteApprovalInput = Omit<ToolApprovalRequest, "id" | "requestedAt" | "expiresAt" | "mode" | "remoteAsk" | "taskAllowOffered" | "preview" | "capability">
  & { sessionKey: string; signal?: AbortSignal; closed?: AbortSignal; kind: AskKind; remote: RemoteAsk; target: string; preview?: string };

export async function requestRemoteToolApproval(input: RemoteApprovalInput): Promise<ToolApprovalOutcome> {
  const { sessionKey, signal, closed, kind, remote, target, preview, ...rest } = input;
  if (signal?.aborted) throw (signal.reason ?? new Error("tool_approval_cancelled"));
  const asker = pluralRowAsker();
  const refused = (): ToolApprovalOutcome => ({ decision: "deny", decidedAt: new Date().toISOString(), reason: "row_refused" });
  if (!asker) return refused();   // nobody can be asked from this process: the Work does not wait on a card the sender never sees
  const requestedAt = new Date();
  const id = `approval:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  const question = { qid: id, kind, target: redactSecrets(target).slice(0, REMOTE_TARGET_CHARS), ...(kind === "send" && preview ? { preview: redactSecrets(preview).slice(0, REMOTE_PREVIEW_CHARS) } : {}) };
  let verdict: "asked" | "allowed" | "refused";
  try { verdict = await asker.ask(remote, question); } catch { verdict = "refused"; }
  if (verdict === "allowed") return { decision: "allow_once", decidedAt: new Date().toISOString() };
  if (verdict === "refused") { try { asker.close(remote, id, "work_stopped"); } catch { /* nothing was kept */ } return refused(); }
  const request: ToolApprovalRequest = {
    ...rest, id, capability: kind, mode: "live", requestedAt: requestedAt.toISOString(),
    ...(isAppWorkFolder(rest.cwd) ? { cwdIsAppFolder: true as const } : {}),
    remoteAsk: { rowId: remote.rowId, fromName: remote.fromName, askVia: "row" },
    ...(kind !== "money" ? { taskAllowOffered: true as const } : {}),
    ...(question.preview ? { preview: question.preview } : {}),
  };
  const entry: Pending = { request, dedupeKey: `remote\u0000${id}`, waiters: new Set(), remote: { row: remote, kind } };
  if (toolApprovalLedger && request.chatId) {
    try { toolApprovalLedger.persist({ ...request, expiresAt: new Date(requestedAt.getTime() + REMOTE_LEDGER_CEILING_MS).toISOString() }); entry.durable = true; } catch { /* in-process only */ }
  }
  try { stampNativeToolApproval(request, signal, toolApprovalLedger); }
  catch (error) {
    if (entry.durable) { try { toolApprovalLedger?.cancel(id); } catch { /* the ledger's own ceiling closes it */ } }
    try { asker.close(remote, id, "work_stopped"); } catch { /* nothing more to do */ }
    throw error;
  }
  pending.set(id, entry);
  pendingByKey.set(entry.dedupeKey, id);
  const promise = joinApproval(entry, sessionKey, signal);
  const waiting = waitingForPerson(promise, signal && nativeApprovalSignalChain(signal));
  const onClosed = (): void => { if (pending.get(id) === entry) { entry.remote!.closeWhy = "timeout"; expirePending(entry); } };
  if (closed) { if (closed.aborted) queueMicrotask(onClosed); else closed.addEventListener("abort", onClosed, { once: true }); }
  if (pending.get(id) === entry) {
    for (const fn of listeners) { try { fn(request); } catch { /* UI cannot block settlement. */ } }
  }
  return waiting;
}

/*
 * 고지한 post-denial 요청들 — 사용자의 선택("다음부터 허용")을 나중에 반영하려면 그
 * 요청이 어느 세션의 무엇이었는지 알아야 한다. live 요청과 달리 기다리는 실행이 없어서
 * pending 에는 남지 않는다.
 *
 * ★이 맵이 없을 때 "다음부터 허용"은 아무 일도 하지 않았다: 허용 저장이 live 경로의
 *   resolve 안에만 있었고, post-denial 은 그 경로를 지나지 않는다. 누를 수 있는데 아무
 *   효과가 없는 버튼은 선택이 아니라 거짓말이다.
 */
const announced = new Map<string, { request: ToolApprovalRequest; sessionKey?: string }>();
const announcedByKey = new Map<string, string>();
const ANNOUNCED_LIMIT = 200;

/**
 * post-denial 고지 — 이미 거부된 호출을 사용자에게 보이게만 한다.
 * 답을 기다리지 않는다(기다릴 대상이 없다). 선택은 다음 실행의 허용 범위에만 쓰인다.
 */
export function announceToolDenied(
  input: Omit<ToolApprovalRequest, "id" | "requestedAt" | "expiresAt" | "mode"> & { sessionKey?: string; signal?: AbortSignal },
): ToolApprovalRequest {
  const { sessionKey, signal, ...rest } = input;
  const dedupeKey = approvalDedupeKey(sessionKey ?? "", rest);
  const existingId = announcedByKey.get(dedupeKey);
  if (existingId) {
    const existing = announced.get(existingId);
    if (existing) return existing.request;
    announcedByKey.delete(dedupeKey);
  }
  const request: ToolApprovalRequest = {
    ...rest,
    id: `denied:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    mode: "post-denial",
    requestedAt: new Date().toISOString(),
  };
  stampNativeDeniedApproval(request, signal, toolApprovalLedger);
  announced.set(request.id, { request, sessionKey });
  announcedByKey.set(dedupeKey, request.id);
  // 오래된 고지부터 버린다 — 삽입 순서가 곧 시간 순서다.
  while (announced.size > ANNOUNCED_LIMIT) {
    const oldest = announced.keys().next();
    if (oldest.done) break;
    const old = announced.get(oldest.value);
    announced.delete(oldest.value);
    if (old) {
      const oldKey = approvalDedupeKey(old.sessionKey ?? "", old.request);
      if (announcedByKey.get(oldKey) === oldest.value) announcedByKey.delete(oldKey);
    }
  }
  for (const fn of listeners) { try { fn(request); } catch { /* 같은 이유 */ } }
  return request;
}

/** A decision this process no longer holds in memory (an earlier app run, or an evicted record) read back from the ledger. */
function ledgerResolution(id: string): ResolutionRecord | undefined {
  if (!toolApprovalLedger) return undefined;
  let receipt: ToolApprovalResolutionReceipt;
  try { receipt = toolApprovalLedger.get(id); } catch { return undefined; }
  if (receipt.status === "not_found" || receipt.status === "pending" || !receipt.resolvedDecision || !receipt.decidedAt) return undefined;
  const record: ResolutionRecord = {
    requestId: id,
    decision: receipt.resolvedDecision,
    actionId: receipt.actionId,
    status: receipt.status === "expired" ? "expired" : "resolved",
    decidedAt: receipt.decidedAt,
    ...(receipt.durableConsent ? { durableConsent: receipt.durableConsent } : {}),
  };
  rememberResolution(record);
  return record;
}

/**
 * Commits the owner's decision to the ledger before any waiter hears it, and takes an allow back out
 * only while the request is still current. Returns a receipt to answer with instead of settling, or
 * null to settle normally. A deny always settles — refusing is safe even when the ledger cannot write.
 */
function commitDurableDecision(entry: Pending, decision: ToolApprovalDecision, actionId: string, via?: ToolApprovalVia): ToolApprovalResolutionReceipt | null {
  const ledger = toolApprovalLedger as ToolApprovalLedger;
  const id = entry.request.id;
  const assertCurrent = () => {
    if (pending.get(id) !== entry || entry.waiters.size === 0) throw new Error("tool_approval_not_current");
  };
  let receipt: ToolApprovalResolutionReceipt;
  try {
    receipt = ledger.decide(id, decision, actionId, assertCurrent, via);
  } catch {
    // Not written: an allow stays pending so the owner can answer again; nothing has run.
    return decision === "deny" ? null : unresolvedReceipt(id, decision, "pending");
  }
  if (receipt.status === "expired") {
    expirePending(entry, true); // the ledger's clock ran out: time, not a cancellation
    return resolutionReceipt(resolutions.get(id) as ResolutionRecord, decision, "expired");
  }
  if (receipt.status !== "resolved") return decision === "deny" ? null : receipt;
  if (decision === "deny") return null;
  let consumed: { decision: ToolApprovalDecision; decidedAt: string } | null = null;
  try { consumed = ledger.consume(id, assertCurrent); } catch { consumed = null; }
  if (consumed?.decision === decision) return null;
  // Committed, but no longer current at the moment of use: the run gets a refusal, never the allow.
  expirePending(entry);
  return resolutionReceipt(resolutions.get(id) as ResolutionRecord, decision, "expired");
}

/**
 * 사용자의 선택을 반영하고 exact receipt를 남긴다. 응답이 유실된 renderer는 같은
 * actionId를 재전송하지 않고 getToolApprovalResolution으로 실제 결정을 확인한다.
 */
export function resolveToolApproval(
  id: string,
  decision: ToolApprovalDecision,
  actionId = toolApprovalActionId(id, decision),
  via?: ToolApprovalVia,
): ToolApprovalResolutionReceipt {
  if (actionId !== toolApprovalActionId(id, decision)) {
    return unresolvedReceipt(id, decision, "invalid_action");
  }

  // A request this run still holds goes through the live path, so a ledger-side expiry also releases its waiter.
  const prior = resolutions.get(id) ?? (pending.has(id) ? undefined : ledgerResolution(id));
  if (prior) {
    rememberResolution(prior);
    if (prior.status === "expired") {
      return resolutionReceipt(prior, decision, "expired");
    }
    return resolutionReceipt(
      prior,
      decision,
      prior.decision === decision ? "replayed" : "conflict",
    );
  }

  const entry = pending.get(id);
  // A remote question goes to the row first: the row's first answer is the answer, wherever the click was (plural-remote-ask.ts).
  if (entry?.remote && !entry.remote.settling) return remoteLocalAnswer(entry, decision, via);
  let outcome: ToolApprovalOutcome = { decision, decidedAt: new Date().toISOString() };
  if (entry) {
    if (entry.durable && toolApprovalLedger) {
      const committed = commitDurableDecision(entry, decision, actionId, via);
      if (committed) return committed;
    }
    detachPending(entry);
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) waiter.cleanup();
    outcome = settleApproval(entry.request, new Set(waiters.map(waiter => waiter.sessionKey)), outcome);
    if (entry.durable && outcome.durableConsent) {
      try { toolApprovalLedger?.recordConsent(id, outcome.durableConsent); } catch { /* the in-memory receipt still carries it */ }
    }
    for (const waiter of waiters) waiter.resolve(outcome);
    rememberResolution({
      requestId: id,
      decision: outcome.decision,
      actionId,
      status: "resolved",
      decidedAt: outcome.decidedAt,
      ...(outcome.durableConsent ? { durableConsent: outcome.durableConsent } : {}),
    });
    // "Always allow" was pressed and saved: the other cards open right now for the very same permission (the same tool asked by
    // other teammates at the same moment) are the question the owner just answered, so they close as allowed instead of waiting
    // to be pressed one by one (after "always allow" it is not asked again; T6).
    if (outcome.decision === "allow_always" && outcome.durableConsent?.status === "persisted" && alwaysAllowedNow) {
      const same = [...pending.values()].filter((other) => other.request.tool === entry.request.tool && other.request.capability === entry.request.capability);
      for (const other of same) {
        // Only where the answer just saved really covers that card (the same project): the stored rule is read, nothing is assumed.
        try { if (alwaysAllowedNow(other.request)) resolveToolApproval(other.request.id, "allow_once", undefined, "always_allow"); } catch { /* that card stays for the owner */ }
      }
    }
  } else if (announced.has(id)) {
    // 이미 거부된 호출이라 이번 실행은 되살릴 수 없다 — 그래서 이 선택이 뜻하는 바는
    // 오직 "다음부터는 묻지 말고 허용하라"이고, 그것만은 반드시 남아야 한다.
    const known = announced.get(id);
    if (decision === "allow_session" && known?.sessionKey && known.request.capability !== "money") {
      rememberSessionGrant(known.sessionKey, known.request);
    }
    if (known && decision === "allow_always" && known.request.capability !== "money") {
      outcome = {
        ...outcome,
        durableConsent: persistAlwaysGrant(known.request),
      };
    }
    if (known) {
      const knownKey = approvalDedupeKey(known.sessionKey ?? "", known.request);
      if (announcedByKey.get(knownKey) === id) announcedByKey.delete(knownKey);
      announced.delete(id);
    }
    rememberResolution({
      requestId: id,
      decision,
      actionId,
      status: "resolved",
      decidedAt: outcome.decidedAt,
      ...(outcome.durableConsent ? { durableConsent: outcome.durableConsent } : {}),
    });
  } else {
    return unresolvedReceipt(id, decision, "not_found");
  }
  for (const fn of resolvedListeners) { try { fn(id, outcome); } catch { /* 같은 이유 */ } }
  return resolutionReceipt(
    resolutions.get(id) as ResolutionRecord,
    decision,
    "resolved",
  );
}

/** Main의 live queue와 resolution ledger를 한 요청 id로 다시 읽는다. */
export function getToolApprovalResolution(id: string): ToolApprovalResolutionReceipt {
  const record = resolutions.get(id) ?? (pending.has(id) ? undefined : ledgerResolution(id));
  if (record) {
    return resolutionReceipt(
      record,
      null,
      record.status === "expired" ? "expired" : "resolved",
    );
  }
  return unresolvedReceipt(id, null, pending.has(id) ? "pending" : "not_found");
}

/**
 * 내장 도구(shared/builtin-tools.ts)의 승인 + 실행 — **한 벌**.
 *
 * ★로컬 루프(ollama·lmstudio·mlx)와 BYOK 가 각자 승인을 짜면, 한쪽이 관문을
 * 빠뜨렸을 때 그 런타임만 조용히 무방비가 된다. 이 파일이 이미 승인 정책의
 * 소유자이므로 실행까지 여기서 묶는다.
 *
 * 도구의 성격은 **알고 있는 것만** 싣는다: 내장 도구는 우리가 만들었으니
 * read/edit/execute 를 안다. 중재자가 던지면 거부다(fail-closed).
 */
export interface BuiltinApprovalContext {
  runtimeKind: string;
  sessionKey: string;
  permission: RuntimeToolPermissionAsk["permission"];
  cwd?: string;
  chatId?: string;
  consentBinding?: ToolApprovalConsentBinding;
  unattended: boolean;
  signal?: AbortSignal;
  /** Main-owned broker ledger hook. It receives the actual arbiter decision,
   * never a lossy allow/deny boolean. */
  onApprovalDecision?: (decision: RuntimeToolPermissionDecision) => void;
}

export async function runApprovedBuiltinTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BuiltinApprovalContext,
  events: { onTool?: (name: string, args?: string, result?: string, id?: string, isError?: boolean, artifactPaths?: readonly string[]) => void },
  callId: string,
): Promise<{ ok: boolean; content: string; artifactPaths?: readonly string[]; imageDataUrl?: string }> {
  const builtin = builtinToolByName(toolName);
  const kind = builtin
    ? builtin.minPerm === "read"
      ? ("read" as const)
      : builtin.name === "bash"
        ? ("execute" as const)
        : ("edit" as const)
    : ("other" as const);
  const ask: RuntimeToolPermissionAsk = {
    runtime: ctx.runtimeKind,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    sessionKey: ctx.sessionKey,
    tool: toolName,
    kind,
    cwd: ctx.cwd,
    permission: ctx.permission,
    mutating: kind !== "read",
    ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    ...(ctx.consentBinding ? { consentBinding: ctx.consentBinding } : {}),
    ...(ctx.unattended ? { unattended: true as const } : {}),
  };
  const arbiter = getRuntimeToolPermissionArbiter();
  let decision: RuntimeToolPermissionDecision;
  if (!arbiter) {
    decision = defaultRuntimeToolPermission(ask);
  } else {
    try {
      decision = await arbiter(ask);
    } catch {
      decision = "deny"; // 중재자 실패는 거부다 — 실패가 허용이 되면 관문이 아니다.
    }
  }
  ctx.onApprovalDecision?.(decision);
  if (decision === "deny") {
    const denied = `tool call denied — "${toolName}" was not approved for this run.`;
    events.onTool?.(toolName, JSON.stringify(args), denied, callId, true);
    return { ok: false, content: denied };
  }
  const outcome = await runBuiltinTool(toolName, args, {
    cwd: ctx.cwd ?? process.cwd(),
    permission: (ctx.permission ?? "read") as ToolPermission,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    askUser: (input) =>
      askUser(
        { ...input, askedBy: ctx.runtimeKind, ...(ctx.chatId ? { chatId: ctx.chatId } : {}) },
        { unattended: ctx.unattended, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      ),
  });
  events.onTool?.(toolName, JSON.stringify(args), outcome.content, callId, !outcome.ok, outcome.artifactPaths);
  return outcome;
}

/** Native daemon reply route only: retains actual pending object and provenance,
 * then delegates to the original ledger/permission resolver without fallback. */
export function resolveNativeToolApproval(request: ToolApprovalRequest, decision: ToolApprovalDecision, actionId: string): ToolApprovalResolutionReceipt {
  if (pending.get(request.id)?.request !== request && announced.get(request.id)?.request !== request) throw new Error("native_approval_original_pending_required");
  assertNativeToolApproval(request, toolApprovalLedger);
  return resolveToolApproval(request.id, decision, actionId);
}

/** Source-owned requests for a newly attached native observation stream. */
export function listNativeToolApprovalRequests(): ToolApprovalRequest[] {
  return [...pending.values(), ...announced.values()].map(entry => entry.request).filter(request => {
    try { return !!nativeToolApprovalOwner(request); } catch { return false; }
  });
}
