"use client";

// Connect / sign-in popup in the ChatGPT authorize style (two logos, title, one
// pill button, "나중에"). It drives the same ServiceConnectRun the page already
// owns — the real enable → tools/list probe → OAuth → re-probe sequence. Nothing
// here reports success unless that run resolves.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconClose } from "@/components/Icon";
import type { ServiceConnectProgress, ServiceConnectRun } from "@/components/connect/ServiceConnect";
import styles from "./ToolsUi.module.css";

type Phase = "idle" | "running" | "failed" | "cancelled" | "done";

function IconExternal({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
}

export function AuthorizeDialog({ name, logo, ko, mode, recheck = false, run, onClose, onDone, setupLink }: {
  name: string;
  logo: ReactNode;
  ko: boolean;
  mode: "login" | "connect";
  /** The connection already answered once: the popup says it is checking again, not connecting. */
  recheck?: boolean;
  run: ServiceConnectRun;
  onClose: () => void;
  onDone: () => void;
  setupLink?: { label: string; href: string };
}) {
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ServiceConnectProgress | null>(null);
  const [error, setError] = useState("");
  const [proof, setProof] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const start = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPhase("running"); setError(""); setProgress(null); setProof([]);
    void run(controller.signal, (next) => { if (!controller.signal.aborted) setProgress(next); }).then((result) => {
      if (controller.signal.aborted) return;
      setProof(result?.evidence?.filter(Boolean) ?? []);
      setPhase("done");
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("failed");
    });
  }, [run]);
  const cancel = useCallback(() => { abort.current?.abort(); setPhase("cancelled"); }, []);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (phaseRef.current === "running") cancel(); else closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, [cancel]);

  const title = mode === "login" ? ko ? `${name}에 로그인` : `Sign in to ${name}`
    : recheck ? ko ? `${name} 연결 확인` : `Check the ${name} connection`
    : ko ? `${name} 연결` : `Connect ${name}`;
  const sub = phase === "failed" ? error
    : phase === "cancelled" ? ko ? "취소했어요." : "Cancelled."
    : phase === "done" ? ko ? "연결됐어요. 도구 목록을 실제로 읽어 확인했어요." : "Connected. The live tool list was read."
    : phase === "running" ? progress?.note ?? (ko ? "연결을 확인하고 있어요." : "Checking the connection.")
    : recheck ? ko ? `${name}에 실제로 연결해 도구 목록을 다시 읽습니다` : `Reads the live ${name} tool list again`
    : ko ? `Agentlas가 ${name} 도구를 쓸 수 있게 합니다` : `Lets Agentlas use ${name} tools`;
  const primary = phase === "running"
    ? <><span className={styles.spinner} />{ko ? "연결하는 중…" : "Connecting…"}</>
    : phase === "done" ? ko ? "완료" : "Done"
    : phase === "failed" || phase === "cancelled" ? ko ? "다시 시도" : "Try again"
    : mode === "login" ? <>{ko ? "로그인" : "Sign in"}<IconExternal /></> : recheck ? ko ? "확인" : "Check" : ko ? "연결" : "Connect";

  return <div className={styles.scrim} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && phaseRef.current !== "running") onClose(); }}>
    <div ref={panel} tabIndex={-1} className={styles.authPanel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-service-connect={name} data-connect-phase={phase}>
      <button type="button" className={`${styles.iconButton} ${styles.modalClose}`} aria-label={ko ? "닫기" : "Close"} onClick={() => { if (phase === "running") cancel(); onClose(); }}><IconClose size={16} /></button>
      <div className={styles.authLogos}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <span className={styles.authApp}><img src="/brand/agentlas-mark.png" alt="Agentlas" /></span>
        <span className={styles.authDots} aria-hidden="true"><span /><span /><span /></span>
        {logo}
      </div>
      <h2 id={titleId} className={styles.authTitle}>{title}</h2>
      <p className={styles.authSub} role={phase === "failed" ? "alert" : "status"} data-tone={phase === "failed" ? "error" : undefined}>{sub}</p>
      {phase === "done" && proof.length > 0 && <ul className={styles.authProof} aria-label={ko ? "연결 근거" : "Connection evidence"}>{proof.map((line) => <li key={line}>{line}</li>)}</ul>}
      {/* The result stays until the person closes it: it used to flash for under a second and the evidence was dropped. */}
      <button type="button" className={styles.authPrimary} disabled={phase === "running"} onClick={phase === "done" ? () => doneRef.current() : start}>{primary}</button>
      {phase === "running" && progress?.manualUrl && <a className={styles.authLink} href={progress.manualUrl} target="_blank" rel="noopener noreferrer">{ko ? "공식 로그인 페이지 열기" : "Open the official sign-in page"}</a>}
      {phase === "failed" && setupLink && <div><a className={styles.authLink} href={setupLink.href}>{setupLink.label}</a></div>}
      {phase !== "done" && <div><button type="button" className={styles.authLater} onClick={() => { if (phase === "running") cancel(); else onClose(); }}>{phase === "running" ? ko ? "취소" : "Cancel" : ko ? "나중에" : "Later"}</button></div>}
    </div>
  </div>;
}
