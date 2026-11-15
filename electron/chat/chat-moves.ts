import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { deliver, type DeliverPorts, type DeliverResult, type PeerRefusalCode } from "../harness/deliver";
import { peerChatFacts } from "../harness/deliver-runtime";
import type {
  ChatNewChatOptions, ChatProjectAttachInput, ChatProjectAttachResult, ChatSendToConversationInput, ChatSendToConversationResult,
} from "../../shared/types";

/*
 * What the Workspace screen's New chat, "add environment" and "send to another conversation" need from Main.
 * Three small hosts-side moves over rows that already exist; nothing here stores anything new:
 *   attachChatToProject   a Work session that started without a project joins a project (existing, or made from a folder) - its next
 *                         turn reads that project's working folder, memory and map. The rows of the conversation are not touched.
 *   newChatOptions        the values the New chat start screen shows: the project of the conversation being looked at, the agents.
 *   ownerSendToConversation  the owner sends words to another conversation of the same project: the same range check as a message between
 *                         agents (harness/deliver.ts), no approval card (the owner is the one sending), and the receiving conversation reads
 *                         the words as the owner's own (ownerSpoke), not as a colleague's envelope.
 */

// ── attach ────────────────────────────────────────────────────────────────

export interface AttachDeps {
  /** Is a turn of this conversation running (this process or another that holds its lease)? */
  isRunning(chatId: string): boolean;
  /** The id of the run that holds the conversation now, when it is known (it goes into the `turn_running` answer). */
  runningRunId?(chatId: string): string | null;
  /** Runs after a project was made from a folder (the project map seed; the caller's background work). */
  onProjectCreated?(project: { id: string; name: string; folderPath: string }): void;
}

export function productionAttachDeps(): AttachDeps {
  return {
    isRunning(chatId) {
      try {
        const service = (require("../invocation/service") as typeof import("../invocation/service")).invocationService; // eslint-disable-line @typescript-eslint/no-require-imports
        if (service.activeChatIds().includes(chatId)) return true;
        const owner = (require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationRunOwners.getActiveOwner(chatId); // eslint-disable-line @typescript-eslint/no-require-imports
        return Boolean(owner && owner.state !== "released");
      } catch { return false; }
    },
    runningRunId(chatId) {
      try {
        const owner = (require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationRunOwners.getActiveOwner(chatId); // eslint-disable-line @typescript-eslint/no-require-imports
        return owner && owner.state !== "released" ? owner.runId : null;
      } catch { return null; }
    },
  };
}

type ChatRow = { id: string; agent_id: string; project_id: string | null; kind: string | null; origin_surface: string | null; surface_pack: string | null; archived_at: string | null; parent_chat_id: string | null };
const refusal = (code: Extract<ChatProjectAttachResult, { ok: false }>["code"], message: string): ChatProjectAttachResult => ({ ok: false, code, message });
const sameFolder = (a: string, b: string): boolean => {
  const norm = (value: string) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  return norm(a) === norm(b);
};
const isDirectory = (folder: string): boolean => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };

/**
 * Joins a Work session that has no project to a project: an existing one (`projectId`) or the one of a folder (`folderPath`, an absolute
 * path Main already holds a grant for - the caller resolves the grant). From the conversation's NEXT turn its working folder, project memory
 * and project map are the project's; what the conversation already holds (lines, session memory, checkpoints, its Task) stays with it:
 * the host adopts the conversation's own earlier journal into the project range at the next turn's admission (runtime/session-scope.ts).
 * Memory the conversation wrote before is not moved into the project. A turn running now refuses (`turn_running`), nothing half done.
 */
export function attachChatToProject(input: ChatProjectAttachInput & { folderPath?: string }, deps: AttachDeps = productionAttachDeps()): ChatProjectAttachResult {
  return attachNow(input, deps, input?.reserve === true);
}

function attachNow(input: ChatProjectAttachInput & { folderPath?: string }, deps: AttachDeps, reserve: boolean): ChatProjectAttachResult {
  const chatId = typeof input?.chatId === "string" ? input.chatId : "";
  if (!chatId) return refusal("chat_not_found", "a conversation id is required");
  const db = getDb();
  const chat = db.prepare("SELECT id, agent_id, project_id, kind, origin_surface, surface_pack, archived_at, parent_chat_id FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
  if (!chat) return refusal("chat_not_found", "no such conversation");
  if (chat.archived_at || chat.origin_surface !== "work" || (chat.kind !== "user" && chat.kind !== null) || chat.parent_chat_id || chat.surface_pack) {
    return refusal("chat_not_attachable", "only a Work session of your own can join a project");
  }
  const projectRows = (): Array<{ id: string; name: string; folder_path: string | null }> => db.prepare("SELECT id, name, folder_path FROM projects").all() as Array<{ id: string; name: string; folder_path: string | null }>;
  let target: { id: string; name: string; folderPath: string | null } | null = null;
  let created = false;
  if (typeof input.projectId === "string" && input.projectId) {
    const row = db.prepare("SELECT id, name, folder_path FROM projects WHERE id = ?").get(input.projectId) as { id: string; name: string; folder_path: string | null } | undefined;
    if (!row) return refusal("project_not_found", "no such project");
    target = { id: row.id, name: row.name, folderPath: row.folder_path };
  } else if (typeof input.folderPath === "string" && input.folderPath) {
    const folder = path.resolve(input.folderPath);
    if (!isDirectory(folder)) return refusal("folder_missing", "that folder does not exist");
    const existing = projectRows().find((row) => row.folder_path && sameFolder(row.folder_path, folder));
    if (existing) target = { id: existing.id, name: existing.name, folderPath: existing.folder_path };
  } else return refusal("project_or_folder_required", "name a project or a folder");
  if (chat.project_id) {
    if (target && target.id === chat.project_id) return { ok: true, chatId, projectId: chat.project_id, created: false, alreadyAttached: true, workingFolder: workingFolderOf(chatId), appliesFrom: "next_turn" };
    return refusal("already_in_project", "this conversation already belongs to a project");
  }
  if (target?.folderPath && !isDirectory(target.folderPath)) return refusal("folder_missing", "the project's folder is gone");
  if (deps.isRunning(chatId)) {
    // The attach is not kept for later (a kept request would need an owner of its own and a clean-up); the answer names the run that holds the conversation, so the screen asks again when it ends.
    let runningRunId: string | null = null;
    try { runningRunId = deps.runningRunId?.(chatId) ?? null; } catch { runningRunId = null; }
    // Desktop repair 6 (B-5): a screen that asks for it (`reserve: true`) gets the join kept in this process until the turn ends. Without the flag the answer is the refusal it always was.
    const reservation = reserve ? reserveAttach(chatId, { ...(target ? { projectId: target.id } : {}), ...(!target && typeof input.folderPath === "string" ? { folderPath: path.resolve(input.folderPath) } : {}) }, deps) : null;
    return { ...refusal("turn_running", reservation ? "a turn of this conversation is running; the conversation joins when it ends (kept in this app only: closing the app drops it)" : "a turn of this conversation is running; add the environment when it ends"),
      ...(runningRunId ? { runningRunId } : {}), ...(reservation ? { reservation } : {}) } as ChatProjectAttachResult;
  }
  if (!target) {
    const folder = path.resolve(input.folderPath as string);
    const { createProject } = require("../store/projects") as typeof import("../store/projects"); // eslint-disable-line @typescript-eslint/no-require-imports
    const made = createProject({ name: path.basename(folder) || "Project", sourceType: "local", sourceRef: null, agentPool: [], folderPath: folder });
    target = { id: made.id, name: made.name, folderPath: made.folderPath };
    created = true;
    try { deps.onProjectCreated?.({ id: made.id, name: made.name, folderPath: folder }); } catch { /* the map is seeded again by the next turn's folder visit */ }
  }
  try {
    const seats = require("../store/seats") as typeof import("../store/seats"); // eslint-disable-line @typescript-eslint/no-require-imports
    let seatId: string | null = null;
    try { seatId = seats.ensureSoloSeatForAgent(chat.agent_id, target.id); } catch { seatId = null; /* a seat is re-derived at the next start (I2: NULL is valid) */ }
    const now = new Date().toISOString();
    db.transaction(() => {
      const moved = db.prepare("UPDATE chats SET project_id = ?, working_folder = COALESCE(?, working_folder), updated_at = ? WHERE id = ? AND project_id IS NULL")
        .run(target!.id, target!.folderPath, now, chatId);
      if (moved.changes !== 1) throw Object.assign(new Error("chat_changed"), { code: "chat_changed" });
      if (seatId) db.prepare("UPDATE chats SET seat_id = ? WHERE id = ?").run(seatId, chatId);
    }).immediate();
    if (seatId) { try { seats.applySeatSnapshotToChats(seatId); } catch { /* display snapshot only */ } }
    // The conversation's Task follows its project (the same reconcile every Work list runs).
    try { (require("../store/tasks") as typeof import("../store/tasks")).ensureCanonicalTaskForChat(chatId); } catch { /* reconciled by the next read */ } // eslint-disable-line @typescript-eslint/no-require-imports
    try { (require("../store/projects") as typeof import("../store/projects")).touchProject(target.id); } catch { /* ordering only */ } // eslint-disable-line @typescript-eslint/no-require-imports
    try { (require("../store/change-bus") as typeof import("../store/change-bus")).emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* the next list read shows it */ } // eslint-disable-line @typescript-eslint/no-require-imports
  } catch (error) {
    return refusal(((error as { code?: unknown })?.code === "chat_changed" ? "already_in_project" : "unavailable") as "already_in_project" | "unavailable", "the conversation could not join the project; nothing changed");
  }
  return { ok: true, chatId, projectId: target.id, created, alreadyAttached: false, workingFolder: workingFolderOf(chatId), appliesFrom: "next_turn" };
}

// ── a join asked for while a turn runs (desktop 3, Workspace B-5; desktop repair 6) ───────────────────────────────────────────────────────

/*
 * WHAT: one in-memory entry per conversation (a project id, or a folder Main already holds a grant for) while its turn runs. NO table, no file: closing the app drops it, and the answer says so
 * (`keptAcrossRestart: false`), because the turn it waited for dies with the app and nothing else would apply it.
 * WHO READS IT: the turn-end signals below (this process's active-chats set; another process's turn end arrives as a `chat` change on the store bus), and `attachProjectPending` (the screen, to show "joins when the turn ends").
 * WHEN IT GOES: when it is applied or refused at a turn end; after `ATTACH_RESERVATION_MS` (24 h; one one-shot timer aimed at the earliest end, no polling); when the conversation is attached by hand meanwhile; at most
 * `ATTACH_RESERVATION_MAX` at once (the oldest is dropped). Nothing stands subscribed while there is no entry. A failed apply leaves one short-lived note for the screen (`lastFailure`, read once, gone after an hour).
 */
const ATTACH_RESERVATION_MS = 24 * 60 * 60 * 1000;
const ATTACH_RESERVATION_MAX = 20;
const ATTACH_FAILURE_NOTE_MS = 60 * 60 * 1000;
interface AttachReservation { projectId?: string; folderPath?: string; until: number; deps: AttachDeps }
const reservations = new Map<string, AttachReservation>();
const failureNotes = new Map<string, { code: string; at: number }>();
let reservationOffs: Array<() => void> = [];
let reservationTimer: ReturnType<typeof setTimeout> | null = null;

function reserveAttach(chatId: string, what: { projectId?: string; folderPath?: string }, deps: AttachDeps): NonNullable<Extract<ChatProjectAttachResult, { ok: false }>["reservation"]> {
  const until = Date.now() + ATTACH_RESERVATION_MS;
  reservations.delete(chatId);
  while (reservations.size >= ATTACH_RESERVATION_MAX) { const oldest = reservations.keys().next().value as string; reservations.delete(oldest); }
  failureNotes.delete(chatId);
  reservations.set(chatId, { ...what, until, deps });
  subscribeForReservations();
  armReservationTimer();
  return { projectId: what.projectId ?? null, until: new Date(until).toISOString(), keptAcrossRestart: false };
}

function subscribeForReservations(): void {
  if (reservationOffs.length) return;
  try {
    const service = (require("../invocation/service") as typeof import("../invocation/service")).invocationService; // eslint-disable-line @typescript-eslint/no-require-imports
    reservationOffs.push(service.onActiveChats(() => applyReservations()));
  } catch { /* no live service here: the store-change signal below still arrives */ }
  try {
    const bus = require("../store/change-bus") as typeof import("../store/change-bus"); // eslint-disable-line @typescript-eslint/no-require-imports
    reservationOffs.push(bus.onDesktopStoreChange((change) => { if (change.entity === "chat" && change.id && reservations.has(change.id)) applyReservations(); }));
  } catch { /* nothing else to listen to */ }
}
function releaseReservationWatch(): void {
  if (reservations.size > 0) return;
  for (const off of reservationOffs) { try { off(); } catch { /* gone */ } }
  reservationOffs = [];
  if (reservationTimer) { clearTimeout(reservationTimer); reservationTimer = null; }
}
function armReservationTimer(): void {
  if (reservationTimer) { clearTimeout(reservationTimer); reservationTimer = null; }
  if (!reservations.size) return;
  const earliest = Math.min(...[...reservations.values()].map((entry) => entry.until));
  reservationTimer = setTimeout(() => { reservationTimer = null; applyReservations(); }, Math.max(1000, Math.min(earliest - Date.now(), 2_147_000_000)));
  (reservationTimer as { unref?: () => void }).unref?.();
}

/** Looks at every kept join: a turn that has ended applies it (once), an old one goes. Runs on a signal, never on a timer of its own (the one-shot timer only ends old entries). */
function applyReservations(): void {
  const now = Date.now();
  for (const [chatId, entry] of [...reservations]) {
    if (entry.until <= now) { reservations.delete(chatId); continue; }
    let running = true;
    try { running = entry.deps.isRunning(chatId); } catch { running = false; }
    if (running) continue;
    reservations.delete(chatId);
    let outcome: ChatProjectAttachResult;
    try { outcome = attachNow({ chatId, ...(entry.projectId ? { projectId: entry.projectId } : {}), ...(entry.folderPath ? { folderPath: entry.folderPath } : {}) } as never, entry.deps, false); }
    catch { outcome = { ok: false, code: "unavailable", message: "the join failed" }; }
    // "already in a project" after a manual attach to the same project is the wanted end; anything else that did not join is a note for the screen.
    if (!outcome.ok && outcome.code !== "already_in_project") failureNotes.set(chatId, { code: outcome.code, at: now });
    if (!outcome.ok) { try { (require("../store/change-bus") as typeof import("../store/change-bus")).emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* the next read shows it */ } } // eslint-disable-line @typescript-eslint/no-require-imports
  }
  for (const [chatId, note] of [...failureNotes]) if (now - note.at > ATTACH_FAILURE_NOTE_MS) failureNotes.delete(chatId);
  armReservationTimer();
  releaseReservationWatch();
}

/** What the screen asks: is a join kept for this conversation, and did the last kept join fail (the code, once)? */
export function attachProjectPending(chatId: unknown): { pending: boolean; projectId?: string | null; until?: string; keptAcrossRestart?: false; lastFailure?: string } {
  const id = typeof chatId === "string" ? chatId : "";
  const entry = reservations.get(id);
  if (entry && entry.until <= Date.now()) { reservations.delete(id); armReservationTimer(); releaseReservationWatch(); }
  const live = reservations.get(id);
  if (live) return { pending: true, projectId: live.projectId ?? null, until: new Date(live.until).toISOString(), keptAcrossRestart: false };
  const note = failureNotes.get(id);
  if (note) { failureNotes.delete(id); if (Date.now() - note.at <= ATTACH_FAILURE_NOTE_MS) return { pending: false, lastFailure: note.code }; }
  return { pending: false };
}

/** A gate's clean slate (nothing outside tests calls it). */
export function resetAttachReservationsForTests(): void { reservations.clear(); failureNotes.clear(); releaseReservationWatch(); }

function workingFolderOf(chatId: string): string | null {
  try { return (getDb().prepare("SELECT working_folder AS folder FROM chats WHERE id = ?").get(chatId) as { folder: string | null } | undefined)?.folder ?? null; } catch { return null; }
}

// ── New chat start screen ─────────────────────────────────────────────────

/**
 * The values the New chat start screen shows. `currentProject` is the project of the conversation being looked at (the project dropdown's
 * default; null = none, then the screen offers "Empty project" or "No project"). `emptyProject` states what an Empty project is in code:
 * a project of `sourceType` "empty" whose folder Main makes and manages (projects:create); "No project" is a Work session with project null
 * (chats:create without projectId): both are open, the screen picks the default. `agents` are the standing teammates an Agent chat can start with.
 */
export function newChatOptions(currentChatId: unknown): ChatNewChatOptions {
  const db = getDb();
  let currentProject: ChatNewChatOptions["currentProject"] = null;
  if (typeof currentChatId === "string" && currentChatId) {
    try {
      const row = db.prepare("SELECT p.id AS id, p.name AS name, p.folder_path AS folderPath, p.source_type AS sourceType FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ?").get(currentChatId) as { id: string; name: string; folderPath: string | null; sourceType: string } | undefined;
      if (row) currentProject = row;
    } catch { currentProject = null; }
  }
  let agents: ChatNewChatOptions["agents"] = [];
  let agentsReadError: ChatNewChatOptions["agentsReadError"];
  try {
    agents = db.prepare(`SELECT m.installed_agent_id AS id, COALESCE(NULLIF(m.display_name, ''), a.name) AS name, COALESCE(a.tone, m.icon) AS tone
        FROM one_org_members m JOIN installed_agents a ON a.id = m.installed_agent_id
        WHERE m.archived_at IS NULL AND m.source <> 'hub' ORDER BY m.sort_order, m.added_at`).all() as ChatNewChatOptions["agents"];
  } catch (error) {
    // A store error is not "no teammates": the screen is told (with a way to ask again), the cause stays in the log.
    agents = []; agentsReadError = "agents_unreadable";
    console.warn(`[chat-moves] newChatOptions: the agent list could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    currentProject,
    workSession: { available: true },
    emptyProject: { sourceType: "empty", managedFolder: true },
    noProject: { available: true },
    agents,
    ...(agentsReadError ? { agentsReadError } : {}),
  };
}

// ── owner sends to another conversation ───────────────────────────────────

const OWNER_SEND_MAX_CHARS = 4000;

function permissionOfChat(chatId: string): "read" | "write" | "full" {
  try {
    const service = (require("../invocation/service") as typeof import("../invocation/service")).invocationService; // eslint-disable-line @typescript-eslint/no-require-imports
    return service.latestOwnerReceipt(chatId)?.executionPermission ?? "write";
  } catch { return "write"; }
}

/** The owner's own send: the range checks are deliver()'s, no card is raised, no chain is recorded, and the words arrive as the owner's. */
export function ownerDeliverPorts(overrides: Partial<DeliverPorts> = {}): DeliverPorts {
  return {
    facts: peerChatFacts,
    chainOfRun: () => null,
    admit: () => "delivered",
    approve: async () => "allow",
    toRoom(input) {
      const rooms = require("../one/room-lead-runtime") as typeof import("../one/room-lead-runtime"); // eslint-disable-line @typescript-eslint/no-require-imports
      return rooms.routeLeadRoomOwnerMessage({ chatId: input.roomChatId, userPrompt: input.body, permissions: permissionOfChat(input.roomChatId) }, "owner", true);
    },
    async toSession(input) {
      const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(input.chatId); // eslint-disable-line @typescript-eslint/no-require-imports
      const permissions = permissionOfChat(input.chatId);
      const locale = (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko" ? "ko" : "en"; // eslint-disable-line @typescript-eslint/no-require-imports
      const { markOwnerSpoke } = require("../invocation/owner-spoke") as typeof import("../invocation/owner-spoke"); // eslint-disable-line @typescript-eslint/no-require-imports
      // The owner's words: user origin (nobody else typed them), queued behind the conversation's running turn or started at once when it is idle.
      const request = markOwnerSpoke({
        chatId: input.chatId, userPrompt: input.text, steeringMode: "queue" as const, taskIntent: "task" as const, locale, permissions,
        ...(chat?.originSurface === "one" ? { oneMode: true, onePermissionMode: permissions } : {}),
      } as never);
      const control = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control"); // eslint-disable-line @typescript-eslint/no-require-imports
      const receipt = await control.steerInvocationOwnerNextTurn(request as never, input.intentId);
      const started = (receipt as { status?: string }).status === "started" || (receipt as { queued?: boolean }).queued === false;
      return { queued: !started, ...((receipt as { runId?: string }).runId ? { runId: (receipt as { runId: string }).runId } : {}) };
    },
    intentId: () => `ownerfwd:${randomUUID()}`,
    ...overrides,
  };
}

/** Why a conversation can never take a message (nothing a resend could fix), when the host knows; {} otherwise (desktop 3, Workspace §4.6 #4). */
function unavailableReason(toChatId: string): { reason?: "room_has_no_members" | "agent_deleted" } {
  try {
    const state = (require("../one/agent-chat-state") as typeof import("../one/agent-chat-state")).agentChatState(toChatId); // eslint-disable-line @typescript-eslint/no-require-imports
    if (state.reason === "no_members") return { reason: "room_has_no_members" };
    if (state.reason === "agent_deleted") return { reason: "agent_deleted" };
  } catch { /* an unknown cause stays unnamed */ }
  return {};
}

export async function ownerSendToConversation(input: ChatSendToConversationInput, ports: DeliverPorts = ownerDeliverPorts()): Promise<ChatSendToConversationResult> {
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  const fromChatId = typeof input?.fromChatId === "string" ? input.fromChatId : "";
  const toChatId = typeof input?.toChatId === "string" ? input.toChatId : "";
  if (!text) return { ok: false, code: "empty", message: "the message is empty; nothing was sent" };
  if (text.length > OWNER_SEND_MAX_CHARS) return { ok: false, code: "too_long", message: `the message is longer than ${OWNER_SEND_MAX_CHARS} characters; nothing was sent` };
  if (!fromChatId || !toChatId) return { ok: false, code: "not_found", message: "both conversations are required; nothing was sent" };
  let result: DeliverResult;
  try {
    // deliver() writes the words as a colleague's envelope for the session hand-off; the owner's own words go as typed.
    const owner: DeliverPorts = { ...ports, toSession: (input) => ports.toSession({ ...input, text }) };
    result = await deliver({ fromChatId, fromRunId: `owner-send:${randomUUID()}`, toChatId, text, attended: true, permission: "full" }, owner);
  } catch {
    return { ok: false, code: "unavailable", message: "the message could not be handed to that conversation; nothing was sent", ...unavailableReason(toChatId) };
  }
  // The owner's words carry no chain and never join a peer bundle, so "bundle_full" cannot come back here; the shared answer has no such code.
  if (!result.ok) {
    const code = (result.code === "bundle_full" ? "unavailable" : result.code) as Exclude<PeerRefusalCode, "bundle_full">;
    return { ok: false, code, message: result.message, ...(code === "unavailable" ? unavailableReason(toChatId) : {}) };
  }
  return { ok: true, to: result.to, queued: result.queued, ...(result.runId ? { runId: result.runId } : {}) };
}
