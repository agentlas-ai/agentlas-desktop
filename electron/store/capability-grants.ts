/**
 * 통합 능력 승인(capability grants) — 오너 결정 2026-08-20.
 *
 * 원칙: 에이전트의 능력을 정적 권한(read 강등, 도구 박탈)으로 제한하지 않는다.
 * 경계를 넘는 행동은 그 순간 칩 [항상 허용 / 이번만 허용 / 거부]로 묻고,
 * "항상 허용"은 여기 영구 기록되어 **다시는 묻지 않는다**.
 *
 * 모델은 Claude Code의 permission rules를 따른다(2026-08-20 조사):
 *  - 규칙 키 = 도구 + 선택적 인자 프리픽스 패턴 ("git push *")
 *  - 우선순위 = deny > allow, 스코프 구체성 chat > agent > global
 *  - 규칙은 에이전트들이 **공유**한다(비전: 행동 기반, 에이전트별 아님).
 *    per-agent 예외가 필요할 때만 scope 'agent:<id>' 를 쓴다.
 *
 * 이 표로 뚫리지 않는 것(각 채널이 매번 확인): 결제, 브라우저 임의코드 실행.
 * 그 예외는 소비자(browser/connect.ts, 중재자)가 지킨다 — 여기서는 저장만 한다.
 */
import { getDb } from "./db";

export type CapabilityDecision = "allow" | "deny";

export interface CapabilityGrantRow {
  id: number;
  capability: string;
  pattern: string | null;
  decision: CapabilityDecision;
  scope: string;
  source: string;
  createdAt: string;
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
      `SELECT capability, pattern, decision, scope FROM capability_grants
       WHERE capability IN (${keys.map(() => "?").join(",")})`,
    )
    .all(...keys) as Array<Pick<CapabilityGrantRow, "capability" | "pattern" | "decision" | "scope">>;
  if (rows.length === 0) return null;
  for (const scope of scopesFor(q)) {
    const inScope = rows.filter((row) => row.scope === scope && patternMatches(row.pattern, q.detail));
    if (inScope.length === 0) continue;
    if (inScope.some((row) => row.decision === "deny")) return "deny";
    return "allow";
  }
  return null;
}

export interface CapabilityGrantInput {
  capability: string;
  pattern?: string | null;
  decision: CapabilityDecision;
  scope?: string;
  source?: string;
}

/** 규칙을 영속한다. 같은 (capability, pattern, scope)는 마지막 결정으로 덮는다. */
export function recordCapabilityGrant(input: CapabilityGrantInput): void {
  getDb()
    .prepare(
      `INSERT INTO capability_grants (capability, pattern, decision, scope, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(capability, pattern, scope)
       DO UPDATE SET decision = excluded.decision, source = excluded.source, created_at = excluded.created_at`,
    )
    .run(
      input.capability,
      input.pattern ?? null,
      input.decision,
      input.scope ?? "global",
      input.source ?? "chip",
      new Date().toISOString(),
    );
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
