"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { BrowserLiveFrame, ComputerUsePreview } from "@/lib/types";

type ViewMode = "browser" | "computer";

interface ComputerUseActivityDetail {
  mode?: ViewMode;
  phase?: "active" | "finished";
}

interface FloatPosition {
  right: number;
  bottom: number;
}

interface DragState extends FloatPosition {
  pointerId: number;
  x: number;
  y: number;
}

export default function FloatingComputerUsePanel() {
  const { locale } = useT();
  const ko = locale === "ko";
  const api = ipc();
  const [mode, setMode] = useState<ViewMode>("browser");
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<FloatPosition>({ right: 78, bottom: 116 });
  const [browserFrame, setBrowserFrame] = useState<BrowserLiveFrame | null>(null);
  const [computerFrame, setComputerFrame] = useState<ComputerUsePreview | null>(null);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const busy = useRef(false);
  const finishTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const drag = useRef<DragState | null>(null);

  const capture = useCallback(async () => {
    if (!api || busy.current || document.visibilityState !== "visible") return;
    busy.current = true;
    try {
      if (mode === "browser") {
        const next = await api.browser.captureLiveFrame();
        // Keep showing the last good screen through a transient CDP hiccup
        // (busy socket, mid-navigation, a slow screenshot). Blanking on every
        // failed poll made the panel flicker to "Waiting for screen" between
        // good frames. Only replace the image when a new one actually arrives.
        // 그리고 화면이 안 변했으면(같은 dataUrl) 이전 참조를 유지한다 — 멀티 MB
        // 문자열 state 교체와 이미지 재디코드를 틱마다 반복하지 않는다.
        setBrowserFrame((prev) => {
          if (!next.dataUrl && prev?.dataUrl) return prev;
          if (prev && prev.dataUrl === next.dataUrl && prev.title === next.title && prev.url === next.url) return prev;
          return next;
        });
      } else {
        const next = await api.computerUse.capturePreview(sourceId);
        setComputerFrame((prev) => {
          if (!next.dataUrl && prev?.dataUrl) return prev;
          if (prev && prev.dataUrl === next.dataUrl) return prev;
          return next;
        });
        if (!sourceId && next.selectedSourceId) setSourceId(next.selectedSourceId);
      }
    } catch {
      // A stale preload during dev reload must not crash the workspace.
    } finally {
      busy.current = false;
    }
  }, [api, mode, sourceId]);

  useEffect(() => {
    const onActivity = (event: Event) => {
      const detail = (event as CustomEvent<ComputerUseActivityDetail>).detail;
      if (detail?.mode) setMode(detail.mode);
      if (detail?.phase === "finished") {
        setActive(false);
        if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
        finishTimer.current = window.setTimeout(() => setOpen(false), 5_000);
        return;
      }
      if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
      setDismissed(false);
      setActive(true);
      setOpen(true);
    };
    window.addEventListener("agentlas:computer-use-activity", onActivity);
    const events = ipcEvents();
    const off = events?.onActiveChats((chatIds) => {
      if (chatIds.length > 0) return;
      setActive(false);
    });
    return () => {
      if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
      off?.();
      window.removeEventListener("agentlas:computer-use-activity", onActivity);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void capture();
    // 화면 캡처는 렌더러 타이머 중 가장 비싸다 — 창이 숨어 있는 동안은 프레임을
    // 잡지 않고, 다시 보이면 즉시 한 장 갱신한다.
    const tick = () => { if (document.visibilityState !== "hidden") void capture(); };
    const timer = window.setInterval(tick, mode === "browser" ? 1_300 : 1_900);
    const onVisible = () => { if (document.visibilityState !== "hidden") void capture(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [capture, mode, open]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select")) return;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ...position,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [position]);

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const panel = panelRef.current;
    const width = panel?.offsetWidth ?? 430;
    const height = panel?.offsetHeight ?? 320;
    const maxRight = Math.max(12, window.innerWidth - width - 12);
    const maxBottom = Math.max(12, window.innerHeight - height - 12);
    setPosition({
      right: Math.min(maxRight, Math.max(12, current.right - (event.clientX - current.x))),
      bottom: Math.min(maxBottom, Math.max(12, current.bottom - (event.clientY - current.y))),
    });
  }, []);

  const stopDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const focusPreview = useCallback(async () => {
    if (!api) return;
    if (mode === "browser") {
      await api.browser.focusLiveTarget(browserFrame?.targetId ?? undefined).catch(() => ({ ok: false }));
      return;
    }
    await api.computerUse.revealPreview().catch(() => ({ ok: false }));
  }, [api, browserFrame?.targetId, mode]);

  const image = mode === "browser" ? browserFrame?.dataUrl : computerFrame?.dataUrl;
  const ready = mode === "browser" ? browserFrame?.available : computerFrame?.observationAvailable;
  const label = mode === "browser"
    ? browserFrame?.title || (ko ? "브라우저 화면" : "Browser view")
    : computerFrame?.sources.find((source) => source.id === computerFrame.selectedSourceId)?.name ||
      (ko ? "컴퓨터 화면" : "Computer view");

  if (dismissed) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="cua-float-trigger titlebar-nodrag"
        onClick={() => setOpen(true)}
        style={{ right: position.right, bottom: position.bottom }}
        aria-label={ko ? "컴퓨터 유즈 화면 열기" : "Open Computer Use view"}
      >
        <span className={`cua-trigger-dot ${active ? "active" : ""}`} aria-hidden="true" />
        <span className="cua-trigger-screen" aria-hidden="true" />
        <span>{ko ? "화면" : "Screen"}</span>
        <style jsx>{triggerStyles}</style>
      </button>
    );
  }

  return (
    <aside
      ref={panelRef}
      className="cua-float titlebar-nodrag"
      aria-label={ko ? "컴퓨터 유즈 라이브 화면" : "Live Computer Use view"}
      style={{ right: position.right, bottom: position.bottom }}
    >
      <header
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <div className="cua-title">
          <span className={`cua-live-dot ${ready ? "ready" : ""}`} aria-hidden="true" />
          <span>{label}</span>
          {active && <small>{ko ? "에이전트 조작 중" : "Agent working"}</small>}
        </div>
        <div className="cua-controls">
          <button className={mode === "browser" ? "selected" : ""} onClick={() => setMode("browser")}>
            {ko ? "브라우저" : "Browser"}
          </button>
          <button className={mode === "computer" ? "selected" : ""} onClick={() => setMode("computer")}>
            {ko ? "컴퓨터" : "Computer"}
          </button>
          <button className="minimize" onClick={() => setOpen(false)} aria-label={ko ? "화면 접기" : "Minimize view"}>
            —
          </button>
          <button
            className="close"
            onClick={() => { setOpen(false); setDismissed(true); }}
            aria-label={ko ? "화면 닫기" : "Close view"}
          >
            ×
          </button>
        </div>
      </header>

      <button
        type="button"
        className="cua-canvas"
        onClick={() => void focusPreview()}
        aria-label={mode === "browser"
          ? ko ? "브라우저 화면 앞으로 가져오기" : "Bring browser to front"
          : ko ? "컴퓨터 화면 열기" : "Show computer screen"}
      >
        {image ? (
          // Main only returns locally generated image data URLs.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={ko ? "에이전트가 보는 화면" : "Screen visible to the agent"} />
        ) : (
          <div className="cua-empty">
            <span className="cua-empty-screen" aria-hidden="true" />
            <strong>{ko ? "화면 연결 대기 중" : "Waiting for screen"}</strong>
            <span>
              {mode === "browser"
                ? ko ? "브라우저 도구가 시작되면 자동으로 표시됩니다." : "It appears automatically when a browser tool starts."
                : ko ? "Agentlas의 화면 기록 권한을 확인해 주세요." : "Check Agentlas Screen Recording permission."}
            </span>
          </div>
        )}
      </button>

      {mode === "computer" && computerFrame && (
        <footer>
          {computerFrame.sources.length > 1 && (
            <select value={sourceId ?? ""} onChange={(event) => setSourceId(event.target.value || undefined)}>
              {computerFrame.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
          )}
          <span className={computerFrame.screenPermission === "granted" ? "ok" : "warn"}>
            {ko ? "화면" : "Screen"} {computerFrame.screenPermission === "granted" ? "ON" : "OFF"}
          </span>
          <span className={computerFrame.accessibility ? "ok" : "warn"}>
            {ko ? "조작 권한" : "Control"} {computerFrame.accessibility ? "ON" : "OFF"}
          </span>
          {!computerFrame.interactionAvailable && (
            <span className="native">{ko ? "네이티브 입력 드라이버 필요" : "Native input driver required"}</span>
          )}
        </footer>
      )}

      <style jsx>{`
        .cua-float {
          position: fixed;
          z-index: 80;
          width: min(430px, calc(100vw - 112px));
          overflow: hidden;
          border-radius: 14px;
          background: color-mix(in srgb, var(--paper) 94%, transparent);
          box-shadow: 0 22px 58px rgba(0, 18, 24, 0.27), 0 4px 14px rgba(0, 18, 24, 0.13);
          backdrop-filter: blur(20px) saturate(135%);
        }
        header { height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 7px 0 12px; cursor: move; touch-action: none; user-select: none; }
        .cua-title { min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; }
        .cua-title > span:nth-child(2) { min-width: 0; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cua-title small { color: var(--accent); font-size: 9.5px; white-space: nowrap; }
        .cua-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #b68a35; flex-shrink: 0; }
        .cua-live-dot.ready { background: #2aa978; box-shadow: 0 0 0 3px rgba(42,169,120,0.13); }
        .cua-controls { display: flex; align-items: center; gap: 2px; }
        .cua-controls button { height: 27px; border: 0; border-radius: 7px; padding: 0 8px; background: transparent; color: var(--ink); font-size: 10.5px; font-weight: 650; cursor: pointer; }
        .cua-controls button.selected { background: var(--ink); color: var(--paper); }
        .cua-controls button.minimize, .cua-controls button.close { width: 25px; padding: 0; font-size: 14px; color: var(--muted-deep); }
        .cua-controls button.close { font-size: 17px; }
        .cua-controls button.close:hover { background: rgba(181, 45, 45, 0.1); color: #ad3030; }
        .cua-canvas { width: 100%; aspect-ratio: 16 / 10; display: grid; place-items: center; overflow: hidden; border: 0; padding: 0; background: #111416; cursor: pointer; }
        .cua-canvas img { display: block; width: 100%; height: 100%; object-fit: contain; }
        .cua-canvas:hover img { filter: brightness(1.035); }
        .cua-empty { display: flex; flex-direction: column; align-items: center; gap: 5px; color: rgba(255,255,255,0.82); text-align: center; }
        .cua-empty strong { font-size: 12px; }
        .cua-empty > span:last-child { max-width: 280px; font-size: 10.5px; line-height: 1.45; opacity: 0.5; }
        .cua-empty-screen { width: 28px; height: 19px; border: 1.5px solid rgba(255,255,255,0.45); border-radius: 4px; position: relative; margin-bottom: 3px; }
        .cua-empty-screen::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: -5px; height: 1.5px; background: rgba(255,255,255,0.45); }
        footer { min-height: 31px; display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 9.5px; color: var(--muted-deep); }
        footer select { max-width: 120px; border: 0; background: transparent; color: var(--ink); font-size: 9.5px; }
        footer .ok { color: var(--green-deep); font-weight: 700; }
        footer .warn { color: #a77721; font-weight: 700; }
        footer .native { margin-left: auto; }
        @media (max-width: 720px) { .cua-float { width: calc(100vw - 24px); } .cua-title small { display: none; } }
      `}</style>
    </aside>
  );
}

const triggerStyles = `
  .cua-float-trigger {
    position: fixed;
    z-index: 80;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 11px;
    border: 1px solid var(--paper-edge);
    border-radius: 999px;
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    color: var(--ink);
    box-shadow: 0 8px 24px rgba(0,18,24,0.15);
    backdrop-filter: blur(16px);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
  }
  .cua-trigger-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .cua-trigger-dot.active { background: #2aa978; box-shadow: 0 0 0 3px rgba(42,169,120,0.12); }
  .cua-trigger-screen { width: 15px; height: 10px; border: 1.3px solid currentColor; border-radius: 2px; opacity: 0.68; }
`;
