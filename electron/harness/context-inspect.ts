/*
 * Context inspector (docs/2026-10-13-native-harness/20 §4-6): what the last model request of a chat carried, item by
 * item, read from the model-call ledger (electron/runtime/model-call-ledger.ts) — never by calling a model, logging in,
 * compacting or ending a session.
 *
 * Rules the snapshot obeys:
 *  - one window view: last_request (the newest, or an exact past request by requestId). The session's cumulative usage
 *    and the next request's estimate from current settings are separate views, never mixed into window occupancy.
 *  - the window input is ONE model request. A CLI runtime's turn receipt (codex, claude-code) sums every request of its
 *    tool loop, so for those rows the window is the runtime's own last-request figure (`observedContextInput`); the
 *    turn sum is shown apart as `turnUsage` and, session-wide, in sessionCumulative. Without a last-request figure a
 *    turn sum is never presented as the window (host estimate or unavailable instead).
 *  - every item carries its measurement: provider_reported (the provider's input total), host_estimated (the adapter's
 *    block estimate of what it transmitted) or unavailable (a resumed native thread keeps that block inside the
 *    provider). Unknown is never written as 0.
 *  - cached input counts toward the window; it is a separate column, never subtracted.
 *  - the gap between the provider total and the attributed items is shown both ways (unattributed / over-attributed and a
 *    signed aggregate difference), not spread over items.
 *  - capacity is the window the runtime reported for that request when it did (a local server's loaded window, the ACP
 *    size), else the model catalog; without either there is no ratio.
 *  - each block is an occurrence of that exact request; host-authored originals are read back from the retention store
 *    by digest (context-originals.ts), never re-rendered from current settings.
 * No electron import: the daemon and the SDK read the same snapshot.
 */
import { createHash } from "node:crypto";
import { MODEL_CALL_LEDGER_EVENT_KIND, TURN_AGGREGATE_USAGE_RUNTIMES } from "../runtime/model-call-ledger";
import { GENERATION_CONTEXT_RATIO, runtimeContextWindow } from "../runtime/session-generation";

export type ContextCategory =
  | "system_prompt" | "tools" | "messages" | "agentlas_instructions" | "attachments" | "current_input" | "tool_exchanges" | "framing";
export type ContextMeasurement = "provider_reported" | "host_estimated" | "unavailable";

export interface ContextItem { category: ContextCategory; tokens: number | null; measurement: ContextMeasurement }

/**
 * One block as it travelled in that exact request (doc 20 §4: the unit is the wire occurrence). `original` says whether
 * the host-authored text is retained (context-originals.ts): it is read through context.sources.get, never re-rendered
 * from today's settings. Conversation, attachments and tool results point at their own stores.
 */
export interface ContextOccurrence {
  occurrenceId: string;
  category: ContextCategory;
  tokens: number | null;
  measurement: ContextMeasurement;
  digest?: string;
  bytes?: number;
  /** derived: framing is the residual of the whole request, not a text of its own. */
  original: "retained" | "not_retained" | "elsewhere" | "provider_held" | "derived";
}

export interface ContextSnapshot {
  schemaVersion: "agentlas.context-snapshot.v1";
  view: "last_request";
  status: "observed" | "no_request";
  /** The exact provider request this snapshot describes: `<callRef>:<attempt>`; a past request is read by this id. */
  requestId?: string;
  snapshotId?: string;
  request?: { runId: string; callRef: string; ts: string; runtimeKind: string; model: string | null; role: string; mode: string; attempt: number };
  /** runtime-reported: the window the runtime reported for that session (a local server's loaded n_ctx, ACP size). */
  capacity: { tokens: number | null; source: "runtime-reported" | "model-catalog" | "unavailable" };
  input: { tokens: number | null; measurement: ContextMeasurement; cachedTokens?: number };
  /**
   * What the whole call used when its runtime reports a turn sum (every request of the CLI's tool loop): cost of the
   * turn, not window occupancy. Absent for runtimes whose row is one request.
   */
  turnUsage?: { inputTokens: number; cachedTokens?: number; outputTokens?: number };
  outputTokens?: number;
  /** The session rolls to a new generation at this input size (80% of the window); null without a window. */
  rotationAtTokens: number | null;
  usedRatio: number | null;
  items: ContextItem[];
  occurrences?: ContextOccurrence[];
  /** Provider total minus the attributed items, when both exist and the provider total is larger. */
  unattributedTokens: number | null;
  /** Attributed items minus the provider total, when the host estimate is the larger one (doc 20 §5.4: both ways). */
  overAttributedTokens?: number | null;
  /** Signed provider − attributed, only when both sides are known. */
  aggregate?: { providerTokens: number | null; attributedTokens: number; differenceTokens: number | null; direction: "provider_higher" | "attributed_higher" | "equal" | "unknown" };
  measuredBy?: { estimate: "host-block-estimate"; tokenizerRevision: string | null; observedAt: string };
  toolsCount?: number;
  /** Separate views (doc 20 §5.1), never mixed into the header's window occupancy. */
  views?: {
    sessionCumulative: { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; unmeasuredRequests: number };
    nextRequestEstimate: { basis: "current-settings"; moduleTokens: number; modules: number };
  };
  /** The chat's recorded requests, newest first: pick one by requestId. */
  requests?: Array<{ requestId: string; snapshotId: string; ts: string; role: string; model: string | null; inputTokens: number | null; measurement: ContextMeasurement }>;
}

/**
 * The window input of one ledger row: the provider-reported size of ONE request. The runtime's last-request figure
 * wins; a row whose receipt is a turn sum (usageScope turn_aggregate) never stands in for it. Other observed rows are
 * one HTTP dispatch each, so their receipt is the request.
 */
/** A receipt that sums a CLI turn's requests: stamped on the row, else (a row written before the stamp) by its runtime. */
const isTurnAggregate = (p: Record<string, unknown>): boolean =>
  p.usageScope === "turn_aggregate" || (p.usageScope === undefined && typeof p.runtimeKind === "string" && TURN_AGGREGATE_USAGE_RUNTIMES.has(p.runtimeKind));

function windowObservation(p: Record<string, unknown>): { tokens: number; cachedTokens?: number } | null {
  const last = count(p.observedContextInput);
  if (last !== null) {
    const cached = count(p.observedContextCachedInput);
    return { tokens: last, ...(cached !== null && cached <= last ? { cachedTokens: cached } : {}) };
  }
  if (p.usageStatus !== "observed" || isTurnAggregate(p)) return null;
  const observed = count(p.observedInput);
  if (observed === null) return null;
  const cached = count(p.observedCachedInput);
  return { tokens: observed, ...(cached !== null ? { cachedTokens: cached } : {}) };
}

/** Ledger block field → inspector category, in display order. */
const BLOCKS: ReadonlyArray<[string, ContextCategory]> = [
  ["instructionsTokens", "system_prompt"],
  ["toolsTokens", "tools"],
  ["hostContextTokens", "agentlas_instructions"],
  ["historyTokens", "messages"],
  ["toolExchangeTokens", "tool_exchanges"],
  ["attachmentsTokens", "attachments"],
  ["ownerTextTokens", "current_input"],
  ["framingTokens", "framing"],
];
/** Ledger block whose original the retention store keeps (context-originals.ts RETAINED_CONTEXT_BLOCKS). */
const RETAINED_FIELD = new Set(["instructionsTokens", "toolsTokens", "hostContextTokens"]);

const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const requestIdOf = (p: Record<string, unknown>): string => `${typeof p.callRef === "string" ? p.callRef : "model-call:unknown"}:${count(p.attemptIndex) ?? 1}`;
const snapshotIdOf = (runId: string, requestId: string, ts: string): string =>
  `ctxsnap_${createHash("sha256").update(`${runId}\u0000${requestId}\u0000${ts}`).digest("hex").slice(0, 16)}`;

/** Build the snapshot from one ledger payload (exported for the gate). `retained` says whether a digest's original is kept. */
export function snapshotFromLedger(row: { runId: string; ts: string; payload: Record<string, unknown> }, retained: (digest: string) => boolean = () => false): ContextSnapshot {
  const p = row.payload;
  const items: ContextItem[] = BLOCKS.map(([field, category]) => {
    const tokens = count(p[field]);
    return { category, tokens, measurement: tokens === null ? "unavailable" : "host_estimated" };
  });
  const attributed = items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  const observedWindow = windowObservation(p);
  const observed = observedWindow ? observedWindow.tokens : null;
  const estimated = count(p.sentTokensEst) ?? count(p.wholeRequestEstimate);
  const turnInput = p.usageStatus === "observed" && isTurnAggregate(p) ? count(p.observedInput) : null;
  const turnCached = turnInput !== null ? count(p.observedCachedInput) : null;
  const turnOutput = turnInput !== null ? count(p.observedOutput) : null;
  const input: ContextSnapshot["input"] = observedWindow
    ? { tokens: observedWindow.tokens, measurement: "provider_reported", ...(observedWindow.cachedTokens !== undefined ? { cachedTokens: observedWindow.cachedTokens } : {}) }
    : estimated !== null && estimated > 0
      ? { tokens: estimated, measurement: "host_estimated" }
      : { tokens: null, measurement: "unavailable" };
  const runtimeKind = typeof p.runtimeKind === "string" ? p.runtimeKind : "unknown";
  const model = typeof p.model === "string" ? p.model : null;
  const reported = count(p.contextWindowObserved);
  const catalog = reported ? null : runtimeContextWindow(runtimeKind, model);
  const window = reported ?? catalog;
  const requestId = requestIdOf(p);
  const snapshotId = snapshotIdOf(row.runId, requestId, row.ts);
  const occurrences: ContextOccurrence[] = BLOCKS.map(([field, category], index) => {
    const base = field.replace(/Tokens$/, "");
    const digest = typeof p[`${base}Digest`] === "string" ? p[`${base}Digest`] as string : undefined;
    const bytes = count(p[`${base}Bytes`]) ?? undefined;
    const tokens = items[index].tokens;
    const original: ContextOccurrence["original"] = tokens === null ? "provider_held" : field === "framingTokens" ? "derived"
      : !RETAINED_FIELD.has(field) ? "elsewhere" : digest && retained(digest) ? "retained" : "not_retained";
    return { occurrenceId: `${snapshotId}:${base}`, category, tokens, measurement: items[index].measurement,
      ...(digest ? { digest } : {}), ...(bytes !== undefined ? { bytes } : {}), original };
  });
  const difference = observed !== null ? observed - attributed : null;
  return {
    schemaVersion: "agentlas.context-snapshot.v1",
    view: "last_request",
    status: "observed",
    requestId,
    snapshotId,
    request: {
      runId: row.runId, callRef: typeof p.callRef === "string" ? p.callRef : "", ts: row.ts, runtimeKind, model,
      role: typeof p.role === "string" ? p.role : "unscoped", mode: typeof p.mode === "string" ? p.mode : "unknown",
      attempt: count(p.attemptIndex) ?? 1,
    },
    capacity: reported ? { tokens: reported, source: "runtime-reported" } : catalog ? { tokens: catalog, source: "model-catalog" } : { tokens: null, source: "unavailable" },
    input,
    ...(turnInput !== null ? { turnUsage: { inputTokens: turnInput, ...(turnCached !== null ? { cachedTokens: turnCached } : {}),
      ...(turnOutput !== null ? { outputTokens: turnOutput } : {}) } } : {}),
    ...(count(p.observedOutput) !== null ? { outputTokens: count(p.observedOutput)! } : {}),
    rotationAtTokens: window ? Math.floor(window * GENERATION_CONTEXT_RATIO) : null,
    usedRatio: window && input.tokens !== null ? Math.min(1, input.tokens / window) : null,
    items,
    occurrences,
    unattributedTokens: difference !== null && difference > 0 ? difference : null,
    overAttributedTokens: difference !== null && difference < 0 ? -difference : null,
    aggregate: { providerTokens: observed, attributedTokens: attributed, differenceTokens: difference,
      direction: difference === null ? "unknown" : difference > 0 ? "provider_higher" : difference < 0 ? "attributed_higher" : "equal" },
    measuredBy: { estimate: "host-block-estimate", tokenizerRevision: typeof p.tokenizerRevision === "string" ? p.tokenizerRevision : null, observedAt: row.ts },
    ...(count(p.toolsCount) !== null ? { toolsCount: count(p.toolsCount)! } : {}),
  };
}

const EMPTY: ContextSnapshot = {
  schemaVersion: "agentlas.context-snapshot.v1", view: "last_request", status: "no_request",
  capacity: { tokens: null, source: "unavailable" }, input: { tokens: null, measurement: "unavailable" },
  rotationAtTokens: null, usedRatio: null, items: [], unattributedTokens: null,
};

type LedgerRow = { runId: string; ts: string; payload: Record<string, unknown> };

const validJson = "CASE WHEN json_valid(payload_json) THEN payload_json END";
const sqlCount = (field: string, json = "p"): string => {
  const value = `json_extract(${json}, '$.${field}')`;
  return `CASE WHEN json_type(${json}, '$.${field}') IN ('integer', 'real') AND ${value} BETWEEN 0 AND 9007199254740991 AND ${value} = CAST(${value} AS INTEGER) THEN ${value} END`;
};
function parseLedgerRow(row: { runId: string; ts: string; payloadJson: string }): LedgerRow | null {
  try { const payload: unknown = JSON.parse(row.payloadJson);
    return payload !== null && typeof payload === "object" ? { runId: row.runId, ts: row.ts, payload: payload as Record<string, unknown> } : null;
  } catch { return null; }
}
async function chatLedgerRows(chatId: string, limit: number, requestId?: string, mainOnly = false): Promise<LedgerRow[]> {
  const { getDb } = await import("../store/db");
  const columns = "SELECT run_id AS runId, ts, payload_json AS payloadJson FROM run_events WHERE chat_id = ? AND kind = ?";
  const params: unknown[] = [chatId, MODEL_CALL_LEDGER_EVENT_KIND];
  let query = columns;
  if (mainOnly) query += ` AND json_extract(${validJson}, '$.role') = 'main'`;
  if (requestId !== undefined) {
    const at = requestId.lastIndexOf(":");
    const attempt = Number(requestId.slice(at + 1));
    if (at < 1 || !Number.isSafeInteger(attempt) || attempt < 0 || String(attempt) !== requestId.slice(at + 1)) return [];
    // The existing chat/kind index bounds the lookup; an exact historical id is never limited to the newest page.
    query += ` AND json_extract(${validJson}, '$.callRef') = ? AND COALESCE(${sqlCount("attemptIndex", validJson)}, 1) = ?`;
    params.push(requestId.slice(0, at), attempt);
  }
  query += " ORDER BY ts DESC, seq DESC, id DESC LIMIT ?";
  params.push(requestId !== undefined ? 1 : limit);
  const rows = getDb().prepare(query).all(...params) as Array<{ runId: string; ts: string; payloadJson: string }>;
  return rows.map(parseLedgerRow).filter((row): row is LedgerRow => row !== null);
}

async function chatCumulative(chatId: string): Promise<NonNullable<ContextSnapshot["views"]>["sessionCumulative"]> {
  const { getDb } = await import("../store/db");
  const row = getDb().prepare(`WITH data AS (
    SELECT ${validJson} AS p FROM run_events WHERE chat_id = ? AND kind = ?
  ), meters AS (
    SELECT CASE WHEN json_extract(p, '$.usageStatus') = 'observed' THEN ${sqlCount("observedInput")} END AS input,
      ${sqlCount("observedOutput")} AS output, ${sqlCount("observedCachedInput")} AS cached
      FROM data WHERE p IS NOT NULL AND json_type(p) IN ('object', 'array')
  ) SELECT COUNT(*) AS requests, COALESCE(SUM(input), 0) AS inputTokens,
    COALESCE(SUM(CASE WHEN input IS NOT NULL THEN output END), 0) AS outputTokens,
    COALESCE(SUM(CASE WHEN input IS NOT NULL THEN cached END), 0) AS cachedTokens,
    COALESCE(SUM(CASE WHEN input IS NULL THEN 1 ELSE 0 END), 0) AS unmeasuredRequests FROM meters`)
    .get(chatId, MODEL_CALL_LEDGER_EVENT_KIND) as NonNullable<ContextSnapshot["views"]>["sessionCumulative"];
  return row;
}

/**
 * The chat's last main-role request (the context the next turn starts from), or the exact past request `requestId`.
 * Falls back to the newest request of any role when the chat has no main-role call recorded yet. Reads the indexed
 * (chat_id, kind, ts) rows only; the views and the request list come from the same rows.
 */
export async function inspectContext(chatId: string, options: { requestId?: string; locale?: "ko" | "en" } = {}): Promise<ContextSnapshot> {
  const parsed = await chatLedgerRows(chatId, 200);
  const pick = options.requestId !== undefined
    ? (await chatLedgerRows(chatId, 1, options.requestId))[0]
    : (await chatLedgerRows(chatId, 1, undefined, true))[0] ?? parsed[0];
  if (!pick) return EMPTY;
  const { hasContextOriginal } = await import("../runtime/context-originals");
  const snapshot = snapshotFromLedger(pick, hasContextOriginal);
  const sessionCumulative = await chatCumulative(chatId);
  let moduleTokens = 0, modules = 0;
  try {
    const next = await listContextItems("modules", { limit: 200, locale: options.locale });
    modules = next.total; moduleTokens = next.items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  } catch { /* the estimate is optional; the past request stands on its own */ }
  return {
    ...snapshot,
    views: {
      sessionCumulative,
      nextRequestEstimate: { basis: "current-settings", moduleTokens, modules },
    },
    requests: parsed.slice(0, 20).map((row) => {
      const requestId = requestIdOf(row.payload);
      const observed = windowObservation(row.payload)?.tokens ?? null;
      const estimated = count(row.payload.sentTokensEst);
      return { requestId, snapshotId: snapshotIdOf(row.runId, requestId, row.ts), ts: row.ts,
        role: typeof row.payload.role === "string" ? row.payload.role : "unscoped",
        model: typeof row.payload.model === "string" ? row.payload.model : null,
        inputTokens: observed ?? estimated, measurement: observed !== null ? "provider_reported" : estimated !== null ? "host_estimated" : "unavailable" };
    }),
  };
}

/**
 * The retained original of one occurrence of one exact request of this chat (doc 20 §6 context.sources.get). The
 * owner's own chat only; conversation/attachment/tool-result blocks point at their store; a block that was not retained
 * (requests recorded before retention, or a block the provider keeps) says so — today's settings never stand in.
 */
export async function getContextSource(chatId: string, occurrenceId: string): Promise<
  | { status: "ok"; occurrenceId: string; requestId: string; category: ContextCategory; tokens: number | null; measurement: ContextMeasurement; digest?: string; bytes?: number; original: "retained"; text: string }
  | { status: "ok"; occurrenceId: string; requestId: string; category: ContextCategory; tokens: number | null; measurement: ContextMeasurement; digest?: string; bytes?: number; original: "not_retained" | "elsewhere" | "provider_held" | "derived" }
  | { status: "unknown" }> {
  const at = occurrenceId.lastIndexOf(":");
  const snapshotId = at > 0 ? occurrenceId.slice(0, at) : "";
  if (!/^ctxsnap_[a-f0-9]{16}$/.test(snapshotId)) return { status: "unknown" };
  const { hasContextOriginal, readContextOriginal } = await import("../runtime/context-originals");
  const { getDb } = await import("../store/db");
  // Iterate the indexed chat scope with bounded memory; a retained past source never expires with a UI page.
  const rows = getDb().prepare(`SELECT run_id AS runId, ts, payload_json AS payloadJson FROM run_events
    WHERE chat_id = ? AND kind = ? ORDER BY ts DESC, seq DESC, id DESC`).iterate(chatId, MODEL_CALL_LEDGER_EVENT_KIND);
  for (const raw of rows) {
    const row = parseLedgerRow(raw as { runId: string; ts: string; payloadJson: string });
    if (!row) continue;
    const requestId = requestIdOf(row.payload);
    if (snapshotIdOf(row.runId, requestId, row.ts) !== snapshotId) continue;
    const occurrence = snapshotFromLedger(row, hasContextOriginal).occurrences!.find((item) => item.occurrenceId === occurrenceId);
    if (!occurrence) return { status: "unknown" };
    const { occurrenceId: _id, original, ...rest } = occurrence;
    if (original === "retained") {
      const text = readContextOriginal(occurrence.digest);
      if (text !== null) return { status: "ok", occurrenceId, requestId, ...rest, original: "retained", text };
      return { status: "ok", occurrenceId, requestId, ...rest, original: "not_retained" };
    }
    return { status: "ok", occurrenceId, requestId, ...rest, original };
  }
  return { status: "unknown" };
}

/**
 * Typed port handlers (doc 20 §6) for Main to route from capability-ports: chat-scoped — an agent reads only its own
 * chat; the owner UI (chatId "ui") names the chat.
 */
export const CONTEXT_PORT_HANDLERS = {
  "context.inspect": async (args: Record<string, unknown>, ctx: { chatId: string }) => {
    const chatId = scopedChat(args, ctx);
    if (!chatId) return { status: "refused" as const, reason: "chat_scope" };
    return { status: "ok" as const, data: await inspectContext(chatId, { ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
      ...(args.locale === "ko" ? { locale: "ko" as const } : {}) }) };
  },
  "context.sources.get": async (args: Record<string, unknown>, ctx: { chatId: string }) => {
    const chatId = scopedChat(args, ctx);
    if (!chatId || typeof args.occurrenceId !== "string") return { status: "refused" as const, reason: chatId ? "occurrence_required" : "chat_scope" };
    const source = await getContextSource(chatId, args.occurrenceId);
    return source.status === "ok" ? { status: "ok" as const, data: source } : { status: "refused" as const, reason: "occurrence_unknown" };
  },
};

function scopedChat(args: Record<string, unknown>, ctx: { chatId: string }): string | null {
  const asked = typeof args.chatId === "string" && args.chatId ? args.chatId : null;
  if (ctx.chatId === "ui") return asked;
  return asked && asked !== ctx.chatId ? null : ctx.chatId;
}

export type ContextItemList = "modules" | "plugins" | "skills" | "connectors" | "tools";

/** Page through what the next request can carry: prompt modules (with size) and the installed catalogs (names). */
export async function listContextItems(list: ContextItemList, options: { cursor?: number; limit?: number; locale?: "ko" | "en" } = {}): Promise<{
  items: Array<{ id: string; name: string; tokens?: number; detail?: string }>; nextCursor: number | null; total: number;
}> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const cursor = Math.max(0, options.cursor ?? 0);
  let all: Array<{ id: string; name: string; tokens?: number; detail?: string }>;
  if (list === "modules") {
    const { renderPromptModuleTexts } = await import("../runtime/prompt-modules");
    const { estimateTextTokens } = await import("../runtime/token-estimate");
    all = renderPromptModuleTexts(moduleContext(options.locale ?? "en"))
      .map((module) => ({ id: `module:${module.id}`, name: module.id, tokens: estimateTextTokens(module.text), detail: `${module.layer} r${module.revision}` }));
  } else {
    const { searchHarness } = await import("./capability-ports");
    const kind = list === "plugins" ? "plugin" : list === "skills" ? "skill" : list === "connectors" ? "connector" : "tool";
    all = (await searchHarness("", kind)).map((row) => ({ id: row.id, name: row.name, detail: row.description }));
  }
  const items = all.slice(cursor, cursor + limit);
  return { items, nextCursor: cursor + limit < all.length ? cursor + limit : null, total: all.length };
}

/** One module's exact rendered text (ordinary profile); other ids go through harness_describe. */
export async function getContextItem(id: string, locale: "ko" | "en" = "en"): Promise<{ id: string; text: string; tokens: number } | null> {
  if (!id.startsWith("module:")) return null;
  const { renderPromptModuleTexts } = await import("../runtime/prompt-modules");
  const { estimateTextTokens } = await import("../runtime/token-estimate");
  const module = renderPromptModuleTexts(moduleContext(locale)).find((row) => `module:${row.id}` === id);
  return module ? { id, text: module.text, tokens: estimateTextTokens(module.text) } : null;
}

function moduleContext(locale: "ko" | "en") {
  return { profile: "ordinary" as const, locale, permission: "full" as const, agentPrompt: "", agentSeparator: "" };
}
