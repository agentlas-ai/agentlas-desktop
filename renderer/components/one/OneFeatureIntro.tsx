"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OneFeatureIntroResolution } from "@shared/one-feature-intro";
import { tFor } from "@/lib/i18n";
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
  briefingAvailable = false,
  onConnectMobile,
}: {
  eligible: boolean;
  needsAcknowledgement: boolean;
  locale: "ko" | "en";
  replayToken?: number;
  onResolve: (resolution: OneFeatureIntroResolution) => void | Promise<void>;
  onOpenOne: () => void;
  onKeepWork: () => void;
  /**
   * AC-022.4: the last slide must lead to a real One Briefing or to Mobile
   * pairing, never to a generic "get started". The caller owns the truth about
   * whether a briefing actually exists right now.
   */
  briefingAvailable?: boolean;
  onConnectMobile?: () => void;
}) {
  const slides = useMemo<IntroSlide[]>(
    () => [
      { eyebrow: "ONE", title: tFor(locale, "one.feat.slide.briefing.title"), body: tFor(locale, "one.feat.slide.briefing.body"), preview: "briefing" },
      { eyebrow: "ONE + WORK", title: tFor(locale, "one.feat.slide.work.title"), body: tFor(locale, "one.feat.slide.work.body"), preview: "work" },
      { eyebrow: "MOBILE", title: tFor(locale, "one.feat.slide.mobile.title"), body: tFor(locale, "one.feat.slide.mobile.body"), preview: "mobile" },
      { eyebrow: "NEXT TIME", title: tFor(locale, "one.feat.slide.proof.title"), body: tFor(locale, "one.feat.slide.proof.body"), preview: "proof" },
    ],
    [locale],
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
            <IntroPreview kind={slide.preview} locale={locale} />
          </div>
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.button} onClick={close} disabled={resolving}>{tFor(locale, "one.feat.action.skip")}</button>
          <div className={styles.footerGroup}>
            {index > 0 && <button type="button" className={styles.button} onClick={() => setIndex((value) => value - 1)} disabled={resolving}>{tFor(locale, "one.feat.action.back")}</button>}
            {!last ? (
              <button type="button" className={styles.buttonPrimary} onClick={() => setIndex((value) => value + 1)} disabled={resolving}>
                {index === 0 ? tFor(locale, "one.feat.action.next_work") : tFor(locale, "one.feat.action.next")}
              </button>
            ) : (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={resolving}
                onClick={() => void finish(
                  "opened_one",
                  briefingAvailable || !onConnectMobile ? onOpenOne : onConnectMobile,
                )}
              >
                {briefingAvailable
                  ? tFor(locale, "one.feat.action.open_briefing")
                  : onConnectMobile
                    ? tFor(locale, "one.feat.action.connect_mobile")
                    : tFor(locale, "one.feat.action.open_one")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function IntroPreview({ kind, locale }: { kind: IntroSlide["preview"]; locale: "ko" | "en" }) {
  if (kind === "work") {
    return (
      <div className={styles.splitPreview}>
        <div className={styles.surfaceCard}><strong>One</strong><span>{tFor(locale, "one.feat.preview.work.one_desc")}</span><span>{tFor(locale, "one.feat.preview.work.same")}</span></div>
        <div className={styles.arrow}>→</div>
        <div className={styles.surfaceCard}><strong>Work</strong><span>{tFor(locale, "one.feat.preview.work.work_desc")}</span><span>{tFor(locale, "one.feat.preview.work.details")}</span></div>
      </div>
    );
  }
  if (kind === "mobile") {
    return (
      <div className={styles.phone}>
        <div className={styles.phoneTop}><span>One</span><span>•••</span></div>
        <div className={styles.decision}><small>{tFor(locale, "one.feat.preview.mobile.decision")}</small><strong>{tFor(locale, "one.feat.preview.mobile.question")}</strong><span className={styles.miniLine} /><span className={styles.decisionAction}>{tFor(locale, "one.feat.preview.mobile.action")}</span></div>
      </div>
    );
  }
  if (kind === "proof") {
    return (
      <div className={styles.miniWindow}>
        <div className={styles.miniBar}><span>{tFor(locale, "one.feat.preview.proof.bar")}</span><span>{tFor(locale, "one.feat.preview.proof.after")}</span></div>
        <div className={`${styles.miniContent} ${styles.proof}`}>
          <div className={styles.proofRow}><span className={styles.proofCheck}>✓</span><span>{tFor(locale, "one.feat.preview.proof.row1")}</span></div>
          <div className={styles.proofRow}><span className={styles.proofCheck}>✓</span><span>{tFor(locale, "one.feat.preview.proof.row2")}</span></div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.miniWindow}>
      <div className={styles.miniBar}><span>Agentlas One</span><span>Work</span></div>
      <div className={styles.miniContent}>
        <div className={styles.miniOne}>One</div>
        <div className={styles.miniTitle}>{tFor(locale, "one.feat.preview.briefing.title")}</div>
        <div className={styles.miniLine} /><div className={styles.miniLine} />
        <div className={styles.miniAction}>{tFor(locale, "one.feat.preview.briefing.action")}</div>
      </div>
    </div>
  );
}
