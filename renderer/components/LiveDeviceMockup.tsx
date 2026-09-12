"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkLiveViewState } from "@/lib/types";
import {
  IconExpand,
  IconHome,
  IconPower,
  IconRefresh,
  IconClose,
  IconMonitor,
  IconSmartphone,
  IconAlertTriangle,
} from "@/components/Icon";
import { NativeLiveWebView } from "@/components/NativeLiveWebView";
import styles from "./LiveDeviceMockup.module.css";

type Locale = "ko" | "en";

export type LiveDeviceMockupProps = {
  url: string;
  title: string;
  runtimeLabel?: string;
  updateFailed?: boolean;
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
export function LiveDeviceMockup({ url, title, runtimeLabel, updateFailed = false, viewId, locale = "ko", onClose }: LiveDeviceMockupProps) {
  const ko = locale === "ko";
  const viewIdRef = useRef(viewId || makeViewId());
  const effectiveViewId = viewIdRef.current;
  const [expanded, setExpanded] = useState(false);
  const [poweredOff, setPoweredOff] = useState(false);
  // Web output is the default surface. The phone frame remains available as a
  // deliberate viewport choice, but must not be the surrounding card users
  // see for ordinary app rendering.
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  // "LIVE"는 관측된 사실일 때만 단다 (U-D-1 범위 밖 3종 ③): 네이티브 뷰의
  // 실제 상태 + (같은 오리진일 때만) 루프백 서버 도달성 프로브.
  // 앱마다 다른 포트를 쓰는 managed preview의 CORP: same-origin 응답은
  // 바깥 렌더러의 cross-origin HEAD를 올바르게 막으므로, 그 실패를 앱의
  // 생존 실패로 해석하지 않는다. 그런 경우에는 native view 상태가 권위다.
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
    // The native WebContentsView owns the status for a cross-origin app. A
    // renderer HEAD probe cannot distinguish CORP from a dead loopback server.
    if (!localOrigin || poweredOff || localOrigin !== window.location.origin) {
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
  const badge = poweredOff ? (ko ? "미리보기 꺼짐" : "Preview off") : serverGone || viewState === "error"
    ? (ko ? "연결 끊김" : "OFFLINE")
    : viewState === "ready"
      ? "LIVE"
      : (ko ? "연결 중" : "CONNECTING");

  /** 미리보고 있는 대상의 이름. 이름이 없으면 지어내지 않고 종류만 말한다. */
  const previewName = title.trim() || (ko ? "앱 미리보기" : "App preview");

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
      aria-label={ko ? `${previewName} 앱 미리보기` : `${previewName} app preview`}
    >
      <header className={styles.windowBar}>
        <div className={styles.windowTitle}>
          <span className={styles.windowDot} data-live-state={poweredOff ? "off" : serverGone || viewState === "error" ? "offline" : viewState} role="img" aria-label={badge} title={badge} />
          <strong title={previewName}>{previewName}</strong>
        </div>
        <div className={styles.windowActions}>
          {updateFailed && <span className={styles.windowButton} role="img" aria-label={ko ? "갱신 실패 · 마지막 미리보기 표시 중" : "Update failed · Showing last preview"} title={ko ? "갱신 실패 · 마지막 미리보기 표시 중" : "Update failed · Showing last preview"}><IconAlertTriangle size={15} /></span>}
          <button type="button" className={styles.windowButton} onClick={goHome} disabled={poweredOff} aria-label={ko ? "홈" : "Home"} title={ko ? "홈" : "Home"}><IconHome size={15} /></button>
          <button type="button" className={styles.windowButton} onClick={reload} disabled={poweredOff} aria-label={ko ? "앱 새로고침" : "Reload app"} title={ko ? "앱 새로고침" : "Reload app"}><IconRefresh size={15} /></button>
          <button type="button" className={styles.windowButton} onClick={() => setDevice(current => current === "desktop" ? "phone" : "desktop")} aria-label={ko ? "미리보기 화면 크기 전환" : "Toggle preview viewport"} aria-pressed={device === "phone"} title={device === "desktop" ? (ko ? "휴대전화 화면" : "Phone viewport") : (ko ? "데스크탑 화면" : "Desktop viewport")}>
            {device === "desktop" ? <IconSmartphone size={15} /> : <IconMonitor size={15} />}
          </button>
          <button type="button" className={styles.windowButton} onClick={togglePower} aria-label={poweredOff ? (ko ? "미리보기 켜기" : "Start preview") : (ko ? "미리보기 끄기" : "Stop preview")} aria-pressed={!poweredOff} title={poweredOff ? (ko ? "미리보기 켜기" : "Start preview") : (ko ? "미리보기 끄기" : "Stop preview")}><IconPower size={15} /></button>
          <button
            type="button"
            className={styles.windowButton}
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? (ko ? "미리보기 축소" : "Restore preview") : (ko ? "미리보기 확대" : "Expand preview")}
            title={expanded ? (ko ? "미리보기 축소" : "Restore") : (ko ? "미리보기 확대" : "Expand")}
          >
            <IconExpand size={14} />
          </button>
          <button
            type="button"
            className={styles.windowButton}
            onClick={close}
            aria-label={ko ? "미리보기 닫기" : "Close preview"}
            title={ko ? "미리보기 닫기" : "Close preview"}
          >
            <IconClose size={14} />
          </button>
        </div>
      </header>

      <div className={styles.deviceArea} data-device={device}>
        {device === "desktop" ? (
          <div className={styles.desktopSurface}>
            {poweredOff ? (
              <div className={styles.poweredOff} role="status">
                <IconPower size={24} />
                <strong>{ko ? "미리보기가 꺼져 있습니다" : "Preview is powered off"}</strong>
                <button type="button" onClick={() => setPoweredOff(false)}>
                  {ko ? "다시 켜기" : "Turn on"}
                </button>
              </div>
            ) : (
              <NativeLiveWebView
                url={url}
                title={title}
                runtimeLabel={runtimeLabel}
                mode="app"
                bare
                viewId={effectiveViewId}
                onStatus={(status) => setViewState(status.state)}
              />
            )}
          </div>
        ) : (
          <div className={styles.deviceFrame}>
            <span className={`${styles.sideButton} ${styles.sideButtonTop}`} aria-hidden="true" />
            <span className={`${styles.sideButton} ${styles.sideButtonMiddle}`} aria-hidden="true" />
            <div className={styles.bezel}>
              <div className={styles.deviceScreen}>
                <div className={styles.dynamicIsland} aria-hidden="true" />
                {poweredOff ? (
                  <div className={styles.poweredOff} role="status">
                    <IconPower size={24} />
                    <strong>{ko ? "미리보기가 꺼져 있습니다" : "Preview is powered off"}</strong>
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
        )}
      </div>


    </section>
  );
}
