/**
 * Pure rules of the "My rules" screen (F-D11): which state lines the backend's answer produces, how a refusal code is worded,
 * and the small formatting the pick list needs. No React, no bridge: the gate runs every row of these tables without a window.
 */
import type { WorkspaceRulesCode, WorkspaceRulesStatus } from "@shared/workspace-rules";
import { rulesCopy, type LineWords, type RulesAction, type RulesLocale } from "./copy";

export type RulesLineId = "off" | "empty" | "missing" | "unreadable" | "overflow" | "localModels" | "refusal";
export interface RulesLine { id: RulesLineId; kind: "plain" | "warn" | "divider"; icon: "clock" | "empty" | "file-x" | "alert" | "ruler" | "cpu" | "refresh"; title: string; body: string; action?: { id: RulesAction; label: string } }

export type RulesRefusal = WorkspaceRulesCode | "save_failed" | "save_full";
const REFUSAL_ICON: Record<RulesRefusal, RulesLine["icon"]> = {
  rules_changed: "refresh", rules_readonly: "alert", rules_disk_full: "alert", rules_busy: "alert", rules_unreadable: "alert", rules_full: "ruler", save_failed: "alert", save_full: "ruler",
};

/** "1 KB" style size of the small-window cap, from the backend's number (never a fixed 1KB). */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

export function refusalLine(locale: RulesLocale, code: RulesRefusal): RulesLine {
  const words: LineWords = rulesCopy(locale).refusal[code] ?? rulesCopy(locale).refusal.save_failed;
  return { id: "refusal", kind: "warn", icon: REFUSAL_ICON[code] ?? "alert", title: words.title, body: words.body, action: words.action };
}

/**
 * The lines under the editor, in the picture's order: a refusal first, then the file's state, then the overflow divider, then the local-model line.
 * Each line comes from a backend value, never from a guess: `state`, `fileState`, `overflowLines`, and `loadedBytes > smallWindowMaxBytes` (the only time a
 * small-window runner gets less than a big one - the screen never looks at which runner is connected).
 */
export function stateLines(locale: RulesLocale, status: WorkspaceRulesStatus, refusal: RulesRefusal | null): RulesLine[] {
  const c = rulesCopy(locale);
  const lines: RulesLine[] = [];
  if (refusal) lines.push(refusalLine(locale, refusal));
  if (status.state === "off") lines.push({ id: "off", kind: "plain", icon: "clock", title: c.state.off.title, body: c.state.off.body });
  if (status.fileState === "missing") lines.push({ id: "missing", kind: "warn", icon: "file-x", title: c.state.missing.title, body: c.state.missing.body, action: c.state.missing.action });
  else if (status.fileState === "rules_unreadable") lines.push({ id: "unreadable", kind: "warn", icon: "alert", title: c.state.unreadable.title, body: c.state.unreadable.body, action: status.clearable ? c.state.unreadable.action : undefined });
  else if (status.fileState === "empty") lines.push({ id: "empty", kind: "plain", icon: "empty", title: c.state.empty.title, body: c.state.empty.body, action: status.candidatesAvailable > 0 ? { id: "pick", label: c.pick } : undefined });
  if (status.overflowLines > 0) lines.push({ id: "overflow", kind: "divider", icon: "ruler", title: c.state.overflow(status.overflowLines), body: "" });
  if (status.loadedBytes > status.smallWindowMaxBytes && status.smallWindowMaxBytes > 0) {
    const words = c.state.localModels(sizeWords(status.smallWindowMaxBytes));
    lines.push({ id: "localModels", kind: "plain", icon: "cpu", title: words.title, body: words.body });
  }
  return lines;
}

/** Month/day of a stored time ("11/9"), "" when the time cannot be read - the screen never invents a date. */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** The "shown once" notice moves forward only (backend rank); this says whether the screen still has to send `state`. */
const RANK = { none: 0, offered: 1, dismissed: 2, done: 3 } as const;
export function shouldSendPickNotice(current: keyof typeof RANK, next: "offered" | "dismissed"): boolean {
  return RANK[next] > RANK[current];
}
