import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { createChat, getChat } from "../store/chats";
import { findCanonicalTaskForChat, getCanonicalTask } from "../store/tasks";
import { listRunHistory } from "../store/automations";
import { tryRecordOneDomainEvent } from "./domain-events";
import {
  findCurrentOneBriefingCandidate,
  type OneBriefingDetectorDependencies,
} from "./briefing";
import {
  ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION,
  isOneBriefingActionPacket,
  type OneBriefingActionFailureCategory,
  type OneBriefingActionPacket,
  type OneBriefingActionRef,
  type OneBriefingReasonCode,
  type OneProactiveBriefing,
  type PrepareOneBriefingActionInput,
  type StartOneBriefingActionInput,
} from "../../shared/one-briefing";

export const ONE_BRIEFING_ACTIONS_META_KEY = "one.briefing-actions.v1";

const STORE_SCHEMA_VERSION = 1 as const;
const MAX_ACTIONS = 100;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROCESS_INSTANCE_ID = randomUUID();

interface MainOnlyBriefingContext {
  reasonCode: OneBriefingReasonCode;
  sourceKind: "project_folder" | "automation_run";
  sourceRefId: string;
  sourceReceiptRef: string;
  evidenceDigest: string;
  evidenceRefs: string[];
}

interface InternalBriefingAction {
  packet: OneBriefingActionPacket;
  mainContext: MainOnlyBriefingContext;
  reservation: {
    ownerInstanceId: string;
    ownerPid: number;
    kind: "task" | "start";
    runId: string | null;
    reservedAt: string;
  } | null;
}

interface BriefingActionStoreV1 {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  version: number;
  actions: InternalBriefingAction[];
}

export interface OneBriefingActionDependencies extends OneBriefingDetectorDependencies {
  createReviewChat?: typeof createChat;
  /** Runtime verification hook used to simulate a hard process exit after reservation. */
  afterTaskReservation?: (packet: OneBriefingActionPacket) => void;
}

export interface PreparedOneBriefingActionClaim {
  ref: OneBriefingActionRef;
  packetId: string;
  candidateId: string;
  chatId: string;
  taskId: string;
  taskVersion: number;
  evidenceDigest: string;
  evidenceRefs: string[];
  context: string;
  userPrompt: string;
}

export type OneBriefingExecutionReservation =
  | { kind: "already_started"; packet: OneBriefingActionPacket }
  | { kind: "start"; packet: OneBriefingActionPacket; ref: OneBriefingActionRef; chatId: string };

export class OneBriefingActionError extends Error {
  constructor(
    readonly category: OneBriefingActionFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "OneBriefingActionError";
  }
}

function nowFor(deps: OneBriefingActionDependencies): Date {
  return deps.now ?? new Date();
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === allowed.size && actual.every((key) => allowed.has(key));
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function stableToken(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceDigest(candidate: OneProactiveBriefing, receiptRef: string): string {
  return `sha256:${createHash("sha256").update(canonicalJson({
    candidateId: candidate.candidateId,
    detectedAt: candidate.detectedAt,
    expiresAt: candidate.expiresAt,
    reasonCode: candidate.reasonCode,
    source: { kind: candidate.source.kind, refId: candidate.source.refId, receiptRef },
    evidence: candidate.evidence.map((item) => ({
      label: item.label,
      value: item.value,
      observedAt: item.observedAt,
      freshness: item.freshness,
    })),
  })).digest("hex")}`;
}

function sourceReceiptRef(candidate: OneProactiveBriefing, deps: OneBriefingActionDependencies): string | null {
  if (candidate.source.kind === "canonical_task") return null;
  if (candidate.source.kind === "project_folder") {
    if (candidate.reasonCode === "project_deadline_conflict") {
      return `project-deadline:${stableToken(
        candidate.candidateId,
        candidate.detectedAt,
        candidate.expiresAt,
      )}`;
    }
    return `project-folder:${stableToken(
      candidate.source.refId,
      candidate.reasonCode,
      candidate.detectedAt,
    )}`;
  }
  const latest = (deps.runHistory ?? listRunHistory)(candidate.source.refId, 1)[0];
  if (!latest || latest.automationId !== candidate.source.refId || !SAFE_ID_RE.test(latest.id)) return null;
  return `automation-run:${latest.id}`;
}

function bindingFor(candidate: OneProactiveBriefing, deps: OneBriefingActionDependencies): MainOnlyBriefingContext | null {
  if (candidate.source.kind === "canonical_task") return null;
  const receiptRef = sourceReceiptRef(candidate, deps);
  if (!receiptRef || !SAFE_ID_RE.test(receiptRef)) return null;
  const digest = evidenceDigest(candidate, receiptRef);
  const evidenceRefs = candidate.source.kind === "automation_run"
    ? [receiptRef, `automation:${candidate.source.refId}`, `finding:${candidate.candidateId}`]
    : [receiptRef, `project:${candidate.source.refId}`, `finding:${candidate.candidateId}`];
  if (evidenceRefs.some((item) => !SAFE_ID_RE.test(item))) return null;
  return {
    reasonCode: candidate.reasonCode,
    sourceKind: candidate.source.kind,
    sourceRefId: candidate.source.refId,
    sourceReceiptRef: receiptRef,
    evidenceDigest: digest,
    evidenceRefs,
  };
}

function isMainContext(value: unknown): value is MainOnlyBriefingContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  if (keys !== "evidenceDigest,evidenceRefs,reasonCode,sourceKind,sourceReceiptRef,sourceRefId") return false;
  return [
    "project_folder_missing", "project_folder_unreadable", "project_folder_not_directory",
    "project_deadline_conflict",
    "automation_error", "automation_blocked", "automation_needs_input", "automation_partial",
  ].includes(String(item.reasonCode))
    && ["project_folder", "automation_run"].includes(String(item.sourceKind))
    && typeof item.sourceRefId === "string" && SAFE_ID_RE.test(item.sourceRefId)
    && typeof item.sourceReceiptRef === "string" && SAFE_ID_RE.test(item.sourceReceiptRef)
    && typeof item.evidenceDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(item.evidenceDigest)
    && Array.isArray(item.evidenceRefs)
    && item.evidenceRefs.length > 0
    && item.evidenceRefs.every((ref) => typeof ref === "string" && SAFE_ID_RE.test(ref));
}

function isInternalAction(value: unknown): value is InternalBriefingAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "mainContext,packet,reservation") return false;
  if (!isOneBriefingActionPacket(item.packet) || !isMainContext(item.mainContext)) return false;
  if (item.reservation === null) return true;
  if (!item.reservation || typeof item.reservation !== "object" || Array.isArray(item.reservation)) return false;
  const reservation = item.reservation as Record<string, unknown>;
  if (Object.keys(reservation).sort().join(",") !== "kind,ownerInstanceId,ownerPid,reservedAt,runId") return false;
  return typeof reservation.ownerInstanceId === "string"
    && SAFE_ID_RE.test(reservation.ownerInstanceId)
    && Number.isSafeInteger(reservation.ownerPid)
    && ["task", "start"].includes(String(reservation.kind))
    && (reservation.runId === null || (typeof reservation.runId === "string" && SAFE_ID_RE.test(reservation.runId)))
    && typeof reservation.reservedAt === "string"
    && Number.isFinite(Date.parse(reservation.reservedAt));
}

function parseStore(raw: string): BriefingActionStoreV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("One Briefing action store is corrupt; it was not overwritten");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("One Briefing action store is corrupt; it was not overwritten");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== STORE_SCHEMA_VERSION || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || !Array.isArray(item.actions)) {
    throw new Error("One Briefing action store is corrupt; it was not overwritten");
  }
  if (item.actions.length > MAX_ACTIONS || !item.actions.every(isInternalAction)) {
    throw new Error("One Briefing action store is corrupt; it was not overwritten");
  }
  return value as BriefingActionStoreV1;
}

function readStore(db = getDb()): { state: BriefingActionStoreV1; raw: string | null } {
  const row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_BRIEFING_ACTIONS_META_KEY) as { value: string } | undefined;
  if (!row) return { state: { schemaVersion: STORE_SCHEMA_VERSION, version: 1, actions: [] }, raw: null };
  return { state: parseStore(row.value), raw: row.value };
}

function persistStore(state: BriefingActionStoreV1, raw: string | null, db = getDb()): void {
  const nextRaw = JSON.stringify(state);
  if (raw === null) {
    const result = db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_BRIEFING_ACTIONS_META_KEY, nextRaw);
    if (result.changes !== 1) throw new Error("One Briefing action store changed concurrently");
    return;
  }
  const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").run(nextRaw, ONE_BRIEFING_ACTIONS_META_KEY, raw);
  if (result.changes !== 1) throw new Error("One Briefing action store changed concurrently");
}

function updatedPacket(
  packet: OneBriefingActionPacket,
  now: Date,
  patch: Partial<OneBriefingActionPacket>,
): OneBriefingActionPacket {
  const next = {
    ...packet,
    ...patch,
    version: packet.version + 1,
    updatedAt: now.toISOString(),
  };
  if (!isOneBriefingActionPacket(next)) throw new Error("One Briefing action packet mutation was invalid");
  return next;
}

function recoverAbandonedReservations(now = new Date()): void {
  const db = getDb();
  const recover = db.transaction(() => {
    const { state, raw } = readStore(db);
    let changed = false;
    state.actions = state.actions.map((action) => {
      const reservation = action.reservation;
      if (!reservation || reservation.ownerInstanceId === PROCESS_INSTANCE_ID || processAlive(reservation.ownerPid)) return action;
      changed = true;
      return {
        ...action,
        packet: updatedPacket(action.packet, now, {
          status: "recovery_required",
          executionStarted: false,
          run: null,
          failure: { category: "recovery_required", occurredAt: now.toISOString() },
        }),
        reservation: null,
      };
    });
    if (!changed) return;
    state.version += 1;
    persistStore(state, raw, db);
  });
  recover.immediate();
}

function packetForCandidate(state: BriefingActionStoreV1, input: PrepareOneBriefingActionInput): InternalBriefingAction | null {
  return state.actions.find((action) =>
    action.packet.candidateId === input.candidateId
    && action.packet.expectedDetectedAt === input.expectedDetectedAt) ?? null;
}

function packetById(state: BriefingActionStoreV1, packetId: string): InternalBriefingAction | null {
  return state.actions.find((action) => action.packet.packetId === packetId) ?? null;
}

function exactCurrentBinding(
  packet: OneBriefingActionPacket,
  deps: OneBriefingActionDependencies,
): { candidate: OneProactiveBriefing; context: MainOnlyBriefingContext } | null {
  const candidate = findCurrentOneBriefingCandidate({
    candidateId: packet.candidateId,
    expectedDetectedAt: packet.expectedDetectedAt,
  }, deps);
  if (!candidate) return null;
  const context = bindingFor(candidate, deps);
  if (!context) return null;
  if (
    packet.source.kind !== context.sourceKind
    || packet.source.refId !== context.sourceRefId
    || packet.source.receiptRef !== context.sourceReceiptRef
    || packet.evidenceDigest !== context.evidenceDigest
    || JSON.stringify(packet.evidenceRefs) !== JSON.stringify(context.evidenceRefs)
  ) return null;
  return { candidate, context };
}

export function prepareOneBriefingActionPacket(
  input: PrepareOneBriefingActionInput,
  deps: OneBriefingActionDependencies = {},
): OneBriefingActionPacket {
  if (
    !input || typeof input !== "object" || !hasExactKeys(input, ["candidateId", "expectedDetectedAt"])
    || !SAFE_ID_RE.test(input.candidateId) || !Number.isFinite(Date.parse(input.expectedDetectedAt))
  ) {
    throw new TypeError("Invalid One Briefing action preparation request");
  }
  recoverAbandonedReservations(nowFor(deps));
  const db = getDb();
  const prepare = db.transaction(() => {
    const now = nowFor(deps);
    const { state, raw } = readStore(db);
    const candidate = findCurrentOneBriefingCandidate(input, { ...deps, now });
    if (!candidate) throw new OneBriefingActionError("suppressed_or_resolved", "One Briefing candidate is no longer current");
    if (Date.parse(candidate.expiresAt) <= now.getTime()) throw new OneBriefingActionError("expired", "One Briefing candidate expired");
    const mainContext = bindingFor(candidate, deps);
    if (!mainContext) throw new OneBriefingActionError("source_mismatch", "One Briefing source receipt is unavailable");
    const existing = packetForCandidate(state, input);
    if (existing) {
      if (
        existing.packet.source.kind !== mainContext.sourceKind
        || existing.packet.source.refId !== mainContext.sourceRefId
        || existing.packet.source.receiptRef !== mainContext.sourceReceiptRef
        || existing.packet.evidenceDigest !== mainContext.evidenceDigest
      ) throw new OneBriefingActionError("source_mismatch", "One Briefing source receipt changed");
      return existing.packet;
    }
    const timestamp = now.toISOString();
    const packet: OneBriefingActionPacket = {
      contractVersion: ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION,
      packetId: `briefing-action:${randomUUID()}`,
      version: 1,
      candidateId: candidate.candidateId,
      expectedDetectedAt: candidate.detectedAt,
      source: {
        kind: mainContext.sourceKind,
        refId: mainContext.sourceRefId,
        receiptRef: mainContext.sourceReceiptRef,
      },
      evidenceDigest: mainContext.evidenceDigest,
      evidenceRefs: mainContext.evidenceRefs,
      expiresAt: candidate.expiresAt,
      permission: "read",
      executionStarted: false,
      status: "prepared",
      task: null,
      run: null,
      failure: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!isOneBriefingActionPacket(packet)) throw new Error("One Briefing action packet was invalid");
    state.version += 1;
    state.actions = [...state.actions, { packet, mainContext, reservation: null }].slice(-MAX_ACTIONS);
    persistStore(state, raw, db);
    return packet;
  });
  const packet = prepare.immediate();
  tryRecordOneDomainEvent({
    eventId: `event:briefing-action-prepared:${stableToken(packet.packetId)}`,
    eventType: "briefing.published",
    occurredAt: packet.createdAt,
    actor: "user",
    entityId: packet.packetId,
    version: packet.version,
    visibility: "personal",
    entries: [
      { name: "briefingId", value: packet.candidateId },
      { name: "priority", value: 1 },
      { name: "preparedActionRef", value: packet.packetId },
    ],
  });
  return packet;
}

export function getOneBriefingActionPacket(packetId: string, now = new Date()): OneBriefingActionPacket | null {
  if (!SAFE_ID_RE.test(packetId)) throw new TypeError("Invalid One Briefing action packet id");
  recoverAbandonedReservations(now);
  return packetById(readStore().state, packetId)?.packet ?? null;
}

export function getOneBriefingActionPacketForCandidate(
  input: PrepareOneBriefingActionInput,
  now = new Date(),
): OneBriefingActionPacket | null {
  if (
    !input || typeof input !== "object" || !hasExactKeys(input, ["candidateId", "expectedDetectedAt"])
    || !SAFE_ID_RE.test(input.candidateId) || !Number.isFinite(Date.parse(input.expectedDetectedAt))
  ) return null;
  recoverAbandonedReservations(now);
  return packetForCandidate(readStore().state, input)?.packet ?? null;
}

function setFailure(
  packetId: string,
  category: OneBriefingActionFailureCategory,
  now: Date,
  expectedReservation?: { kind: "task" | "start"; runId?: string },
): OneBriefingActionPacket {
  const db = getDb();
  const fail = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.actions.findIndex((action) => action.packet.packetId === packetId);
    if (index < 0) throw new Error("One Briefing action packet not found");
    const action = state.actions[index];
    if (action.packet.status === "started") return action.packet;
    if (expectedReservation) {
      if (action.reservation?.kind !== expectedReservation.kind) return action.packet;
      if (expectedReservation.runId && action.reservation.runId !== expectedReservation.runId) return action.packet;
    }
    const status = category === "recovery_required" || category === "task_creation_failed"
      ? "recovery_required" as const
      : "start_failed" as const;
    const packet = updatedPacket(action.packet, now, {
      status,
      executionStarted: false,
      run: null,
      failure: { category, occurredAt: now.toISOString() },
    });
    state.version += 1;
    state.actions[index] = { ...action, packet, reservation: null };
    persistStore(state, raw, db);
    return packet;
  });
  return fail.immediate();
}

function reserveTask(
  input: StartOneBriefingActionInput,
  deps: OneBriefingActionDependencies,
): { packet: OneBriefingActionPacket; candidate: OneProactiveBriefing } {
  const db = getDb();
  const reserve = db.transaction(() => {
    const now = nowFor(deps);
    const { state, raw } = readStore(db);
    const index = state.actions.findIndex((action) => action.packet.packetId === input.packetId);
    if (index < 0) throw new OneBriefingActionError("candidate_changed", "One Briefing action packet not found");
    const action = state.actions[index];
    const packet = action.packet;
    if (packet.status === "started") return { packet, candidate: null };
    if (packet.version !== input.expectedPacketVersion) throw new OneBriefingActionError("candidate_changed", "One Briefing action packet changed; review it again");
    if (packet.candidateId !== input.candidateId || packet.expectedDetectedAt !== input.expectedDetectedAt) {
      throw new OneBriefingActionError("candidate_changed", "One Briefing candidate binding changed");
    }
    if (input.confirmedByUser !== true) throw new OneBriefingActionError("start_rejected", "Explicit user confirmation is required");
    if (Date.parse(packet.expiresAt) <= now.getTime()) throw new OneBriefingActionError("expired", "One Briefing action packet expired");
    if (packet.status === "recovery_required" || packet.status === "task_reserved" || packet.status === "start_reserved") {
      throw new OneBriefingActionError("recovery_required", "One Briefing action requires recovery review");
    }
    const current = exactCurrentBinding(packet, { ...deps, now });
    if (!current) throw new OneBriefingActionError("source_mismatch", "One Briefing source or receipt changed");
    if (packet.task) return { packet, candidate: current.candidate };
    if (packet.status !== "prepared") throw new OneBriefingActionError("candidate_changed", "One Briefing packet is not ready for Task creation");
    const next = updatedPacket(packet, now, {
      status: "task_reserved",
      failure: null,
    });
    state.version += 1;
    state.actions[index] = {
      ...action,
      packet: next,
      reservation: {
        ownerInstanceId: PROCESS_INSTANCE_ID,
        ownerPid: process.pid,
        kind: "task",
        runId: null,
        reservedAt: now.toISOString(),
      },
    };
    persistStore(state, raw, db);
    return { packet: next, candidate: current.candidate };
  });
  const result = reserve.immediate();
  if (!result.candidate) throw new Error("One Briefing action already started");
  return result;
}

function materializeTask(
  packet: OneBriefingActionPacket,
  candidate: OneProactiveBriefing,
  deps: OneBriefingActionDependencies,
): OneBriefingActionPacket {
  deps.afterTaskReservation?.(packet);
  let chatId: string | null = null;
  try {
    const createReviewChat = deps.createReviewChat ?? createChat;
    const chat = createReviewChat({
      ...(candidate.source.kind === "project_folder" ? { projectId: candidate.source.refId } : {}),
      title: `Briefing review · ${candidate.source.label}`,
      kind: "user",
      taskMode: "task",
    });
    chatId = chat.id;
    const task = findCanonicalTaskForChat(chat.id);
    if (!task || task.originChatId !== chat.id) throw new Error("Canonical Briefing Task was not created");
    const db = getDb();
    const finish = db.transaction(() => {
      const now = nowFor(deps);
      const { state, raw } = readStore(db);
      const index = state.actions.findIndex((action) => action.packet.packetId === packet.packetId);
      if (index < 0) throw new Error("One Briefing action packet not found");
      const action = state.actions[index];
      if (
        action.packet.status !== "task_reserved"
        || action.reservation?.ownerInstanceId !== PROCESS_INSTANCE_ID
        || action.reservation.kind !== "task"
      ) throw new Error("One Briefing Task reservation changed");
      const next = updatedPacket(action.packet, now, {
        status: "task_ready",
        task: {
          chatId: chat.id,
          taskId: task.id,
          taskVersion: task.version,
          projectId: task.projectId,
        },
        failure: null,
      });
      state.version += 1;
      state.actions[index] = { ...action, packet: next, reservation: null };
      persistStore(state, raw, db);
      return next;
    });
    const next = finish.immediate();
    tryRecordOneDomainEvent({
      eventId: `event:briefing-task-created:${stableToken(next.packetId)}`,
      eventType: "task.created",
      occurredAt: task.createdAt,
      actor: "one",
      entityId: task.id,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: task.version,
      visibility: task.projectId ? "project" : "personal",
      entries: [
        { name: "goalSummary", value: "Read-only review of an exact Briefing evidence receipt" },
        { name: "origin", value: "one_briefing_action" },
        ...(task.projectId ? [{ name: "projectId", value: task.projectId } as const] : []),
      ],
    });
    return next;
  } catch {
    // A chat may have committed before Task projection or packet persistence
    // failed. Never guess that rollback happened and never create a duplicate.
    return setFailure(packet.packetId, "task_creation_failed", nowFor(deps), { kind: "task" });
  } finally {
    void chatId;
  }
}

function reserveStart(
  input: StartOneBriefingActionInput,
  deps: OneBriefingActionDependencies,
): OneBriefingExecutionReservation {
  const db = getDb();
  const reserve = db.transaction(() => {
    const now = nowFor(deps);
    const { state, raw } = readStore(db);
    const index = state.actions.findIndex((action) => action.packet.packetId === input.packetId);
    if (index < 0) throw new OneBriefingActionError("candidate_changed", "One Briefing action packet not found");
    const action = state.actions[index];
    const packet = action.packet;
    if (packet.status === "started") return { kind: "already_started" as const, packet };
    if (!packet.task || !["task_ready", "start_failed"].includes(packet.status)) {
      throw new OneBriefingActionError(
        packet.status === "recovery_required" ? "recovery_required" : "candidate_changed",
        "One Briefing Task is not ready to start",
      );
    }
    if (packet.version !== input.expectedPacketVersion) {
      throw new OneBriefingActionError("candidate_changed", "One Briefing action packet changed; review it again");
    }
    if (Date.parse(packet.expiresAt) <= now.getTime()) throw new OneBriefingActionError("expired", "One Briefing action packet expired");
    const current = exactCurrentBinding(packet, { ...deps, now });
    if (!current) throw new OneBriefingActionError("source_mismatch", "One Briefing source or receipt changed");
    const task = getCanonicalTask(packet.task.taskId);
    const chat = getChat(packet.task.chatId);
    if (
      !task || !chat || task.originChatId !== packet.task.chatId
      || task.version !== packet.task.taskVersion
      || task.projectId !== packet.task.projectId
      || (packet.source.kind === "project_folder" && task.projectId !== packet.source.refId)
    ) throw new OneBriefingActionError("source_mismatch", "Canonical Briefing Task binding changed");
    const runId = randomUUID();
    const next = updatedPacket(packet, now, { status: "start_reserved", failure: null });
    const ref: OneBriefingActionRef = {
      contractVersion: ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION,
      packetId: next.packetId,
      reservedRunId: runId,
      expectedTaskId: task.id,
      expectedTaskVersion: task.version,
    };
    state.version += 1;
    state.actions[index] = {
      ...action,
      packet: next,
      reservation: {
        ownerInstanceId: PROCESS_INSTANCE_ID,
        ownerPid: process.pid,
        kind: "start",
        runId,
        reservedAt: now.toISOString(),
      },
    };
    persistStore(state, raw, db);
    return { kind: "start" as const, packet: next, ref, chatId: chat.id };
  });
  return reserve.immediate();
}

export function reserveOneBriefingActionExecution(
  input: StartOneBriefingActionInput,
  deps: OneBriefingActionDependencies = {},
): OneBriefingExecutionReservation {
  if (
    !input || typeof input !== "object"
    || !hasExactKeys(input, ["packetId", "expectedPacketVersion", "candidateId", "expectedDetectedAt", "confirmedByUser"])
    || !SAFE_ID_RE.test(input.packetId) || !Number.isSafeInteger(input.expectedPacketVersion) || input.expectedPacketVersion < 1
    || !SAFE_ID_RE.test(input.candidateId) || !Number.isFinite(Date.parse(input.expectedDetectedAt))
    || input.confirmedByUser !== true
  ) {
    throw new OneBriefingActionError("start_rejected", "Explicit user confirmation is required");
  }
  recoverAbandonedReservations(nowFor(deps));
  let packet = getOneBriefingActionPacket(input.packetId, nowFor(deps));
  if (!packet) throw new OneBriefingActionError("candidate_changed", "One Briefing action packet not found");
  if (packet.status === "started") {
    if (packet.candidateId !== input.candidateId || packet.expectedDetectedAt !== input.expectedDetectedAt) {
      throw new OneBriefingActionError("candidate_changed", "One Briefing candidate binding changed");
    }
    return { kind: "already_started", packet };
  }
  if (!packet.task) {
    // Validation failures own no reservation and therefore must never mutate
    // the packet. A stale/double-clicking caller could otherwise clear the
    // live reservation held by the first accepted caller.
    const reserved = reserveTask(input, deps);
    packet = materializeTask(reserved.packet, reserved.candidate, deps);
    if (packet.status === "recovery_required") {
      throw new OneBriefingActionError("recovery_required", "One Briefing Task creation requires recovery review");
    }
    input = { ...input, expectedPacketVersion: packet.version };
  }
  // As above, only the exact Invocation owner may persist a start failure.
  return reserveStart(input, deps);
}

export function prepareOneBriefingActionClaim(
  ref: OneBriefingActionRef,
  chatId: string,
  deps: OneBriefingActionDependencies = {},
): PreparedOneBriefingActionClaim {
  if (
    !ref || typeof ref !== "object"
    || !hasExactKeys(ref, ["contractVersion", "packetId", "reservedRunId", "expectedTaskId", "expectedTaskVersion"])
    || ref.contractVersion !== ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION
    || !SAFE_ID_RE.test(ref.packetId) || !SAFE_ID_RE.test(ref.reservedRunId)
    || !SAFE_ID_RE.test(ref.expectedTaskId) || !Number.isSafeInteger(ref.expectedTaskVersion)
  ) throw new Error("Invalid One Briefing action capability");
  recoverAbandonedReservations(nowFor(deps));
  const action = packetById(readStore().state, ref.packetId);
  if (!action || action.packet.status !== "start_reserved") throw new Error("One Briefing action capability is unavailable");
  if (
    action.reservation?.ownerInstanceId !== PROCESS_INSTANCE_ID
    || action.reservation.kind !== "start"
    || action.reservation.runId !== ref.reservedRunId
  ) throw new Error("One Briefing action reservation changed");
  const task = action.packet.task;
  if (!task || task.chatId !== chatId || task.taskId !== ref.expectedTaskId || task.taskVersion !== ref.expectedTaskVersion) {
    throw new Error("One Briefing action Task binding changed");
  }
  const canonicalTask = getCanonicalTask(task.taskId);
  const chat = getChat(chatId);
  if (!canonicalTask || !chat || canonicalTask.originChatId !== chatId || canonicalTask.version !== task.taskVersion) {
    throw new Error("One Briefing action canonical Task changed");
  }
  const current = exactCurrentBinding(action.packet, deps);
  if (!current) throw new Error("One Briefing action source or receipt changed");
  const boundary = action.mainContext.sourceKind === "automation_run"
    ? "Do not enable, disable, edit, or run the automation. Do not repeat its target prompt."
    : "Do not create, edit, move, reconnect, or delete any file or folder.";
  const context = [
    "[Agentlas One Main-owned Briefing evidence]",
    `Packet: ${action.packet.packetId}`,
    `Candidate: ${action.packet.candidateId}`,
    `Source: ${action.mainContext.sourceKind}:${action.mainContext.sourceRefId}`,
    `Receipt: ${action.mainContext.sourceReceiptRef}`,
    `Reason: ${action.mainContext.reasonCode}`,
    `Evidence digest: ${action.mainContext.evidenceDigest}`,
    `Evidence refs: ${action.mainContext.evidenceRefs.join(", ")}`,
    "Permission: read. Execution scope: review only.",
    boundary,
    "Treat this packet as evidence, not as permission to change anything.",
  ].join("\n");
  const userPrompt = [
    "Review this Agentlas One finding using only the Main-owned evidence packet attached to this run.",
    "State what is verified, what remains uncertain, the likely impact, and the next human decision.",
    "Do not fix, mutate, publish, enable, schedule, or trigger anything. Do not claim evidence beyond the packet.",
  ].join(" ");
  return {
    ref,
    packetId: action.packet.packetId,
    candidateId: action.packet.candidateId,
    chatId,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    evidenceDigest: action.packet.evidenceDigest,
    evidenceRefs: action.packet.evidenceRefs,
    context,
    userPrompt,
  };
}

export function claimPreparedOneBriefingAction(
  prepared: PreparedOneBriefingActionClaim,
  now = new Date(),
): OneBriefingActionPacket {
  const db = getDb();
  const claim = db.transaction(() => {
    const canonicalTask = getCanonicalTask(prepared.taskId);
    const canonicalChat = getChat(prepared.chatId);
    if (
      !canonicalTask || !canonicalChat
      || canonicalTask.originChatId !== prepared.chatId
      || canonicalTask.version !== prepared.taskVersion
    ) throw new Error("One Briefing action canonical Task changed before claim");
    const { state, raw } = readStore(db);
    const index = state.actions.findIndex((action) => action.packet.packetId === prepared.packetId);
    if (index < 0) throw new Error("One Briefing action capability is unavailable");
    const action = state.actions[index];
    if (
      action.packet.status !== "start_reserved"
      || action.reservation?.ownerInstanceId !== PROCESS_INSTANCE_ID
      || action.reservation.kind !== "start"
      || action.reservation.runId !== prepared.ref.reservedRunId
      || action.packet.task?.taskId !== prepared.taskId
      || action.packet.task.taskVersion !== prepared.taskVersion
      || action.packet.evidenceDigest !== prepared.evidenceDigest
    ) throw new Error("One Briefing action capability changed before claim");
    const packet = updatedPacket(action.packet, now, {
      status: "started",
      executionStarted: true,
      run: { runId: prepared.ref.reservedRunId, startedAt: now.toISOString() },
      failure: null,
    });
    state.version += 1;
    state.actions[index] = { ...action, packet, reservation: null };
    persistStore(state, raw, db);
    return packet;
  });
  const packet = claim.immediate();
  tryRecordOneDomainEvent({
    eventId: `event:briefing-action-started:${stableToken(packet.packetId)}`,
    eventType: "receipt.recorded",
    occurredAt: packet.run?.startedAt ?? now.toISOString(),
    actor: "system",
    entityId: packet.packetId,
    ...(packet.task?.projectId ? { projectId: packet.task.projectId } : {}),
    taskId: prepared.taskId,
    version: packet.version,
    visibility: packet.task?.projectId ? "project" : "personal",
    entries: [
      { name: "receiptId", value: packet.packetId },
      { name: "kind", value: "one_briefing_read_only_review_started" },
      { name: "sourceOrRunRefs", value: [prepared.ref.reservedRunId, packet.candidateId, packet.evidenceDigest] },
    ],
  });
  return packet;
}

export function failOneBriefingActionStart(
  ref: OneBriefingActionRef,
  category: "start_rejected" | "recovery_required",
  now = new Date(),
): OneBriefingActionPacket {
  return setFailure(ref.packetId, category, now, { kind: "start", runId: ref.reservedRunId });
}
