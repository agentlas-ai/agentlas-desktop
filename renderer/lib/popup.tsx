"use client";

import { createRoot } from "react-dom/client";
import { PopupAction, PopupDetails, PopupFrame } from "@/components/Popup";
import { IconAlertTriangle, IconCheck, IconShield, IconTrash } from "@/components/Icon";
import styles from "@/components/Popup.module.css";

export type PopupOptions = {
  locale?: "ko" | "en";
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "neutral" | "danger" | "warning";
  /** Extra context remains available without competing with the decision. */
  detail?: string;
};

type Request = { message: string; options: PopupOptions; confirm: boolean; resolve: (value: boolean) => void };
const queue: Request[] = [];
let showing = false;
let sequence = 0;

function currentLocale(options: PopupOptions): "ko" | "en" {
  if (options.locale) return options.locale;
  try {
    const preference = window.localStorage.getItem("agentlas.locale");
    if (preference === "ko" || preference === "en") return preference;
  } catch { /* The browser language is still available without storage. */ }
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function presentNext() {
  if (showing || queue.length === 0 || typeof document === "undefined") return;
  showing = true;
  const request = queue.shift()!;
  const { message, options, confirm } = request;
  const ko = currentLocale(options) === "ko";
  const normalizedMessage = message.trim();
  const firstLine = normalizedMessage.split("\n")[0].trim();
  const title = options.title ?? (firstLine.length <= 80 ? firstLine : ko ? "확인" : "Confirm");
  const body = options.title || title !== firstLine ? normalizedMessage : normalizedMessage.slice(firstLine.length).trim();
  const host = document.createElement("div");
  const messageId = `agentlas-popup-message-${++sequence}`;
  host.dataset.popupHost = "true";
  document.body.appendChild(host);
  const root = createRoot(host);
  let settled = false;
  const finish = (accepted: boolean) => {
    if (settled) return;
    settled = true;
    queueMicrotask(() => {
      root.unmount();
      host.remove();
      showing = false;
      request.resolve(accepted);
      presentNext();
    });
  };
  const icon = options.tone === "danger" ? <IconTrash size={20} />
    : options.tone === "warning" ? <IconAlertTriangle size={20} /> : <IconShield size={20} />;
  root.render(<PopupFrame title={title} icon={icon} closeLabel={ko ? "닫기" : "Close"} onClose={() => finish(false)} role={confirm ? "alertdialog" : "dialog"}
    dataAttributes={{"data-app-confirmation": confirm ? "confirm" : "notice"}} ariaDescribedBy={body ? messageId : undefined}
    footer={<>
      {confirm && <PopupAction onClick={() => finish(false)}>{options.cancelLabel ?? (ko ? "취소" : "Cancel")}</PopupAction>}
      <PopupAction primary danger={options.tone === "danger"} icon={confirm ? icon : <IconCheck size={16} />}
        onClick={() => finish(true)}>{options.confirmLabel ?? (confirm ? ko ? "계속" : "Continue" : ko ? "확인" : "OK")}</PopupAction>
    </>}>
    {body && <p id={messageId} className={styles.message}>{body}</p>}
    {options.detail && <PopupDetails label={ko ? "자세히" : "Details"}><p>{options.detail}</p></PopupDetails>}
  </PopupFrame>);
}

/** In-app asynchronous confirmation. Cancellation never runs the guarded action. */
export function confirmPopup(message: string, options: PopupOptions = {}): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => { queue.push({ message, options, confirm: true, resolve }); presentNext(); });
}

export async function alertPopup(message: string, options: PopupOptions = {}): Promise<void> {
  if (typeof document === "undefined") return;
  await new Promise<boolean>((resolve) => { queue.push({ message, options, confirm: false, resolve }); presentNext(); });
}
