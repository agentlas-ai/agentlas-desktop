import { nativeApprovalActorSnapshot } from "./native-approval-provenance";
import { createHash } from "node:crypto";
import path from "node:path";
import { configuredIdentity } from "../install-identity";
import { getDb } from "../store/db";
import {
  capabilityAlwaysAllowResource,
  capabilityConsentScope,
  capabilityResourceIdentity,
  getCapabilityDecision,
  recordCapabilityGrant,
  removeSupersededAlwaysAllowRows,
} from "../store/capability-grants";
import { installDurableToolApprovalLedger } from "../one/supervisor-approval-ledger";
import { recordApprovalClosure } from "./approval-closure-notice";
import { mainToolConsentResource } from "./tool-consent";
import { NOT_OWNER_ANSWER_SOURCES, classifyApprovalAction, type ApprovalRefusalCause } from "./approval-rule";
import { scopedAlwaysAllowBinding } from "./approval-scope";
import {
  announceToolDenied,
  capabilityClassFor,
  markToolApprovalExpired,
  markToolApprovalRefusal,
  recordAutoApprovedToolCall,
  requestToolApproval,
  setAlwaysAllowedReader,
  setApprovalClosureRecorder,
  setCapabilityGrantPersister,
  setRuntimeToolPermissionArbiter,
  type CapabilityGrantPersister,
  type RuntimeToolPermissionArbiter,
} from "./tool-approval";
import type { ToolApprovalConsentBinding } from "../../shared/types";

/** Native host identity only. These callbacks never come from an invocation payload. */
export interface HostToolPermissionIdentityPorts {
  hostKind: "main" | "daemon";
  getAuthenticatedActorIds(): { workspaceId: string; userId: string } | null;
}

/** Closed dependency ports for deterministic native policy verification. */
export interface HostToolPermissionPolicyPorts extends HostToolPermissionIdentityPorts {
  configuredIdentity: typeof configuredIdentity;
  getCapabilityDecision: typeof getCapabilityDecision;
  recordCapabilityGrant: typeof recordCapabilityGrant;
  requestToolApproval: typeof requestToolApproval;
  announceToolDenied: typeof announceToolDenied;
  now?: () => number;
  /** The binding one "always allow" is kept under (approval-scope.ts: the project, else the conversation). Default: the store. */
  scopedAlwaysAllowBinding?: typeof scopedAlwaysAllowBinding;
}

const opaqueConsentIdentity = (label: string, value: string): string => {
    // Account ids, workspace paths, and agent names are native host-only material.
    // Approval events may cross into a renderer, so keep the binding exact but
    // value-free at that boundary and in the capability ledger.
    if (!value || value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`invalid capability consent ${label}`);
    }
    return `consent-id:v1:${label}:${createHash("sha256")
      .update(`agentlas-tool-consent-${label}-v1\u0000${value}`, "utf8")
      .digest("hex")}`;
  };

/** Exact existing actor/workspace consent calculation; no resource grant or effect. */
export function toolApprovalConsentActorBinding(
  request: { cwd?: string; chatId?: string },
  actor: { workspaceId: string; userId: string } | null,
  install = configuredIdentity(),
): Pick<ToolApprovalConsentBinding, "userIdentity" | "workspaceIdentity"> {
    // Keep the supplied path bytes intact before canonicalizing `.`/`..`.
    // Unix permits leading/trailing spaces in a directory name; trimming here
    // would let two distinct workspaces inherit the same durable consent.
    const rawWorkspace = request.cwd && request.cwd.length > 0
      ? path.resolve(request.cwd)
      : request.chatId
        ? `chat:${request.chatId}`
        : `desktop:${install?.userDataNamespace ?? "Agentlas"}`;
    const rawUser = actor
      ? `account:${actor.userId}`
      : `install:${install?.channel ?? "official"}:${install?.userDataNamespace ?? "Agentlas"}`;
    const rawWorkspaceIdentity = actor
      ? `account-workspace:${actor.workspaceId}|${rawWorkspace}`
      : rawWorkspace;
    return {
      userIdentity: opaqueConsentIdentity("user", rawUser),
      workspaceIdentity: opaqueConsentIdentity("workspace", rawWorkspaceIdentity),
    };
}

/** The same policy is installed as the base arbiter; private relays retain dispatch ownership. */
export function createHostToolPermissionPolicy(ports: HostToolPermissionPolicyPorts) {
  const { getAuthenticatedActorIds, configuredIdentity, getCapabilityDecision,
    recordCapabilityGrant, requestToolApproval, announceToolDenied } = ports;
  const now = ports.now ?? Date.now;
  const scopedBinding = ports.scopedAlwaysAllowBinding ?? scopedAlwaysAllowBinding;
  const recentUserDenials = new Map<string, number>();
  // Cards that expired unanswered: the same scope is not asked again in the TTL (no 5-minute wait per call while the
  // owner is away), but the refusal stays typed as an expiry, never as the owner's denial.
  const recentExpiries = new Map<string, number>();
  const USER_DENIAL_TTL_MS = 5 * 60_000;
  const denialKey = (ask: { sessionKey: string; tool: string; detail?: string }) => `${ask.sessionKey}\u0000${ask.tool}\u0000${mainToolConsentResource(ask) ?? ask.detail ?? ""}`;



  /**
   * The native host is the only authority that can mint a durable consent identity. The
   * account id comes from the authenticated session when available; unsigned
   * local work is isolated to this install's user-data namespace.  Workspace
   * includes the exact working folder (or chat fallback), while requester is
   * stable across runtime restarts and excludes the ephemeral session key.
   */
  const consentBindingForAsk = (ask: {
    runtime: string;
    tool: string;
    detail?: string;
    arguments?: unknown;
    cwd?: string;
    chatId?: string;
    agentId?: string;
    permission: "read" | "write" | "full" | undefined;
  }): ToolApprovalConsentBinding => {
    const scopedActor = nativeApprovalActorSnapshot();
    const actor = scopedActor ? scopedActor.actor : getAuthenticatedActorIds();
    const actorBinding = toolApprovalConsentActorBinding(ask, actor, configuredIdentity());
    const rawRequester = `runtime:${ask.runtime}|agent:${ask.agentId?.trim() || "default"}`;
    return {
      ...actorBinding,
      requesterIdentity: opaqueConsentIdentity("requester", rawRequester),
      credentialResourceIdentity: mainToolConsentResource(ask) ?? capabilityResourceIdentity(ask.tool, ask.detail, ask.arguments),
      permissionScope: ask.permission ?? "read",
    };
  };
  // ★한 벌뿐이다 — ACP 의 session/request_permission 과 우리 in-process 도구 루프
  // (ollama/lmstudio/mlx)가 **같은** 이 함수를 지난다. 정책을 두 벌 쓰면 갈라지고,
  // 갈라진 쪽은 반드시 "묻지 않고 실행"으로 기운다(local-tool-loop 이 실제로 그랬다).
  // "항상 허용" 칩의 영구 기록(capability_grants) — tool-approval.ts 는 store 를 모르므로
  // 여기서 주입한다(오너 결정 2026-08-20: 항상 허용은 다시는 묻지 않는다).
  // What one "always allow" on a delete / sending-out card covers: the project of the card's conversation
  // (the conversation itself when it has none), any agent. A card's own binding stays the exact one (account + folder + requester),
  // which other readers verify (the phone's original-account check): only the saved rule is widened to the project.
  // The server a call went to (defect 4) is part of what "always allow" keeps: the card is answered later than the call is
  // made, so the identity Main resolved for the call is remembered here, by the call's exact consent digest. Bounded; a call this
  // process no longer remembers (a card restored after a restart) is saved and read as "no server identity", which only asks again.
  const serverOfCall = new Map<string, string>();
  const SERVER_OF_CALL_MAX = 512;
  const callKey = (tool: string, chatId: string | undefined, binding: ToolApprovalConsentBinding | undefined) =>
    `${tool}\u0000${chatId ?? ""}\u0000${binding?.credentialResourceIdentity ?? ""}`;
  const rememberServerOfCall = (ask: { tool: string; chatId?: string; catalogId?: string | null }, binding: ToolApprovalConsentBinding) => {
    if (typeof ask.catalogId !== "string" || !ask.catalogId) return;
    const key = callKey(ask.tool, ask.chatId, binding);
    serverOfCall.delete(key);
    serverOfCall.set(key, ask.catalogId);
    while (serverOfCall.size > SERVER_OF_CALL_MAX) { const oldest = serverOfCall.keys().next(); if (oldest.done) break; serverOfCall.delete(oldest.value); }
  };
  const serverOfRequest = (request: { tool: string; chatId?: string; consentBinding?: ToolApprovalConsentBinding }): string | null =>
    serverOfCall.get(callKey(request.tool, request.chatId, request.consentBinding)) ?? null;
  const alwaysAllowBindingFor = (userIdentity: string, chatId: string | undefined, tool: string, server: string | null | undefined): ToolApprovalConsentBinding | null =>
    scopedBinding({ userIdentity, chatId, resourceIdentity: capabilityAlwaysAllowResource(tool, server) });
  const persistGrant: CapabilityGrantPersister = (grant) => {
    if (!grant.consentBinding) return { ok: false, code: "missing-binding" };
    const server = serverOfRequest({ tool: grant.tool, ...(grant.chatId ? { chatId: grant.chatId } : {}), consentBinding: grant.consentBinding });
    // Money is never remembered, and that is checked here once more, by what the tool is NOW (defect 1): an answer that
    // reaches this door for a tool the rule today calls a payment is refused whatever class the card was raised under.
    if (grant.kind === "money" || classifyApprovalAction({ tool: grant.tool, kind: "other", mutating: true, catalogId: server }) === "money") {
      return { ok: false, code: "money-never-remembered" };
    }
    const scoped = grant.kind === "delete" || grant.kind === "send"
      ? alwaysAllowBindingFor(grant.consentBinding.userIdentity, grant.chatId, grant.tool, server) : null;
    const binding = scoped ?? grant.consentBinding;
    const result = recordCapabilityGrant({
      capability: grant.capability,
      pattern: scoped ? scoped.credentialResourceIdentity : grant.pattern,
      decision: "allow",
      // The store derives the full scope digest from all binding fields.  The
      // marker supplied by the runtime is intentionally not trusted here.
      scope: capabilityConsentScope(binding),
      source: "chip",
      tool: grant.tool,
      consentBinding: binding,
    });
    if (!result.ok) return { ok: false, code: result.code };
    if (scoped) removeSupersededAlwaysAllowRows({ workspaceIdentity: scoped.workspaceIdentity, capability: grant.capability, tool: grant.tool });
    return { ok: true, id: result.id };
  };
  const arbiter: RuntimeToolPermissionArbiter = async (ask) => {
    /*
     * 저장된 능력 규칙이 최우선이다(deny > allow, chat > agent > global).
     * "항상 허용"으로 영구 부여된 행동은 권한 등급과 무관하게 통과한다.
     * Full access는 그 밖의 모든 일반 도구 관문을 해제한다. 단, 그 호출에 오너가 저장한
     * 거부 규칙이 있으면 조용히 허용하지도, 조용히 거부하지도 않고 승인 칩으로 묻는다
     * (오너 2026-10-27 "거부 우선 말고 승인 칩 뜨게"). One이 넘긴 일은 자동으로 full이라,
     * full이 거부를 이기면 위임된 실행에서 거부 규칙이 무력했다.
     */
    const capability = capabilityClassFor(ask.kind, ask.tool);
    // Full access is the owner's explicit grant for this run, and it needs no
    // stored rule, card or durable consent. The identity binding and the rule
    // lookup below only serve those, so a failure in either (a busy store, an
    // unrepresentable workspace path) must not turn the grant into a refusal.
    // Measured 2026-10-12 (1.3.5, One chat, permission full): an MCP tool that
    // auto-select had chosen for the run came back "not approved for this run".
    const fullAccess = ask.permission === "full";
    // BB-1a: a delete / send call that goes through below with no card because a saved "always allow", full access or an unattended write-mode run covered it leaves one settled row in the approval ledger (the conversation's quiet
    // "auto-approved" line). Every card-less pass of those two kinds is one of the five places that call this; a payment never passes without a card, and an ordinary call is not recorded.
    const passedWithoutCard = (basis: "always_allow" | "full_access" | "unattended"): void => {
      try {
        const kind = classifyApprovalAction(ask);
        if (kind === "delete" || kind === "send") recordAutoApprovedToolCall({ runtime: ask.runtime, tool: ask.tool, detail: ask.detail, cwd: ask.cwd, chatId: ask.chatId, capability: kind, agentId: ask.agentId }, basis);
      } catch { /* the record is a courtesy */ }
    };
    let consentBinding: ToolApprovalConsentBinding;
    try {
      consentBinding = consentBindingForAsk(ask);
    } catch {
      // An invalid host-owned identity must not turn into a broad legacy rule.
      if (fullAccess) passedWithoutCard("full_access");
      return fullAccess ? "allow_session" : "deny";
    }
    /*
     * ★한 규칙: 카드는 돈·삭제·외부 전송에만 뜬다. 모든 표면(구독 CLI의 승인 요청, ACP, 로컬 도구 루프, MCP 프록시, 방 팀원,
     * 1:1·Work·개인 에이전트)이 이 함수 하나를 지나므로 규칙도 여기 한 곳이다 — runtime/approval-rule.ts.
     *   돈      : 매번 묻는다. 저장된 허용은 읽지 않고, 카드에 "항상 허용"도 없다.
     *   삭제·전송: 읽기·쓰기 모드에서 처음에 묻고, "항상 허용"을 누르면 그 도구는 그 프로젝트 안에서 다시 묻지 않는다(방·세션·에이전트·인자가 달라도).
     *   그 밖   : 묻지 않는다(권한 모드는 잠그지 않는다).
     * 방 팀원 세션에 호스트가 자동으로 깔아 준 `*` 허용(source one-delegation)은 오너가 누른 답이 아니라 이 규칙에 적용되지 않는다.
     * decision: (1) "항상 허용"은 프로젝트 단위(프로젝트가 없으면 그 대화) - approval-scope.ts 한 함수; (2) 허브에서 불러만 쓴
     * 에이전트도 같은 "항상 허용"을 쓴다(에이전트를 가리지 않는다); (3) 전체 액세스에서는 삭제·전송을 묻지 않고 돈만 묻는다.
     */
    const action = classifyApprovalAction(ask);
    const gated = action !== "other";
    // A call the rule asks about is a call that changes something, whatever its runtime wrote: a payment whose runtime left
    // "mutating" out (a JS relay) was let through below before its card. Set in place: the ask's identity is a key.
    if (gated && !ask.mutating) ask.mutating = true;
    const rememberable = action === "delete" || action === "send";
    // Full access asks money only: delete / send cards exist in read and write modes.
    const asking = gated && Boolean(ask.chatId) && !ask.unattended && !(fullAccess && rememberable);
    // What one "always allow" covers: the project of this conversation (the conversation itself when it has none), any agent.
    // A run with no conversation has no such unit and keeps its exact binding.
    // The server is part of the key (defect 4). Rows saved under the older keys (the tool's name alone: per project, and the
    // account-wide ones a development build wrote) are not read: they ask again and are removed when the answer is given again.
    const scopeBinding = (): ToolApprovalConsentBinding => alwaysAllowBindingFor(consentBinding.userIdentity, ask.chatId, ask.tool, ask.catalogId) ?? consentBinding;
    if (gated) rememberServerOfCall(ask, consentBinding);
    // Why a call this rule asks about did not run, for the surface that answers the model (tool-approval.ts toolApprovalRefusal).
    const refuse = (cause: ApprovalRefusalCause): "deny" => {
      if (action !== "other") markToolApprovalRefusal(ask, { action, cause });
      return "deny";
    };
    const lookup = (binding: ToolApprovalConsentBinding) => getCapabilityDecision({
      capability,
      tool: ask.tool,
      detail: ask.detail,
      agentId: ask.agentId,
      chatId: ask.chatId,
      consentBinding: binding,
      ...(gated ? { excludeSources: NOT_OWNER_ANSWER_SOURCES } : {}),
    });
    const decideNow = () => (rememberable ? (lookup(scopeBinding()) ?? lookup(consentBinding)) : lookup(consentBinding));
    let ruled: ReturnType<typeof getCapabilityDecision>;
    try {
      ruled = decideNow();
      if (action === "money" && ruled === "allow") ruled = null; // money is never remembered
    } catch (error) {
      // Full access needs no stored rule for anything but money: an unreadable store must not turn its grant into a refusal.
      if (fullAccess && action !== "money") { if (rememberable) passedWithoutCard("full_access"); return "allow_session"; }
      throw error;
    }
    // Durable rules are re-read for each request so revocation is not cached by the runtime.
    // The owner's stored "no": the reason goes with the refusal (refuse), the next line is the refusal itself.
    if (ruled === "deny" && !fullAccess) refuse("owner_denied");
    if (ruled === "deny" && !fullAccess) return "deny";
    if (ruled === "allow") { if (rememberable) passedWithoutCard("always_allow"); return "allow_once"; }
    // Full access with the owner's stored deny for this very call: the card asks (below); an answer of "yes" is for this
    // call only, since the stored rule stays.
    const askOverDeny = fullAccess && ruled === "deny";
    // Money with nobody to ask (an automation, a headless run) is refused with the fact on record: the card cannot be answered.
    if (action === "money" && !asking) {
      announceToolDenied({
        ...(ask.signal ? { signal: ask.signal } : {}),
        sessionKey: ask.sessionKey, runtime: ask.runtime, tool: ask.tool, detail: ask.detail, cwd: ask.cwd,
        // The notice carries the class: a "from now on allow" answer to it stores nothing for money (tool-approval.ts), since
        // such a row would never be read (the old notice had no class and saved a row the next run still refused).
        capability: "money",
        deniedBy: "runtime-headless", consentBinding,
      });
      return refuse("nobody_to_ask");
    }
    if (fullAccess && !askOverDeny && !asking) { if (rememberable) passedWithoutCard("full_access"); return "allow_session"; }
    // One's own coordination tools (one-team: hand off, follow up, observe, team sessions, groups) are gated by Main's
    // One control server — capability binding, personal-conversation scope, follow-up bounds — the same gate codex exec
    // runs reach through default_tools_approval_mode. Owner 2026-10-04: what One hands off runs without asking. An
    // explicit owner deny rule (above) still wins.
    // The server is known by its registry identity when the ask carries one (the name alone otherwise): a server that only
    // carries the name is not One's own (mcp-config.ts refuses such a key, so this is a second lock).
    if (ask.catalogId == null || ask.catalogId === "one-team") {
      if (!askOverDeny && ask.tool.startsWith("mcp__one-team__")) return "allow_session";
    }
    if (!askOverDeny && !ask.mutating) return "allow_once";
    // BB-1c: the same pass, now on the ledger. Write mode with nobody to ask (an unattended run) lets a delete / send call through with no card, as before; it is recorded as `unattended`. A payment never gets here (refused above).
    if (!askOverDeny && ask.permission === "write" && !asking) { if (rememberable) passedWithoutCard("unattended"); return "allow_session"; }
    // The gateway tool of a tool.call: its port asks the connector tool's own rule next, in every mode - a second generic card for the same act is not asked. Only for a run that can be
    // asked at all (a conversation, attended); every other run falls through to the refusals below exactly as it did.
    if (!askOverDeny && ask.portAsksItsOwnRule === true && !asking && ask.chatId && !ask.unattended) return "allow_once";
    const deniedAt = recentUserDenials.get(denialKey(ask));
    if (deniedAt && now() - deniedAt < USER_DENIAL_TTL_MS) return refuse("owner_denied");
    const expiredAt = recentExpiries.get(denialKey(ask));
    if (expiredAt && now() - expiredAt < USER_DENIAL_TTL_MS) { markToolApprovalExpired(ask); return refuse("no_answer"); }
    /*
     * 대화가 붙어 있지 않은 실행(자동화/그래프/헤드리스)은 답할 사람이 없다 — 5분을
     * 매달아 두었다가 거부하는 대신 즉시 거부하고 사실만 남긴다(08-09 결정: 실행 중
     * 승인 게이트 없음. 승인은 만들 때 한 번).
     */
    if (!ask.chatId || ask.unattended) {
      announceToolDenied({
        ...(ask.signal ? { signal: ask.signal } : {}),
        sessionKey: ask.sessionKey,
        // 실제로 돈 런타임을 적는다. 예전엔 "acp"로 못 박혀 있어, 같은 중재자를
        // 쓰는 로컬 런타임의 거부까지 ACP 가 한 일로 기록될 뻔했다.
        runtime: ask.runtime,
        tool: ask.tool,
        detail: ask.detail,
        cwd: ask.cwd,
        ...(gated ? { capability: action } : {}),
        deniedBy: "runtime-headless",
        consentBinding,
      });
      return refuse("nobody_to_ask");
    }
    const outcome = await requestToolApproval({
      ...(ask.signal ? { signal: ask.signal } : {}),
      sessionKey: ask.sessionKey,
      runtime: ask.runtime,
      tool: ask.tool,
      detail: ask.detail,
      cwd: ask.cwd,
      chatId: ask.chatId,
      // The class the card names (money | delete | send) travels in the same field the phone already reads as a plain string.
      capability: gated ? action : capability,
      agentId: ask.agentId,
      consentBinding,
    });
    if (outcome.decision === "deny") {
      // An unanswered card closed by its timer is not the owner's answer: typed as an expiry for the caller.
      if (outcome.reason === "expired") { markToolApprovalExpired(ask); recentExpiries.set(denialKey(ask), now()); refuse("no_answer"); }
      else { recentUserDenials.set(denialKey(ask), now()); refuse("owner_denied"); }
    }
    if (askOverDeny && outcome.decision !== "deny") return "allow_once";
    // Durable consent is checked again for each call, including its first approval.
    // A native session permit would outlive revocation of the saved rule.
    if (outcome.decision === "allow_always" || outcome.decision === "allow_session") {
      // Revocation/deny written while this call was waiting on its card must win
      // at the last decision point before execution (G04). Fail closed on error.
      try {
        const latest = decideNow();
        if (latest === "deny") return "deny";
      } catch { return "deny"; }
    }
    return outcome.decision === "allow_always" ? "allow_once" : outcome.decision;
  };
  /** Does a saved "always allow" cover this open delete / send card (its conversation's project)? Reads the stored rule. */
  const alwaysAllowed = (request: { tool: string; capability?: string; chatId?: string; consentBinding?: ToolApprovalConsentBinding }): boolean => {
    if ((request.capability !== "delete" && request.capability !== "send") || !request.consentBinding) return false;
    try {
      const server = serverOfRequest(request);
      if (classifyApprovalAction({ tool: request.tool, kind: "other", mutating: true, catalogId: server }) === "money") return false;
      const binding = alwaysAllowBindingFor(request.consentBinding.userIdentity, request.chatId, request.tool, server);
      return Boolean(binding) && getCapabilityDecision({ capability: "other", tool: request.tool, consentBinding: binding as ToolApprovalConsentBinding, excludeSources: NOT_OWNER_ANSWER_SOURCES }) === "allow";
    } catch { return false; }
  };
  return { consentBindingForAsk, persistGrant, arbiter, alwaysAllowed };
}

/** Install the actual store-backed host policy without importing GUI authentication surfaces. */
export function installHostToolPermissionPolicy(identity: HostToolPermissionIdentityPorts): void {
  if (identity.hostKind !== "main" && identity.hostKind !== "daemon") {
    throw new Error("supervisor_approval_host_invalid");
  }
  const policy = createHostToolPermissionPolicy({
    getAuthenticatedActorIds: identity.getAuthenticatedActorIds,
    hostKind: identity.hostKind,
    configuredIdentity,
    getCapabilityDecision,
    recordCapabilityGrant,
    requestToolApproval,
    announceToolDenied,
  });
  setCapabilityGrantPersister(policy.persistGrant);
  setAlwaysAllowedReader(policy.alwaysAllowed);
  // live 승인 결정의 영속 장부 — 결정은 여기 먼저 기록되고 그다음 실행이 듣는다. 장부를 못 열면 예전처럼 메모리로만 기다린다.
  try {
    // R3-3: a request this host lets close unanswered leaves one quiet line in its conversation (Main and the daemon each for the requests they hold).
    setApprovalClosureRecorder((closure) => { recordApprovalClosure(closure); });
    installDurableToolApprovalLedger(getDb(), Date.now, identity.hostKind);
  } catch (error) {
    console.error("[tool-approval] durable ledger unavailable", error);
  }
  setRuntimeToolPermissionArbiter(policy.arbiter);
}
