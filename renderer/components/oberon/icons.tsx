// Oberon — 아이콘 시스템. 이모지 금지. 둥근 사각 배지 + 라인 글리프.
"use client";
import type { CSSProperties } from "react";

export type GlyphName =
  | "setup"
  | "plan"
  | "storyboard"
  | "assets"
  | "keyframe"
  | "video"
  | "deliver"
  | "character"
  | "background"
  | "prop"
  | "style"
  | "cli"
  | "sparkle"
  | "check"
  | "lock"
  | "chevron"
  | "plus"
  | "download"
  | "play"
  | "image"
  | "film"
  | "shield"
  | "wand"
  | "layers"
  | "grid"
  | "x";

function paths(name: GlyphName): React.ReactNode {
  switch (name) {
    case "setup": // sliders
      return (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
          <circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
        </>
      );
    case "plan": // document with lines
      return (
        <>
          <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
          <path d="M14 3.5V8h4" />
          <line x1="9" y1="12" x2="15" y2="12" />
          <line x1="9" y1="15.5" x2="15" y2="15.5" />
        </>
      );
    case "storyboard": // 2x2 frames
      return (
        <>
          <rect x="4" y="4" width="7" height="7" rx="1.2" />
          <rect x="13" y="4" width="7" height="7" rx="1.2" />
          <rect x="4" y="13" width="7" height="7" rx="1.2" />
          <rect x="13" y="13" width="7" height="7" rx="1.2" />
        </>
      );
    case "assets":
    case "layers": // stacked layers
      return (
        <>
          <path d="M12 3.5 21 8l-9 4.5L3 8l9-4.5Z" />
          <path d="M3 12l9 4.5L21 12" />
          <path d="M3 16l9 4.5L21 16" />
        </>
      );
    case "keyframe":
    case "image": // picture frame
      return (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M5 17l4-3.5 3 2.2 3-3 4 4.3" />
        </>
      );
    case "video":
    case "film":
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2.2" />
          <path d="M10 9.2l5 2.8-5 2.8V9.2Z" fill="currentColor" stroke="none" />
        </>
      );
    case "deliver": // package box
      return (
        <>
          <path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" />
          <path d="M4 8l8 4.5L20 8" />
          <line x1="12" y1="12.5" x2="12" y2="20.5" />
        </>
      );
    case "character": // person
      return (
        <>
          <circle cx="12" cy="8.5" r="3.4" />
          <path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
        </>
      );
    case "background": // mountains + sun
      return (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="8" cy="9" r="1.8" />
          <path d="M4 18l4.5-5 3 3.2L15 11l5 6.5" />
        </>
      );
    case "prop": // cube
      return (
        <>
          <path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" />
          <path d="M4 8l8 4.5 8-4.5M12 12.5V21" />
        </>
      );
    case "style": // palette swatch
      return (
        <>
          <rect x="4" y="4" width="6.5" height="16" rx="1.4" />
          <rect x="13.5" y="4" width="6.5" height="7.5" rx="1.4" />
          <rect x="13.5" y="13" width="6.5" height="7" rx="1.4" />
        </>
      );
    case "cli": // terminal >_
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2.2" />
          <path d="M7 10l3 2-3 2" />
          <line x1="12" y1="15" x2="16" y2="15" />
        </>
      );
    case "sparkle":
    case "wand":
      return (
        <>
          <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" fill="currentColor" stroke="none" />
          <path d="M18 15l.8 2 .8-2 2-.8-2-.8-.8-2-.8 2-2 .8 2 .8Z" fill="currentColor" stroke="none" />
        </>
      );
    case "check":
      return <path d="M5 12.5l4.2 4L19 7" />;
    case "lock":
      return (
        <>
          <rect x="5.5" y="10.5" width="13" height="9" rx="2" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </>
      );
    case "chevron":
      return <path d="M9 5l7 7-7 7" />;
    case "plus":
      return (
        <>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </>
      );
    case "download":
      return (
        <>
          <path d="M12 4v10" />
          <path d="M7.5 10.5 12 15l4.5-4.5" />
          <path d="M5 19h14" />
        </>
      );
    case "play":
      return <path d="M8 5.5l11 6.5-11 6.5V5.5Z" fill="currentColor" stroke="none" />;
    case "shield":
      return (
        <>
          <path d="M12 3.5l7 2.5v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-2.5Z" />
          <path d="M9 12l2.2 2.2L15.5 10" />
        </>
      );
    case "grid":
      return (
        <>
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="4" y1="15" x2="20" y2="15" />
          <line x1="9" y1="4" x2="9" y2="20" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </>
      );
    case "x":
      return (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      );
    default:
      return null;
  }
}

export function Glyph({
  name,
  size = 16,
  strokeWidth = 1.8,
  style,
}: {
  name: GlyphName;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
    >
      {paths(name)}
    </svg>
  );
}

/** 둥근 사각 배지 — 차분한 모노크롬. 무지개색 금지(레거시 color/gradient prop은 무시).
 *  tone: neutral(기본·라이트 필) | ink(다크 채움) | accent(앰버) | locked. */
export function OberonBadge({
  name,
  size = 34,
  tone = "neutral",
  state,
  glyphSize,
  // 레거시 — 더 이상 색으로 쓰지 않음
  color: _color,
  gradient: _gradient,
}: {
  name: GlyphName;
  size?: number;
  tone?: "neutral" | "ink" | "accent" | "locked";
  state?: "active" | "done" | "locked" | "idle";
  glyphSize?: number;
  color?: string;
  gradient?: string;
}) {
  const t = state === "locked" ? "locked" : state === "done" ? "ink" : tone;
  const styleByTone: Record<string, { bg: string; fg: string; border: string }> = {
    neutral: { bg: "var(--ob-fill, #f4f2ec)", fg: "var(--ob-ink-soft, #56544c)", border: "1px solid var(--ob-edge, #ebe8e0)" },
    ink: { bg: "var(--ob-ink, #1c1b17)", fg: "#fff", border: "none" },
    accent: { bg: "var(--ob-accent, #b26a1b)", fg: "#fff", border: "none" },
    locked: { bg: "var(--ob-fill, #f4f2ec)", fg: "var(--ob-muted, #9a968b)", border: "1px solid var(--ob-edge, #ebe8e0)" },
  };
  const s = styleByTone[t] ?? styleByTone.neutral;
  const radius = Math.round(size * 0.28);
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: s.bg,
        border: s.border,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: s.fg,
        flexShrink: 0,
        transition: "all 0.15s ease",
      }}
    >
      <Glyph name={state === "done" ? "check" : name} size={glyphSize ?? Math.round(size * 0.5)} strokeWidth={1.9} />
    </span>
  );
}

/** 단계/카테고리별 시그니처 색. */
export const STEP_COLOR: Record<string, string> = {
  setup: "#5b5bd6",
  plan: "#0b7285",
  storyboard: "#1098ad",
  assets: "#2f9e44",
  keyframe: "#e8590c",
  video: "#d6336c",
  deliver: "#6741d9",
};

export const CATEGORY_COLOR: Record<string, string> = {
  character: "#d6336c",
  background: "#1098ad",
  location: "#1098ad",
  prop: "#e8590c",
  wardrobe: "#9c36b5",
  vehicle: "#3b5bdb",
  style: "#2f9e44",
};
