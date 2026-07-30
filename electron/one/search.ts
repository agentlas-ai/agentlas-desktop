import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { parseDurableOneSurfaceJson } from "../../shared/one-surface-durable";
import type { OneSurfaceManifestV1 } from "../../shared/one-surface";
import {
  ONE_SEARCH_CONTRACT_VERSION,
  type OneSearchHitKind,
  type OneSearchHitV1,
  type OneSearchMatchKind,
  type OneSearchPageV1,
  type OneSearchRequestV1,
  type OneTaskArchiveMutationInputV1,
  type OneTaskArchiveMutationResultV1,
} from "../../shared/one-search";
import { redactSecrets } from "../../shared/secret-patterns";

const MAX_QUERY_CHARS = 160;
const MAX_QUERY_TERMS = 8;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;
const TASK_STATUS = new Set([
  "open", "running", "waiting-decision", "partial", "completed", "failed", "cancelled", "archived",
]);
const RESTORABLE_TASK_STATUS = new Set(["open", "waiting-decision", "partial", "completed", "failed", "cancelled"]);
const ARCHIVE_STATE_EVENT_KIND = "one_task_archive_state";

interface TaskCandidateRow {
  id: string;
  title: string;
  origin_chat_id: string;
  status: string;
  updated_at: string;
  archived_at: string | null;
}

interface ConversationCandidateRow {
  id: string;
  title: string;
  updated_at: string;
  archived_at: string | null;
}

interface SearchCursor {
  version: 1;
  queryHash: string;
  includeArchived: boolean;
  updatedAt: string;
  sortKey: string;
}

interface SearchParts {
  text: string;
  resultText: string;
  artifactLabels: string[];
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new TypeError("One search request contains unsupported fields");
  }
}

function searchQueryHash(query: string): string {
  return createHash("sha256").update(query.toLocaleLowerCase(), "utf8").digest("hex");
}

function normalizeRequest(value: unknown): Required<Omit<OneSearchRequestV1, "cursor">> & { cursor: SearchCursor | null } {
  if (!isRecord(value)) throw new TypeError("One search request is required");
  assertOnlyKeys(value, ["contractVersion", "query", "limit", "cursor", "includeArchived"]);
  if (value.contractVersion !== ONE_SEARCH_CONTRACT_VERSION) {
    throw new TypeError("Unsupported One search contract version");
  }
  if (typeof value.query !== "string") throw new TypeError("One search query must be text");
  const query = value.query.replace(/\s+/g, " ").trim();
  if (!query || query.length > MAX_QUERY_CHARS) {
    throw new TypeError(`One search query must contain 1-${MAX_QUERY_CHARS} characters`);
  }
  const limit = value.limit === undefined ? DEFAULT_LIMIT : Number(value.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(`One search limit must be between 1 and ${MAX_LIMIT}`);
  }
  if (value.includeArchived !== undefined && typeof value.includeArchived !== "boolean") {
    throw new TypeError("One search includeArchived must be boolean");
  }
  const includeArchived = value.includeArchived !== false;
  const cursor = decodeCursor(value.cursor);
  if (cursor && (cursor.queryHash !== searchQueryHash(query) || cursor.includeArchived !== includeArchived)) {
    throw new TypeError("One search cursor does not belong to this query");
  }
  return {
    contractVersion: ONE_SEARCH_CONTRACT_VERSION,
    query,
    limit,
    includeArchived,
    cursor,
  };
}

function decodeCursor(value: unknown): SearchCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CURSOR_RE.test(value)) throw new TypeError("Invalid One search cursor");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) || parsed.version !== 1 ||
      typeof parsed.queryHash !== "string" || !/^[0-9a-f]{64}$/.test(parsed.queryHash) ||
      typeof parsed.includeArchived !== "boolean" || typeof parsed.updatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.updatedAt) ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.sortKey !== "string" ||
      !/^(?:task|conversation):[A-Za-z0-9._:-]{1,256}$/.test(parsed.sortKey) ||
      Object.keys(parsed).some((key) => !["version", "queryHash", "includeArchived", "updatedAt", "sortKey"].includes(key))
    ) throw new Error("invalid");
    return {
      version: 1,
      queryHash: parsed.queryHash,
      includeArchived: parsed.includeArchived,
      updatedAt: parsed.updatedAt,
      sortKey: parsed.sortKey,
    };
  } catch {
    throw new TypeError("Invalid One search cursor");
  }
}

function encodeCursor(hit: OneSearchHitV1, query: string, includeArchived: boolean): string {
  const sortKey = hit.taskId ? `task:${hit.taskId}` : `conversation:${hit.chatId}`;
  return Buffer.from(JSON.stringify({
    version: 1,
    queryHash: searchQueryHash(query),
    includeArchived,
    updatedAt: hit.updatedAt,
    sortKey,
  }), "utf8").toString("base64url");
}

function queryTerms(query: string): string[] {
  const parts = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(parts)].slice(0, MAX_QUERY_TERMS);
}

function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function cursorSql(alias: string, prefix: "task" | "conversation", cursor: SearchCursor | null): {
  clause: string;
  params: unknown[];
} {
  if (!cursor) return { clause: "", params: [] };
  return {
    clause: `AND (${alias}.updated_at < ? OR (${alias}.updated_at = ? AND '${prefix}:' || ${alias}.id > ?))`,
    params: [cursor.updatedAt, cursor.updatedAt, cursor.sortKey],
  };
}

function taskCandidates(terms: string[], includeArchived: boolean, cursor: SearchCursor | null, limit: number): TaskCandidateRow[] {
  const matches = terms.map(() => `(
    lower(t.title) LIKE ? ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM chat_messages m
      WHERE m.chat_id = t.origin_chat_id AND lower(m.text) LIKE ? ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1 FROM run_events r
      WHERE r.chat_id = t.origin_chat_id AND r.kind = 'one_surface_snapshot'
        AND lower(r.payload_json) LIKE ? ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1 FROM task_agent_participants p
      WHERE p.task_id = t.id AND lower(p.agent_slug || ' ' || COALESCE(p.role, '')) LIKE ? ESCAPE '\\'
    )
  )`).join(" AND ");
  const termParams = terms.flatMap((term) => {
    const pattern = likeTerm(term);
    return [pattern, pattern, pattern, pattern];
  });
  const cursorPart = cursorSql("t", "task", cursor);
  return getDb().prepare(
    `SELECT t.id, t.title, t.origin_chat_id, t.status, t.updated_at, t.archived_at
     FROM tasks t
     WHERE t.id NOT LIKE 'task_pairing_%'
       AND t.origin_chat_id IS NOT NULL
       ${includeArchived ? "" : "AND t.status <> 'archived' AND t.archived_at IS NULL"}
       AND ${matches}
       ${cursorPart.clause}
     ORDER BY t.updated_at DESC, 'task:' || t.id ASC
     LIMIT ?`,
  ).all(...termParams, ...cursorPart.params, limit) as TaskCandidateRow[];
}

function conversationCandidates(terms: string[], includeArchived: boolean, cursor: SearchCursor | null, limit: number): ConversationCandidateRow[] {
  const matches = terms.map(() => `(
    lower(c.title) LIKE ? ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id AND lower(m.text) LIKE ? ESCAPE '\\'
    )
  )`).join(" AND ");
  const termParams = terms.flatMap((term) => {
    const pattern = likeTerm(term);
    return [pattern, pattern];
  });
  const cursorPart = cursorSql("c", "conversation", cursor);
  return getDb().prepare(
    `SELECT c.id, c.title, c.updated_at, c.archived_at
     FROM chats c
     WHERE COALESCE(c.kind, 'user') <> 'division'
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.origin_chat_id = c.id)
       ${includeArchived ? "" : "AND c.archived_at IS NULL"}
       AND ${matches}
       ${cursorPart.clause}
     ORDER BY c.updated_at DESC, 'conversation:' || c.id ASC
     LIMIT ?`,
  ).all(...termParams, ...cursorPart.params, limit) as ConversationCandidateRow[];
}

function containsAll(text: string, terms: string[]): boolean {
  const lower = text.toLocaleLowerCase();
  return terms.every((term) => lower.includes(term));
}

function redactPrivatePaths(value: string): string {
  return value
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s/]+(?:\/[^\s]*)?/gi, "[local-path]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[local-path]");
}

function safeSnippet(value: string, terms: string[], limit = 180): string | null {
  const redacted = redactPrivatePaths(redactSecrets(value)).replace(/\s+/g, " ").trim();
  if (!redacted) return null;
  const lower = redacted.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const anchor = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, anchor - 48);
  const end = Math.min(redacted.length, start + limit);
  return `${start > 0 ? "…" : ""}${redacted.slice(start, end)}${end < redacted.length ? "…" : ""}`;
}

function matchingMessage(chatId: string, terms: string[]): string | null {
  const matches = terms.map(() => "lower(text) LIKE ? ESCAPE '\\'").join(" AND ");
  const row = getDb().prepare(
    `SELECT text FROM chat_messages
     WHERE chat_id = ? AND ${matches}
     ORDER BY created_at DESC, id ASC LIMIT 1`,
  ).get(chatId, ...terms.map(likeTerm)) as { text: string } | undefined;
  return row ? safeSnippet(row.text, terms) : null;
}

function surfaceParts(manifest: OneSurfaceManifestV1): SearchParts {
  const artifactLabels = new Set<string>(manifest.fallback.artifacts.map((item) => item.label));
  const values: string[] = [manifest.title, manifest.summary, manifest.surfaceState.summary, manifest.fallback.markdown];
  for (const block of manifest.blocks) {
    values.push(block.title);
    if (block.type === "Narrative") values.push(...block.paragraphs);
    if (block.type === "Document") {
      values.push(block.excerpt);
      artifactLabels.add(block.title);
    }
    if (block.type === "ArtifactList") for (const item of block.items) artifactLabels.add(item.label);
    if (block.type === "Gallery") for (const item of block.items) artifactLabels.add(item.label);
    if (block.type === "Media") for (const item of block.outputs) artifactLabels.add(item.label);
    if (block.type === "Comparison") for (const item of block.options) values.push(item.title, item.subtitle ?? "", ...item.strengths, ...item.limitations);
    if (block.type === "Timeline") for (const item of block.items) values.push(item.title, item.detail ?? "");
    if (block.type === "Checklist") for (const item of block.items) values.push(item.label);
    if (block.type === "SourceList") for (const item of block.sources) values.push(item.title, item.publisher ?? "");
    if (block.type === "Table") {
      values.push(...block.columns.map((column) => column.label));
      for (const row of block.rows.slice(0, 200)) {
        values.push(...row.cells.map((cell) => cell.value === null ? "" : String(cell.value)));
      }
    }
  }
  const resultText = values.join(" ");
  return {
    text: `${resultText} ${[...artifactLabels].join(" ")}`,
    resultText,
    artifactLabels: [...artifactLabels],
    summary: manifest.summary,
  };
}

function matchingSurface(chatId: string, taskId: string, terms: string[]): SearchParts | null {
  const matches = terms.map(() => "lower(payload_json) LIKE ? ESCAPE '\\'").join(" AND ");
  const rows = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE chat_id = ? AND kind = 'one_surface_snapshot'
       AND ${matches}
     ORDER BY ts DESC, seq DESC
     LIMIT 128`,
  ).all(chatId, ...terms.map(likeTerm)) as Array<{ payload_json: string }>;
  for (const row of rows) {
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (!isRecord(payload) || typeof payload.oneSurfaceJson !== "string") continue;
      const manifest = parseDurableOneSurfaceJson(payload.oneSurfaceJson, taskId);
      if (!manifest) continue;
      const parts = surfaceParts(manifest);
      if (containsAll(parts.text, terms)) return parts;
    } catch {
      // A corrupt historical event is not a searchable result and must not
      // prevent older valid snapshots from being found.
    }
  }
  return null;
}

function matchingParticipant(taskId: string, terms: string[]): string | null {
  const rows = getDb().prepare(
    `SELECT agent_slug, role FROM task_agent_participants WHERE task_id = ? ORDER BY first_seen_at ASC`,
  ).all(taskId) as Array<{ agent_slug: string; role: string | null }>;
  const text = rows.map((row) => `${row.agent_slug} ${row.role ?? ""}`).join(" · ");
  return containsAll(text, terms) ? safeSnippet(text, terms) : null;
}

function taskHit(row: TaskCandidateRow, terms: string[]): OneSearchHitV1 {
  const matchedBy: OneSearchMatchKind[] = [];
  const titleMatch = containsAll(row.title, terms);
  if (titleMatch) matchedBy.push("task_title");
  const surface = matchingSurface(row.origin_chat_id, row.id, terms);
  const artifact = surface?.artifactLabels.find((label) => containsAll(label, terms)) ?? null;
  const result = surface && containsAll(surface.resultText, terms) ? surface : null;
  if (result) matchedBy.push("result_content");
  if (artifact) matchedBy.push("artifact_label");
  const message = matchingMessage(row.origin_chat_id, terms);
  if (message) matchedBy.push("conversation_text");
  const participant = matchingParticipant(row.id, terms);
  if (participant) matchedBy.push("team_participant");

  let kind: OneSearchHitKind = "task";
  let detail: string | null = null;
  if (artifact) {
    kind = "artifact";
    detail = safeSnippet(artifact, terms);
  } else if (result) {
    kind = "result";
    detail = safeSnippet(result.summary, terms);
  } else if (message && !titleMatch) {
    kind = "conversation";
    detail = message;
  } else if (participant && !titleMatch) {
    kind = "team";
    detail = participant;
  }
  const status = row.archived_at !== null
    ? "archived"
    : row.status as OneSearchHitV1["status"];
  return {
    contractVersion: ONE_SEARCH_CONTRACT_VERSION,
    hitId: `${kind}:${row.id}`,
    kind,
    taskId: row.id,
    chatId: row.origin_chat_id,
    title: safeSnippet(row.title, terms, 160) ?? "Task",
    detail,
    status,
    updatedAt: row.updated_at,
    archived: status === "archived" || row.archived_at !== null,
    matchedBy: [...new Set(matchedBy)],
  };
}

function conversationHit(row: ConversationCandidateRow, terms: string[]): OneSearchHitV1 {
  const titleMatch = containsAll(row.title, terms);
  const message = matchingMessage(row.id, terms);
  return {
    contractVersion: ONE_SEARCH_CONTRACT_VERSION,
    hitId: `conversation:${row.id}`,
    kind: "conversation",
    taskId: null,
    chatId: row.id,
    title: safeSnippet(row.title, terms, 160) ?? "Conversation",
    detail: titleMatch ? null : message,
    status: "conversation",
    updatedAt: row.updated_at,
    archived: row.archived_at !== null,
    matchedBy: [
      ...(titleMatch ? ["conversation_title" as const] : []),
      ...(message ? ["conversation_text" as const] : []),
    ],
  };
}

function compareHits(left: OneSearchHitV1, right: OneSearchHitV1): number {
  const time = right.updatedAt.localeCompare(left.updatedAt);
  if (time !== 0) return time;
  const leftKey = left.taskId ? `task:${left.taskId}` : `conversation:${left.chatId}`;
  const rightKey = right.taskId ? `task:${right.taskId}` : `conversation:${right.chatId}`;
  return leftKey.localeCompare(rightKey);
}

/**
 * Search all canonical history locally. The response contains safe pointers and
 * bounded snippets only; raw chat/result payloads never cross the Main boundary.
 */
export function searchOneHistory(input: unknown): OneSearchPageV1 {
  const request = normalizeRequest(input);
  const terms = queryTerms(request.query);
  const fetchLimit = request.limit + 1;
  const hits = [
    ...taskCandidates(terms, request.includeArchived, request.cursor, fetchLimit)
      .filter((row) => TASK_STATUS.has(row.status))
      .map((row) => taskHit(row, terms)),
    ...conversationCandidates(terms, request.includeArchived, request.cursor, fetchLimit).map((row) => conversationHit(row, terms)),
  ].filter((hit) => hit.matchedBy.length > 0).sort(compareHits);
  const pageHits = hits.slice(0, request.limit);
  return {
    contractVersion: ONE_SEARCH_CONTRACT_VERSION,
    query: request.query,
    hits: pageHits,
    nextCursor: hits.length > request.limit && pageHits.length > 0
      ? encodeCursor(pageHits[pageHits.length - 1], request.query, request.includeArchived)
      : null,
  };
}

interface ArchiveTaskRow {
  id: string;
  status: string;
  updated_at: string;
  archived_at: string | null;
  origin_chat_id: string | null;
}

interface ArchiveChatRow {
  id: string;
  kind: string | null;
  updated_at: string;
  archived_at: string | null;
}

function canonicalVersion(updatedAt: string): number {
  const value = Date.parse(updatedAt);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function nextMutationTimestamp(...timestamps: string[]): string {
  const prior = timestamps
    .map((value) => Date.parse(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const next = Math.max(Date.now(), ...(prior.length ? prior.map((value) => value + 1) : [1]));
  return new Date(next).toISOString();
}

function archiveStateRunId(taskId: string, chatId: string): string {
  return `one-archive:${createHash("sha256").update(taskId).update("\0").update(chatId).digest("hex")}`;
}

function priorStatusForRestore(task: ArchiveTaskRow, chat: ArchiveChatRow): string {
  const runId = archiveStateRunId(task.id, chat.id);
  const rows = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE run_id = ? AND kind = ? AND chat_id = ?
     ORDER BY seq DESC LIMIT 8`,
  ).all(runId, ARCHIVE_STATE_EVENT_KIND, chat.id) as Array<{ payload_json: string }>;
  for (const row of rows) {
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (
        !isRecord(payload) ||
        Object.keys(payload).some((key) => !["taskId", "chatId", "priorStatus", "archivedTaskVersion", "archivedAt"].includes(key)) ||
        payload.taskId !== task.id || payload.chatId !== chat.id ||
        payload.archivedTaskVersion !== canonicalVersion(task.updated_at) ||
        payload.archivedAt !== task.archived_at ||
        typeof payload.priorStatus !== "string" || !RESTORABLE_TASK_STATUS.has(payload.priorStatus)
      ) continue;
      return payload.priorStatus;
    } catch {
      // Ignore corrupt or legacy receipts and use the conservative open state.
    }
  }
  return "open";
}

function insertArchiveStateReceipt(input: {
  taskId: string;
  chatId: string;
  priorStatus: string;
  archivedTaskVersion: number;
  archivedAt: string;
}): void {
  if (!RESTORABLE_TASK_STATUS.has(input.priorStatus)) {
    throw new Error("Task state cannot be archived safely");
  }
  const db = getDb();
  const runId = archiveStateRunId(input.taskId, input.chatId);
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?")
    .get(runId) as { seq: number }).seq;
  db.prepare(
    `INSERT INTO run_events
       (id, run_id, seq, ts, kind, chat_id, automation_id, node_id, agent_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    `evt_${randomUUID()}`,
    runId,
    seq,
    input.archivedAt,
    ARCHIVE_STATE_EVENT_KIND,
    input.chatId,
    JSON.stringify(input),
  );
}

function normalizeArchiveMutation(value: unknown): OneTaskArchiveMutationInputV1 {
  if (!isRecord(value)) throw new TypeError("One Task archive request is required");
  assertOnlyKeys(value, [
    "contractVersion",
    "taskId",
    "expectedTaskVersion",
    "expectedOriginChatUpdatedAt",
    "operation",
    "confirmedByUser",
  ]);
  if (value.contractVersion !== ONE_SEARCH_CONTRACT_VERSION) {
    throw new TypeError("Unsupported One Task archive contract version");
  }
  if (typeof value.taskId !== "string" || !/^task_[A-Za-z0-9._:-]{1,256}$/.test(value.taskId)) {
    throw new TypeError("Invalid One Task archive target");
  }
  if (!Number.isSafeInteger(value.expectedTaskVersion) || Number(value.expectedTaskVersion) < 1) {
    throw new TypeError("Invalid expected One Task version");
  }
  if (
    typeof value.expectedOriginChatUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.expectedOriginChatUpdatedAt))
  ) {
    throw new TypeError("Invalid expected origin conversation version");
  }
  if (value.operation !== "archive" && value.operation !== "restore") {
    throw new TypeError("Invalid One Task archive operation");
  }
  if (value.confirmedByUser !== true) {
    throw new TypeError("One Task archive mutation requires explicit user confirmation");
  }
  return value as unknown as OneTaskArchiveMutationInputV1;
}

/**
 * Atomically archive or restore one canonical Task and its exact origin chat.
 * Both optimistic versions and the server-owned binding are checked inside the
 * same SQLite transaction, so double-clicks, stale tabs, and process restarts
 * cannot produce a half-archived projection.
 */
export function mutateOneTaskArchive(input: unknown): OneTaskArchiveMutationResultV1 {
  const request = normalizeArchiveMutation(input);
  const db = getDb();
  const mutate = db.transaction(() => {
    const task = db.prepare(
      "SELECT id, status, updated_at, archived_at, origin_chat_id FROM tasks WHERE id = ? LIMIT 1",
    ).get(request.taskId) as ArchiveTaskRow | undefined;
    if (!task || !task.origin_chat_id || task.id.startsWith("task_pairing_")) {
      throw new Error("Canonical One Task is unavailable");
    }
    const chat = db.prepare(
      "SELECT id, kind, updated_at, archived_at FROM chats WHERE id = ? LIMIT 1",
    ).get(task.origin_chat_id) as ArchiveChatRow | undefined;
    if (!chat || chat.kind === "division") throw new Error("Canonical origin conversation is unavailable");
    if (canonicalVersion(task.updated_at) !== request.expectedTaskVersion) {
      throw new Error("Task changed before the archive action; review the current Task state");
    }
    if (chat.updated_at !== request.expectedOriginChatUpdatedAt) {
      throw new Error("Conversation changed before the archive action; review the current Task state");
    }
    if (request.operation === "archive") {
      if (task.status === "archived" || task.archived_at || chat.archived_at) {
        throw new Error("Task is already archived");
      }
      if (task.status === "running") throw new Error("A running Task cannot be archived");
    } else if (task.status !== "archived" || !task.archived_at || !chat.archived_at) {
      throw new Error("Task is not archived");
    }

    const now = nextMutationTimestamp(task.updated_at, chat.updated_at);
    const nextArchived = request.operation === "archive";
    const nextStatus = nextArchived ? "archived" : priorStatusForRestore(task, chat);
    const taskResult = db.prepare(
      `UPDATE tasks
       SET status = ?, updated_at = ?, archived_at = ?
       WHERE id = ? AND updated_at = ? AND origin_chat_id = ?`,
    ).run(nextStatus, now, nextArchived ? now : null, task.id, task.updated_at, chat.id);
    const chatResult = db.prepare(
      `UPDATE chats
       SET updated_at = ?, archived_at = ?
       WHERE id = ? AND updated_at = ?`,
    ).run(now, nextArchived ? now : null, chat.id, chat.updated_at);
    // `ensureCanonicalTaskForChat()` treats the root chat timestamp as the
    // latest owner-participant observation. Advance that projection in the
    // same transaction so a subsequent read cannot manufacture a second Task
    // version after this CAS receipt has already been returned.
    db.prepare(
      `UPDATE task_agent_participants
       SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
       WHERE task_id = ?`,
    ).run(now, now, task.id);
    if (taskResult.changes !== 1 || chatResult.changes !== 1) {
      throw new Error("Task changed before the archive action; review the current Task state");
    }
    if (nextArchived) {
      insertArchiveStateReceipt({
        taskId: task.id,
        chatId: chat.id,
        priorStatus: task.status,
        archivedTaskVersion: canonicalVersion(now),
        archivedAt: now,
      });
    }
    return {
      contractVersion: ONE_SEARCH_CONTRACT_VERSION,
      operation: request.operation,
      taskId: task.id,
      chatId: chat.id,
      priorTaskVersion: canonicalVersion(task.updated_at),
      priorOriginChatUpdatedAt: chat.updated_at,
      taskVersion: canonicalVersion(now),
      originChatUpdatedAt: now,
      archived: nextArchived,
    } satisfies OneTaskArchiveMutationResultV1;
  });
  const result = mutate();
  emitDesktopStoreChange({ entity: "task", id: result.taskId });
  emitDesktopStoreChange({ entity: "chat", id: result.chatId });
  return result;
}
