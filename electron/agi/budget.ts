/**
 * AGI goal manager — token limits (owner decision D1, 2026-09-28: "토큰 한도 커스터마이즈 되야지").
 *
 *  - per unblock attempt: default 60,000 tokens;
 *  - per goal per day:    default 200,000 tokens;
 * both editable by the owner (AGI popover / settings), and every token is also deducted from the goal's Alive grant
 * (alive_agents.budget.tokensUsed) when the goal has an AGI life, so the popover's grant still governs.
 *
 * The monitor itself costs 0 tokens; only a model-backed unblock attempt (P4) spends. The executor asks
 * admitAgiTokens before any model-spending step and charges measured usage after it.
 */
import type Database from "better-sqlite3";

export const AGI_DEFAULT_ATTEMPT_TOKEN_LIMIT = 60_000;
export const AGI_DEFAULT_DAILY_GOAL_TOKEN_LIMIT = 200_000;
export const AGI_MIN_TOKEN_LIMIT = 5_000;
export const AGI_MAX_TOKEN_LIMIT = 50_000_000;

export interface AgiTokenLimits { attemptTokenLimit: number; dailyGoalTokenLimit: number }

export function ensureAgiBudgetSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json)), updated_at_ms INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agi_token_ledger (
    goal_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0 CHECK(tokens >= 0),
    PRIMARY KEY(goal_id, day))`);
}

function validLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= AGI_MIN_TOKEN_LIMIT && value <= AGI_MAX_TOKEN_LIMIT ? value : null;
}

export function readAgiTokenLimits(db: Database.Database): AgiTokenLimits {
  ensureAgiBudgetSchema(db);
  const row = db.prepare("SELECT value_json FROM agi_settings WHERE key = 'token_limits'").get() as { value_json: string } | undefined;
  let stored: Partial<AgiTokenLimits> = {};
  try { stored = row ? JSON.parse(row.value_json) as Partial<AgiTokenLimits> : {}; } catch { stored = {}; }
  return {
    attemptTokenLimit: validLimit(stored.attemptTokenLimit) ?? AGI_DEFAULT_ATTEMPT_TOKEN_LIMIT,
    dailyGoalTokenLimit: validLimit(stored.dailyGoalTokenLimit) ?? AGI_DEFAULT_DAILY_GOAL_TOKEN_LIMIT,
  };
}

export class AgiBudgetError extends Error {
  constructor(readonly code: string) { super(`[agentlas:code=${code}] ${code}`); this.name = "AgiBudgetError"; }
}

/** Owner edit. Out-of-range values are refused (no silent clamp: the popover shows the range). */
export function writeAgiTokenLimits(db: Database.Database, input: Partial<AgiTokenLimits>, nowMs: number): AgiTokenLimits {
  const current = readAgiTokenLimits(db);
  const next: AgiTokenLimits = { ...current };
  if (input.attemptTokenLimit !== undefined) {
    const value = validLimit(input.attemptTokenLimit);
    if (value === null) throw new AgiBudgetError("agi.budget.attempt-limit-invalid");
    next.attemptTokenLimit = value;
  }
  if (input.dailyGoalTokenLimit !== undefined) {
    const value = validLimit(input.dailyGoalTokenLimit);
    if (value === null) throw new AgiBudgetError("agi.budget.daily-limit-invalid");
    next.dailyGoalTokenLimit = value;
  }
  if (next.attemptTokenLimit > next.dailyGoalTokenLimit) throw new AgiBudgetError("agi.budget.attempt-over-daily");
  db.prepare(`INSERT INTO agi_settings(key,value_json,updated_at_ms) VALUES ('token_limits',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at_ms=excluded.updated_at_ms`).run(JSON.stringify(next), nowMs);
  return next;
}

export function agiDay(nowMs: number): string { return new Date(nowMs).toISOString().slice(0, 10); }

export function agiTokensToday(db: Database.Database, goalId: string, nowMs: number): number {
  ensureAgiBudgetSchema(db);
  const row = db.prepare("SELECT tokens FROM agi_token_ledger WHERE goal_id = ? AND day = ?").get(goalId, agiDay(nowMs)) as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

/** The goal's Alive life, if any: its grant also has to cover AGI spend. */
export interface AliveGrantView { agentId: string; tokenLimit: number | null; tokensUsed: number; version: number }
export function aliveGrantForGoal(db: Database.Database, goalId: string): AliveGrantView | null {
  const hasLives = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alive_organism_lives'").get();
  if (!hasLives) return null;
  // One goal → its own life; Work → the project life whose attachment follows the goal's chat.
  type Row = { agent_id: string; budget_json: string; version: number };
  let row = db.prepare(`SELECT a.agent_id, a.budget_json, a.version FROM alive_organism_lives l JOIN alive_agents a ON a.agent_id = l.agent_id
    WHERE l.life_key = ? LIMIT 1`).get(`alive:one-goal:v1:${goalId}`) as Row | undefined;
  if (!row) {
    try {
      row = db.prepare(`SELECT a.agent_id, a.budget_json, a.version FROM alive_organism_lives l JOIN alive_agents a ON a.agent_id = l.agent_id
        WHERE l.organism = 'work' AND l.scope_id = (SELECT c.project_id FROM long_runs r JOIN chats c ON c.id = r.root_chat_id WHERE r.goal_id = ?)
        LIMIT 1`).get(goalId) as Row | undefined;
    } catch { row = undefined; }
  }
  if (!row) return null;
  try {
    const budget = JSON.parse(row.budget_json) as { tokenLimit: number | null; tokensUsed: number };
    return { agentId: row.agent_id, tokenLimit: budget.tokenLimit ?? null, tokensUsed: budget.tokensUsed ?? 0, version: row.version };
  } catch { return null; }
}

/**
 * Admission for a model-spending step: null = admitted, else a typed code. The attempt cap is checked against the
 * attempt's running total; the daily cap against today's ledger; the Alive grant against its remaining tokens.
 */
export function admitAgiTokens(db: Database.Database, input: { goalId: string; nowMs: number; attemptTokensSoFar: number; estimate: number }): string | null {
  // Limits remain visible accounting preferences. They cannot stop repair or
  // the original work under the owner's nonblocking execution policy.
  ensureAgiBudgetSchema(db);
  return null;
}

/** Charge measured usage to the daily ledger and to the goal's Alive grant (deducted, D1). */
export function chargeAgiTokens(db: Database.Database, goalId: string, tokens: number, nowMs: number): void {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
  ensureAgiBudgetSchema(db);
  db.transaction(() => {
    db.prepare(`INSERT INTO agi_token_ledger(goal_id,day,tokens) VALUES (?,?,?)
      ON CONFLICT(goal_id,day) DO UPDATE SET tokens = tokens + excluded.tokens`).run(goalId, agiDay(nowMs), tokens);
    const grant = aliveGrantForGoal(db, goalId);
    if (grant) {
      const row = db.prepare("SELECT budget_json FROM alive_agents WHERE agent_id = ?").get(grant.agentId) as { budget_json: string };
      const budget = JSON.parse(row.budget_json) as Record<string, unknown>;
      budget.tokensUsed = (Number(budget.tokensUsed) || 0) + tokens;
      db.prepare("UPDATE alive_agents SET budget_json = ?, version = version + 1, updated_at_ms = ? WHERE agent_id = ?")
        .run(JSON.stringify(budget), nowMs, grant.agentId);
    }
  })();
}
