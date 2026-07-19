import type { OneAutomationPermissionPreview } from "./one-suggestions";

export const ONE_RECURRENCE_SELECTION_CONTRACT_VERSION = "1.0.0" as const;

export const ONE_RECURRENCE_INTENT_KINDS = [
  "briefing",
  "research",
  "file_review",
  "content_draft",
  "status_check",
] as const;

export const ONE_RECURRENCE_CADENCES = ["daily", "weekdays", "weekly"] as const;

export type OneRecurrenceIntentKind = typeof ONE_RECURRENCE_INTENT_KINDS[number];
export type OneRecurrenceCadence = typeof ONE_RECURRENCE_CADENCES[number];

/**
 * A closed, value-free declaration that can only come from explicit controls.
 * It deliberately has no free text, prompt, path, target, executable schedule,
 * or enablement bit. The proposal still starts only after a later review.
 */
export interface OneRecurrenceSelectionV1 {
  contractVersion: typeof ONE_RECURRENCE_SELECTION_CONTRACT_VERSION;
  intentKind: OneRecurrenceIntentKind;
  cadence: OneRecurrenceCadence;
  /** ISO weekday (Monday=1, Sunday=7), required only for weekly. */
  weekday: number | null;
  /** Exact local wall-clock minute, HH:mm. */
  localTime: string;
  /** IANA time-zone name selected by the user/device. */
  timeZone: string;
  startPolicy: "after_review_approval";
  endPolicy: "manual_stop";
  permission: OneAutomationPermissionPreview;
}

const INTENT_KINDS = new Set<string>(ONE_RECURRENCE_INTENT_KINDS);
const CADENCES = new Set<string>(ONE_RECURRENCE_CADENCES);
const PERMISSIONS = new Set<OneAutomationPermissionPreview>([
  "read_only",
  "draft_only",
  "approval_before_external_change",
]);
const LOCAL_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TIME_ZONE_RE = /^(?:UTC|[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+){1,3})$/;
const MAX_NEXT_OCCURRENCE_MINUTES = 8 * 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => expected.has(key));
}

function validTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 64 || !TIME_ZONE_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isOneRecurrenceSelectionV1(value: unknown): value is OneRecurrenceSelectionV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "intentKind", "cadence", "weekday", "localTime",
    "timeZone", "startPolicy", "endPolicy", "permission",
  ])) return false;
  if (
    value.contractVersion !== ONE_RECURRENCE_SELECTION_CONTRACT_VERSION
    || typeof value.intentKind !== "string" || !INTENT_KINDS.has(value.intentKind)
    || typeof value.cadence !== "string" || !CADENCES.has(value.cadence)
    || typeof value.localTime !== "string" || !LOCAL_TIME_RE.test(value.localTime)
    || typeof value.timeZone !== "string" || !validTimeZone(value.timeZone)
    || value.startPolicy !== "after_review_approval"
    || value.endPolicy !== "manual_stop"
    || typeof value.permission !== "string" || !PERMISSIONS.has(value.permission as OneAutomationPermissionPreview)
  ) return false;
  return value.cadence === "weekly"
    ? Number.isSafeInteger(value.weekday) && Number(value.weekday) >= 1 && Number(value.weekday) <= 7
    : value.weekday === null;
}

export function normalizeOneRecurrenceSelectionV1(value: unknown): OneRecurrenceSelectionV1 {
  if (!isOneRecurrenceSelectionV1(value)) {
    throw new TypeError("One recurrence requires an exact explicit selection; free text and unknown fields are not accepted");
  }
  return {
    contractVersion: ONE_RECURRENCE_SELECTION_CONTRACT_VERSION,
    intentKind: value.intentKind,
    cadence: value.cadence,
    weekday: value.weekday,
    localTime: value.localTime,
    timeZone: value.timeZone,
    startPolicy: "after_review_approval",
    endPolicy: "manual_stop",
    permission: value.permission,
  };
}

function localParts(atMs: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  isoWeekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const number = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    return raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  };
  const year = number("year");
  const month = number("month");
  const day = number("day");
  const hour = number("hour");
  const minute = number("minute");
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    throw new Error("Could not resolve the selected local wall-clock time");
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, isoWeekday: weekday === 0 ? 7 : weekday };
}

function cadenceMatches(selection: OneRecurrenceSelectionV1, isoWeekday: number): boolean {
  if (selection.cadence === "daily") return true;
  if (selection.cadence === "weekdays") return isoWeekday >= 1 && isoWeekday <= 5;
  return isoWeekday === selection.weekday;
}

/**
 * Finds the next real UTC instant matching the selected IANA-zone wall clock.
 * A bounded minute scan is intentional: it naturally handles DST gaps/folds
 * without inventing a fixed offset, and the supported cadences always resolve
 * within eight days.
 */
export function nextOneRecurrenceAt(
  selectionValue: OneRecurrenceSelectionV1,
  afterMs = Date.now(),
): string {
  const selection = normalizeOneRecurrenceSelectionV1(selectionValue);
  if (!Number.isFinite(afterMs)) throw new TypeError("afterMs must be finite");
  const [hour, minute] = selection.localTime.split(":").map(Number);
  let candidateMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < MAX_NEXT_OCCURRENCE_MINUTES; offset += 1, candidateMs += 60_000) {
    const local = localParts(candidateMs, selection.timeZone);
    if (
      local.hour === hour
      && local.minute === minute
      && cadenceMatches(selection, local.isoWeekday)
    ) return new Date(candidateMs).toISOString();
  }
  throw new Error("The selected recurrence has no bounded future occurrence");
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export function oneRecurrenceTriggerPreview(selectionValue: OneRecurrenceSelectionV1): string {
  const selection = normalizeOneRecurrenceSelectionV1(selectionValue);
  const cadence = selection.cadence === "daily"
    ? "Daily"
    : selection.cadence === "weekdays"
      ? "Weekdays"
      : `Weekly on ${WEEKDAY_NAMES[(selection.weekday ?? 1) - 1]}`;
  return `${cadence} at ${selection.localTime} (${selection.timeZone}), after explicit review approval`;
}

export function oneRecurrenceStopControl(): string {
  return "Manual stop remains available before every proposed future run.";
}
