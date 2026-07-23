"use client";

import { useEffect, useRef, useState } from "react";

import { ipc } from "@/lib/ipc";

// This is intentionally a release identifier, not a generic "dismissed"
// flag. Bump it only when there is a real new-feature story to introduce.
// Existing users then get this update once, while a normal relaunch stays quiet.
export const ONTOLOGY_CHIP_FEATURE_RELEASE = "desktop-v0.8.13-ontology-chips";
export const ONTOLOGY_CHIP_FEATURE_ACK_KEY =
  `agentlas.featureUpdate.${ONTOLOGY_CHIP_FEATURE_RELEASE}.ack`;

const MINIMUM_APP_VERSION = [0, 8, 13] as const;
const ONBOARDED_KEY = "agentlas.onboarded";

export function OntologyChipFeatureUpdateModal({
  eligible,
  locale,
  onOpen,
}: {
  eligible: boolean;
  locale: string;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const ko = locale === "ko";

  useEffect(() => {
    if (!eligible) {
      setOpen((wasOpen) => {
        if (wasOpen) window.setTimeout(() => previousFocusRef.current?.focus(), 0);
        return false;
      });
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const prepare = async () => {
      try {
        if (window.localStorage.getItem(ONBOARDED_KEY) !== "1") return;
        if (window.localStorage.getItem(ONTOLOGY_CHIP_FEATURE_ACK_KEY)) return;
      } catch {
        // If acknowledgement cannot be persisted, do not create a popup loop.
        return;
      }
      const version = await ipc()?.app.getVersion().catch(() => "") ?? "";
      if (cancelled || !isVersionAtLeast(version, MINIMUM_APP_VERSION)) return;
      timer = window.setTimeout(() => {
        if (cancelled || document.visibilityState !== "visible") return;
        // Tours, approvals, import, or another product dialog always win. A
        // deferred feature update can wait for the next safe surface/session.
        if (document.querySelector('[role="dialog"], dialog[open]')) return;
        previousFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        try {
          // The introduction is a release note, not a persistent task. Record
          // the view before displaying it so an app restart cannot replay it.
          window.localStorage.setItem(ONTOLOGY_CHIP_FEATURE_ACK_KEY, new Date().toISOString());
        } catch {
          // Without durable storage, don't risk showing the same release note
          // repeatedly on every launch.
          return;
        }
        setOpen(true);
      }, 900);
    };
    void prepare();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [eligible]);

  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = titleRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === titleRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  function close(next?: () => void) {
    setOpen(false);
    window.setTimeout(() => {
      if (next) next();
      else previousFocusRef.current?.focus();
    }, 0);
  }

  return (
    <div
      className="feature-update-backdrop titlebar-nodrag"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="feature-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ontology-chip-feature-title"
        aria-describedby="ontology-chip-feature-description"
        data-feature-release={ONTOLOGY_CHIP_FEATURE_RELEASE}
      >
        <button
          type="button"
          className="feature-update-close"
          aria-label={ko ? "업데이트 안내 닫기" : "Close feature update"}
          onClick={() => close()}
        >
          ×
        </button>
        <div className="feature-update-hero" aria-hidden="true">
          <img
            src="/feature-updates/ontology-chip-modal-hero-v2.png"
            alt=""
            width={1877}
            height={838}
          />
          <span className="feature-update-hero-label">WHAT&apos;S NEW · 0.8.13</span>
        </div>
        <div className="feature-update-body">
          <div className="feature-update-copy">
            <span className="feature-update-kicker">
              {ko ? "새 기능 · 경험 칩" : "NEW · EXPERIENCE CHIPS"}
            </span>
            <h2 id="ontology-chip-feature-title" ref={titleRef} tabIndex={-1}>
              {ko ? "좋은 경험을, 에이전트의 판단으로" : "Turn good experience into better agent judgment"}
            </h2>
            <p id="ontology-chip-feature-description">
              {ko
                ? "검증된 작업 방식과 사람의 선호를 분리해 쌓고, 검토를 통과한 항목만 에이전트가 장착합니다. 개인 경로와 비밀은 칩에 포함되지 않습니다."
                : "Verified methods and human preference signals stay separate. Only reviewed items become equipable chips, while private paths and secrets stay out."}
            </p>
          </div>
          <div className="feature-update-actions">
            <button type="button" className="feature-update-secondary" onClick={() => close()}>
              {ko ? "닫기" : "Close"}
            </button>
            <button
              type="button"
              className="feature-update-primary"
              onClick={() => close(onOpen)}
            >
              {ko ? "새 기능 살펴보기" : "Explore what’s new"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function isVersionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}
