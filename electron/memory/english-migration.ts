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
import { getDb, openedStoreMigrationRole } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { runSlotStats } from "../runtime/run-slots";
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
const DAILY_CAP_KEY = "memory_english_translate_daily_cap";
const DEFAULT_DAILY_CAP = 400;
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 6_000;
const MAX_ATTEMPTS = 2;
/** Whole-call failures (runtime outage, unparseable output) before a row is given up. */
const MAX_CALL_FAILURES = 5;
const BATCHES_PER_TICK = 5;
const TICK_MS = 5 * 60 * 1000;
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
  "You translate short memory notes into English for a search index.",
  "Translate the meaning faithfully and concisely. Do not add, drop or explain facts.",
  "Copy every ASCII token exactly as written: identifiers, file names and paths, URLs, commands, flags,",
  "numbers, versions, product and model names, and anything inside backticks — same spelling and case.",
  "Write numbers as digits, as in the source. Never expand an acronym or rename an identifier.",
  "Output English only.",
  'Return ONLY JSON: {"items":[{"id":"<id>","en":"<english>"}]} with exactly one item per input id.',
  "No markdown fences, no commentary.",
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

function dailyCap(): number {
  const configured = Number(getMeta(DAILY_CAP_KEY));
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_DAILY_CAP;
}

function budgetUsed(): number {
  try {
    const raw = JSON.parse(getMeta(BUDGET_KEY) ?? "{}") as { day?: string; rows?: number };
    return raw.day === today() ? Number(raw.rows) || 0 : 0;
  } catch {
    return 0;
  }
}

function spendBudget(rows: number): void {
  setMeta(BUDGET_KEY, JSON.stringify({ day: today(), rows: budgetUsed() + rows }));
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
 * The one-time desktop meta auto-migration. Records provenance once; later
 * calls only re-sweep (translate-on-write safety net) and never reset progress.
 */
export function ensureEnglishMigration(db: Db = getDb()): MigrationRecord | null {
  if (englishMigrationOptedOut()) return readRecord();
  const added = sweepEnglishMigrationQueue(db);
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
  attempted: number;
  translated: number;
  reused: number;
  keptNative: number;
  stale: number;
  translator: string | null;
  elapsedMs: number;
  failure?: string;
}

export type TranslateCall = (input: {
  systemPrompt: string;
  input: string;
  selection: RuntimeSelection;
  signal?: AbortSignal;
}) => Promise<string | null>;

async function defaultTranslateCall(input: Parameters<TranslateCall>[0]): Promise<string | null> {
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
  return result.text;
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
               priority DESC, created_at DESC
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
  // Rows sent to a model count against the daily cap whether or not it answered.
  receipt.attempted = toModel.length;
  let output: string | null = null;
  try {
    output = await (options.translate ?? defaultTranslateCall)({
      systemPrompt: TRANSLATOR_SYSTEM_PROMPT,
      input: JSON.stringify({ items: [...shortIds].map(([id, job]) => ({ id, text: job.text })) }),
      selection: translator.selection,
      signal: options.signal,
    });
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message.slice(0, 200) : "translator-error";
  }
  if (options.signal?.aborted) {
    receipt.elapsedMs = Date.now() - started;
    return receipt;
  }
  const parsed = parseTranslatorOutput(output, new Set(shortIds.keys()));
  if (!parsed) {
    // Whole-call failure: count the attempt, but a runtime outage is not the
    // row's fault — give up on a row only after repeated failures.
    for (const job of toModel) {
      const exhausted = job.attempts + 1 >= MAX_CALL_FAILURES;
      finishJob(db, job, exhausted ? "kept_native" : "pending", {
        reason: exhausted ? "translator-unavailable" : receipt.failure ?? "invalid-output",
        translator: translator.label,
        attempt: true,
      });
    }
    receipt.failure = receipt.failure ?? "invalid-output";
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

function idleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0;
  }
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
  if (running) return;
  if (openedStoreMigrationRole() !== "owner") return;
  if (englishMigrationOptedOut()) return;
  if (idleSeconds() < dreamingIdleRequiredSec()) return;
  const slots = runSlotStats();
  if (slots.inUse > 0 || slots.queued > 0) return;
  if (await dreamingRunning()) return;
  running = true;
  const controller = new AbortController();
  const watchdog = setInterval(() => {
    if (idleSeconds() < 30) controller.abort(new Error("user-returned"));
  }, 15_000);
  watchdog.unref?.();
  try {
    if (Date.now() - lastSweepAt > SWEEP_EVERY_MS) {
      ensureEnglishMigration();
      lastSweepAt = Date.now();
    }
    const translatorChoice = chooseTranslator(await defaultRuntimes());
    for (let index = 0; index < BATCHES_PER_TICK && !controller.signal.aborted; index += 1) {
      const remaining = dailyCap() - budgetUsed();
      if (remaining <= 0) break;
      const receipt = await runEnglishMigrationBatch({
        signal: controller.signal,
        maxItems: Math.min(BATCH_MAX_ITEMS, remaining),
        translator: translatorChoice,
      });
      spendBudget(receipt.attempted + receipt.reused);
      const record = readRecord();
      if (record) {
        const db = getDb();
        writeRecord({
          ...record,
          lastTranslator: receipt.translator ?? record.lastTranslator,
          lastError: receipt.failure ?? null,
          completedAt: pendingCount(db) === 0 ? record.completedAt ?? new Date().toISOString() : null,
        });
      }
      if (receipt.translated + receipt.reused > 0 || receipt.failure) {
        console.info("[english-memory]", JSON.stringify(receipt));
      }
      if (receipt.failure || receipt.attempted + receipt.reused + receipt.stale === 0) break;
    }
  } catch (error) {
    console.error("[english-memory] pass failed:", error);
  } finally {
    clearInterval(watchdog);
    running = false;
  }
}

/**
 * Boot: start the idle worker and, off the startup path, record the one-time
 * migration (the sweep reads every memory row once). Never throws.
 */
export function startEnglishMemoryMigration(): void {
  if (timer) return;
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
