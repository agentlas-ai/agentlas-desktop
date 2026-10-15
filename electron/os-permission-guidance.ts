import {
  isSystemPermissionFeature, isSystemPermissionKey, systemPermissionSettingsTarget,
  type SystemPermissionFeature, type SystemPermissionKey, type SystemPermissionSnapshot,
} from "../shared/os-permissions";

// Electron-free: import readers and daemon/Terminal consumers may report without a GUI.
// A later renderer hydrates this bounded snapshot, so an early failure is not lost.
const notices: SystemPermissionSnapshot["notices"] = [];
const listeners = new Set<(snapshot: SystemPermissionSnapshot) => void>();
let revision = 0;
let sequence = 0;
export function systemPermissionSnapshot(): SystemPermissionSnapshot {
  return { revision, notices: notices.map(notice => ({ ...notice })) };
}
function publish(): void {
  revision += 1;
  for (const listener of listeners) {
    try { listener(systemPermissionSnapshot()); } catch { /* Guidance never changes the operation's result. */ }
  }
}
export function reportSystemPermissionIssue(permission: SystemPermissionKey, feature: SystemPermissionFeature): void {
  if (!isSystemPermissionKey(permission) || !isSystemPermissionFeature(feature)) return;
  if (notices.some(notice => notice.permission === permission && notice.feature === feature)) return;
  if (notices.length >= 12) notices.shift();
  notices.push({ id: `os-permission-${++sequence}`, permission, feature, platform: process.platform,
    canOpenSettings: systemPermissionSettingsTarget(process.platform, permission) !== null, createdAt: new Date().toISOString() });
  publish();
}
export function dismissSystemPermissionIssue(id: string): void {
  const index = notices.findIndex(notice => notice.id === id);
  if (index < 0) return;
  notices.splice(index, 1);
  publish();
}
export function subscribeSystemPermissionIssues(callback: (snapshot: SystemPermissionSnapshot) => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
