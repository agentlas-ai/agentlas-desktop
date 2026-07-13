"use client";

import { useEffect, useRef, useState } from "react";

import { ipc } from "@/lib/ipc";

export const ONTOLOGY_CHIP_FEATURE_RELEASE = "ontology-chips-v1.2026-07-13";
export const ONTOLOGY_CHIP_FEATURE_ACK_KEY =
  `agentlas.featureUpdate.${ONTOLOGY_CHIP_FEATURE_RELEASE}.ack`;

const MINIMUM_APP_VERSION = [0, 8, 10] as const;
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
        acknowledgeAndClose();
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

  function acknowledgeAndClose(next?: () => void) {
    try {
      window.localStorage.setItem(ONTOLOGY_CHIP_FEATURE_ACK_KEY, new Date().toISOString());
    } catch {
      // Closing must remain possible even when storage is unavailable.
    }
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
        if (event.target === event.currentTarget) acknowledgeAndClose();
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
          onClick={() => acknowledgeAndClose()}
        >
          ×
        </button>
        <div className="feature-update-hero" aria-hidden="true">
          <img
            src="/feature-updates/ontology-chip-modal-hero-960x428.webp"
            alt=""
            width={960}
            height={428}
          />
        </div>
        <div className="feature-update-body">
          <div className="feature-update-copy">
            <span className="feature-update-kicker">
              {ko ? "AGENTLAS 온톨로지 칩" : "AGENTLAS ONTOLOGY CHIPS"}
            </span>
            <h2 id="ontology-chip-feature-title" ref={titleRef} tabIndex={-1}>
              {ko ? "에이전트가 경험을 장착합니다" : "Agents can equip experience"}
            </h2>
            <p id="ontology-chip-feature-description">
              {ko
                ? "반복 검증된 방법은 비공개 후보로 쌓이고, 취향은 사람 A/B로 따로 평가됩니다. 검토된 항목만 칩이 되며 개인 경로와 비밀은 제외됩니다."
                : "Verified methods accumulate as private candidates, while taste is evaluated separately through human A/B choices. Only reviewed items become chips; personal paths and secrets stay out."}
            </p>
          </div>
          <div className="feature-update-actions">
            <button type="button" className="feature-update-secondary" onClick={() => acknowledgeAndClose()}>
              {ko ? "나중에 보기" : "Maybe later"}
            </button>
            <button
              type="button"
              className="feature-update-primary"
              onClick={() => acknowledgeAndClose(onOpen)}
            >
              {ko ? "온톨로지 칩 보기" : "View Ontology Chips"}
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
