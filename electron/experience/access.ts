import type {
  ExperiencePackCreateInput,
  ExperiencePackCreateIpcInput,
  RuntimeKind,
} from "../../shared/types";
import { FsAccessDeniedError, pathFromGrant } from "../fs/access";

const CREATE_KEYS = new Set([
  "agentId",
  "name",
  "description",
  "projectId",
  "projectGrant",
  "mcpRequirements",
]);

/** Main-owned IPC resolver: renderer paths and renderer environment labels are never trusted. */
export function resolveExperiencePackCreateIpcInput(
  value: unknown,
  environment: { platform: NodeJS.Platform; arch: string; runtimeKind: RuntimeKind },
): ExperiencePackCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FsAccessDeniedError("Experience Pack creation requires a filesystem capability.");
  }
  const input = value as ExperiencePackCreateIpcInput & Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !CREATE_KEYS.has(key));
  if (extra.length > 0) {
    throw new FsAccessDeniedError("Experience Pack creation rejects raw paths and unsupported fields.");
  }
  const projectPath = pathFromGrant(input.projectGrant, "directory");
  const { projectGrant: _projectGrant, ...metadata } = input;
  return {
    ...metadata,
    projectPath,
    environment,
  } as ExperiencePackCreateInput;
}
