import { nativeApprovalActorSnapshot } from "./native-approval-provenance";
import { createHash } from "node:crypto";
import path from "node:path";
import { configuredIdentity } from "../install-identity";
import { getDb } from "../store/db";
import {
  capabilityConsentScope,
  capabilityResourceIdentity,
  getCapabilityDecision,
  recordCapabilityGrant,
} from "../store/capability-grants";
import { installDurableToolApprovalLedger } from "../one/supervisor-approval-ledger";
import { mainToolConsentResource } from "./tool-consent";
import {
  announceToolDenied,
  capabilityClassFor,
  requestToolApproval,
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
}

/** The same policy is installed as the base arbiter; private relays retain dispatch ownership. */
export function createHostToolPermissionPolicy(ports: HostToolPermissionPolicyPorts) {
  const { getAuthenticatedActorIds, configuredIdentity, getCapabilityDecision,
    recordCapabilityGrant, requestToolApproval, announceToolDenied } = ports;
  const now = ports.now ?? Date.now;
  const recentUserDenials = new Map<string, number>();
  const USER_DENIAL_TTL_MS = 5 * 60_000;
  const denialKey = (ask: { sessionKey: string; tool: string; detail?: string }) => `${ask.sessionKey}\u0000${ask.tool}\u0000${mainToolConsentResource(ask) ?? ask.detail ?? ""}`;

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
    cwd?: string;
    chatId?: string;
    agentId?: string;
    permission: "read" | "write" | "full" | undefined;
  }): ToolApprovalConsentBinding => {
    const scopedActor = nativeApprovalActorSnapshot();
    const actor = scopedActor ? scopedActor.actor : getAuthenticatedActorIds();
    const install = configuredIdentity();
    // Keep the supplied path bytes intact before canonicalizing `.`/`..`.
    // Unix permits leading/trailing spaces in a directory name; trimming here
    // would let two distinct workspaces inherit the same durable consent.
    const rawWorkspace = ask.cwd && ask.cwd.length > 0
      ? path.resolve(ask.cwd)
      : ask.chatId
        ? `chat:${ask.chatId}`
        : `desktop:${install?.userDataNamespace ?? "Agentlas"}`;
    const rawUser = actor
      ? `account:${actor.userId}`
      : `install:${install?.channel ?? "official"}:${install?.userDataNamespace ?? "Agentlas"}`;
    const rawWorkspaceIdentity = actor
      ? `account-workspace:${actor.workspaceId}|${rawWorkspace}`
      : rawWorkspace;
    const rawRequester = `runtime:${ask.runtime}|agent:${ask.agentId?.trim() || "default"}`;
    return {
      userIdentity: opaqueConsentIdentity("user", rawUser),
      workspaceIdentity: opaqueConsentIdentity("workspace", rawWorkspaceIdentity),
      requesterIdentity: opaqueConsentIdentity("requester", rawRequester),
      credentialResourceIdentity: mainToolConsentResource(ask) ?? capabilityResourceIdentity(ask.tool, ask.detail),
      permissionScope: ask.permission ?? "read",
    };
  };
  // ★한 벌뿐이다 — ACP 의 session/request_permission 과 우리 in-process 도구 루프
  // (ollama/lmstudio/mlx)가 **같은** 이 함수를 지난다. 정책을 두 벌 쓰면 갈라지고,
  // 갈라진 쪽은 반드시 "묻지 않고 실행"으로 기운다(local-tool-loop 이 실제로 그랬다).
  // "항상 허용" 칩의 영구 기록(capability_grants) — tool-approval.ts 는 store 를 모르므로
  // 여기서 주입한다(오너 결정 2026-08-20: 항상 허용은 다시는 묻지 않는다).
  const persistGrant: CapabilityGrantPersister = (grant) => {
    if (!grant.consentBinding) return { ok: false, code: "missing-binding" };
    const result = recordCapabilityGrant({
      capability: grant.capability,
      pattern: grant.pattern,
      decision: "allow",
      // The store derives the full scope digest from all binding fields.  The
      // marker supplied by the runtime is intentionally not trusted here.
      scope: capabilityConsentScope(grant.consentBinding),
      source: "chip",
      tool: grant.tool,
      consentBinding: grant.consentBinding,
    });
    if (!result.ok) return { ok: false, code: result.code };
    return { ok: true, id: result.id };
  };
  const arbiter: RuntimeToolPermissionArbiter = async (ask) => {
    /*
     * 저장된 능력 규칙이 최우선이다(deny > allow, chat > agent > global).
     * "항상 허용"으로 영구 부여된 행동은 권한 등급과 무관하게 통과한다.
     * 사용자가 이 실행에서 Full access를 선택하면 이전에 저장된 거부보다
     * 현재의 명시적 선택을 우선해 모든 일반 도구 관문을 해제한다.
     */
    const capability = capabilityClassFor(ask.kind, ask.tool);
    let consentBinding: ToolApprovalConsentBinding;
    try {
      consentBinding = consentBindingForAsk(ask);
    } catch {
      // An invalid host-owned identity must not turn into a broad legacy rule.
      return "deny";
    }
    const ruled = getCapabilityDecision({
      capability,
      tool: ask.tool,
      detail: ask.detail,
      agentId: ask.agentId,
      chatId: ask.chatId,
      consentBinding,
    });
    // Durable rules are re-read for each request so revocation is not cached by the runtime.
    if (ruled === "allow") return "allow_once";
    if (ask.permission === "full") return "allow_session";
    if (ruled === "deny") return "deny";
    // One's own coordination tools (one-team: hand off, follow up, observe, team sessions, groups) are gated by Main's
    // One control server — capability binding, personal-conversation scope, follow-up bounds — the same gate codex exec
    // runs reach through default_tools_approval_mode. Owner 2026-10-04: what One hands off runs without asking. An
    // explicit owner deny rule (above) still wins.
    if (ask.tool.startsWith("mcp__one-team__")) return "allow_session";
    if (!ask.mutating) return "allow_once";
    if (ask.permission === "write") return "allow_session";
    const deniedAt = recentUserDenials.get(denialKey(ask));
    if (deniedAt && now() - deniedAt < USER_DENIAL_TTL_MS) return "deny";
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
        deniedBy: "runtime-headless",
        consentBinding,
      });
      return "deny";
    }
    const outcome = await requestToolApproval({
      ...(ask.signal ? { signal: ask.signal } : {}),
      sessionKey: ask.sessionKey,
      runtime: ask.runtime,
      tool: ask.tool,
      detail: ask.detail,
      cwd: ask.cwd,
      chatId: ask.chatId,
      capability,
      agentId: ask.agentId,
      consentBinding,
    });
    if (outcome.decision === "deny") recentUserDenials.set(denialKey(ask), now());
    // Durable consent is checked again for each call, including its first approval.
    // A native session permit would outlive revocation of the saved rule.
    return outcome.decision === "allow_always" ? "allow_once" : outcome.decision;
  };
  return { consentBindingForAsk, persistGrant, arbiter };
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
  // live 승인 결정의 영속 장부 — 결정은 여기 먼저 기록되고 그다음 실행이 듣는다. 장부를 못 열면 예전처럼 메모리로만 기다린다.
  try {
    installDurableToolApprovalLedger(getDb(), Date.now, identity.hostKind);
  } catch (error) {
    console.error("[tool-approval] durable ledger unavailable", error);
  }
  setRuntimeToolPermissionArbiter(policy.arbiter);
}
