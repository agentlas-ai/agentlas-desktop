"use client";

// The agreement asked every time "Explore this desktop's apps" is turned on (owner 2026-10-23). Cancel is where focus starts; Escape or a
// click outside cancels; nothing is turned on until "Agree and turn on" is pressed.
import { useEffect, useId, useRef } from "react";
import styles from "./ReachConsentDialog.module.css";

export function ReachConsentDialog({ ko, busy, onCancel, onAgree }: { ko: boolean; busy: boolean; onCancel: () => void; onAgree: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onCancel }); callbacks.current = { onCancel };
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); callbacks.current.onCancel(); return; }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (buttons.length === 0) return;
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); prior?.focus(); };
  }, []);
  return (
    <div className={styles.backdrop} data-reach-consent="true" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}>
        <h3 id={titleId} className={styles.title}>{ko ? "앱 탐색을 켤까요?" : "Turn on app exploration?"}</h3>
        <p id={bodyId} className={styles.body}>
          {ko
            ? "제품 개선을 위해 활동 내역 일부가 Agentlas 로 전송될 수 있습니다. 개인정보가 아니라, 새로 만들어진 앱 관련 스크립트·MCP 메서드의 일부입니다."
            : "To improve the product, part of this activity may be sent to Agentlas. It is not personal information: it is part of the newly created app-related scripts and MCP methods."}
        </p>
        <p className={styles.note}>{ko ? "동의하면 앱 탐색이 켜집니다. 이 스위치로 언제든 끌 수 있습니다." : "If you agree, app exploration turns on. You can turn it off any time with this switch."}</p>
        <div className={styles.actions}>
          <button type="button" onClick={onCancel} disabled={busy}>{ko ? "취소" : "Cancel"}</button>
          <button type="button" onClick={onAgree} disabled={busy}>{ko ? "동의하고 켜기" : "Agree and turn on"}</button>
        </div>
      </div>
    </div>
  );
}
