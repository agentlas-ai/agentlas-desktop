/*
 * The eight ports of `BundleHost` (bundle.ts) filled with this computer's own stores (Agentlas 2.0 O-M3b, contracts/one-home-move.md §4 last lines).
 * One function builds the host for one move step; nothing here holds state. Every source is an injected function, so a gate drives the same code with synthetic homes,
 * and the real wiring (`realBundleSources`) is lazy: no Electron import, no store opened until a step asks.
 *
 * What comes back from a bundle (profile, avatar, settings, reconnect names) is untrusted input: this file only applies what it can check (profile through the profile
 * table in server-import.ts; an avatar only when its bytes are a PNG, JPEG or WebP and the local avatar is still the default). Nothing from it goes into a prompt or a log.
 */
import type Database from "better-sqlite3";
import type { BundleCheckin, BundleHost, ReconnectNames, SeedTurn } from "./bundle";
import { DEFAULT_AVATAR_ICON, DEFAULT_DISPLAY_NAME, type LocalProfileView, type ProfilePatch } from "./server-import";

export interface BundleSources {
  db(): Database.Database;
  oneId(): string;
  profile(): (LocalProfileView & { oneId?: string; [key: string]: unknown }) | null;
  /** Writes the changed fields into the profile (the profile's own validation applies and may throw: the caller counts it as "not applied"). */
  applyProfile(patch: ProfilePatch): void;
  avatarBytes(): Buffer | null;
  writeAvatar(bytes: Buffer, extension: "png" | "jpg" | "webp"): void;
  settings(): Record<string, unknown> | null;
  applySettings(value: Record<string, unknown>): void;
  reconnect(): ReconnectNames | null;
  checkinsRead(): BundleCheckin[];
  checkinsMerge(rows: BundleCheckin[]): number | { added: number; dropped: number };
  ensurePersonalChat(): string | null;
  plantContextSeed(packId: string, turns: SeedTurn[]): boolean;
  activeWorkCount(): number;
  /** Older versions of Personal lines (replaced by an owner edit) held here: they are not live lines, so a purge leaves them (optional: a source without it says nothing). */
  olderVersionCount?(): number;
  /** The receiving store's original-wording table must exist before an import (N-2; see `BundleHost.ensureNativeTable`). */
  ensureNativeTable?(): void;
}

/** The profile keys a computer-to-computer move carries and applies (nothing else is read from `profile.json`). */
export const PROFILE_KEYS = ["displayName", "role", "profileContext", "preferredLocale", "timeZone", "avatarIcon", "bubbleColor"] as const;

export function createBundleHost(src: BundleSources): BundleHost {
  return {
    db: src.db(),
    oneId: src.oneId(),
    profile: () => {
      const p = src.profile();
      if (!p) return null;
      const out: Record<string, unknown> = {};
      for (const k of PROFILE_KEYS) if (p[k] !== undefined) out[k] = p[k];
      return out;
    },
    avatar: () => src.avatarBytes(),
    settings: () => src.settings(),
    reconnect: () => src.reconnect(),
    checkins: { read: () => src.checkinsRead(), merge: (rows) => src.checkinsMerge(rows) },
    ensurePersonalChat: () => src.ensurePersonalChat(),
    plantContextSeed: (packId, turns) => src.plantContextSeed(packId, turns),
    activeWorkCount: () => src.activeWorkCount(),
    ...(src.olderVersionCount ? { olderVersionCount: () => src.olderVersionCount!() } : {}),
    ...(src.ensureNativeTable ? { ensureNativeTable: () => src.ensureNativeTable!() } : {}),
  };
}

const imageExtension = (b: Buffer): "png" | "jpg" | "webp" | null =>
  b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 ? "jpg"
      : b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;

export interface HandedBack { profile?: Record<string, unknown> | null; avatar?: Buffer | null; settings?: Record<string, unknown> | null }
export interface HandedBackResult { applied: string[]; ask: { here: { displayName: string; avatarIcon: string; profileContext?: string }; incoming: { displayName?: string; avatarIcon?: string; profileContext?: string } } | null; avatarApplied: boolean; settingsApplied: boolean }

/**
 * Computer-to-computer: `importStaged` hands the sender's profile, avatar and settings back un-applied. A value the owner has not touched here (the default) takes the sender's;
 * both touched and different = one question (`ask`); `oneId` is never taken. Only closed, checked keys are read from untrusted JSON.
 */
export function applyHandedBack(src: BundleSources, back: HandedBack): HandedBackResult {
  const here = src.profile();
  const result: HandedBackResult = { applied: [], ask: null, avatarApplied: false, settingsApplied: false };
  const incoming = back.profile ?? null;
  if (here && incoming) {
    const patch: ProfilePatch = {};
    const incomingAsk: { displayName?: string; avatarIcon?: string; profileContext?: string } = {};
    let conflict = false;
    const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
    const name = str(incoming.displayName, 64)?.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim() || null;
    if (name && name !== here.displayName) { if (here.displayName === DEFAULT_DISPLAY_NAME) patch.displayName = name; else { incomingAsk.displayName = name; conflict = true; } }
    const icon = str(incoming.avatarIcon, 160);
    if (icon && /^character:[a-z0-9][a-z0-9-]{0,60}$/.test(icon) && icon !== here.avatarIcon) { if (here.avatarIcon === DEFAULT_AVATAR_ICON) patch.avatarIcon = icon; else { incomingAsk.avatarIcon = icon; conflict = true; } }
    // The text the owner wrote about themselves goes into every model turn as "User-authored context", so a bundle never sets it, not even over an empty one (F-9): a different text is asked about, like a name.
    // A move of the whole profile is the owner's own move, so the question is one yes or no; the answer `incoming` applies it (home-move.ts answerProfile).
    const ctx = str(incoming.profileContext, 4_000);
    if (ctx !== null && ctx.trim() && ctx.trim() !== here.profileContext.trim()) { incomingAsk.profileContext = ctx; conflict = true; }
    const loc = str(incoming.preferredLocale, 16);
    if (loc && here.preferredLocale === "system" && loc !== "system") patch.preferredLocale = loc;
    const tz = str(incoming.timeZone, 128);
    if (tz && !here.timeZone) patch.timeZone = tz;
    // A computer-to-computer move carries the whole profile (design 5.8.6): the role and the bubble colour too, when this computer has not set its own.
    const role = str(incoming.role, 120);
    if (role && (here as { role?: unknown }).role === "Agentlas One" && role !== "Agentlas One") patch.role = role;
    const bubble = str(incoming.bubbleColor, 32);
    if (bubble && /^#?[A-Za-z0-9]{3,32}$/.test(bubble) && (here as { bubbleColor?: unknown }).bubbleColor === undefined) patch.bubbleColor = bubble;
    if (Object.keys(patch).length) { try { src.applyProfile(patch); result.applied = Object.keys(patch); } catch { result.applied = []; } }
    if (conflict) result.ask = { here: { displayName: here.displayName, avatarIcon: here.avatarIcon, ...(incomingAsk.profileContext !== undefined ? { profileContext: here.profileContext } : {}) }, incoming: incomingAsk };
  }
  if (back.avatar && here && here.avatarIcon === DEFAULT_AVATAR_ICON) {
    const ext = imageExtension(back.avatar);
    if (ext) { try { src.writeAvatar(back.avatar, ext); result.avatarApplied = true; } catch { /* not applied */ } }
  }
  if (back.settings) { try { src.applySettings(back.settings); result.settingsApplied = true; } catch { /* not applied */ } }
  return result;
}
