import { createHash } from "node:crypto";
import path from "node:path";
import { MANAGED_ONE_BOOTSTRAP_SCHEMA, type ManagedOneBootstrap, type ManagedOnePurpose } from "../../shared/managed-one";

const PURPOSES = ["serving", "relay", "pairing", "control"] as const;
let current: Readonly<ManagedOneBootstrap> | undefined;
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
  if (!record(value) || Object.keys(value).some(key => !["schemaVersion", "hostId", "generation", "userId", "workspaceId", "expiresAt", "webBaseUrl", "relayUrl", "userDataDir", "credentials", "controlBearer"].includes(key))) return fail();
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
  current = next; return next;
}
export function managedOneConfigured(): boolean { return !!current; }
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
export function clearManagedOneAuthentication(): void { current = undefined; }
