"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { PluginPickerDialog } from "../plugins/PluginPickerDialog";
import { keySaveInterruptionText, keySaveSessionIdentity, type KeySavePhase } from "../plugins/PluginPickerCore";

/** The same existing service picker from Settings or a pending original request.
 * Registry changes never resolve a request; its dedicated native receipt does. */
export function ServiceConnectionsButton({ locale, requestServerId, requestName, disabled = false, embedded = false, active = true, portalTarget, onOpenChange, closeRequest }: {
  locale: "ko" | "en";
  requestServerId?: string;
  requestName?: string;
  disabled?: boolean;
  embedded?: boolean;
  active?: boolean;
  portalTarget?: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
  closeRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  const ko = locale === "ko";
  const generation = useRef(0);
  const pickerId = useId();
  const showing = useRef(false);
  const savePhase = useRef<KeySavePhase | null>(null);
  const [interruption, setInterruption] = useState<KeySavePhase | null>(null);
  const rememberInterruption = (phase: KeySavePhase) => setInterruption(current => current === "write-started" ? current : phase);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousActive = useRef(active);
  useLayoutEffect(() => {
    if (portalTarget && previousActive.current && !active) trigger.current?.focus();
    previousActive.current = active;
  }, [active, portalTarget]);
  const portalTargetRef = useRef(portalTarget);
  portalTargetRef.current = portalTarget;
  const previousCloseRequest = useRef(closeRequest);
  const locked = useRef(disabled);
  locked.current = disabled;
  const close = () => { const wasOpen = showing.current; generation.current += 1; showing.current = false; savePhase.current = null; setOpen(false); if (wasOpen) { onOpenChange?.(false); } };
  useEffect(() => {
    if (previousCloseRequest.current === closeRequest) return;
    previousCloseRequest.current = closeRequest;
    if (showing.current && portalTargetRef.current) { onOpenChange?.(false); }
  }, [closeRequest]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  // A picker result belongs to its opening, not a later reopened dialog or request.
  useEffect(() => { close(); }, [requestServerId]);
  useEffect(() => {
    let alive = true;
    let identity: string | null | undefined;
    let events = 0;
    void window.agentlas?.auth?.getSession?.().then(session => { if (alive && events === 0) identity = keySaveSessionIdentity(session); }).catch(() => undefined);
    const unsubscribe = ipc()?.auth?.onSessionChanged?.((session) => {
      if (!alive) return;
      events += 1;
      const next = keySaveSessionIdentity(session);
      const changed = identity === undefined || next === null || identity !== next;
      identity = next;
      if (!changed) return;
      if (savePhase.current) rememberInterruption(savePhase.current);
      close();
    });
    return () => { alive = false; generation.current += 1; unsubscribe?.(); };
  }, []);
  const owner = generation.current;
  const picker = <div id={pickerId}><PluginPickerDialog ko={ko} embedded={embedded} active={active} onClose={() => { if (generation.current === owner) close(); }}
      onKeySavePhase={phase => { if (generation.current === owner) savePhase.current = phase; }}
      onKeySaveInterrupted={phase => { if (generation.current === owner) rememberInterruption(phase); }}
      isKeySaveOwnerCurrent={() => generation.current === owner}
      contextNote={requestServerId ? ko
        ? `${requestName || "현재 도구"}의 키 요청은 그대로 유지됩니다. 연결 추가는 현재 요청의 계정·권한·저장 결과를 바꾸지 않습니다.`
        : `The key request for ${requestName || "this tool"} stays pending. Adding a connection does not change its account, permission, or save receipt.`
        : undefined}
      onCustomSetup={() => { if (locked.current || generation.current !== owner) return; close(); navigate("/library/mcps#custom"); }} /></div>;
  return <>
    {interruption && <p role="status">{keySaveInterruptionText(interruption, ko)}{" "}<button type="button" onClick={() => setInterruption(null)}>{ko ? "닫기" : "Dismiss"}</button></p>}
    <button ref={trigger} type="button" disabled={disabled || (embedded && portalTarget === null)} onClick={() => { if (locked.current) return; if (showing.current) { if (portalTargetRef.current) { onOpenChange?.(true); } return; } generation.current += 1; showing.current = true; setOpen(true); onOpenChange?.(true); }} aria-haspopup={embedded ? undefined : "dialog"} aria-expanded={embedded ? (portalTarget ? active && open : open) : undefined} aria-controls={embedded && open ? pickerId : undefined}
      style={{ padding: "8px 12px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}>
      {requestServerId ? ko ? "서비스 연결 확인" : "Review service connection" : ko ? "서비스 검색·연결" : "Find and connect services"}
    </button>
    {open && (portalTarget ? createPortal(picker, portalTarget) : picker)}
  </>;
}
