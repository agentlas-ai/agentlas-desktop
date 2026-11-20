"use client";

/*
 * The hand-off cards a person sees (pictures desktop-plural-4 BM..BQ, rules WORK-1117.md; the words are in shared/plural-handoff-card.ts and nowhere else):
 *   HandoffCard       the card of one piece of work in the personal agent's conversation - the work this desktop's agent handed to another (sent) or the work another handed to it (received).
 *                     It is drawn from the card row only; its buttons carry ids to Main (`pluralHandoffAct`). Confirmations waiting for THIS desktop's answer sit under it, one prompt each; what was answered here is a quiet line.
 *   RemoteAskPrompt   the numbered confirmation (BP): delete / send = Allow, Allow for this task, Deny; payment = Allow, Deny. It has no clock.
 * ConsentChip the chip of a hand-off between agents: Allow, Always allow, Deny. On the sending card while its row is `asking` (nothing was sent), and on the receiving desktop's screen
 *                     (components/one/PluralConsentPrompts.tsx). It carries the row id only; the server alone sends, so whichever screen answers first is the answer. It has no clock.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck, IconClose, IconMonitor, IconSmartphone } from "@/components/Icon";
import { ApprovalPrompt, type ApprovalPromptDeck } from "@/components/ApprovalPrompt";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import {
  consentCopy, handoffCardView, handoffTimeWord, remoteAskCopy,
  type ConsentChipCopy, type ConsentChoice, type HandoffAction, type HandoffAnswerLine, type HandoffCardValue, type HandoffIcon, type RemoteAskChoice, type RemoteAskCopy,
} from "@shared/plural-handoff-card";
import s from "./PluralHandoffCards.module.css";
import r from "./one/OneApprovalRecords.module.css";

function Glyph({ icon, size = 16 }: { icon: HandoffIcon; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (icon) {
    case "send": return <svg {...common}><path d="M21 3L3 10.5l7 2.5 2.5 7z" /><path d="M10 13l11-10" /></svg>;
    case "clock": return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
    case "phoneOff": return <svg {...common}><path d="M7 3h10v18H7z" /><path d="M3 3l18 18" /></svg>;
    case "spinner": return <svg {...common} className={s.spin}><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" /></svg>;
    case "question": return <svg {...common}><path d="M4 12a8 8 0 0 1 13.5-5.8L20 8.5" /><path d="M20 4v4.5h-4.5" /><path d="M20 12a8 8 0 0 1-13.5 5.8L4 15.5" /></svg>;
    case "flag": return <svg {...common}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>;
    case "alert": return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>;
    case "pause": return <svg {...common}><path d="M9 6v12M15 6v12" /></svg>;
    case "blocked": return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M6 6l12 12" /></svg>;
    case "cancel": return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M8 12h8" /></svg>;
  }
}

/** The numbered confirmation of a remote Work's question (BP). `deck` is set when several wait on one screen. */
export function RemoteAskPrompt({ copy, locked = false, onChoose, deck, testId = "plural-ask-card" }: {
  copy: RemoteAskCopy; locked?: boolean; onChoose: (id: RemoteAskChoice) => void; deck?: ApprovalPromptDeck; testId?: string;
}) {
  const box = copy.rows.length > 0 ? (
    <dl className={s.box} data-testid="plural-ask-box">
      {copy.rows.map((row) => <Fragment key={row.label}><dt className={s.boxLabel}>{row.label}</dt><dd className={s.boxValue} style={{ margin: 0 }}>{row.value}</dd></Fragment>)}
    </dl>
  ) : null;
  return (
    <ApprovalPrompt
      question={copy.title}
      code={copy.target || null}
      meta={<><span>{copy.header}</span>{box}</>}
      options={copy.choices.map((choice) => ({ id: choice.id, title: choice.label, ...(choice.role ? { role: choice.role } : {}), disabled: locked }))}
      locked={locked}
      onChoose={(id) => onChoose(id as RemoteAskChoice)}
      {...(deck ? { deck } : {})}
      testId={testId}
    />
  );
}

/** The consent chip: the question line, the work in one line (and its end condition), then Allow / Always allow / Deny. `brief` is left out where the card above already shows the work. */
export function ConsentChip({ copy, showBrief = true, locked = false, onChoose, deck, testId = "plural-consent-chip" }: {
  copy: ConsentChipCopy; showBrief?: boolean; locked?: boolean; onChoose: (choice: ConsentChoice) => void; deck?: ApprovalPromptDeck; testId?: string;
}) {
  return (
    <ApprovalPrompt
      question={copy.header}
      meta={showBrief ? <><div>{copy.brief}</div>{copy.doneWhen ? <div>{copy.doneWhen}</div> : null}</> : null}
      options={copy.choices.map((choice) => ({ id: choice.id, title: choice.label, ...(choice.note ? { note: choice.note, showNote: true } : {}), ...(choice.role ? { role: choice.role } : {}), disabled: locked }))}
      locked={locked}
      onChoose={(id) => onChoose(id as ConsentChoice)}
      {...(deck ? { deck } : {})}
      testId={testId}
    />
  );
}

/** The name of this desktop's own personal agent (the "A" of the chip). Read when a chip is on screen, never kept. */
export function useOwnAgentName(enabled: boolean): string {
  const [name, setName] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const profiles = ipc()?.oneProfile;
    if (profiles && typeof profiles.get === "function") void Promise.resolve(profiles.get()).then((profile) => { if (live) setName(typeof profile?.displayName === "string" ? profile.displayName.trim() : ""); }).catch(() => undefined);
    return () => { live = false; };
  }, [enabled]);
  return name;
}

function AnswerLine({ line, ko, now }: { line: HandoffAnswerLine; ko: boolean; now: number }) {
  const kind = line.kind === "money" ? (ko ? "결제" : "Payment") : line.kind === "delete" ? (ko ? "삭제" : "Delete") : (ko ? "전송" : "Send");
  const word = line.result === "allowed" ? (ko ? "허용됨" : "Allowed") : line.result === "denied" ? (ko ? "거절됨" : "Denied") : (ko ? "확인 요청 취소" : "Request cancelled");
  const time = handoffTimeWord(line.at, { ko, now });
  const side = line.result === "cancelled" ? "" : (ko ? "이 데스크탑" : "This desktop");
  return (
    <div className={r.row} data-approval-line={line.result} style={{ cursor: "default" }}>
      <span className={r.icon} data-icon={line.result === "allowed" ? "approved" : line.result === "denied" ? "declined" : "expired"}>
        {line.result === "allowed" ? <IconCheck size={17} /> : line.result === "denied" ? <IconClose size={17} /> : <Glyph icon="cancel" size={17} />}
      </span>
      <span className={r.left}><span className={r.result}>{word}</span>{` · ${kind}${line.target ? ` · ${line.target}` : ""}`}</span>
      <span className={r.right}>{side ? <IconMonitor size={14} /> : null}<span>{[side, time].filter(Boolean).join(" · ")}</span></span>
    </div>
  );
}

export function HandoffCard({ value }: { value: HandoffCardValue }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const now = useMemo(() => Date.now(), [value.at, value.state]);
  const view = handoffCardView(value, { ko, now });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  // "Show all" only when the two-line result is really cut: measured, never guessed from the length.
  const resultRef = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = resultRef.current;
    if (!el || expanded) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view.result, expanded]);
  const longResult = cut || expanded;
  const act = async (action: HandoffAction): Promise<void> => {
    if (busy) return;
    const api = ipc();
    if (action === "plan" || action === "login") { router.push("/settings"); return; }
    if (!api?.pluralHandoffAct) return;
    setBusy(true);
    // Dismiss is the card's cancel once the work is over (Main reads the card row; plural-handoff-cards.ts actOnHandoffCard).
    try { await api.pluralHandoffAct({ op: action === "dismiss" ? "cancel" : action, id: value.id }); } catch { /* the card stays as it is; the next read shows the truth */ } finally { setBusy(false); }
  };
  const asking = value.state === "asking" && value.k === "sent";
  const ownName = useOwnAgentName(asking);
  const [consentLocked, setConsentLocked] = useState(false);
  const consent = async (choice: ConsentChoice): Promise<void> => {
    const api = ipc();
    if (!api?.pluralHandoffAct || consentLocked) return;
    setConsentLocked(true);
    let settled = false;
    try { settled = (await api.pluralHandoffAct({ op: "consent", id: value.id, answer: choice })).ok; } catch { /* the chip stays; the same answer again is the same request */ }
    if (!settled) setConsentLocked(false);
  };
  const answer = async (qid: string, choice: RemoteAskChoice): Promise<void> => {
    const api = ipc();
    if (!api?.pluralHandoffAct) return;
    try { await api.pluralHandoffAct({ op: "answer", id: value.id, qid, answer: choice === "deny" ? "deny" : choice === "allow_session" ? "allow_task" : "allow" }); } catch { /* the chip stays */ }
  };
  const actionLabel = (a: HandoffAction): string => a === "cancel" ? (ko ? "취소" : "Cancel") : a === "retry" ? (value.consent === "unanswered" ? (ko ? "다시 묻기" : "Ask again") : (ko ? "재시도" : "Retry")) : a === "plan" ? (ko ? "요금제" : "Plan") : a === "dismiss" ? (ko ? "지우기" : "Dismiss") : (ko ? "로그인" : "Sign in");
  return (
    <section className={s.card} data-testid="handoff-card" data-handoff-state={value.state} data-handoff-kind={value.k} aria-label={view.header}>
      <div className={s.head}>
        {value.phone ? <IconSmartphone size={14} /> : <IconMonitor size={14} />}
        <span className={s.headText}>{view.header}</span>
      </div>
      <div className={s.brief}>{view.brief}</div>
      <div className={s.statusRow}>
        <span className={s.status} data-tone={view.tone}><Glyph icon={view.icon} /><span className={s.statusText}>{view.status}</span></span>
        {view.actions.length > 0 && (
          <span className={s.actions}>
            {view.actions.map((a) => <button key={a} type="button" className={s.action} disabled={busy} onClick={() => { void act(a); }}>{actionLabel(a)}</button>)}
          </span>
        )}
      </div>
      {view.result && <p ref={resultRef} className={s.result} data-clamped={expanded ? "false" : "true"}>{view.result}</p>}
      {view.result && longResult && !expanded && <button type="button" className={s.more} onClick={() => setExpanded(true)}>{ko ? "전체 보기" : "Show all"}</button>}
      {asking && (
        <div className={s.asks}>
          <ConsentChip showBrief={false} locked={consentLocked} onChoose={(choice) => { void consent(choice); }}
            copy={consentCopy({ fromName: ownName, toName: [value.agent, value.phone ? (ko ? "폰" : "Phone") : value.place].filter(Boolean).join(" · "), brief: value.brief }, ko)} />
        </div>
      )}
      {view.note && <div className={s.note}><IconMonitor size={13} /><span>{view.note}</span></div>}
      {value.q && value.q.length > 0 && (
        <div className={s.asks}>
          {value.q.map((q) => (
            <RemoteAskPrompt key={q.qid} testId="plural-ask-card"
              copy={remoteAskCopy({ kind: q.kind, tool: "", target: q.target, ...(q.preview ? { preview: q.preview } : {}), fromName: value.agent, placeName: value.phone ? (ko ? "폰" : "Phone") : value.place || (ko ? "데스크탑" : "desktop") }, ko)}
              onChoose={(choice) => { void answer(q.qid, choice); }} />
          ))}
        </div>
      )}
      {value.log && value.log.length > 0 && <div className={r.list} data-approval-records="true">{value.log.map((line, i) => <AnswerLine key={`${line.at}:${i}`} line={line} ko={ko} now={now} />)}</div>}
    </section>
  );
}
