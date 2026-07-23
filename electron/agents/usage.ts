// v74 에이전트 사용 원장 + 북마크 — run_events 귀속으로 축적되는 agent_usage
// 테이블의 조회 표면과 installed_agents.bookmarked_at 소유자 북마크 토글.
// 사용 원장은 recordRunEvent(라이브)와 v74 마이그레이션 백필이 유일한 쓰기 경로다.
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import type { AgentUsageSummaryRow } from "../../shared/types";

type AgentUsageRow = {
  agent_key: string;
  kind: string;
  first_used_at: string;
  last_used_at: string;
  use_count: number;
  bookmarked_at: string | null;
  installed: number;
};

/**
 * Per-agent run participation aggregate, most recently used first. Rows keep
 * the raw agent_key even when the installed agent has been removed
 * (`installed: false`) so history stays honest instead of silently vanishing.
 */
export function listAgentUsageSummary(): AgentUsageSummaryRow[] {
  const rows = getDb().prepare(
    `SELECT u.agent_key, u.kind, u.first_used_at, u.last_used_at, u.use_count,
            a.bookmarked_at,
            CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS installed
       FROM agent_usage u
       LEFT JOIN installed_agents a ON a.id = u.agent_key
      ORDER BY u.last_used_at DESC, u.agent_key ASC`,
  ).all() as AgentUsageRow[];
  return rows.map((row) => ({
    agentId: row.agent_key,
    kind: row.kind,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    bookmarkedAt: row.bookmarked_at,
    installed: row.installed === 1,
  }));
}

/** Owner bookmark toggle. Returns the stored timestamp (null when un-bookmarked). */
export function setAgentBookmark(agentIdValue: string, bookmarked: boolean): { agentId: string; bookmarkedAt: string | null } {
  const agentId = String(agentIdValue ?? "").trim();
  if (!agentId || agentId.length > 256) throw new Error("Agent id is invalid.");
  if (typeof bookmarked !== "boolean") throw new Error("bookmarked must be a boolean.");
  const existing = getDb().prepare("SELECT id FROM installed_agents WHERE id = ?").get(agentId) as { id?: string } | undefined;
  if (!existing?.id) throw new Error("Installed agent not found.");
  const bookmarkedAt = bookmarked ? new Date().toISOString() : null;
  getDb().prepare("UPDATE installed_agents SET bookmarked_at = ? WHERE id = ?").run(bookmarkedAt, agentId);
  emitDesktopStoreChange({ entity: "agent", id: agentId });
  return { agentId, bookmarkedAt };
}
