"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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
  const ko = locale === "ko";
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
    ? (ko
      ? "입력창을 선택한 상태에서 Fn 또는 지구본 키를 두 번 누르세요. Mac 받아쓰기 설정에 따라 단축키가 다를 수 있습니다."
      : "With the composer focused, press Fn or the Globe key twice. Your Mac dictation shortcut may be configured differently.")
    : platform === "windows"
      ? (ko
        ? "입력창을 선택한 상태에서 Windows 키 + H를 누르세요."
        : "With the composer focused, press Windows key + H.")
      : (ko
        ? "입력창을 선택한 뒤 운영체제의 받아쓰기 단축키를 사용하세요."
        : "Focus the composer, then use your operating system's dictation shortcut.");

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
        aria-label={ko ? "시스템 받아쓰기로 입력" : "Enter with system dictation"}
        aria-expanded={open}
        aria-controls={panelId}
        title={ko ? "음성 입력" : "Voice input"}
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
          <strong id={titleId}>{ko ? "시스템 받아쓰기 사용" : "Use system dictation"}</strong>
          <p id={instructionId}>{instruction}</p>
          <small id={privacyId}>
            {ko
              ? "One은 여기서 마이크를 켜거나 음성 파일을 저장하지 않습니다. 받아쓴 텍스트를 확인한 뒤 직접 보내세요."
              : "One does not turn on the microphone or save audio here. Review the dictated text before sending it yourself."}
          </small>
          <button type="button" onClick={closeToComposer}>
            {ko ? "입력창으로 돌아가기" : "Return to composer"}
          </button>
        </div>
      )}
    </div>
  );
}
