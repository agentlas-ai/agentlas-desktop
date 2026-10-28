// Team seats: this Desktop asks "am I still on a team seat, and what does the team give me?" and keeps the team's AI keys in
// the OS keychain only while the answer is yes.
//
// Rules (owner decision 2026-10-27, Claude-Team-like seats):
//  - Sync at sign-in/restore and every 10 minutes while the app runs.
//  - Removed seat (`active:false`) or signed out: the keys this module put in the keychain are deleted at once.
//  - Offline: keys stay for at most 24 h since the last successful check, then they are deleted.
//  - A key the person saved themselves is never overwritten and never deleted; the team key is skipped for that provider.
//  - Honest limit: a key that was already read out of the keychain cannot be recalled. Rotate it at the provider.
//
// Nothing here stores key values outside the keychain; the state file holds provider names and short fingerprints only.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeBackend } from "../../shared/types";

export const ORG_SYNC_SCHEMA = "agentlas.org-sync.v1";
export const ORG_SYNC_INTERVAL_MS = 10 * 60_000;
export const ORG_SYNC_MAX_OFFLINE_MS = 24 * 60 * 60_000;

/** Provider names the team console uses -> the Desktop BYOK backend that holds the key. */
const BACKEND_FOR_PROVIDER: Readonly<Record<string, RuntimeBackend>> = {
  anthropic: "anthropic", openai: "openai", google: "google", openrouter: "openrouter", custom: "custom",
};

export type OrgSeatState = {
  schema: 1;
  orgId: string | null;
  /** Backends whose keychain key this module wrote, with the fingerprint of what it wrote. */
  managed: Partial<Record<RuntimeBackend, string>>;
  lastVerifiedAt: number;
  hubBlocked: boolean;
};
export const EMPTY_STATE: Readonly<OrgSeatState> = Object.freeze({ schema: 1, orgId: null, managed: {}, lastVerifiedAt: 0, hubBlocked: false });

export type OrgSyncFetch = { status: number; body: unknown } | null;
export interface OrgSeatDeps {
  /** null = no signed-in session, or the network failed. */
  fetchSync(): Promise<OrgSyncFetch>;
  readKey(backend: RuntimeBackend): Promise<string | null>;
  saveKey(backend: RuntimeBackend, value: string): Promise<void>;
  deleteKey(backend: RuntimeBackend): Promise<void>;
  loadState(): Promise<OrgSeatState>;
  saveState(state: OrgSeatState): Promise<void>;
  now(): number;
}
export type OrgSyncOutcome = "updated" | "revoked" | "unchanged" | "offline";

export function fingerprint(value: string): string {
  return createHash("sha256").update("agentlas.org-seat.v1\0").update(value).digest("hex").slice(0, 16);
}

type TeamKey = { backend: RuntimeBackend; value: string };
function parseActive(body: unknown): { orgId: string; hubBlocked: boolean; keys: TeamKey[] } | null {
  const o = body as Record<string, any> | null;
  if (!o || typeof o !== "object" || o.schema !== ORG_SYNC_SCHEMA || o.active !== true) return null;
  const orgId = o.org?.id;
  if (typeof orgId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(orgId) || !Array.isArray(o.keys) || o.keys.length > 50) return null;
  const byBackend = new Map<RuntimeBackend, string>();
  for (const key of o.keys) {
    const backend = typeof key?.provider === "string" ? BACKEND_FOR_PROVIDER[key.provider] : undefined;
    const value = key?.value;
    if (!backend || typeof value !== "string" || value.length < 8 || value.length > 512 || /\s/.test(value)) continue;
    if (!byBackend.has(backend)) byBackend.set(backend, value); // the first key of a provider wins
  }
  return { orgId, hubBlocked: o.policy?.hubBlocked === true, keys: [...byBackend].map(([backend, value]) => ({ backend, value })) };
}

/** Delete every team key this module wrote, but never one the person has since replaced with their own. */
async function revokeManaged(deps: OrgSeatDeps, state: OrgSeatState): Promise<boolean> {
  let changed = Object.keys(state.managed).length > 0;
  for (const [backend, fp] of Object.entries(state.managed) as Array<[RuntimeBackend, string]>) {
    const current = await deps.readKey(backend).catch(() => null);
    if (current && fingerprint(current) === fp) await deps.deleteKey(backend);
  }
  await deps.saveState({ ...EMPTY_STATE, managed: {}, lastVerifiedAt: state.lastVerifiedAt });
  return changed;
}

export async function runOrgSeatSync(deps: OrgSeatDeps): Promise<OrgSyncOutcome> {
  const state = await deps.loadState();
  const response = await deps.fetchSync();
  const now = deps.now();
  const unreachable = !response || response.status >= 500 || response.status === 429 || response.status === 408;
  if (unreachable) {
    if (Object.keys(state.managed).length > 0 && now - state.lastVerifiedAt > ORG_SYNC_MAX_OFFLINE_MS) {
      await revokeManaged(deps, state); return "revoked";
    }
    return "offline";
  }
  if (response.status === 401 || response.status === 403) { return (await revokeManaged(deps, state)) ? "revoked" : "unchanged"; }
  if (response.status !== 200) return "offline";
  const active = parseActive(response.body);
  if (!active) {
    const body = response.body as { active?: unknown; schema?: unknown } | null;
    if (body && body.schema === ORG_SYNC_SCHEMA && body.active === false) return (await revokeManaged(deps, state)) ? "revoked" : "unchanged";
    return "offline"; // an answer we cannot read is not proof that the seat ended
  }

  let working = state;
  if (state.orgId && state.orgId !== active.orgId) { await revokeManaged(deps, state); working = { ...EMPTY_STATE, managed: {}, lastVerifiedAt: state.lastVerifiedAt }; }
  const managed: OrgSeatState["managed"] = { ...working.managed };
  let changed = false;
  const wanted = new Set(active.keys.map(k => k.backend));
  for (const { backend, value } of active.keys) {
    const fp = fingerprint(value);
    const current = await deps.readKey(backend).catch(() => null);
    if (managed[backend] !== undefined) {
      if (current && fingerprint(current) === fp) continue;                   // already in place
      if (current && fingerprint(current) !== managed[backend]) { delete managed[backend]; changed = true; continue; } // the person replaced it: theirs now
    } else if (current) continue;                                              // a personal key exists: it wins
    await deps.saveKey(backend, value); managed[backend] = fp; changed = true;
  }
  for (const [backend, fp] of Object.entries(managed) as Array<[RuntimeBackend, string]>) {
    if (wanted.has(backend)) continue;                                         // the team no longer provides this provider
    const current = await deps.readKey(backend).catch(() => null);
    if (current && fingerprint(current) === fp) await deps.deleteKey(backend);
    delete managed[backend]; changed = true;
  }
  await deps.saveState({ schema: 1, orgId: active.orgId, managed, lastVerifiedAt: now, hubBlocked: active.hubBlocked });
  return changed ? "updated" : "unchanged";
}

/** Sign-out or a lost session: the keys leave with the person. */
export async function revokeOrgSeatKeys(deps: OrgSeatDeps): Promise<boolean> {
  return revokeManaged(deps, await deps.loadState());
}

// ── real wiring ──────────────────────────────────────────────────────────────────────────────
export function stateFilePath(userData: string): string { return path.join(userData, "org-seat-state.json"); }

export function fileStateStore(userData: string): Pick<OrgSeatDeps, "loadState" | "saveState"> {
  const file = stateFilePath(userData);
  return {
    async loadState() {
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<OrgSeatState>;
        if (raw.schema !== 1 || typeof raw.managed !== "object" || !raw.managed) return { ...EMPTY_STATE, managed: {} };
        const managed: OrgSeatState["managed"] = {};
        for (const [k, v] of Object.entries(raw.managed)) if (typeof v === "string" && /^[a-f0-9]{16}$/.test(v) && Object.values(BACKEND_FOR_PROVIDER).includes(k as RuntimeBackend)) managed[k as RuntimeBackend] = v;
        return { schema: 1, orgId: typeof raw.orgId === "string" ? raw.orgId : null, managed,
          lastVerifiedAt: Number.isFinite(raw.lastVerifiedAt) ? Number(raw.lastVerifiedAt) : 0, hubBlocked: raw.hubBlocked === true };
      } catch { return { ...EMPTY_STATE, managed: {} }; }
    },
    async saveState(state) {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(tmp, file);
    },
  };
}
