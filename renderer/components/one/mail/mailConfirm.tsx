"use client";

// In-app confirmation for destructive mail actions (delete conversation, contact,
// domain). Replaces window.confirm, whose buttons follow the OS language ("Cancel"
// / "OK" on a Korean screen) and cannot be styled. Rendered in its own root so any
// mail surface (mailbox, contacts, the One edit dialog) can ask without a host.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Locale } from "@/lib/i18n";
import { OneBottomSheet } from "../OneBottomSheet";
import styles from "./OneMail.module.css";

const COPY: Record<Locale, { cancel: string; delete: string; title: string }> = {
  ko: { cancel: "취소", delete: "삭제", title: "삭제할까요?" },
  en: { cancel: "Cancel", delete: "Delete", title: "Delete?" },
};

function ConfirmSheet({ locale, title, body, confirmLabel, onDone }: {
  locale: Locale;
  title: string;
  body: string;
  confirmLabel: string;
  onDone: (ok: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const finish = (ok: boolean) => { setOpen(false); onDone(ok); };
  const copy = COPY[locale] ?? COPY.en;
  return (
    <OneBottomSheet
      open={open}
      onClose={() => finish(false)}
      closeLabel={copy.cancel}
      size="compact"
      dialogRole="alertdialog"
      title={title}
      titleId="one-mail-confirm-title"
      hideHeaderClose
      footer={(
        <div className={styles.confirmActions} data-one-mail-confirm>
          <button type="button" className={styles.blockSecondary} onClick={() => finish(false)} data-one-mail-confirm-cancel>{copy.cancel}</button>
          <button type="button" className={styles.dangerButton} onClick={() => finish(true)} data-one-mail-confirm-ok autoFocus>{confirmLabel}</button>
        </div>
      )}
    >
      <p className={styles.confirmBody}>{body}</p>
    </OneBottomSheet>
  );
}

/** Ask before a destructive mail action. Resolves true only when the owner pressed the danger button. */
export function confirmMailAction(input: { locale: Locale; body: string; title?: string; confirmLabel?: string }): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  const copy = COPY[input.locale] ?? COPY.en;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-one-mail-confirm-host", "");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
      // Let the sheet's exit run before the root goes away.
      window.setTimeout(() => { root.unmount(); host.remove(); }, 200);
    };
    root.render(
      <ConfirmSheet
        locale={input.locale}
        title={input.title ?? copy.title}
        body={input.body}
        confirmLabel={input.confirmLabel ?? copy.delete}
        onDone={done}
      />,
    );
  });
}
