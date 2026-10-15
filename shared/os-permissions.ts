/** Local OS recovery metadata only. Never credentials, paths, grants or replay authority. */
export const SYSTEM_PERMISSION_KEYS = ["accessibility", "screen", "microphone", "camera", "automation", "browser-files", "keychain"] as const;
export type SystemPermissionKey = typeof SYSTEM_PERMISSION_KEYS[number];
export const SYSTEM_PERMISSION_FEATURES = ["browser-import", "computer-use", "automation", "one-context", "media"] as const;
export type SystemPermissionFeature = typeof SYSTEM_PERMISSION_FEATURES[number];
export interface SystemPermissionNotice {
  id: string;
  permission: SystemPermissionKey;
  feature: SystemPermissionFeature;
  platform: string;
  canOpenSettings: boolean;
  createdAt: string;
}
export interface SystemPermissionSnapshot { revision: number; notices: SystemPermissionNotice[] }
export interface SystemPermissionBridge {
  snapshot(): Promise<SystemPermissionSnapshot>;
  subscribe(callback: (value: SystemPermissionSnapshot) => void): () => void;
  openSettings(id: string): Promise<{ ok: boolean; error?: string }>;
  dismiss(id: string): Promise<void>;
  recheck(id: string): Promise<{ resolved: boolean }>;
}
export function isSystemPermissionKey(value: unknown): value is SystemPermissionKey {
  return typeof value === "string" && (SYSTEM_PERMISSION_KEYS as readonly string[]).includes(value);
}
export function isSystemPermissionFeature(value: unknown): value is SystemPermissionFeature {
  return typeof value === "string" && (SYSTEM_PERMISSION_FEATURES as readonly string[]).includes(value);
}
/** One allowlist; Windows has no macOS Accessibility/Keychain/Full Disk Access switch. */
export function systemPermissionSettingsTarget(platform: string, permission: SystemPermissionKey): string | null {
  if (!isSystemPermissionKey(permission)) return null;
  if (platform === "darwin") {
    if (permission === "keychain") return "keychain-access";
    const panes: Record<Exclude<SystemPermissionKey, "keychain">, string> = {
      accessibility: "Accessibility", screen: "ScreenCapture", microphone: "Microphone",
      camera: "Camera", automation: "Automation", "browser-files": "AllFiles",
    };
    const pane = panes[permission];
    return pane ? `x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}` : null;
  }
  if (platform === "win32") {
    const panes: Partial<Record<SystemPermissionKey, string>> = {
      screen: "privacy-graphicscaptureprogrammatic", microphone: "privacy-microphone", camera: "privacy-webcam",
    };
    return panes[permission] ? `ms-settings:${panes[permission]}` : null;
  }
  return null;
}
