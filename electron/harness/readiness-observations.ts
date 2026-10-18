import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
 * Observed readiness (native-harness notyet NH31, docs 15/17/18; audit C05/C08).
 *
 * "Ready" used to mean "a row exists and a key/bin is present". Configuration is not readiness: a connection is ready
 * only after an exact handshake and tool inventory were observed for its current configuration, and a media route is
 * proven only by an outcome it actually produced. This store keeps the last observation per connection / route — one
 * small file per key written atomically (tmp + rename), so Main and the background service never overwrite each
 * other's record of a different key. Names, counts, digests and outcome codes only: never a value, URL, path, prompt
 * or tool argument. No electron import (the daemon loads the harness).
 */

export type ReadinessSubject = "connection" | "media-route";
export type ObservedOutcome =
  | "ok" | "authentication_required" | "entitlement_denied" | "quota_exhausted" | "configuration_missing" | "unavailable" | "cancelled";

export interface ReadinessObservation {
  schemaVersion: "agentlas.readiness-observation.v1";
  subject: ReadinessSubject;
  id: string;
  outcome: ObservedOutcome;
  observedAt: string;
  /** The configuration the observation was made with; a later configuration change makes it stale. */
  configurationDigest?: string;
  toolCount?: number;
  toolNamesDigest?: string;
  /** Operation that produced the observation (connector.connect, media.image.generate, a media job). */
  via: string;
}

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "authentication_required", "entitlement_denied", "quota_exhausted", "configuration_missing", "unavailable", "cancelled"]);

async function directory(subject: ReadinessSubject): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath(path.join("harness", "observations", subject));
}

function fileName(id: string): string {
  return `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`;
}

export async function recordReadinessObservation(entry: Omit<ReadinessObservation, "schemaVersion" | "observedAt"> & { observedAt?: string }): Promise<boolean> {
  try {
    if (!OUTCOMES.has(entry.outcome)) return false;
    const dir = await directory(entry.subject);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: ReadinessObservation = {
      schemaVersion: "agentlas.readiness-observation.v1", subject: entry.subject, id: entry.id, outcome: entry.outcome,
      observedAt: entry.observedAt ?? new Date().toISOString(), via: entry.via,
      ...(entry.configurationDigest ? { configurationDigest: entry.configurationDigest } : {}),
      ...(typeof entry.toolCount === "number" ? { toolCount: entry.toolCount } : {}),
      ...(entry.toolNamesDigest ? { toolNamesDigest: entry.toolNamesDigest } : {}),
    };
    const target = path.join(dir, fileName(entry.id));
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export async function readReadinessObservation(subject: ReadinessSubject, id: string): Promise<ReadinessObservation | null> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(await directory(subject), fileName(id)), "utf8")) as ReadinessObservation;
    return parsed && parsed.schemaVersion === "agentlas.readiness-observation.v1" && parsed.id === id && OUTCOMES.has(parsed.outcome) ? parsed : null;
  } catch {
    return null;
  }
}

/** The same record, read synchronously for a synchronous probe (canonical-server-state.ts). Null when absent or unreadable. */
export function readReadinessObservationSync(subject: ReadinessSubject, id: string): ReadinessObservation | null {
  try {
    const { userDataPath } = require("../runtime-paths") as typeof import("../runtime-paths");
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataPath(path.join("harness", "observations", subject)), fileName(id)), "utf8")) as ReadinessObservation;
    return parsed && parsed.schemaVersion === "agentlas.readiness-observation.v1" && parsed.id === id && OUTCOMES.has(parsed.outcome) ? parsed : null;
  } catch {
    return null;
  }
}

export function toolNamesDigest(names: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...names].sort())).digest("hex");
}

export interface ConnectionReadiness {
  /** One state, most blocking first: disabled → credential/login → observed failure → stale → unobserved → ready. */
  state: "disabled" | "credential_missing" | "login_may_be_required" | ObservedOutcome | "configuration_changed" | "unobserved" | "ready";
  stored: true;
  enabled: boolean;
  auth: "ready" | "credential_missing" | "login_may_be_required";
  negotiated: { observedAt: string; toolCount: number } | null;
  entitlement: "ok" | "denied" | "unobserved";
  quota: "ok" | "exhausted" | "unobserved";
  ready: boolean;
  observedAt: string | null;
}

/** Fold configuration, credential state and the last observation into separate axes plus one state. Pure. */
export function connectionReadiness(input: {
  enabled: boolean; auth: ConnectionReadiness["auth"]; configurationDigest: string; observation: ReadinessObservation | null;
}): ConnectionReadiness {
  const obs = input.observation;
  const current = Boolean(obs && obs.configurationDigest === input.configurationDigest);
  const negotiated = obs && current && obs.outcome === "ok" ? { observedAt: obs.observedAt, toolCount: obs.toolCount ?? 0 } : null;
  const entitlement = obs && current ? (obs.outcome === "entitlement_denied" ? "denied" : obs.outcome === "ok" ? "ok" : "unobserved") : "unobserved";
  const quota = obs && current ? (obs.outcome === "quota_exhausted" ? "exhausted" : obs.outcome === "ok" ? "ok" : "unobserved") : "unobserved";
  // A remote server with no key and no OAuth session may simply need none: an observed handshake settles it.
  const auth = input.auth === "login_may_be_required" && negotiated ? "ready" : input.auth;
  const ready = input.enabled && auth === "ready" && Boolean(negotiated);
  const state: ConnectionReadiness["state"] = !input.enabled ? "disabled"
    : auth === "credential_missing" ? "credential_missing"
      : !obs ? (auth === "login_may_be_required" ? "login_may_be_required" : "unobserved")
        : !current ? "configuration_changed"
          : obs.outcome === "ok" ? "ready" : obs.outcome;
  return { state, stored: true, enabled: input.enabled, auth, negotiated, entitlement, quota, ready, observedAt: obs?.observedAt ?? null };
}

/** Map an MCP probe/call failure to an outcome code (typed fields first; HTTP status only when the SDK carried one). */
export function outcomeFromProbe(status: { connected: boolean; failureCode?: string; httpStatus?: number | null }): ObservedOutcome {
  if (status.connected) return "ok";
  if (status.failureCode === "configuration_missing") return "configuration_missing";
  if (status.failureCode === "connection_cancelled") return "cancelled";
  if (status.failureCode === "authentication_required" || status.httpStatus === 401) return "authentication_required";
  if (status.httpStatus === 402 || status.httpStatus === 403) return "entitlement_denied";
  if (status.httpStatus === 429) return "quota_exhausted";
  return "unavailable";
}
