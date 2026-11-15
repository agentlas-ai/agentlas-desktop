"use client";

/**
 * The first-run line at the very top of the Dashboard (pictures desktop-impl-gaps-7 AJ-1 · AJ-2 · AJ-3; words and state choice are in lib/first-run-line.ts).
 * It reads `firstRun.status()` when the screen opens and when the window is focused again (no timer: Main gives no change signal for this state) and draws nothing for a build with
 * no cleanup (`applicable: false`), an older preload with no `firstRun`, or an answer that is a refusal. The state comes from the closed values only; a code is never written.
 * [See what moved] and the closing x belong to the finished lines. The one remembered value is a mark in localStorage: "seen" when this window saw the move not finished (written again for each
 * new move), "closed" when the owner closed its finished line. Read: this component, on each read. Cleared: overwritten by the next move's "seen"; it holds one word.
 */
import { useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconCheck, IconChat, IconClock, IconTrash, IconUsers } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { FIRST_RUN_MARK_KEY, formatFirstRunCount, isFirstRunOpen, parseFirstRunMark, planFirstRunLine, planFirstRunWindow, type FirstRunLineInput, type FirstRunMark } from "@/lib/first-run-line";
import s from "./FirstRunLine.module.css";

const readMark = (): FirstRunMark => { try { return parseFirstRunMark(window.localStorage.getItem(FIRST_RUN_MARK_KEY)); } catch { return null; } };
const writeMark = (mark: "seen" | "closed"): void => { try { window.localStorage.setItem(FIRST_RUN_MARK_KEY, mark); } catch { /* the line is drawn without it */ } };

type Reader = { firstRun?: {
  status?: () => Promise<({ ok: true } & FirstRunLineInput) | { ok: false; code: string }>;
  /** Asks the cleanup to look again at what it is stopped on; answers with closed words. Absent on an older preload (the line then draws no [Retry]). */
  retry?: () => Promise<{ ok: boolean; code?: string }>;
  /** One signal each time the state `status` answers changed; returns the way to stop listening. Absent on an older preload (the line then reads when it opens and when the window is focused). */
  onChanged?: (callback: () => void) => () => void;
} };

function Spinner() { return <svg className={s.spin} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.28" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>; }
function Pause() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="4.5" width="5" height="15" rx="1.4" /><rect x="14" y="4.5" width="5" height="15" rx="1.4" /></svg>; }
function Cross({ size = 16 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>; }
function Bulb() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></svg>; }

export function FirstRunLine() {
  const { locale } = useT();
  const lang = locale === "ko" ? "ko" : "en";
  const [status, setStatus] = useState<FirstRunLineInput | null>(null);
  const [mark, setMark] = useState<FirstRunMark>(null);
  const [sheet, setSheet] = useState(false);

  const read = useCallback(async (): Promise<void> => {
    const api = (ipc() as unknown as Reader | null)?.firstRun;
    if (!api?.status) { setStatus(null); return; }
    let answer: Awaited<ReturnType<NonNullable<typeof api.status>>> | null = null;
    try { answer = await api.status(); } catch { answer = null; }
    if (!answer || answer.ok !== true) { setStatus(null); return; }
    const next: FirstRunLineInput = answer;
    if (isFirstRunOpen(next) && readMark() !== "seen") writeMark("seen");   // a move that is not finished: its end is this move's end
    setMark(readMark());
    setStatus(next);
  }, []);

  useEffect(() => {
    void read();
    const onFocus = () => { void read(); };
    window.addEventListener("focus", onFocus);
    // Main says when the state changed (no timer here): one read for each signal.
    let off: (() => void) | undefined;
    try { off = (ipc() as unknown as Reader | null)?.firstRun?.onChanged?.(onFocus); } catch { off = undefined; }
    return () => { window.removeEventListener("focus", onFocus); try { off?.(); } catch { /* the window is closing */ } };
  }, [read]);

  const canRetry = typeof (ipc() as unknown as Reader | null)?.firstRun?.retry === "function";
  // The answer is not drawn: a refusal (a step is running, nothing is stopped) is the state the next read shows anyway.
  const retry = useCallback(async (): Promise<void> => {
    try { await (ipc() as unknown as Reader | null)?.firstRun?.retry?.(); } catch { /* read again below */ }
    void read();
  }, [read]);

  const plan = planFirstRunLine(status, mark, lang, { canRetry });
  const close = useCallback(() => { writeMark("closed"); setMark("closed"); setSheet(false); }, []);
  // The window has a way out by the keyboard too: Escape does what its closing button does.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet, close]);
  if (plan.kind === "hidden") return null;
  const win = sheet ? planFirstRunWindow(status, lang) : null;
  const icon = plan.icon === "spinner" ? <Spinner /> : plan.icon === "pause" ? <Pause /> : plan.icon === "warning" ? <IconAlertTriangle size={18} /> : <IconCheck size={18} />;
  const rowIcon = { agents: <IconUsers size={17} />, chats: <IconChat size={17} />, memory: <Bulb />, removed: <IconTrash size={17} />, notMoved: <IconClock size={17} /> };
  return (
    <>
      <section className={s.line} data-first-run-line={plan.kind} data-kind={plan.kind} role="status" aria-live="polite">
        <span className={s.icon} data-icon={plan.icon} aria-hidden="true">{icon}</span>
        <div className={s.text}><span className={s.title}>{plan.title}</span>{plan.sub ? <span className={s.sub}>{plan.sub}</span> : null}</div>
        <div className={s.side}>
          {plan.step ? <span className={s.step}>{plan.step.n}/{plan.step.total}<span className={s.bar} aria-hidden="true"><i style={{ width: `${Math.round((plan.step.n / plan.step.total) * 100)}%` }} /></span></span> : null}
          {plan.canRetry ? <button type="button" className={s.btn} onClick={() => { void retry(); }}>{lang === "ko" ? "재시도" : "Retry"}</button> : null}
          {plan.canOpen ? <button type="button" className={s.btn} onClick={() => setSheet(true)}>{lang === "ko" ? "내용 보기" : "Details"}</button> : null}
          {plan.canClose ? <button type="button" className={s.x} aria-label={lang === "ko" ? "닫기" : "Close"} onClick={close}><Cross /></button> : null}
        </div>
      </section>
      {win ? (
        <div className={s.scrim} data-first-run-window="true">
          <div className={s.sheet} role="dialog" aria-modal="true" aria-label={win.title}>
            <h2 className={s.sheetTitle}>{win.title}</h2>
                        <ul className={s.rows}>
              {win.rows.map((r) => (
                <li key={r.id} className={s.row} data-faint={r.faint ? "true" : "false"}>
                  <span className={s.rowIcon} aria-hidden="true">{rowIcon[r.icon]}</span>
                  <span>{r.label}</span>
                  {r.count !== null ? <span className={s.rowCount}>{formatFirstRunCount(r.count, lang)}</span> : r.soft ? <span className={s.rowSoft}>{r.soft}</span> : <span />}
                </li>
              ))}
            </ul>
            <div className={s.sheetActions}><button type="button" className={s.btnPrimary} onClick={close}>{win.close}</button></div>
          </div>
        </div>
      ) : null}
    </>
  );
}
