import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { listAutomations, listRunHistory } from "../store/automations";
import { listProjects } from "../store/projects";
import { listCanonicalTasks } from "../store/tasks";
import {
  listOneProjectDeadlineChecksMain,
  type MainOnlyOneProjectDeadlineCheck,
} from "../store/one-project-deadlines";
import { getLatestInvocationRunReceipt, listFailureEvents } from "../store/run-events";
import {
  ONE_BRIEFING_CONTRACT_VERSION,
  isOneProactiveBriefing,
  type OneBriefingCadence,
  type OneBriefingChannel,
  type OneBriefingFeedback,
  type OneBriefingPreferences,
  type OneBriefingSnapshot,
  type OpenOneBriefingTaskInput,
  type OpenOneBriefingTaskResult,
  type OneProactiveBriefing,
} from "../../shared/one-briefing";
import type { Automation, AutomationRunRecord, CanonicalTask, FailureEventUi, InvocationRunReceipt, Project } from "../../shared/types";
import { tryRecordOneDomainEvent } from "./domain-events";
import { resolveMainOwnedReadPath } from "../fs/access";

const STATE_VERSION = 1 as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const CANDIDATE_TTL_MS = 7 * DAY_MS;
const TASK_CANDIDATE_TTL_MS = 30 * DAY_MS;
const WAITING_DECISION_THRESHOLD_MS = DAY_MS;
const RUNNING_STALL_THRESHOLD_MS = 2 * 60 * 60 * 1_000;
const ABANDONED_TASK_THRESHOLD_MS = 3 * DAY_MS;
const DEADLINE_CONFLICT_RETENTION_MS = 7 * DAY_MS;
const MAX_STATE_BYTES = 256 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

interface BriefingSuppression {
  key: string;
  until: string;
  feedback: OneBriefingFeedback;
}

interface BriefingObservation {
  key: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface BriefingNotificationReceipt {
  key: string;
  candidateId: string;
  sourceVersion: number | null;
  claimedAt: string;
  expiresAt: string;
}

interface BriefingStateV1 {
  version: typeof STATE_VERSION;
  revision: number;
  preferences: OneBriefingPreferences;
  suppressions: BriefingSuppression[];
  observations: BriefingObservation[];
  notificationReceipts: BriefingNotificationReceipt[];
}

export interface OneBriefingDetectorDependencies {
  now?: Date;
  projects?: Project[];
  automations?: Automation[];
  runHistory?: (automationId: string, limit?: number) => AutomationRunRecord[];
  pathStatus?: (folderPath: string) => "directory" | "missing" | "unreadable" | "not_directory";
  projectObservationAt?: (projectId: string, status: "missing" | "unreadable" | "not_directory") => string | null;
  projectDeadlines?: MainOnlyOneProjectDeadlineCheck[];
  deliverableStatus?: (folderPath: string, relativeDeliverablePath: string) => "present" | "missing" | "unreadable";
  tasks?: CanonicalTask[];
  activeChatIds?: string[];
  latestRunReceipt?: (chatId: string) => InvocationRunReceipt | null;
  failureEvents?: (chatId: string, limit?: number) => FailureEventUi[];
}

let activeChatIdsProvider: () => string[] = () => [];

export function configureOneBriefingRuntime(input: { activeChatIds: () => string[] }): void {
  activeChatIdsProvider = input.activeChatIds;
}

function iso(date: Date): string {
  return date.toISOString();
}

function safeLabel(value: string, fallback: string, limit = 120): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, limit);
}

function stableToken(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

function candidateId(kind: string, refId: string, observedAt: string): string {
  return `briefing:${kind}:${stableToken(refId, observedAt)}`;
}

function freshness(observedAt: string, now: Date): "fresh" | "aging" | "stale" {
  const age = now.getTime() - Date.parse(observedAt);
  if (age <= DAY_MS) return "fresh";
  if (age <= 3 * DAY_MS) return "aging";
  return "stale";
}

function defaultPathStatus(folderPath: string): "directory" | "missing" | "unreadable" | "not_directory" {
  try {
    const stat = fs.lstatSync(folderPath);
    // A connected root that has become a symlink can be swapped after the
    // user's approval. Background Briefing detection must not follow it into
    // an unapproved location; reconnect the canonical folder explicitly.
    if (stat.isSymbolicLink()) return "unreadable";
    return stat.isDirectory() ? "directory" : "not_directory";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    return code === "ENOENT" ? "missing" : "unreadable";
  }
}

function defaultDeliverableStatus(
  folderPath: string,
  relativeDeliverablePath: string,
): "present" | "missing" | "unreadable" {
  try {
    const root = path.resolve(folderPath);
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return "unreadable";
    const segments = relativeDeliverablePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "unreadable";
    const target = path.resolve(root, ...segments);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "unreadable";
    let cursor = root;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(cursor);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
        return code === "ENOENT" ? "missing" : "unreadable";
      }
      if (stat.isSymbolicLink()) return "unreadable";
      const final = index === segments.length - 1;
      if (!final && !stat.isDirectory()) return "unreadable";
      if (final) {
        if (!stat.isFile()) return "missing";
        try {
          resolveMainOwnedReadPath(cursor, root);
          return "present";
        } catch {
          return "unreadable";
        }
      }
    }
    return "unreadable";
  } catch {
    return "unreadable";
  }
}

function projectFolderCandidate(
  project: Project,
  now: Date,
  status: ReturnType<typeof defaultPathStatus>,
  observedAt?: string | null,
): OneProactiveBriefing | null {
  if (!project.folderPath || status === "directory") return null;
  const detectedAt = observedAt && Number.isFinite(Date.parse(observedAt)) ? observedAt : iso(now);
  const projectName = safeLabel(project.name, "Project");
  const statusLabel = status === "missing"
    ? "Connected folder is no longer available"
    : status === "not_directory"
      ? "Connected location is not a folder"
      : "Connected folder could not be verified";
  const dedupeKey = `project-folder:${stableToken(project.id, status)}`;
  return {
    contractVersion: ONE_BRIEFING_CONTRACT_VERSION,
    candidateId: candidateId("project-folder", project.id, status),
    dedupeKey,
    kind: "risk",
    reasonCode: status === "missing"
      ? "project_folder_missing"
      : status === "not_directory"
        ? "project_folder_not_directory"
        : "project_folder_unreadable",
    severity: 4,
    source: { kind: "project_folder", refId: project.id, label: projectName },
    detectedAt,
    expiresAt: iso(new Date(Date.parse(detectedAt) + CANDIDATE_TTL_MS)),
    confidence: {
      level: "high",
      basis: "Desktop checked only the user-connected folder boundary and did not read file contents.",
    },
    discovery: `${projectName}'s connected folder is not currently available to One.`,
    impact: "The team cannot verify current project files, so a new result could be incomplete or based on stale context.",
    prepared: "The project connection screen is ready. No file or folder was changed.",
    decision: {
      prompt: "Open the project and reconnect its folder now?",
      acceptLabel: "Open project",
      dismissLabel: "Later",
    },
    evidence: [
      { label: "Project", value: projectName, observedAt: detectedAt, freshness: "fresh" },
      { label: "Connection check", value: statusLabel, observedAt: detectedAt, freshness: "fresh" },
    ],
    preparedAction: {
      kind: "open_project",
      targetId: project.id,
      label: "Open project",
      executionStarted: false,
    },
  };
}

function projectDeadlineCandidate(
  check: MainOnlyOneProjectDeadlineCheck,
  project: Project,
  now: Date,
  status: "present" | "missing" | "unreadable",
): OneProactiveBriefing | null {
  if (!project.folderPath || !check.enabled || status !== "missing") return null;
  const deadlineMs = Date.parse(check.deadlineAt);
  if (!Number.isFinite(deadlineMs)) return null;
  const riskStartsMs = deadlineMs - check.leadTimeMinutes * 60 * 1_000;
  const expiresMs = deadlineMs + DEADLINE_CONFLICT_RETENTION_MS;
  if (now.getTime() < riskStartsMs || now.getTime() >= expiresMs) return null;
  const configuredMs = Date.parse(check.updatedAt);
  const detectedMs = Math.max(riskStartsMs, Number.isFinite(configuredMs) ? configuredMs : riskStartsMs);
  if (detectedMs > now.getTime()) return null;
  const detectedAt = iso(new Date(detectedMs));
  const projectName = safeLabel(project.name, "Project");
  const overdue = now.getTime() >= deadlineMs;
  return {
    contractVersion: ONE_BRIEFING_CONTRACT_VERSION,
    candidateId: candidateId("project-deadline", check.checkId, `${check.version}:${check.deadlineAt}`),
    dedupeKey: `project-deadline:${stableToken(check.checkId, String(check.version), check.deadlineAt)}`,
    kind: "risk",
    reasonCode: "project_deadline_conflict",
    severity: overdue ? 4 : 3,
    source: { kind: "project_folder", refId: project.id, label: projectName },
    detectedAt,
    expiresAt: iso(new Date(expiresMs)),
    confidence: {
      level: "high",
      basis: "The user explicitly connected this read-only deadline and expected-file condition; Desktop checked file metadata only and used no model inference.",
    },
    discovery: `${projectName} has an explicitly expected deliverable that is not present before its connected deadline.`,
    impact: overdue
      ? "The connected deadline has passed while the expected deliverable condition is still unmet."
      : "The expected deliverable condition is still unmet inside the user-selected warning window.",
    prepared: "One prepared read-only navigation to the project. No file, calendar, or external system was changed.",
    decision: {
      prompt: "Open the project and review the deadline risk?",
      acceptLabel: "Open project",
      dismissLabel: "Later",
    },
    evidence: [
      { label: "Deadline", value: check.deadlineAt, observedAt: detectedAt, freshness: "fresh" },
      { label: "Schedule source", value: "User-provided read-only deadline", observedAt: check.updatedAt, freshness: "fresh" },
      { label: "Expected condition", value: "Required file is not present", observedAt: detectedAt, freshness: "fresh" },
    ],
    preparedAction: {
      kind: "open_project",
      targetId: project.id,
      label: "Open project",
      executionStarted: false,
    },
  };
}

function automationSeverity(status: AutomationRunRecord["status"]): 1 | 2 | 3 | 4 {
  if (status === "error" || status === "blocked") return 4;
  if (status === "needs_input") return 3;
  return status === "partial" ? 2 : 1;
}

function automationCandidate(automation: Automation, run: AutomationRunRecord, now: Date): OneProactiveBriefing | null {
  if (!automation.enabled || run.status === "ok" || run.status === "skipped") return null;
  const observedAt = Number.isFinite(Date.parse(run.ranAt)) ? run.ranAt : null;
  if (!observedAt || now.getTime() - Date.parse(observedAt) > CANDIDATE_TTL_MS) return null;
  const name = safeLabel(automation.name, "Automation");
  const statusLabel: Record<Exclude<AutomationRunRecord["status"], "ok" | "skipped">, string> = {
    error: "failed",
    blocked: "was blocked before completion",
    needs_input: "is waiting for input",
    partial: "finished only part of the work",
  };
  const status = run.status as Exclude<AutomationRunRecord["status"], "ok" | "skipped">;
  const severity = automationSeverity(status);
  return {
    contractVersion: ONE_BRIEFING_CONTRACT_VERSION,
    candidateId: candidateId("automation", automation.id, run.id),
    dedupeKey: `automation-run:${stableToken(automation.id, run.id)}`,
    kind: status === "needs_input" ? "decision" : status === "partial" ? "anomaly" : "risk",
    reasonCode: `automation_${status}`,
    severity,
    source: { kind: "automation_run", refId: automation.id, label: name },
    detectedAt: observedAt,
    expiresAt: iso(new Date(Date.parse(observedAt) + CANDIDATE_TTL_MS)),
    confidence: {
      level: "high",
      basis: "The status comes from the durable scheduler run receipt; One does not infer external completion.",
    },
    discovery: `${name} ${statusLabel[status]}.`,
    impact: automation.nextRunAt
      ? "The next scheduled run may repeat the same unresolved condition."
      : "The scheduled outcome is not verified as complete.",
    prepared: "One kept the existing automation and its run receipt unchanged for review.",
    decision: {
      prompt: "Review the automation before its next run?",
      acceptLabel: "Review automation",
      dismissLabel: "Later",
    },
    evidence: [
      { label: "Automation", value: name, observedAt, freshness: freshness(observedAt, now) },
      { label: "Last run", value: status.replace("_", " "), observedAt, freshness: freshness(observedAt, now) },
      ...(automation.nextRunAt && Number.isFinite(Date.parse(automation.nextRunAt))
        ? [{ label: "Next scheduled run", value: automation.nextRunAt, observedAt, freshness: freshness(observedAt, now) } as const]
        : []),
    ],
    preparedAction: {
      kind: "open_automation",
      targetId: automation.id,
      label: "Review automation",
      executionStarted: false,
    },
  };
}

function safeCanonicalTasks(): CanonicalTask[] {
  try { return listCanonicalTasks({ limit: 200 }); } catch { return []; }
}

function safeLatestRunReceipt(chatId: string): InvocationRunReceipt | null {
  try { return getLatestInvocationRunReceipt(chatId); } catch { return null; }
}

function safeFailureEvents(chatId: string, limit = 10): FailureEventUi[] {
  try { return listFailureEvents({ chatId, limit }); } catch { return []; }
}

function safeProjectDeadlines(): MainOnlyOneProjectDeadlineCheck[] {
  try { return listOneProjectDeadlineChecksMain(); } catch { return []; }
}

function taskCandidate(
  task: CanonicalTask,
  now: Date,
  activeChatIds: Set<string>,
  latestReceipt: (chatId: string) => InvocationRunReceipt | null,
  failuresFor: (chatId: string, limit?: number) => FailureEventUi[],
): OneProactiveBriefing | null {
  if (!task.originChatId || !["waiting-decision", "running", "failed", "partial"].includes(task.status)) return null;
  const updatedMs = Date.parse(task.updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  const ageMs = now.getTime() - updatedMs;
  if (ageMs < 0 || ageMs > TASK_CANDIDATE_TTL_MS) return null;
  const activeRunPresent = activeChatIds.has(task.originChatId);
  const receipt = latestReceipt(task.originChatId);
  const failures = failuresFor(task.originChatId, 10).filter((item) => {
    const ts = Date.parse(item.ts);
    return Number.isFinite(ts) && now.getTime() - ts <= TASK_CANDIDATE_TTL_MS;
  });

  let reasonCode: OneProactiveBriefing["reasonCode"] | null = null;
  let kind: OneProactiveBriefing["kind"] = "risk";
  let severity: OneProactiveBriefing["severity"] = 3;
  let discovery = "";
  let impact = "";
  if (task.status === "waiting-decision" && ageMs >= WAITING_DECISION_THRESHOLD_MS) {
    reasonCode = "task_waiting_decision_stale";
    kind = "decision";
    discovery = "A Task has been waiting for an explicit decision for more than a day.";
    impact = "The Task cannot safely advance until its unanswered decision is reviewed.";
  } else if (task.status === "running" && ageMs >= RUNNING_STALL_THRESHOLD_MS && !activeRunPresent) {
    reasonCode = "task_running_without_active_run";
    kind = "anomaly";
    severity = 4;
    discovery = "A Task still says running, but Desktop has no active run for its canonical chat.";
    impact = "The visible state and live execution state disagree and should be reconciled before retrying.";
  } else if (task.status === "failed" && failures.length >= 2) {
    reasonCode = "task_failed_repeated";
    kind = "repetition";
    severity = 4;
    discovery = "A failed Task has multiple durable failure receipts.";
    impact = "Repeating the same Task without review may reproduce the verified failure pattern.";
  } else if (task.status === "failed" && ageMs >= ABANDONED_TASK_THRESHOLD_MS) {
    reasonCode = "task_failed_abandoned";
    discovery = "A failed Task has remained unchanged for more than three days.";
    impact = "The failed outcome is still unresolved and may be mistaken for completed work.";
  } else if (task.status === "partial" && ageMs >= ABANDONED_TASK_THRESHOLD_MS) {
    reasonCode = "task_partial_abandoned";
    kind = "anomaly";
    discovery = "A partially completed Task has remained unchanged for more than three days.";
    impact = "The remaining scope has not been verified as complete.";
  }
  if (!reasonCode) return null;

  const title = safeLabel(task.title, "Task");
  const observedAt = task.updatedAt;
  const sourceVersion = task.version;
  const dedupeKey = `canonical-task:${stableToken(task.id, String(sourceVersion), reasonCode)}`;
  return {
    contractVersion: ONE_BRIEFING_CONTRACT_VERSION,
    candidateId: candidateId("canonical-task", task.id, `${sourceVersion}:${reasonCode}`),
    dedupeKey,
    kind,
    reasonCode,
    severity,
    source: {
      kind: "canonical_task",
      refId: task.id,
      label: title,
      taskVersion: sourceVersion,
      taskStatus: task.status as "waiting-decision" | "running" | "failed" | "partial",
      originChatId: task.originChatId,
      runReceiptRef: receipt?.runId ?? null,
      runReceiptStatus: receipt?.status ?? null,
      activeRunPresent,
    },
    detectedAt: observedAt,
    expiresAt: iso(new Date(updatedMs + TASK_CANDIDATE_TTL_MS)),
    confidence: {
      level: "high",
      basis: "The finding uses only the canonical Task version, Desktop's live-run registry, and durable run/failure receipts.",
    },
    discovery: `${title}: ${discovery}`,
    impact,
    prepared: "One prepared read-only navigation to the exact Task version. Nothing was run or changed.",
    decision: {
      prompt: "Open the exact Task and review its current state?",
      acceptLabel: "Open Task",
      dismissLabel: "Later",
    },
    evidence: [
      { label: "Task status", value: task.status, observedAt, freshness: freshness(observedAt, now) },
      { label: "Task version", value: String(sourceVersion), observedAt, freshness: freshness(observedAt, now) },
      { label: "Active run", value: activeRunPresent ? "present" : "not present", observedAt: iso(now), freshness: "fresh" },
      ...(receipt ? [{ label: "Latest run receipt", value: `${receipt.runId}:${receipt.status}`, observedAt: receipt.updatedAt, freshness: freshness(receipt.updatedAt, now) } as const] : []),
      ...(failures.length > 0 ? [{ label: "Recent failure receipts", value: String(failures.length), observedAt: failures[0].ts, freshness: freshness(failures[0].ts, now) } as const] : []),
    ],
    preparedAction: { kind: "open_task", targetId: task.id, label: "Open Task", executionStarted: false },
  };
}

/**
 * Deterministic, read-only detectors. They inspect only explicit project folder
 * boundaries and durable automation receipts. No model output is trusted as a
 * finding and no raw local path or scheduler error leaves Main.
 */
export function detectOneProactiveBriefings(deps: OneBriefingDetectorDependencies = {}): OneProactiveBriefing[] {
  const now = deps.now ?? new Date();
  const projects = deps.projects ?? listProjects();
  const automations = deps.automations ?? listAutomations();
  const runHistory = deps.runHistory ?? listRunHistory;
  const pathStatus = deps.pathStatus ?? defaultPathStatus;
  const candidates: OneProactiveBriefing[] = [];

  for (const project of projects) {
    if (!project.folderPath) continue;
    const status = pathStatus(project.folderPath);
    const candidate = projectFolderCandidate(
      project,
      now,
      status,
      status === "directory" ? null : deps.projectObservationAt?.(project.id, status),
    );
    if (candidate && isOneProactiveBriefing(candidate)) candidates.push(candidate);
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const deadlineChecks = deps.projectDeadlines ?? safeProjectDeadlines();
  const deliverableStatus = deps.deliverableStatus ?? defaultDeliverableStatus;
  for (const check of deadlineChecks) {
    const project = projectsById.get(check.projectId);
    if (!project?.folderPath) continue;
    const candidate = projectDeadlineCandidate(
      check,
      project,
      now,
      deliverableStatus(project.folderPath, check.relativeDeliverablePath),
    );
    if (candidate && isOneProactiveBriefing(candidate)) candidates.push(candidate);
  }
  for (const automation of automations) {
    const latest = runHistory(automation.id, 1)[0];
    if (!latest) continue;
    const candidate = automationCandidate(automation, latest, now);
    if (candidate && isOneProactiveBriefing(candidate)) candidates.push(candidate);
  }
  const tasks = deps.tasks ?? safeCanonicalTasks();
  const activeChatIds = new Set(deps.activeChatIds ?? activeChatIdsProvider());
  const latestReceipt = deps.latestRunReceipt ?? safeLatestRunReceipt;
  const failuresFor = deps.failureEvents ?? safeFailureEvents;
  for (const task of tasks) {
    const candidate = taskCandidate(task, now, activeChatIds, latestReceipt, failuresFor);
    if (candidate && isOneProactiveBriefing(candidate)) candidates.push(candidate);
  }
  return candidates.sort((left, right) =>
    right.severity - left.severity || right.detectedAt.localeCompare(left.detectedAt) || left.candidateId.localeCompare(right.candidateId));
}

function statePath(): string {
  const explicit = process.env.AGENTLAS_ONE_BRIEFING_STATE_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  const root = process.env.AGENTLAS_STORE_PATH?.trim()
    ? path.dirname(path.resolve(process.env.AGENTLAS_STORE_PATH))
    : app.getPath("userData");
  return path.join(root, "one", "briefing-state.v1.json");
}

function defaultPreferences(now = new Date()): OneBriefingPreferences {
  return {
    cadence: "important_only",
    channels: ["in_app"],
    quietHours: { enabled: false, startHour: 22, endHour: 8 },
    updatedAt: iso(now),
  };
}

function parseState(raw: string, now = new Date()): BriefingStateV1 | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Partial<BriefingStateV1>;
    if (value.version !== STATE_VERSION || !value.preferences || !Array.isArray(value.suppressions)) return null;
    const cadence = value.preferences.cadence;
    if (!["important_only", "daily", "weekdays", "weekly"].includes(cadence)) return null;
    const channels = Array.isArray(value.preferences.channels)
      ? value.preferences.channels.filter((item): item is OneBriefingChannel => item === "in_app" || item === "desktop_notification")
      : [];
    const quiet = value.preferences.quietHours;
    if (!quiet || typeof quiet.enabled !== "boolean" || !Number.isInteger(quiet.startHour) || !Number.isInteger(quiet.endHour)) return null;
    return {
      version: STATE_VERSION,
      revision: Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 ? Number(value.revision) : 1,
      preferences: {
        cadence,
        channels: [...new Set<OneBriefingChannel>(channels.length > 0 ? channels : ["in_app"])],
        quietHours: {
          enabled: quiet.enabled,
          startHour: Math.max(0, Math.min(23, quiet.startHour)),
          endHour: Math.max(0, Math.min(23, quiet.endHour)),
        },
        updatedAt: Number.isFinite(Date.parse(value.preferences.updatedAt)) ? value.preferences.updatedAt : iso(now),
      },
      suppressions: value.suppressions.flatMap((entry) => {
        if (!entry || typeof entry.key !== "string" || !SAFE_ID_RE.test(entry.key)) return [];
        if (!Number.isFinite(Date.parse(entry.until)) || !["later", "not_important", "wrong"].includes(entry.feedback)) return [];
        return [{ key: entry.key, until: entry.until, feedback: entry.feedback }];
      }).slice(-500),
      observations: Array.isArray(value.observations)
        ? value.observations.flatMap((entry) => {
          if (!entry || typeof entry.key !== "string" || !SAFE_ID_RE.test(entry.key)) return [];
          if (!Number.isFinite(Date.parse(entry.firstSeenAt)) || !Number.isFinite(Date.parse(entry.lastSeenAt))) return [];
          return [{ key: entry.key, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt }];
        }).slice(-500)
        : [],
      notificationReceipts: Array.isArray(value.notificationReceipts)
        ? value.notificationReceipts.flatMap((entry) => {
          if (!entry || typeof entry.key !== "string" || !SAFE_ID_RE.test(entry.key)) return [];
          if (typeof entry.candidateId !== "string" || !SAFE_ID_RE.test(entry.candidateId)) return [];
          if (entry.sourceVersion !== null && (!Number.isSafeInteger(entry.sourceVersion) || entry.sourceVersion < 1)) return [];
          if (!Number.isFinite(Date.parse(entry.claimedAt)) || !Number.isFinite(Date.parse(entry.expiresAt))) return [];
          return [{ key: entry.key, candidateId: entry.candidateId, sourceVersion: entry.sourceVersion, claimedAt: entry.claimedAt, expiresAt: entry.expiresAt }];
        }).slice(-500)
        : [],
    };
  } catch {
    return null;
  }
}

function loadState(now = new Date()): BriefingStateV1 {
  try {
    const parsed = parseState(fs.readFileSync(statePath(), "utf8"), now);
    if (parsed) return parsed;
  } catch {
    // Missing or damaged state resets to the privacy-conservative in-app default.
  }
  return { version: STATE_VERSION, revision: 1, preferences: defaultPreferences(now), suppressions: [], observations: [], notificationReceipts: [] };
}

function saveState(state: BriefingStateV1): void {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function mutateStateCas(now: Date, mutate: (state: BriefingStateV1) => void): BriefingStateV1 {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  let handle: number | null = null;
  try {
    handle = fs.openSync(lock, "wx", 0o600);
    const state = loadState(now);
    const expectedRevision = state.revision;
    mutate(state);
    const current = loadState(now);
    if (current.revision !== expectedRevision) throw new Error("One Briefing state changed during update");
    state.revision = expectedRevision + 1;
    saveState(state);
    return state;
  } finally {
    if (handle !== null) try { fs.closeSync(handle); } catch { /* best effort */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ }
  }
}

function activeSuppressionKeys(state: BriefingStateV1, now: Date): Set<string> {
  return new Set(state.suppressions.filter((item) => Date.parse(item.until) > now.getTime()).map((item) => item.key));
}

function sourceSuppressionKey(candidate: OneProactiveBriefing): string {
  return `source:${stableToken(candidate.source.kind, candidate.source.refId)}`;
}

function observationKey(projectId: string, status: "missing" | "unreadable" | "not_directory"): string {
  return `observation:${stableToken("project_folder", projectId, status)}`;
}

function prepareDetectionContext(
  deps: OneBriefingDetectorDependencies,
  state: BriefingStateV1,
  now: Date,
): { deps: OneBriefingDetectorDependencies; changed: boolean } {
  const projects = deps.projects ?? listProjects();
  const basePathStatus = deps.pathStatus ?? defaultPathStatus;
  const statuses = new Map<string, ReturnType<typeof defaultPathStatus>>();
  const observations = new Map(state.observations.map((item) => [item.key, item]));
  let changed = false;
  for (const project of projects) {
    if (!project.folderPath) continue;
    const status = basePathStatus(project.folderPath);
    statuses.set(project.folderPath, status);
    if (status === "directory") continue;
    const key = observationKey(project.id, status);
    const current = observations.get(key);
    if (!current) {
      observations.set(key, { key, firstSeenAt: iso(now), lastSeenAt: iso(now) });
      changed = true;
    } else if (now.getTime() - Date.parse(current.lastSeenAt) >= 60 * 60 * 1_000) {
      observations.set(key, { ...current, lastSeenAt: iso(now) });
      changed = true;
    }
  }
  const retentionCutoff = now.getTime() - 120 * DAY_MS;
  const retained = [...observations.values()].filter((item) => Date.parse(item.lastSeenAt) >= retentionCutoff).slice(-500);
  if (retained.length !== state.observations.length) changed = true;
  state.observations = retained;
  return {
    changed,
    deps: {
      ...deps,
      now,
      projects,
      pathStatus: (folderPath) => statuses.get(folderPath) ?? basePathStatus(folderPath),
      projectObservationAt: (projectId, status) =>
        observations.get(observationKey(projectId, status))?.firstSeenAt ?? null,
    },
  };
}

function cadenceAllows(candidate: OneProactiveBriefing, preferences: OneBriefingPreferences, now: Date): boolean {
  if (preferences.cadence === "weekdays") {
    const day = now.getDay();
    return day !== 0 && day !== 6;
  }
  if (preferences.cadence === "weekly") return now.getDay() === 1;
  if (preferences.cadence === "important_only") return candidate.severity >= 3;
  return true;
}

function eligibleCandidates(
  deps: OneBriefingDetectorDependencies,
  state: BriefingStateV1,
  now: Date,
): { candidates: OneProactiveBriefing[]; changed: boolean } {
  const preparedContext = prepareDetectionContext(deps, state, now);
  const suppressed = activeSuppressionKeys(state, now);
  return {
    changed: preparedContext.changed,
    candidates: detectOneProactiveBriefings(preparedContext.deps).filter((candidate) =>
      cadenceAllows(candidate, state.preferences, now)
      && !suppressed.has(candidate.dedupeKey)
      && !suppressed.has(sourceSuppressionKey(candidate))),
  };
}

/**
 * Main-only exact binding lookup used immediately before a Briefing review
 * packet or run is accepted. Suppressed, resolved, expired, or changed
 * findings deliberately collapse to null.
 */
export function findCurrentOneBriefingCandidate(input: {
  candidateId: string;
  expectedDetectedAt: string;
}, deps: OneBriefingDetectorDependencies = {}): OneProactiveBriefing | null {
  if (!SAFE_ID_RE.test(input.candidateId) || !Number.isFinite(Date.parse(input.expectedDetectedAt))) {
    throw new TypeError("Invalid One Briefing candidate binding");
  }
  const now = deps.now ?? new Date();
  const state = loadState(now);
  const eligible = eligibleCandidates(deps, state, now);
  if (eligible.changed) saveState(state);
  const candidate = eligible.candidates.find((item) =>
    item.candidateId === input.candidateId && item.detectedAt === input.expectedDetectedAt) ?? null;
  if (!candidate || Date.parse(candidate.expiresAt) <= now.getTime()) return null;
  return candidate;
}

export function getOneBriefingSnapshot(deps: OneBriefingDetectorDependencies = {}): OneBriefingSnapshot {
  const now = deps.now ?? new Date();
  const state = loadState(now);
  const eligible = eligibleCandidates(deps, state, now);
  if (eligible.changed) saveState(state);
  const candidate = eligible.candidates[0] ?? null;
  if (candidate) {
    const eventSuffix = stableToken(candidate.candidateId);
    tryRecordOneDomainEvent({
      eventId: `event:briefing-detected:${eventSuffix}`,
      eventType: "briefing.detected",
      occurredAt: candidate.detectedAt,
      actor: "system",
      entityId: candidate.candidateId,
      version: 1,
      visibility: "personal",
      entries: [
        { name: "category", value: candidate.kind },
        { name: "sourceRefs", value: [`${candidate.source.kind}:${candidate.source.refId}`] },
        { name: "confidence", value: candidate.confidence.level },
        { name: "expiry", value: candidate.expiresAt },
      ],
    });
    tryRecordOneDomainEvent({
      eventId: `event:briefing-published:${eventSuffix}`,
      eventType: "briefing.published",
      occurredAt: iso(now),
      actor: "one",
      entityId: candidate.candidateId,
      version: 1,
      visibility: "personal",
      entries: [
        { name: "briefingId", value: candidate.candidateId },
        { name: "priority", value: candidate.severity },
        { name: "preparedActionRef", value: `${candidate.preparedAction.kind}:${candidate.preparedAction.targetId}` },
      ],
    });
  }
  return {
    contractVersion: ONE_BRIEFING_CONTRACT_VERSION,
    evaluatedAt: iso(now),
    candidate,
    preferences: state.preferences,
  };
}

function quietHoursActive(preferences: OneBriefingPreferences, now: Date): boolean {
  const quiet = preferences.quietHours;
  if (!quiet.enabled) return false;
  if (quiet.startHour === quiet.endHour) return true;
  const hour = now.getHours();
  return quiet.startHour < quiet.endHour
    ? hour >= quiet.startHour && hour < quiet.endHour
    : hour >= quiet.startHour || hour < quiet.endHour;
}

/**
 * Atomically claims one generic Desktop notification. The candidate is
 * re-derived while holding the state lock; a persisted receipt prevents
 * duplicate delivery after restart or concurrent scheduler ticks.
 */
export function claimOneBriefingDesktopNotification(
  deps: OneBriefingDetectorDependencies = {},
): OneProactiveBriefing | null {
  const now = deps.now ?? new Date();
  let claimed: OneProactiveBriefing | null = null;
  try {
    mutateStateCas(now, (state) => {
      state.notificationReceipts = state.notificationReceipts
        .filter((item) => Date.parse(item.expiresAt) > now.getTime())
        .slice(-500);
      if (!state.preferences.channels.includes("desktop_notification") || quietHoursActive(state.preferences, now)) return;
      const eligible = eligibleCandidates(deps, state, now);
      const candidate = eligible.candidates.find((item) => item.severity >= 3) ?? null;
      if (!candidate || Date.parse(candidate.expiresAt) <= now.getTime()) return;
      const key = `notification:${stableToken(candidate.dedupeKey)}`;
      if (state.notificationReceipts.some((item) => item.key === key)) return;
      const sourceVersion = candidate.source.kind === "canonical_task" ? candidate.source.taskVersion : null;
      state.notificationReceipts.push({
        key,
        candidateId: candidate.candidateId,
        sourceVersion,
        claimedAt: iso(now),
        expiresAt: candidate.expiresAt,
      });
      claimed = candidate;
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code !== "EEXIST") throw error;
  }
  return claimed;
}

export function resolveOneBriefingTaskNavigation(
  input: OpenOneBriefingTaskInput,
  deps: OneBriefingDetectorDependencies = {},
): OpenOneBriefingTaskResult {
  if (!SAFE_ID_RE.test(input.expectedTaskId) || !Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1) {
    throw new TypeError("Invalid One Briefing Task binding");
  }
  const candidate = findCurrentOneBriefingCandidate(input, deps);
  if (
    !candidate
    || candidate.source.kind !== "canonical_task"
    || candidate.preparedAction.kind !== "open_task"
    || candidate.source.refId !== input.expectedTaskId
    || candidate.source.taskVersion !== input.expectedTaskVersion
  ) {
    throw new Error("One Briefing Task changed; refresh before opening it");
  }
  return { taskId: candidate.source.refId, taskVersion: candidate.source.taskVersion };
}

export function setOneBriefingPreferences(input: {
  cadence?: OneBriefingCadence;
  channels?: OneBriefingChannel[];
  quietHours?: { enabled: boolean; startHour: number; endHour: number };
}, now = new Date()): OneBriefingPreferences {
  const state = loadState(now);
  const cadence = input.cadence ?? state.preferences.cadence;
  if (!["important_only", "daily", "weekdays", "weekly"].includes(cadence)) throw new TypeError("Invalid One Briefing cadence");
  const channels = input.channels ?? state.preferences.channels;
  if (!Array.isArray(channels) || channels.length < 1 || !channels.includes("in_app") || channels.some((item) => !["in_app", "desktop_notification"].includes(item))) {
    throw new TypeError("Invalid One Briefing channel selection");
  }
  const quiet = input.quietHours ?? state.preferences.quietHours;
  if (!Number.isInteger(quiet.startHour) || !Number.isInteger(quiet.endHour) || quiet.startHour < 0 || quiet.startHour > 23 || quiet.endHour < 0 || quiet.endHour > 23) {
    throw new TypeError("Invalid One Briefing quiet hours");
  }
  const updated = mutateStateCas(now, (current) => {
    current.preferences = {
      cadence,
      channels: [...new Set(channels)],
      quietHours: { enabled: quiet.enabled === true, startHour: quiet.startHour, endHour: quiet.endHour },
      updatedAt: iso(now),
    };
  });
  return updated.preferences;
}

export function recordOneBriefingFeedback(input: {
  candidateId: string;
  expectedDetectedAt: string;
  feedback: OneBriefingFeedback;
}, deps: OneBriefingDetectorDependencies = {}): OneBriefingSnapshot {
  if (!SAFE_ID_RE.test(input.candidateId) || !Number.isFinite(Date.parse(input.expectedDetectedAt))) {
    throw new TypeError("Invalid One Briefing feedback binding");
  }
  if (!["later", "not_important", "wrong"].includes(input.feedback)) throw new TypeError("Invalid One Briefing feedback");
  const now = deps.now ?? new Date();
  const state = loadState(now);
  const preparedContext = prepareDetectionContext(deps, state, now);
  const current = detectOneProactiveBriefings(preparedContext.deps).find((candidate) =>
    candidate.candidateId === input.candidateId && candidate.detectedAt === input.expectedDetectedAt);
  if (!current) throw new Error("One Briefing candidate changed; refresh before applying feedback");
  const duration = input.feedback === "later" ? DAY_MS : input.feedback === "not_important" ? 30 * DAY_MS : 90 * DAY_MS;
  const key = input.feedback === "later" ? current.dedupeKey : sourceSuppressionKey(current);
  state.suppressions = [
    ...state.suppressions.filter((entry) => entry.key !== key && Date.parse(entry.until) > now.getTime()),
    { key, until: iso(new Date(now.getTime() + duration)), feedback: input.feedback },
  ].slice(-500);
  saveState(state);
  tryRecordOneDomainEvent({
    eventId: `event:briefing-dismissed:${stableToken(current.candidateId, input.feedback, iso(now))}`,
    eventType: "briefing.dismissed",
    occurredAt: iso(now),
    actor: "user",
    entityId: current.candidateId,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "reasonCategory", value: input.feedback },
      { name: "suppressionScope", value: input.feedback === "later" ? "finding" : "source" },
    ],
  });
  return getOneBriefingSnapshot({ ...deps, now });
}
