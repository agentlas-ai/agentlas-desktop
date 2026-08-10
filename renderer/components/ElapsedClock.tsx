"use client";

// 1초 경과 시계는 리프에서만 돈다. 페이지/셸 컴포넌트가 "시계 한 칸" 때문에
// 자기 전체를 초당 리렌더하지 않도록, 타이머와 리렌더를 이 컴포넌트 안에 가둔다.
// (실측 2026-08-10: OneShell 3,801줄이 실행 내내 초당 1회 통째로 리렌더되던 원인.)
import { memo, useEffect, useState } from "react";

function defaultFormat(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const ElapsedClock = memo(function ElapsedClock({
  startedAt,
  format,
  className,
  style,
}: {
  /** epoch ms. null이면 아무것도 그리지 않고 타이머도 돌지 않는다. */
  startedAt: number | null;
  format?: (elapsedMs: number) => string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (startedAt === null) return null;
  const label = (format ?? defaultFormat)(Math.max(0, Date.now() - startedAt));
  return <span className={className} style={style}>{label}</span>;
});
