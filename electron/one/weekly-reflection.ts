import { createHash } from "node:crypto";
import {
  ONE_WEEKLY_REFLECTION_CONTRACT_VERSION,
  ONE_WEEKLY_REFLECTION_SELECTION_BASIS,
  isOneWeeklyReflectionSnapshotV1,
  isOneWeeklyReflectionV1,
  type OneWeeklyReflectionEstimateV1,
  type OneWeeklyReflectionFactV1,
  type OneWeeklyReflectionOutcomeV1,
  type OneWeeklyReflectionSnapshotV1,
  type OneWeeklyReflectionStatus,
  type OneWeeklyReflectionTimeZoneSource,
  type OneWeeklyReflectionV1,
  type ResolveOneWeeklyReflectionInputV1,
} from "../../shared/one-weekly-reflection";
import type {
  OneTrustedOutcomeEvidence,
  OneValueClosureRecord,
  OneValueClosureState,
} from "../../shared/one-value-closure";
import { oneValueClosureContainsCompletionClaim } from "../../shared/one-value-closure";
import type { OneDomainEventV1 } from "../../shared/one-domain-events";
import type { OneProfile } from "../../shared/one-profile";
import { getDb } from "../store/db";
import { getOneProfile } from "../store/one-profile";
import { getOneValueClosureState } from "./value-closure";
import { listOneDomainEventsByType } from "./domain-events";

export const ONE_WEEKLY_REFLECTION_META_KEY = "agentlas.one.weekly-reflection.v1";

const INTERNAL_STATE_VERSION = 1 as const;
const MAX_STATE_ENTRIES = 104;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const REFLECTION_ID_RE = /^weekly_reflection_[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const WEEK_KEY_RE = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

interface OneWeeklyReflectionReceiptV1 {
  weekKey: string;
  reflectionId: string;
  contentDigest: string;
  status: Exclude<OneWeeklyReflectionStatus, "open">;
  updatedAt: string;
}

interface OneWeeklyReflectionStateV1 {
  schemaVersion: typeof INTERNAL_STATE_VERSION;
  version: number;
  receipts: OneWeeklyReflectionReceiptV1[];
  createdAt: string;
  updatedAt: string;
}

export interface OneIsoWeekWindow {
  weekKey: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  timeZoneSource: OneWeeklyReflectionTimeZoneSource;
}

export interface BuildOneWeeklyReflectionInput {
  now: Date;
  profile?: Pick<OneProfile, "timeZone"> | null;
  systemTimeZone?: string | null;
  valueClosureState: OneValueClosureState;
  correctionEvents: OneDomainEventV1[];
  receipt?: OneWeeklyReflectionReceiptV1 | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(
  profile: Pick<OneProfile, "timeZone"> | null | undefined,
  systemTimeZone?: string | null,
): { timeZone: string; timeZoneSource: OneWeeklyReflectionTimeZoneSource } {
  if (validTimeZone(profile?.timeZone)) return { timeZone: profile.timeZone, timeZoneSource: "profile" };
  let system = systemTimeZone;
  if (system === undefined) {
    try { system = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { system = null; }
  }
  if (validTimeZone(system)) return { timeZone: system, timeZoneSource: "system" };
  return { timeZone: "UTC", timeZoneSource: "utc" };
}

function zonedParts(at: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)) values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localDateAtStartOfIsoWeek(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const local = zonedParts(now, timeZone);
  const cursor = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const isoWeekday = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() - (isoWeekday - 1));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

function instantForLocalMidnight(date: { year: number; month: number; day: number }, timeZone: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  let candidate = target;
  for (let pass = 0; pass < 8; pass += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = target - rendered;
    if (delta === 0) return new Date(candidate);
    candidate += delta;
  }
  // Midnight transitions exist in a small set of IANA zones. If the exact
  // wall time does not exist, choose the first real instant belonging to that
  // local date rather than silently moving the week to another date.
  const lower = target - 36 * 60 * 60 * 1_000;
  const upper = target + 36 * 60 * 60 * 1_000;
  let first: number | null = null;
  for (let cursor = lower; cursor <= upper; cursor += 60 * 1_000) {
    const parts = zonedParts(new Date(cursor), timeZone);
    if (parts.year === date.year && parts.month === date.month && parts.day === date.day) {
      first = cursor;
      break;
    }
  }
  if (first === null) throw new Error("Could not resolve the local ISO-week boundary");
  return new Date(first);
}

function nextLocalWeek(start: { year: number; month: number; day: number }): { year: number; month: number; day: number } {
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  cursor.setUTCDate(cursor.getUTCDate() + 7);
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

function isoWeekKey(localMonday: { year: number; month: number; day: number }): string {
  const cursor = new Date(Date.UTC(localMonday.year, localMonday.month - 1, localMonday.day));
  cursor.setUTCDate(cursor.getUTCDate() + 4 - (cursor.getUTCDay() || 7));
  const isoYear = cursor.getUTCFullYear();
  const first = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil((((cursor.getTime() - first) / 86_400_000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function getOneIsoWeekWindow(input: {
  now: Date;
  profile?: Pick<OneProfile, "timeZone"> | null;
  systemTimeZone?: string | null;
}): OneIsoWeekWindow {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new TypeError("Weekly reflection now must be a valid date");
  const zone = resolveTimeZone(input.profile, input.systemTimeZone);
  const startLocal = localDateAtStartOfIsoWeek(input.now, zone.timeZone);
  return {
    weekKey: isoWeekKey(startLocal),
    periodStart: instantForLocalMidnight(startLocal, zone.timeZone).toISOString(),
    periodEnd: instantForLocalMidnight(nextLocalWeek(startLocal), zone.timeZone).toISOString(),
    ...zone,
  };
}

function trustedEvidenceForRecord(
  state: OneValueClosureState,
  record: OneValueClosureRecord,
  latestAllowedAt: number,
): OneTrustedOutcomeEvidence[] {
  const refs = new Set(record.trustedEvidenceRefs);
  return state.evidence.filter((item) => refs.has(item.evidenceRef)
    && item.taskId === record.closure.taskId
    && item.taskVersion === record.taskVersion
    && item.verificationStatus === "verified"
    && item.source !== "explicit_user_observation"
    && Date.parse(item.observedAt) <= latestAllowedAt);
}

function exactEvidence(
  refs: readonly string[],
  trusted: readonly OneTrustedOutcomeEvidence[],
): OneTrustedOutcomeEvidence[] | null {
  const resolved: OneTrustedOutcomeEvidence[] = [];
  for (const ref of refs) {
    const matches = trusted.filter((item) => [
      item.evidenceRef,
      item.receiptRef,
      item.outcomeRef,
      item.artifactRef,
    ].some((candidate) => candidate === ref));
    if (matches.length < 1) return null;
    resolved.push(...matches);
  }
  return [...new Map(resolved.map((item) => [item.evidenceRef, item])).values()];
}

function projectPreservation(
  record: OneValueClosureRecord,
  trusted: readonly OneTrustedOutcomeEvidence[],
): OneWeeklyReflectionOutcomeV1["originalPreservation"] | null {
  const source = record.closure.originalPreservation;
  if (source.status === "not_applicable") {
    return { status: "not_applicable", artifactRefs: [], receiptRefs: [] };
  }
  const artifactEvidence = source.artifactRefs.map((ref) => trusted.find((item) => item.artifactRef === ref));
  const receiptEvidence = source.receiptRefs.map((ref) => trusted.find((item) => item.receiptRef === ref));
  if (artifactEvidence.some((item) => !item) || receiptEvidence.some((item) => !item)) return null;
  if (source.status === "preserved" && ![...artifactEvidence, ...receiptEvidence].every((item) => item?.kind === "original_preservation")) return null;
  if (source.status === "modified_with_approval" && !receiptEvidence.every((item) => item?.kind === "approval_receipt")) return null;
  return {
    status: source.status,
    artifactRefs: [...source.artifactRefs],
    receiptRefs: [...source.receiptRefs],
    ...(source.explanation ? { explanation: source.explanation } : {}),
  };
}

function projectOutcome(
  state: OneValueClosureState,
  record: OneValueClosureRecord,
  latestAllowedAt: number,
): OneWeeklyReflectionOutcomeV1 | null {
  const closure = record.closure;
  if (closure.outcomeStatus !== "verified"
    || !closure.reflection.eligible
    || !closure.reflection.userOptedIn
    || !closure.reflection.included) return null;
  const trusted = trustedEvidenceForRecord(state, record, latestAllowedAt);
  if (trusted.length < 1) return null;
  if (!closure.outcomeRefs.every((outcomeRef) => trusted.some((item) =>
    item.kind === "outcome_verification" && item.outcomeRef === outcomeRef,
  ))) return null;
  const verification = closure.lifecycleClaims.find((item) => item.phase === "verification");
  const verificationEvidence = verification ? exactEvidence(verification.evidenceRefs, trusted) : null;
  if (verification?.status !== "completed" || !verificationEvidence?.some((item) =>
    item.kind === "outcome_verification" || item.kind === "artifact_verification",
  )) return null;

  const facts = closure.valueItems.flatMap((item): OneWeeklyReflectionFactV1[] => {
    if (item.kind !== "fact") return [];
    const evidence = exactEvidence(item.evidenceRefs, trusted);
    if (!evidence) return [];
    if (oneValueClosureContainsCompletionClaim(item.statement) && !evidence.some((entry) =>
      entry.kind === "execution_receipt" || entry.kind === "outcome_verification",
    )) return [];
    return [{ valueItemRef: item.valueItemId, statement: item.statement, evidenceRefs: item.evidenceRefs }];
  }).slice(0, 3);
  if (facts.length < 1) return null;
  const estimates = closure.valueItems.flatMap((item): OneWeeklyReflectionEstimateV1[] => {
    if (item.kind !== "estimate") return [];
    const evidence = exactEvidence(item.estimate.evidenceRefs, trusted);
    if (!evidence?.some((entry) => entry.kind === "estimate_baseline")) return [];
    return [{
      valueItemRef: item.valueItemId,
      label: "estimate",
      statement: item.statement,
      ...(item.estimate.value !== undefined ? { value: item.estimate.value } : {}),
      ...(item.estimate.lowerBound !== undefined ? { lowerBound: item.estimate.lowerBound } : {}),
      ...(item.estimate.upperBound !== undefined ? { upperBound: item.estimate.upperBound } : {}),
      unit: item.estimate.unit,
      basis: item.estimate.basis,
      method: item.estimate.method,
      evidenceRefs: item.estimate.evidenceRefs,
    }];
  }).slice(0, 1);
  const originalPreservation = projectPreservation(record, trusted);
  if (!originalPreservation) return null;
  const evidenceRefs = [...new Set([
    ...closure.outcomeRefs.flatMap((outcomeRef) => trusted.filter((item) => item.outcomeRef === outcomeRef).map((item) => item.evidenceRef)),
    ...facts.flatMap((item) => item.evidenceRefs),
    ...estimates.flatMap((item) => item.evidenceRefs),
    ...trusted.filter((item) => originalPreservation.artifactRefs.includes(item.artifactRef ?? "")
      || originalPreservation.receiptRefs.includes(item.receiptRef)).map((item) => item.evidenceRef),
  ])].sort();
  if (evidenceRefs.length < 1) return null;
  return {
    valueClosureRef: closure.valueClosureId,
    valueClosureVersion: record.version,
    taskId: closure.taskId,
    taskVersion: record.taskVersion,
    generatedAt: closure.generatedAt,
    outcomeRefs: [...closure.outcomeRefs],
    facts,
    estimates,
    evidenceRefs,
    originalPreservation,
    remainingWork: closure.remainingWork
      .filter((item) => item.status === "pending" || item.status === "blocked")
      .slice(0, 3)
      .map((item) => ({ ...item })),
  };
}

function correctionCategory(event: OneDomainEventV1): "wrong" | "not_important" | null {
  if (event.eventType !== "briefing.dismissed") return null;
  const entry = event.payload.entries.find((item) => item.name === "reasonCategory");
  return entry?.value === "wrong" || entry?.value === "not_important" ? entry.value : null;
}

function stableContent(value: unknown): string {
  return JSON.stringify(value);
}

export function buildOneWeeklyReflection(input: BuildOneWeeklyReflectionInput): OneWeeklyReflectionV1 | null {
  const window = getOneIsoWeekWindow(input);
  const startMs = Date.parse(window.periodStart);
  const endMs = Date.parse(window.periodEnd);
  const latestAllowedAt = input.now.getTime() + MAX_CLOCK_SKEW_MS;
  const outcomes = input.valueClosureState.closures
    .filter((record) => {
      const generated = Date.parse(record.closure.generatedAt);
      return Number.isFinite(generated) && generated >= startMs && generated < endMs && generated <= latestAllowedAt;
    })
    .map((record) => projectOutcome(input.valueClosureState, record, latestAllowedAt))
    .filter((item): item is OneWeeklyReflectionOutcomeV1 => Boolean(item))
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt)
      || left.valueClosureRef.localeCompare(right.valueClosureRef))
    .slice(0, 5);
  if (outcomes.length < 1) return null;
  const corrections = input.correctionEvents.reduce((aggregate, event) => {
    const occurred = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurred) || occurred < startMs || occurred >= endMs || occurred > latestAllowedAt) return aggregate;
    const category = correctionCategory(event);
    if (category === "wrong") aggregate.wrong += 1;
    if (category === "not_important") aggregate.notImportant += 1;
    return aggregate;
  }, { wrong: 0, notImportant: 0 });
  const content = {
    weekKey: window.weekKey,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    timeZone: window.timeZone,
    timeZoneSource: window.timeZoneSource,
    selectionBasis: ONE_WEEKLY_REFLECTION_SELECTION_BASIS,
    outcomes,
    corrections,
  };
  const contentDigest = createHash("sha256").update(stableContent(content)).digest("hex");
  const reflectionId = `weekly_reflection_${createHash("sha256").update(`${window.weekKey}\0${contentDigest}`).digest("hex").slice(0, 32)}`;
  const receipt = input.receipt?.weekKey === window.weekKey
    && (input.receipt.status === "hidden"
      || (input.receipt.reflectionId === reflectionId
        && input.receipt.contentDigest === contentDigest))
    ? input.receipt
    : null;
  const generatedAt = outcomes.map((item) => item.generatedAt).sort().at(-1) ?? window.periodStart;
  const reflection: OneWeeklyReflectionV1 = {
    contractVersion: ONE_WEEKLY_REFLECTION_CONTRACT_VERSION,
    reflectionId,
    contentDigest,
    ...window,
    selectionBasis: ONE_WEEKLY_REFLECTION_SELECTION_BASIS,
    generatedAt,
    status: receipt?.status ?? "open",
    statusUpdatedAt: receipt?.updatedAt ?? null,
    outcomes,
    corrections,
  };
  if (!isOneWeeklyReflectionV1(reflection)) throw new Error("Weekly reflection violated its closed renderer contract");
  return reflection;
}

function initialState(): OneWeeklyReflectionStateV1 {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return { schemaVersion: INTERNAL_STATE_VERSION, version, receipts: [], createdAt: now, updatedAt: now };
}

function isReceipt(value: unknown): value is OneWeeklyReflectionReceiptV1 {
  if (!isRecord(value) || !exactKeys(value, ["weekKey", "reflectionId", "contentDigest", "status", "updatedAt"])) return false;
  return typeof value.weekKey === "string" && WEEK_KEY_RE.test(value.weekKey)
    && typeof value.reflectionId === "string" && REFLECTION_ID_RE.test(value.reflectionId)
    && typeof value.contentDigest === "string" && DIGEST_RE.test(value.contentDigest)
    && ["acknowledged", "hidden"].includes(String(value.status))
    && isTimestamp(value.updatedAt);
}

function isState(value: unknown): value is OneWeeklyReflectionStateV1 {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "version", "receipts", "createdAt", "updatedAt"])) return false;
  if (value.schemaVersion !== INTERNAL_STATE_VERSION || !isPositiveVersion(value.version)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_STATE_ENTRIES || !value.receipts.every(isReceipt)) return false;
  return new Set(value.receipts.map((item) => item.weekKey)).size === value.receipts.length;
}

function parseState(raw: string): OneWeeklyReflectionStateV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Stored One weekly reflection state is corrupt; it was not overwritten"); }
  if (!isState(parsed)) throw new Error("Stored One weekly reflection state violates its closed contract; it was not overwritten");
  return parsed;
}

function readOrCreateState(): { raw: string; state: OneWeeklyReflectionStateV1 } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_WEEKLY_REFLECTION_META_KEY) as { value: string } | undefined;
  if (!row) {
    const candidate = JSON.stringify(initialState());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_WEEKLY_REFLECTION_META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_WEEKLY_REFLECTION_META_KEY) as { value: string } | undefined;
  }
  if (!row) throw new Error("Could not initialize One weekly reflection state");
  return { raw: row.value, state: parseState(row.value) };
}

function dependencies(now: Date): {
  profile: Pick<OneProfile, "timeZone"> | null;
  valueClosureState: OneValueClosureState;
  window: OneIsoWeekWindow;
  correctionEvents: OneDomainEventV1[];
} {
  let profile: Pick<OneProfile, "timeZone"> | null = null;
  try { profile = getOneProfile(); } catch { profile = null; }
  const window = getOneIsoWeekWindow({ now, profile });
  return {
    profile,
    valueClosureState: getOneValueClosureState(),
    window,
    correctionEvents: listOneDomainEventsByType("briefing.dismissed", {
      occurredAtOrAfter: window.periodStart,
      occurredBefore: window.periodEnd,
      limit: 500,
    }),
  };
}

export function getOneWeeklyReflectionSnapshot(input: { now?: Date } = {}): OneWeeklyReflectionSnapshotV1 {
  const now = input.now ?? new Date();
  const current = readOrCreateState();
  const deps = dependencies(now);
  const receipt = current.state.receipts.find((item) => item.weekKey === deps.window.weekKey) ?? null;
  const snapshot: OneWeeklyReflectionSnapshotV1 = {
    contractVersion: ONE_WEEKLY_REFLECTION_CONTRACT_VERSION,
    stateVersion: current.state.version,
    reflection: buildOneWeeklyReflection({
      now,
      profile: deps.profile,
      valueClosureState: deps.valueClosureState,
      correctionEvents: deps.correctionEvents,
      receipt,
    }),
  };
  if (!isOneWeeklyReflectionSnapshotV1(snapshot)) throw new Error("Weekly reflection snapshot violated its closed renderer contract");
  return snapshot;
}

function normalizeAction(input: ResolveOneWeeklyReflectionInputV1): void {
  if (!isRecord(input) || !exactKeys(input, [
    "expectedStateVersion", "reflectionId", "weekKey", "expectedContentDigest", "action", "confirmedByUser",
  ])) throw new TypeError("Weekly reflection action violates its closed contract");
  if (!isPositiveVersion(input.expectedStateVersion)
    || !REFLECTION_ID_RE.test(String(input.reflectionId))
    || !WEEK_KEY_RE.test(String(input.weekKey))
    || !DIGEST_RE.test(String(input.expectedContentDigest))
    || !["acknowledge", "hide_week"].includes(String(input.action))) throw new TypeError("Invalid weekly reflection action binding");
  if (input.confirmedByUser !== true) throw new Error("Weekly reflection actions require explicit user confirmation");
}

export function resolveOneWeeklyReflection(input: ResolveOneWeeklyReflectionInputV1): OneWeeklyReflectionSnapshotV1 {
  normalizeAction(input);
  const status: OneWeeklyReflectionReceiptV1["status"] = input.action === "acknowledge" ? "acknowledged" : "hidden";
  const db = getDb();
  const mutate = db.transaction(() => {
    const current = readOrCreateState();
    const existing = current.state.receipts.find((item) => item.weekKey === input.weekKey);
    const exactAlreadyApplied = existing?.weekKey === input.weekKey
      && existing.status === status
      && (status === "hidden"
        || (existing.reflectionId === input.reflectionId
          && existing.contentDigest === input.expectedContentDigest));
    if (current.state.version !== input.expectedStateVersion) {
      if (exactAlreadyApplied) return current.state;
      throw new Error(`One weekly reflection state changed (expected ${input.expectedStateVersion}, current ${current.state.version})`);
    }
    if (exactAlreadyApplied) return current.state;
    const currentSnapshot = getOneWeeklyReflectionSnapshot();
    const reflection = currentSnapshot.reflection;
    if (!reflection
      || reflection.status !== "open"
      || reflection.reflectionId !== input.reflectionId
      || reflection.weekKey !== input.weekKey
      || reflection.contentDigest !== input.expectedContentDigest) {
      throw new Error("Weekly reflection changed; review the current week before resolving it");
    }
    const version = Math.max(Date.now(), current.state.version + 1);
    const updatedAt = new Date(version).toISOString();
    if (Date.parse(updatedAt) > Date.now() + MAX_CLOCK_SKEW_MS) throw new Error("Weekly reflection clock moved beyond the allowed skew");
    const receipt: OneWeeklyReflectionReceiptV1 = {
      weekKey: input.weekKey,
      reflectionId: input.reflectionId,
      contentDigest: input.expectedContentDigest,
      status,
      updatedAt,
    };
    const receipts = [
      ...current.state.receipts.filter((item) => item.weekKey !== input.weekKey),
      receipt,
    ].sort((left, right) => right.weekKey.localeCompare(left.weekKey)).slice(0, MAX_STATE_ENTRIES);
    const next: OneWeeklyReflectionStateV1 = {
      ...current.state,
      version,
      receipts,
      updatedAt,
    };
    if (!isState(next)) throw new Error("Weekly reflection mutation violated its closed storage contract");
    const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_WEEKLY_REFLECTION_META_KEY, current.raw);
    if (result.changes !== 1) throw new Error("One weekly reflection state changed concurrently; reload and try again");
    return next;
  });
  mutate.immediate();
  return getOneWeeklyReflectionSnapshot();
}
