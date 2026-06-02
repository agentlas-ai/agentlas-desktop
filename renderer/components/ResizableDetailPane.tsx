"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

interface Props {
  children: ReactNode;
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth?: number;
  maxWidthCss?: CSSProperties["maxWidth"];
  style?: CSSProperties;
  className?: string;
}

export function ResizableDetailPane({
  children,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth = 860,
  maxWidthCss = "52vw",
  style,
  className,
}: Props) {
  const { t } = useT();
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);
  const draggingRef = useRef(false);

  const clamp = useCallback(
    (value: number) => {
      const viewportMax =
        typeof window === "undefined"
          ? maxWidth
          : Math.min(maxWidth, Math.max(minWidth, window.innerWidth - 360));
      return Math.max(minWidth, Math.min(viewportMax, value));
    },
    [maxWidth, minWidth],
  );

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      const parsed = saved ? Number.parseInt(saved, 10) : NaN;
      if (Number.isFinite(parsed)) setWidth(clamp(parsed));
    } catch {
      // ignore
    }
  }, [clamp, storageKey]);

  useEffect(() => {
    const next = clamp(width);
    widthRef.current = next;
    if (next !== width) {
      setWidth(next);
      return;
    }
    if (draggingRef.current) return;
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      // ignore
    }
  }, [clamp, storageKey, width]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        const dx = startX - moveEvent.clientX;
        const next = clamp(startWidth + dx);
        widthRef.current = next;
        setWidth(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current));
        } catch {
          // ignore
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      event.preventDefault();
    },
    [clamp, storageKey],
  );

  return (
    <aside
      className={className}
      style={{
        width,
        maxWidth: maxWidthCss,
        minWidth,
        flexShrink: 0,
        borderLeft: "var(--hairline)",
        background: "var(--paper)",
        minHeight: 0,
        overflow: "hidden",
        ...style,
        position: "relative",
      }}
    >
      <div
        role="separator"
        aria-label={t("workspace.resize")}
        aria-orientation="vertical"
        onPointerDown={startResize}
        title={t("workspace.resize")}
        style={resizeHandle}
      />
      {children}
    </aside>
  );
}

const resizeHandle: CSSProperties = {
  position: "absolute",
  left: -3,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: "ew-resize",
  zIndex: 5,
  touchAction: "none",
};
