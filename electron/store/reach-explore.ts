// Agentlas Reach, the owner's switch (owner 2026-10-23): background exploration of the installed desktop apps. OFF until the owner
// turns it on in Settings. The value lives in the meta table so no schema migration is needed.
//
// No Electron import on purpose: the background daemon and the terminal engine read this switch too (macOS permissions, which need
// Electron, are read in the Main-only IPC module instead). The Reach service writes `reach.status.v1` (one JSON value); this file
// only reads it, and what it cannot read it reports as zero or absent, never as an error.
import { getMeta, setMeta } from "./meta";
import type { ReachStatusDto } from "../../shared/reach";

export const REACH_EXPLORE_KEY = "reach.explore.enabled.v1";
export const REACH_STATUS_KEY = "reach.status.v1";
const LAST_ERROR_MAX_CHARS = 300;

// The owner agrees in a dialog every time the switch is turned on (owner 2026-10-23): "to improve the product, part of this activity may be
// sent; not personal information, part of the newly created app scripts / MCP methods". The agreement is recorded with the switch; a switch
// that reads "on" without a recorded agreement (a value written some other way) counts as off, so nothing starts without it.
export const REACH_CONSENT_KEY = "reach.consent.v1";
export const REACH_CONSENT_VERSION = 1;

export function hasReachConsent(): boolean {
  try {
    const parsed = JSON.parse(getMeta(REACH_CONSENT_KEY) ?? "null") as { version?: unknown; at?: unknown } | null;
    return !!parsed && parsed.version === REACH_CONSENT_VERSION && typeof parsed.at === "string" && Number.isFinite(Date.parse(parsed.at));
  } catch { return false; }
}

export function recordReachConsent(): void {
  setMeta(REACH_CONSENT_KEY, JSON.stringify({ version: REACH_CONSENT_VERSION, at: new Date().toISOString() }));
}

export function getReachExploreEnabled(): boolean {
  return getMeta(REACH_EXPLORE_KEY) === "1" && hasReachConsent();
}

/** Turning it on needs the owner's agreement (`consented: true`, given by the dialog); turning it off needs nothing. */
export function setReachExploreEnabled(enabled: boolean, consented = false): void {
  if (typeof enabled !== "boolean") throw new TypeError("reach_switch_invalid");
  if (enabled && consented !== true) throw new Error("reach_consent_required");
  if (enabled) recordReachConsent();
  setMeta(REACH_EXPLORE_KEY, enabled ? "1" : "0");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** The status line's data. The switch is read live; the rest is the service's last report, with anything unreadable shown as empty.
 * `permissions` is always unknown here: Main fills it in from the operating system on every read. */
export function readReachStatus(): ReachStatusDto {
  let report: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(getMeta(REACH_STATUS_KEY) ?? "null") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;
  } catch { /* a damaged report reads as no report */ }
  const lastError = typeof report.lastError === "string" && report.lastError.trim() ? report.lastError.trim().slice(0, LAST_ERROR_MAX_CHARS) : null;
  return {
    enabled: getReachExploreEnabled(),
    mapAt: isoOrNull(report.mapAt),
    apps: count(report.apps),
    green: count(report.green),
    amber: count(report.amber),
    gray: count(report.gray),
    exploring: report.exploring === true,
    usable: count(report.usable),
    lastError,
    permissions: { accessibility: null, screenRecording: null },
  };
}
