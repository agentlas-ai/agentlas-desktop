"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { useAgentScreen, AgentScreenCanvas, AgentScreenFooter, type AgentScreenMode } from "./AgentScreenView";

type ViewMode = AgentScreenMode;

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
  const [mode, setMode] = useState<ViewMode>("browser");
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<FloatPosition>({ right: 78, bottom: 116 });
  const finishTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const drag = useRef<DragState | null>(null);
  // 화면은 이 카드가 열려 있을 때만 잡는다 — 접혀 있으면 캡처도 멈춘다.
  const screen = useAgentScreen(mode, open, ko);

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
      // 스스로 떠오르지 않는다. 화면은 우측 레일이 기본 자리이고(RailAgentScreen),
      // 이 카드는 사람이 "화면" 버튼을 눌러 떼어 낼 때만 열린다 — 띄워 달라고만 했는데
      // 매번 떠다닌다는 보고가 정확히 이 자동 열기였다(2026-09-03).
      setActive(true);
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

  const { ready, label } = screen;

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

      <AgentScreenCanvas screen={screen} ko={ko} />

      {screen.focusNotice && <div className="cua-focus-notice" role="status">{screen.focusNotice}</div>}

      <AgentScreenFooter screen={screen} ko={ko} />

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
        .cua-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex-shrink: 0; }
        .cua-live-dot.ready { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 13%, transparent); }
        .cua-controls { display: flex; align-items: center; gap: 2px; }
        .cua-controls button { height: 27px; border: 0; border-radius: 7px; padding: 0 8px; background: transparent; color: var(--ink); font-size: 10.5px; font-weight: 650; cursor: pointer; }
        .cua-controls button.selected { background: var(--black); color: var(--white); }
        .cua-controls button.minimize, .cua-controls button.close { width: 25px; padding: 0; font-size: 14px; color: var(--muted-deep); }
        .cua-controls button.close { font-size: 17px; }
        .cua-controls button.close:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
        .cua-canvas { width: 100%; aspect-ratio: 16 / 10; display: grid; place-items: center; overflow: hidden; border: 0; padding: 0; background: var(--black); cursor: pointer; }
        .cua-canvas:disabled { cursor: wait; opacity: 0.82; }
        .cua-canvas img { display: block; width: 100%; height: 100%; object-fit: contain; }
        .cua-canvas:hover img { filter: brightness(1.035); }
        .cua-focus-notice { min-height: 28px; display: flex; align-items: center; padding: 5px 10px; border-top: 1px solid color-mix(in srgb, var(--line) 75%, transparent); color: var(--muted-deep); font-size: 10px; line-height: 1.35; }
        .cua-empty { display: flex; flex-direction: column; align-items: center; gap: 5px; color: var(--white-soft); text-align: center; }
        .cua-empty strong { font-size: 12px; }
        .cua-empty > span:last-child { max-width: 280px; font-size: 10.5px; line-height: 1.45; opacity: 0.5; }
        .cua-empty-screen { width: 28px; height: 19px; border: 1.5px solid var(--white-faint); border-radius: 4px; position: relative; margin-bottom: 3px; }
        .cua-empty-screen::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: -5px; height: 1.5px; background: var(--white-faint); }
        footer { min-height: 31px; display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 9.5px; color: var(--muted-deep); }
        footer select { max-width: 120px; border: 0; background: transparent; color: var(--ink); font-size: 9.5px; }
        footer .ok { color: var(--green-deep); font-weight: 700; }
        footer .warn { color: var(--warn); font-weight: 700; }
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
  .cua-trigger-dot.active { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 12%, transparent); }
  .cua-trigger-screen { width: 15px; height: 10px; border: 1.3px solid currentColor; border-radius: 2px; opacity: 0.68; }
`;
