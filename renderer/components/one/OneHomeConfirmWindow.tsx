"use client";

/**
 * The page of the Main-owned confirmation window (`/one-confirm`, loaded only by electron/one/home-confirm-window-real.ts). The owner window's renderer never draws this:
 * the confirmation number and the final "yes" live here. It calls the three confirm channels through `window.oneHomeConfirm` (its own preload) and nothing else.
 * What it draws is a plan from lib/one-home-confirm-copy.ts; a refusal after a press is the closed word's sentence (lib/one-home-copy.ts REFUSAL) in the same small line as elsewhere.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconClock, IconCloud, IconLock, IconMonitor, IconSmartphone } from "@/components/Icon";
import { CONFIRM_YES_DELAY_MS, type OneHomeConfirmBridge, type OneHomeConfirmView } from "@shared/one-home-confirm";
import { confirmPlan, heldLine, phaseSettled, pressEnd, refusalResult, resultPlan, WORDS, type ConfirmPhase } from "@/lib/one-home-confirm-copy";
import { refusalLine, t2, type Lang } from "@/lib/one-home-copy";
import { OneHomeWaitingReview } from "@/components/one/OneHomeWaitingReview";
import s from "./OneHomeConfirm.module.css";

type Phase = ConfirmPhase;

export function OneHomeConfirmWindow({ bridge, lang: forced }: { bridge?: OneHomeConfirmBridge; lang?: Lang }) {
  const api = bridge ?? (typeof window !== "undefined" ? (window as unknown as { oneHomeConfirm?: OneHomeConfirmBridge }).oneHomeConfirm : undefined);
  const lang: Lang = forced ?? (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en");
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<Extract<OneHomeConfirmView, { ok: true }> | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [waited, setWaited] = useState(false);
  const [word, setWord] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | undefined>(undefined);   // the server's closed reason of a refusal: it only picks the sentence
  const requestId = useRef<string | null>(null);
  /** One answer per request: a second press while the first is on its way (or over) is not sent. Only a "too early" gives the press back. */
  const pressed = useRef(false);

  const read = useCallback(async () => {
    if (!api) { setPhase("gone"); return; }
    try {
      const v = await api.view();
      if (!v.ok) { setPhase((p) => (p === "expired" || phaseSettled(p) ? p : "gone")); return; }
      requestId.current = v.requestId; setData(v); setScreenBusy(v.screenBusy);
      setPhase((p) => (p === "loading" ? "ready" : p));
    } catch { setPhase((p) => (p === "expired" || phaseSettled(p) ? p : "gone")); }
  }, [api]);

  useEffect(() => { void read(); }, [read]);
  // The first second: the yes is grey for the same time Main refuses it (shared CONFIRM_YES_DELAY_MS). The timer only greys a button; Main decides.
  useEffect(() => { const t = setTimeout(() => setWaited(true), CONFIRM_YES_DELAY_MS); return () => clearTimeout(t); }, []);
  // Focus is the signal to read the screen-control state again (no timer): the owner comes back to this window, the yes follows what is true now.
  useEffect(() => {
    const onFocus = () => { if (phase === "ready") void read(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [phase, read]);
  useEffect(() => api?.onExpired(() => setPhase((p) => (phaseSettled(p) ? p : "expired"))), [api]);

  const plan = data ? confirmPlan(data.kind, data.view, lang) : null;
  const close = useCallback(async () => {
    const id = requestId.current;
    try { if (id && api && (phase === "ready" || phase === "busy")) await api.cancel(id); } catch { /* the window closes anyway */ }
    window.close();
  }, [api, phase]);
  const press = useCallback(async (answer?: "no") => {
    const id = requestId.current; if (!id || !api || pressed.current) return;
    pressed.current = true; setPhase("busy"); setWord(null); setDetail(undefined);
    try {
      const end = pressEnd(await api.approve(id, answer));
      if (end.phase === "ready") { setWord(end.word); setDetail(end.detail); setPhase("ready"); pressed.current = false; return; }   // nothing was used up: the owner presses again
      if (end.phase === "refused") { if (end.screenBusy) setScreenBusy(true); setWord(end.word); setDetail(end.detail); }
      setPhase(end.phase);   // done, held (the press goes on after the sign-in: not a failure) or refused
    } catch { setWord("confirm_run_failed"); setPhase("refused"); }
  }, [api]);

  const noteLine = (icon: React.ReactNode, text: string, code?: string | null) => (
    <div className={s.note} role="status" data-confirm-note={code ?? "info"}>
      <span className={s.noteIcon} aria-hidden="true">{icon}</span><span>{text}</span>
    </div>
  );
  const refusal = word && word !== "too_early" ? refusalLine(lang, word, detail) : null;
  const result = phase === "refused" ? (resultPlan(word, lang) ?? (plan ? refusalResult(plan.kind, word, detail, lang) : null)) : null;   // a disconnect done here whose key is not cut yet: the window turns into a result

  if (phase === "loading") return <main className={`rd ${s.win}`} data-confirm-phase="loading"><p className={s.line}>{t2(lang, WORDS.loading)}</p></main>;
  if (!plan || phase === "gone") {
    return (
      <main className={`rd ${s.win}`} data-confirm-phase="gone">
        {noteLine(<IconClock size={15} />, t2(lang, WORDS.gone), "no_pending_request")}
        <div className={s.buttons}><button type="button" className={s.btn} onClick={() => window.close()}>{t2(lang, WORDS.close)}</button></div>
      </main>
    );
  }
  // The list of what waits is its own session window (its list, its selection, its answers): the same page, the same bridge, the same window.
  if (data && data.kind === "reviewWaiting" && api && phase !== "expired") {
    const w = (data.view as { waiting?: unknown }).waiting;
    return <OneHomeWaitingReview bridge={api} requestId={data.requestId} lang={lang} initialScreenBusy={data.screenBusy} waiting={typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.floor(w) : 0} />;
  }
  if (result) {
    return (
      <main className={`rd ${s.win}`} data-confirm-kind={plan.kind} data-confirm-phase="result" data-confirm-result={word}>
        <h1 className={s.title}>{result.title}</h1>
        {plan.who ? <p className={s.who} data-confirm-who>{plan.who.icon === "phone" ? <IconSmartphone size={14} /> : plan.who.icon === "cloud" ? <IconCloud size={14} /> : <IconMonitor size={14} />}<span>{plan.who.text}</span></p> : null}   {/* which device: the same line as the question */}
        {result.line ? <p className={s.line}>{result.line}</p> : null}
        <div className={s.buttons}><button type="button" className={s.btn} onClick={() => window.close()}>{t2(lang, WORDS.close)}</button></div>
      </main>
    );
  }
  const finished = phase === "expired" || phase === "held" || phase === "refused" || phase === "done";
  const yesLocked = !waited || screenBusy || phase === "busy" || finished;
  const icon = plan.who?.icon === "phone" ? <IconSmartphone size={14} /> : plan.who?.icon === "cloud" ? <IconCloud size={14} /> : <IconMonitor size={14} />;
  return (
    <main className={`rd ${s.win}`} data-confirm-kind={plan.kind} data-confirm-phase={phase}>
      <h1 className={s.title}>{plan.title}</h1>
      {plan.who ? <p className={s.who}>{icon}<span>{plan.who.text}</span></p> : null}
      {plan.code ? <p className={s.code} data-confirm-code>{plan.code}</p> : null}
      {plan.codeCaption ? <p className={s.caption}>{plan.codeCaption}</p> : null}
      {plan.lines.map((line) => <p key={line} className={s.line}>{line}</p>)}
      {plan.warn ? noteLine(<IconAlertTriangle size={15} />, plan.warn, "caution") : null}
      {plan.items.length ? <ul className={s.items}>{plan.items.map((it, i) => <li key={i}>{it}</li>)}</ul> : null}
      {phase === "expired" ? noteLine(<IconClock size={15} />, t2(lang, WORDS.expired)) : null}
      {phase === "ready" && screenBusy && plan.yes ? noteLine(<IconLock size={15} />, t2(lang, WORDS.screenBusy), "screen_control_active") : null}
      {phase === "ready" && word === "too_early" ? noteLine(<IconClock size={15} />, t2(lang, WORDS.tooEarly), "too_early") : null}
      {(phase === "refused" || phase === "ready") && refusal ? noteLine(<IconAlertTriangle size={15} />, refusal.text, refusal.code) : null}
      {phase === "held" ? noteLine(<IconClock size={15} />, heldLine(lang), "reauth_required") : null}
      {phase === "done" ? noteLine(<IconCheck size={15} />, t2(lang, WORDS.done)) : null}
      <div className={s.buttons}>
        {finished ? <button type="button" className={s.btn} onClick={() => window.close()}>{t2(lang, WORDS.close)}</button> : (
          <>
            {plan.not ? <button type="button" className={s.btn} disabled={phase === "busy"} onClick={() => void press("no")}>{plan.not}</button> : <button type="button" className={s.btn} disabled={phase === "busy"} onClick={() => void close()}>{plan.no}</button>}
            {plan.yes ? <button type="button" className={s.btnPrimary} disabled={yesLocked} onClick={() => void press()}>{plan.yes}</button> : null}
          </>
        )}
      </div>
    </main>
  );
}
