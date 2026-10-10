"use client";

import { useEffect, useState } from "react";
import { navigate } from "@/lib/navigation";
import { PluginPickerDialog } from "../plugins/PluginPickerDialog";

/** The same existing service picker from Settings or a pending original request.
 * Registry changes never resolve a request; its dedicated native receipt does. */
export function ServiceConnectionsButton({ locale, requestServerId, requestName, disabled = false }: {
  locale: "ko" | "en";
  requestServerId?: string;
  requestName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ko = locale === "ko";
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)} aria-haspopup="dialog"
      style={{ padding: "8px 12px", border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)" }}>
      {requestServerId ? ko ? "서비스 연결 확인" : "Review service connection" : ko ? "서비스 검색·연결" : "Find and connect services"}
    </button>
    {open && <PluginPickerDialog ko={ko} onClose={() => setOpen(false)}
      contextNote={requestServerId ? ko
        ? `${requestName || "현재 도구"}의 키 요청은 그대로 유지됩니다. 연결 추가는 현재 요청의 계정·권한·저장 결과를 바꾸지 않습니다.`
        : `The key request for ${requestName || "this tool"} stays pending. Adding a connection does not change its account, permission, or save receipt.`
        : undefined}
      onCustomSetup={() => { setOpen(false); navigate("/library/mcps#custom"); }} />}
  </>;
}
