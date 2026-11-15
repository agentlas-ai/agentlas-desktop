/*
 * A key cut that the owner already confirmed, whose server half could not be done yet. The pure rules; home.ts holds the one stored value and the one call.
 *
 * What is kept: `revokeOwed` in the account's own home record (the row `one_home:v1:<userId>`, the one `hardenTold` already lives in) - a list of `{ kid, at }`, at most OWED_MAX lines.
 * No new table, file, timer or poll.
 *   Written by: home.ts `revokeKeyAndPairing`, only after the owner pressed [Disconnect] for exactly that `kid` and the server answered a "wait" word (nothing reached it, or it was down).
 *   Read by:    (1) the pointer read that just succeeded (`afterRead`: the one signal that says "the server answers now" - it already runs on focus, wake, restore and the sweep; nothing here adds one),
 *               (2) `status()` (the list draws that line without a button: "revoking, waiting for the server").
 *   Erased:     the server no longer has the line (done by this computer, by another, or by the key's own expiry) - the call answered "done" - the server refused for good (this computer may not cut it) - this computer
 *               sees the same phone connected again (a pairing record carries the kid again) - the line on the server is newer than the owner's press (a key that registered again is not the one the owner confirmed) -
 *               another account is seen (`leaveAccount`) - the account slot is forgotten. The confirmation is for ONE `kid`; it is never used for another key or another account.
 * Closed values only: a `kid` and a number. No name, no sentence.
 */
/** The same shape as home.ts `KID_RE` (the first 22 base64url characters of the key's sha-256); written here so this file imports nothing from home.ts. */
const KID_RE = /^[A-Za-z0-9_-]{22}$/;

export interface OwedRevoke { kid: string; at: number }
/** The server keeps at most 8 device keys (`DEVICE_KEYS_MAX`, pointer contract section 9): a longer list could never be true. */
export const OWED_MAX = 8;

export function readOwed(raw: unknown): OwedRevoke[] {
  if (!Array.isArray(raw)) return [];
  const out: OwedRevoke[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const { kid, at } = v as { kid?: unknown; at?: unknown };
    if (typeof kid !== "string" || !KID_RE.test(kid) || typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    if (out.some((o) => o.kid === kid)) continue;
    out.push({ kid, at });
  }
  return out.slice(-OWED_MAX);
}
export const addOwed = (list: readonly OwedRevoke[], kid: string, at: number): OwedRevoke[] => readOwed([...list.filter((o) => o.kid !== kid), { kid, at }]);
export const withoutOwed = (list: readonly OwedRevoke[], kids: readonly string[]): OwedRevoke[] => list.filter((o) => !kids.includes(o.kid));

/** A time of the server's lines as ms: a number in seconds or ms, or an ISO string; null when there is none. */
export function msOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; }
  return null;
}

export type CutOutcome = { ok: boolean; code?: string; status?: number; unreachable?: boolean; retryable?: boolean };
/**
 * What the server's answer to `device/revoke` means for the owed cut.
 *   done    - the key is gone (or the server never had it).
 *   wait    - the server did not decide (nothing reached it, it was busy or shut its writes for a moment): the next successful pointer read tries once more.
 *   refused - the server decided or this computer cannot ask (it may not cut that key, no key here, a malformed ask): trying again changes nothing.
 */
export function cutVerdict(out: CutOutcome): "done" | "wait" | "refused" {
  if (out.ok || out.code === "device_not_found") return "done";
  if (out.unreachable === true || out.retryable === true) return "wait";
  if (typeof out.status === "number" && (out.status >= 500 || out.status === 429)) return "wait";
  if (out.code === "device_proof_unavailable" || out.code === "one_home_unavailable") return "wait";
  return "refused";
}

type Line = Record<string, unknown>;
export interface AuthorityInput {
  /** The record's kid of THIS computer's key, and whether this computer is the living (connected) home. */
  ownKid: string | null;
  livingHome: boolean;
  homeTrust: "confirmed" | "unconfirmed";
  lines: readonly Line[];   // pendingDevices + devices of the pointer
  target: string;
}
/**
 * Could the server take this computer's cut of `target`? The server's own rule (web `store.ts revokeDevice`), read from the pointer's lines:
 * the connected desktop may cut any key (while its own connection is unconfirmed, not a key trusted before that - the pointer does not say which, so "unknown");
 * a registered key may cut a key that was trusted later or not at all. "no" is only said when the pointer proves it; anything else is "unknown" and the server decides.
 */
export function revokeAuthority(i: AuthorityInput): "yes" | "no" | "unknown" {
  const target = i.lines.find((l) => l.kid === i.target);
  if (!target) return "unknown";   // not a line of the server any more: the caller treats that as done
  if (i.livingHome) {
    if (i.homeTrust === "confirmed") return "yes";
    return target.trust === "none" || target.trust === undefined ? "yes" : "unknown";
  }
  const own = i.ownKid ? i.lines.find((l) => l.kid === i.ownKid) : undefined;
  if (!own) return "no";   // a key the server does not list signs nothing (`unknown_key`)
  if (own.trust !== "home" && own.trust !== "aged") return "no";
  if (target.trust === "none" || target.trust === undefined) return "yes";
  const o = msOf(own.trustedAt), t = msOf(target.trustedAt);
  if (o === null || t === null) return "unknown";
  return o <= t ? "yes" : "no";
}

export type OwedStep = "drop_gone" | "drop_reconnected" | "drop_newer" | "drop_refused" | "call";
/** One owed line against the pointer just read: what to do. No call is made for a line the server no longer has, a phone that is connected again, a key that registered after the press, or a key this computer may not cut. */
export function owedStep(i: { owed: OwedRevoke; lines: readonly Line[]; reconnected: boolean; authority: "yes" | "no" | "unknown" }): OwedStep {
  const line = i.lines.find((l) => l.kid === i.owed.kid);
  if (!line) return "drop_gone";
  if (i.reconnected) return "drop_reconnected";
  const registered = msOf(line.registeredAt);
  if (registered !== null && registered > i.owed.at) return "drop_newer";
  if (i.authority === "no") return "drop_refused";
  return "call";
}
