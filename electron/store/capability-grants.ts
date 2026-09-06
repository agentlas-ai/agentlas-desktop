/**
 * 통합 능력 승인(capability grants) — 오너 결정 2026-08-20.
 *
 * 원칙: 에이전트의 능력을 정적 권한(read 강등, 도구 박탈)으로 제한하지 않는다.
 * 경계를 넘는 행동은 그 순간 칩 [항상 허용 / 이번만 허용 / 거부]로 묻고,
 * "항상 허용"은 여기 영구 기록되어 **다시는 묻지 않는다**.
 *
 * 레거시 행은 Claude Code-style 규칙(도구 + 선택적 프리픽스 패턴)을 유지한다.
 * 새 durable consent 행은 이 규칙을 상속하지 않고, Main이 만든 exact
 * user/workspace/requester/resource/permission binding 하나에만 매치한다.
 * 레거시 스코프 우선순위는 deny > allow, chat > agent > global을 그대로 둔다.
 *
 * 이 표로 뚫리지 않는 것(각 채널이 매번 확인): 결제, 브라우저 임의코드 실행.
 * 그 예외는 소비자(browser/connect.ts, 중재자)가 지킨다 — 여기서는 저장만 한다.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db";
import type {
  ToolApprovalConsentBinding,
} from "../../shared/types";

export type CapabilityDecision = "allow" | "deny";

export interface CapabilityGrantRow {
  id: number;
  capability: string;
  pattern: string | null;
  decision: CapabilityDecision;
  scope: string;
  source: string;
  createdAt: string;
  /** Present only for v1 exact-consent rows. Legacy rows intentionally keep
   * their historical scope semantics so an existing explicit grant is not
   * silently invalidated by the migration. */
  binding?: ToolApprovalConsentBinding;
}

export interface CapabilityQuery {
  /** 능력 클래스: execute | edit | delete | network | other */
  capability: string;
  /** 도구 이름 — tool:<name> 규칙 매칭용 */
  tool?: string;
  /** 인자 상세(명령줄/경로) — 프리픽스 패턴 매칭 대상 */
  detail?: string;
  agentId?: string;
  chatId?: string;
  /** Main-owned exact identity. When present, matching first checks only this
   * binding; legacy rows are considered afterwards with their old scope. */
  consentBinding?: ToolApprovalConsentBinding;
}

export type CapabilityGrantPersistenceResult =
  | { ok: true; id: number }
  | { ok: false; code: "invalid-binding" | "storage-failure" };

const CONSENT_SCOPE_PREFIX = "consent:v1:";
const CONSENT_IDENTITY_MAX = 512;
const CONSENT_DETAIL_MAX = 16 * 1024;

function boundedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > CONSENT_IDENTITY_MAX || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`invalid capability consent ${label}`);
  }
  return normalized;
}

function normalizedBinding(binding: ToolApprovalConsentBinding): ToolApprovalConsentBinding {
  if (binding.permissionScope !== "read" && binding.permissionScope !== "write" && binding.permissionScope !== "full") {
    throw new Error("invalid capability consent permission scope");
  }
  return {
    userIdentity: boundedIdentity(binding.userIdentity, "user identity"),
    workspaceIdentity: boundedIdentity(binding.workspaceIdentity, "workspace identity"),
    requesterIdentity: boundedIdentity(binding.requesterIdentity, "requester identity"),
    credentialResourceIdentity: boundedIdentity(binding.credentialResourceIdentity, "resource identity"),
    permissionScope: binding.permissionScope,
  };
}

function bindingCanonicalText(binding: ToolApprovalConsentBinding): string {
  const normalized = normalizedBinding(binding);
  return [
    "agentlas-tool-consent-v1",
    normalized.userIdentity,
    normalized.workspaceIdentity,
    normalized.requesterIdentity,
    normalized.credentialResourceIdentity,
    normalized.permissionScope,
  ].join("\u0000");
}

/** Stable, value-free row scope for one exact consent binding. */
export function capabilityConsentScope(binding: ToolApprovalConsentBinding): string {
  return `${CONSENT_SCOPE_PREFIX}${createHash("sha256").update(bindingCanonicalText(binding), "utf8").digest("hex")}`;
}

/**
 * Build the value-free resource identity used by the exact consent row. The
 * caller supplies the exact tool/detail material in Main; only the digest is
 * persisted so commands or credential names cannot leak through the ledger.
 */
export function capabilityResourceIdentity(tool: string, detail?: string): string {
  const normalizedTool = boundedIdentity(tool, "tool");
  // Preserve the exact detail bytes. Collapsing whitespace would make two
  // different paths/quoted arguments share a grant and therefore broaden the
  // user's consent. The value itself is never persisted, only this digest.
  const exactDetail = detail ?? "";
  if (exactDetail.length > CONSENT_DETAIL_MAX) {
    throw new Error("invalid capability consent resource");
  }
  return createHash("sha256")
    .update("agentlas-tool-resource-v1\u0000", "utf8")
    .update(normalizedTool, "utf8")
    .update("\u0000", "utf8")
    .update(exactDetail, "utf8")
    .digest("hex");
}

function isExactConsentScope(scope: string): boolean {
  return scope.startsWith(CONSENT_SCOPE_PREFIX) && /^consent:v1:[a-f0-9]{64}$/.test(scope);
}

function bindingMatchesRow(
  row: Pick<CapabilityGrantRow, "scope" | "binding">,
  binding: ToolApprovalConsentBinding,
): boolean {
  if (!isExactConsentScope(row.scope)) return false;
  const candidate = row.binding;
  if (!candidate) return false;
  return candidate.userIdentity === binding.userIdentity
    && candidate.workspaceIdentity === binding.workspaceIdentity
    && candidate.requesterIdentity === binding.requesterIdentity
    && candidate.credentialResourceIdentity === binding.credentialResourceIdentity
    && candidate.permissionScope === binding.permissionScope
    && row.scope === capabilityConsentScope(binding);
}

function scopesFor(q: Pick<CapabilityQuery, "agentId" | "chatId">): string[] {
  // 구체성 내림차순 — 먼저 맞은 스코프가 이긴다.
  const scopes: string[] = [];
  if (q.chatId) scopes.push(`chat:${q.chatId}`);
  if (q.agentId) scopes.push(`agent:${q.agentId}`);
  scopes.push("global");
  return scopes;
}

/** "git push *" 스타일 프리픽스 패턴. NULL 패턴은 인자 무관 매치. */
function patternMatches(pattern: string | null, detail: string | undefined): boolean {
  if (pattern === null || pattern === "") return true;
  if (!detail) return false;
  if (pattern.endsWith("*")) {
    // The space before `*` is part of the command boundary. Trimming it turns
    // `git push *` into `git push*`, which also authorizes `git pushx ...`.
    return detail.startsWith(pattern.slice(0, -1));
  }
  return detail === pattern;
}

/**
 * 저장된 규칙으로 결정을 찾는다. 없으면 null(→ 기존 권한 정책/칩 질문으로).
 * 같은 스코프 안에서는 deny 가 allow 를 이긴다.
 */
export function getCapabilityDecision(q: CapabilityQuery): CapabilityDecision | null {
  const keys = [q.capability, ...(q.tool ? [`tool:${q.tool}`] : []), "*"];
  const rows = getDb()
    .prepare(
      `SELECT capability, pattern, decision, scope, binding_version, user_identity,
              workspace_identity, requester_identity, resource_identity, permission_scope
         FROM capability_grants
       WHERE capability IN (${keys.map(() => "?").join(",")})`,
    )
    .all(...keys) as Array<{
      capability: string;
      pattern: string | null;
      decision: CapabilityDecision;
      scope: string;
      binding_version?: number | null;
      user_identity?: string | null;
      workspace_identity?: string | null;
      requester_identity?: string | null;
      resource_identity?: string | null;
      permission_scope?: ToolApprovalConsentBinding["permissionScope"] | null;
    }>;
  if (rows.length === 0) return null;

  // An exact row outranks every historical global/chat/agent rule.  This lets
  // a user explicitly deny or allow one binding without changing the meaning
  // of an older grant, while keeping legacy rows available below for users who
  // already granted them before v1 identity fields existed.
  if (q.consentBinding) {
    let binding: ToolApprovalConsentBinding;
    try {
      binding = normalizedBinding(q.consentBinding);
    } catch {
      return null;
    }
    const exact = rows.filter((row) => {
      if (Number(row.binding_version ?? 0) !== 1) return false;
      const rowBinding =
        row.user_identity && row.workspace_identity && row.requester_identity
          && row.resource_identity && row.permission_scope
          ? {
              userIdentity: row.user_identity,
              workspaceIdentity: row.workspace_identity,
              requesterIdentity: row.requester_identity,
              credentialResourceIdentity: row.resource_identity,
              permissionScope: row.permission_scope,
            } satisfies ToolApprovalConsentBinding
          : undefined;
      return bindingMatchesRow({ scope: row.scope, binding: rowBinding }, binding)
        && (row.capability === q.capability || Boolean(q.tool && row.capability === `tool:${q.tool}`));
    });
    if (exact.length > 0) {
      if (exact.some((row) => row.decision === "deny")) return "deny";
      return "allow";
    }
  }

  // Old rows are intentionally scoped by their original contract.  Exact
  // rows never enter this loop, so they cannot accidentally become global
  // rules.  Legacy rows remain usable to avoid invalidating explicit grants
  // during migration; no new call is written in this shape.
  for (const scope of scopesFor(q)) {
    const inScope = rows.filter((row) =>
      Number(row.binding_version ?? 0) !== 1
      && row.scope === scope
      && patternMatches(row.pattern, q.detail),
    );
    if (inScope.length === 0) continue;
    if (inScope.some((row) => row.decision === "deny")) return "deny";
    return "allow";
  }
  return null;
}

export interface CapabilityGrantInput {
  capability: string;
  tool?: string;
  pattern?: string | null;
  decision: CapabilityDecision;
  scope?: string;
  source?: string;
  consentBinding?: ToolApprovalConsentBinding;
}

/**
 * 영속 규칙을 기록한다. exact binding은 다섯 가지 정체성과 권한을 모두
 * 포함한 digest scope로 저장한다. 레거시 입력은 기존 scope 의미를 유지하되,
 * SQLite의 NULL UNIQUE 함정은 명시적인 replace로 피한다.
 */
export function recordCapabilityGrant(input: CapabilityGrantInput): CapabilityGrantPersistenceResult {
  const db = getDb();
  const now = new Date().toISOString();
  if (input.consentBinding) {
    try {
      normalizedBinding(input.consentBinding);
    } catch {
      return { ok: false, code: "invalid-binding" };
    }
  }
  try {
    if (input.consentBinding) {
      const binding = normalizedBinding(input.consentBinding);
      const scope = capabilityConsentScope(binding);
      const pattern = binding.credentialResourceIdentity;
      const result = db
        .prepare(
          `INSERT INTO capability_grants (
             capability, pattern, decision, scope, source, created_at,
             binding_version, user_identity, workspace_identity,
             requester_identity, resource_identity, permission_scope, tool_identity
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(capability, pattern, scope)
           DO UPDATE SET
             decision = excluded.decision,
             source = excluded.source,
             created_at = excluded.created_at,
             binding_version = excluded.binding_version,
             user_identity = excluded.user_identity,
             workspace_identity = excluded.workspace_identity,
             requester_identity = excluded.requester_identity,
             resource_identity = excluded.resource_identity,
             permission_scope = excluded.permission_scope,
             tool_identity = excluded.tool_identity`,
        )
        .run(
          input.capability,
          pattern,
          input.decision,
          scope,
          input.source ?? "chip",
          now,
          binding.userIdentity,
          binding.workspaceIdentity,
          binding.requesterIdentity,
          binding.credentialResourceIdentity,
          binding.permissionScope,
          input.tool ?? null,
        );
      const row = db
        .prepare(
          `SELECT id FROM capability_grants
             WHERE capability = ? AND pattern = ? AND scope = ?
             ORDER BY id DESC LIMIT 1`,
        )
        .get(input.capability, pattern, scope) as { id?: number } | undefined;
      return { ok: true, id: Number(row?.id ?? result.lastInsertRowid) };
    }

    const pattern = input.pattern ?? null;
    const scope = input.scope ?? "global";
    // UNIQUE(capability, pattern, scope) does not consider NULL equal in
    // SQLite. Replace all historical duplicates before updating the survivor,
    // so a later explicit allow cannot be shadowed by an older deny row.
    if (pattern === null) {
      const existing = db
        .prepare(
          `SELECT id FROM capability_grants
             WHERE capability = ? AND pattern IS NULL AND scope = ?
             ORDER BY id DESC`,
        )
        .all(input.capability, scope) as Array<{ id: number }>;
      const keep = existing[0]?.id;
      if (keep !== undefined) {
        db.transaction(() => {
          db.prepare("DELETE FROM capability_grants WHERE capability = ? AND pattern IS NULL AND scope = ? AND id <> ?")
            .run(input.capability, scope, keep);
          db.prepare(
            `UPDATE capability_grants
                SET decision = ?, source = ?, created_at = ?, binding_version = 0,
                    user_identity = NULL, workspace_identity = NULL,
                    requester_identity = NULL, resource_identity = NULL,
                    permission_scope = NULL, tool_identity = NULL
              WHERE id = ?`,
          ).run(input.decision, input.source ?? "chip", now, keep);
        })();
        return { ok: true, id: Number(keep) };
      }
    }
    const result = db
      .prepare(
        `INSERT INTO capability_grants (
           capability, pattern, decision, scope, source, created_at, binding_version
         ) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(capability, pattern, scope)
         DO UPDATE SET decision = excluded.decision, source = excluded.source,
                       created_at = excluded.created_at, binding_version = 0`,
      )
      .run(input.capability, pattern, input.decision, scope, input.source ?? "chip", now);
    const row = db
      .prepare(
        `SELECT id FROM capability_grants
           WHERE capability = ? AND pattern = ? AND scope = ?
           ORDER BY id DESC LIMIT 1`,
      )
      .get(input.capability, pattern, scope) as { id?: number } | undefined;
    return { ok: true, id: Number(row?.id ?? result.lastInsertRowid) };
  } catch {
    return { ok: false, code: "storage-failure" };
  }
}

export function revokeCapabilityGrant(id: number): boolean {
  return getDb().prepare("DELETE FROM capability_grants WHERE id = ?").run(id).changes > 0;
}

export function listCapabilityGrants(scope?: string): CapabilityGrantRow[] {
  const rows = scope
    ? getDb().prepare("SELECT * FROM capability_grants WHERE scope = ? ORDER BY id").all(scope)
    : getDb().prepare("SELECT * FROM capability_grants ORDER BY id").all();
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    capability: String(row.capability),
    pattern: row.pattern == null ? null : String(row.pattern),
    decision: row.decision === "deny" ? "deny" : "allow",
    scope: String(row.scope),
    source: String(row.source ?? "chip"),
    createdAt: String(row.created_at ?? ""),
    ...(
      Number(row.binding_version ?? 0) === 1
      && typeof row.user_identity === "string"
      && typeof row.workspace_identity === "string"
      && typeof row.requester_identity === "string"
      && typeof row.resource_identity === "string"
      && (row.permission_scope === "read" || row.permission_scope === "write" || row.permission_scope === "full")
        ? {
            binding: {
              userIdentity: row.user_identity,
              workspaceIdentity: row.workspace_identity,
              requesterIdentity: row.requester_identity,
              credentialResourceIdentity: row.resource_identity,
              permissionScope: row.permission_scope,
            },
          }
        : {}
    ),
  }));
}

/**
 * 대화 전체 통과("항상 승인" 대화) — 기존 renderer localStorage
 * `agentlas.one.alwaysApprovedChats.v1` 의 이관처. capability '*' + scope chat.
 */
export function isChatAlwaysApproved(chatId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT decision FROM capability_grants WHERE capability = '*' AND scope = ? ORDER BY id DESC LIMIT 1",
    )
    .get(`chat:${chatId}`) as { decision?: string } | undefined;
  return row?.decision === "allow";
}

export function grantChatAlwaysApproval(chatId: string, source = "chip"): void {
  recordCapabilityGrant({ capability: "*", decision: "allow", scope: `chat:${chatId}`, source });
}

export function revokeChatAlwaysApproval(chatId: string): void {
  getDb()
    .prepare("DELETE FROM capability_grants WHERE capability = '*' AND scope = ?")
    .run(`chat:${chatId}`);
}

export function listAlwaysApprovedChatIds(): string[] {
  const rows = getDb()
    .prepare(
      "SELECT scope FROM capability_grants WHERE capability = '*' AND decision = 'allow' AND scope LIKE 'chat:%'",
    )
    .all() as Array<{ scope: string }>;
  return rows.map((row) => row.scope.slice("chat:".length));
}
