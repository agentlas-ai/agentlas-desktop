// Explicit owner preference and effective login-service state are separate.
// Historical forced-off values are not owner opt-outs. Main can enable recovery
// for observed unfinished Science work, but an explicit new opt-out wins.
import { getMeta, setMeta } from "./meta";
import { randomUUID } from "node:crypto";
import { AUTOSTART_READY_KEY } from "../daemon/autostart-manifest";

export const DAEMON_AUTOSTART_META_KEY = "daemon_autostart";
export const DAEMON_AUTOSTART_PREFERENCE_KEY = "daemon_autostart_preference_v1";

/** 켜짐은 정확히 "1" 만 인정한다 — 없는 값·이상한 값은 전부 off(보수적 기본). */
export function getDaemonAutostartEnabled(): boolean {
  return getMeta(DAEMON_AUTOSTART_META_KEY) === "1";
}

export function setDaemonAutostartEnabled(enabled: boolean): void {
  if (typeof enabled !== "boolean") throw new TypeError("daemon_autostart_preference_invalid");
  setMeta(DAEMON_AUTOSTART_PREFERENCE_KEY, enabled ? "enabled" : "disabled");
  setMeta(DAEMON_AUTOSTART_META_KEY, enabled ? "1" : "0");
}

/** Older builds forced the legacy key to 0 on every boot. Only this new
 * preference key can prove an explicit owner opt-out. The Science owner supplies
 * a read-only recovered-work observation; no second Science DB is opened here. */
export function resolveDaemonAutostartPolicy(input: { hasRecoverableScienceWork: boolean }): { enabled: boolean; reason: "explicit" | "recoverable-science" | "existing" | "off" } {
  const preference = getMeta(DAEMON_AUTOSTART_PREFERENCE_KEY);
  if (preference === "enabled" || preference === "disabled") {
    const enabled = preference === "enabled"; setMeta(DAEMON_AUTOSTART_META_KEY, enabled ? "1" : "0");
    return { enabled, reason: "explicit" };
  }
  if (input.hasRecoverableScienceWork === true) {
    setMeta(DAEMON_AUTOSTART_META_KEY, "1");
    return { enabled: true, reason: "recoverable-science" };
  }
  return { enabled: getDaemonAutostartEnabled(), reason: getDaemonAutostartEnabled() ? "existing" : "off" };
}

export function readDaemonAutostartStoreReady(input: { appVersion: string; requiredSchemaVersion: number }): string | null {
  try {
    const value = JSON.parse(getMeta(AUTOSTART_READY_KEY) ?? "null");
    return value?.appVersion === input.appVersion && value?.schemaVersion === input.requiredSchemaVersion
      && typeof value.token === "string" && /^[a-f0-9-]{36}$/i.test(value.token) ? value.token : null;
  } catch { return null; }
}

/** Main calls this only after its actual built-in/plugin seed barrier. A
 * migration-only/new empty DB has no token and cannot be booted at login. */
export function markDaemonAutostartStoreReady(input: { appVersion: string; requiredSchemaVersion: number }): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(input.appVersion)
    || !Number.isSafeInteger(input.requiredSchemaVersion) || input.requiredSchemaVersion < 1) throw new TypeError("daemon_autostart_ready_input_invalid");
  const existing = readDaemonAutostartStoreReady(input);
  if (existing) return existing;
  const token = randomUUID();
  setMeta(AUTOSTART_READY_KEY, JSON.stringify({ token, appVersion: input.appVersion, schemaVersion: input.requiredSchemaVersion }));
  return token;
}
