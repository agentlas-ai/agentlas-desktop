// Oberon 스튜디오 — 공유 UI 프리미티브 + 디자인 토큰.
//
// 미감: agentlas hub/use-cases 디자인 시스템(--rd-*)에 맞춤.
// 쿨 뉴트럴 + 단일 인디고 액센트(#5A56DC, 브랜드색). 필 버튼/칩, 라운드 카드,
// accent-soft 하이라이트, 휴머니스트 산세리프 디스플레이, 넉넉한 여백, 절제된 그림자.
// 무지개·보라그라데이션·이모지·모노 대문자 남발 금지.
"use client";
import type { CSSProperties, ReactNode } from "react";
import { SHOT_SIZES } from "@/lib/oberon";

// ── 디자인 토큰 (단일 소스) — Oberon 루트에 주입. agentlas --rd-* 기준 ──
export const OB_VARS: CSSProperties = {
  ["--ob-bg" as never]: "#FBFBFD",
  ["--ob-paper" as never]: "#FFFFFF",
  ["--ob-surface" as never]: "#F7F7FA",
  ["--ob-sunk" as never]: "#EEEEF3",
  ["--ob-fill" as never]: "#F4F4F7",
  ["--ob-edge" as never]: "rgba(11,11,15,0.08)",
  ["--ob-edge-strong" as never]: "rgba(11,11,15,0.14)",
  ["--ob-ink" as never]: "#0B0B0F",
  ["--ob-ink-soft" as never]: "rgba(11,11,15,0.66)",
  ["--ob-muted" as never]: "rgba(11,11,15,0.46)",
  ["--ob-accent" as never]: "#5A56DC", // 인디고 — 브랜드 액센트
  ["--ob-accent-text" as never]: "#3730A3",
  ["--ob-accent-soft" as never]: "rgba(90,86,220,0.12)",
  ["--ob-accent-wash" as never]: "rgba(90,86,220,0.14)",
  ["--ob-danger" as never]: "#C0392B",
  ["--ob-success" as never]: "#2E7D52",
  ["--ob-warning" as never]: "#B7791F",
  // 앱 토큰 오버라이드 (재사용 패널들이 var(--ink) 등 사용).
  ["--paper" as never]: "#FFFFFF",
  ["--paper-2" as never]: "#F7F7FA",
  ["--paper-edge" as never]: "rgba(11,11,15,0.08)",
  ["--ink" as never]: "#0B0B0F",
  ["--ink-soft" as never]: "rgba(11,11,15,0.66)",
  ["--muted" as never]: "rgba(11,11,15,0.46)",
  ["--muted-deep" as never]: "rgba(11,11,15,0.6)",
  ["--fill-1" as never]: "#F4F4F7",
  ["--glass-border" as never]: "rgba(11,11,15,0.08)",
  ["--accent" as never]: "#5A56DC",
  ["--accent-strong" as never]: "#4945c4",
  ["--green-deep" as never]: "#2E7D52",
  ["--red-deep" as never]: "#C0392B",
  ["--peach-ink" as never]: "#9A3412",
  ["--purple-deep" as never]: "#3730A3",
  ["--shadow-1" as never]: "0 1px 0 rgba(11,11,15,0.04), 0 1px 2px rgba(11,11,15,0.03)",
  ["--neu-raised" as never]: "none",
  ["--font-display" as never]:
    "'Inter Tight', 'Pretendard Variable', 'Pretendard', 'SF Pro Display', -apple-system, 'Segoe UI Variable Display', 'Segoe UI', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif",
  color: "#0B0B0F",
  background: "#FBFBFD",
};

// 격자 제거 — 레퍼런스는 플랫 배경. (호환용 빈 객체)
export const OB_GRID: CSSProperties = {
  backgroundColor: "#FBFBFD",
};

export const CHARCOAL = "linear-gradient(155deg,#2B2A33,#3B3A47)";
export function neutralThumb(_seed?: number): string {
  return CHARCOAL;
}

export function aspectCss(aspect?: string): string {
  switch (aspect) {
    case "9:16": return "9 / 16";
    case "1:1": return "1 / 1";
    case "2.39:1": return "2.39 / 1";
    case "4:5": return "4 / 5";
    default: return "16 / 9";
  }
}

export const displayStyle: CSSProperties = { fontFamily: "var(--font-display, serif)", letterSpacing: 0 };

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
export function providerColor(_id?: string): string {
  return "var(--ob-ink-soft)";
}

// ── 시그니처: 트래킹 대문자 eyebrow (섹션당 최대 1개) ──────
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ob-accent-text)", marginBottom: 8 }}>
      {children}
    </div>
  );
}

// ── 필름 프레임 (컨택트시트 썸네일) — 무지개 금지 ──────────
export function FilmFrame({
  aspect,
  code,
  state = "ready",
  selected,
  size,
  imageUrl,
  style,
}: {
  aspect?: string;
  code?: string;
  state?: "idle" | "generating" | "ready";
  selected?: boolean;
  size?: string;
  imageUrl?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        aspectRatio: aspectCss(aspect),
        borderRadius: 8,
        background: state === "idle" ? "var(--ob-sunk)" : CHARCOAL,
        border: selected ? "2px solid var(--ob-accent)" : "1px solid var(--ob-edge)",
        boxShadow: selected ? "0 0 0 3px var(--ob-accent-soft)" : "inset 0 0 0 1px rgba(11,11,15,0.04)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {imageUrl && state === "ready" && (
        <img
          src={imageUrl}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {imageUrl && state === "ready" && (
        <span style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,0.18),rgba(0,0,0,0) 28%,rgba(0,0,0,0.22))", pointerEvents: "none" }} />
      )}
      {state === "generating" && (
        <span style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.25)", borderTopColor: "rgba(255,255,255,0.8)", borderRadius: "50%", animation: "agentlas-spin 1.1s linear infinite" }} />
      )}
      {size && (
        <span style={{ position: "absolute", top: 5, left: 6, fontSize: 9, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.7)", fontVariantNumeric: "tabular-nums" }}>{size}</span>
      )}
      {code && state !== "generating" && (
        <span style={{ position: "absolute", bottom: 5, left: 6, fontSize: 8.5, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums" }}>{code}</span>
      )}
    </div>
  );
}

// ── 칩 (선택형) — 선택 시 잉크 채움, 평소 조용한 중성 ──────
export function Chip({
  children,
  active,
  onClick,
  title,
  accentSelect,
}: {
  children: ReactNode;
  color?: string;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  /** true면 선택 시 앰버 링(멀티셀렉트용), 아니면 잉크 채움. */
  accentSelect?: boolean;
}) {
  const selectedBg = accentSelect ? "var(--ob-accent-soft)" : "var(--ob-accent)";
  const selectedFg = accentSelect ? "var(--ob-accent-text)" : "#fff";
  const selectedBorder = accentSelect ? "transparent" : "var(--ob-accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 34,
        padding: "0 14px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: onClick ? "pointer" : "default",
        border: `1px solid ${active ? selectedBorder : "var(--ob-edge-strong)"}`,
        background: active ? selectedBg : "var(--ob-surface)",
        color: active ? selectedFg : "var(--ob-ink-soft)",
        transition: "all 0.14s ease",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ── 태그 (조용한 메타 칩) — 테두리 없음, 산세리프 ──────────
export function Tag({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "5px 9px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: 1,
        color: color ?? "var(--ob-ink-soft)",
        background: "var(--ob-surface)",
        border: "1px solid var(--ob-edge)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ── 샷 사이즈 (모노 코드 — 정당한 모노 사용) ──────────────
export function SizeBadge({ size }: { size: keyof typeof SHOT_SIZES }) {
  return (
    <span
      title={SHOT_SIZES[size].ko}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 32,
        padding: "2px 6px",
        borderRadius: 5,
        fontSize: 10.5,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        letterSpacing: 0.2,
        color: "var(--ob-ink-soft)",
        background: "var(--ob-fill)",
      }}
    >
      {size}
    </span>
  );
}

export function StatChip({ label, value }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "5px 12px", borderRadius: 8, background: "var(--ob-surface)", minWidth: 58 }}>
      <span style={{ fontSize: 10.5, color: "var(--ob-muted)" }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ob-ink)", lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px", ...style }}>{children}</div>;
}

export function PanelHead({
  title,
  subtitle,
  icon,
  right,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  right?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 13, marginBottom: 26 }}>
      {icon && (
        <div
          style={{
            width: 34, height: 34, borderRadius: 9,
            background: "var(--ob-fill)", border: "1px solid var(--ob-edge)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            color: "var(--ob-ink-soft)", flexShrink: 0, marginTop: 4,
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 style={{ margin: 0, fontSize: 27, fontWeight: 600, fontFamily: "var(--font-display)", letterSpacing: 0, color: "var(--ob-ink)", lineHeight: 1.12 }}>{title}</h2>
        {subtitle && <p style={{ margin: "10px 0 0", fontSize: 14.5, color: "var(--ob-ink-soft)", lineHeight: 1.6, maxWidth: 720 }}>{subtitle}</p>}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        minHeight: 44, padding: "0 20px", borderRadius: 999, fontSize: 14, fontWeight: 700,
        background: "var(--ob-accent)", color: "#fff", border: "1px solid transparent",
        opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer",
        transition: "transform 0.15s ease, background 0.15s ease",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  active,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        minHeight: 40, padding: "0 16px", borderRadius: 999, fontSize: 13.5, fontWeight: 600,
        background: active ? "var(--ob-accent-soft)" : "var(--ob-surface)",
        color: active ? "var(--ob-accent-text)" : "var(--ob-ink)",
        border: `1px solid ${active ? "transparent" : "var(--ob-edge-strong)"}`,
        cursor: "pointer", transition: "all 0.14s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Card({ children, style, onClick }: { children: ReactNode; style?: CSSProperties; onClick?: () => void; accent?: string }) {
  return (
    <div
      onClick={onClick}
      style={{
        borderRadius: 16,
        background: "var(--ob-surface)",
        border: "1px solid var(--ob-edge)",
        boxShadow: "var(--shadow-1)",
        overflow: "hidden",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Swatch({ hex, name }: { hex: string; name: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }} title={`${name} ${hex}`}>
      <div style={{ width: 44, height: 44, borderRadius: 8, background: hex, border: "1px solid var(--ob-edge)" }} />
      <span style={{ fontSize: 10, color: "var(--ob-muted)", fontFamily: "var(--font-mono)" }}>{hex}</span>
    </div>
  );
}

export function Meter({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div style={{ height: 6, borderRadius: 999, background: "var(--ob-fill)", overflow: "hidden", width: "100%" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color ?? "var(--ob-accent)", transition: "width 0.3s ease", borderRadius: 999 }} />
    </div>
  );
}
