"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./ConnectChips.module.css";

export type ServiceConnectStep = "checking" | "setup" | "login" | "verifying" | "done";
export interface ServiceConnectProgress {
  step: ServiceConnectStep;
  note: string;
  evidence?: string[];
  manualUrl?: string | null;
}
export type ServiceConnectRun = (signal: AbortSignal, update: (progress: ServiceConnectProgress) => void) => Promise<{ evidence: string[] }>;

/** Shared visual stepper; each service keeps its existing Main-owned API. */
export function ConnectSteps({ labels, current, failed = false, done = false }: {
  labels: string[]; current: number; failed?: boolean; done?: boolean;
}) {
  return <ol className={styles.steps} aria-live="polite">{labels.map((label, index) => {
    const status = done || index < current ? "done" : index === current ? (failed ? "failed" : "current") : "todo";
    return <li key={label} data-status={status}><span className={styles.dot} aria-hidden="true">{status === "done" ? "✓" : status === "failed" ? "!" : ""}</span><span>{label}</span></li>;
  })}</ol>;
}

/** Cancellation stops renderer follow-up work and ignores late IPC replies. */
export function ServiceConnectPopup({ name, icon, ko, run, onClose, onDone, setupLink }: {
  name: string; icon: React.ReactNode; ko: boolean; run: ServiceConnectRun;
  onClose: () => void; onDone: () => void; setupLink?: { label: string; href: string };
}) {
  const titleId = useId();
  const [progress, setProgress] = useState<ServiceConnectProgress>({ step: "checking", note: ko ? "연결 상태를 확인하고 있어요." : "Checking the connection." });
  const [phase, setPhase] = useState<"running" | "failed" | "cancelled" | "done">("running");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const start = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPhase("running"); setError("");
    setProgress({ step: "checking", note: ko ? "연결 상태를 확인하고 있어요." : "Checking the connection." });
    void run(controller.signal, (next) => { if (!controller.signal.aborted) setProgress(next); }).then((result) => {
      if (controller.signal.aborted) return;
      setProgress({ step: "done", note: ko ? "실제 연결을 확인했어요." : "The live connection was verified.", evidence: result.evidence });
      setPhase("done");
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason)); setPhase("failed");
    });
  }, [run, ko]);
  useEffect(() => { start(); return () => abort.current?.abort(); }, [start]);
  useEffect(() => {
    if (phase !== "done") return;
    const timer = window.setTimeout(() => doneRef.current(), 900);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const cancel = useCallback(() => { abort.current?.abort(); setPhase("cancelled"); }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (phaseRef.current === "running") cancel(); else closeRef.current(); }
      if (event.key === "Tab") {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => { document.removeEventListener("keydown", handler, true); previous?.focus(); };
  }, [cancel]);
  useEffect(() => { panel.current?.focus(); }, [phase]);
  const order: ServiceConnectStep[] = ["checking", "setup", "login", "verifying", "done"];
  const labels = ko ? ["연결 확인", "설정", "로그인", "실제 연결 확인", "완료"] : ["Check", "Setup", "Sign in", "Verify live connection", "Done"];
  return <div className={styles.scrim} role="presentation"><div ref={panel} tabIndex={-1} className={styles.popup} role="dialog" aria-modal="true" aria-labelledby={titleId} data-service-connect={name} data-connect-phase={phase} data-connect-step={progress.step}>
    <div className={styles.popupHead}>{icon}<h2 id={titleId}>{ko ? `${name} 연결` : `Connect ${name}`}</h2></div>
    <ConnectSteps labels={labels} current={order.indexOf(progress.step)} failed={phase === "failed" || phase === "cancelled"} done={phase === "done"} />
    <p className={styles.note} role={phase === "failed" ? "alert" : "status"} data-tone={phase === "failed" ? "error" : undefined}>{phase === "failed" ? error : phase === "cancelled" ? (ko ? "이 창의 연결 확인을 취소했어요. 이미 열린 로그인 창과 시작된 설정은 남아 있을 수 있어요." : "Stopped checking here. An already opened sign-in window or started setup may remain.") : progress.note}</p>
    {progress.evidence?.map((fact) => <p key={fact} className={styles.note}>{fact}</p>)}
    {progress.manualUrl && <a className={styles.link} href={progress.manualUrl} target="_blank" rel="noopener noreferrer">{ko ? "공식 로그인 페이지 열기" : "Open the official sign-in page"}</a>}
    {phase === "failed" && setupLink && <a className={styles.link} href={setupLink.href}>{setupLink.label}</a>}
    <div className={styles.actions}>{phase === "running" ? <button type="button" className={styles.button} onClick={cancel}>{ko ? "취소" : "Cancel"}</button> : <><button type="button" className={styles.button} onClick={onClose}>{ko ? "닫기" : "Close"}</button>{phase !== "done" && <button type="button" className={styles.button} data-variant="primary" onClick={start}>{ko ? "다시 시도" : "Retry"}</button>}</>}</div>
  </div></div>;
}

export function waitForConnectPoll(signal: AbortSignal, delayMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("cancelled")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
