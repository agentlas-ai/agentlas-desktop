// One-time English migration of desktop memory + translate-on-write worker.
// Plan 2026-09-22-PLAN-memory-recall-repair.md, section
// "전면 영어 마이그레이션 — 데스크탑 (2026-09-23)" (D-1..D-8).
//
// Rows keep their id; `content`/`summary` becomes the English search surface and
// the original wording moves to a side table (native-text.ts). In-place, not
// "new row + supersede": desktop links experience candidates, curator decisions,
// nest projections, relation edges and forget-cleanup targets by memory id.
//
// Never on the UI/main critical path: runs from its own idle timer with the
// dreaming guards (system idle, run slots empty, one pass at a time, abort when
// the user returns). It is independent of the dreaming switch — the owner turned
// dreaming off, and this migration is a separate one-time job. Only the hard
// opt-out meta key stops it.
import { powerMonitor } from "electron";
import { looksSecret } from "../../shared/secret-patterns";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { openedStoreMigrationRole } from "../store/db";
import { getMemoryDb as getDb } from "./database";
import { getMeta, setMeta } from "../store/meta";
import { runSlotStats, runSlotsQuietForMs } from "../runtime/run-slots";
import { dreamingIdleRequiredSec } from "./curator-rules";
import { autoLocalEmbedding, cosineSimilarity, type LocalMemoryEmbedding } from "./local-embedding";
import { currentMemoryForgetEpoch, assertMemoryWriteAllowed, MemoryRevokedError } from "./revocations";
import {
  ensureNativeTextTables,
  isNonEnglishText,
  serializeNativeEmbedding,
  translationSourceHash,
  type TranslationTargetKind,
} from "./native-text";

type Db = ReturnType<typeof getDb>;

export const MIGRATION_KEY = "memory_english_migration_v1";
export const MIGRATION_SET_BY_KEY = "memory_english_migration_v1_set_by";
export const MIGRATION_SET_BY = "auto-migration-2026-09-23";
export const OPT_OUT_KEY = "memory_english_migration_opt_out";
const BUDGET_KEY = "memory_english_translate_budget";
/** One-time repair of rows/budget wasted by calls that never reached a model (value = ISO time it ran). */
export const WASTE_REPAIR_KEY = "memory_english_migration_waste_repair_v1";
const DAILY_CAP_KEY = "memory_english_translate_daily_cap";
const DEFAULT_DAILY_CAP = 400;
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 6_000;
const MAX_ATTEMPTS = 2;
/** Unparseable answers (text came back) before a row is given up. Runner failures never count. */
const MAX_CALL_FAILURES = 5;
const BATCHES_PER_TICK = 5;
const TICK_MS = 5 * 60 * 1000;
/** Wait after a real (invoked) refusal or runner failure that carries no retry hint. */
const DEFAULT_HOLD_MS = 30 * 60 * 1000;
const SWEEP_EVERY_MS = 30 * 60 * 1000;
const CALL_TIMEOUT_MS = 180_000;
/** Same floor as the engine: same-meaning KO–EN 0.420, unrelated 0.135 (plan §9-8). */
export const BACK_CHECK_FLOOR = 0.25;
const ENGLISH_MAX_CHARS = 4_000;

// ── pure checks (exported for the contract) ─────────────────────────────────
// Atoms, not compound tokens: a translation legitimately re-joins ASCII pieces
// ("49~58" → "49-58", "2인용" → "2-player", "Base64/URL/로컬파일" →
// "Base64/URL/local files"). Measured on the owner's store copy: comparing
// compound tokens rejected 12 of 40 real translations that had every
// identifier. Every atom of a path/identifier is still required.
const ASCII_ATOM_RE = /[A-Za-z0-9_]+/g;
const NUMBER_WORDS: Record<string, RegExp> = {
  "1": /\b(one|once|single)\b/i,
  "2": /\b(two|twice|both|pair)\b/i,
  "3": /\b(three|thrice|third)\b/i,
  "4": /\bfour(th)?\b/i,
  "5": /\b(five|fifth)\b/i,
  "6": /\bsix(th)?\b/i,
  "7": /\bseven(th)?\b/i,
  "8": /\beighth?\b/i,
  "9": /\bnin(e|th)\b/i,
  "10": /\bten(th)?\b/i,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Atoms a translation must carry verbatim: anything with a digit,
 * an underscore or an uppercase letter (numbers, versions, identifiers,
 * acronyms, product names, file-name stems). Plain lowercase words are ordinary
 * vocabulary a translator may inflect ("dispose" → "disposed") and are exempt.
 */
export function protectedTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of String(text ?? "").matchAll(ASCII_ATOM_RE)) {
    const atom = match[0];
    if (!/[0-9_A-Z]/.test(atom)) continue;
    counts.set(atom, (counts.get(atom) ?? 0) + 1);
  }
  return counts;
}

/** Atoms of `native` that are missing (or fewer) in `english`. Empty = preserved. */
export function missingProtectedTokens(native: string, english: string): string[] {
  const want = protectedTokens(native);
  const have = new Map<string, number>();
  const englishText = String(english ?? "");
  for (const match of englishText.matchAll(ASCII_ATOM_RE)) {
    have.set(match[0], (have.get(match[0]) ?? 0) + 1);
    // "1위" → "1st", "300회" → "300x", "5분" → "5min": the number survives with a unit.
    const unit = /^(\d+)[a-z]{1,3}$/i.exec(match[0]);
    if (unit) have.set(unit[1], (have.get(unit[1]) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const [token, count] of want) {
    // Presence, not count: a translation may merge or split a repeated mention.
    if ((have.get(token) ?? 0) > 0) continue;
    // "2인용" → "two-player" is faithful; a small count may be spelled out.
    if (NUMBER_WORDS[token]?.test(englishText)) continue;
    // "7월" → "July": a CJK month becomes a month name.
    const month = /^\d{1,2}$/.test(token) ? Number(token) : 0;
    if (month >= 1 && month <= 12 && new RegExp(`(^|[^0-9])${token}\\s*[월月]`).test(native)
      && new RegExp(`\\b${MONTHS[month - 1]}`, "i").test(englishText)) continue;
    missing.push(`${token}${count > 1 ? `×${count}` : ""}`);
  }
  return missing;
}

export type TranslationVerdict =
  | { ok: true; english: string; backCheck: number }
  | { ok: false; reason: string; backCheck?: number };

/** Every gate a translation must pass before it may replace the search surface. */
export function judgeTranslation(
  native: string,
  english: unknown,
  embed: (text: string) => LocalMemoryEmbedding = autoLocalEmbedding,
): TranslationVerdict {
  if (typeof english !== "string") return { ok: false, reason: "missing-output" };
  const text = english.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty-output" };
  if (text.length > Math.min(ENGLISH_MAX_CHARS, native.length * 4 + 200)) return { ok: false, reason: "output-too-long" };
  if (isNonEnglishText(text)) return { ok: false, reason: "output-not-english" };
  if (looksSecret(text)) return { ok: false, reason: "output-looks-secret" };
  if (missingProtectedTokens(native, text).length > 0) return { ok: false, reason: "identifier-lost" };
  const nativeVector = embed(native);
  const englishVector = embed(text);
  // A hashing fallback compares letter buckets, not meaning — across languages
  // it cannot confirm anything, so no back-check means no translation.
  if (nativeVector.degraded || englishVector.degraded) return { ok: false, reason: "back-check-unavailable" };
  const backCheck = cosineSimilarity(nativeVector.vector, englishVector.vector);
  if (!(backCheck >= BACK_CHECK_FLOOR)) return { ok: false, reason: "back-check-below-floor", backCheck };
  return { ok: true, english: text, backCheck };
}

export const TRANSLATOR_SYSTEM_PROMPT = [
  "task: translate short memory notes into English for a search index; faithful, concise, no added or dropped facts; English only",
  "copy exactly: identifiers, file names, paths, URLs, commands, flags, numbers (digits), versions, product/model names, anything in backticks; never expand acronyms or rename",
  'output: ONLY JSON {"items":[{"id":"<id>","en":"<english>"}]}, one item per input id, no fences, no commentary',
].join("\n");

/** Strict parse: one object, `items` array, ids from the batch only. */
export function parseTranslatorOutput(text: string | null, ids: ReadonlySet<string>): Map<string, string> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const result = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as { id?: unknown }).id ?? "");
    const en = (item as { en?: unknown }).en;
    if (!ids.has(id) || typeof en !== "string" || result.has(id)) continue;
    result.set(id, en);
  }
  return result;
}

// ── translator ladder ────────────────────────────────────────────────────────
export interface TranslatorChoice {
  tier: "local-model" | "cli";
  selection: RuntimeSelection;
  label: string;
}

const LOCAL_KINDS = new Set<RuntimeStatus["kind"]>(["agentlas-local", "mlx", "lmstudio"]);

/**
 * (1) the desktop local model hub (or an already-configured local server) when
 * a model is selected, (2) the signed-in CLI whose no-tools isolation is
 * release-verified, on its cheapest tier, (3) none → originals stay.
 * Codex/agy/… are not used: their no-tools capability is not verified, and the
 * owner's condition is "no tools".
 */
export function chooseTranslator(runtimes: RuntimeStatus[]): TranslatorChoice | null {
  const usable = runtimes.filter((runtime) => !runtime.signInRequired);
  const local = usable.find((runtime) => LOCAL_KINDS.has(runtime.kind) && Boolean(runtime.model));
  if (local) {
    return {
      tier: "local-model",
      selection: { kind: local.kind, backend: local.backend, source: local.source, model: local.model ?? undefined },
      label: `${local.kind}:${local.model}`,
    };
  }
  const claude = usable.find((runtime) => runtime.kind === "claude-code");
  if (claude) {
    return {
      tier: "cli",
      selection: { kind: claude.kind, backend: claude.backend, source: claude.source, model: "haiku", effort: "low" } as RuntimeSelection,
      label: "claude-code:haiku",
    };
  }
  return null;
}

// ── meta: migration record, budget, opt-out ─────────────────────────────────
export interface MigrationRecord {
  startedAt: string;
  enqueued: Record<TranslationTargetKind, number>;
  lastSweepAt: string;
  completedAt: string | null;
  lastTranslator: string | null;
  lastError: string | null;
  /** Last batch attempt (any outcome). Absent until the first one; starvation is measured from startedAt. */
  lastBatchAt?: string | null;
}

function readRecord(): MigrationRecord | null {
  try {
    const raw = getMeta(MIGRATION_KEY);
    return raw ? JSON.parse(raw) as MigrationRecord : null;
  } catch {
    return null;
  }
}

function writeRecord(record: MigrationRecord): void {
  setMeta(MIGRATION_KEY, JSON.stringify(record));
}

export function englishMigrationOptedOut(): boolean {
  return getMeta(OPT_OUT_KEY) === "1";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/*
 * ★The cap was 0 on every store that never set it: Number(null) is 0, finite and >= 0, so the
 * default never applied and every pass broke out of its loop before the first batch (owner's store
 * 2026-09-27: no cap key, 3,138 jobs attempts=0, budget meta never written). Unset means default;
 * an explicit "0" still pauses the job.
 */
function dailyCap(): number {
  const raw = getMeta(DAILY_CAP_KEY);
  if (raw == null || String(raw).trim() === "") return DEFAULT_DAILY_CAP;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_DAILY_CAP;
}

/** Calls that really started but produced nothing (aborted by a run, or the runner failed) before the day is closed. */
const NO_PROGRESS_CAP = 6;

function readBudget(): { day?: string; rows?: number; noProgress?: number } {
  try {
    return JSON.parse(getMeta(BUDGET_KEY) ?? "{}") as { day?: string; rows?: number; noProgress?: number };
  } catch {
    return {};
  }
}

function budgetUsed(): number {
  const raw = readBudget();
  return raw.day === today() ? Number(raw.rows) || 0 : 0;
}

/** Same day key as the row budget; an old record without the field counts 0. */
function noProgressToday(): number {
  const raw = readBudget();
  return raw.day === today() ? Number(raw.noProgress) || 0 : 0;
}

function writeBudget(rows: number, noProgress: number): void {
  setMeta(BUDGET_KEY, JSON.stringify({ day: today(), rows, noProgress }));
}

function spendBudget(rows: number): void {
  writeBudget(budgetUsed() + rows, noProgressToday());
}

function countNoProgress(): void {
  writeBudget(budgetUsed(), noProgressToday() + 1);
}

// ── sweep: find every untranslated non-English row ──────────────────────────
function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * Idempotent: INSERT OR IGNORE keyed by (kind, id). Rows that already have an
 * original-wording side row are born English and skipped. Returns what it added.
 */
export function sweepEnglishMigrationQueue(db: Db = getDb()): Record<TranslationTargetKind, number> {
  ensureNativeTextTables(db);
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_translation_jobs
       (target_kind, target_id, source_hash, priority, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
  );
  const added: Record<TranslationTargetKind, number> = { memory_entry: 0, memory_episode: 0, experience_candidate: 0 };
  const tasteSources = tableExists(db, "taste_draft_candidates")
    ? "AND m.id NOT IN (SELECT source_memory_id FROM taste_draft_candidates WHERE status <> 'rejected')"
    : "";
  const entries = db.prepare(
    `SELECT m.id, m.content, m.confidence FROM memory_entries m
      WHERE m.superseded_at IS NULL AND m.content <> ''
        AND m.sensitivity NOT IN ('secret','confidential')
        AND NOT EXISTS (SELECT 1 FROM memory_entry_native n WHERE n.entry_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM memory_translation_jobs j
                         WHERE j.target_kind = 'memory_entry' AND j.target_id = m.id)
        ${tasteSources}`,
  ).all() as Array<{ id: string; content: string; confidence: string }>;
  const episodes = db.prepare(
    `SELECT e.episode_id AS id, e.summary AS content FROM memory_episodes e
      WHERE e.summary IS NOT NULL AND e.summary <> ''
        AND NOT EXISTS (SELECT 1 FROM memory_episode_quarantines q WHERE q.ticket_id = e.ticket_id)
        AND NOT EXISTS (SELECT 1 FROM memory_episode_native n WHERE n.episode_id = e.episode_id)
        AND NOT EXISTS (SELECT 1 FROM memory_translation_jobs j
                         WHERE j.target_kind = 'memory_episode' AND j.target_id = e.episode_id)`,
  ).all() as Array<{ id: string; content: string }>;
  const candidates = tableExists(db, "experience_candidates")
    ? db.prepare(
        `SELECT c.id, c.summary AS content FROM experience_candidates c
          WHERE c.status <> 'rejected' AND c.summary <> ''
            AND NOT EXISTS (SELECT 1 FROM experience_candidate_native n WHERE n.candidate_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM memory_translation_jobs j
                             WHERE j.target_kind = 'experience_candidate' AND j.target_id = c.id)
            ${tableExists(db, "experience_cloud_uploads") ? "AND NOT EXISTS (SELECT 1 FROM experience_cloud_uploads u WHERE u.pack_id = c.pack_id)" : ""}
            ${tableExists(db, "experience_public_projections") ? "AND NOT EXISTS (SELECT 1 FROM experience_public_projections p WHERE p.pack_id = c.pack_id)" : ""}`,
      ).all() as Array<{ id: string; content: string }>
    : [];
  const confidencePriority: Record<string, number> = { high: 3, medium: 2, low: 1 };
  db.transaction(() => {
    for (const row of entries) {
      if (!isNonEnglishText(row.content) || looksSecret(row.content)) continue;
      added.memory_entry += insert.run("memory_entry", row.id, translationSourceHash(row.content),
        (confidencePriority[row.confidence] ?? 0), now, now).changes;
    }
    for (const row of episodes) {
      if (!isNonEnglishText(row.content) || looksSecret(row.content)) continue;
      added.memory_episode += insert.run("memory_episode", row.id, translationSourceHash(row.content), 0, now, now).changes;
    }
    for (const row of candidates) {
      if (!isNonEnglishText(row.content) || looksSecret(row.content)) continue;
      added.experience_candidate += insert.run("experience_candidate", row.id, translationSourceHash(row.content), 0, now, now).changes;
    }
  }).immediate();
  return added;
}

/**
 * One-time repair of damage from calls that never reached a model: rows given up as
 * translator-unavailable, attempts burned by invalid-output, and today's cap spent on
 * aborted batches. Guarded by a meta key, so a second run changes nothing. Other reasons
 * (identifier-lost, source-changed-or-gone, sensitive, ...) are real verdicts and stay.
 */
export function repairEnglishMigrationWaste(db: Db = getDb(), log: (line: string) => void = (line) => console.info(line)):
  { revived: number; attemptsReset: number } | null {
  if (getMeta(WASTE_REPAIR_KEY)) return null;
  ensureNativeTextTables(db);
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const revived = db.prepare(
      `UPDATE memory_translation_jobs SET state = 'pending', attempts = 0, reason = NULL, updated_at = ?
        WHERE state = 'kept_native' AND reason = 'translator-unavailable'`,
    ).run(now).changes;
    const attemptsReset = db.prepare(
      `UPDATE memory_translation_jobs SET attempts = 0, updated_at = ?
        WHERE state = 'pending' AND reason = 'invalid-output' AND attempts <> 0`,
    ).run(now).changes;
    return { revived, attemptsReset };
  }).immediate();
  writeBudget(0, 0);
  setMeta(WASTE_REPAIR_KEY, now);
  log(`[english-memory] waste repair: revived=${result.revived} attemptsReset=${result.attemptsReset} budgetReset=today`);
  return result;
}

/**
 * The one-time desktop meta auto-migration. Records provenance once; later
 * calls only re-sweep (translate-on-write safety net) and never reset progress.
 */
export function ensureEnglishMigration(db: Db = getDb()): MigrationRecord | null {
  if (englishMigrationOptedOut()) return readRecord();
  const added = sweepEnglishMigrationQueue(db);
  repairEnglishMigrationWaste(db);
  const now = new Date().toISOString();
  const existing = readRecord();
  const record: MigrationRecord = existing
    ? {
        ...existing,
        enqueued: {
          memory_entry: (existing.enqueued?.memory_entry ?? 0) + added.memory_entry,
          memory_episode: (existing.enqueued?.memory_episode ?? 0) + added.memory_episode,
          experience_candidate: (existing.enqueued?.experience_candidate ?? 0) + added.experience_candidate,
        },
        lastSweepAt: now,
        completedAt: pendingCount(db) === 0 ? existing.completedAt ?? now : null,
      }
    : {
        startedAt: now,
        enqueued: added,
        lastSweepAt: now,
        completedAt: pendingCount(db) === 0 ? now : null,
        lastTranslator: null,
        lastError: null,
      };
  writeRecord(record);
  if (!existing) setMeta(MIGRATION_SET_BY_KEY, MIGRATION_SET_BY);
  return record;
}

function pendingCount(db: Db): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS n FROM memory_translation_jobs WHERE state = 'pending'",
  ).get() as { n: number }).n);
}

export interface EnglishMigrationStatus {
  optedOut: boolean;
  record: MigrationRecord | null;
  jobs: Array<{ kind: string; state: string; count: number }>;
  keptNativeReasons: Array<{ reason: string; count: number }>;
  budget: { day: string; used: number; cap: number };
}

export function getEnglishMigrationStatus(): EnglishMigrationStatus {
  const db = getDb();
  ensureNativeTextTables(db);
  return {
    optedOut: englishMigrationOptedOut(),
    record: readRecord(),
    jobs: db.prepare(
      `SELECT target_kind AS kind, state, COUNT(*) AS count FROM memory_translation_jobs
        GROUP BY target_kind, state ORDER BY target_kind, state`,
    ).all() as EnglishMigrationStatus["jobs"],
    keptNativeReasons: db.prepare(
      `SELECT COALESCE(reason, '-') AS reason, COUNT(*) AS count FROM memory_translation_jobs
        WHERE state = 'kept_native' GROUP BY reason ORDER BY count DESC`,
    ).all() as EnglishMigrationStatus["keptNativeReasons"],
    budget: { day: today(), used: budgetUsed(), cap: dailyCap() },
  };
}

// ── a batch ──────────────────────────────────────────────────────────────────
interface Job {
  kind: TranslationTargetKind;
  id: string;
  sourceHash: string;
  attempts: number;
}

interface LoadedJob extends Job {
  text: string;
  sensitivity: string | null;
}

function loadText(db: Db, job: Job): LoadedJob | null {
  if (job.kind === "memory_entry") {
    const row = db.prepare(
      "SELECT content, sensitivity, superseded_at FROM memory_entries WHERE id = ?",
    ).get(job.id) as { content: string; sensitivity: string; superseded_at: string | null } | undefined;
    if (!row || row.superseded_at || !row.content) return null;
    return { ...job, text: row.content, sensitivity: row.sensitivity };
  }
  if (job.kind === "memory_episode") {
    const row = db.prepare("SELECT summary FROM memory_episodes WHERE episode_id = ?").get(job.id) as
      { summary: string | null } | undefined;
    if (!row?.summary) return null;
    return { ...job, text: row.summary, sensitivity: null };
  }
  const row = db.prepare("SELECT summary, sensitivity, status FROM experience_candidates WHERE id = ?").get(job.id) as
    { summary: string; sensitivity: string; status: string } | undefined;
  if (!row || row.status === "rejected" || !row.summary) return null;
  return { ...job, text: row.summary, sensitivity: row.sensitivity };
}

function finishJob(
  db: Db,
  job: Job,
  state: "translated" | "kept_native" | "pending",
  fields: { reason?: string | null; translator?: string | null; backCheck?: number | null; englishHash?: string | null; attempt?: boolean },
): void {
  db.prepare(
    `UPDATE memory_translation_jobs
        SET state = ?, reason = ?, translator = COALESCE(?, translator), back_check = COALESCE(?, back_check),
            english_hash = COALESCE(?, english_hash), attempts = attempts + ?, updated_at = ?
      WHERE target_kind = ? AND target_id = ?`,
  ).run(
    state,
    fields.reason ?? null,
    fields.translator ?? null,
    fields.backCheck ?? null,
    fields.englishHash ?? null,
    fields.attempt ? 1 : 0,
    new Date().toISOString(),
    job.kind,
    job.id,
  );
}

function embeddingColumns(embedding: LocalMemoryEmbedding): unknown[] {
  return [
    embedding.model,
    embedding.adapter,
    embedding.modelSha256,
    embedding.contentHash,
    embedding.dimensions,
    JSON.stringify(embedding.vector),
  ];
}

/**
 * Swap the search surface to English and move the original to its side table,
 * atomically, only if the row is exactly what was translated (hash) and still
 * live. A forget that happened while the model was answering wins.
 */
export function applyTranslation(
  db: Db,
  job: LoadedJob,
  english: string,
  meta: { translator: string; backCheck: number | null; intakeEpoch: number | null },
): "translated" | "stale" | "forgotten" {
  const now = new Date().toISOString();
  const embedding = autoLocalEmbedding(english);
  return db.transaction((): "translated" | "stale" | "forgotten" => {
    const current = loadText(db, job);
    if (!current || translationSourceHash(current.text) !== job.sourceHash) return "stale";
    if (job.kind === "memory_entry") {
      const row = db.prepare(
        `SELECT scope, kind, project_id, project_path, agent_id, chat_id FROM memory_entries WHERE id = ?`,
      ).get(job.id) as { scope: string; kind: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null };
      try {
        assertMemoryWriteAllowed({
          scope: row.scope as never,
          kind: row.kind as never,
          content: english,
          projectId: row.project_id,
          projectPath: row.project_path,
          agentId: row.agent_id,
          chatId: row.chat_id,
          intakeEpoch: meta.intakeEpoch,
        });
      } catch (error) {
        if (error instanceof MemoryRevokedError) return "forgotten";
        throw error;
      }
      db.prepare(
        `UPDATE memory_entries
            SET content = ?, embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
                embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE id = ?`,
      ).run(english, ...embeddingColumns(embedding), job.id);
      const nativeText = current.text.slice(0, 4_000);
      db.prepare(
        `INSERT OR REPLACE INTO memory_entry_native (entry_id, content_native, created_at, native_embedding)
         VALUES (?, ?, ?, ?)`,
      ).run(job.id, nativeText, now, serializeNativeEmbedding(autoLocalEmbedding(nativeText)));
    } else if (job.kind === "memory_episode") {
      db.prepare(
        `UPDATE memory_episodes
            SET summary = ?, summary_hash = ?, embedding_model = ?, embedding_adapter = ?,
                embedding_model_sha256 = ?, embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE episode_id = ?`,
      ).run(english, translationSourceHash(english), ...embeddingColumns(embedding), job.id);
      db.prepare(
        `INSERT OR REPLACE INTO memory_episode_native (episode_id, summary_native, created_at, native_embedding)
         VALUES (?, ?, ?, ?)`,
      ).run(job.id, current.text, now, serializeNativeEmbedding(autoLocalEmbedding(current.text)));
    } else {
      db.prepare(
        `UPDATE experience_candidates
            SET summary = ?, embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
                embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE id = ?`,
      ).run(english, ...embeddingColumns(embedding), job.id);
      db.prepare(
        `INSERT OR REPLACE INTO experience_candidate_native (candidate_id, summary_native, created_at, native_embedding)
         VALUES (?, ?, ?, ?)`,
      ).run(job.id, current.text, now, serializeNativeEmbedding(autoLocalEmbedding(current.text)));
    }
    finishJob(db, job, "translated", {
      translator: meta.translator,
      backCheck: meta.backCheck,
      englishHash: translationSourceHash(english),
      attempt: true,
    });
    return "translated";
  }).immediate();
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Most experience candidates are verbatim copies of a memory's text. When that
 * memory was already translated, reuse its English (no model call). The copy
 * must be exact; anything else goes to the model like any other row.
 */
function reuseMemoryTranslation(db: Db, job: LoadedJob): string | null {
  if (job.kind !== "experience_candidate") return null;
  const row = db.prepare(
    `SELECT m.content AS english, n.content_native AS native FROM experience_candidates c
       JOIN memory_entries m ON m.id = c.source_memory_id
       JOIN memory_entry_native n ON n.entry_id = m.id
      WHERE c.id = ? AND m.superseded_at IS NULL AND m.content <> ''`,
  ).get(job.id) as { english: string; native: string } | undefined;
  if (!row || normalized(row.native) !== normalized(job.text)) return null;
  return row.english;
}

export interface BatchReceipt {
  /** Rows the model actually answered for (a parse failure is an answer). Only these count against the daily cap. */
  attempted: number;
  translated: number;
  reused: number;
  keptNative: number;
  stale: number;
  translator: string | null;
  elapsedMs: number;
  failure?: string;
  /** Provider/judgment retry hint (ISO time or "in 30s") when the call was held back; the tick turns it into a wait. */
  retryAfterHint?: string;
  /** A model run really happened for the refused/failed call; without a hint the tick then waits DEFAULT_HOLD_MS. */
  invoked?: boolean;
  /** The call really started and produced nothing (aborted by a run, or the runner failed): counted toward the day's no-progress cap. */
  noProgress?: boolean;
}

/** Why a call produced no answer that says anything about the rows. Machine fields only; prose is never parsed. */
export type TranslateCallCause = "cooldown" | "quota" | "rate_limit" | "unavailable";

export interface TranslateCallResult {
  text: string | null;
  /** The model was really called (judgment runtimeReceipt.execution === "invoked"). */
  invoked: boolean;
  cause?: TranslateCallCause;
  retryAfterHint?: string;
}

/** A plain string / null (older fakes) means "invoked; this is the answer". */
export type TranslateCall = (input: {
  systemPrompt: string;
  input: string;
  selection: RuntimeSelection;
  signal?: AbortSignal;
}) => Promise<string | null | TranslateCallResult>;

function normalizeTranslateResult(raw: string | null | TranslateCallResult): TranslateCallResult {
  if (raw === null || typeof raw === "string") return { text: raw, invoked: true };
  return raw;
}

/** Row-neutral causes from the judgment result: typed failure + runtime receipt, never the message text. */
export function translateResultFromJudgment(result: {
  text: string | null;
  failure?: { kind?: string; providerCode?: string; retryAfterHint?: string };
  runtimeReceipt?: { execution?: string };
  attempts?: Array<{ runtimeReceipt?: { execution?: string } }>;
}): TranslateCallResult {
  if (result.text !== null && result.text !== undefined) return { text: result.text, invoked: true };
  const invoked = (result.attempts ?? []).some((attempt) => attempt.runtimeReceipt?.execution === "invoked")
    || result.runtimeReceipt?.execution === "invoked";
  const failure = result.failure;
  const hint = typeof failure?.retryAfterHint === "string" && failure.retryAfterHint ? { retryAfterHint: failure.retryAfterHint } : {};
  if (!invoked) {
    // Nothing reached a model: never the row's fault, whatever the reason.
    const cause: TranslateCallCause = failure?.providerCode === "judgment_runtime_cooldown" ? "cooldown"
      : failure?.kind === "quota" ? "quota"
      : failure?.kind === "rate_limit" ? "rate_limit" : "unavailable";
    return { text: null, invoked: false, cause, ...hint };
  }
  if (failure?.kind === "quota") return { text: null, invoked: true, cause: "quota", ...hint };
  if (failure?.kind === "rate_limit") return { text: null, invoked: true, cause: "rate_limit", ...hint };
  if (failure?.kind === "unavailable" || failure?.kind === "auth") return { text: null, invoked: true, cause: "unavailable", ...hint };
  return { text: null, invoked: true };
}

async function defaultTranslateCall(input: Parameters<TranslateCall>[0]): Promise<TranslateCallResult> {
  const { callConnectedModelDetailed } = await import("../system-agents/judgment");
  const result = await callConnectedModelDetailed({
    systemPrompt: input.systemPrompt,
    input: input.input,
    timeoutMs: CALL_TIMEOUT_MS,
    signal: input.signal,
    locale: "en",
    runtimeSelection: input.selection,
    requireNoTools: true,
  });
  return translateResultFromJudgment(result);
}

async function defaultRuntimes(): Promise<RuntimeStatus[]> {
  const { detectRuntimes } = await import("../runtime/detect");
  return detectRuntimes();
}

/**
 * One batch: pending jobs by priority, candidates reuse memory translations,
 * the rest go to the translator in one strict-JSON call. Resumable: every
 * decision is committed per row; an interrupted batch leaves rows pending.
 */
export async function runEnglishMigrationBatch(options: {
  db?: Db;
  signal?: AbortSignal;
  maxItems?: number;
  runtimes?: () => Promise<RuntimeStatus[]>;
  translate?: TranslateCall;
  translator?: TranslatorChoice | null;
} = {}): Promise<BatchReceipt> {
  const started = Date.now();
  const db = options.db ?? getDb();
  ensureNativeTextTables(db);
  const receipt: BatchReceipt = { attempted: 0, translated: 0, reused: 0, keptNative: 0, stale: 0, translator: null, elapsedMs: 0 };
  const limit = Math.max(1, Math.min(BATCH_MAX_ITEMS, options.maxItems ?? BATCH_MAX_ITEMS));
  const jobs = db.prepare(
    `SELECT target_kind AS kind, target_id AS id, source_hash AS sourceHash, attempts
       FROM memory_translation_jobs
      WHERE state = 'pending'
      ORDER BY CASE target_kind WHEN 'memory_entry' THEN 0 WHEN 'experience_candidate' THEN 1 ELSE 2 END,
               priority DESC,
               CASE WHEN updated_at > created_at THEN updated_at ELSE '' END ASC, created_at DESC
      LIMIT ?`,
  ).all(limit * 3) as Job[];

  const toModel: LoadedJob[] = [];
  let chars = 0;
  for (const job of jobs) {
    if (options.signal?.aborted) break;
    const loaded = loadText(db, job);
    if (!loaded || translationSourceHash(loaded.text) !== job.sourceHash) {
      finishJob(db, job, "kept_native", { reason: "source-changed-or-gone" });
      receipt.stale += 1;
      continue;
    }
    if (!isNonEnglishText(loaded.text)) {
      finishJob(db, job, "kept_native", { reason: "already-english" });
      continue;
    }
    if (loaded.sensitivity === "secret" || loaded.sensitivity === "confidential" || looksSecret(loaded.text)) {
      finishJob(db, job, "kept_native", { reason: "sensitive" });
      receipt.keptNative += 1;
      continue;
    }
    const reused = reuseMemoryTranslation(db, loaded);
    if (reused) {
      const verdict = judgeTranslation(loaded.text, reused);
      if (verdict.ok && applyTranslation(db, loaded, verdict.english, {
        translator: "reuse:memory_entry",
        backCheck: verdict.backCheck,
        intakeEpoch: null,
      }) === "translated") {
        receipt.reused += 1;
        continue;
      }
    }
    if (toModel.length >= limit || chars + loaded.text.length > BATCH_MAX_CHARS) continue;
    toModel.push(loaded);
    chars += loaded.text.length;
  }
  if (toModel.length === 0 || options.signal?.aborted) {
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }

  const translator = options.translator !== undefined
    ? options.translator
    : chooseTranslator(await (options.runtimes ?? defaultRuntimes)());
  if (!translator) {
    // Rung 3: nothing to translate with. Rows stay pending (not failed) — a
    // later install/sign-in picks them up; recall keeps working on originals.
    receipt.failure = "no-translator";
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }
  receipt.translator = translator.label;
  const shortIds = new Map(toModel.map((job, index) => [String(index + 1), job]));
  const intakeEpoch = currentMemoryForgetEpoch();
  let output: string | null = null;
  let call: TranslateCallResult = { text: null, invoked: true };
  try {
    call = normalizeTranslateResult(await (options.translate ?? defaultTranslateCall)({
      systemPrompt: TRANSLATOR_SYSTEM_PROMPT,
      input: JSON.stringify({ items: [...shortIds].map(([id, job]) => ({ id, text: job.text })) }),
      selection: translator.selection,
      signal: options.signal,
    }));
    output = call.text;
  } catch {
    // A call that threw produced no text: handled below like any runner failure.
    call = { text: null, invoked: true };
  }
  if (options.signal?.aborted) {
    // Interrupted by a run taking a slot: the rows stay as they were and spend nothing.
    const reason = options.signal.reason instanceof Error ? options.signal.reason.message : "aborted";
    receipt.failure = `aborted:${reason}`.slice(0, 100);
    receipt.noProgress = true;
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }
  if (output === null && (!call.invoked || call.cause)) {
    // Not called, or the provider refused (cooldown/quota/rate limit/unavailable): not the rows' fault.
    // Rows, attempts and the daily cap stay untouched; the tick stops and waits out the hint.
    receipt.failure = `translator-${(call.cause ?? "unavailable").replace("_", "-")}`;
    receipt.invoked = call.invoked;
    if (call.retryAfterHint) receipt.retryAfterHint = call.retryAfterHint;
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }
  if (output === null) {
    // The runner was invoked but produced no text (exit, timeout, refused, empty, threw): the runner's failure, not
    // the rows'. Rows and attempts stay; the tick stops and waits. The run was real, so the cap (a cost cap) counts it.
    receipt.attempted = toModel.length;
    receipt.failure = "translator-failed";
    receipt.invoked = true;
    receipt.noProgress = true;
    // Rotate: a batch that keeps killing the runner goes behind the others (attempts and state untouched, rows never given up).
    const rotatedAt = new Date().toISOString();
    const touch = db.prepare("UPDATE memory_translation_jobs SET updated_at = ? WHERE target_kind = ? AND target_id = ?");
    db.transaction(() => { for (const job of toModel) touch.run(rotatedAt, job.kind, job.id); })();
    if (call.retryAfterHint) receipt.retryAfterHint = call.retryAfterHint;
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }
  // Text came back: from here a failure is the rows' (and counts against the cap).
  receipt.attempted = toModel.length;
  const parsed = parseTranslatorOutput(output, new Set(shortIds.keys()));
  if (!parsed) {
    // Unparseable answer: count the attempt; give up on a row only after repeated failures.
    for (const job of toModel) {
      const exhausted = job.attempts + 1 >= MAX_CALL_FAILURES;
      finishJob(db, job, exhausted ? "kept_native" : "pending", {
        reason: exhausted ? "translator-unavailable" : "invalid-output",
        translator: translator.label,
        attempt: true,
      });
    }
    receipt.failure = "invalid-output";
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }
  for (const [shortId, job] of shortIds) {
    const verdict = judgeTranslation(job.text, parsed.get(shortId));
    if (!verdict.ok) {
      const retry = job.attempts + 1 < MAX_ATTEMPTS && verdict.reason !== "back-check-unavailable";
      finishJob(db, job, retry ? "pending" : "kept_native", {
        reason: verdict.reason,
        translator: translator.label,
        backCheck: verdict.backCheck ?? null,
        attempt: true,
      });
      if (!retry) receipt.keptNative += 1;
      continue;
    }
    const outcome = applyTranslation(db, job, verdict.english, {
      translator: translator.label,
      backCheck: verdict.backCheck,
      intakeEpoch,
    });
    if (outcome === "translated") receipt.translated += 1;
    else {
      finishJob(db, job, "kept_native", { reason: outcome === "forgotten" ? "forgotten-during-translation" : "source-changed-or-gone" });
      receipt.stale += 1;
    }
  }
  receipt.elapsedMs = Date.now() - started;
  return receipt;
}

// ── scheduler ────────────────────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSweepAt = 0;
let lastGateLogAt = 0;
/** Wait set by a cooldown/quota/rate-limit hint. In memory only: after a restart the first tick asks again, and a refused ask costs no model call. */
let translatorHoldUntil = 0;

/*
 * ★Starvation (measured 2026-09-27 on the owner's machine): 3,138 jobs, every one attempts=0 since
 * 2026-09-23. The pass needed 10 minutes of *system* HID idle, but Codex Computer Use and a
 * remote-desktop tool assert UserIsActive (pmset log), so "the owner is away" was never observed
 * while agents drove the machine — and no gate said so. Two changes, both still yield to runs:
 *  - every blocked tick names its gate in one log line, at most once an hour;
 *  - after STARVED_AFTER_MS without a batch, a quiet-window pass may run when this app has had no
 *    run in a slot for APP_QUIET_MS: one small batch, aborted the moment any run takes a slot.
 * Run slots in use or queued always block, in both modes — this job never contends with a run.
 */
const STARVED_AFTER_MS = 6 * 60 * 60 * 1000;
const APP_QUIET_MS = 10 * 60 * 1000;
const QUIET_WINDOW_MAX_ITEMS = 10;
const GATE_LOG_EVERY_MS = 60 * 60 * 1000;

export type EnglishMigrationGate =
  | "not_store_owner" | "opted_out" | "nothing_pending" | "daily_cap_reached"
  | "runs_active" | "dreaming_running" | "system_not_idle" | "app_not_quiet" | "translator_hold" | "no_progress_cap";

export interface EnglishMigrationTickEnv {
  now(): number;
  idleSeconds(): number;
  slots(): { inUse: number; queued: number };
  slotsQuietForMs(): number;
  dreamingRunning(): Promise<boolean>;
  runtimes(): Promise<RuntimeStatus[]>;
  translate?: TranslateCall;
  log(line: string): void;
}

export interface EnglishMigrationTickReceipt {
  gate: EnglishMigrationGate | "already_running" | null;
  mode: "idle" | "quiet-window" | null;
  batches: number;
}

function idleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0;
  }
}

const defaultTickEnv: EnglishMigrationTickEnv = {
  now: () => Date.now(),
  idleSeconds,
  slots: () => runSlotStats(),
  slotsQuietForMs: () => runSlotsQuietForMs(),
  dreamingRunning,
  runtimes: defaultRuntimes,
  log: (line) => console.info(line),
};

/** Which gate holds the pass now, and in which mode it may run otherwise. Reads meta; no writes. */
export async function englishMigrationGate(env: EnglishMigrationTickEnv, pending: number):
  Promise<{ gate: EnglishMigrationGate | null; mode: "idle" | "quiet-window" | null; starved: boolean }> {
  const hold = (gate: EnglishMigrationGate, starved = false) => ({ gate, mode: null, starved });
  if (openedStoreMigrationRole() !== "owner") return hold("not_store_owner");
  if (englishMigrationOptedOut()) return hold("opted_out");
  if (pending <= 0) return hold("nothing_pending");
  if (dailyCap() - budgetUsed() <= 0) return hold("daily_cap_reached");
  if (noProgressToday() >= NO_PROGRESS_CAP) return hold("no_progress_cap");
  if (env.now() < translatorHoldUntil) return hold("translator_hold");
  const slots = env.slots();
  if (slots.inUse > 0 || slots.queued > 0) return hold("runs_active");
  if (await env.dreamingRunning()) return hold("dreaming_running");
  const record = readRecord();
  const lastProgress = Date.parse(record?.lastBatchAt ?? record?.startedAt ?? "");
  const starved = Number.isFinite(lastProgress) && env.now() - lastProgress >= STARVED_AFTER_MS;
  if (env.idleSeconds() >= dreamingIdleRequiredSec()) return { gate: null, mode: "idle", starved };
  if (!starved) return hold("system_not_idle");
  if (env.slotsQuietForMs() < APP_QUIET_MS) return hold("app_not_quiet", true);
  return { gate: null, mode: "quiet-window", starved };
}

/** One scheduler tick. The timer calls it with the real environment; the contract fakes idle and slots. */
export async function runEnglishMigrationTick(overrides: Partial<EnglishMigrationTickEnv> = {}): Promise<EnglishMigrationTickReceipt> {
  const env: EnglishMigrationTickEnv = { ...defaultTickEnv, ...overrides };
  if (running) return { gate: "already_running", mode: null, batches: 0 };
  const pending = openedStoreMigrationRole() === "owner" ? pendingCount(getDb()) : 0;
  const decision = await englishMigrationGate(env, pending);
  if (decision.gate) {
    if (decision.gate !== "nothing_pending" && decision.gate !== "not_store_owner"
      && env.now() - lastGateLogAt >= GATE_LOG_EVERY_MS) {
      lastGateLogAt = env.now();
      const slots = env.slots();
      env.log(`[english-memory] waiting gate=${decision.gate} pending=${pending} idle=${Math.round(env.idleSeconds())}s `
        + `slots=${slots.inUse}/${slots.queued} appQuiet=${Math.round(env.slotsQuietForMs() / 60_000)}m starved=${decision.starved ? "yes" : "no"}`);
    }
    return { gate: decision.gate, mode: null, batches: 0 };
  }
  const quietWindow = decision.mode === "quiet-window";
  running = true;
  let batches = 0;
  const controller = new AbortController();
  // A run taking a slot aborts the call (this job never competes with a run). The owner coming back does not: the call
  // in flight finishes and its result is applied; only the next batch is not started.
  let userReturned = false;
  const watchdog = setInterval(() => {
    const slots = env.slots();
    if (slots.inUse > 0 || slots.queued > 0) controller.abort(new Error("run-started"));
    else if (!quietWindow && env.idleSeconds() < 30) userReturned = true;
  }, quietWindow ? 2_000 : 15_000);
  watchdog.unref?.();
  try {
    if (env.now() - lastSweepAt > SWEEP_EVERY_MS) {
      ensureEnglishMigration();
      lastSweepAt = env.now();
    }
    const translatorChoice = chooseTranslator(await env.runtimes());
    const maxBatches = quietWindow ? 1 : BATCHES_PER_TICK;
    for (let index = 0; index < maxBatches && !controller.signal.aborted && !userReturned; index += 1) {
      const remaining = dailyCap() - budgetUsed();
      if (remaining <= 0) break;
      const receipt = await runEnglishMigrationBatch({
        signal: controller.signal,
        maxItems: Math.min(quietWindow ? QUIET_WINDOW_MAX_ITEMS : BATCH_MAX_ITEMS, remaining),
        translator: translatorChoice,
        ...(env.translate ? { translate: env.translate } : {}),
      });
      batches += 1;
      spendBudget(receipt.attempted + receipt.reused);
      const record = readRecord();
      if (record) {
        const db = getDb();
        writeRecord({
          ...record,
          lastBatchAt: new Date(env.now()).toISOString(),
          lastTranslator: receipt.translator ?? record.lastTranslator,
          lastError: receipt.failure ?? null,
          completedAt: pendingCount(db) === 0 ? record.completedAt ?? new Date().toISOString() : null,
        });
      }
      if (receipt.noProgress) {
        countNoProgress();
        // An aborted call waits like a failed one: the next tick must not start another real call right away.
        if (receipt.failure?.startsWith("aborted:")) translatorHoldUntil = env.now() + DEFAULT_HOLD_MS;
      }
      const heldFailure = receipt.failure !== undefined && /^(translator-(cooldown|quota|rate-limit|unavailable|failed)|aborted:)/.test(receipt.failure);
      if (heldFailure && receipt.failure?.startsWith("translator-")) {
        // The hint when there is one; otherwise a real call that failed waits a default (a not-invoked ask is free: next tick).
        const waitUntil = parseRetryHint(receipt.retryAfterHint, env.now());
        if (waitUntil > 0) translatorHoldUntil = waitUntil;
        else if (receipt.invoked) translatorHoldUntil = env.now() + DEFAULT_HOLD_MS;
      }
      if (heldFailure) {
        // Same hourly cadence as the gate line: a cooldown must not repeat its line every tick.
        if (env.now() - lastGateLogAt >= GATE_LOG_EVERY_MS) {
          lastGateLogAt = env.now();
          env.log(`[english-memory] ${JSON.stringify({ ...receipt, mode: decision.mode })}`);
        }
      } else if (receipt.translated + receipt.reused > 0 || receipt.failure) {
        env.log(`[english-memory] ${JSON.stringify({ ...receipt, mode: decision.mode })}`);
      }
      if (receipt.failure || receipt.attempted + receipt.reused + receipt.stale === 0) break;
    }
  } catch (error) {
    console.error("[english-memory] pass failed:", error);
  } finally {
    clearInterval(watchdog);
    running = false;
  }
  return { gate: null, mode: decision.mode, batches };
}

/** Absolute wait-until (ms) from a retry hint: ISO time or "in 30s/5m/2h". 0 = no usable hint. Capped at a day. */
function parseRetryHint(hint: string | undefined, now: number): number {
  if (!hint) return 0;
  let until = Date.parse(hint);
  if (!Number.isFinite(until)) {
    const match = /^in\s+(\d+(?:\.\d+)?)\s*(s|m|h)/i.exec(hint.trim());
    if (!match) return 0;
    until = now + Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000 } as Record<string, number>)[match[2].toLowerCase()];
  }
  return until > now ? Math.min(until, now + 24 * 60 * 60 * 1000) : 0;
}

/** Test seam: forget the in-memory hold, as a restart does. */
export function resetEnglishMigrationHoldForTests(): void {
  translatorHoldUntil = 0;
  lastGateLogAt = 0;
}

async function dreamingRunning(): Promise<boolean> {
  try {
    const { getDreamingStatus } = await import("./dreaming");
    return getDreamingStatus().running;
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  await runEnglishMigrationTick();
}

/**
 * Boot: start the idle worker and, off the startup path, record the one-time
 * migration (the sweep reads every memory row once). Never throws.
 */
export function startEnglishMemoryMigration(): void {
  if (timer) return;
  // A test profile (AGENTLAS_E2E) does not start this worker by itself: with no local model ready its translator is the person's own
  // Claude CLI, and an isolated test app must not spend that subscription. A test that wants the worker sets AGENTLAS_E2E_ENGLISH_MIGRATION=1;
  // the passes below (runEnglishMigrationTick and under it) are unchanged and run with fakes.
  if (process.env.AGENTLAS_E2E === "1" && process.env.AGENTLAS_E2E_ENGLISH_MIGRATION !== "1") return;
  const enqueue = setTimeout(() => {
    try {
      if (openedStoreMigrationRole() === "owner" && !englishMigrationOptedOut()) {
        ensureEnglishMigration();
        lastSweepAt = Date.now();
      }
    } catch (error) {
      console.error("[english-memory] enqueue failed:", error);
    }
  }, 90_000);
  enqueue.unref?.();
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
}

export function stopEnglishMemoryMigration(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
