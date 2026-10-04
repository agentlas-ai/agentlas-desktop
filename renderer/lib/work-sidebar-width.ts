"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Work 좌측 패널 폭 하나 — 대시보드 쪽 SideNav 와 작업 화면의 ProjectSidebar 가 같이 쓴다.
 *
 * 오너 2026-10-04: "좌측 패널도 줄이고 늘리고 가능하게". 두 패널은 화면의 같은 자리라 폭도 하나다.
 * 예전에는 SideNav 252px · ProjectSidebar 274px 로 따로 고정돼 있어서, 대시보드에서 작업으로
 * 넘어갈 때마다 본문이 22px 씩 튀었다.
 */
export const WORK_SIDEBAR_DEFAULT_WIDTH = 252;
export const WORK_SIDEBAR_MIN_WIDTH = 200;
const WORK_SIDEBAR_MAX_WIDTH = 420;
/** 창의 이 비율을 넘게 넓히면 최소 창(960px)에서 대화와 결과 레일이 읽을 수 없는 폭으로 눌린다. */
const WORK_SIDEBAR_MAX_VIEWPORT_RATIO = 0.36;
const WORK_SIDEBAR_WIDTH_KEY = "agentlas.work.sidebar_width";
/** 폭이 바뀌면 window 에 보낸다 — 결과 레일처럼 남은 폭으로 자기 폭을 정하는 화면이 다시 잰다. */
export const WORK_SIDEBAR_WIDTH_EVENT = "agentlas:work-sidebar-width";

export function workSidebarMaxWidth(viewport = typeof window === "undefined" ? 1440 : window.innerWidth): number {
  return Math.max(WORK_SIDEBAR_MIN_WIDTH, Math.min(WORK_SIDEBAR_MAX_WIDTH, Math.round(viewport * WORK_SIDEBAR_MAX_VIEWPORT_RATIO)));
}

export function clampWorkSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return WORK_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(workSidebarMaxWidth(), Math.max(WORK_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readWorkSidebarWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(WORK_SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) return clampWorkSidebarWidth(raw);
  } catch {
    // SSR or storage unavailable: the default width still works.
  }
  return clampWorkSidebarWidth(WORK_SIDEBAR_DEFAULT_WIDTH);
}

function writeWorkSidebarWidth(width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(WORK_SIDEBAR_WIDTH_KEY);
    else window.localStorage.setItem(WORK_SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // Persistence is optional; the panel keeps the width for this session.
  }
}

/**
 * 지금 화면에 보이는 Work 좌측 패널 폭. 좁은 창에서 패널이 숨거나 접혀 있으면 그 폭(0·68)을 그대로 돌려준다 —
 * 예전 계산은 274 를 상수로 빼서, 패널이 숨은 821px 미만에서도 그만큼 자리를 비워 뒀다.
 */
export function currentWorkSidebarWidth(): number {
  if (typeof document === "undefined") return WORK_SIDEBAR_DEFAULT_WIDTH;
  const panel = document.querySelector(".project-sidebar, .sidenav");
  if (panel instanceof HTMLElement) return Math.round(panel.getBoundingClientRect().width);
  return readWorkSidebarWidth();
}

/** 패널 폭 상태. 끄는 동안은 화면만 바꾸고, 놓을 때 저장한다. */
export function useWorkSidebarWidth() {
  const [width, setWidthState] = useState(() => readWorkSidebarWidth());
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const onWindowResize = () => setWidthState((current) => clampWorkSidebarWidth(current));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);
  useEffect(() => {
    window.dispatchEvent(new Event(WORK_SIDEBAR_WIDTH_EVENT));
  }, [width]);
  const preview = useCallback((next: number) => setWidthState(clampWorkSidebarWidth(next)), []);
  const commit = useCallback((next: number) => {
    const clamped = clampWorkSidebarWidth(next);
    setWidthState(clamped);
    writeWorkSidebarWidth(clamped === WORK_SIDEBAR_DEFAULT_WIDTH ? null : clamped);
  }, []);
  const reset = useCallback(() => commit(WORK_SIDEBAR_DEFAULT_WIDTH), [commit]);
  return { width, resizing, setResizing, preview, commit, reset };
}
