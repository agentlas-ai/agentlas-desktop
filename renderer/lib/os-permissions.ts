import type { SystemPermissionBridge, SystemPermissionSnapshot } from "@shared/os-permissions";

declare global {
  interface Window {
    agentlasSystemPermissions?: SystemPermissionBridge;
  }
}

export function systemPermissions(): SystemPermissionBridge | null {
  return typeof window === "undefined" ? null : window.agentlasSystemPermissions ?? null;
}

const permissions = new Set(["accessibility", "screen", "microphone", "camera", "automation", "browser-files", "keychain"]);
const features = new Set(["browser-import", "computer-use", "automation", "one-context", "media"]);

/** Ignore malformed/older preload events without turning their prose into OS evidence. */
export function isSystemPermissionSnapshot(value: unknown): value is SystemPermissionSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SystemPermissionSnapshot>;
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision ?? -1) < 0 || !Array.isArray(snapshot.notices)) return false;
  const ids = new Set<string>();
  return snapshot.notices.every(notice => {
    if (!notice || typeof notice !== "object" || typeof notice.id !== "string" || !notice.id || ids.has(notice.id)
      || !permissions.has(notice.permission) || !features.has(notice.feature)
      || typeof notice.platform !== "string" || typeof notice.canOpenSettings !== "boolean"
      || typeof notice.createdAt !== "string") return false;
    ids.add(notice.id);
    return true;
  });
}
