"use client";

/**
 * Pictures desktop-impl-gaps-6 AI-1 / AI-2: the line right above the personal agent's composer for what waits for the owner, and the dot on the personal agent's face in the menu.
 * The line shows a COUNT and a state, never a word of an item (the words are read in the Main-owned review window that [Review] opens; the owner window is never given them).
 * No item: no line and no dot. Not on the Dashboard. A finished line (accepted / declined / done) is gone the next time this screen opens; the x only closes the line.
 * Reads through lib/use-waiting-line.ts (open, window focus, after the owner's own press: no timer).
 */
import { useCallback, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconShield } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { refusalLine } from "@/lib/one-home-copy";
import { useWaitingSnapshot } from "@/lib/use-waiting-line";
import { planWaitingLine, W } from "@/lib/waiting-review";
import s from "./OneHome.module.css";

function Cross() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>; }

export function OneWaitingLine() {
  const { locale } = useT();
  const lang = locale === "ko" ? "ko" : "en";
  const { snapshot, reload } = useWaitingSnapshot();
  const mountedAt = useRef(Date.now());
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState<string | null>(null);
  const plan = planWaitingLine(snapshot ? { ...snapshot, mountedAt: mountedAt.current, closedAt } : null, lang);
  const review = useCallback(async () => {
    const api = ipc()?.oneHome; if (!api?.reviewWaiting || busy) return;
    setBusy(true); setWord(null);
    try { const out = await api.reviewWaiting(); if (!out?.ok) setWord(out?.code ?? "unknown"); } catch { setWord("confirm_window_unavailable"); }
    setBusy(false); await reload();
  }, [busy, reload]);
  const retry = useCallback(async () => {
    const api = ipc()?.oneHome; if (!api?.waitingCheck || busy) return;
    setBusy(true); setWord(null);
    try { const out = await api.waitingCheck(); if (!out?.ok && out?.code !== "server_unreachable") setWord(out?.code ?? "unknown"); } catch { setWord("unknown"); }
    setBusy(false); await reload();
  }, [busy, reload]);
  if (plan.kind === "hidden") return null;
  const finished = plan.canClose;
  const icon = plan.icon === "check" ? <IconCheck size={16} /> : plan.icon === "cross" ? <Cross /> : <IconShield size={16} />;
  const refusal = word ? refusalLine(lang === "ko" ? "ko" : "en", word) : null;
  return (
    <div className={s.waitStack} data-one-waiting-line={plan.kind}>
      <div className={s.waitLine} role="status" data-kind={plan.kind}>
        <span className={s.waitIcon} aria-hidden="true">{icon}</span>
        <span className={s.waitText}><b>{plan.title}</b>{plan.sub ? <span>{plan.sub}</span> : null}</span>
        {plan.button === "review" || plan.button === "review-off" ? <button type="button" className={s.waitPrimary} disabled={plan.button === "review-off" || busy} onClick={() => void review()}>{lang === "ko" ? "확인" : "Review"}</button> : null}
        {plan.button === "retry" ? <button type="button" className={s.waitBtn} disabled={busy} onClick={() => void retry()}>{W.retry(lang)}</button> : null}
        {finished ? <button type="button" className={s.waitX} aria-label={W.close(lang)} onClick={() => setClosedAt(snapshot?.result?.at ?? Date.now())}><Cross /></button> : null}
      </div>
      {refusal ? <div className={s.note} role="status"><span className={s.noteIcon} aria-hidden="true"><IconAlertTriangle size={15} /></span><span>{refusal.text}</span><span /></div> : null}
    </div>
  );
}

/** The red dot on the personal agent's face in the menu: any item waiting (the colour of the dots in the Workspace list). Nothing when none waits or the numbers are not there. */
export function WaitingDot() {
  const { snapshot } = useWaitingSnapshot();
  if (!snapshot || snapshot.waiting <= 0) return null;
  return <i className={s.waitDot} data-one-waiting-dot="true" aria-hidden="true" />;
}
