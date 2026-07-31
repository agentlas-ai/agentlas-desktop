"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { IconBuilding, IconCheck, IconFileUp, IconLock, IconRefresh } from "@/components/Icon";

interface CloudSaveChoiceDialogProps {
  open: boolean;
  choiceId: string;
  packageName: string;
  ko: boolean;
  busy: boolean;
  error: string | null;
  progress: string | null;
  onCloud: () => void;
  onLocalOnly: () => void;
}

/**
 * The Build already exists locally when this dialog opens. This surface only
 * asks for an explicit owner-private Cloud copy; it never offers public Hub
 * publishing and never dismisses into an ambiguous default.
 */
export function CloudSaveChoiceDialog({
  open,
  choiceId,
  packageName,
  ko,
  busy,
  error,
  progress,
  onCloud,
  onLocalOnly,
}: CloudSaveChoiceDialogProps) {
  const cloudButtonRef = useRef<HTMLButtonElement | null>(null);
  const localButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Privacy-safe default: an accidental Enter must keep the package local,
    // never start an off-device upload.
    const focusTimer = window.setTimeout(() => localButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, choiceId]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onLocalOnly();
      return;
    }
    if (event.key !== "Tab") return;
    const first = cloudButtonRef.current;
    const last = localButtonRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="build-cloud-choice-backdrop titlebar-nodrag"
      data-choice-id={choiceId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onLocalOnly();
      }}
    >
      <section
        className="build-cloud-choice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-cloud-choice-title"
        aria-describedby="build-cloud-choice-description build-cloud-choice-boundary"
        aria-busy={busy}
        onKeyDown={onKeyDown}
      >
        <div className="build-cloud-choice-visual" aria-hidden="true">
          <span className="build-cloud-choice-device"><i /></span>
          <span className="build-cloud-choice-rail"><i /></span>
          <span className="build-cloud-choice-cloud"><IconFileUp size={18} /></span>
          <span className="build-cloud-choice-rail"><i /></span>
          <span className="build-cloud-choice-device build-cloud-choice-device-mobile"><i /></span>
        </div>

        <div className="build-cloud-choice-heading">
          <span className="build-cloud-choice-kicker"><IconCheck size={12} /> {ko ? "로컬 저장 완료" : "Saved locally"}</span>
          <h2 id="build-cloud-choice-title">{ko ? "다른 기기에서도 사용할까요?" : "Use it on your other devices?"}</h2>
          <p id="build-cloud-choice-description">
            {ko
              ? "Cloud에 올리면 같은 계정의 다른 Desktop에서 복원할 수 있어요."
              : "Cloud lets your other signed-in Desktops restore this package."}
          </p>
        </div>

        <div className="build-cloud-choice-package" title={packageName}>
          <span className="build-cloud-choice-package-dot" />
          <strong>{packageName}</strong>
          <span>{ko ? "이 컴퓨터에 설치됨" : "Installed on this computer"}</span>
        </div>

        <div className="build-cloud-choice-actions">
          <button
            ref={cloudButtonRef}
            type="button"
            className="build-cloud-choice-option build-cloud-choice-option-primary"
            disabled={busy}
            onClick={onCloud}
          >
            <span className="build-cloud-choice-option-icon">
              {busy ? <IconRefresh size={18} /> : <IconFileUp size={18} />}
            </span>
            <span>
              <strong>{ko ? "Cloud에 올리기" : "Upload to Cloud"}</strong>
              <small>{ko ? "내 계정에 비공개 보관" : "Private to my account"}</small>
            </span>
          </button>
          <button
            ref={localButtonRef}
            type="button"
            className="build-cloud-choice-option"
            disabled={busy}
            onClick={onLocalOnly}
          >
            <span className="build-cloud-choice-option-icon"><IconBuilding size={18} /></span>
            <span>
              <strong>{ko ? "로컬에만 저장" : "Keep local only"}</strong>
              <small>{ko ? "네트워크 연결 없이 이 컴퓨터에만" : "Only on this computer; no network call"}</small>
            </span>
          </button>
        </div>

        {busy && progress && (
          <div className="build-cloud-choice-progress" role="status" aria-live="polite">
            <IconRefresh size={13} />
            <span>{progress}</span>
          </div>
        )}

        {error && (
          <div className="build-cloud-choice-error" role="alert">
            <IconRefresh size={13} />
            <span>{error}</span>
          </div>
        )}

        <p id="build-cloud-choice-boundary" className="build-cloud-choice-boundary">
          <IconLock size={12} />
          {ko
            ? "Agent Cloud 비공개 · Hub 공개 아님 · 호스팅 LLM 아님. 다른 Desktop에서 복원·설치한 뒤, 그 Desktop에 연결된 Mobile이 호출해요."
            : "Private Agent Cloud · not public Hub · not a hosted LLM. After another Desktop restores and installs it, Mobile calls it through that paired Desktop."}
        </p>
      </section>
    </div>
  );
}
