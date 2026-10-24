/**
 * Company seat token for this Desktop (API-CONTRACT.md §4.2). A device Ed25519 key is created once and kept in the
 * user data folder (0600); enrollment uses the one-time code from the company admin; refresh is signed by the device
 * key only (no shared secret). Tokens are accepted only when signed by the server key whose SHA-256 fingerprint the
 * managed configuration pins. Pure Node — no Electron import.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EnterpriseServerConnection } from "./connection";

export const SEAT_TOKEN_TYP = "agentlas-seat+jwt";
export interface SeatTokenClaims { iss: string; sub: string; dev: string; org: string; mode: "full" | "readonly"; feat: string[]; iat: number; exp: number }
export interface DeviceIdentity { deviceId: string; privateKey: KeyObject; publicKey: string }
export interface SeatState { token: string; claims: SeatTokenClaims; serverPublicKey: string }

const b64u = (b: Buffer) => b.toString("base64url");
const rawPub = (k: KeyObject) => String((createPublicKey(k).export({ format: "jwk" }) as { x?: string }).x);
const pubFromRaw = (raw: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
export const fingerprintOf = (rawPublicKey: string) => createHash("sha256").update(Buffer.from(rawPublicKey, "base64url")).digest("hex");

export function loadOrCreateDeviceIdentity(dir: string): DeviceIdentity {
  const file = path.join(dir, "device.json");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ deviceId: randomUUID(), privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { deviceId: string; privateKeyPkcs8: string };
  const privateKey = createPrivateKey({ key: Buffer.from(raw.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" });
  return { deviceId: raw.deviceId, privateKey, publicKey: rawPub(privateKey) };
}

/** Verify a seat token against the pinned server key. Returns claims or null — never trusts an unpinned key. */
export function verifySeatToken(token: string, serverPublicKey: string, pinnedFingerprint: string, nowMs = Date.now()): SeatTokenClaims | null {
  if (fingerprintOf(serverPublicKey) !== pinnedFingerprint) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as SeatTokenClaims;
    if (header.alg !== "EdDSA" || header.typ !== SEAT_TOKEN_TYP) return null;
    const sig = Buffer.from(parts[2], "base64url");
    if (sig.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pubFromRaw(serverPublicKey), sig)) return null;
    const now = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now || (claims.mode !== "full" && claims.mode !== "readonly")) return null;
    return claims;
  } catch { return null; }
}

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error" });
  let json: Record<string, unknown> | null = null;
  try { json = await res.json() as Record<string, unknown>; } catch { json = null; }
  return { status: res.status, json };
}

export class SeatError extends Error { constructor(readonly code: string) { super(code); } }

export interface SeatClientOptions { connection: EnterpriseServerConnection; stateDir: string; appVersion: string; platform?: NodeJS.Platform; fetchImpl?: typeof fetch; now?: () => number }

/** Enroll (once, with a code) and keep a fresh token. State is cached in stateDir/seat.json (0600). */
export function createSeatClient(opts: SeatClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch, now = opts.now ?? Date.now;
  const identity = loadOrCreateDeviceIdentity(opts.stateDir);
  const stateFile = path.join(opts.stateDir, "seat.json");
  let state: SeatState | null = null;
  // The pinned server key this device enrolled with. It outlives an expired token so the device key alone can refresh after
  // the Desktop was off or offline longer than the token's 12 hours (the server needs no new code for that).
  let knownServerKey: string | null = null;
  try {
    const cached = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { token: string; serverPublicKey: string };
    if (typeof cached.serverPublicKey === "string" && fingerprintOf(cached.serverPublicKey) === opts.connection.serverKeyFingerprint) knownServerKey = cached.serverPublicKey;
    const claims = verifySeatToken(cached.token, cached.serverPublicKey, opts.connection.serverKeyFingerprint, now());
    if (claims && claims.dev === identity.deviceId) state = { token: cached.token, claims, serverPublicKey: cached.serverPublicKey };
  } catch { state = null; }
  const persist = (s: SeatState) => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ token: s.token, serverPublicKey: s.serverPublicKey }), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };
  function accept(token: unknown, serverPublicKey: unknown): SeatState {
    if (typeof token !== "string" || typeof serverPublicKey !== "string") throw new SeatError("seat_response_invalid");
    const claims = verifySeatToken(token, serverPublicKey, opts.connection.serverKeyFingerprint, now());
    if (!claims || claims.dev !== identity.deviceId) throw new SeatError("seat_token_untrusted");
    state = { token, claims, serverPublicKey }; knownServerKey = serverPublicKey; persist(state); return state;
  }
  return {
    deviceId: identity.deviceId,
    current(): SeatState | null { return state && state.claims.exp * 1000 > now() ? state : null; },
    /** This device enrolled with the pinned server (a token may have expired since; refresh still works). */
    enrolled(): boolean { return knownServerKey !== null; },
    async enroll(code = opts.connection.enrollmentCode): Promise<SeatState> {
      if (!code) throw new SeatError("enrollment_code_required");
      const r = await postJson(`${opts.connection.serverUrl}/api/v1/devices/enroll`, { enrollmentCode: code, deviceId: identity.deviceId,
        devicePublicKey: identity.publicKey, platform: opts.platform ?? process.platform, appVersion: opts.appVersion }, fetchImpl);
      if (r.status !== 200 || !r.json) throw new SeatError(String(r.json?.error ?? `http_${r.status}`));
      return accept(r.json.token, r.json.serverPublicKey);
    },
    async refresh(): Promise<SeatState> {
      const serverPublicKey = state?.serverPublicKey ?? knownServerKey;
      if (!serverPublicKey) throw new SeatError("not_enrolled");
      const timestamp = now();
      const signature = b64u(sign(null, Buffer.from(`agentlas-es-device-v1\n${identity.deviceId}\n${timestamp}`), identity.privateKey));
      const r = await postJson(`${opts.connection.serverUrl}/api/v1/devices/token`, { deviceId: identity.deviceId, timestamp, signature, appVersion: opts.appVersion }, fetchImpl);
      if (r.status !== 200 || !r.json) throw new SeatError(String(r.json?.error ?? `http_${r.status}`));
      return accept(r.json.token, serverPublicKey);
    },
    /** Business features are on only with a live, pinned token. `readonly` keeps reading on, new work off. */
    businessMode(): "full" | "readonly" | "off" { const s = this.current(); return s ? s.claims.mode : "off"; },
  };
}
export type SeatClient = ReturnType<typeof createSeatClient>;
