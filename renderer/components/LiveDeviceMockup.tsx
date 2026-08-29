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
  const badge = serverGone || viewState === "error"
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
          <span className={styles.windowDot} aria-hidden="true" />
          {/*
           * ★ 창 제목은 **실제로 도는 것**의 이름이어야 한다.
           *
           * 여기에는 "iOS 시뮬레이터"가 박혀 있었다. 이 컴포넌트 자신의 주석이 바로 위에서
           * "iOS/Android 바이너리인 척하지 않는다"고 적어 두었는데, 정작 제목이 그 척을 하고
           * 있었다 — 안에서 도는 것은 Xcode 시뮬레이터가 아니라 Main 이 소유한 로컬
           * 미리보기(WebContentsView, 웹은 iframe)다. 오너가 화면을 보고 바로 잡아냈다.
           *
           * OS 이름은 박지 않는다: 이 틀은 표현일 뿐이고 뷰포트는 폰/데스크탑을 오갈 수 있다.
           * 관측된 사실("무엇을 미리보고 있는가")만 적고, 이름이 없으면 종류만 말한다.
           * LIVE 배지가 "관측된 사실일 때만 단다"와 같은 규칙이다.
           */}
          <strong>{previewName}</strong>
          <span className={styles.windowKind}>{ko ? "미리보기" : "Preview"}</span>
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
        )}
      </div>

      <footer className={styles.deviceControls} aria-label={ko ? "미리보기 제어" : "Preview controls"}>
        <button
          type="button"
          className={styles.deviceToggle}
          onClick={() => setDevice((current) => (current === "desktop" ? "phone" : "desktop"))}
          aria-label={ko ? "미리보기 화면 크기 전환" : "Toggle preview viewport"}
          title={device === "desktop" ? (ko ? "데스크탑 · 눌러서 폰" : "Desktop · tap for phone") : (ko ? "폰 · 눌러서 데스크탑" : "Phone · tap for desktop")}
        >
          {device === "desktop" ? (ko ? "데스크탑" : "Desktop") : (ko ? "폰" : "Phone")}
        </button>
        <button type="button" onClick={goHome} aria-label={ko ? "홈" : "Home"} title={ko ? "홈" : "Home"}>
          <IconHome size={15} />
        </button>
        {/*
         * ★ 아직 없는 기능을 있는 것처럼 부르지 않는다 (같은 계열, 한 겹 아래).
         * 이 둘은 `onClick` 이 없다 — 눌러도 아무 일도 일어나지 않는다. 그런데 "(준비 중)"
         * 은 마우스를 올려야 보이는 title 에만 있고, 화면 낭독기가 읽는 이름은 그냥
         * "스크린샷"·"화면 녹화"였다. 이름에도 상태를 적고 실제로 비활성으로 둔다.
         */}
        <button
          type="button"
          className={styles.passiveControl}
          disabled
          aria-label={ko ? "스크린샷 (준비 중)" : "Screenshot (coming soon)"}
          title={ko ? "스크린샷 (준비 중)" : "Screenshot (coming soon)"}
        >
          <IconCamera size={15} />
        </button>
        <button
          type="button"
          className={styles.passiveControl}
          disabled
          aria-label={ko ? "화면 녹화 (준비 중)" : "Record screen (coming soon)"}
          title={ko ? "화면 녹화 (준비 중)" : "Record screen (coming soon)"}
        >
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
