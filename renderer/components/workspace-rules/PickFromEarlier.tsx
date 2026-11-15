"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRulesCandidates } from "@shared/workspace-rules";
import { ipc } from "@/lib/ipc";
import { PopupAction, PopupFrame } from "../Popup";
import { rulesCopy, type RulesLocale } from "./copy";
import { refusalLine, shortDate, type RulesRefusal } from "./rules-model";
import { IconListCheck } from "./icons";
import styles from "./WorkspaceRules.module.css";

export type PickOutcome =
  | { kind: "added"; fingerprint: string; added: number; alreadyThere: number; unknown: number }
  | { kind: "reread" }
  | { kind: "closed" };

/**
 * "Pick from earlier instructions" (picture E): two groups, every box off, a line is shown whole (never cut), only the picked lines go to the END of the file.
 * It reads `candidates()` once when it opens and calls `addPicked` once per press of [Add N lines]; a refusal stays in the dialog with its one action.
 */
export function PickFromEarlier({ locale, baseFingerprint, onDone }: { locale: RulesLocale; baseFingerprint: () => string; onDone: (outcome: PickOutcome) => void }) {
  const c = rulesCopy(locale);
  const d = c.dialog;
  const [data, setData] = useState<WorkspaceRulesCandidates | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RulesRefusal | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(() => {
    setLoadFailed(false); setData(null);
    Promise.resolve().then(() => ipc()?.workspaceRules?.candidates()).then((answer) => { if (alive.current) { if (answer) setData(answer); else setLoadFailed(true); } }).catch(() => { if (alive.current) setLoadFailed(true); });
  }, []);
  useEffect(load, [load]);

  const toggle = (id: string) => setPicked((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const add = async () => {
    const api = ipc()?.workspaceRules;
    if (!api || busy || picked.size === 0) return;
    setBusy(true); setRefusal(null);
    try {
      const result = await api.addPicked({ ids: [...picked], baseFingerprint: baseFingerprint() });
      if (!alive.current) return;
      if (result.ok) onDone({ kind: "added", fingerprint: result.fingerprint, added: result.added, alreadyThere: result.alreadyThere, unknown: result.unknown });
      else setRefusal(result.code);
    } catch { if (alive.current) setRefusal("save_failed"); }
    finally { if (alive.current) setBusy(false); }
  };

  const total = (data?.personal.length ?? 0) + (data?.heard.length ?? 0);
  const line = refusal ? refusalLine(locale, refusal) : null;
  const act = () => {
    if (!line?.action) return;
    if (line.action.id === "reread") onDone({ kind: "reread" });
    else void add();
  };
  const group = (heading: string, rows: Array<{ id: string; text: string; meta: string }>) => rows.length === 0 ? null : (
    <section className={styles.pickGroup} key={heading}>
      <h3>{heading}</h3>
      {rows.map((row) => (
        <label className={styles.pickRow} key={row.id}>
          <input type="checkbox" checked={picked.has(row.id)} onChange={() => toggle(row.id)} disabled={busy} />
          <span className={styles.pickText}>{row.text}</span>
          <small>{row.meta}</small>
        </label>
      ))}
    </section>
  );
  const date = (iso: string) => shortDate(iso);
  return (
    <PopupFrame title={d.title} icon={<IconListCheck size={18} />} closeLabel={d.close} onClose={() => onDone({ kind: "closed" })} size="wide" busy={busy}
      description={d.lead} dataAttributes={{ "data-workspace-rules-pick": true }}
      footer={<div className={styles.pickFooter}>
        <span className={styles.pickHint}>{picked.size > 0 ? d.hint(picked.size) : ""}</span>
        <PopupAction onClick={() => onDone({ kind: "closed" })} disabled={busy}>{c.later}</PopupAction>
        <PopupAction primary className={styles.dark} onClick={() => void add()} disabled={busy || picked.size === 0}>{d.add(picked.size)}</PopupAction>
      </div>}>
      {loadFailed ? <p className={styles.pickEmpty} role="status">{d.failed} <button type="button" className={styles.linkBtn} onClick={load}>{c.retry}</button></p>
        : data === null ? <p className={styles.pickEmpty} role="status">{d.loading}</p>
        : total === 0 ? <p className={styles.pickEmpty} role="status">{d.none}</p>
        : <>
          {group(d.personal, data.personal.map((row) => ({ id: row.id, text: row.text, meta: date(row.createdAt) })))}
          {group(d.heard, data.heard.map((row) => ({ id: row.id, text: row.text, meta: [row.from.kind === "project" ? d.project(row.from.name) : row.from.name, date(row.createdAt)].filter(Boolean).join(" · ") })))}
          <p className={styles.pickNote}>{d.note}</p>
        </>}
      {line ? <div className={styles.line} data-kind={line.kind} data-line={line.id} role="alert">
        <div className={styles.lineText}><b>{line.title}</b><span>{line.body}</span></div>
        {line.action ? <button type="button" className={styles.lineBtn} onClick={act} disabled={busy}>{line.action.label}</button> : null}
      </div> : null}
    </PopupFrame>
  );
}
