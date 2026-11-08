"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { PluginPickerDialog } from "../plugins/PluginPickerDialog";

/** The same existing service picker from Settings or a pending original request.
 * Registry changes never resolve a request; its dedicated native receipt does. */
export function ServiceConnectionsButton({ locale, requestServerId, requestName, disabled = false, embedded = false, active = true }: {
  locale: "ko" | "en";
  requestServerId?: string;
  requestName?: string;
  disabled?: boolean;
  embedded?: boolean;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ko = locale === "ko";
  const generation = useRef(0);
  const pickerId = useId();
  const showing = useRef(false);
  const locked = useRef(disabled);
  locked.current = disabled;
  const close = () => { generation.current += 1; showing.current = false; setOpen(false); };
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  // A picker result belongs to its opening, not a later reopened dialog or request.
  useEffect(() => { close(); }, [requestServerId]);
  useEffect(() => {
    let alive = true;
    const unsubscribe = ipc()?.auth?.onSessionChanged?.(() => { if (alive) close(); });
    return () => { alive = false; generation.current += 1; unsubscribe?.(); };
  }, []);
  const owner = generation.current;
  return <>
    <button type="button" disabled={disabled} onClick={() => { if (locked.current || showing.current) return; generation.current += 1; showing.current = true; setOpen(true); }} aria-haspopup={embedded ? undefined : "dialog"} aria-expanded={embedded ? open : undefined} aria-controls={embedded && open ? pickerId : undefined}
      style={{ padding: "8px 12px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}>
      {requestServerId ? ko ? "서비스 연결 확인" : "Review service connection" : ko ? "서비스 검색·연결" : "Find and connect services"}
    </button>
    {open && <div id={pickerId}><PluginPickerDialog ko={ko} embedded={embedded} active={active} onClose={() => { if (generation.current === owner) close(); }}
      contextNote={requestServerId ? ko
        ? `${requestName || "현재 도구"}의 키 요청은 그대로 유지됩니다. 연결 추가는 현재 요청의 계정·권한·저장 결과를 바꾸지 않습니다.`
        : `The key request for ${requestName || "this tool"} stays pending. Adding a connection does not change its account, permission, or save receipt.`
        : undefined}
      onCustomSetup={() => { if (locked.current || generation.current !== owner) return; close(); navigate("/library/mcps#custom"); }} /></div>}
  </>;
}
