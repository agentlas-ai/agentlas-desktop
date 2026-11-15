"use client";

/**
 * The Main-owned review window for what waits (kind `reviewWaiting`; pictures desktop-impl-gaps-6 AI-3 · AI-4). It is drawn INSIDE `/one-confirm` (OneHomeConfirmWindow hands this the same bridge), never in the owner window:
 * the words of an item are the other side's plain text and live here only. Calls: the list, one long text whole, the answer over a selection (`window.oneHomeConfirm.waiting`), and the same view / cancel the other windows use.
 * Rules it mirrors from Main (Main enforces them): the first second takes no press; a long text (`cut`, over 200 characters) is not in an [Accept N] count and is accepted alone after reading to the end; a decline needs no reading;
 * while the screen is operated [Decline] and [Accept] are off and only [Cancel] works. Texts are drawn as React text nodes (no markup, no link). Words and arithmetic: lib/waiting-review.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconChat, IconChevronLeft, IconChevronRight, IconEdit, IconLock, IconTrash } from "@/components/Icon";
import { CONFIRM_YES_DELAY_MS, type OneHomeConfirmBridge, type OneHomeWaitingItem } from "@shared/one-home-confirm";
import { refusalLine, t2, type Lang } from "@/lib/one-home-copy";
import { WORDS } from "@/lib/one-home-confirm-copy";
import { acceptableCount, cutCount, doneTotal, fullIdOf, fullListOf, isCut, itemKey, rowOf, selectedCount, selectionOf, W, type ItemKind } from "@/lib/waiting-review";
import s from "./OneHomeConfirm.module.css";

type Phase = "reading" | "list" | "unreadable" | "empty" | "done" | "expired" | "gone";
type Note = { kind: "accepted" | "declined"; n: number; newer: number } | null;
type Full = { key: string; item: OneHomeWaitingItem; text: string | null; failed: boolean; atEnd: boolean } | null;

function Bulb() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></svg>; }
const kindIcon = (k: ItemKind) => (k === "message" ? <IconChat size={14} /> : k === "memory" ? <Bulb /> : k === "memoryDeletion" ? <IconTrash size={14} /> : <IconEdit size={14} />);

function Check({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return <button type="button" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled} className={s.rvBox} data-on={on ? "true" : "false"} onClick={onToggle}>{on ? <IconCheck size={12} /> : null}</button>;
}

export function OneHomeWaitingReview({ bridge, requestId, lang, initialScreenBusy, waiting }: { bridge: OneHomeConfirmBridge; requestId: string; lang: Lang; initialScreenBusy: boolean; waiting: number }) {
  const api = bridge.waiting;
  const [phase, setPhase] = useState<Phase>("reading");
  const [items, setItems] = useState<OneHomeWaitingItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [screenBusy, setScreenBusy] = useState(initialScreenBusy);
  const [waited, setWaited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [tally, setTally] = useState({ accepted: 0, declined: 0 });
  const [full, setFull] = useState<Full>(null);
  const fullBox = useRef<HTMLDivElement>(null);
  const now = useMemo(() => new Date(), []);

  const load = useCallback(async (keep: boolean): Promise<void> => {
    if (!keep) setPhase("reading");
    let out: Awaited<ReturnType<typeof api.list>>;
    try { out = await api.list(requestId); } catch { out = { ok: false, code: "confirm_run_failed" }; }
    if (!out.ok) {
      if (out.code === "screen_control_active") setScreenBusy(true);
      if (out.code === "no_pending_request" || out.code === "not_confirm_window") { setPhase((p) => (p === "done" || p === "expired" ? p : "gone")); return; }
      setWord(out.code); setPhase((p) => (p === "list" && keep ? p : "unreadable")); return;
    }
    setScreenBusy(out.screenBusy); setWord(null);
    setItems(out.items); setSelected(new Set(out.items.map(itemKey)));
    setPhase(out.items.length === 0 ? (tallyRef.current.accepted + tallyRef.current.declined > 0 ? "done" : "empty") : "list");
  }, [api, requestId]);
  const tallyRef = useRef(tally); tallyRef.current = tally;

  useEffect(() => { void load(false); }, [load]);
  // The first second: both answers are grey for the same time Main refuses them. The timer only greys a button; Main decides.
  useEffect(() => { const t = setTimeout(() => setWaited(true), CONFIRM_YES_DELAY_MS); return () => clearTimeout(t); }, []);
  // Focus is the signal to read the screen-control state again (no timer).
  useEffect(() => {
    const onFocus = () => { void bridge.view().then((v) => { if (v.ok) setScreenBusy(v.screenBusy); }).catch(() => undefined); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [bridge]);
  useEffect(() => bridge.onExpired(() => setPhase((p) => (p === "done" ? p : "expired"))), [bridge]);

  const cancel = useCallback(async () => { try { await bridge.cancel(requestId); } catch { /* the window closes anyway */ } window.close(); }, [bridge, requestId]);
  const locked = !waited || screenBusy || busy;
  const rows = useMemo(() => items.map((i) => ({ item: i, row: rowOf(i, lang, now) })), [items, lang, now]);
  const n = selectedCount(items, selected);
  const acceptN = acceptableCount(items, selected);
  const longN = cutCount(items);

  const answer = useCallback(async (decision: "accept" | "reject", only?: OneHomeWaitingItem): Promise<void> => {
    const sel = only ? selectionOf([only], new Set([itemKey(only)]), decision) : selectionOf(items, selected, decision);
    if (!sel || busy) return;
    setBusy(true); setWord(null);
    let out: Awaited<ReturnType<typeof api.decide>>;
    try { out = await api.decide(requestId, decision, sel); } catch { out = { ok: false, code: "confirm_run_failed" }; }
    setBusy(false);
    if (!out.ok) {
      if (out.code === "screen_control_active") setScreenBusy(true);
      if (out.code === "no_pending_request" || out.code === "not_confirm_window") { setPhase((p) => (p === "done" ? p : "gone")); return; }
      setWord(out.code); return;   // too_early / a refusal: the list stays, the owner reads the line and presses again
    }
    const count = doneTotal(out.done);
    setTally((t) => ({ accepted: t.accepted + (decision === "accept" ? count : 0), declined: t.declined + (decision === "reject" ? count : 0) }));
    tallyRef.current = { accepted: tallyRef.current.accepted + (decision === "accept" ? count : 0), declined: tallyRef.current.declined + (decision === "reject" ? count : 0) };
    setNote(count > 0 || (out.done.newer ?? 0) > 0 ? { kind: decision === "accept" ? "accepted" : "declined", n: count, newer: out.done.newer ?? 0 } : null);
    setFull(null);
    await load(true);
  }, [api, busy, items, load, requestId, selected]);

  const openFull = useCallback(async (item: OneHomeWaitingItem): Promise<void> => {
    const list = fullListOf(item), id = fullIdOf(item);
    if (!list || !id) return;
    setWord(null); setFull({ key: itemKey(item), item, text: null, failed: false, atEnd: false });
    let out: Awaited<ReturnType<typeof api.item>>;
    try { out = await api.item(requestId, list, id); } catch { out = { ok: false, code: "confirm_run_failed" }; }
    if (!out.ok) { if (out.code === "screen_control_active") setScreenBusy(true); setFull((f) => (f && f.key === itemKey(item) ? { ...f, failed: true } : f)); setWord(out.code); return; }
    const whole = out.item;
    setFull((f) => (f && f.key === itemKey(item) ? { ...f, text: whole.t === "profile" ? whole.name : (whole.t === "fact" ? whole.text : (whole.text ?? "")) } : f));
  }, [api, requestId]);
  // Reading to the end: scrolled to the bottom, or nothing to scroll (the text fits).
  const checkEnd = useCallback(() => {
    const el = fullBox.current; if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) setFull((f) => (f && !f.atEnd ? { ...f, atEnd: true } : f));
  }, []);
  useEffect(() => { if (full?.text !== null && full?.text !== undefined) checkEnd(); }, [full?.text, checkEnd]);

  const refusal = word && word !== "too_early" ? refusalLine(lang, word) : null;
  const noteLine = (icon: React.ReactNode, body: React.ReactNode, code?: string | null) => (
    <div className={s.rvNote} role="status" data-confirm-note={code ?? "info"}><span className={s.noteIcon} aria-hidden="true">{icon}</span><span>{body}</span></div>
  );
  const busyStrip = screenBusy ? noteLine(<IconLock size={15} />, W.screenBusy(lang), "screen_control_active") : null;
  const lineOfWord = refusal ? noteLine(<IconAlertTriangle size={15} />, refusal.text, refusal.code) : word === "too_early" ? noteLine(<IconAlertTriangle size={15} />, t2(lang, WORDS.tooEarly), "too_early") : null;

  if (phase === "gone") return <main className={`rd ${s.rv}`} data-confirm-kind="reviewWaiting" data-confirm-phase="gone"><div className={s.rvBody}>{noteLine(<IconAlertTriangle size={15} />, t2(lang, WORDS.gone), "no_pending_request")}</div><div className={s.rvButtons}><button type="button" className={s.btn} onClick={() => window.close()}>{W.close(lang)}</button></div></main>;
  if (phase === "expired") return <main className={`rd ${s.rv}`} data-confirm-kind="reviewWaiting" data-confirm-phase="expired"><div className={s.rvBody}>{noteLine(<IconAlertTriangle size={15} />, t2(lang, WORDS.expired))}</div><div className={s.rvButtons}><button type="button" className={s.btn} onClick={() => window.close()}>{W.close(lang)}</button></div></main>;

  // ── the full view of one long text (AI-3 middle) ──
  if (full) {
    const r = rowOf(full.item, lang, now);
    return (
      <main className={`rd ${s.rv}`} data-confirm-kind="reviewWaiting" data-confirm-phase="full">
        <button type="button" className={s.rvBack} onClick={() => { setFull(null); setWord(null); }}><IconChevronLeft size={13} />{W.back(lang)}</button>
        <div className={s.rvFullHead}><span className={s.rvKind}>{kindIcon(r.kind)}<b>{r.label}</b>{r.chars !== null ? <span className={s.rvSoft}> · {W.longChars(r.chars, lang)}</span> : null}</span><span className={s.rvSoft}>{r.when}</span></div>
        <div ref={fullBox} className={s.rvFullText} onScroll={checkEnd} tabIndex={0} data-testid="full-text">{full.failed ? W.unreadable(lang) : full.text === null ? "" : full.text}</div>
        {full.text !== null && !full.atEnd ? <p className={s.rvHint}>{W.readToEnd(lang)}</p> : null}
        <div className={s.rvBody}>{busyStrip}{lineOfWord}</div>
        <div className={s.rvButtons}>
          <button type="button" className={s.btn} data-tone="decline" disabled={locked} onClick={() => void answer("reject", full.item)}>{W.decline(lang)}</button>
          <button type="button" className={s.btnPrimary} disabled={locked || !full.atEnd || full.text === null} onClick={() => void answer("accept", full.item)}>{W.accept(null, lang)}</button>
        </div>
      </main>
    );
  }

  // ── all done (AI-4 right) ──
  if (phase === "done") {
    const total = tally.accepted + tally.declined;
    return (
      <main className={`rd ${s.rv}`} data-confirm-kind="reviewWaiting" data-confirm-phase="done">
        <div className={s.rvDone}>
          <span className={s.rvDoneMark} aria-hidden="true"><IconCheck size={18} /></span>
          <h1 className={s.rvDoneTitle}>{W.allDone(total, lang)}</h1>
          <p className={s.rvDoneLine}>{W.tally(tally.accepted, tally.declined, lang)}</p>
          {note && note.newer > 0 ? <p className={s.rvDoneLine}>{W.newer(note.newer, lang)}</p> : null}
        </div>
        <div className={s.rvButtons}><button type="button" className={s.btn} onClick={() => void cancel()}>{W.close(lang)}</button></div>
      </main>
    );
  }

  // ── reading / unreadable / empty / the list ──
  const processed = tally.accepted + tally.declined > 0;
  return (
    <main className={`rd ${s.rv}`} data-confirm-kind="reviewWaiting" data-confirm-phase={phase}>
      <div className={s.rvHead}>
        <h1 className={s.rvTitle}>{phase === "list" ? W.title(items.length, lang) : phase === "empty" ? W.nothing(lang) : waiting > 0 ? W.title(waiting, lang) : phase === "unreadable" ? W.unreadable(lang) : W.reading(lang)}</h1>
        {phase === "list" && !note ? <p className={s.rvLead}>{W.acceptOnlyYours(lang)}</p> : phase === "reading" && waiting > 0 ? <p className={s.rvLead}>{W.reading(lang)}</p> : phase === "unreadable" && waiting > 0 ? <p className={s.rvLead}>{W.unreadable(lang)}</p> : null}
      </div>
      <div className={s.rvBody}>
        {note ? noteLine(<IconCheck size={15} />, <><b>{note.kind === "accepted" ? W.accepted(note.n, lang).head : W.declined(note.n, lang).head}</b>{note.newer > 0 ? ` · ${W.newer(note.newer, lang)}` : ""}</>) : null}
        {phase === "reading" ? <ul className={s.rvSkeleton} aria-hidden="true">{[0, 1, 2].map((k) => <li key={k}><i /><i /></li>)}</ul> : null}
        {phase === "unreadable" ? <div className={s.rvRetry}><button type="button" className={s.btn} onClick={() => void load(false)}>{W.retry(lang)}</button></div> : null}
        {phase === "list" ? (
          <>
            <div className={s.rvAll}>
              <Check on={n === items.length && n > 0} label={W.selectAll(lang)} disabled={busy} onToggle={() => setSelected(n === items.length ? new Set() : new Set(items.map(itemKey)))} />
              <span>{W.selectAll(lang)}</span><span className={s.rvSoft}>{W.selected(n, lang)}</span>
            </div>
            <div className={s.rvScroll}><ul className={s.rvList}>
              {rows.map(({ item, row }, idx) => (
                <li key={`${row.key}:${idx}`} className={s.rvItem} data-kind={row.kind}>
                  <Check on={selected.has(row.key)} label={row.label} disabled={busy} onToggle={() => setSelected((prev) => { const next = new Set(prev); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })} />
                  <div className={s.rvItemMain}>
                    <div className={s.rvItemHead}><span className={s.rvKind}>{kindIcon(row.kind)}<b>{row.label}</b></span><span className={s.rvSoft}>{row.when}</span></div>
                    <p className={s.rvText}>{row.text ? row.text : W.noText(lang)}</p>
                    {row.cut ? <button type="button" className={s.rvReadAll} disabled={busy} onClick={() => void openFull(item)}><b>{W.readAll(lang)}</b>{row.chars !== null ? <span className={s.rvSoft}> · {W.longChars(row.chars, lang)}</span> : null}<IconChevronRight size={12} /></button> : null}
                  </div>
                </li>
              ))}
            </ul></div>
            {longN > 0 ? <p className={s.rvHint}>{W.longNote(longN, lang)}</p> : null}
          </>
        ) : null}
        {busyStrip}
        {phase === "list" ? lineOfWord : null}
      </div>
      <div className={s.rvButtons} data-three={phase === "list" || phase === "reading" || phase === "empty" ? "true" : "false"}>
        <button type="button" className={s.btn} disabled={busy} onClick={() => void cancel()}>{processed ? W.close(lang) : W.cancel(lang)}</button>
        {phase === "empty" || phase === "unreadable" ? null : <>
          <button type="button" className={s.btn} data-tone="decline" disabled={phase !== "list" || locked || n === 0} onClick={() => void answer("reject")}>{W.decline(lang)}</button>
          <button type="button" className={s.btnPrimary} disabled={phase !== "list" || locked || acceptN === 0} onClick={() => void answer("accept")}>{phase === "list" ? W.accept(acceptN, lang) : W.accept(null, lang)}</button>
        </>}
      </div>
    </main>
  );
}
