/**
 * The personal agent's home as the screen reads it (Agentlas 2.0 F-D15 / F-D16). Pure functions over `oneHome.status()`; nothing here calls the app.
 * Values come from the contract only (contracts/one-home-desktop.md §8, one-home-move.md §3.3 / §5): a value the status does not carry is `null` and the
 * screen draws no line for it. Names inside the status (`label`, `computer`) are untrusted text: screen values only, never a prompt or a key.
 */
import type { OneHomeStatus } from "@shared/types";
import type { Lang } from "./one-home-copy";

export type HomeKind = "server" | "moving" | "home" | "unconfirmed" | "sealed" | "away" | "elsewhere";

/** The one word for where the personal agent lives, as this computer sees it. */
export function homeKindOf(s: OneHomeStatus): HomeKind {
  // A move of this desktop that has done everything but wait for the owner to confirm the connection is the unconfirmed connection itself: the screen draws its two buttons, not a "moving" card with none (contract home-move-phone-card R7).
  if (s.move && s.move.role === "receiver") return importWaitsForConfirm(s) ? "unconfirmed" : "moving";
  if (s.state === "sealed") return "sealed";
  if (s.state === "away") return "away";
  if (s.state === "home") return s.pointer?.homeTrust === "unconfirmed" ? "unconfirmed" : "home";
  // `legacy`: the home is the server, or another computer this one never was the home of.
  return s.pointer?.home.kind === "desktop" && s.pointer.home.hostId !== s.hostId ? "elsewhere" : "server";
}

/** Time values arrive as a number (ms) or an ISO string. */
export function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** "2 days 21 hours" / "5 hours" / "under an hour" from a remaining time; null when the end is unknown or already past. */
export function remainingOf(untilMs: number | null, nowMs: number): { days: number; hours: number } | null {
  if (untilMs === null || untilMs <= nowMs) return null;
  const hours = Math.floor((untilMs - nowMs) / 3_600_000);
  return { days: Math.floor(hours / 24), hours: hours % 24 };
}

/** The receiver's steps in the order the move runs them (one-home-move.md §3.3 / §16.1). A step that is not in the list has no "n / total". */
const RECEIVER_STEPS: Record<"server" | "desktop", readonly string[]> = {
  server: ["claimed", "requested", "fetched", "checked", "committed", "imported", "caughtUp", "reported"],
  desktop: ["requested", "fetched", "checked", "committed", "imported", "reported"],
};
export function stepProgress(move: NonNullable<OneHomeStatus["move"]>): { n: number; total: number } | null {
  if (move.role !== "receiver") return null;
  const list = RECEIVER_STEPS[move.from];
  const at = list.indexOf(move.step);
  return at < 0 ? null : { n: at + 1, total: list.length };
}
/** A receiver's move that has not committed yet can still be cancelled (`cancelMove` answers `already_committed` after that). */
export function cancellableStep(move: NonNullable<OneHomeStatus["move"]>): boolean {
  if (move.role !== "receiver") return false;
  const list = RECEIVER_STEPS[move.from];
  const at = list.indexOf(move.step);
  return at >= 0 && at < list.indexOf("committed");
}

export interface DeviceRow {
  key: string;
  kind: "this" | "phone" | "desktop";
  name: string;
  /** Phone rows: how far the "desktop work" door is. `this` rows: trusted = this computer is the confirmed home. */
  state: "trusted" | "press" | "register_first" | "pair_again" | "new" | "other";
  /**
   * Which of the two lists the row belongs to (contracts/trust-root.md section 1 / 3): "desktop" = introduced by the desktop that is the connected one NOW (this computer itself while it is the connected desktop, or a key
   * that desktop vouched for: the status says it as `desktopWork`, the server's `viaHome`); "server" = everything else. Where the status does not say (an older server, a phone with no server line), the weaker list is the safe side
   * for a device this window did not pair, and this computer's own pairing record decides only while this computer is the connected desktop.
   */
  group: "desktop" | "server";
  /** How the device came to be trusted, as the status says it: a screen QR, a press on this computer, or the device registered itself. */
  how: "qr" | "confirmed" | "direct" | null;
  deviceId?: string;
  kid?: string;
  pairedVia?: string | null;
  registeredAtMs?: number | null;
  /** The one date the row shows: the QR connection for a row that says "QR connected", the key's registration otherwise; null when the status has none (no date is drawn). */
  dateMs?: number | null;
  /** New (registered, not yet trusted) device: when the server lets it count as trusted. */
  matureAtMs?: number | null;
  home?: boolean;
  /** The owner already confirmed cutting this key and the server has not taken it yet (Main cuts it when the server answers): the row is drawn without a button, "revoking, waiting for the server". */
  revoking?: boolean;
}
function recordOf(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? v as Record<string, unknown> : {}; }

/** The list under "Trusted devices": this computer, the phones paired with it, and devices the server lists that this window has not paired itself. */
export function deviceRows(s: OneHomeStatus): DeviceRow[] {
  const rows: DeviceRow[] = [];
  const phoneKids = new Set(s.phones.map((p) => p.kid).filter(Boolean) as string[]);
  const serverLines = [...(s.pointer?.pendingDevices ?? []), ...(s.pointer?.devices ?? [])].map(recordOf);
  const lineOf = (kid: string | undefined): Record<string, unknown> | undefined => (kid ? serverLines.find((d) => d.kid === kid) : undefined);
  const registeredAt = (kid: string | undefined): number | null => { const line = lineOf(kid); return line ? toMs(line.registeredAt) : null; };
  // A device the server just registered to the account and that is not trusted yet comes first: it is the one the owner is asked about.
  for (const raw of [...(s.pointer?.pendingDevices ?? []), ...(s.pointer?.devices ?? [])]) {
    const d = recordOf(raw);
    const kid = typeof d.kid === "string" ? d.kid : null;
    if (!kid || kid === s.kid || phoneKids.has(kid) || rows.some((r) => r.kid === kid)) continue;
    const trusted = d.trust === "home" || d.mayConfirm === true;
    const pending = (s.pointer?.pendingDevices ?? []).some((p) => recordOf(p).kid === kid);
    // A key the connected desktop of now vouched for (the server's word, `desktopWork`): in the first list, "QR connected" since a vouch only comes from a QR pairing. The server saying it did not (false) sends the key to the second list with the way up.
    const vouched = d.desktopWork === true && !pending;
    const notVouched = d.desktopWork === false && !pending && d.kind !== "desktop";
    const revoking = d.revoking === true;
    rows.push({
      key: "srv:" + kid, kind: d.kind === "desktop" ? "desktop" : "phone", name: typeof d.label === "string" && d.label ? d.label : "",
      ...(revoking ? { revoking: true } : {}),
      state: revoking ? "other" : pending && !trusted ? "new" : vouched ? "trusted" : notVouched ? "pair_again" : trusted ? "trusted" : "other",
      group: vouched ? "desktop" : "server", how: vouched ? "qr" : notVouched || d.kind === "desktop" ? null : "direct", kid, registeredAtMs: toMs(d.registeredAt), matureAtMs: toMs(d.matureAt),
      dateMs: vouched ? toMs(d.trustedAt) ?? toMs(d.registeredAt) : toMs(d.registeredAt),
    });
  }
  rows.sort((a, b) => (a.state === "new" ? 0 : 1) - (b.state === "new" ? 0 : 1));
  rows.push({ key: "this", kind: "this", name: "", state: s.state === "home" && s.pointer?.homeTrust === "confirmed" ? "trusted" : "other", group: s.state === "home" ? "desktop" : "server", how: null, home: s.state === "home" });
  for (const p of s.phones) {
    // `desktopWork` is the status's own verdict (the server's word, or this computer's record while it is the connected desktop); an older status without it is read as before: by the pairing record.
    const work = typeof p.desktopWork === "boolean" ? p.desktopWork : p.vouch === "eligible";
    // A phone this desktop recorded as QR-paired that the connected desktop of now did not vouch for (the connection changed since): the lower list, with the way up, and no "paired by QR" claim.
    const state: DeviceRow["state"] = work ? "trusted" : p.vouch === "owner_press_needed" ? (p.keyRegistered === false ? "register_first" : "press") : "pair_again";
    const how: DeviceRow["how"] = work ? (p.vouch === "eligible" && p.pairedVia === "owner-confirmed" ? "confirmed" : "qr") : p.vouch === "eligible" ? null : "direct";
    const dateMs = how === "qr" || how === "confirmed" ? (typeof p.pairedAt === "number" ? p.pairedAt : null) ?? toMs(lineOf(p.kid)?.trustedAt) ?? registeredAt(p.kid) : registeredAt(p.kid) ?? (how === null && typeof p.pairedAt === "number" ? p.pairedAt : null);
    rows.push({ key: "phone:" + p.deviceId, kind: "phone", name: p.name, state, group: work ? "desktop" : "server", how, deviceId: p.deviceId, kid: p.kid, pairedVia: p.pairedVia, registeredAtMs: registeredAt(p.kid), dateMs });
  }
  // New devices first (they are the ones the owner is asked about), then this desktop, then the rest in the order the lists gave them.
  const rank = (r: DeviceRow): number => (r.state === "new" ? 0 : r.kind === "this" ? 1 : 2);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** The screen's "same line" for a result code: the table lives in one-home-copy.ts. */
export interface ActionLine { code: string; detail?: string; count?: number }
export function lineOf(r: { ok: boolean; code?: string; detail?: string; count?: number } | null | undefined): ActionLine | null {
  if (!r || r.ok) return null;
  return { code: r.code ?? "unknown", detail: r.detail, count: r.count };
}

/** This desktop is the connected desktop, the server calls the connection unconfirmed, and its receiving move waits for exactly that (the move's own word `home_unconfirmed`): only the owner's answer ends the wait. */
export function importWaitsForConfirm(s: OneHomeStatus): boolean {
  return s.move?.role === "receiver" && s.move.waiting === "home_unconfirmed" && s.state === "home" && s.pointer?.homeTrust === "unconfirmed";
}

/**
 * An unconfirmed connection as this desktop sees it (Agentlas 2.0 AP / AQ / AR). `new`: this desktop is the connected desktop. `previous`: the connection was changed AWAY from this desktop (the server's `trustInfo.fromHome` is this desktop), so
 * this desktop is the one whose key can still undo it. Any other desktop, and a confirmed connection, is null: nothing is drawn for it. Every value is the pointer's own; a value it does not carry is null and its part of the line is not drawn.
 */
export interface PendingConnection {
  role: "new" | "previous";
  sinceMs: number | null;
  /** The server's date of the automatic confirmation (`trustInfo.hardenAt`). */
  hardenMs: number | null;
  /** `new` only: the move of this desktop waits for the owner's confirmation. "server" = it then brings the server's chats and memory; "other" = it brought a computer's records already. */
  importWait: "server" | "other" | null;
  /** [Yes, it was me] / [Revert]: "ask" = draw the button (the server decides at the press), "no" = the pointer itself proves the server will refuse (this key's own line), so no button. */
  confirm: "ask" | "no";
  revert: "ask" | "no";
}
export function pendingOf(s: OneHomeStatus): PendingConnection | null {
  const p = s.pointer;
  if (!p || p.homeTrust !== "unconfirmed") return null;
  const info = recordOf((p as { trustInfo?: unknown }).trustInfo);
  const sinceMs = toMs(info.sinceAt), hardenMs = toMs(info.hardenAt);
  const kind = homeKindOf(s);
  if (kind === "unconfirmed") {
    const mine = (list: Array<Record<string, unknown>>): Record<string, unknown> | undefined => (s.kid ? list.map(recordOf).find((d) => d.kid === s.kid) : undefined);
    const own = mine(p.devices), waiting = mine(p.pendingDevices);
    // The server's rules, read from this key's own line (the same rule and the same two values as the phone, mobile 0519061): [Yes, it was me] = the server's own word `mayConfirm: false` removes it; a key not trusted yet can do neither.
    // [Revert] = the server asks for the key of the home before or a key trusted BEFORE the change (`store.ts` revertHome): a key with no line in `devices` (the home's own key has none), a key trusted at or after `trustInfo.sinceAt`, and
    // a key with no trust is a certain refusal, so no button. Only a date the pointer did not give (the line's `trustedAt`, or `sinceAt`), or no key id of this desktop's own, leaves the server to decide: the button is drawn.
    const trustedMs = toMs(own?.trustedAt);
    const revert: "ask" | "no" = !s.kid ? "ask" : waiting || !own || own.trust === "none" ? "no" : trustedMs !== null && sinceMs !== null && trustedMs >= sinceMs ? "no" : "ask";
    return {
      role: "new", sinceMs, hardenMs,
      importWait: importWaitsForConfirm(s) ? (s.move?.from === "server" ? "server" : "other") : null,
      confirm: waiting || own?.mayConfirm === false ? "no" : "ask",
      revert,
    };
  }
  if (kind === "away" && s.state === "away") {
    const from = recordOf(info.fromHome);
    if (from.kind === "desktop" && s.hostId && from.hostId === s.hostId) return { role: "previous", sinceMs, hardenMs, importWait: null, confirm: "no", revert: "ask" };
  }
  return null;
}

/** The parts of the one line of an unconfirmed connection, from the server's dates by the server's clock (`nowMs`): "11/12 changed" and "confirms in 23 days"; a part whose value is missing is null. `urgent`: the last 7 days (the caution icon, the same 7 days as the one notice Main shows: home-harden-notice.ts). */
export function pendingParts(p: PendingConnection, lang: Lang, nowMs: number): { since: string | null; left: string | null; urgent: boolean } {
  const ko = lang === "ko";
  const at = p.sinceMs !== null ? new Date(p.sinceMs) : null;
  const day = at ? `${at.getMonth() + 1}/${at.getDate()}` : null;
  const r = remainingOf(p.hardenMs, nowMs);
  const span = r ? (r.days > 0 ? (ko ? `${r.days}일` : `${r.days} day${r.days > 1 ? "s" : ""}`) : (ko ? `${Math.max(1, r.hours)}시간` : `${Math.max(1, r.hours)} hour${r.hours > 1 ? "s" : ""}`)) : null;
  return {
    since: day ? (ko ? `${day} 변경` : `moved ${day}`) : null,
    left: span ? (ko ? `${span} 후 자동 확정` : `confirms in ${span}`) : null,
    urgent: p.role === "new" && p.hardenMs !== null && p.hardenMs > nowMs && p.hardenMs - nowMs <= 7 * 86_400_000,
  };
}
