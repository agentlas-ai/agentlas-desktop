"use client";

import { useRef } from "react";
import { useT } from "@/lib/i18n";
import { WORK_SIDEBAR_DEFAULT_WIDTH, WORK_SIDEBAR_MIN_WIDTH, workSidebarMaxWidth, type useWorkSidebarWidth } from "@/lib/work-sidebar-width";
import styles from "./SidebarResizeHandle.module.css";

/**
 * Work 좌측 패널 오른쪽 가장자리의 손잡이. 끌면 폭이 바뀌고, 놓을 때 저장한다.
 * 키보드: ←/→ 16px, Home 최소, End 최대, 두 번 클릭은 기본 폭으로.
 */
export function SidebarResizeHandle({ sidebar }: { sidebar: ReturnType<typeof useWorkSidebarWidth> }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const { width, preview, commit, reset, setResizing } = sidebar;
  const end = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    setResizing(false);
    if (drag) commit(drag.width);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuemin={WORK_SIDEBAR_MIN_WIDTH}
      aria-valuemax={workSidebarMaxWidth()}
      aria-valuenow={width}
      aria-label={ko ? "왼쪽 패널 너비 조절" : "Resize left panel"}
      title={ko ? "끌어서 너비 조절 · 두 번 클릭하면 기본 너비" : "Drag to resize · double-click for the default width"}
      className={`${styles.handle} titlebar-nodrag`}
      data-work-sidebar-resize="true"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const shown = Math.round(event.currentTarget.parentElement?.getBoundingClientRect().width ?? width);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: shown, width: shown };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window events still arrive */ }
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        setResizing(true);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.width = drag.startWidth + event.clientX - drag.startX;
        preview(drag.width);
      }}
      onPointerUp={end}
      onLostPointerCapture={() => { if (dragRef.current) end(); }}
      onDoubleClick={reset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") commit(width - 16);
        else if (event.key === "ArrowRight") commit(width + 16);
        else if (event.key === "Home") commit(WORK_SIDEBAR_MIN_WIDTH);
        else if (event.key === "End") commit(workSidebarMaxWidth());
        else if (event.key === "Enter") commit(WORK_SIDEBAR_DEFAULT_WIDTH);
        else return;
        event.preventDefault();
      }}
    />
  );
}
