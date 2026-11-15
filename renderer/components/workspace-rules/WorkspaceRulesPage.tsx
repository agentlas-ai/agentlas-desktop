"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRulesPickNotice, WorkspaceRulesStatus } from "@shared/workspace-rules";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconAlertTriangle, IconClock, IconCpu, IconRefresh } from "../Icon";
import { PopupAction, PopupFrame } from "../Popup";
import { rulesCopy, type RulesAction } from "./copy";
import { IconFileEmpty, IconFileX, IconListCheck, IconRuler } from "./icons";
import { PickFromEarlier, type PickOutcome } from "./PickFromEarlier";
import { shouldSendPickNotice, stateLines, type RulesLine, type RulesRefusal } from "./rules-model";
import styles from "./WorkspaceRules.module.css";

type Refusal = RulesRefusal;
type SaveState = "saved" | "dirty" | "saving";
/** One quiet moment after the last key before the text is saved (a debounce, not a timer that polls). */
const AUTOSAVE_MS = 900;
const NOTICE_ORDER: WorkspaceRulesPickNotice[] = ["none", "offered", "dismissed", "done"];

const LINE_ICON: Record<RulesLine["icon"], () => JSX.Element> = {
  clock: () => <IconClock size={17} />, empty: () => <IconFileEmpty size={17} />, "file-x": () => <IconFileX size={17} />, alert: () => <IconAlertTriangle size={17} />,
  ruler: () => <IconRuler size={17} />, cpu: () => <IconCpu size={17} />, refresh: () => <IconRefresh size={17} />,
};

/**
 * "My rules" (F-D11, pictures desktop-final-pieces A and desktop-final-pieces-2 E/F): one text file on this computer that the Workspace conversations read.
 * The screen only stores the file's text through the six `workspaceRules` calls. It reads when it opens and after its own commands, never on a timer, and it builds no prompt.
 */
export function WorkspaceRulesPage() {
  const { locale } = useT();
  const loc = locale === "ko" ? "ko" : "en";
  const c = rulesCopy(loc);
  const [status, setStatus] = useState<WorkspaceRulesStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  // Latest values for the save loop and the unmount flush (state alone would be stale inside a timer).
  const fingerprint = useRef("");
  const draft = useRef("");
  const dirty = useRef(false);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refused = useRef<Refusal | null>(null);
  const noticeRank = useRef<WorkspaceRulesPickNotice>("none");
  const alive = useRef(true);
  const autoOpened = useRef(false);

  const api = () => ipc()?.workspaceRules;

  const sendNotice = useCallback((next: "offered" | "dismissed") => {
    if (!shouldSendPickNotice(noticeRank.current, next)) return;
    noticeRank.current = next;
    void Promise.resolve().then(() => api()?.pickNotice({ state: next })).catch(() => undefined);
  }, []);

  /** Reads the file's state (and, when `replaceText`, its text). One call per open or own command. */
  const read = useCallback(async (replaceText: boolean) => {
    const rules = api();
    if (!rules) { setLoadFailed(true); return; }
    try {
      const next = await rules.get();
      if (!alive.current) return;
      if (!next) { setLoadFailed(true); return; }
      setLoadFailed(false); setStatus(next);
      fingerprint.current = next.fingerprint;
      if (NOTICE_ORDER.indexOf(next.pickNotice) > NOTICE_ORDER.indexOf(noticeRank.current)) noticeRank.current = next.pickNotice;
      if (replaceText) { draft.current = next.text; dirty.current = false; setText(next.text); setSaveState("saved"); }
      return next;
    } catch { if (alive.current) setLoadFailed(true); }
  }, []);

  useEffect(() => {
    alive.current = true;
    void read(true).then((first) => {
      // The pick list is offered once, the first time this screen opens with lines to offer.
      if (first && first.pickNotice === "none" && first.candidatesAvailable > 0 && !first.seeded && !autoOpened.current) { autoOpened.current = true; sendNotice("offered"); setPicking(true); }
    });
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); void flush(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSave = useCallback(async (): Promise<void> => {
    if (inflight.current) { await inflight.current; if (!dirty.current || refused.current) return; }
    const rules = api();
    if (!rules || !dirty.current || refused.current) return;
    const sent = draft.current;
    const run = (async () => {
      if (alive.current) setSaveState("saving");
      try {
        const answer = await rules.save({ text: sent, baseFingerprint: fingerprint.current });
        if (answer.ok) {
          fingerprint.current = answer.fingerprint;
          if (draft.current === sent) dirty.current = false;
          if (alive.current) { setRefusal(null); refused.current = null; setSaveState(dirty.current ? "dirty" : "saved"); }
        } else { const why: Refusal = answer.code === "rules_full" ? "save_full" : answer.code; refused.current = why; if (alive.current) { setRefusal(why); setSaveState("dirty"); } }
      } catch { refused.current = "save_failed"; if (alive.current) { setRefusal("save_failed"); setSaveState("dirty"); } }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
    if (alive.current && !refused.current && !dirty.current) void read(false); // own command done: the numbers (bytes, overflow) once
    else if (dirty.current && !refused.current && alive.current) schedule();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    await doSave();
  }, [doSave]);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void doSave(); }, AUTOSAVE_MS);
  }, [doSave]);

  const onChange = (value: string) => {
    draft.current = value; dirty.current = true; setText(value); setResult("");
    if (refused.current) { setSaveState("dirty"); return; } // a refused write waits for the person's [action]; typing never retries it
    setSaveState("dirty"); schedule();
  };

  const runAction = async (id: RulesAction) => {
    if (busy) return;
    if (id === "pick") { await openPick(); return; }
    if (id === "clear") { setConfirmClear(true); return; }
    setBusy(true);
    try {
      if (id === "retry") { refused.current = null; setRefusal(null); await doSave(); }
      else if (id === "reread") { refused.current = null; setRefusal(null); await read(true); }
      else if (id === "create") {
        const answer = await api()?.clear({ baseFingerprint: fingerprint.current });
        if (answer?.ok) { fingerprint.current = answer.fingerprint; await read(true); } else if (answer) { refused.current = answer.code; setRefusal(answer.code); }
      }
    } catch { refused.current = "save_failed"; setRefusal("save_failed"); }
    finally { if (alive.current) setBusy(false); }
  };

  const openPick = async () => {
    await flush();
    if (refused.current) return; // the refusal line says why; the file must be what the list is computed against
    sendNotice("offered");
    setPicking(true);
  };
  const onPickDone = (outcome: PickOutcome) => {
    setPicking(false);
    if (outcome.kind === "closed") { sendNotice("dismissed"); return; }
    if (outcome.kind === "added") {
      noticeRank.current = "done"; fingerprint.current = outcome.fingerprint; refused.current = null; setRefusal(null);
      setResult(rulesCopy(loc).dialog.result(outcome.added, outcome.alreadyThere, outcome.unknown));
    }
    void read(true);
  };

  const openRulesFile = async () => {
    try {
      const answer = await api()?.openFile?.();
      if (answer && !answer.ok) setResult(c.openFailed);
    } catch { setResult(c.openFailed); }
  };

  const confirmClearNow = async () => {
    setConfirmClear(false); setBusy(true);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    try {
      if (inflight.current) await inflight.current;
      const answer = await api()?.clear({ baseFingerprint: fingerprint.current });
      if (answer?.ok) { fingerprint.current = answer.fingerprint; refused.current = null; setRefusal(null); setResult(""); await read(true); }
      else if (answer) { refused.current = answer.code; setRefusal(answer.code); setSaveState("dirty"); }
    } catch { refused.current = "save_failed"; setRefusal("save_failed"); }
    finally { if (alive.current) setBusy(false); }
  };

  if (!status) {
    return (
      <div className={styles.page} data-workspace-rules="loading">
        <div className={styles.head}><h1>{c.title}</h1></div>
        {loadFailed
          ? <div className={styles.line} data-kind="warn" role="alert"><div className={styles.lineText}><b>{c.loadFailed}</b></div><button type="button" className={styles.lineBtn} onClick={() => void read(true)}>{c.retry}</button></div>
          : <p className={styles.quiet} role="status">{c.loading}</p>}
      </div>
    );
  }

  const lines = stateLines(loc, status, refusal);
  const savedWord = saveState === "saving" ? c.saving : saveState === "dirty" ? c.unsaved : c.saved;
  const footerLeft = [savedWord, c.local, status.accountLabel].filter(Boolean).join(" · ");
  const editable = status.editable;
  return (
    <div className={styles.page} data-workspace-rules="ready" data-file-state={status.fileState} data-switch={status.state}>
      <div className={styles.head}>
        <h1>{c.title}</h1>
        <div className={styles.headActions}>
          <button type="button" className={styles.btn} onClick={() => void openPick()} disabled={busy}><IconListCheck size={15} />{c.pick}</button>
          {api()?.openFile ? <button type="button" className={styles.btn} onClick={() => void openRulesFile()} disabled={busy || status.fileState === "missing"} data-workspace-rules-open="true">{c.open}</button> : null}
          <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={() => setConfirmClear(true)} disabled={busy || !status.clearable || (!text && status.fileState !== "rules_unreadable")}>{c.clear}</button>
        </div>
      </div>
      <div className={styles.who}>
        {c.chips.map((chip) => <span key={chip}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12l5 5L20 6" /></svg>{chip}</span>)}
        <span className={styles.no}>{c.notRead}</span>
      </div>
      <textarea className={styles.editor} value={text} onChange={(event) => onChange(event.target.value)} onBlur={() => void flush()}
        readOnly={!editable} spellCheck={false} placeholder={editable ? c.placeholder : ""} aria-label={c.editorLabel} data-testid="workspace-rules-editor" />
      <div className={styles.foot}><span data-testid="workspace-rules-saved">{footerLeft}</span><span>{c.noAuto}</span></div>
      {result ? <p className={styles.result} role="status" data-testid="workspace-rules-result">{result}</p> : null}
      {lines.length ? (
        <div className={styles.lines} data-testid="workspace-rules-lines">
          {lines.map((line) => line.kind === "divider"
            ? <div className={styles.divider} key={line.id} data-line={line.id}><span>{line.title}</span></div>
            : (
              <div className={styles.line} key={line.id} data-kind={line.kind} data-line={line.id} role={line.id === "refusal" ? "alert" : undefined}>
                <span className={styles.lineIcon}>{LINE_ICON[line.icon]()}</span>
                <div className={styles.lineText}><b>{line.title}</b><span>{line.body}</span></div>
                {line.action ? <button type="button" className={styles.lineBtn} onClick={() => void runAction(line.action!.id)} disabled={busy}>{line.action.label}</button> : null}
              </div>
            ))}
        </div>
      ) : null}
      {picking ? <PickFromEarlier locale={loc} baseFingerprint={() => fingerprint.current} onDone={onPickDone} /> : null}
      {confirmClear ? (
        <PopupFrame title={c.clearConfirm.title} closeLabel={c.cancel} onClose={() => setConfirmClear(false)} role="alertdialog"
          footer={<div className={styles.pickFooter}><PopupAction onClick={() => setConfirmClear(false)}>{c.cancel}</PopupAction><PopupAction danger onClick={() => void confirmClearNow()}>{c.clearConfirm.ok}</PopupAction></div>}>
          <p className={styles.confirmBody}>{c.clearConfirm.body}</p>
        </PopupFrame>
      ) : null}
    </div>
  );
}
