// "업데이트하고 이어하기" — the in-app confirm shown when the person presses update while work runs.
//
// Main counts and names the running work (updater/update-resume.ts). [업데이트하고 이어하기] pauses
// that work for the update and continues it after the restart; [나중에] keeps the update ready and
// installs it the next time the app quits. Never a browser dialog (owner brief 2026-09-28).
"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

export function UpdateResumeConfirm({
  count,
  line,
  busy,
  onInstall,
  onLater,
}: {
  count: number;
  line?: string;
  busy: boolean;
  onInstall: () => void;
  onLater: () => void;
}) {
  const { t } = useT();
  const installRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    installRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onLater();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onLater]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="titlebar-nodrag"
      style={{ position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", alignItems: "center", justifyContent: "center",
        background: "color-mix(in srgb, var(--black, #000) 32%, transparent)", padding: 16 }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-resume-confirm-title"
        aria-describedby={line ? "update-resume-confirm-line" : undefined}
        data-update-resume-confirm="true"
        style={{ width: "min(440px, 100%)", borderRadius: 14, background: "var(--paper, #fff)", color: "var(--ink, #111)",
          boxShadow: "0 18px 48px rgba(0,0,0,.22)", padding: "20px 20px 16px", display: "grid", gap: 10 }}
      >
        <h2 id="update-resume-confirm-title" style={{ margin: 0, fontSize: 15, lineHeight: 1.45, fontWeight: 600 }}>
          {t("update.resume_confirm_title", { n: String(count) })}
        </h2>
        {line && (
          <p id="update-resume-confirm-line" data-update-resume-line style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--muted-deep, #555)", overflowWrap: "anywhere" }}>
            {line}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            data-update-resume-action="later"
            disabled={busy}
            onClick={onLater}
            style={{ border: "1px solid var(--paper-edge, #ddd)", background: "transparent", color: "var(--ink, #111)",
              borderRadius: 8, padding: "7px 12px", fontSize: 13, cursor: busy ? "default" : "pointer" }}
          >
            {t("update.resume_confirm_later")}
          </button>
          <button
            ref={installRef}
            type="button"
            data-update-resume-action="install"
            disabled={busy}
            onClick={onInstall}
            style={{ border: 0, background: "var(--black, #111)", color: "var(--white, #fff)",
              borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer" }}
          >
            {t("update.resume_confirm_install")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
