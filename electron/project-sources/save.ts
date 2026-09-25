import type {
  FsPathGrant,
  Project,
  ProjectAgentPoolMember,
  ProjectSourceType,
} from "../../shared/types";
import { pathFromGrant } from "../fs/access";
import type { ProjectAgentLimitGrant } from "../billing";
import {
  createProject,
  getProject,
  isProjectSourceType,
  updateProject,
} from "../store/projects";

export interface ExplicitProjectCreateInput {
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  agentPool?: ProjectAgentPoolMember[];
  sourceType: ProjectSourceType;
  sourceRef?: string | null;
  folderGrant?: FsPathGrant | null;
}

export type ExplicitProjectUpdatePatch =
  Partial<Pick<Project, "name" | "description" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef">>
  & { folderGrant?: FsPathGrant | null };

interface ExplicitProjectSaveOptions {
  /** Private verification seam; never populated from renderer IPC. */
  managedProjectsRoot?: string;
  projectAgentGrant?: ProjectAgentLimitGrant;
}

function owns(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertedSourceType(value: unknown): ProjectSourceType {
  if (!isProjectSourceType(value)) throw new TypeError("Unknown project source type.");
  return value;
}

function validatedAgentPool(value: unknown): ProjectAgentPoolMember[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("Project agentPool must be an array.");
  return value as ProjectAgentPoolMember[];
}

function folderPathFromExplicitGrant(sourceType: ProjectSourceType, grant: unknown): string | null {
  if (sourceType === "empty" || sourceType === "sample") {
    if (grant !== undefined && grant !== null) {
      throw new TypeError(`${sourceType} projects do not accept a folder grant.`);
    }
    return null;
  }
  if (grant === undefined || grant === null) {
    throw new TypeError(`${sourceType} projects require a folder grant.`);
  }
  return pathFromGrant(grant as FsPathGrant, "directory");
}

/** Main-only explicit create/save boundary used by projects:create. */
export function createProjectFromExplicitSave(
  rawInput: unknown,
  options: ExplicitProjectSaveOptions = {},
): Project {
  assertRecord(rawInput, "Project create input");
  const sourceType = assertedSourceType(rawInput.sourceType);
  const folderPath = folderPathFromExplicitGrant(sourceType, rawInput.folderGrant);
  const agentPool = validatedAgentPool(rawInput.agentPool);
  return createProject({
    name: typeof rawInput.name === "string" ? rawInput.name : "",
    description: typeof rawInput.description === "string" ? rawInput.description : null,
    systemPrompt: typeof rawInput.systemPrompt === "string" ? rawInput.systemPrompt : null,
    agentPool,
    sourceType,
    sourceRef: typeof rawInput.sourceRef === "string" ? rawInput.sourceRef : null,
    folderPath,
  }, { managedProjectsRoot: options.managedProjectsRoot, projectAgentGrant: options.projectAgentGrant });
}

/** Main-only explicit create/save boundary used by projects:update. */
export function updateProjectFromExplicitSave(
  id: string,
  rawPatch: unknown,
  options: ExplicitProjectSaveOptions = {},
): Project {
  assertRecord(rawPatch, "Project update patch");
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);

  const sourceType = owns(rawPatch, "sourceType")
    ? assertedSourceType(rawPatch.sourceType)
    : existing.sourceType;
  const sourceChanged = sourceType !== existing.sourceType;
  const hasFolderGrant = owns(rawPatch, "folderGrant");
  let folderPath: string | null | undefined;
  if (sourceChanged && (sourceType === "local" || sourceType === "github")) {
    folderPath = folderPathFromExplicitGrant(sourceType, rawPatch.folderGrant);
  } else if (hasFolderGrant) {
    folderPath = rawPatch.folderGrant === undefined
      ? undefined
      : folderPathFromExplicitGrant(sourceType, rawPatch.folderGrant);
  } else if (sourceChanged && (sourceType === "empty" || sourceType === "sample")) {
    folderPath = null;
  }

  const patch: Partial<Pick<Project, "name" | "description" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef" | "folderPath">> = {};
  if (owns(rawPatch, "name")) patch.name = typeof rawPatch.name === "string" ? rawPatch.name : existing.name;
  if (owns(rawPatch, "description")) {
    patch.description = typeof rawPatch.description === "string" ? rawPatch.description : null;
  }
  if (owns(rawPatch, "systemPrompt")) {
    patch.systemPrompt = typeof rawPatch.systemPrompt === "string" ? rawPatch.systemPrompt : null;
  }
  if (owns(rawPatch, "agentPool")) patch.agentPool = validatedAgentPool(rawPatch.agentPool);
  if (owns(rawPatch, "sourceType")) patch.sourceType = sourceType;
  if (owns(rawPatch, "sourceRef")) {
    patch.sourceRef = typeof rawPatch.sourceRef === "string" ? rawPatch.sourceRef : null;
  } else if (sourceChanged) {
    patch.sourceRef = null;
  }
  if (folderPath !== undefined) patch.folderPath = folderPath;

  return updateProject(id, patch, {
    managedProjectsRoot: options.managedProjectsRoot,
    allocateManagedEmptyFolder: owns(rawPatch, "sourceType") && sourceType === "empty",
    projectAgentGrant: options.projectAgentGrant,
  });
}
