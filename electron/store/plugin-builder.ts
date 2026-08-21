import { randomUUID } from "node:crypto";
import type {
  PluginBuilderAnswers,
  PluginBuilderPhase,
  PluginBuilderSeed,
} from "../../shared/plugin-builder";
import { getDb } from "./db";

export interface PluginBuilderSessionRow {
  id: string;
  chatId: string;
  slug: string | null;
  phase: PluginBuilderPhase | "discarded";
  stagingDir: string | null;
  answers: PluginBuilderAnswers | null;
  gateReport: Record<string, unknown> | null;
  seed: PluginBuilderSeed;
  createdAt: string;
  updatedAt: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function rowToSession(row: Record<string, unknown>): PluginBuilderSessionRow {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    slug: row.slug === null || row.slug === undefined ? null : String(row.slug),
    phase: String(row.phase) as PluginBuilderSessionRow["phase"],
    stagingDir: row.staging_dir === null || row.staging_dir === undefined ? null : String(row.staging_dir),
    answers: parseJson<PluginBuilderAnswers | null>(String(row.answers_json ?? ""), null),
    gateReport: parseJson<Record<string, unknown> | null>(String(row.gate_report_json ?? ""), null),
    seed: parseJson<PluginBuilderSeed>(String(row.seed_json ?? ""), { kind: "mention", request: "" }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createPluginBuilderSession(input: {
  chatId: string;
  seed: PluginBuilderSeed;
}): PluginBuilderSessionRow {
  const id = `plugin_builder_${randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO plugin_builder_sessions
      (id, chat_id, slug, phase, staging_dir, answers_json, gate_report_json, seed_json, created_at, updated_at)
    VALUES (?, ?, NULL, 'interview', NULL, NULL, NULL, ?, ?, ?)
  `).run(id, input.chatId, JSON.stringify(input.seed), now, now);
  return getPluginBuilderSession(id)!;
}

export function getPluginBuilderSession(id: string): PluginBuilderSessionRow | null {
  const row = getDb().prepare("SELECT * FROM plugin_builder_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function listPluginBuilderSessions(chatId: string): PluginBuilderSessionRow[] {
  const rows = getDb().prepare(`
    SELECT * FROM plugin_builder_sessions
    WHERE chat_id = ? AND phase <> 'discarded'
    ORDER BY updated_at DESC
  `).all(chatId) as Array<Record<string, unknown>>;
  return rows.map(rowToSession);
}

export function listAllPluginBuilderSessions(): PluginBuilderSessionRow[] {
  const rows = getDb().prepare("SELECT * FROM plugin_builder_sessions ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
  return rows.map(rowToSession);
}

export function updatePluginBuilderSession(
  id: string,
  patch: {
    slug?: string | null;
    phase?: PluginBuilderPhase | "discarded";
    stagingDir?: string | null;
    answers?: PluginBuilderAnswers | null;
    gateReport?: Record<string, unknown> | null;
  },
): PluginBuilderSessionRow {
  const current = getPluginBuilderSession(id);
  if (!current) throw new Error(`Plugin builder session not found: ${id}`);
  const next = {
    slug: patch.slug === undefined ? current.slug : patch.slug,
    phase: patch.phase === undefined ? current.phase : patch.phase,
    stagingDir: patch.stagingDir === undefined ? current.stagingDir : patch.stagingDir,
    answers: patch.answers === undefined ? current.answers : patch.answers,
    gateReport: patch.gateReport === undefined ? current.gateReport : patch.gateReport,
  };
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE plugin_builder_sessions
    SET slug = ?, phase = ?, staging_dir = ?, answers_json = ?, gate_report_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.slug,
    next.phase,
    next.stagingDir,
    next.answers ? JSON.stringify(next.answers) : null,
    next.gateReport ? JSON.stringify(next.gateReport) : null,
    now,
    id,
  );
  return getPluginBuilderSession(id)!;
}

export function discardPluginBuilderSession(id: string): PluginBuilderSessionRow {
  return updatePluginBuilderSession(id, { phase: "discarded" });
}
