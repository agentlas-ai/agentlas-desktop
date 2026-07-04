// Oberon 진입 랜딩 — 분리 앱 없이 한 제작 콘솔에서 시작한다.
"use client";
import type { CSSProperties } from "react";
import Link from "next/link";
import type { OberonStudio } from "@/lib/oberon";
import { useT } from "@/lib/i18n";
import { Glyph } from "./icons";

const REF_BLUE = "#0A84FF";
const REF_BLUE_TEXT = "#006DDE";
const REF_BLUE_SOFT = "rgba(10,132,255,0.12)";

export function StudioLanding({ onPick }: { onPick: (studio: OberonStudio) => void }) {
  const { locale } = useT();
  const isKo = locale === "ko";
  const stages = isKo
    ? ["소스", "기획", "컷 이미지", "영상/모션", "납품"]
    : ["Source", "Plan", "Frames", "Video/Motion", "Delivery"];
  const rows = isKo
    ? [
        ["01", "애니메이션", "이미지를 먼저 잠그고 샷 단위로 영상화"],
        ["02", "모션그래픽", "30초/60초 포맷을 같은 제작 흐름 안에서 코드 렌더"],
        ["03", "납품", "출력 파일과 편집 보드를 한 프로젝트에 정리"],
      ]
    : [
        ["01", "Animation", "Lock images first, then animate shot by shot"],
        ["02", "Motion graphics", "Render 30s/60s formats inside the same production flow"],
        ["03", "Delivery", "Keep outputs and edit board in one project"],
      ];

  return (
    <div style={wrap}>
      <div style={inner}>
        <div style={topline}>
          <Link href="/apps" style={backLink}>
            <Glyph name="chevron" size={12} style={{ transform: "rotate(180deg)" }} />
            Apps
          </Link>
          <span style={statusBadge}>Oberon Production Console</span>
        </div>

        <section className="oberon-studio-console" style={consoleShell}>
          <div style={heroPane}>
            <div style={blueStrokeA} />
            <div style={blueStrokeB} />
            <div style={eyebrow}>MAKE VIDEOS PROGRAMMATICALLY</div>
            <h1 className="oberon-studio-title" style={title}>{isKo ? "오베론 제작 스튜디오" : "Oberon production studio"}</h1>
            <p style={subtitle}>
              {isKo
                ? "영화, 애니메이션, 모션그래픽을 하나의 프로젝트 흐름에서 만들고 검수합니다."
                : "Build and review film, animation, and motion-graphics work in one project flow."}
            </p>
            <button type="button" onClick={() => onPick("animation")} style={startButton}>
              <Glyph name="sparkle" size={15} />
              {isKo ? "제작 시작" : "Start production"}
              <Glyph name="chevron" size={12} />
            </button>
          </div>

          <div style={diagramPane}>
            <div style={timeline}>
              {stages.map((stage, index) => (
                <div key={stage} style={timelineStep}>
                  <span style={timelineCode}>{String(index + 1).padStart(2, "0")}</span>
                  <span style={timelineBar(index === 0 || index === 3)} />
                  <strong style={timelineLabel}>{stage}</strong>
                </div>
              ))}
            </div>
            <div style={previewBox}>
              <div style={previewHeader}>
                <span style={windowDot} />
                <span style={windowDot} />
                <span style={windowDot} />
                <strong>Oberon</strong>
              </div>
              <div style={previewBody}>
                <div style={previewRail}>
                  <span style={{ width: "42%" }} />
                  <span style={{ width: "82%", background: REF_BLUE }} />
                  <span style={{ width: "70%" }} />
                </div>
                <div style={previewCard}>
                  <span style={screenTag}>{isKo ? "통합 제작" : "Unified flow"}</span>
                  <strong>{isKo ? "포맷은 선택하고, 프로젝트는 하나로" : "Choose the format, keep one project"}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section style={rowPanel} aria-label={isKo ? "Oberon 제작 흐름" : "Oberon production flow"}>
          {rows.map(([code, name, desc]) => (
            <div key={code} className="oberon-flow-row" style={flowRow}>
              <span style={rowCode}>{code}</span>
              <strong style={rowName}>{name}</strong>
              <span style={rowDesc}>{desc}</span>
            </div>
          ))}
        </section>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .oberon-studio-console { grid-template-columns: minmax(0, 1.05fr) minmax(360px, .95fr); }
        @media (max-width: 920px) {
          .oberon-studio-console { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 680px) {
          .oberon-studio-title { font-size: 40px !important; }
          .oberon-flow-row { grid-template-columns: 48px 1fr !important; align-items: start !important; padding: 14px !important; }
          .oberon-flow-row span:last-child { grid-column: 2 !important; }
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
  padding: "30px",
  background: "var(--ob-bg)",
};

const inner: CSSProperties = {
  width: "100%",
  maxWidth: 1180,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const topline: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const backLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  minHeight: 32,
  padding: "0 10px",
  borderRadius: 7,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  color: "var(--ob-ink)",
  fontSize: 12,
  fontWeight: 760,
  textDecoration: "none",
};

const statusBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 30,
  padding: "0 10px",
  borderRadius: 7,
  background: "var(--ob-ink)",
  color: "var(--ob-paper)",
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: ".04em",
  textTransform: "uppercase",
};

const consoleShell: CSSProperties = {
  display: "grid",
  gap: 16,
  alignItems: "stretch",
};

const heroPane: CSSProperties = {
  position: "relative",
  minHeight: 410,
  padding: "54px 36px",
  borderRadius: 8,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  textAlign: "center",
};

const blueStrokeA: CSSProperties = {
  position: "absolute",
  width: 260,
  height: 180,
  left: -92,
  top: -92,
  border: `18px solid ${REF_BLUE}`,
  borderRightColor: "transparent",
  borderBottomColor: "transparent",
  borderRadius: "50%",
  transform: "rotate(-18deg)",
};

const blueStrokeB: CSSProperties = {
  position: "absolute",
  width: 420,
  height: 120,
  right: -95,
  bottom: 42,
  borderBottom: `17px solid ${REF_BLUE}`,
  borderRadius: "50%",
  transform: "rotate(8deg)",
};

const eyebrow: CSSProperties = {
  position: "relative",
  zIndex: 1,
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: ".08em",
  color: REF_BLUE_TEXT,
  textTransform: "uppercase",
  marginBottom: 10,
};

const title: CSSProperties = {
  position: "relative",
  zIndex: 1,
  margin: 0,
  maxWidth: 560,
  fontSize: 48,
  fontWeight: 900,
  lineHeight: 1.08,
  color: "var(--ob-ink)",
  fontFamily: "var(--font-display, var(--rd-f-display, inherit))",
  letterSpacing: 0,
  wordBreak: "keep-all",
  overflowWrap: "normal",
};

const subtitle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  margin: "18px 0 24px",
  maxWidth: 540,
  fontSize: 15,
  lineHeight: 1.55,
  color: "var(--ob-ink-soft)",
};

const startButton: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  minHeight: 46,
  padding: "0 18px",
  borderRadius: 8,
  border: "2px solid var(--ob-ink)",
  background: "var(--ob-ink)",
  color: "var(--ob-paper)",
  fontSize: 14,
  fontWeight: 850,
  cursor: "pointer",
};

const diagramPane: CSSProperties = {
  minHeight: 410,
  padding: 22,
  borderRadius: 8,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  display: "grid",
  gridTemplateRows: "auto 1fr",
  gap: 18,
};

const timeline: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  borderBottom: "1px solid var(--ob-edge)",
  paddingBottom: 18,
  gap: 0,
};

const timelineStep: CSSProperties = {
  minWidth: 0,
  padding: "0 10px",
  borderRight: "1px solid var(--ob-edge)",
  display: "grid",
  gap: 8,
};

const timelineCode: CSSProperties = {
  color: REF_BLUE_TEXT,
  fontSize: 11,
  fontWeight: 900,
  fontVariantNumeric: "tabular-nums",
};

function timelineBar(active: boolean): CSSProperties {
  return {
    display: "block",
    width: active ? "100%" : "68%",
    height: 8,
    borderRadius: 5,
    background: active ? REF_BLUE : "var(--ob-fill)",
  };
}

const timelineLabel: CSSProperties = {
  color: "var(--ob-ink)",
  fontSize: 12.5,
  fontWeight: 780,
  lineHeight: 1.25,
};

const previewBox: CSSProperties = {
  minHeight: 280,
  borderRadius: 8,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  overflow: "hidden",
};

const previewHeader: CSSProperties = {
  height: 38,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 12px",
  borderBottom: "1px solid var(--ob-edge)",
  color: "var(--ob-muted)",
  fontSize: 11,
  fontWeight: 800,
};

const windowDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 4,
  background: "var(--ob-fill)",
  display: "inline-block",
};

const previewBody: CSSProperties = {
  minHeight: 242,
  display: "grid",
  gridTemplateColumns: "96px 1fr",
};

const previewRail: CSSProperties = {
  padding: "34px 18px",
  borderRight: "1px solid var(--ob-edge)",
  display: "grid",
  alignContent: "start",
  gap: 12,
};

const previewCard: CSSProperties = {
  margin: 28,
  borderRadius: 8,
  border: "1px solid var(--ob-edge)",
  background: "var(--ob-surface)",
  padding: 20,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 14,
  color: "var(--ob-ink)",
};

const screenTag: CSSProperties = {
  alignSelf: "flex-start",
  padding: "5px 8px",
  borderRadius: 6,
  background: REF_BLUE_SOFT,
  color: REF_BLUE_TEXT,
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: ".04em",
  textTransform: "uppercase",
};

const rowPanel: CSSProperties = {
  borderRadius: 8,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  overflow: "hidden",
};

const flowRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "64px 180px minmax(0, 1fr)",
  alignItems: "center",
  gap: 16,
  minHeight: 66,
  padding: "0 18px",
  borderTop: "1px solid var(--ob-edge)",
};

const rowCode: CSSProperties = {
  color: REF_BLUE_TEXT,
  fontSize: 12,
  fontWeight: 900,
  fontVariantNumeric: "tabular-nums",
};

const rowName: CSSProperties = {
  color: "var(--ob-ink)",
  fontSize: 15,
  fontWeight: 820,
};

const rowDesc: CSSProperties = {
  color: "var(--ob-ink-soft)",
  fontSize: 13.5,
  lineHeight: 1.45,
};
