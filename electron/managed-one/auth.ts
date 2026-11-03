import { createHash } from "node:crypto";
import path from "node:path";
import { MANAGED_ONE_BOOTSTRAP_SCHEMA, type ManagedOneBootstrap, type ManagedOnePurpose } from "../../shared/managed-one";

// ---- Feature switches (kept in this file: the module has no relative imports, so isolated loaders can still load it) ----
/** Cloud computer feature switches. One list, read from the bootstrap (`features`) or the
 * AGENTLAS_MANAGED_ONE_FEATURES environment variable (comma separated). The bootstrap wins.
 * Defaults keep the behaviour that shipped before the switches existed. */
export const MANAGED_ONE_FEATURE_NAMES = ["one", "work", "browser", "team", "goal", "computerUse"] as const;
export type ManagedOneFeatureName = typeof MANAGED_ONE_FEATURE_NAMES[number];
export type ManagedOneFeatures = Readonly<Record<ManagedOneFeatureName, boolean>>;

/** One and Work are on, everything else is off. Matches the host before the switches existed. */
export const MANAGED_ONE_DEFAULT_FEATURES: ManagedOneFeatures = Object.freeze({ one: true, work: true, browser: false, team: false, goal: false, computerUse: false });
/** Names that are accepted and stay off. Computer Use: a Linux container has no screen to drive. Goal: the phone bridge's
 * goal control is typed `false` for service hosts (mobile-bridge/runtime.ts hostAuthority.goalControl), so it cannot be
 * turned on from here; the flag must not claim a capability the bridge does not serve. */
export const MANAGED_ONE_UNSWITCHABLE_FEATURES: readonly ManagedOneFeatureName[] = Object.freeze(["computerUse", "goal"]);

/** `team,browser` turns those on. `-work` turns a default-on feature off. `none` starts from nothing. */
export function parseManagedOneFeatures(spec: unknown): ManagedOneFeatures {
  if (spec === undefined || spec === null || spec === "") return MANAGED_ONE_DEFAULT_FEATURES;
  const items = Array.isArray(spec) ? spec : typeof spec === "string" ? spec.split(",") : null;
  if (!items || items.length > 32) throw new Error("managed_one_features_invalid");
  const next: Record<ManagedOneFeatureName, boolean> = { ...MANAGED_ONE_DEFAULT_FEATURES };
  for (const raw of items) {
    if (typeof raw !== "string") throw new Error("managed_one_features_invalid");
    const item = raw.trim();
    if (!item) continue;
    if (item === "none") { for (const name of MANAGED_ONE_FEATURE_NAMES) next[name] = false; continue; }
    const off = item.startsWith("-"), name = (off ? item.slice(1) : item) as ManagedOneFeatureName;
    if (!MANAGED_ONE_FEATURE_NAMES.includes(name)) throw new Error("managed_one_features_invalid");
    next[name] = !off;
  }
  for (const name of MANAGED_ONE_UNSWITCHABLE_FEATURES) next[name] = false;
  return Object.freeze(next);
}

const PURPOSES = ["serving", "relay", "pairing", "control"] as const;
let current: Readonly<ManagedOneBootstrap> | undefined;
let managedHostProcess = false;
let managedFeatures: ManagedOneFeatures = MANAGED_ONE_DEFAULT_FEATURES;
const ownershipListeners = new Set<() => void>();
/** Invalidates in-flight work when a managed host owner disappears or becomes active. */
export function onManagedOneOwnershipChanged(listener: () => void): () => void {
  ownershipListeners.add(listener);
  return () => ownershipListeners.delete(listener);
}
function notifyOwnershipChanged(): void {
  for (const listener of ownershipListeners) {
    try { listener(); } catch { /* A listener must not prevent host authentication changes. */ }
  }
}
function fail(): never { throw new Error("managed_one_bootstrap_invalid"); }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function origin(value: unknown, relay = false): string {
  if (typeof value !== "string" || value.length > 2048) return fail();
  let url: URL; try { url = new URL(value); } catch { return fail(); }
  if (url.username || url.password || url.hash || url.search || !(relay ? ["wss:", "https:"] : ["https:"]).includes(url.protocol)) return fail();
  if (!relay && (url.pathname !== "/" || !["agentlas.cloud", "www.agentlas.cloud", "api.agentlas.cloud", "staging.agentlas.cloud"].includes(url.hostname))) return fail();
  return value.replace(/\/$/, "");
}
export function validateManagedOneBootstrap(value: unknown, now = Date.now()): Readonly<ManagedOneBootstrap> {
  if (!record(value) || Object.keys(value).some(key => !["schemaVersion", "hostId", "generation", "userId", "workspaceId", "expiresAt", "webBaseUrl", "relayUrl", "userDataDir", "credentials", "controlBearer", "features", "restoreFrom", "restoreSha256", "timeZone"].includes(key))) return fail();
  // Optional fields: absent means the behaviour that shipped before they existed.
  if (value.features !== undefined) { try { parseManagedOneFeatures(value.features); } catch { return fail(); } }
  if (value.restoreFrom !== undefined && (typeof value.restoreFrom !== "string" || value.restoreFrom.length > 1024 || value.restoreFrom.includes("\0") || !path.isAbsolute(value.restoreFrom)
    || typeof value.restoreSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.restoreSha256))) return fail();
  if (value.restoreFrom === undefined && value.restoreSha256 !== undefined) return fail();
  if (value.timeZone !== undefined) {
    if (typeof value.timeZone !== "string" || value.timeZone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value.timeZone)) return fail();
    try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }); } catch { return fail(); }
  }
  if (value.schemaVersion !== MANAGED_ONE_BOOTSTRAP_SCHEMA || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= now || Number(value.expiresAt) > now + 24 * 60 * 60_000) return fail();
  for (const name of ["hostId", "userId", "workspaceId"] as const) if (typeof value[name] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value[name] as string)) return fail();
  if (!/^host_[a-f0-9]{32}$/.test(String(value.hostId)) || typeof value.userDataDir !== "string" || !path.isAbsolute(value.userDataDir) || value.userDataDir.includes("\0") || path.resolve(value.userDataDir) === path.parse(value.userDataDir).root) return fail();
  if (!record(value.credentials) || Object.keys(value.credentials).sort().join(",") !== [...PURPOSES].sort().join(",")) return fail();
  for (const token of [...Object.values(value.credentials), value.controlBearer]) if (typeof token !== "string" || !/^[A-Za-z0-9_.-]{32,16384}$/.test(token)) return fail();
  if (new Set(Object.values(value.credentials)).size !== PURPOSES.length || Object.values(value.credentials).includes(value.controlBearer)) return fail();
  return Object.freeze({ ...value, webBaseUrl: origin(value.webBaseUrl), ...(value.relayUrl !== undefined ? { relayUrl: origin(value.relayUrl, true) } : {}),
    userDataDir: path.resolve(value.userDataDir), credentials: Object.freeze({ ...value.credentials }) }) as Readonly<ManagedOneBootstrap>;
}
export function configureManagedOneAuthentication(value: unknown): Readonly<ManagedOneBootstrap> {
  const next = validateManagedOneBootstrap(value);
  if (current && ["hostId", "generation", "userId", "workspaceId", "webBaseUrl", "userDataDir", "controlBearer"].some(key => current![key as keyof ManagedOneBootstrap] !== next[key as keyof ManagedOneBootstrap])) throw new Error("managed_one_host_identity_changed");
  const features = parseManagedOneFeatures(next.features ?? process.env.AGENTLAS_MANAGED_ONE_FEATURES);
  // The switches are fixed for the life of the process; a renewal repeats the same bootstrap and cannot flip them.
  if (managedHostProcess && JSON.stringify(features) !== JSON.stringify(managedFeatures)) throw new Error("managed_one_host_identity_changed");
  const wasActive = Boolean(current && current.expiresAt > Date.now());
  current = next;
  managedHostProcess = true;
  managedFeatures = features;
  if (!wasActive) notifyOwnershipChanged();
  return next;
}
export function managedOneConfigured(): boolean { return !!current; }
/** A cleared or expired managed host must never acquire Desktop cookie authority. */
export function wasManagedOneConfigured(): boolean { return managedHostProcess; }
/** Team execution is off on a Cloud host unless the `team` feature is switched on (bootstrap `features` or
 * AGENTLAS_MANAGED_ONE_FEATURES). This is a host identity, not a credential check: expiration or clearing
 * cannot grant it. Desktop and the terminal engine are not managed host processes, so it is always true there. */
export function managedOneTeamAvailable(): boolean { return !managedHostProcess || managedFeatures.team; }
/** The switches this host process runs with (defaults until a managed bootstrap is configured). */
export function managedOneFeatures(): ManagedOneFeatures { return managedFeatures; }
export function assertManagedOneTeamAvailable(): void {
  if (!managedOneTeamAvailable()) throw new Error("managed_one_team_unavailable");
}
export function managedOneAuthentication(): Readonly<ManagedOneBootstrap> | null { return current && current.expiresAt > Date.now() ? current : null; }
export function managedOneHeaders(purpose: ManagedOnePurpose): Record<string, string> | null {
  const value = managedOneAuthentication();
  return value ? { authorization: `Bearer ${value.credentials[purpose]}`, "x-agentlas-managed-one": "1", "x-agentlas-client": "desktop" } : null;
}
/** Value-free connection epoch. A renewed token invalidates existing relay authority. */
export function managedOneAuthenticationEpoch(purpose: ManagedOnePurpose): string | null {
  const value = managedOneAuthentication();
  return value ? createHash("sha256").update(value.credentials[purpose]).digest("hex") : null;
}
export function clearManagedOneAuthentication(): void {
  if (!current) return;
  current = undefined;
  notifyOwnershipChanged();
}
