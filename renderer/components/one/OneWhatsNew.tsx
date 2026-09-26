"use client";

/*
 * What's New carousel — the feature-intro deck for existing accounts after an update.
 *
 * Not a new system: authority is the same Main-owned One Feature Intro state
 * (oneFeatureIntro IPC, per account). This component only presents the deck for
 * ONE_FEATURE_INTRO_CURRENT_VERSION. The card look follows the Science promo
 * (ScienceInstallExperience): artwork on top, kicker + title + short body, one
 * black pill action, close button over the artwork.
 *
 * Who sees it:
 *   - existing accounts, once per version, when nothing more important is on screen;
 *   - NOT an account that just did first-run setup (its record says audience "new"
 *     and it never acknowledged any intro) — that is recorded as covered_by_first_run;
 *   - anyone, on request: Settings → "새 기능 다시 보기", or the One home button.
 * Closing in any way acknowledges the version ("다시 보지 않기" is implicit).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OneFeatureIntroResolution, OneFeatureIntroState } from "@shared/one-feature-intro";
import { IconClose } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { readFirstRunRecord } from "@/lib/first-run-state";
import {
  WHATS_NEW_OPEN_EVENT,
  WHATS_NEW_SLIDES,
  takeWhatsNewReplayRequest,
  type WhatsNewAction,
} from "@/lib/whats-new";
import styles from "./OneWhatsNew.module.css";

export function OneWhatsNew({
  locale,
  introState,
  blocked,
  replayToken = 0,
  mailEntitled,
  onAcknowledge,
  onAction,
}: {
  locale: "ko" | "en";
  introState: OneFeatureIntroState | null;
  /** Something more important owns the screen (approval, running task, update…). */
  blocked: boolean;
  /** Bump to reopen from the One home button. */
  replayToken?: number;
  /** Free plan → the mail slide leads to plans instead of the create flow. */
  mailEntitled: boolean;
  onAcknowledge: (resolution: OneFeatureIntroResolution) => void | Promise<void>;
  onAction: (action: WhatsNewAction) => void;
}) {
  const ko = locale === "ko";
  const slides = WHATS_NEW_SLIDES;
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const previousReplayRef = useRef(replayToken);
  const autoDecidedRef = useRef<string | null>(null);
  const pending = Boolean(introState && introState.acknowledgedIntroVersion < introState.currentIntroVersion);

  const present = useCallback(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIndex(0);
    setOpen(true);
  }, []);

  // Explicit reopen: One home button, Settings event, or a request carried across routes.
  useEffect(() => {
    if (replayToken !== previousReplayRef.current) {
      previousReplayRef.current = replayToken;
      present();
    }
  }, [present, replayToken]);
  useEffect(() => {
    if (takeWhatsNewReplayRequest()) present();
    const onOpen = () => {
      takeWhatsNewReplayRequest();
      present();
    };
    window.addEventListener(WHATS_NEW_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(WHATS_NEW_OPEN_EVENT, onOpen);
  }, [present]);

  // Automatic, once per version per account.
  useEffect(() => {
    if (!introState || !pending || blocked || open) return;
    const decisionKey = `${introState.oneId}:${introState.currentIntroVersion}`;
    if (autoDecidedRef.current === decisionKey) return;
    let cancelled = false;
    let timer: number | null = null;
    void (async () => {
      const session = await ipc()?.auth.getSession().catch(() => null);
      if (cancelled) return;
      const record = readFirstRunRecord(window.localStorage, session?.accountFingerprint);
      // No record yet = the first-run gate has not classified this account; wait.
      if (!record) return;
      autoDecidedRef.current = decisionKey;
      if (record.audience === "new" && introState.acknowledgedIntroVersion === 0) {
        // They just saw these features in first-run setup. Record, never show.
        void Promise.resolve(onAcknowledge("covered_by_first_run")).catch(() => undefined);
        return;
      }
      timer = window.setTimeout(() => {
        if (cancelled || document.visibilityState !== "visible") {
          autoDecidedRef.current = null;
          return;
        }
        // Another dialog (tour, approval, import) wins; try again on a later render.
        if (document.querySelector('[role="dialog"], dialog[open]')) {
          autoDecidedRef.current = null;
          return;
        }
        present();
      }, 700);
    })();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [blocked, introState, onAcknowledge, open, pending, present]);

  const close = useCallback((resolution: OneFeatureIntroResolution, then?: () => void) => {
    setOpen(false);
    if (pending) void Promise.resolve(onAcknowledge(resolution)).catch(() => undefined);
    window.setTimeout(() => {
      if (then) then();
      else restoreFocusRef.current?.focus?.();
    }, 0);
  }, [onAcknowledge, pending]);

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
        close("skipped");
      } else if (event.key === "Tab" && dialog) {
        const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
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
  }, [close, open, slides.length]);

  if (!open) return null;
  const slide = slides[index];
  const last = index === slides.length - 1;
  const text = (value: { ko: string; en: string }) => (ko ? value.ko : value.en);
  const ctaLabel = slide.id === "mail" && !mailEntitled
    ? (ko ? "플랜 보기" : "See plans")
    : slide.cta
      ? text(slide.cta)
      : last
        ? (ko ? "시작하기" : "Get started")
        : (ko ? "다음" : "Next");
  const onPrimary = () => {
    if (slide.cta) {
      close("opened_one", () => onAction(slide.id));
    } else if (last) {
      close("opened_one");
    } else {
      setIndex((value) => value + 1);
    }
  };
  return (
    <div
      className={`${styles.backdrop} titlebar-nodrag`}
      role="presentation"
      data-one-whats-new="open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close("skipped");
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-roledescription={ko ? "새 기능 안내" : "What's new"}
        aria-labelledby="one-whats-new-title"
        aria-describedby="one-whats-new-body"
        data-slide={slide.id}
        tabIndex={-1}
      >
        <button
          type="button"
          className={styles.close}
          aria-label={ko ? "닫기" : "Close"}
          data-one-whats-new-close
          onClick={() => close("skipped")}
        >
          <IconClose size={16} />
        </button>
        <div className={styles.art} aria-hidden="true" key={slide.id}>
          <img className={styles.artImage} src={slide.image} alt="" width={1104} height={500} />
        </div>
        <div className={styles.body}>
          <span className={styles.kicker}>{text(slide.kicker)}</span>
          <h2 id="one-whats-new-title">{text(slide.title)}</h2>
          <p id="one-whats-new-body">{text(slide.body)}</p>
          <button type="button" className={styles.primary} data-one-whats-new-primary={slide.id} onClick={onPrimary}>
            {ctaLabel}
          </button>
          <nav className={styles.nav} aria-label={ko ? "새 기능 넘기기" : "Browse what's new"}>
            <button
              type="button"
              className={styles.arrow}
              aria-label={ko ? "이전" : "Previous"}
              disabled={index === 0}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
            >
              ‹
            </button>
            <span className={styles.dots}>
              {slides.map((item, dot) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.dot}
                  data-active={dot === index ? "true" : "false"}
                  aria-current={dot === index ? "step" : undefined}
                  aria-label={ko ? `${dot + 1} / ${slides.length}` : `${dot + 1} of ${slides.length}`}
                  onClick={() => setIndex(dot)}
                />
              ))}
            </span>
            <button
              type="button"
              className={styles.arrow}
              aria-label={ko ? "다음" : "Next"}
              disabled={last}
              onClick={() => setIndex((value) => Math.min(slides.length - 1, value + 1))}
            >
              ›
            </button>
          </nav>
        </div>
      </div>
    </div>
  );
}
