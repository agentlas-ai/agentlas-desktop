export const ONE_PROJECT_DEADLINE_CONTRACT_VERSION = "1.0.0" as const;

export type OneProjectDeadlineLeadMinutes = 60 | 180 | 1440 | 4320 | 10080;

/**
 * Renderer-safe projection. The Main-only relative path is deliberately not
 * represented here, so list/read IPC and Mobile can never echo it.
 */
export interface OneProjectDeadlineCheck {
  contractVersion: typeof ONE_PROJECT_DEADLINE_CONTRACT_VERSION;
  checkId: string;
  version: number;
  projectId: string;
  sourceKind: "user_provided_read_only_deadline";
  conditionKind: "relative_path_exists";
  deadlineAt: string;
  timezone: string;
  leadTimeMinutes: OneProjectDeadlineLeadMinutes;
  enabled: true;
  createdAt: string;
  updatedAt: string;
}

export interface OneProjectDeadlineState {
  contractVersion: typeof ONE_PROJECT_DEADLINE_CONTRACT_VERSION;
  storeVersion: number;
  checks: OneProjectDeadlineCheck[];
}

export interface ConnectOneProjectDeadlineInput {
  expectedStoreVersion: number;
  projectId: string;
  deadlineAt: string;
  timezone: string;
  leadTimeMinutes: OneProjectDeadlineLeadMinutes;
  /** Main-only after this inbound user action; no read projection echoes it. */
  relativeDeliverablePath: string;
  confirmedReadOnly: true;
}

export interface RemoveOneProjectDeadlineInput {
  expectedStoreVersion: number;
  checkId: string;
  expectedCheckVersion: number;
  confirmedByUser: true;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LEAD_MINUTES = new Set<number>([60, 180, 1440, 4320, 10080]);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function safeIsoWithZone(value: unknown): value is string {
  return typeof value === "string" && ISO_WITH_ZONE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function safeTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001F\u007F]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function isOneProjectDeadlineCheck(value: unknown): value is OneProjectDeadlineCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "contractVersion", "checkId", "version", "projectId", "sourceKind", "conditionKind",
    "deadlineAt", "timezone", "leadTimeMinutes", "enabled", "createdAt", "updatedAt",
  ])) return false;
  return item.contractVersion === ONE_PROJECT_DEADLINE_CONTRACT_VERSION
    && typeof item.checkId === "string" && SAFE_ID_RE.test(item.checkId)
    && Number.isSafeInteger(item.version) && Number(item.version) >= 1
    && typeof item.projectId === "string" && SAFE_ID_RE.test(item.projectId)
    && item.sourceKind === "user_provided_read_only_deadline"
    && item.conditionKind === "relative_path_exists"
    && safeIsoWithZone(item.deadlineAt)
    && safeTimezone(item.timezone)
    && Number.isSafeInteger(item.leadTimeMinutes) && LEAD_MINUTES.has(Number(item.leadTimeMinutes))
    && item.enabled === true
    && safeIsoWithZone(item.createdAt)
    && safeIsoWithZone(item.updatedAt);
}

export function isOneProjectDeadlineState(value: unknown): value is OneProjectDeadlineState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, ["contractVersion", "storeVersion", "checks"])
    && item.contractVersion === ONE_PROJECT_DEADLINE_CONTRACT_VERSION
    && Number.isSafeInteger(item.storeVersion) && Number(item.storeVersion) >= 1
    && Array.isArray(item.checks) && item.checks.length <= 100
    && item.checks.every(isOneProjectDeadlineCheck);
}

export function isOneProjectDeadlineTimezone(value: unknown): value is string {
  return safeTimezone(value);
}

export function isOneProjectDeadlineIso(value: unknown): value is string {
  return safeIsoWithZone(value);
}

export function isOneProjectDeadlineLeadMinutes(value: unknown): value is OneProjectDeadlineLeadMinutes {
  return Number.isSafeInteger(value) && LEAD_MINUTES.has(Number(value));
}
