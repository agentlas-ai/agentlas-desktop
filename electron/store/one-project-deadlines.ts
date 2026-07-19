import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "./db";
import { getProject } from "./projects";
import {
  ONE_PROJECT_DEADLINE_CONTRACT_VERSION,
  isOneProjectDeadlineCheck,
  isOneProjectDeadlineIso,
  isOneProjectDeadlineLeadMinutes,
  isOneProjectDeadlineState,
  isOneProjectDeadlineTimezone,
  type ConnectOneProjectDeadlineInput,
  type OneProjectDeadlineCheck,
  type OneProjectDeadlineState,
  type RemoveOneProjectDeadlineInput,
} from "../../shared/one-project-deadline";

export const ONE_PROJECT_DEADLINES_META_KEY = "one.project-deadlines.v1";

const STORE_SCHEMA_VERSION = 1 as const;
const MAX_CHECKS = 100;
const MAX_STORE_BYTES = 512 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface MainOnlyOneProjectDeadlineCheck extends OneProjectDeadlineCheck {
  /** Never returned by renderer or Mobile read projections. */
  relativeDeliverablePath: string;
}

interface OneProjectDeadlineStoreV1 {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  storeVersion: number;
  checks: MainOnlyOneProjectDeadlineCheck[];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === allowed.size && actual.every((key) => allowed.has(key));
}

function normalizeRelativeDeliverablePath(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected deliverable path must be a relative file path");
  const raw = value.trim().replace(/\\/g, "/");
  if (
    raw.length < 1 || raw.length > 512 || raw.endsWith("/")
    || /[\u0000-\u001F\u007F]/.test(raw)
    || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)
  ) {
    throw new TypeError("Expected deliverable path must stay inside the connected project folder");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment.length < 1 || segment === "." || segment === "..")) {
    throw new TypeError("Expected deliverable path must stay inside the connected project folder");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new TypeError("Expected deliverable path must stay inside the connected project folder");
  }
  return normalized;
}

function isMainOnlyCheck(value: unknown): value is MainOnlyOneProjectDeadlineCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "contractVersion", "checkId", "version", "projectId", "sourceKind", "conditionKind",
    "deadlineAt", "timezone", "leadTimeMinutes", "enabled", "createdAt", "updatedAt",
    "relativeDeliverablePath",
  ])) return false;
  const { relativeDeliverablePath: _privatePath, ...projection } = item;
  if (!isOneProjectDeadlineCheck(projection)) return false;
  try {
    return normalizeRelativeDeliverablePath(item.relativeDeliverablePath) === item.relativeDeliverablePath;
  } catch {
    return false;
  }
}

function parseStore(raw: string): OneProjectDeadlineStoreV1 {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) {
    throw new Error("One project deadline store is corrupt; it was not overwritten");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("One project deadline store is corrupt; it was not overwritten");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("One project deadline store is corrupt; it was not overwritten");
  }
  const item = value as Record<string, unknown>;
  if (
    !exactKeys(item, ["schemaVersion", "storeVersion", "checks"])
    || item.schemaVersion !== STORE_SCHEMA_VERSION
    || !Number.isSafeInteger(item.storeVersion) || Number(item.storeVersion) < 1
    || !Array.isArray(item.checks) || item.checks.length > MAX_CHECKS
    || !item.checks.every(isMainOnlyCheck)
  ) {
    throw new Error("One project deadline store is corrupt; it was not overwritten");
  }
  return value as OneProjectDeadlineStoreV1;
}

function readStore(): { state: OneProjectDeadlineStoreV1; raw: string | null } {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_PROJECT_DEADLINES_META_KEY) as { value: string } | undefined;
  if (!row) return { state: { schemaVersion: STORE_SCHEMA_VERSION, storeVersion: 1, checks: [] }, raw: null };
  return { state: parseStore(row.value), raw: row.value };
}

function persistStore(state: OneProjectDeadlineStoreV1, previousRaw: string | null): void {
  const nextRaw = JSON.stringify(state);
  if (Buffer.byteLength(nextRaw, "utf8") > MAX_STORE_BYTES) throw new Error("One project deadline store is full");
  if (previousRaw === null) {
    const result = getDb().prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_PROJECT_DEADLINES_META_KEY, nextRaw);
    if (result.changes !== 1) throw new Error("One project deadline state changed; refresh and try again");
    return;
  }
  const result = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").run(nextRaw, ONE_PROJECT_DEADLINES_META_KEY, previousRaw);
  if (result.changes !== 1) throw new Error("One project deadline state changed; refresh and try again");
}

function projection(state: OneProjectDeadlineStoreV1, projectId?: string): OneProjectDeadlineState {
  const result: OneProjectDeadlineState = {
    contractVersion: ONE_PROJECT_DEADLINE_CONTRACT_VERSION,
    storeVersion: state.storeVersion,
    checks: state.checks
      .filter((check) => projectId === undefined || check.projectId === projectId)
      .map(({ relativeDeliverablePath: _privatePath, ...check }) => ({ ...check })),
  };
  if (!isOneProjectDeadlineState(result)) throw new Error("One project deadline read projection is invalid");
  return result;
}

export function getOneProjectDeadlineState(projectId?: string): OneProjectDeadlineState {
  if (projectId !== undefined && (typeof projectId !== "string" || !SAFE_ID_RE.test(projectId))) {
    throw new TypeError("Invalid project deadline project identity");
  }
  return projection(readStore().state, projectId);
}

/** Main-only detector input. Callers must never return this value over IPC. */
export function listOneProjectDeadlineChecksMain(): MainOnlyOneProjectDeadlineCheck[] {
  return readStore().state.checks.map((check) => ({ ...check }));
}

export function connectOneProjectDeadline(
  input: ConnectOneProjectDeadlineInput,
  now = new Date(),
): OneProjectDeadlineState {
  if (!input || typeof input !== "object" || !exactKeys(input, [
    "expectedStoreVersion", "projectId", "deadlineAt", "timezone", "leadTimeMinutes",
    "relativeDeliverablePath", "confirmedReadOnly",
  ])) throw new TypeError("Invalid project deadline connection request");
  if (!Number.isSafeInteger(input.expectedStoreVersion) || input.expectedStoreVersion < 1) throw new TypeError("Invalid project deadline store version");
  if (typeof input.projectId !== "string" || !SAFE_ID_RE.test(input.projectId)) throw new TypeError("Invalid project identity");
  if (!isOneProjectDeadlineIso(input.deadlineAt)) throw new TypeError("Deadline must be an ISO timestamp with an explicit offset");
  if (!isOneProjectDeadlineTimezone(input.timezone)) throw new TypeError("Deadline timezone must be a valid IANA timezone");
  if (!isOneProjectDeadlineLeadMinutes(input.leadTimeMinutes)) throw new TypeError("Invalid deadline warning window");
  if (input.confirmedReadOnly !== true) throw new TypeError("Read-only deadline connection requires explicit confirmation");
  const relativeDeliverablePath = normalizeRelativeDeliverablePath(input.relativeDeliverablePath);
  const project = getProject(input.projectId);
  if (!project?.folderPath) throw new Error("Connect a project folder before adding a deadline check");

  const connect = getDb().transaction(() => {
    const { state, raw } = readStore();
    if (state.storeVersion !== input.expectedStoreVersion) throw new Error("One project deadline state changed; refresh and try again");
    if (state.checks.length >= MAX_CHECKS) throw new Error("One project deadline check limit reached");
    const timestamp = now.toISOString();
    const check: MainOnlyOneProjectDeadlineCheck = {
      contractVersion: ONE_PROJECT_DEADLINE_CONTRACT_VERSION,
      checkId: `project-deadline:${randomUUID()}`,
      version: 1,
      projectId: project.id,
      sourceKind: "user_provided_read_only_deadline",
      conditionKind: "relative_path_exists",
      deadlineAt: new Date(input.deadlineAt).toISOString(),
      timezone: input.timezone,
      leadTimeMinutes: input.leadTimeMinutes,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      relativeDeliverablePath,
    };
    if (!isMainOnlyCheck(check)) throw new Error("Project deadline connection could not be validated");
    state.checks.push(check);
    state.storeVersion += 1;
    persistStore(state, raw);
    return projection(state, project.id);
  });
  return connect.immediate();
}

export function removeOneProjectDeadline(input: RemoveOneProjectDeadlineInput): OneProjectDeadlineState {
  if (!input || typeof input !== "object" || !exactKeys(input, [
    "expectedStoreVersion", "checkId", "expectedCheckVersion", "confirmedByUser",
  ])) throw new TypeError("Invalid project deadline removal request");
  if (!Number.isSafeInteger(input.expectedStoreVersion) || input.expectedStoreVersion < 1) throw new TypeError("Invalid project deadline store version");
  if (typeof input.checkId !== "string" || !SAFE_ID_RE.test(input.checkId)) throw new TypeError("Invalid project deadline check identity");
  if (!Number.isSafeInteger(input.expectedCheckVersion) || input.expectedCheckVersion < 1) throw new TypeError("Invalid project deadline check version");
  if (input.confirmedByUser !== true) throw new TypeError("Project deadline removal requires explicit confirmation");

  const remove = getDb().transaction(() => {
    const { state, raw } = readStore();
    if (state.storeVersion !== input.expectedStoreVersion) throw new Error("One project deadline state changed; refresh and try again");
    const index = state.checks.findIndex((check) => check.checkId === input.checkId);
    if (index < 0 || state.checks[index].version !== input.expectedCheckVersion) {
      throw new Error("One project deadline check changed; refresh and try again");
    }
    const [removed] = state.checks.splice(index, 1);
    state.storeVersion += 1;
    persistStore(state, raw);
    return projection(state, removed.projectId);
  });
  return remove.immediate();
}
