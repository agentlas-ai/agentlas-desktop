// 사이드바·버튼·페르소나 칩에 쓸 라인 아이콘. Lucide 스타일 미니 SVG 인라인.
// 의존성 0 — 번들 가벼움. 이모지 대체용으로도 사용 (no AI slop).
"use client";
import type { CSSProperties } from "react";

type Props = {
  size?: number;
  color?: string;
  style?: CSSProperties;
  strokeWidth?: number;
};

function svg(d: string, { size = 16, color = "currentColor", style, strokeWidth = 1.7 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

// ── 기본 ────────────────────────────────────────────────
export const IconPlus = (p: Props) => svg("M12 5v14M5 12h14", p);
export const IconCheck = (p: Props) => svg("M4 12l5 5L20 6", p);
export const IconChevronRight = (p: Props) => svg("M9 6l6 6-6 6", p);
export const IconChevronDown = (p: Props) => svg("M6 9l6 6 6-6", p);
export const IconClose = (p: Props) => svg("M6 6l12 12M18 6L6 18", p);
export const IconSearch = (p: Props) =>
  svg("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", p);
export const IconMoreHorizontal = (p: Props) =>
  svg("M5 12h.01M12 12h.01M19 12h.01", { ...p, strokeWidth: (p.strokeWidth ?? 1.7) + 0.6 });

// ── 사이드바 ────────────────────────────────────────────
export const IconChat = (p: Props) =>
  svg("M21 12c0 4.4-4 8-9 8-1.4 0-2.7-.3-3.9-.8L3 21l1.9-4.4C3.7 15 3 13.6 3 12c0-4.4 4-8 9-8s9 3.6 9 8z", p);
export const IconFolder = (p: Props) =>
  svg("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z", p);
export const IconBolt = (p: Props) => svg("M13 2 4 14h7l-1 8 9-12h-7l1-8z", p);
export const IconLibrary = (p: Props) =>
  svg("M4 5v14M9 4v16M14 7v13M19 5v14", p);
export const IconStore = (p: Props) =>
  svg("M3 9l1.5-4h15L21 9M3 9v11h18V9M3 9h18M9 14h6", p);
export const IconApps = (p: Props) =>
  svg("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z", p);
export const IconTrash = (p: Props) =>
  svg("M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", p);
export const IconRefresh = (p: Props) =>
  svg("M21 12a9 9 0 0 1-15.4 6.4L3 21M3 12a9 9 0 0 1 15.4-6.4L21 3M21 3v6h-6M3 21v-6h6", p);
export const IconSettings = (p: Props) =>
  svg(
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.4 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8L4.4 7A2 2 0 1 1 7 4.4l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.6 7l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1c.4.6 1 1 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    p,
  );
export const IconSparkles = (p: Props) =>
  svg("M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2", p);
export const IconBuilding = (p: Props) =>
  svg(
    "M3 21h18M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M15 21v-9h4a1 1 0 0 1 1 1v8M8 8h2M8 12h2M8 16h2",
    p,
  );
export const IconUsers = (p: Props) =>
  svg(
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    p,
  );

// ── 페르소나 (이모지 대체) ──────────────────────────────
/** 쇼핑몰 사장 — 쇼핑백 */
export const IconShoppingBag = (p: Props) =>
  svg("M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 1 1-8 0", p);
/** 1인 마케터 — 메가폰 */
export const IconMegaphone = (p: Props) =>
  svg("M3 11v2a2 2 0 0 0 2 2h1l4 4V5l-4 4H5a2 2 0 0 0-2 2zM14 8a4 4 0 0 1 0 8M18 5a8 8 0 0 1 0 14", p);
/** 부동산 — 집 */
export const IconHome = (p: Props) =>
  svg("M3 12 12 4l9 8M5 10v10h14V10M9 20v-6h6v6", p);
/** 크리에이터 — 필름 */
export const IconFilm = (p: Props) =>
  svg("M3 4h18v16H3zM7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4", p);

// ── 그 외 (배너·하이라이트용) ───────────────────────────
export const IconLock = (p: Props) =>
  svg("M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 1 1 8 0v4", p);
export const IconKey = (p: Props) =>
  svg("M21 2 12 11M16 7l3 3M15 12a5 5 0 1 1-3-3", p);
export const IconBrain = (p: Props) =>
  svg(
    "M12 5a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 1 2.2A3 3 0 0 0 3 13a3 3 0 0 0 3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3M12 5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1 3 3 3 3 0 0 1-1 2.2A3 3 0 0 1 21 13a3 3 0 0 1-3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3V5z",
    p,
  );
export const IconEdit = (p: Props) =>
  svg("M11 4H4a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-7M18.5 2.5a2.12 2.12 0 1 1 3 3L12 15l-4 1 1-4z", p);
export const IconAtSign = (p: Props) =>
  svg("M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1", p);
export const IconSlash = (p: Props) => svg("M7 21 17 3", p);
export const IconBug = (p: Props) =>
  svg(
    "M8 6a4 4 0 0 1 8 0M6 10h12M12 8v11M8 10v9M16 10v9M5 8l2 2M19 8l-2 2M4 14h2M18 14h2M5 20l2-2M19 20l-2-2",
    p,
  );
export const IconLayers = (p: Props) =>
  svg("M12 2 3 7l9 5 9-5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5", p);
export const IconTarget = (p: Props) =>
  svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z", p);
export const IconRoute = (p: Props) =>
  svg("M6 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM18 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM18 9v7a4 4 0 0 1-4 4H7M6 15V8a4 4 0 0 1 4-4h3", p);
export const IconShield = (p: Props) =>
  svg("M12 3 4 6v6c0 5 3.5 9.3 8 10 4.5-.7 8-5 8-10V6l-8-3z", p);
export const IconFileUp = (p: Props) =>
  svg("M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6zM14 3v6h6M12 18v-6M9 15l3-3 3 3", p);
export const IconCircleDollar = (p: Props) =>
  svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9.5a2.5 2.5 0 0 0-2.5-2H12a2.5 2.5 0 0 0 0 5h.5a2.5 2.5 0 0 1 0 5H12a2.5 2.5 0 0 1-2.5-2M12 6v2M12 16v2", p);
export const IconWand = (p: Props) =>
  svg("M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5", p);
export const IconPaperclip = (p: Props) =>
  svg("M21 11.5V6a4 4 0 0 0-8 0v12a2.5 2.5 0 0 0 5 0V8.5a1 1 0 0 0-2 0V17", p);
export const IconImage = (p: Props) =>
  svg("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21", p);
export const IconArrowUp = (p: Props) =>
  svg("M12 19V5M5 12l7-7 7 7", { ...p, strokeWidth: (p.strokeWidth ?? 1.7) + 0.3 });
export const IconSidebar = (p: Props) =>
  svg("M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16", p);
/** 우측 패널 토글 — 오른쪽에 구분선 */
export const IconPanelRight = (p: Props) =>
  svg("M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM15 4v16", p);
export const IconSun = (p: Props) =>
  svg(
    "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
    p,
  );
export const IconMoon = (p: Props) => svg("M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z", p);
/** 팀 네트워크 — 상단 노드 + 두 하위 노드 + 연결선 */
export const IconNetwork = (p: Props) =>
  svg(
    "M12 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM5.5 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18.5 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM11 7.7 6.5 14.5M13 7.7l4.5 6.8",
    p,
  );
