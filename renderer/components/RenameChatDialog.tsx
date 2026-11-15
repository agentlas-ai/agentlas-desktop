"use client";

import { useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { listCopy, listFailureText } from "@/lib/workspace-list-copy";
import { IconEdit } from "./Icon";
import { PopupAction, PopupFrame } from "./Popup";
import styles from "./NewAgentChatDialog.module.css";

/**
 * Rename from the list's right-click menu (chats.rename: a Work task and its root chat are renamed together by Main). One field,
 * Save / Cancel. Cancel and close are always live: a rename that never answers cannot lock the window, and its late answer is dropped.
 */
export function RenameChatDialog({ chatId, current, locale, onClose }: { chatId: string; current: string; locale: "ko" | "en"; onClose: () => void }) {
  const copy = listCopy(locale);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);
  const close = () => { attempt.current += 1; onClose(); };
  const save = async () => {
    const api = ipc();
    const next = value.trim();
    if (!api?.chats?.rename || busy || !next) return;
    const mine = ++attempt.current;
    setBusy(true); setError(null);
    try {
      await api.chats.rename(chatId, next);
      if (mine === attempt.current) onClose();
    } catch (cause) {
      if (mine !== attempt.current) return;
      setBusy(false); setError(listFailureText(cause, locale));
    }
  };
  return (
    <PopupFrame title={copy.renameTitle} icon={<IconEdit size={20} />} closeLabel={copy.close} onClose={close} dataAttributes={{ "data-rename-chat": "true" }}
      footer={<>
        <PopupAction onClick={close}>{copy.cancel}</PopupAction>
        <PopupAction primary data-save="true" onClick={() => void save()} disabled={busy || !value.trim()}>{busy ? copy.renameSaving : copy.renameSave}</PopupAction>
      </>}>
      <div className={styles.body} aria-busy={busy ? "true" : "false"}>
        <label className={styles.title}>{copy.renameLabel}
          <input value={value} maxLength={120} autoFocus disabled={busy} onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
        </label>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </PopupFrame>
  );
}
