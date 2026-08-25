"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkLiveViewState } from "@/lib/types";
import {
  IconCamera,
  IconExpand,
  IconFilm,
  IconHome,
  IconLogOut,
  IconPower,
  IconRefresh,
  IconClose,
} from "@/components/Icon";
import { NativeLiveWebView } from "@/components/NativeLiveWebView";
import styles from "./LiveDeviceMockup.module.css";

type Locale = "ko" | "en";

export type LiveDeviceMockupProps = {
  url: string;
  title: string;
  runtimeLabel?: string;
  viewId?: string;
  locale?: Locale;
  onClose?: () => void;
};

function makeViewId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `device_${random}`.slice(0, 72);
}

/**
 * A simulator-shaped host chrome for a real web runtime.
 *
 * The phone is presentation only: the page inside remains the same sandboxed
 * Main-owned WebContentsView used by Work and One. This deliberately does not
 * pretend to be an iOS/Android binary or invoke Xcode/Gradle.
 */
export function LiveDeviceMockup({ url, title, runtimeLabel, viewId, locale = "ko", onClose }: LiveDeviceMockupProps) {
  const ko = locale === "ko";
  const viewIdRef = useRef(viewId || makeViewId());
  const effectiveViewId = viewIdRef.current;
  const [expanded, setExpanded] = useState(false);
  const [poweredOff, setPoweredOff] = useState(false);
  // "LIVE"는 관측된 사실일 때만 단다 (U-D-1 범위 밖 3종 ③): 네이티브 뷰의
  // 실제 상태 + 루프백 서버 도달성 프로브(OneActivityTimeline과 같은 계약 —
  // 보이는 동안만 6초 주기, 죽음/부활 매 주기 재평가).
  const [viewState, setViewState] = useState<WorkLiveViewState>("opening");
  const [serverGone, setServerGone] = useState(false);
  const localOrigin = useMemo(() => {
    try {
      const parsed = new URL(url);
      return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname) ? parsed.origin : null;
    } catch {
      return null;
    }
  }, [url]);
  useEffect(() => {
    if (!localOrigin || poweredOff) {
      setServerGone(false);
      return;
    }
    let disposed = false;
    const probe = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        await fetch(localOrigin, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(1_500) });
        if (!disposed) setServerGone(false);
      } catch {
        if (!disposed) setServerGone(true);
      }
    };
    void probe();
    const timer = window.setInterval(() => { void probe(); }, 6_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [localOrigin, poweredOff]);
  const badge = serverGone || viewState === "error"
    ? (ko ? "연결 끊김" : "OFFLINE")
    : viewState === "ready"
      ? "LIVE"
      : (ko ? "연결 중" : "CONNECTING");

  const reload = () => {
    void window.agentlas?.workLiveView?.reload(effectiveViewId);
  };
  const goHome = () => {
    void window.agentlas?.workLiveView?.navigate({ viewId: effectiveViewId, url });
  };
  const togglePower = () => setPoweredOff((current) => !current);
  const close = () => {
    if (onClose) onClose();
    else setPoweredOff(true);
  };

  return (
    <section
      className={styles.shell}
      data-live-device-mockup="true"
      data-expanded={expanded ? "true" : "false"}
      data-powered-off={poweredOff ? "true" : "false"}
      aria-label={ko ? `${title} 실제 앱 목업` : `${title} live device mockup`}
    >
      <header className={styles.windowBar}>
        <div className={styles.windowTitle}>
          <span className={styles.windowDot} aria-hidden="true" />
          <strong>{ko ? "iOS 시뮬레이터" : "iOS simulator"}</strong>
          <span className={styles.liveBadge} data-live-state={serverGone || viewState === "error" ? "offline" : viewState}>{badge}</span>
        </div>
        <div className={styles.windowActions}>
          <button
            type="button"
            className={styles.windowButton}
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? (ko ? "목업 축소" : "Restore device mockup") : (ko ? "목업 확대" : "Expand device mockup")}
            title={expanded ? (ko ? "목업 축소" : "Restore") : (ko ? "목업 확대" : "Expand")}
          >
            <IconExpand size={14} />
          </button>
          <button
            type="button"
            className={styles.windowButton}
            onClick={close}
            aria-label={ko ? "앱 목업 닫기" : "Close app mockup"}
            title={ko ? "앱 목업 닫기" : "Close mockup"}
          >
            <IconClose size={14} />
          </button>
        </div>
      </header>

      <div className={styles.deviceArea}>
        <div className={styles.deviceFrame}>
          <span className={`${styles.sideButton} ${styles.sideButtonTop}`} aria-hidden="true" />
          <span className={`${styles.sideButton} ${styles.sideButtonMiddle}`} aria-hidden="true" />
          <div className={styles.bezel}>
            <div className={styles.deviceScreen}>
              <div className={styles.dynamicIsland} aria-hidden="true" />
              {poweredOff ? (
                <div className={styles.poweredOff} role="status">
                  <IconPower size={24} />
                  <strong>{ko ? "앱 목업이 꺼져 있습니다" : "App mockup is powered off"}</strong>
                  <button type="button" onClick={() => setPoweredOff(false)}>
                    {ko ? "다시 켜기" : "Turn on"}
                  </button>
                </div>
              ) : (
                <div className={styles.screenViewport}>
                  <NativeLiveWebView
                    url={url}
                    title={title}
                    runtimeLabel={runtimeLabel}
                    mode="app"
                    bare
                    viewId={effectiveViewId}
                    onStatus={(status) => setViewState(status.state)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className={styles.deviceControls} aria-label={ko ? "시뮬레이터 제어" : "Simulator controls"}>
        <button type="button" onClick={goHome} aria-label={ko ? "홈" : "Home"} title={ko ? "홈" : "Home"}>
          <IconHome size={15} />
        </button>
        <button type="button" className={styles.passiveControl} aria-label={ko ? "스크린샷" : "Screenshot"} title={ko ? "스크린샷 (준비 중)" : "Screenshot (coming soon)"}>
          <IconCamera size={15} />
        </button>
        <button type="button" className={styles.passiveControl} aria-label={ko ? "화면 녹화" : "Record screen"} title={ko ? "화면 녹화 (준비 중)" : "Record screen (coming soon)"}>
          <IconFilm size={15} />
        </button>
        <button type="button" onClick={reload} aria-label={ko ? "앱 새로고침" : "Reload app"} title={ko ? "앱 새로고침" : "Reload app"}>
          <IconRefresh size={15} />
        </button>
        <button type="button" onClick={togglePower} aria-label={ko ? "전원" : "Power"} title={ko ? "전원" : "Power"}>
          <IconPower size={15} />
        </button>
        <button type="button" onClick={close} aria-label={ko ? "목업 닫기" : "Exit mockup"} title={ko ? "목업 닫기" : "Exit mockup"}>
          <IconLogOut size={15} />
        </button>
      </footer>
    </section>
  );
}
