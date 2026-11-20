import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PlaceValues } from "../../shared/place-values";
import { PLURAL_PLACES_V } from "../one/plural-handoff-wire";

/**
 *: this desktop's two calls to the web service about its PLACE in the person's list of agents, and nothing else.
 *   - `POST /api/desktop/place`  - the values of this desktop (machine name, agent name, face, style, what it reaches, runnable, version), sent when they CHANGED (never a timer).
 *   - `GET /api/desktop/plural`  - the ONE read after a `relay.wake` frame and at every connect: { rows, done, approvals, sharedSeq, placesRev, known, removed }.
 * The proof is the desktop's login session (the cookie the relay's control channel already uses); the body never names the account.
 *
 * Who calls: the bridge runtime, in whichever process holds the bridge (Desktop Main or the background service: one process at a time, the lease in main.ts / daemon/main.ts),
 * so a window that closes and a service that takes the bridge do the same thing. What was last reported lives in ONE small file next to the bridge's own files
 * (`mobile-bridge/places-report.json`: host id, account, a digest of the values): either process reads it, so a hand-over from one process to the other neither reports twice nor skips a change.
 * The file is replaced on each report and deleted when the phone disconnected this desktop (`removed`) - it is read at every connect and at every value change, and goes with the bridge's folder.
 *
 * The server's switch (COMPANION_PLURAL_V1) closed = both routes answer 404: this file then does NOTHING (no error, no retry, no line) until the next connect; there is no switch on this side.
 * Every failure (network, 5xx, 429, 409 `no_account`) leaves the digest unwritten, so the next event (connect, wake, a value change) reports again; no timer, no retry loop.
 *
 * What the later bundles read from here: `onPluralAnswer(listener)` / `lastPluralAnswer()` - the answer of every GET, parsed, in the process that made it
 * (E "receive" reads `rows` / `done` / `approvals`, C2 "shared memory" reads `sharedSeq`, the place list reads `placesRev`).
 */
export const PLACES_PROTOCOL_V = PLURAL_PLACES_V;    // the `v` the desktop reports (1..99 on the server): 2 = this desktop knows the question and end words of the hand-off wire (a sender only sends work to a place with v >= 2); 3 = it draws the consent chip (a hand-off from this desktop to another agent needs v >= 3)
export const PLACES_REQUEST_TIMEOUT_MS = 10_000;     // one request; the same bound the team-seat sync uses for its server call
const STATE_FILE = "places-report.json";
const WAKE_ID = /^[A-Za-z0-9_-]{8,100}$/;

export type { PlaceValues };
export interface PluralAnswer {
  rows: unknown[]; done: unknown[]; approvals: unknown[];
  sharedSeq: number; placesRev: number; known: boolean; removed: boolean;
  /** the server says shared memory is open for this person here (a phone conversation exists, or another desktop is registered). Absent / false (an older server, the switch closed) = this desktop does not touch shared memory at all. */
  sharedOpen: boolean;
  /** When the phone disconnected this desktop (the server's clock, ms since the epoch), or null: a server that does not say. Only a pairing made BEFORE this instant is the one that was disconnected. */
  removedAt: number | null;
  /** The work rows this desktop holds (`claimed`): `{ id, run }`. Empty from a server that does not send them. */
  held: unknown[];
  /** Row ids the sender asked to cancel. */
  cancel: unknown[];
  /** The answer was cut at the server's budget: read again. */
  more: boolean;
  /** Rows this desktop sent that are not ended yet (`open`), and the answer's places list (only when `placesRev` differs): kept as the server sent them; the sender side parses them. */
  open: unknown[];
  /** Chips waiting on this desktop (hand-offs another agent wants to give to this desktop's agent); an older server sends none. */
  consent: unknown[];
  places?: unknown;
  /** The wake id this answer was asked with (null: connect or a plain read). */
  wake: string | null;
}

const listeners = new Set<(answer: PluralAnswer) => void>();
/** The ids of the plural Works this desktop has going, named on every GET (`running`): the server answers `cancel[]` for the ones it ended. Set by the receiver (plural-work-real.ts), read here; no timer. */
let runningProvider: (() => string[]) | null = null;
export function setPluralRunningProvider(provider: (() => string[]) | null): void { runningProvider = provider; }
let last: PluralAnswer | null = null;
/** Told after every GET answer that parsed. The answer is data from the server; a listener re-reads nothing from here. */
export function onPluralAnswer(listener: (answer: PluralAnswer) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
/** The newest parsed answer of this process (null before the first). */
export function lastPluralAnswer(): PluralAnswer | null { return last; }
/** Test hook. */
export function __resetPluralAnswersForTest(): void { listeners.clear(); last = null; runningProvider = null; }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The server's `removedAt` (an ISO instant) in ms, or null when it is absent or not an instant. */
export function removedAtOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export function parsePluralAnswer(body: unknown, wake: string | null): PluralAnswer | null {
  if (!isObject(body) || body.ok === false) return null;
  const { rows, done, sharedSeq, placesRev, known, removed } = body;
  // `approvals` is the old wire's list of questions of rows this desktop sent; the new wire carries them in `open[]` - an answer without it is as good
  const approvals = Array.isArray(body.approvals) ? body.approvals : [];
  if (!Array.isArray(rows) || !Array.isArray(done) || !count(sharedSeq) || !count(placesRev) || typeof known !== "boolean" || typeof removed !== "boolean") return null;
  return { rows, done, approvals, sharedSeq, placesRev, known, removed, sharedOpen: body.sharedOpen === true, removedAt: removedAtOf(body.removedAt), held: Array.isArray(body.held) ? body.held : [], cancel: Array.isArray(body.cancel) ? body.cancel : [], more: body.more === true, open: Array.isArray(body.open) ? body.open : [], consent: Array.isArray(body.consent) ? body.consent : [], ...(body.places !== undefined ? { places: body.places } : {}), wake };
}

export function placeDigest(values: PlaceValues): string {
  // `paths` joins the digest only when there are some: a desktop that reports none digests exactly as it did before this column existed (no spurious report after an update).
  const paths = values.paths && values.paths.length ? [[...values.paths].sort()] : [];
  return createHash("sha256").update(JSON.stringify([values.machine, values.agent, values.preset, values.style, [...values.reach].sort(), values.runnable, values.v, ...paths])).digest("hex").slice(0, 16);
}

let pathsProvider: (() => string[]) | null = null;
/** The roads this computer measured as ready (connectors/desktop-paths.ts measureDesktopPaths, kept by Main). Null = none are reported (the switch is off: nothing is added to any report). */
export function setPlacePathsProvider(provider: (() => string[]) | null): void { pathsProvider = provider; }
/**
 * `PLACE_PATHS_MAX` 200 = the server's own ceiling for one report (companion-places.mjs MAX_PLACE_PATHS): the card file has one road per service, so 200 leaves room for a computer that holds most of them.
 * Reached: roads past the 200th (sorted order) are not reported; the phone then does not know the computer has them and falls to the next road.
 */
export const PLACE_PATHS_MAX = 200;
const pathsListeners = new Set<() => void>();
/** The runtime that holds the link subscribes: a changed measured set reports once (the digest keeps an unchanged one from being sent). In-process signal, no timer. */
export function onPlacePathsChanged(listener: () => void): () => void { pathsListeners.add(listener); return () => { pathsListeners.delete(listener); }; }
export function notifyPlacePathsChanged(): void { for (const listener of [...pathsListeners]) { try { listener(); } catch { /* a listener never changes the answer */ } } }
/** True once a server refused a report that carried `paths` (an older service): they are not sent again in this process, so the place is reported exactly as it always was. */
let pathsRefused = false;
export function __resetPlacePathsForTest(): void { pathsRefused = false; pathsProvider = null; }
function withReportablePaths(values: PlaceValues, allowed: boolean): PlaceValues {
  const { paths: _own, ...rest } = values;
  const paths = allowed ? (values.paths ?? pathsProvider?.() ?? []) : [];
  return paths.length ? { ...rest, paths: [...new Set(paths)].sort().slice(0, PLACE_PATHS_MAX) } : rest;
}

export interface PlacesLinkDeps {
  userDataPath: string;
  hostId: string;
  /** The web service's origin (no trailing slash). */
  origin(): string;
  /** One request with the login session's cookie (fetchWithHubSession); null when nobody is signed in. */
  request(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }): Promise<{ status: number; text(): Promise<string> }> | null;
  /** The signed-in account's id, or null. */
  userId(): string | null;
  /** This desktop's values now, or null when they cannot be read (nothing is reported then). */
  values(): PlaceValues | null;
  /** The phone disconnected this desktop: forget the pairing records (the bridge's own revocation; the list of connected phones follows). `removedAt` = when (ms), null when the server did not say: then nothing is forgotten. */
  onRemoved(removedAt: number | null): void;
  /** The server suggests a face the account has not used; the caller applies it ONLY when this desktop's face is still the default. */
  onSuggestedPreset(preset: string): void;
  log?(line: string): void;
}

export interface PlacesLink {
  /** The control channel (re)connected: one GET, then a report when the server does not know this desktop or the values changed since the last report. */
  connect(): Promise<void>;
  /** One more GET without a wake id (the receiver of hand-off rows: the answer was cut, or words were added while it acknowledged). Does not reopen a closed server switch. */
  read(): Promise<void>;
  /** A `relay.wake` frame: one GET carrying the frame's id. */
  wake(id: unknown): Promise<void>;
  /** The profile or the capabilities may have changed: a report when the digest differs from the last one (no GET). */
  valuesChanged(): Promise<void>;
  stop(): void;
}

export function createPlacesLink(deps: PlacesLinkDeps): PlacesLink {
  const file = path.join(deps.userDataPath, "mobile-bridge", STATE_FILE);
  let stopped = false, switchClosed = false;
  let pendingGet: { wake: string | null } | null = null, pendingValues = false;
  let lastLine = "";
  const say = (line: string): void => { if (line === lastLine) return; lastLine = line; try { deps.log?.(line); } catch { /* a log never changes the answer */ } };

  function readState(): { hostId: string; userId: string; digest: string } | null {
    try {
      const x: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return isObject(x) && typeof x.hostId === "string" && typeof x.userId === "string" && typeof x.digest === "string" ? { hostId: x.hostId, userId: x.userId, digest: x.digest } : null;
    } catch { return null; }
  }
  function writeState(userId: string, digest: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ hostId: deps.hostId, userId, digest }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* not written = reported again at the next event: never a wrong "same" */ }
  }
  function clearState(): void { try { fs.rmSync(file, { force: true }); } catch { /* the next report overwrites it */ } }
  const reported = (userId: string, digest: string): boolean => { const s = readState(); return s !== null && s.hostId === deps.hostId && s.userId === userId && s.digest === digest; };

  async function call(method: "GET" | "POST", route: string, body?: string): Promise<{ status: number; json: unknown } | null> {
    const url = `${deps.origin().replace(/\/$/, "")}${route}`;
    try {
      const pending = deps.request(url, { method, headers: { "x-agentlas-client": "desktop", accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
      if (!pending) return null;
      const res = await pending;
      let json: unknown = null;
      if (res.status === 200 || res.status === 409) { try { json = JSON.parse(await res.text()); } catch { json = null; } }
      return { status: res.status, json };
    } catch { return null; }
  }

  async function report(userId: string): Promise<void> {
    const raw = deps.values();
    if (!raw) return;
    let values = withReportablePaths(raw, !pathsRefused);
    let digest = placeDigest(values);
    const send = (v: PlaceValues) => call("POST", "/api/desktop/place", JSON.stringify({ hostId: deps.hostId, ...v, reach: [...v.reach].sort(), ...(v.paths?.length ? { os: process.platform } : {}) }));
    let out = await send(values);
    // An older service that refuses the unknown column (400): the roads are dropped for this process and the report goes out as it always did, once, now.
    if (out && out.status === 400 && values.paths?.length) { pathsRefused = true; values = withReportablePaths(raw, false); digest = placeDigest(values); out = await send(values); }
    if (!out) { say("place report: not sent"); return; }
    if (out.status === 404) { switchClosed = true; return; }                           // the server's switch is closed: nothing, quietly
    if (out.status === 409) {
      // `no_account` (the account has no phone data yet) and `full` (the plan's number of desktops is reached: `{ error: "full", limit, plan, next }`) are two different causes; the next connect or wake reports again either way.
      const code = isObject(out.json) && typeof out.json.error === "string" ? out.json.error : null;
      say(code === "full" ? "place report: the plan has no room for another desktop" : "place report: the account has no phone data yet");
      return;
    }
    if (out.status !== 200 || !isObject(out.json) || out.json.ok !== true) { say(`place report: refused (${out.status})`); return; }
    switchClosed = false;
    if (out.json.removed === true) { removed(removedAtOf(out.json.removedAt)); return; }
    writeState(userId, digest);
    say("place report: sent");
    if (typeof out.json.suggestedPreset === "string" && out.json.suggestedPreset) { try { deps.onSuggestedPreset(out.json.suggestedPreset); } catch { /* a face that cannot be applied stays as it is */ } }
  }

  function removed(removedAt: number | null): void {
    clearState();
    try { deps.onRemoved(removedAt); } catch { /* the next connect asks again */ }
    say("place: the phone disconnected this desktop");
  }

  async function runGet(wake: string | null): Promise<void> {
    const userId = deps.userId();
    if (!userId || stopped) return;
    let runningIds: string[] = [];
    try { runningIds = (runningProvider?.() ?? []).filter((id) => /^h_[a-f0-9]{64}$/.test(id)).slice(0, 40); } catch { runningIds = []; }
    const query = `hostId=${encodeURIComponent(deps.hostId)}${wake ? `&wake=${encodeURIComponent(wake)}` : ""}${runningIds.length ? `&running=${runningIds.join(",")}` : ""}`;
    const out = await call("GET", `/api/desktop/plural?${query}`);
    if (!out) { say("place read: not reached"); return; }
    if (out.status === 404) { switchClosed = true; return; }
    if (out.status !== 200) { say(`place read: refused (${out.status})`); return; }
    switchClosed = false;
    const answer = parsePluralAnswer(out.json, wake);
    if (!answer) { say("place read: answer not understood"); return; }
    last = answer;
    for (const listener of [...listeners]) { try { listener(answer); } catch { /* a listener never changes the answer */ } }
    if (answer.removed) { removed(answer.removedAt); return; }
    const values = deps.values();
    if (!answer.known || (values !== null && !reported(userId, placeDigest(withReportablePaths(values, !pathsRefused))))) await report(userId);
  }

  async function runValues(): Promise<void> {
    const userId = deps.userId();
    if (!userId || stopped || switchClosed) return;
    const values = deps.values();
    if (!values || reported(userId, placeDigest(withReportablePaths(values, !pathsRefused)))) return;
    await report(userId);
  }

  /** One request at a time; events that arrive while one is in flight are folded (the newest wake id wins, one pending report check). */
  let draining: Promise<void> | null = null;
  function enqueue(): Promise<void> {
    if (!draining) {
      draining = (async () => {
        try {
          while (!stopped && (pendingGet || pendingValues)) {
            const get = pendingGet;
            pendingGet = null; pendingValues = false;   // a GET also checks the digest, so a report check folded into it is not asked twice
            try { if (get) await runGet(get.wake); else await runValues(); } catch { /* never throws into the bridge */ }
          }
        } finally { draining = null; }   // no await between the loop test and here: an event cannot fall in between
      })();
    }
    return draining;
  }

  return {
    connect() { switchClosed = false; pendingGet = { wake: pendingGet?.wake ?? null }; return enqueue(); },
    wake(id) {
      if (typeof id !== "string" || !WAKE_ID.test(id)) return Promise.resolve();
      pendingGet = { wake: id };
      return enqueue();
    },
    read() { if (switchClosed) return Promise.resolve(); pendingGet = { wake: pendingGet?.wake ?? null }; return enqueue(); },
    valuesChanged() { if (switchClosed) return Promise.resolve(); pendingValues = true; return enqueue(); },
    stop() { stopped = true; pendingGet = null; pendingValues = false; },
  };
}

/**
 * The phone disconnected this desktop while the bridge could not be told (the desktop was off or unreachable): forget the pairing records the way the phone's own disconnect does
 * (`device.revokeSelf` -> cause `device_requested`; the bridge's change hook then hands back what the phone held and tells the window, so the list of connected phones follows at once).
 * ONLY the pairings that account made BEFORE the server's `removedAt` are the one that was disconnected: another phone, another account's pairing, a managed (cloud) pairing, and a pairing made after the
 * disconnect (a new QR) all stay. No `removedAt` (an older server), no account, or a record that names no account (an old record): nothing is forgotten. The caller remembers the `removedAt` it has handled.
 */
export function revokeRemovedPairings(pairing: {
  listDevices(): Array<{ deviceId: string; issuedAt: string; revokedAt: string | null }>;
  revokeDevice(deviceId: string, cause: "device_requested"): boolean;
  deviceAccountBinding(deviceId: string): { ownerUserId: string | null } | null;
  phoneTrustRecord?(deviceId: string): { pairedVia: string | null } | null;
}, removedAt: number | null, userId: string | null): number {
  if (removedAt === null || !userId) return 0;
  let revoked = 0;
  for (const device of pairing.listDevices()) {
    if (device.revokedAt !== null) continue;
    if (pairing.deviceAccountBinding(device.deviceId)?.ownerUserId !== userId) continue;
    if (pairing.phoneTrustRecord?.(device.deviceId)?.pairedVia === "managed") continue;
    const issued = Date.parse(device.issuedAt);
    if (!Number.isFinite(issued) || issued >= removedAt) continue;
    if (pairing.revokeDevice(device.deviceId, "device_requested")) revoked += 1;
  }
  return revoked;
}

/**
 * What the bridge does with "the phone disconnected this desktop" (`onRemoved`): forget this account's pairings made before `removedAt`, ONCE per `removedAt`. The server keeps the mark until the phone clears it, so
 * every later read repeats it; the instant that was handled is kept in the account's own meta row (`places_removed_at:v1:<userId>`, one small row per account, read at every repeat, overwritten by a later removal, gone with
 * the account's meta rows) and a mark that is not newer is not handled again. Returns how many pairings were forgotten.
 */
export function applyRemoval(
  pairing: Parameters<typeof revokeRemovedPairings>[0], removedAt: number | null, userId: string | null,
  meta: { get(key: string): string | null; set(key: string, value: string): void },
): number {
  if (removedAt === null || !userId) return 0;
  const key = `places_removed_at:v1:${userId}`;
  const done = Number(meta.get(key));
  if (Number.isFinite(done) && done >= removedAt) return 0;
  const revoked = revokeRemovedPairings(pairing, removedAt, userId);
  meta.set(key, String(removedAt));
  return revoked;
}
