// Model discovery contract shared by every runtime probe (PRD 2026-08-15 D-1..D-3).
//
// Why: on 2026-08-14 `agy models` changed its line format inside a minor
// version, the parser returned [] (rc=0, no exception, no log), the model
// picker showed 0 models, and the empty catalog even switched model validation
// OFF. Eleven parsers shared no contract, so "unsupported", "failed", and
// "genuinely empty" were the same value: [].
//
// The contract:
//   ok           — a non-empty, validated list (may carry a yield warning)
//   unsupported  — this runtime has no list concept / no discovery path yet
//   failed       — discovery ran and produced nothing usable; MUST be loud
//
// Yield rule (Spidermon ItemCountMonitor lineage): non-empty stdout with zero
// parsed rows is `failed` ("yield regression"), never an empty `ok`. Exit
// codes are not trusted — `agy models --json`, `grok`, `opencode` return 0 on
// usage output (measured 2026-08-14).

export type DiscoveryStatus = "ok" | "unsupported" | "failed";
export type DiscoverySource = "acp" | "cli" | "file" | "http" | "none";

export interface DiscoveryOutcome {
  status: DiscoveryStatus;
  /** Validated model ids; always [] unless status === "ok". */
  models: string[];
  /** Non-empty lines the source produced (0 for unsupported). */
  rawLineCount: number;
  /** Machine-readable reason: `yield-regression`, `exit:<code>`, `empty-output`, `timeout`, `spawn-error`, `no-list-concept`, `not-implemented`, … */
  reason?: string;
  /** ok, but the count dropped sharply against the last good count. */
  yieldWarning?: boolean;
  previousCount?: number;
  source?: DiscoverySource;
  /** Filled by the store when a failed probe was backfilled from the last good run. */
  stale?: boolean;
  /** ISO timestamp of the discovery (or of the last-good run when stale). */
  at?: string;
  /** The runtime's own current/default model when it reports one (ACP configOptions currentValue). */
  defaultModel?: string;
}

/** Runtime status summary carried on RuntimeStatus.modelDiscovery (IPC-safe subset). */
export interface ModelDiscoverySummary {
  status: DiscoveryStatus;
  reason?: string;
  stale?: boolean;
  yieldWarning?: boolean;
  count: number;
  previousCount?: number;
  source?: DiscoverySource;
  at?: string;
}

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]-]{1,119}$/;

/** A yield below this fraction of the previous good count raises yieldWarning. */
export const YIELD_DROP_RATIO = 0.5;

export function countRawLines(stdout: string): number {
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export function unsupportedDiscovery(reason: string, source: DiscoverySource = "none"): DiscoveryOutcome {
  return { status: "unsupported", models: [], rawLineCount: 0, reason, source };
}

export function failedDiscovery(reason: string, rawLineCount = 0, source: DiscoverySource = "cli"): DiscoveryOutcome {
  return { status: "failed", models: [], rawLineCount, reason, source };
}

/**
 * Classify a finished discovery attempt. `models` must already be validated ids.
 * The classifier never invents rows; it only decides how loud to be.
 */
export function classifyDiscovery(input: {
  stdout: string;
  models: readonly string[];
  exitCode?: number | null;
  timedOut?: boolean;
  previousCount?: number | null;
  source?: DiscoverySource;
  /** 파서가 이미 통과시킨 표기를 다시 거르지 않도록, 그 파서의 허용 패턴을 넘긴다(기본 MODEL_ID_RE). */
  idRe?: RegExp;
}): DiscoveryOutcome {
  const source = input.source ?? "cli";
  const rawLineCount = countRawLines(input.stdout ?? "");
  const idRe = input.idRe ?? MODEL_ID_RE;
  const models = [...new Set(input.models.map((m) => m.trim()).filter((m) => idRe.test(m)))];
  const previous = typeof input.previousCount === "number" && input.previousCount > 0 ? input.previousCount : undefined;
  if (models.length > 0) {
    const yieldWarning = previous !== undefined && models.length < previous * YIELD_DROP_RATIO;
    return {
      status: "ok",
      models,
      rawLineCount,
      source,
      ...(yieldWarning ? { yieldWarning: true, previousCount: previous, reason: `yield-drop:${previous}->${models.length}` } : {}),
    };
  }
  if (input.timedOut) return failedDiscovery("timeout", rawLineCount, source);
  if (rawLineCount > 0) {
    // rc may be 0 (usage text, banner, changed format) — the yield is the truth.
    return failedDiscovery(`yield-regression:${rawLineCount}-lines-0-models`, rawLineCount, source);
  }
  if (typeof input.exitCode === "number" && input.exitCode !== 0) return failedDiscovery(`exit:${input.exitCode}`, 0, source);
  return failedDiscovery("empty-output", 0, source);
}

export function summarizeDiscovery(outcome: DiscoveryOutcome): ModelDiscoverySummary {
  return {
    status: outcome.status,
    count: outcome.models.length,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.stale ? { stale: true } : {}),
    ...(outcome.yieldWarning ? { yieldWarning: true } : {}),
    ...(outcome.previousCount !== undefined ? { previousCount: outcome.previousCount } : {}),
    ...(outcome.source ? { source: outcome.source } : {}),
    ...(outcome.at ? { at: outcome.at } : {}),
  };
}

// ── Defensive text parsers (last resort; ACP session/new is the primary path) ──
// Rules: allowlist shape (id-looking cells only), delimiter auto-detect (tab
// first, then 2+ spaces), never trust headers.

const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * `agy models` — 1.1.12+: `<id>\t<Human Name>`; older: `<id>` per line; header
 * lines carry spaces and no tab, so they fail the id check naturally.
 */
export function parseAgyModels(stdout: string): string[] {
  const out: string[] = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const first = rawLine.includes("\t") ? rawLine.split("\t")[0] : rawLine.split(/\s{2,}/)[0];
    const id = (first ?? "").trim();
    if (!id || !MODEL_ID_RE.test(id)) continue;
    if (id.includes("[") || id.includes("]")) continue; // agy ids never carry brackets; guards usage banners
    if (!/[\d-]/.test(id)) continue; // every agy id carries a digit or dash; drops one-word banners ("Loading...")
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, 100);
}

/**
 * `grok models` — prose header + `  * grok-4.6 (default)` bullets. Prefer bullet
 * cells; fall back to any grok-* token so an alias-only line still yields.
 */
export function parseGrokModels(stdout: string): string[] {
  const text = stripAnsi(stdout);
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const bullet = /^\s*[*•-]\s+([A-Za-z0-9][A-Za-z0-9._:-]{1,119})/.exec(line);
    if (bullet && MODEL_ID_RE.test(bullet[1])) {
      const id = bullet[1].toLowerCase();
      if (!out.includes(id)) out.push(id);
    }
  }
  if (out.length > 0) return out;
  for (const mm of text.matchAll(/grok[\w.-]*\d[\w.-]*/gi)) {
    const id = mm[0].toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function cleanCursorCell(raw: string): string {
  return stripAnsi(raw).replace(/^[\s*•·\-]+|[\s]+$/g, "").replace(/\s*\((?:default|current|selected|recommended)\)\s*$/i, "").trim();
}

/**
 * Cursor 전용 표기 허용 — 현행 CLI는 "Composer 2.5", "GPT-5.6 Sol High Fast"처럼
 * 공백 포함 표시명을 계정 인벤토리로 내보낸다. 전역 MODEL_ID_RE(공백 불허)를 넓히면
 * 다른 파서가 문장 조각을 모델로 오인하므로, cursor 경로에서만 이 패턴을 쓴다.
 */
export const CURSOR_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@\[\] -]{1,119}$/;

function modelNamesFromJson(value: unknown, idRe: RegExp = MODEL_ID_RE): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === "object") {
      const rec = node as Record<string, unknown>;
      for (const key of ["id", "name", "model", "slug"]) {
        const v = rec[key];
        if (typeof v === "string" && idRe.test(v.trim()) && !out.includes(v.trim())) { out.push(v.trim()); break; }
      }
      for (const v of Object.values(rec)) if (v && typeof v === "object") visit(v);
    }
  };
  visit(value);
  return out;
}

/**
 * `cursor-agent models` — JSON when available, else a table split on `|`/`│`.
 * The vendor-word allowlist that lived here (`opus|sonnet|gpt|...`) is gone:
 * it silently dropped any new vendor. Any id-shaped cell counts; header words
 * (`Model`, `Provider`) are excluded by shape.
 */
export function parseCursorModels(stdout: string): string[] {
  try {
    const parsed = modelNamesFromJson(JSON.parse(stdout), CURSOR_MODEL_RE);
    if (parsed.length > 0) return parsed;
  } catch { /* text form */ }
  const out: string[] = [];
  const HEADER = /^(model|models|name|provider|status|id|available|default)$/i;
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    if (/^\s*[-─=+|]+\s*$/.test(rawLine)) continue;
    for (const cell of rawLine.split(/[|│]/)) {
      const name = cleanCursorCell(cell);
      if (!name || HEADER.test(name) || !CURSOR_MODEL_RE.test(name)) continue;
      // require at least one digit or a dash/dot so bare words like "Available" fail
      if (!/[\d.\-]/.test(name) && name.toLowerCase() !== "auto") continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** `opencode models` — one `provider/model` per line. */
export function parseOpencodeModels(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const id = line.trim();
    if (id.includes("/") && MODEL_ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
