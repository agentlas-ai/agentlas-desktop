import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { userDataPath } from "../runtime-paths";

export const WORKSPACE_PREVIEW_CONTROL_ENV = "AGENTLAS_WORKSPACE_PREVIEW_CONTROL_FILE";

/** Main-minted owner evidence for a preview subprocess.  This is deliberately
 * separate from the worker's ordinary read/write permission: a full owner turn
 * may authorize one project preview while the worker remains write-scoped. */
export interface WorkspacePreviewOwnerGrant {
  schemaVersion: "agentlas.workspace-preview-owner-grant.v1";
  grantId: string;
  taskScopeId: string;
  chatId: string;
  runId: string;
  canonicalCwd: string;
  ownerExecutionPermission: "full";
}

export interface WorkspacePreviewCapabilityBinding {
  capabilityId: string;
  taskScopeId: string;
  chatId: string | null;
  runId: string | null;
  cwd: string;
  permission: "read" | "write" | "full";
  ownerGrantId: string | null;
  ownerExecutionPermission: "full" | null;
}

export interface WorkspacePreviewControlInfo {
  schemaVersion: 1;
  port: number;
  token: string;
  capabilityId: string;
}

function safeKey(value: string): string {
  const key = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96);
  return key || randomUUID();
}

export function workspacePreviewControlDirectory(): string {
  return userDataPath("workspace-preview");
}

export function workspacePreviewCapabilityPath(configKey: string, capabilityId?: string): string {
  return path.join(workspacePreviewControlDirectory(), `capability-${safeKey(configKey)}-${safeKey(capabilityId ?? randomUUID())}.json`);
}

export function writeWorkspacePreviewCapability(
  configKey: string,
  info: WorkspacePreviewControlInfo,
): string {
  const directory = workspacePreviewControlDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const target = workspacePreviewCapabilityPath(configKey, info.capabilityId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(info), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  return target;
}

export function removeWorkspacePreviewCapability(configKey: string, capabilityId?: string): void {
  try {
    if (capabilityId) {
      fs.rmSync(workspacePreviewCapabilityPath(configKey, capabilityId), { force: true });
      return;
    }
    const prefix = `capability-${safeKey(configKey)}-`;
    for (const entry of fs.readdirSync(workspacePreviewControlDirectory())) {
      if (entry.startsWith(prefix) && entry.endsWith(".json")) fs.rmSync(path.join(workspacePreviewControlDirectory(), entry), { force: true });
    }
  } catch { /* best effort */ }
}
