// Oberon 진입 랜딩 — 들어오면 두 스튜디오(모션그래픽 / 애니메이션) 중 하나를 고른다.
// docs/DESIGN.md 준수: 토큰만(하드코딩 X), 강조 1개, soft shadow(--rd-shadow), H1 ≤22px, 시스템 폰트.
"use client";
import type { CSSProperties } from "react";
import { OBERON_STUDIOS, type OberonStudio } from "@/lib/oberon";
import { Glyph, type GlyphName } from "./icons";

export function StudioLanding({ onPick }: { onPick: (studio: OberonStudio) => void }) {
  return (
    <div style={wrap}>
      <div style={inner}>
        <div style={eyebrow}>OBERON STUDIO</div>
        <h1 style={title}>무엇을 만들까요?</h1>
        <p style={subtitle}>만들 유형을 선택하세요.</p>

        <div style={grid}>
          {OBERON_STUDIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              className="oberon-studio-card"
              style={card}
            >
              <span style={cardIcon}>
                <Glyph name={s.glyph as GlyphName} size={20} />
              </span>
              <span style={cardTagline}>{s.tagline}</span>
              <span style={cardTitle}>{s.title}</span>
              <span style={cardBlurb}>{s.blurb}</span>
              <span style={cardCta}>
                시작하기 <Glyph name="chevron" size={12} />
              </span>
            </button>
          ))}
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .oberon-studio-card { transition: box-shadow .16s, border-color .16s, transform .16s; }
        .oberon-studio-card:hover {
          border-color: var(--ob-accent);
          box-shadow: var(--rd-shadow-2);
          transform: translateY(-2px);
        }
      `,
        }}
      />
    </div>
  );
}

const wrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  overflowY: "auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "40px 32px",
};

const inner: CSSProperties = {
  width: "100%",
  maxWidth: 680,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
};

const eyebrow: CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: ".14em",
  color: "var(--ob-muted)",
  marginBottom: 12,
};

// docs/DESIGN.md: 페이지 H1 18–22px.
const title: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 650,
  lineHeight: 1.15,
  color: "var(--ob-ink)",
  fontFamily: "var(--font-display, var(--rd-f-display, inherit))",
};

const subtitle: CSSProperties = {
  margin: "8px 0 28px",
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "var(--ob-muted)",
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 16,
  width: "100%",
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  textAlign: "left",
  gap: 7,
  padding: 20,
  borderRadius: "var(--rd-r-lg, 20px)",
  border: "1px solid var(--ob-edge)",
  background: "var(--ob-paper)",
  color: "var(--ob-ink)",
  boxShadow: "var(--rd-shadow-1)",
  cursor: "pointer",
  minHeight: 164,
};

const cardIcon: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 42,
  height: 42,
  borderRadius: "var(--rd-r-sm, 12px)",
  background: "var(--ob-accent-soft)",
  color: "var(--ob-accent-text)",
  marginBottom: 6,
};

const cardTagline: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "var(--ob-muted)",
};

const cardTitle: CSSProperties = {
  fontSize: 18,
  fontWeight: 650,
  color: "var(--ob-ink)",
  fontFamily: "var(--font-display, var(--rd-f-display, inherit))",
};

const cardBlurb: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--ob-ink-soft)",
  flex: 1,
};

const cardCta: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  marginTop: 8,
  fontSize: 13,
  fontWeight: 650,
  color: "var(--ob-accent-text)",
};
