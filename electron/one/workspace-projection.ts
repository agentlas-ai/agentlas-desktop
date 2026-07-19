import { app } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CanonicalTask,
  InvocationRunReceipt,
  Project,
  RunEventUi,
} from "../../shared/types";
import type { OneSurfaceManifestV1 } from "../../shared/one-surface";
import { isDurableOneSurfaceManifestV1 } from "../../shared/one-surface-durable";
import type { OneProfile } from "../../shared/one-profile";
import type { OneMemoryState } from "../../shared/one-memory";
import type { OneExperienceReuseState } from "../../shared/one-experience-reuse";
import type { OneImprovementProofState } from "../../shared/one-improvement-proof";
import type { OneDomainEventV1 } from "../../shared/one-domain-events";
import type { OntologyProjectStatus } from "../../shared/types";
import { getProject } from "../store/projects";
import { getOneProfile } from "../store/one-profile";
import { getInvocationRunReceipt, listRunEvents } from "../store/run-events";
import { getOneMemoryState } from "./memory-candidates";
import { getOneExperienceReuseState } from "./experience-reuse";
import { getOneImprovementProofState } from "./improvement-proof";
import { listOneDomainEvents } from "./domain-events";
import { getProjectOntologyStatus } from "../ontology/project-runtime";

export const ONE_WORKSPACE_CONTRACT_VERSION = "1.0.0" as const;

export type OneWorkspaceRunPhase =
  | "running"
  | "surface_ready"
  | "completed"
  | "cancelled"
  | "failed";

export interface ProjectOneWorkspaceInput {
  task: CanonicalTask;
  runId: string;
  chatId: string;
  phase: OneWorkspaceRunPhase;
  surface?: OneSurfaceManifestV1;
}

interface OneWorkspaceSnapshot {
  generatedAt: string;
  task: CanonicalTask;
  runId: string;
  chatId: string;
  phase: OneWorkspaceRunPhase;
  project: Project | null;
  receipt: InvocationRunReceipt | null;
  events: RunEventUi[];
  domainEvents: OneDomainEventV1[];
  surface: OneSurfaceManifestV1 | null;
  profile: OneProfile;
  memory: OneMemoryState;
  experienceReuse: OneExperienceReuseState;
  improvementProof: OneImprovementProofState;
  ontology: OntologyProjectStatus | null;
}

interface ProjectionRoot {
  root: string;
  scope: "account" | "project";
  projectRef: string;
}

const SAFE_PATH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

const README = `# Agentlas One local workspace

This folder is an organized, human-readable view of One's local work.

## Where things are

- \`projects/\`: work grouped by project, then by task
- \`projects/<project>/tasks/<task>/outputs/\`: finished result and file references
- \`projects/<project>/tasks/<task>/logs/\`: a safe activity timeline
- \`projects/<project>/ontology/\`: project knowledge status
- \`profile/\`: how One is configured for you
- \`memory/\`: approved memories and suggestions waiting for approval
- \`learning/\`: reused approaches and measured improvements

Each project and task has a \`SUMMARY.md\` that points to the useful files.

## Safety

- Agentlas SQLite remains the authority for execution, approvals, and recovery.
- Raw chat transcripts, credentials, temporary attachment paths, and executable permissions are deliberately excluded.
- These files are replaced atomically and may be rebuilt by Agentlas One.
`;

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePathId(value: string, label: string): string {
  const normalized = value.replaceAll(":", "_");
  if (!SAFE_PATH_ID_RE.test(normalized)) throw new TypeError(`${label} is not safe for One workspace storage`);
  return normalized;
}

function realDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  return fs.realpathSync.native(resolved);
}

function ensureChildDirectory(parent: string, name: string): string {
  if (
    name === "."
    || name === ".."
    || !/^[A-Za-z0-9.][A-Za-z0-9._-]{0,191}$/.test(name)
  ) throw new TypeError("One workspace directory name is invalid");
  const canonicalParent = realDirectory(parent, "One workspace parent");
  const candidate = path.join(canonicalParent, name);
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("One workspace contains an unsafe directory entry");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(candidate, { mode: 0o700 });
  }
  const canonical = realDirectory(candidate, "One workspace directory");
  if (!inside(canonicalParent, canonical)) throw new Error("One workspace directory escaped its parent");
  if (process.platform !== "win32") fs.chmodSync(canonical, 0o700);
  return canonical;
}

function ensureNestedDirectory(root: string, parts: readonly string[]): string {
  let current = realDirectory(root, "One workspace root");
  for (const part of parts) current = ensureChildDirectory(current, safePathId(part, "One workspace path"));
  return current;
}

function globalOneRoot(): string {
  const override = process.env.AGENTLAS_ONE_WORKSPACE_ROOT?.trim();
  if (override) {
    const resolved = path.resolve(override);
    const parent = realDirectory(path.dirname(resolved), "One workspace override parent");
    return ensureChildDirectory(parent, path.basename(resolved));
  }
  const home = realDirectory(app.getPath("home"), "User home");
  const agentlas = ensureChildDirectory(home, ".agentlas");
  return ensureChildDirectory(agentlas, "one");
}

function projectOneRoot(project: Project | null): string | null {
  if (!project?.folderPath) return null;
  try {
    const projectRoot = realDirectory(project.folderPath, "Project workspace");
    const agentlas = ensureChildDirectory(projectRoot, ".agentlas");
    return ensureChildDirectory(agentlas, "one");
  } catch {
    return null;
  }
}

function assertWritableTarget(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("One workspace target is not a regular file");
}

function atomicWrite(target: string, text: string): void {
  const parent = realDirectory(path.dirname(target), "One workspace file parent");
  if (!inside(parent, path.resolve(target))) throw new Error("One workspace file escaped its parent");
  assertWritableTarget(target);
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) throw error;
      assertWritableTarget(target);
      fs.rmSync(target, { force: true });
      fs.renameSync(temp, target);
    }
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

function writeJson(directory: string, name: string, value: unknown): void {
  atomicWrite(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writeReadme(root: string): void {
  const target = path.join(root, "README.md");
  atomicWrite(target, README);
}

function markdownLine(value: string | null | undefined, fallback: string): string {
  const text = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() ?? "";
  return text || fallback;
}

function publicReceipt(receipt: InvocationRunReceipt | null): Record<string, unknown> | null {
  if (!receipt) return null;
  return {
    runId: receipt.runId,
    status: receipt.status,
    startedAt: receipt.startedAt,
    updatedAt: receipt.updatedAt,
    ...(receipt.finishedAt ? { finishedAt: receipt.finishedAt } : {}),
    eventCount: receipt.eventCount,
    ...(receipt.hasImages !== undefined ? { hasImages: receipt.hasImages } : {}),
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
  };
}

function publicRunEvents(events: readonly RunEventUi[]): Array<Record<string, unknown>> {
  return events.slice(-500).map((event) => ({
    eventId: event.id,
    sequence: event.seq,
    occurredAt: event.ts,
    kind: event.kind,
    ...(event.agentId ? { agentId: event.agentId } : {}),
  }));
}

function publicOntology(status: OntologyProjectStatus | null): Record<string, unknown> | null {
  if (!status) return null;
  return {
    projectId: status.projectId,
    projectName: status.projectName,
    state: status.state,
    policy: status.policy,
    counts: status.counts,
    warnings: status.warnings,
    error: status.error,
    sources: status.sources.map((source) => ({
      scope: source.scope,
      kind: source.kind,
      exists: source.exists,
      ...(source.registeredAt ? { registeredAt: source.registeredAt } : {}),
    })),
  };
}

function memoryForRoot(snapshot: OneWorkspaceSnapshot, scope: ProjectionRoot["scope"]): OneMemoryState {
  if (scope === "account" || !snapshot.project) return snapshot.memory;
  const projectId = snapshot.project.id;
  return {
    ...snapshot.memory,
    candidates: snapshot.memory.candidates.filter((item) => item.scope === "project" && item.scopeRef === projectId),
    memories: snapshot.memory.memories.filter((item) => item.scope === "project" && item.scopeRef === projectId),
    suppressions: snapshot.memory.suppressions.filter((item) => item.scope === "project" && item.scopeRef === projectId),
  };
}

function profileForRoot(snapshot: OneWorkspaceSnapshot, scope: ProjectionRoot["scope"]): OneProfile | Record<string, unknown> {
  if (scope === "account" || !snapshot.project) return snapshot.profile;
  return {
    contractVersion: snapshot.profile.contractVersion,
    oneId: snapshot.profile.oneId,
    version: snapshot.profile.version,
    displayName: snapshot.profile.displayName,
    role: snapshot.profile.role,
    timeZone: snapshot.profile.timeZone,
    operatingPrinciples: snapshot.profile.operatingPrinciples.filter(
      (item) => item.scope === "project" && item.scopeRef === snapshot.project?.id,
    ),
    createdAt: snapshot.profile.createdAt,
    updatedAt: snapshot.profile.updatedAt,
  };
}

function learningForProject<T extends { receipts?: unknown[]; proofs?: unknown[] }>(
  value: T,
  taskId: string,
): T {
  if (Array.isArray(value.receipts)) {
    return { ...value, receipts: value.receipts.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const receipt = (item as { receipt?: { taskId?: unknown } }).receipt;
      return receipt?.taskId === taskId;
    }) };
  }
  if (Array.isArray(value.proofs)) {
    return { ...value, proofs: value.proofs.filter((item) => {
      if (!item || typeof item !== "object") return false;
      return (item as { proof?: { taskId?: unknown } }).proof?.taskId === taskId;
    }) };
  }
  return value;
}

function writeProjectionRoot(rootInfo: ProjectionRoot, snapshot: OneWorkspaceSnapshot): void {
  const { root, scope, projectRef } = rootInfo;
  writeReadme(root);
  const projectDir = ensureNestedDirectory(root, ["projects", projectRef]);
  const taskDir = ensureNestedDirectory(projectDir, ["tasks", safePathId(snapshot.task.id, "Task id")]);
  const runDir = ensureNestedDirectory(taskDir, ["runs", safePathId(snapshot.runId, "Run id")]);
  const outputsDir = ensureNestedDirectory(taskDir, ["outputs"]);
  const logsDir = ensureNestedDirectory(taskDir, ["logs"]);
  const profileDir = ensureNestedDirectory(root, ["profile"]);
  const memoryDir = ensureNestedDirectory(root, ["memory"]);
  const learningDir = ensureNestedDirectory(root, ["learning"]);
  const ontologyDir = ensureNestedDirectory(projectDir, ["ontology"]);

  writeJson(root, "manifest.json", {
    contractVersion: ONE_WORKSPACE_CONTRACT_VERSION,
    authority: "agentlas-sqlite-local",
    projectionOnly: true,
    scope,
    generatedAt: snapshot.generatedAt,
    oneId: snapshot.profile.oneId,
    profileVersion: snapshot.profile.version,
    lastTaskId: snapshot.task.id,
    lastRunId: snapshot.runId,
  });
  writeJson(profileDir, "profile.json", profileForRoot(snapshot, scope));

  const memory = memoryForRoot(snapshot, scope);
  writeJson(memoryDir, "approved.json", {
    contractVersion: memory.contractVersion,
    storeVersion: memory.version,
    memories: memory.memories,
    updatedAt: memory.updatedAt,
  });
  writeJson(memoryDir, "candidates.json", {
    contractVersion: memory.contractVersion,
    storeVersion: memory.version,
    candidates: memory.candidates,
    suppressions: memory.suppressions,
    updatedAt: memory.updatedAt,
  });

  writeJson(projectDir, "project.json", {
    projectRef,
    projectId: snapshot.project?.id ?? null,
    name: snapshot.project?.name ?? "Personal",
    description: snapshot.project?.description ?? null,
    createdAt: snapshot.project?.createdAt ?? snapshot.task.createdAt,
    updatedAt: snapshot.project?.updatedAt ?? snapshot.task.updatedAt,
  });
  atomicWrite(path.join(projectDir, "SUMMARY.md"), `# ${markdownLine(snapshot.project?.name, "Personal")}

- Updated: ${snapshot.project?.updatedAt ?? snapshot.task.updatedAt}
- Latest task: ${markdownLine(snapshot.task.title, "Untitled work")}

## Open this project

- [Latest task](tasks/${safePathId(snapshot.task.id, "Task id")}/SUMMARY.md)
- [Project knowledge](ontology/status.json)

Tasks stay in separate folders so their results, team, history, and runs do not mix.
`);
  writeJson(taskDir, "task.json", {
    contractVersion: ONE_WORKSPACE_CONTRACT_VERSION,
    taskId: snapshot.task.id,
    version: snapshot.task.version,
    title: snapshot.task.title,
    status: snapshot.task.status,
    projectId: snapshot.task.projectId,
    firmId: snapshot.task.firmId,
    createdAt: snapshot.task.createdAt,
    updatedAt: snapshot.task.updatedAt,
    archivedAt: snapshot.task.archivedAt,
    latestRunId: snapshot.runId,
    latestRunPhase: snapshot.phase,
  });
  atomicWrite(path.join(taskDir, "SUMMARY.md"), `# ${markdownLine(snapshot.task.title, "Untitled work")}

- Status: ${snapshot.task.status}
- Updated: ${snapshot.task.updatedAt}
- Latest run: ${snapshot.phase}

## Open this work

- [Result and files](outputs/index.json)
- [Team](team.json)
- [Activity history](logs/timeline.json)
- [Latest run record](runs/${safePathId(snapshot.runId, "Run id")}/run.json)

Agentlas keeps execution and approvals in its local database. This folder is a safe view for you and your tools.
`);
  writeJson(taskDir, "team.json", {
    taskId: snapshot.task.id,
    participants: snapshot.task.participants,
    updatedAt: snapshot.task.updatedAt,
  });
  writeJson(runDir, "run.json", {
    contractVersion: ONE_WORKSPACE_CONTRACT_VERSION,
    runId: snapshot.runId,
    taskId: snapshot.task.id,
    phase: snapshot.phase,
    generatedAt: snapshot.generatedAt,
    receipt: publicReceipt(snapshot.receipt),
    events: publicRunEvents(snapshot.events),
  });
  writeJson(logsDir, "timeline.json", {
    contractVersion: ONE_WORKSPACE_CONTRACT_VERSION,
    taskId: snapshot.task.id,
    events: snapshot.domainEvents,
    updatedAt: snapshot.task.updatedAt,
  });

  if (snapshot.surface) {
    writeJson(runDir, "surface.json", snapshot.surface);
    writeJson(outputsDir, "index.json", {
      contractVersion: snapshot.surface.contractVersion,
      taskId: snapshot.task.id,
      runId: snapshot.runId,
      manifestId: snapshot.surface.manifestId,
      layout: snapshot.surface.layoutProfile,
      state: snapshot.surface.surfaceState,
      artifacts: snapshot.surface.fallback.artifacts,
      generatedAt: snapshot.generatedAt,
    });
  }

  writeJson(learningDir, "experience-reuse.json", scope === "account"
    ? snapshot.experienceReuse
    : learningForProject(snapshot.experienceReuse, snapshot.task.id));
  writeJson(learningDir, "improvements.json", scope === "account"
    ? snapshot.improvementProof
    : learningForProject(snapshot.improvementProof, snapshot.task.id));
  writeJson(ontologyDir, "status.json", publicOntology(snapshot.ontology));
}

function rootsFor(snapshot: OneWorkspaceSnapshot): ProjectionRoot[] {
  const accountRoot = globalOneRoot();
  const projectRef = snapshot.project
    ? `project-${safePathId(snapshot.project.id, "Project id")}`
    : "personal";
  const roots: ProjectionRoot[] = [{ root: accountRoot, scope: "account", projectRef }];
  const local = projectOneRoot(snapshot.project);
  if (local && local !== accountRoot) roots.push({ root: local, scope: "project", projectRef: "current" });
  return roots;
}

function snapshotFor(input: ProjectOneWorkspaceInput): OneWorkspaceSnapshot {
  if (
    !SAFE_PATH_ID_RE.test(input.task.id.replaceAll(":", "_"))
    || !SAFE_PATH_ID_RE.test(input.runId.replaceAll(":", "_"))
    || input.chatId.trim().length < 1
    || input.chatId.length > 256
  ) throw new TypeError("One workspace projection bindings are invalid");
  if (
    input.surface
    && (
      input.surface.taskId !== input.task.id
      || !isDurableOneSurfaceManifestV1(input.surface, input.task.id)
    )
  ) throw new TypeError("One workspace surface failed its durable contract");
  const project = input.task.projectId ? getProject(input.task.projectId) : null;
  const domainEvents = [
    ...listOneDomainEvents(input.task.id, 500),
    ...listOneDomainEvents(input.runId, 500),
  ]
    .filter((event, index, values) => values.findIndex((item) => item.eventId === event.eventId) === index)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  return {
    generatedAt: new Date().toISOString(),
    task: input.task,
    runId: input.runId,
    chatId: input.chatId,
    phase: input.phase,
    project,
    receipt: getInvocationRunReceipt(input.runId),
    events: listRunEvents(input.runId, 500),
    domainEvents,
    surface: input.surface ?? null,
    profile: getOneProfile(),
    memory: getOneMemoryState(),
    experienceReuse: getOneExperienceReuseState(),
    improvementProof: getOneImprovementProofState(),
    ontology: input.task.projectId ? getProjectOntologyStatus(input.task.projectId) : null,
  };
}

/**
 * Materialize a private, human-readable One workspace without changing the
 * execution authority. Any filesystem or projection failure is isolated from
 * the invocation that produced it.
 */
export function projectOneWorkspace(input: ProjectOneWorkspaceInput): void {
  const snapshot = snapshotFor(input);
  for (const root of rootsFor(snapshot)) writeProjectionRoot(root, snapshot);
}

export function tryProjectOneWorkspace(input: ProjectOneWorkspaceInput): boolean {
  try {
    projectOneWorkspace(input);
    return true;
  } catch {
    return false;
  }
}
