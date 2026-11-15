"use client";

import type { ReactNode } from "react";
import { IconAlertTriangle, IconClock, IconLogOut, IconUser } from "@/components/Icon";
import { REAUTH, REAUTH_BUTTON, refusalLine, t2, type Lang } from "@/lib/one-home-copy";
import type { ActionLine } from "@/lib/one-home-view";
import type { HomeActions } from "@/lib/use-one-home";
import s from "./OneHome.module.css";

export function Btn({ kind = "plain", onClick, disabled, children, title }: { kind?: "plain" | "primary" | "danger"; onClick?: () => void; disabled?: boolean; children: ReactNode; title?: string }) {
  return <button type="button" className={kind === "primary" ? s.btnPrimary : kind === "danger" ? s.btnDanger : s.btn} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

/** A refusal as one plain line: the sentence (what happened and what to do next), then the closed word in small type. */
export function RefusalNote({ line, lang }: { line: ActionLine | null; lang: Lang }) {
  if (!line) return null;
  const r = refusalLine(lang, line.code, line.detail);
  return (
    <div className={s.note} role="status" data-one-home-refusal={r.code}>
      <span className={s.noteIcon} aria-hidden="true"><IconAlertTriangle size={15} /></span>
      <span>{r.text}</span>
      <span />
    </div>
  );
}

const REAUTH_ICON: Record<string, ReactNode> = {
  reauth_required: <IconLogOut size={15} />, reauth_cancelled: <IconClock size={15} />, account_changed: <IconUser size={15} />,
  reauth_failed: <IconAlertTriangle size={15} />, action_expired: <IconClock size={15} />,
};

/**
 * "Sign in again" (picture L): ONE button that continues the held press. The browser opens only when the owner presses it. After it the app
 * runs the held press again with the new sign-in (desktop a0db10bcd), so the owner does not press the first button a second time.
 */
export function ReauthRow({ actions, lang }: { actions: HomeActions; lang: Lang }) {
  const code = actions.reauthCode;
  if (!code || !REAUTH[code]) return null;
  const w = REAUTH[code];
  const actionId = actions.reauth?.actionId;
  return (
    <div className={s.note} role="status" data-one-home-reauth={code} style={{ gridTemplateColumns: "18px minmax(0, 1fr) auto", alignItems: "center" }}>
      <span className={s.noteIcon} aria-hidden="true">{REAUTH_ICON[code]}</span>
      <span><b>{t2(lang, w.title)}</b>{t2(lang, w.body)}</span>
      {actionId ? <Btn onClick={() => void actions.signInAgain(actionId)} disabled={actions.busy === "reauth"}>{t2(lang, REAUTH_BUTTON)}</Btn> : <span />}
    </div>
  );
}

/** "today 14:02" / "11/2" from a time in ms. */
export function dayLabel(ms: number | null | undefined, lang: Lang, nowMs: number = Date.now()): string | null {
  if (!ms) return null;
  const d = new Date(ms), n = new Date(nowMs);
  if (d.toDateString() === n.toDateString()) {
    const hm = d.toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return lang === "ko" ? `오늘 ${hm}` : `today ${hm}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
