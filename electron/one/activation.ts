import {
  ONE_ACTIVATION_CONTRACT_VERSION,
  isOneActivationMobileResolution,
  isOneActivationState,
  type GetOneActivationStateInput,
  type OneActivationState,
  type ResolveOneActivationConcernInput,
  type ResolveOneActivationMobileInput,
  type ResolveOneActivationWorkInput,
  type SkipOneActivationInput,
} from "../../shared/one-activation";
import type { OneValueClosureRecord } from "../../shared/one-value-closure";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getOneProfile } from "../store/one-profile";
import { ONE_DOMAIN_EVENT_KIND } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";
import { tryRecordOneDomainEvent } from "./domain-events";
import { getOneValueClosureState, ONE_VALUE_CLOSURE_META_KEY } from "./value-closure";

export const ONE_ACTIVATION_META_KEY = "agentlas.one.activation.v1";

export interface CompleteOneActivationFirstValueInput {
  taskId: string;
  expectedTaskVersion: number;
  valueClosureId: string;
  expectedValueClosureVersion: number;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function assertPositiveVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new TypeError(`${label} must be an opaque safe id`);
  }
}

function assertGetInput(input: GetOneActivationStateInput): void {
  if (!isRecord(input)) throw new TypeError("Invalid One activation route request");
  assertOnlyKeys(input, ["platform", "locale"], "One activation route request");
  if (input.platform !== "desktop") throw new TypeError("One activation supports the Desktop-first route only");
  if (input.locale !== "ko" && input.locale !== "en") throw new TypeError("Invalid One activation locale");
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function tableExists(name: string): boolean {
  return Boolean(getDb().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

/**
 * Fail conservative: uncertain or corrupt evidence is pre-existing activity,
 * never permission to label the account as a first-use route.
 */
function hasPreexistingActivity(): boolean {
  const db = getDb();
  if (tableExists("tasks") && db.prepare(
    `SELECT 1 FROM tasks
     LEFT JOIN chats ON chats.id = tasks.origin_chat_id
     WHERE tasks.id NOT LIKE 'task_pairing_%'
       AND (
         tasks.origin_chat_id IS NULL
         OR tasks.status <> 'open'
         OR chats.used_at IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM chat_messages WHERE chat_messages.chat_id = tasks.origin_chat_id
         )
       )
     LIMIT 1`,
  ).get()) return true;
  if (tableExists("chats") && db.prepare(
    `SELECT 1 FROM chats
     WHERE kind = 'user'
       AND (used_at IS NOT NULL OR EXISTS (
         SELECT 1 FROM chat_messages WHERE chat_messages.chat_id = chats.id
       ))
     LIMIT 1`,
  ).get()) return true;
  if (tableExists("run_events") && db.prepare(
    `SELECT 1 FROM run_events
     WHERE kind = ?
       AND COALESCE(
         json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.eventType'),
         ''
       ) <> 'feature_intro.deferred'
     LIMIT 1`,
  ).get(ONE_DOMAIN_EVENT_KIND)) return true;

  const closureRow = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(ONE_VALUE_CLOSURE_META_KEY) as { value: string } | undefined;
  if (closureRow) {
    try {
      const parsed = JSON.parse(closureRow.value) as { closures?: unknown; evidence?: unknown };
      if (!Array.isArray(parsed.closures) || !Array.isArray(parsed.evidence)) return true;
      if (parsed.closures.length > 0 || parsed.evidence.length > 0) return true;
    } catch {
      return true;
    }
  }

  const introRow = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get("agentlas.one.feature-intro.v1") as { value: string } | undefined;
  if (introRow) {
    try {
      const parsed = JSON.parse(introRow.value) as { acknowledgedIntroVersion?: unknown };
      if (Number(parsed.acknowledgedIntroVersion) > 0) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function initialState(
  oneId: string,
  input: GetOneActivationStateInput,
  preexisting: boolean,
): OneActivationState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_ACTIVATION_CONTRACT_VERSION,
    oneId,
    version,
    eligibility: preexisting ? "ineligible_preexisting_activity" : "eligible_first_use",
    status: preexisting ? "ineligible" : "active",
    route: preexisting ? null : {
      route: "desktop_first",
      platform: "desktop",
      locale: input.locale,
      selectedAt: now,
    },
    concern: { status: "pending", originChatId: null, resolvedAt: null },
    workNavigation: { status: "pending", resolvedAt: null },
    firstValue: {
      status: "pending",
      taskId: null,
      taskVersion: null,
      valueClosureId: null,
      valueClosureVersion: null,
      resolvedAt: null,
    },
    mobileConnection: { status: "locked", resolution: null, resolvedAt: null },
    completionReason: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function parseState(raw: string): OneActivationState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One activation state is corrupt; it was not overwritten");
  }
  if (!isOneActivationState(parsed)) {
    throw new Error("Stored One activation state violates its closed contract; it was not overwritten");
  }
  return parsed;
}

function assertOneBinding(state: OneActivationState): void {
  if (state.oneId !== getOneProfile().oneId) {
    throw new Error("Stored One activation state belongs to a different One identity; it was not overwritten");
  }
}

function readExistingState(): { raw: string; state: OneActivationState } | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(ONE_ACTIVATION_META_KEY) as { value: string } | undefined;
  if (!row) return null;
  const state = parseState(row.value);
  assertOneBinding(state);
  return { raw: row.value, state };
}

function readOrCreateState(input: GetOneActivationStateInput): { raw: string; state: OneActivationState } {
  assertGetInput(input);
  const profile = getOneProfile();
  const db = getDb();
  const initialize = db.transaction(() => {
    const existing = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get(ONE_ACTIVATION_META_KEY) as { value: string } | undefined;
    if (existing) return existing.value;
    const candidate = initialState(profile.oneId, input, hasPreexistingActivity());
    if (!isOneActivationState(candidate)) throw new Error("Could not initialize a valid One activation state");
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(ONE_ACTIVATION_META_KEY, JSON.stringify(candidate));
    const inserted = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get(ONE_ACTIVATION_META_KEY) as { value: string } | undefined;
    if (!inserted) throw new Error("Could not initialize One activation state");
    return inserted.value;
  });
  const raw = initialize.immediate();
  const state = parseState(raw);
  assertOneBinding(state);
  return { raw, state };
}

function assertExpectedVersion(state: OneActivationState, expectedStoreVersion: number): void {
  assertPositiveVersion(expectedStoreVersion, "expectedStoreVersion");
  if (state.version !== expectedStoreVersion) {
    throw new Error(`One activation state changed (expected ${expectedStoreVersion}, current ${state.version})`);
  }
}

function persist(currentRaw: string, next: OneActivationState): OneActivationState {
  if (!isOneActivationState(next)) throw new Error("Refused to persist invalid One activation state");
  const result = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
    .run(JSON.stringify(next), ONE_ACTIVATION_META_KEY, currentRaw);
  if (result.changes !== 1) {
    throw new Error("One activation state changed concurrently; refresh and retry");
  }
  return next;
}

function activationEntityId(oneId: string): string {
  return `activation:${oneId}`;
}

function eventId(oneId: string, step: "route" | "concern" | "work" | "first_value" | "skip" | "mobile"): string {
  return `event:onboarding:${oneId.slice(4)}:${step}`;
}

/** Repairable, deterministic events make a crash between state and ledger safe. */
function ensureStateEvents(state: OneActivationState): void {
  if (!state.route) return;
  const entityId = activationEntityId(state.oneId);
  tryRecordOneDomainEvent({
    eventId: eventId(state.oneId, "route"),
    eventType: "onboarding.route_selected",
    occurredAt: state.route.selectedAt,
    actor: "system",
    entityId,
    version: Date.parse(state.route.selectedAt),
    visibility: "personal",
    entries: [
      { name: "route", value: state.route.route },
      { name: "platform", value: state.route.platform },
      { name: "locale", value: state.route.locale },
    ],
  });
  if (state.concern.status === "resolved") {
    tryRecordOneDomainEvent({
      eventId: eventId(state.oneId, "concern"),
      eventType: "onboarding.step_resolved",
      occurredAt: state.concern.resolvedAt!,
      actor: "user",
      entityId,
      version: Date.parse(state.concern.resolvedAt!),
      visibility: "personal",
      entries: [
        { name: "stepId", value: "concern" },
        { name: "resolution", value: "submitted" },
      ],
    });
  }
  if (state.workNavigation.status === "resolved") {
    tryRecordOneDomainEvent({
      eventId: eventId(state.oneId, "work"),
      eventType: "onboarding.step_resolved",
      occurredAt: state.workNavigation.resolvedAt!,
      actor: "user",
      entityId,
      version: Date.parse(state.workNavigation.resolvedAt!),
      visibility: "personal",
      entries: [
        { name: "stepId", value: "work_navigation" },
        { name: "resolution", value: "opened_work" },
      ],
    });
  }
  if (state.firstValue.status === "resolved") {
    tryRecordOneDomainEvent({
      eventId: eventId(state.oneId, "first_value"),
      eventType: "onboarding.step_resolved",
      occurredAt: state.firstValue.resolvedAt!,
      actor: "system",
      entityId,
      version: Date.parse(state.firstValue.resolvedAt!),
      visibility: "personal",
      entries: [
        { name: "stepId", value: "first_value" },
        { name: "resolution", value: "verified_value_closure" },
      ],
    });
  }
  if (state.status === "skipped") {
    tryRecordOneDomainEvent({
      eventId: eventId(state.oneId, "skip"),
      eventType: "onboarding.step_resolved",
      occurredAt: state.completedAt!,
      actor: "user",
      entityId,
      version: Date.parse(state.completedAt!),
      visibility: "personal",
      entries: [
        { name: "stepId", value: "activation" },
        { name: "resolution", value: "explicit_skip" },
      ],
    });
  }
  if (state.mobileConnection.status === "resolved") {
    tryRecordOneDomainEvent({
      eventId: eventId(state.oneId, "mobile"),
      eventType: "onboarding.step_resolved",
      occurredAt: state.mobileConnection.resolvedAt!,
      actor: "user",
      entityId,
      version: Date.parse(state.mobileConnection.resolvedAt!),
      visibility: "personal",
      entries: [
        { name: "stepId", value: "mobile_connection" },
        { name: "resolution", value: state.mobileConnection.resolution! },
      ],
    });
  }
}

function exactAcceptedClosure(input: CompleteOneActivationFirstValueInput): OneValueClosureRecord | null {
  const task = getCanonicalTask(input.taskId);
  if (
    !task
    || task.status !== "completed"
    || task.version !== input.expectedTaskVersion
    || !task.originChatId
  ) return null;
  let closureState;
  try {
    closureState = getOneValueClosureState();
  } catch {
    return null;
  }
  const record = closureState.closures.find((item) =>
    item.closure.valueClosureId === input.valueClosureId
    && item.version === input.expectedValueClosureVersion,
  );
  if (
    !record
    || record.closure.status !== "ready"
    || record.closure.taskId !== task.id
    || record.taskVersion !== task.version
  ) return null;
  const evidence = record.trustedEvidenceRefs.map((ref) =>
    closureState.evidence.find((item) => item.evidenceRef === ref),
  );
  const hasExactAcceptance = evidence.some((item) =>
    item?.kind === "result_acceptance"
    && item.source === "canonical_task_runtime"
    && item.taskId === task.id
    && item.taskVersion === task.version,
  );
  const hasExactRun = evidence.some((item) =>
    item?.kind === "execution_receipt"
    && item.source === "invocation_runtime"
    && item.taskId === task.id
    && item.taskVersion === task.version,
  );
  return hasExactAcceptance && hasExactRun ? record : null;
}

function recoverableFirstValue(state: OneActivationState): CompleteOneActivationFirstValueInput | null {
  if (state.status !== "active" || state.concern.status !== "resolved") return null;
  let closureState;
  try {
    closureState = getOneValueClosureState();
  } catch {
    return null;
  }
  const candidates = closureState.closures
    .filter((record) => {
      const task = getCanonicalTask(record.closure.taskId);
      return task?.originChatId === state.concern.originChatId
        && task.status === "completed"
        && task.version === record.taskVersion;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const record of candidates) {
    const input: CompleteOneActivationFirstValueInput = {
      taskId: record.closure.taskId,
      expectedTaskVersion: record.taskVersion,
      valueClosureId: record.closure.valueClosureId,
      expectedValueClosureVersion: record.version,
    };
    if (exactAcceptedClosure(input)) return input;
  }
  return null;
}

export function getOneActivationState(input: GetOneActivationStateInput): OneActivationState {
  let current = readOrCreateState(input).state;
  const recovery = recoverableFirstValue(current);
  if (recovery) current = tryCompleteOneActivationFirstValue(recovery) ?? current;
  ensureStateEvents(current);
  return current;
}

export function resolveOneActivationConcern(input: ResolveOneActivationConcernInput): OneActivationState {
  if (!isRecord(input)) throw new TypeError("Invalid One activation concern resolution");
  assertOnlyKeys(input, ["expectedStoreVersion", "originChatId", "confirmedByUser"], "One activation concern resolution");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  assertSafeId(input.originChatId, "originChatId");
  if (input.confirmedByUser !== true) throw new Error("One activation concern submission requires explicit user confirmation");
  const current = readExistingState();
  if (!current) throw new Error("One activation route has not been selected");
  if (current.state.status !== "active") return current.state;
  if (current.state.concern.status === "resolved") {
    if (current.state.concern.originChatId !== input.originChatId) {
      throw new Error("One activation concern is already bound to a different canonical conversation");
    }
    ensureStateEvents(current.state);
    return current.state;
  }
  assertExpectedVersion(current.state, input.expectedStoreVersion);
  const chat = getChat(input.originChatId);
  if (!chat || chat.kind !== "user") throw new Error("One activation requires an existing user conversation");
  if (!current.state.route || Date.parse(chat.createdAt) < Date.parse(current.state.route.selectedAt)) {
    throw new Error("One activation cannot bind a conversation created before this Desktop-first route");
  }
  const tick = nextTimestamp(current.state.version);
  const next = persist(current.raw, {
    ...current.state,
    version: tick.version,
    concern: { status: "resolved", originChatId: chat.id, resolvedAt: tick.iso },
    updatedAt: tick.iso,
  });
  ensureStateEvents(next);
  return next;
}

export function skipOneActivation(input: SkipOneActivationInput): OneActivationState {
  if (!isRecord(input)) throw new TypeError("Invalid One activation skip");
  assertOnlyKeys(input, ["expectedStoreVersion", "confirmedByUser"], "One activation skip");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Skipping One activation requires explicit user confirmation");
  const current = readExistingState();
  if (!current) throw new Error("One activation route has not been selected");
  if (current.state.status !== "active") {
    ensureStateEvents(current.state);
    return current.state;
  }
  assertExpectedVersion(current.state, input.expectedStoreVersion);
  const tick = nextTimestamp(current.state.version);
  const next = persist(current.raw, {
    ...current.state,
    version: tick.version,
    status: "skipped",
    completionReason: "explicit_skip",
    updatedAt: tick.iso,
    completedAt: tick.iso,
  });
  ensureStateEvents(next);
  return next;
}

export function resolveOneActivationWork(input: ResolveOneActivationWorkInput): OneActivationState {
  if (!isRecord(input)) throw new TypeError("Invalid One activation Work navigation");
  assertOnlyKeys(input, ["expectedStoreVersion", "confirmedByUser"], "One activation Work navigation");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("One activation Work navigation requires explicit user confirmation");
  const current = readExistingState();
  if (!current) throw new Error("One activation route has not been selected");
  if (current.state.eligibility !== "eligible_first_use" || current.state.status !== "active") {
    ensureStateEvents(current.state);
    return current.state;
  }
  if (current.state.workNavigation.status === "resolved") {
    ensureStateEvents(current.state);
    return current.state;
  }
  assertExpectedVersion(current.state, input.expectedStoreVersion);
  const tick = nextTimestamp(current.state.version);
  const next = persist(current.raw, {
    ...current.state,
    version: tick.version,
    workNavigation: { status: "resolved", resolvedAt: tick.iso },
    updatedAt: tick.iso,
  });
  ensureStateEvents(next);
  return next;
}

export function resolveOneActivationMobile(input: ResolveOneActivationMobileInput): OneActivationState {
  if (!isRecord(input)) throw new TypeError("Invalid One activation mobile resolution");
  assertOnlyKeys(input, ["expectedStoreVersion", "resolution", "confirmedByUser"], "One activation mobile resolution");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (!isOneActivationMobileResolution(input.resolution)) throw new TypeError("Invalid One activation mobile resolution");
  if (input.confirmedByUser !== true) throw new Error("One activation mobile resolution requires explicit user confirmation");
  const current = readExistingState();
  if (!current) throw new Error("One activation route has not been selected");
  if (current.state.mobileConnection.status === "resolved") {
    if (current.state.mobileConnection.resolution !== input.resolution) {
      throw new Error("One activation mobile offer was already resolved differently");
    }
    ensureStateEvents(current.state);
    return current.state;
  }
  if (current.state.status !== "completed" || current.state.mobileConnection.status !== "offered") {
    throw new Error("One activation mobile connection is not currently offered");
  }
  assertExpectedVersion(current.state, input.expectedStoreVersion);
  const tick = nextTimestamp(current.state.version);
  const next = persist(current.raw, {
    ...current.state,
    version: tick.version,
    mobileConnection: { status: "resolved", resolution: input.resolution, resolvedAt: tick.iso },
    updatedAt: tick.iso,
  });
  ensureStateEvents(next);
  return next;
}

/**
 * Optional, idempotent Main hook. It can only close the activation against the
 * exact accepted Task version, exact ready Value Closure, and exact concern
 * conversation. Failures never roll back the already accepted result.
 */
export function tryCompleteOneActivationFirstValue(
  input: CompleteOneActivationFirstValueInput,
): OneActivationState | null {
  if (!isRecord(input)) return null;
  if (Object.keys(input).some((key) => ![
    "taskId", "expectedTaskVersion", "valueClosureId", "expectedValueClosureVersion",
  ].includes(key))) return null;
  if (
    typeof input.taskId !== "string"
    || !SAFE_ID_RE.test(input.taskId)
    || !Number.isSafeInteger(input.expectedTaskVersion)
    || input.expectedTaskVersion <= 0
    || typeof input.valueClosureId !== "string"
    || !VALUE_CLOSURE_ID_RE.test(input.valueClosureId)
    || !Number.isSafeInteger(input.expectedValueClosureVersion)
    || input.expectedValueClosureVersion <= 0
  ) return null;
  const exactClosure = exactAcceptedClosure(input);
  if (!exactClosure) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readExistingState();
    if (!current) return null;
    if (current.state.status === "completed") {
      const same = current.state.firstValue.status === "resolved"
        && current.state.firstValue.taskId === input.taskId
        && current.state.firstValue.taskVersion === input.expectedTaskVersion
        && current.state.firstValue.valueClosureId === input.valueClosureId
        && current.state.firstValue.valueClosureVersion === input.expectedValueClosureVersion;
      if (same) {
        ensureStateEvents(current.state);
        return current.state;
      }
      return null;
    }
    if (current.state.status !== "active" || current.state.concern.status !== "resolved") return null;
    const task = getCanonicalTask(input.taskId);
    if (!task || task.originChatId !== current.state.concern.originChatId) return null;
    if (!current.state.route || Date.parse(task.createdAt) < Date.parse(current.state.route.selectedAt)) return null;
    const tick = nextTimestamp(current.state.version);
    try {
      const next = persist(current.raw, {
        ...current.state,
        version: tick.version,
        status: "completed",
        firstValue: {
          status: "resolved",
          taskId: input.taskId,
          taskVersion: input.expectedTaskVersion,
          valueClosureId: exactClosure.closure.valueClosureId,
          valueClosureVersion: exactClosure.version,
          resolvedAt: tick.iso,
        },
        mobileConnection: { status: "offered", resolution: null, resolvedAt: null },
        completionReason: "verified_first_value",
        updatedAt: tick.iso,
        completedAt: tick.iso,
      });
      ensureStateEvents(next);
      return next;
    } catch (error) {
      if (attempt === 2 || !/changed concurrently/.test(error instanceof Error ? error.message : String(error))) {
        return null;
      }
    }
  }
  return null;
}
