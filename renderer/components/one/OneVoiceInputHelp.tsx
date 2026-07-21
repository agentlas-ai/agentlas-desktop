"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { tFor } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import styles from "./OneVoiceInputHelp.module.css";

type OneVoiceInputHelpProps = {
  locale: "ko" | "en";
  composerRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
};

type DictationPlatform = "mac" | "windows" | "other";

function dictationPlatform(): DictationPlatform {
  if (typeof navigator === "undefined") return "other";
  const value = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (value.includes("mac")) return "mac";
  if (value.includes("win")) return "windows";
  return "other";
}

/**
 * Desktop deliberately delegates speech recognition to the operating system.
 *
 * Electron/Web Speech availability is not consistent enough to represent as
 * an Agentlas recording feature. This control focuses the real composer and
 * explains the verified OS shortcut without claiming that One is listening.
 */
export function OneVoiceInputHelp({ locale, composerRef, disabled = false }: OneVoiceInputHelpProps) {
  const platform = useMemo(dictationPlatform, []);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const panelId = `${id}-one-dictation-help`;
  const titleId = `${id}-one-dictation-title`;
  const instructionId = `${id}-one-dictation-instruction`;
  const privacyId = `${id}-one-dictation-privacy`;

  useDismissibleLayer({
    open,
    roots: [panelRef, triggerRef],
    onDismiss: () => setOpen(false),
    restoreFocusRef: triggerRef,
  });

  const instruction = platform === "mac"
    ? tFor(locale, "one.voice.instr_mac")
    : platform === "windows"
      ? tFor(locale, "one.voice.instr_windows")
      : tFor(locale, "one.voice.instr_other");

  const toggle = () => {
    if (disabled) return;
    composerRef.current?.focus();
    setOpen((current) => !current);
  };

  const closeToComposer = () => {
    setOpen(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        onClick={toggle}
        aria-label={tFor(locale, "one.voice.trigger_aria")}
        aria-expanded={open}
        aria-controls={panelId}
        title={tFor(locale, "one.voice.trigger_title")}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className={styles.panel}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={`${instructionId} ${privacyId}`}
          aria-live="polite"
          onKeyDown={handlePanelKeyDown}
        >
          <strong id={titleId}>{tFor(locale, "one.voice.panel_title")}</strong>
          <p id={instructionId}>{instruction}</p>
          <small id={privacyId}>
            {tFor(locale, "one.voice.privacy")}
          </small>
          <button type="button" onClick={closeToComposer}>
            {tFor(locale, "one.voice.return_composer")}
          </button>
        </div>
      )}
    </div>
  );
}
