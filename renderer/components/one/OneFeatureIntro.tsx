"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OneFeatureIntroResolution } from "@shared/one-feature-intro";
import styles from "./OneFeatureIntro.module.css";

type IntroSlide = {
  eyebrow: string;
  title: string;
  body: string;
  preview: "briefing" | "work" | "mobile" | "proof";
};

/**
 * Reusable version-gated introduction. Main owns acknowledgement state; this
 * component never treats renderer storage as authority. The caller also owns
 * eligibility and records deferrals while live work needs attention.
 */
export function OneFeatureIntro({
  eligible,
  needsAcknowledgement,
  locale,
  replayToken = 0,
  onResolve,
  onOpenOne,
  onKeepWork,
}: {
  eligible: boolean;
  needsAcknowledgement: boolean;
  locale: "ko" | "en";
  replayToken?: number;
  onResolve: (resolution: OneFeatureIntroResolution) => void | Promise<void>;
  onOpenOne: () => void;
  onKeepWork: () => void;
}) {
  const ko = locale === "ko";
  const slides = useMemo<IntroSlide[]>(
    () => ko
      ? [
          { eyebrow: "ONE", title: "One이 먼저 챙깁니다.", body: "진행 중인 일에서 놓치기 쉬운 변화와 다음 결정을 미리 찾아 알려드립니다. 기존 대화와 설정은 그대로예요.", preview: "briefing" },
          { eyebrow: "ONE + WORK", title: "말하면, 필요한 팀이 움직입니다.", body: "One에게 평소처럼 말하세요. 더 자세히 보고 싶을 때만 Work에서 팀·파일·도구를 확인할 수 있고, 다시 설명할 필요가 없습니다.", preview: "work" },
          { eyebrow: "MOBILE", title: "결정은 어디서든 이어집니다.", body: "Mobile에서는 중요한 진행 상황과 결과를 확인합니다. Desktop 연결이 끊기면 진행된 것처럼 보여주지 않습니다.", preview: "mobile" },
          { eyebrow: "NEXT TIME", title: "다음 일은 설명이 줄어듭니다.", body: "내가 저장한 취향과 자주 쓰는 팀을 One이 알맞은 때 다시 활용하고, 무엇이 달라졌는지 결과 뒤에 알려줍니다.", preview: "proof" },
        ]
      : [
          { eyebrow: "ONE", title: "One looks out for the work first.", body: "It spots important changes and prepares the next decision. Your existing conversations and settings stay intact.", preview: "briefing" },
          { eyebrow: "ONE + WORK", title: "Say it once. The right team gets moving.", body: "Talk to One normally. Open Work only when you want to inspect the team, files, and tools in detail. You do not need to explain the work again.", preview: "work" },
          { eyebrow: "MOBILE", title: "Decisions continue anywhere.", body: "Mobile shows important progress and results. It never pretends work continued while Desktop was disconnected.", preview: "mobile" },
          { eyebrow: "NEXT TIME", title: "The next task takes less explaining.", body: "One can reuse preferences and teams you saved, then show what changed after the result.", preview: "proof" },
        ],
    [ko],
  );
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [resolving, setResolving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousReplayRef = useRef(replayToken);

  const finish = useCallback(async (
    resolution: OneFeatureIntroResolution,
    next: () => void,
  ) => {
    if (resolving) return;
    setResolving(true);
    try {
      if (needsAcknowledgement) await onResolve(resolution);
    } catch {
      // Keep Main unacknowledged and offer the intro again at a later safe
      // point. Optional feature news does not justify an error trap.
    } finally {
      // A transient persistence error must not trap the user behind a modal.
      // Main remains unacknowledged, so the intro can be offered again later.
      setOpen(false);
      setResolving(false);
      next();
    }
  }, [needsAcknowledgement, onResolve, resolving]);

  useEffect(() => {
    if (replayToken !== previousReplayRef.current) {
      previousReplayRef.current = replayToken;
      setIndex(0);
      setOpen(true);
      return;
    }
    if (eligible && needsAcknowledgement) {
      setIndex(0);
      setOpen(true);
    }
  }, [eligible, needsAcknowledgement, replayToken]);

  useEffect(() => {
    if (!eligible && needsAcknowledgement) {
      // A newly arrived approval, active Task, update, or blocking error wins
      // immediately. Closing is a deferral, never an acknowledgement.
      setOpen(false);
    }
  }, [eligible, needsAcknowledgement]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((value) => Math.min(slides.length - 1, value + 1));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish("kept_work", onKeepWork);
      } else if (event.key === "Tab" && dialog) {
        const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [finish, onKeepWork, open, slides.length]);

  if (!open) return null;
  const slide = slides[index];
  const last = index === slides.length - 1;
  const close = () => void finish("skipped", onKeepWork);

  return (
    <div className={styles.backdrop} role="presentation">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="one-intro-title"
        aria-describedby="one-intro-body"
        tabIndex={-1}
      >
        <header className={styles.top}>
          <span className={styles.brand}>Agentlas</span>
          <span className={styles.count} aria-label={`${index + 1} / ${slides.length}`}>{index + 1} / {slides.length}</span>
        </header>
        <div className={styles.body}>
          <div className={styles.copy}>
            <p className={styles.eyebrow}>{slide.eyebrow}</p>
            <h2 id="one-intro-title">{slide.title}</h2>
            <p id="one-intro-body">{slide.body}</p>
          </div>
          <div className={styles.preview} aria-hidden="true">
            <IntroPreview kind={slide.preview} ko={ko} />
          </div>
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.button} onClick={close} disabled={resolving}>{ko ? "건너뛰기" : "Skip"}</button>
          <div className={styles.footerGroup}>
            {index > 0 && <button type="button" className={styles.button} onClick={() => setIndex((value) => value - 1)} disabled={resolving}>{ko ? "이전" : "Back"}</button>}
            {!last ? (
              <button type="button" className={styles.buttonPrimary} onClick={() => setIndex((value) => value + 1)} disabled={resolving}>
                {index === 0 ? (ko ? "다음: Work 연결" : "Next: Work connection") : ko ? "다음" : "Next"}
              </button>
            ) : (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={resolving}
                onClick={() => void finish("opened_one", onOpenOne)}
              >
                {ko ? "One 시작하기" : "Start with One"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function IntroPreview({ kind, ko }: { kind: IntroSlide["preview"]; ko: boolean }) {
  if (kind === "work") {
    return (
      <div className={styles.splitPreview}>
        <div className={styles.surfaceCard}><strong>One</strong><span>{ko ? "말하기·결정·결과" : "Talk, decide, result"}</span><span>{ko ? "같은 일" : "Same work"}</span></div>
        <div className={styles.arrow}>→</div>
        <div className={styles.surfaceCard}><strong>Work</strong><span>{ko ? "팀·파일·도구·진행 기록" : "Team, files, tools, history"}</span><span>{ko ? "자세히 보기" : "See details"}</span></div>
      </div>
    );
  }
  if (kind === "mobile") {
    return (
      <div className={styles.phone}>
        <div className={styles.phoneTop}><span>One</span><span>•••</span></div>
        <div className={styles.decision}><small>{ko ? "결정 필요" : "Decision needed"}</small><strong>{ko ? "외부 전문가에게 문서 2개를 전달할까요?" : "Share two documents with the external expert?"}</strong><span className={styles.miniLine} /><span className={styles.decisionAction}>{ko ? "이 범위로 검토" : "Review with this scope"}</span></div>
      </div>
    );
  }
  if (kind === "proof") {
    return (
      <div className={styles.miniWindow}>
        <div className={styles.miniBar}><span>{ko ? "이번에 실제로 달라진 점" : "What actually improved"}</span><span>{ko ? "결과 뒤" : "After result"}</span></div>
        <div className={`${styles.miniContent} ${styles.proof}`}>
          <div className={styles.proofRow}><span className={styles.proofCheck}>✓</span><span>{ko ? "지난번 승인한 비교 기준을 다시 사용" : "Reused the comparison criteria you approved"}</span></div>
          <div className={styles.proofRow}><span className={styles.proofCheck}>✓</span><span>{ko ? "검증된 출시 검토팀 역할을 다시 사용" : "Reused the verified launch review team roles"}</span></div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.miniWindow}>
      <div className={styles.miniBar}><span>Agentlas One</span><span>Work</span></div>
      <div className={styles.miniContent}>
        <div className={styles.miniOne}>One</div>
        <div className={styles.miniTitle}>{ko ? "이번 주 확인할 문제가 하나 있어요." : "There is one issue to review this week."}</div>
        <div className={styles.miniLine} /><div className={styles.miniLine} />
        <div className={styles.miniAction}>{ko ? "검토 시작" : "Start review"}</div>
      </div>
    </div>
  );
}
