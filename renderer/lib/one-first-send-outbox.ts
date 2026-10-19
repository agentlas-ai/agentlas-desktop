import type { OrchestrationTarget, RuntimeSelection } from "../../shared/types";

/**











 */
export type FirstSendSurface = "one" | "work";

/** A local terminal state. The text stays in the transcript with a one-tap resend; nothing is sent automatically. */
export type FirstSendHold = "previous_pending" | "refused" | "stale" | "attachments" | "setup";

/** The gesture's choices, frozen at send time, so a resume runs what the owner pressed send on. */
export type FirstSendChoices = {
  runtimeSelection?: RuntimeSelection;
  /** One permission mode ("auto" | "read" | "write" | "full") or the Work permission level. */
  permission?: string;
  overrides?: { goalMode?: boolean; planMode?: boolean; fastMode?: boolean; sessionRouting?: boolean };
  taskForceTargets?: OrchestrationTarget[];
  /** Work send options without attachments (JSON-safe). */
  work?: Record<string, unknown>;
};

export type FirstSendEntry = {
  /** One: the preflight submission id. Work: the run id. */
  intentId: string;
  surface: FirstSendSurface;
  /** null until a fresh One conversation exists. */
  chatId: string | null;
  userPrompt: string;
  createdAt: string;
  /** Every setup step the send depends on (fresh chat, its workspace and model pin) is durable. */
  ready: boolean;
  /** Attachments cannot be replayed after a reload: the text is kept and the owner attaches again. */
  replayable: boolean;
  /** Set synchronously before the run request crosses IPC. */
  runId?: string;
  /** Local clock when runId was recorded (compared with Main's process start, never trusted as a receipt). */
  runIdAt?: number;
  notSent?: FirstSendHold;
  choices: FirstSendChoices;
};

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "agentlas.first-send-outbox.v1:";
const MAX_ENTRIES = 32;
const HOLDS: ReadonlySet<string> = new Set(["previous_pending", "refused", "stale", "attachments", "setup"]);
/** A send older than this is not replayed into a new turn (the follow-up outbox uses the same window). */
export const FIRST_SEND_RESUME_WINDOW_MS = 10 * 60_000;

export function firstSendStorageKey(surface: FirstSendSurface, chatId: string | null): string {
  return `${PREFIX}${surface}:${chatId ?? "new"}`;
}

export function firstSendRowId(intentId: string): string {
  return `first-send:${intentId}`;
}

function validEntry(value: unknown, surface: FirstSendSurface, chatId: string | null): value is FirstSendEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<FirstSendEntry>;
  return item.surface === surface && (item.chatId ?? null) === chatId
    && typeof item.intentId === "string" && item.intentId.length > 0 && item.intentId.length <= 200
    && typeof item.userPrompt === "string" && item.userPrompt.trim().length > 0
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.ready === "boolean" && typeof item.replayable === "boolean"
    && (item.runId === undefined || typeof item.runId === "string")
    && (item.runIdAt === undefined || (typeof item.runIdAt === "number" && Number.isFinite(item.runIdAt)))
    && (item.notSent === undefined || HOLDS.has(item.notSent))
    && !!item.choices && typeof item.choices === "object" && !Array.isArray(item.choices);
}

/** Tolerant: a malformed record is dropped, never allowed to block every later send of the chat. */
export function readFirstSends(storage: StoragePort, surface: FirstSendSurface, chatId: string | null): FirstSendEntry[] {
  let raw: string | null;
  try { raw = storage.getItem(firstSendStorageKey(surface, chatId)); } catch { return []; }
  if (!raw) return [];
  let values: unknown;
  try { values = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is FirstSendEntry => validEntry(value, surface, chatId));
}

function write(storage: StoragePort, surface: FirstSendSurface, chatId: string | null, items: FirstSendEntry[]): void {
  const key = firstSendStorageKey(surface, chatId);
  const serialized = items.length ? JSON.stringify(items) : null;
  if (serialized) storage.setItem(key, serialized);
  else storage.removeItem(key);
  if (storage.getItem(key) !== serialized) throw new Error("first_send_not_persisted");
}

/** Throws when the text cannot be kept durably; the caller then keeps the draft and sends nothing. */
export function saveFirstSend(storage: StoragePort, entry: FirstSendEntry): void {
  if (!validEntry(entry, entry.surface, entry.chatId)) throw new Error("first_send_invalid");
  const items = readFirstSends(storage, entry.surface, entry.chatId);
  const existing = items.find(item => item.intentId === entry.intentId);
  if (existing) {
    if (existing.userPrompt !== entry.userPrompt) throw new Error("first_send_identity_conflict");
    return;
  }
  if (items.length >= MAX_ENTRIES) throw new Error("first_send_outbox_full");
  write(storage, entry.surface, entry.chatId, [...items, entry]);
}

/** Metadata only: the text, the chat and the gesture's choices never change after capture. */
export function patchFirstSend(storage: StoragePort, surface: FirstSendSurface, chatId: string | null, intentId: string,
  patch: Partial<Pick<FirstSendEntry, "runId" | "runIdAt" | "notSent" | "ready">>): FirstSendEntry | null {
  const items = readFirstSends(storage, surface, chatId);
  const index = items.findIndex(item => item.intentId === intentId);
  if (index < 0) return null;
  const next = { ...items[index], ...patch };
  if (patch.notSent === undefined && "notSent" in patch) delete next.notSent;
  items[index] = next;
  write(storage, surface, chatId, items);
  return next;
}

/** A fresh conversation now exists: the record moves from the "new" slot to that chat in one verified step. */
export function moveFirstSendToChat(storage: StoragePort, surface: FirstSendSurface, intentId: string, chatId: string): FirstSendEntry | null {
  const entry = readFirstSends(storage, surface, null).find(item => item.intentId === intentId);
  if (!entry) return null;
  const moved: FirstSendEntry = { ...entry, chatId };
  saveFirstSend(storage, moved);
  removeFirstSend(storage, surface, null, intentId);
  return moved;
}

export function removeFirstSend(storage: StoragePort, surface: FirstSendSurface, chatId: string | null, intentId: string): void {
  const items = readFirstSends(storage, surface, chatId);
  if (!items.some(item => item.intentId === intentId)) return;
  write(storage, surface, chatId, items.filter(item => item.intentId !== intentId));
}

/** Main's answer for the run the entry recorded (invoke:admission), reduced to the fields the decision reads. */
export type FirstSendAdmissionFact = {
  status: "absent" | "pending" | "admitted" | "rejected";
  chatId?: string | null;
  refusedBeforeReservation?: boolean;
  ownerProcessStartedAt?: number;
};

export type FirstSendResumePlan =
  | { kind: "remove" }
  | { kind: "wait" }
  | { kind: "resume" }
  | { kind: "hold"; reason: FirstSendHold }
  | { kind: "shown" };

/**
 * What a reopened renderer does with one saved send. Pure, so every branch is checked without a renderer:
 * - Main admitted (or is admitting) the recorded run: the transcript owns the message, the record goes.
 * - Main refused it after reserving it: shown as not sent, never re-run automatically.
 * - Main never received the run request (refused before reservation, or recorded before this Main started): resume.
 * - anything else unknown: wait for the next look. Never a second run on an unknown answer.
 */
export function planFirstSendResume(entry: FirstSendEntry, facts: {
  now: number; admission?: FirstSendAdmissionFact | null;
}): FirstSendResumePlan {
  if (entry.notSent) return { kind: "shown" };
  if (entry.runId) {
    const admission = facts.admission;
    if (!admission) return { kind: "wait" };
    if (admission.status !== "absent" && admission.chatId && admission.chatId !== entry.chatId) return { kind: "wait" };
    if (admission.status === "admitted") return { kind: "remove" };
    if (admission.status === "pending") return { kind: "wait" };
    if (admission.status === "rejected") return { kind: "hold", reason: "refused" };
    const provenNoStart = admission.refusedBeforeReservation === true
      || (typeof admission.ownerProcessStartedAt === "number" && typeof entry.runIdAt === "number"
        && entry.runIdAt < admission.ownerProcessStartedAt);
    if (!provenNoStart) return { kind: "wait" };
  }
  if (!entry.ready) return { kind: "hold", reason: "setup" };
  if (!entry.replayable) return { kind: "hold", reason: "attachments" };
  if (facts.now - Date.parse(entry.createdAt) > FIRST_SEND_RESUME_WINDOW_MS) return { kind: "hold", reason: "stale" };
  return { kind: "resume" };
}

/** A durable user row with the same words, written at or after the send, is that send. */
export function firstSendEchoed(entry: Pick<FirstSendEntry, "userPrompt" | "createdAt">, messages: ReadonlyArray<{
  role: string; text: string; createdAt?: string; durableMessageId?: string;
}>): boolean {
  const sentAt = Date.parse(entry.createdAt);
  return messages.some(message => message.role === "user" && Boolean(message.durableMessageId)
    && message.text.trim() === entry.userPrompt.trim()
    && (!message.createdAt || !Number.isFinite(Date.parse(message.createdAt)) || Date.parse(message.createdAt) >= sentAt - 5_000));
}

/**
 * The saved sends of a chat that the transcript must draw: a row with the same words already on screen at or after
 * the send (the optimistic or the durable row) is that send.
 */
export function firstSendsToDraw<M extends { id: string; role: string; text: string; createdAt?: string }>(
  entries: readonly FirstSendEntry[], messages: readonly M[], chatId: string | null,
): FirstSendEntry[] {
  return entries.filter(entry => entry.chatId !== null && entry.chatId === chatId
    && !messages.some(message => message.id === firstSendRowId(entry.intentId))
    && !messages.some(message => message.role === "user" && message.text.trim() === entry.userPrompt.trim()
      && (!message.createdAt || !Number.isFinite(Date.parse(message.createdAt))
        || Date.parse(message.createdAt) >= Date.parse(entry.createdAt) - 5_000)));
}

/** What the reopened room may read and do. Injected, so the decision loop runs the same in the renderer and a gate. */
export type FirstSendResumeDeps = {
  entries(): FirstSendEntry[];
  /** A submit of this renderer is driving it right now. */
  isLive(intentId: string): boolean;
  /** This renderer session created or resumed it; it is settled by its own outcome, never auto-resumed again. */
  isOwnSession(intentId: string): boolean;
  /** A run or a preparation of this renderer is in progress in the room. */
  blocked(): boolean;
  /** Main's answer for a recorded run ID. Throws when unreadable (nothing is decided then). */
  admission(runId: string): Promise<FirstSendAdmissionFact>;
  /** The room is still the one on screen. */
  stillOpen(): boolean;
  /** The run ID this renderer's uncertain-admission fence names for the chat, if any. */
  uncertainRunId(): string | null;
  clearUncertain(runId: string): void;
  /** Main lists the chat as active (a turn is still settling). Throws when unreadable. */
  chatActive(): Promise<boolean>;
  settle(intentId: string): void;
  hold(intentId: string, reason: FirstSendHold): void;
  tries(intentId: string): number;
  setTries(intentId: string, tries: number): void;
  /** Re-run the send pipeline for this exact saved send (it takes its held submission over once). */
  resume(entry: FirstSendEntry): Promise<void>;
  now(): number;
};

export const FIRST_SEND_MAX_RESUMES = 3;

/**
 * One look at a reopened room's saved sends, oldest first. Main's receipts decide: taken -> the saved copy goes;
 * never received -> it resumes exactly once with its frozen choices; refused, interrupted mid-setup or older than the
 * window -> it stays visible as not sent. Never a second run on an unknown answer.
 */
export async function resumeFirstSends(deps: FirstSendResumeDeps): Promise<"idle" | "waiting" | "resumed"> {
  for (const entry of deps.entries()) {
    if (entry.notSent) continue;
    if (deps.isLive(entry.intentId)) return "waiting";
    const ownSession = deps.isOwnSession(entry.intentId);
    if (ownSession && !entry.runId) return "waiting"; // its own outcome (e.g. a team decision) is still to come
    if (deps.blocked()) return "waiting";
    let admission: FirstSendAdmissionFact | null = null;
    if (entry.runId) {
      try { admission = await deps.admission(entry.runId); } catch { return "waiting"; }
      if (!deps.stillOpen()) return "waiting";
    }
    const plan = planFirstSendResume(entry, { now: deps.now(), admission });
    if (plan.kind === "remove") { deps.settle(entry.intentId); continue; }
    if (plan.kind === "hold") {
      deps.hold(entry.intentId, plan.reason);
      if (entry.runId && admission?.status === "rejected") deps.clearUncertain(entry.runId);
      continue;
    }
    if (plan.kind !== "resume") return "waiting";
    // This renderer already sent it and Main refused it before reservation: no second automatic try.
    if (ownSession) { deps.hold(entry.intentId, "refused"); continue; }
    const tries = deps.tries(entry.intentId);
    if (tries >= FIRST_SEND_MAX_RESUMES) { deps.hold(entry.intentId, "refused"); continue; }
    // Another unresolved run of this room goes first; its own fence handles it.
    const uncertain = deps.uncertainRunId();
    if (uncertain && uncertain !== entry.runId) return "waiting";
    // Main proved this run ID never started: its fence must not block the resume.
    if (entry.runId) deps.clearUncertain(entry.runId);
    try { if (await deps.chatActive()) return "waiting"; } catch { return "waiting"; }
    if (!deps.stillOpen() || deps.blocked() || deps.isLive(entry.intentId)) return "waiting";
    deps.setTries(entry.intentId, tries + 1);
    await deps.resume(entry);
    return "resumed";
  }
  return "idle";
}
