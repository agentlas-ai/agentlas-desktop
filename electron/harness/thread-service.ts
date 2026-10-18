/*
 * Thread / Turn service over the existing journal (docs/2026-10-13-native-harness/12 §4 "대화 생성·조회·목록·재개",
 * "turn start/queue/steer/interrupt"; F3). App Server's thread/* and turn/* meanings for every executor, served from
 * Agentlas' own store and invocation service — the same rows the app shows — so a native thread id is never the
 * authority and API/local runs get the same view:
 *   thread.list      recent conversations (or one project's), newest first, with whether a turn is running
 *   thread.read      one conversation's messages, oldest first, paged backwards with `cursor` (opaque id+createdAt keyset,
 *                    the same contract as Terminal's thread read); a legacy `before` ISO time still reads strictly older rows
 *   turn.status      the newest run receipt of a conversation (running / completed / failed …)
 *   turn.interrupt   Stop the running turn — owner surfaces only; a model's harness_call cannot stop another run
 *   turn.start       Owner surfaces only: start a turn in an idle Work thread through the same Main start the Goal
 *                    continuation uses (invocationService.start + admitMainInvocation). One threads are daemon-owned
 *                    (native prepared start), so they are refused with their entry instead of a second start path.
 * No electron import at top level (the invocation service is loaded on use, Main only).
 */

type Ctx = { chatId: string; runId: string; dryRun?: boolean };
type Outcome = { status: "ok"; data: unknown } | { status: "refused" | "unavailable"; reason: string; next?: string };

const TEXT_LIMIT = 4000;

async function invocation(): Promise<{ activeChatIds(): string[]; latestReceipt(chatId: string): unknown; latestOwnerReceipt(chatId: string): unknown; cancel(runId: string): string;
  start(req: unknown, binding?: unknown, context?: unknown, question?: unknown, purpose?: unknown, admission?: unknown): { runId: string } } | null> {
  try { return (await import("../invocation/service")).invocationService as never; } catch { return null; }
}

export async function threadList(args: Record<string, unknown>): Promise<Outcome> {
  const chats = await import("../store/chats");
  const limit = Math.max(1, Math.min(200, typeof args.limit === "number" ? Math.floor(args.limit) : 50));
  const rows = typeof args.projectId === "string" && args.projectId ? chats.listChatsByProject(args.projectId).slice(0, limit) : chats.listRecentChats(limit);
  const active = new Set((await invocation())?.activeChatIds() ?? []);
  return { status: "ok", data: { threads: rows.map((chat) => ({
    threadId: chat.id, title: chat.title, agentId: chat.agentId ?? null, projectId: chat.projectId ?? null,
    updatedAt: (chat as { updatedAt?: string }).updatedAt ?? null, running: active.has(chat.id),
  })) } };
}

/** Opaque page cursor: the oldest row of the page, id + createdAt (store keyset order created_at DESC, id DESC). */
export function encodeThreadCursor(row: { id: string; createdAt: string }): string {
  return `c1.${Buffer.from(JSON.stringify([row.id, row.createdAt]), "utf8").toString("base64url")}`;
}

export function decodeThreadCursor(raw: string): { id: string; createdAt: string } | null {
  if (!raw.startsWith("c1.") || raw.length > 2048) return null;
  try {
    const value = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && value[0] && typeof value[1] === "string" && value[1]
      ? { id: value[0], createdAt: value[1] } : null;
  } catch {
    return null;
  }
}

type HistoryRow = { id: string; role: string; text: string; createdAt: string };
type HistoryPage = { messages: HistoryRow[]; hasOlder: boolean };

/**
 * Legacy `before` (an ISO time from an older caller): the newest `limit` rows strictly older than that time, read through the
 * same keyset pages so an equal-timestamp run is never split and no 2000-row window caps how far back it reaches.
 */
function legacyPageBefore(readPage: (limit: number, before?: { id: string; createdAt: string }) => HistoryPage, limit: number, before: string): HistoryPage {
  let kept: HistoryRow[] = [];
  let cursor: { id: string; createdAt: string } | undefined;
  for (;;) {
    const page = readPage(200, cursor);
    kept = [...page.messages.filter((row) => row.createdAt < before), ...kept];
    if (kept.length > limit || !page.hasOlder || !page.messages.length) return { messages: kept.slice(-limit), hasOlder: kept.length > limit };
    cursor = { id: page.messages[0].id, createdAt: page.messages[0].createdAt };
  }
}

export async function threadRead(args: Record<string, unknown>): Promise<Outcome> {
  const chats = await import("../store/chats");
  const threadId = typeof args.threadId === "string" ? args.threadId : "";
  const chat = threadId ? chats.getChat(threadId) : null;
  if (!chat) return { status: "refused", reason: "thread_unknown", next: "thread.list returns thread ids" };
  const limit = Math.max(1, Math.min(200, typeof args.limit === "number" ? Math.floor(args.limit) : 50));
  const rawCursor = typeof args.cursor === "string" ? args.cursor : typeof args.before === "string" && args.before.startsWith("c1.") ? args.before : null;
  const legacyBefore = !rawCursor && typeof args.before === "string" && args.before ? args.before : null;
  // System rows are excluded before the limit (store transcript page), exactly as Terminal's thread read does, so the same
  // data and limit give the same pages and cursors on both surfaces.
  const readPage = (n: number, before?: { id: string; createdAt: string }) => chats.listChatTranscriptPage(threadId, n, before);
  let page: HistoryPage;
  if (rawCursor) {
    const before = decodeThreadCursor(rawCursor);
    if (!before) return { status: "refused", reason: "cursor_invalid", next: "pass olderCursor from the previous page" };
    // The store refuses a cursor whose row is gone (deleted) rather than guessing a position.
    try { page = readPage(limit, before); } catch { return { status: "refused", reason: "cursor_stale", next: "read the newest page again" }; }
  } else if (legacyBefore) {
    page = legacyPageBefore(readPage, limit, legacyBefore);
  } else {
    page = readPage(limit);
  }
  const oldest = page.messages[0];
  return { status: "ok", data: {
    threadId, title: chat.title, archived: Boolean(chat.archivedAt),
    items: page.messages.map((row) => ({ id: row.id, role: row.role, createdAt: row.createdAt,
      text: row.text.length > TEXT_LIMIT ? `${row.text.slice(0, TEXT_LIMIT)}…` : row.text, truncated: row.text.length > TEXT_LIMIT })),
    olderCursor: page.hasOlder && oldest ? encodeThreadCursor(oldest) : null,
    // Kept for callers of the earlier contract; equal timestamps make it lossy, olderCursor is exact.
    olderBefore: page.hasOlder && oldest ? oldest.createdAt : null,
  } };
}

export async function turnStatus(args: Record<string, unknown>): Promise<Outcome> {
  const threadId = typeof args.threadId === "string" ? args.threadId : "";
  if (!threadId) return { status: "refused", reason: "arguments_missing", next: "required: threadId" };
  const service = await invocation();
  if (!service) return { status: "unavailable", reason: "invocation_service_unavailable", next: "turn state is read in the app's main process" };
  const receipt = service.latestReceipt(threadId) as { runId?: string; status?: string; startedAt?: string; finishedAt?: string; model?: string; errorCode?: string } | null;
  return { status: "ok", data: {
    threadId, running: service.activeChatIds().includes(threadId),
    turn: receipt ? { runId: receipt.runId, status: receipt.status, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt ?? null,
      model: receipt.model ?? null, errorCode: receipt.errorCode ?? null } : null,
  } };
}

export async function turnInterrupt(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return { status: "refused", reason: "dry_run" };
  if (ctx.chatId !== "ui") return { status: "refused", reason: "owner_only", next: "Stop is the owner's control; a run cannot stop another run" };
  const threadId = typeof args.threadId === "string" ? args.threadId : "";
  if (!threadId) return { status: "refused", reason: "arguments_missing", next: "required: threadId" };
  const service = await invocation();
  if (!service) return { status: "unavailable", reason: "invocation_service_unavailable" };
  const receipt = service.latestReceipt(threadId) as { runId?: string } | null;
  if (!receipt?.runId || !service.activeChatIds().includes(threadId)) return { status: "refused", reason: "no_running_turn" };
  const result = service.cancel(receipt.runId);
  return result === "not-found" ? { status: "refused", reason: "no_running_turn" } : { status: "ok", data: { threadId, runId: receipt.runId, stop: result } };
}

export async function turnStart(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return { status: "refused", reason: "dry_run" };
  if (ctx.chatId !== "ui") return { status: "refused", reason: "owner_only", next: "a run cannot start a turn in another conversation" };
  const threadId = typeof args.threadId === "string" ? args.threadId : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!threadId || !text) return { status: "refused", reason: "arguments_missing", next: "required: threadId, text" };
  if (text.length > 200_000) return { status: "refused", reason: "text_too_long" };
  const chats = await import("../store/chats");
  const chat = chats.getChat(threadId);
  if (!chat) return { status: "refused", reason: "thread_unknown", next: "thread.list returns thread ids" };
  if ((chat as { originSurface?: string }).originSurface === "one") {
    return { status: "refused", reason: "one_thread_owner_entry", next: "One threads start from the One composer (daemon-owned) or mobile one.invoke.start" };
  }
  const service = await invocation();
  if (!service) return { status: "unavailable", reason: "invocation_service_unavailable", next: "turns start in the app's main process" };
  if (service.activeChatIds().includes(threadId)) return { status: "refused", reason: "turn_running", next: "wait, or Stop it with turn.interrupt" };
  // The owner's last turn, not a host-written one (a read-only teammate report or a Goal continuation).
  const latest = service.latestOwnerReceipt(threadId) as { executionPermission?: string } | null;
  const permissions = args.permissions === "read" || args.permissions === "write" || args.permissions === "full"
    ? args.permissions : latest?.executionPermission === "write" || latest?.executionPermission === "full" ? latest.executionPermission : "read";
  const [{ currentUiLocale }, { admitMainInvocation }, { randomUUID }] = await Promise.all([
    import("../ui-locale"), import("../runtime/scheduled-root-context"), import("node:crypto"),
  ]);
  const runId = randomUUID();
  const started = service.start({ runId, chatId: threadId, userPrompt: text, locale: currentUiLocale(), permissions },
    undefined, undefined, undefined, undefined, admitMainInvocation(threadId, runId));
  return { status: "ok", data: { threadId, runId: started.runId, permissions } };
}
