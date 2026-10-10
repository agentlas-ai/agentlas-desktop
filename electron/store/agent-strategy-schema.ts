/**
 * Agent Strategy DDL — leaf module (no store imports) so the schema ladder in db.ts can call it without an import cycle.
 * Tables are documented in electron/store/agent-strategy.ts.
 */
import type Database from "better-sqlite3";

export function createAgentStrategySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_kpis (
      goal_id TEXT NOT NULL,
      kpi_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'up' CHECK(direction IN ('up','down')),
      kr_id TEXT,
      target REAL,
      deadline_at TEXT,
      baseline REAL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('agent_observed','collector')),
      source_ref TEXT,
      cadence_hours INTEGER NOT NULL DEFAULT 24 CHECK(cadence_hours BETWEEN 1 AND 168),
      min_samples INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      PRIMARY KEY(goal_id, kpi_id)
    );
    CREATE TABLE IF NOT EXISTS goal_kpi_samples (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      kpi_id TEXT NOT NULL,
      value REAL NOT NULL,
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      trust TEXT NOT NULL CHECK(trust IN ('agent_observed','collector')),
      evidence TEXT NOT NULL,
      run_id TEXT,
      UNIQUE(goal_id, kpi_id, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_kpi_samples_series ON goal_kpi_samples(goal_id, kpi_id, observed_at);
    CREATE TABLE IF NOT EXISTS goal_kpi_state (
      goal_id TEXT NOT NULL,
      kpi_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('no_data','ahead','on_pace','behind','stalled','breakout','declining')),
      since TEXT NOT NULL,
      pending_state TEXT,
      pending_count INTEGER NOT NULL DEFAULT 0,
      last_sample_id TEXT,
      last_fired_at TEXT,
      last_fired_state TEXT,
      trigger_id TEXT,
      trigger_created_at TEXT,
      PRIMARY KEY(goal_id, kpi_id)
    );
  `);
}
