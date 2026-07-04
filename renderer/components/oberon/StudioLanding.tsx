// Oberon 진입 랜딩 — 애니메이션 제작 콘솔과 모션그래픽 Agent App을 한 화면에서 고른다.
"use client";
import type { CSSProperties } from "react";
import Link from "next/link";
import type { OberonStudio } from "@/lib/oberon";
import { useT } from "@/lib/i18n";
import { Glyph } from "./icons";

export function StudioLanding({ onPick }: { onPick: (studio: OberonStudio) => void }) {
  const { locale } = useT();
  const isKo = locale === "ko";
  const lanes = [
    {
      id: "animation",
      kind: "button",
      label: isKo ? "Animation Studio" : "Animation Studio",
      title: isKo ? "애니메이션 제작" : "Animation production",
      blurb: isKo
        ? "컷 이미지를 먼저 락하고, 샷 단위로 애니메이션을 생성한 뒤 납품 파일까지 정리합니다."
        : "Locks cut images first, animates shot by shot, then packages delivery files.",
      glyph: "sparkle" as const,
      steps: ["Source", "Frames", "Animate", "Deliver"],
      cta: isKo ? "애니메이션 시작" : "Start animation",
    },
    {
      id: "motion",
      kind: "link",
      label: "Motiongraphic Studio",
      title: isKo ? "모션그래픽 광고" : "Motion-graphics ad",
      blurb: isKo
        ? "실제 제품 화면을 증거로 삼아 Remotion/Lottie 중심의 30초 모션그래픽을 조립합니다."
        : "Builds a 30-second Remotion/Lottie motion graphic around real product-screen proof.",
      glyph: "layers" as const,
      steps: ["Proof", "Timeline", "Render", "QA"],
      cta: isKo ? "모션 스튜디오 열기" : "Open motion studio",
    },
  ];

  return (
    <div style={wrap}>
      <div style={inner}>
        <div style={topline}>
          <Link href="/apps" style={backLink}>
            <Glyph name="chevron" size={12} style={{ transform: "rotate(180deg)" }} />
            Apps
          </Link>
          <span style={statusBadge}>Oberon Studio Console</span>
        </div>

        <section className="oberon-studio-console" style={consoleShell}>
          <div style={heroPane}>
            <div style={eyebrow}>PRODUCT PROOF FIRST</div>
            <h1 style={title}>{isKo ? "오베론 제작 스튜디오" : "Oberon production studios"}</h1>
            <p style={subtitle}>
              {isKo
                ? "애니메이션은 샷 파이프라인으로, 모션그래픽은 제품 화면 증거 중심 Agent App으로 분리했습니다."
                : "Animation runs through the shot pipeline; motion graphics opens as a product-proof Agent App."}
            </p>
            <div style={stage}>
              <div style={stageHeader}>
                <span>source</span>
                <span>shot lock</span>
                <span>render</span>
                <span>delivery</span>
              </div>
              <div style={stageBody}>
                <div style={filmStrip}>
                  {["00", "01", "02", "03"].map((n) => (
                    <span key={n} style={filmCell}>{n}</span>
                  ))}
                </div>
                <div style={screenMock}>
                  <div style={screenRail} />
                  <div style={screenContent}>
                    <span style={screenTag}>Animation</span>
                    <strong>Keyframe → Video</strong>
                    <div style={screenLines}>
                      <span style={{ ...screenLine, width: "82%" }} />
                      <span style={{ ...screenLine, width: "58%" }} />
                      <span style={{ ...screenLine, width: "70%", background: "var(--ob-accent-soft)" }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style={laneStack}>
            {lanes.map((lane) =>
              lane.kind === "link" ? (
                <Link key={lane.id} href="/oberon-motion" className="oberon-studio-lane" style={laneCard}>
                  <LaneBody lane={lane} />
                </Link>
              ) : (
                <button
                  key={lane.id}
                  type="button"
                  onClick={() => onPick("animation")}
                  className="oberon-studio-lane"
                  style={laneCard}
                >
                  <LaneBody lane={lane} />
                </button>
              ),
            )}
          </div>
        </section>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .oberon-studio-lane { transition: border-color .16s, background .16s, transform .16s; }
        .oberon-studio-lane:hover {
          border-color: var(--ob-ink);
          background: var(--ob-paper);
          transform: translateY(-1px);
          text-decoration: none;
        }
        @media (max-width: 920px) {
          .oberon-studio-console { grid-template-columns: 1fr !important; }
        }
      `,
        }}
      />
    </div>
  );
}

function LaneBody({
  lane,
}: {
  lane: {
    label: string;
    title: string;
    blurb: string;
    glyph: "sparkle" | "layers";
    steps: string[];
    cta: string;
  };
}) {
  return (
    <>
      <span style={laneHead}>
        <span style={laneIcon}>
          <Glyph name={lane.glyph} size={16} />
        </span>
        <span style={laneLabel}>{lane.label}</span>
      </span>
      <strong style={laneTitle}>{lane.title}</strong>
      <span style={laneBlurb}>{lane.blurb}</span>
      <span style={miniSteps}>
        {lane.steps.map((step) => (
          <span key={step} style={miniStep}>{step}</span>
        ))}
      </span>
      <span style={laneCta}>
        {lane.cta}
        <Glyph name="chevron" size={12} />
      </span>
    </>
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
  borderRadius: 8,
  border: "1px solid var(--ob-edge)",
  background: "var(--ob-paper)",
  color: "var(--ob-ink-soft)",
  fontSize: 12,
  fontWeight: 700,
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
  fontWeight: 800,
  letterSpacing: ".04em",
  textTransform: "uppercase",
};

const consoleShell: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.15fr) minmax(360px, .85fr)",
  gap: 16,
  alignItems: "stretch",
};

const eyebrow: CSSProperties = {
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: ".08em",
  color: "var(--ob-accent-text)",
  textTransform: "uppercase",
  marginBottom: 10,
};

const title: CSSProperties = {
  margin: 0,
  fontSize: 30,
  fontWeight: 780,
  lineHeight: 1.05,
  color: "var(--ob-ink)",
  fontFamily: "var(--font-display, var(--rd-f-display, inherit))",
  letterSpacing: 0,
};

const subtitle: CSSProperties = {
  margin: "10px 0 22px",
  maxWidth: 600,
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--ob-ink-soft)",
};

const heroPane: CSSProperties = {
  minHeight: 520,
  padding: 24,
  borderRadius: 8,
  border: "1px solid var(--ob-edge)",
  background: "var(--ob-paper)",
  display: "grid",
  gridTemplateRows: "auto 1fr",
  boxShadow: "var(--shadow-1)",
};

const stage: CSSProperties = {
  alignSelf: "end",
  minHeight: 310,
  borderRadius: 8,
  border: "1px solid var(--ob-edge)",
  background: "linear-gradient(180deg, var(--ob-surface), var(--ob-paper))",
  overflow: "hidden",
};

const stageHeader: CSSProperties = {
  minHeight: 42,
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  alignItems: "center",
  borderBottom: "1px solid var(--ob-edge)",
  color: "var(--ob-muted)",
  fontSize: 10.5,
  fontWeight: 850,
  letterSpacing: ".05em",
  textTransform: "uppercase",
};

const stageBody: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "92px 1fr",
  gap: 18,
  padding: 20,
};

const filmStrip: CSSProperties = {
  display: "grid",
  gap: 10,
};

const filmCell: CSSProperties = {
  minHeight: 54,
  borderRadius: 7,
  border: "1px solid var(--ob-edge)",
  background: "var(--ob-paper)",
  color: "var(--ob-muted)",
  display: "grid",
  placeItems: "center",
  fontSize: 12,
  fontWeight: 850,
  fontFamily: "var(--font-mono)",
};

const screenMock: CSSProperties = {
  minHeight: 236,
  borderRadius: 8,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  display: "grid",
  gridTemplateColumns: "74px 1fr",
  overflow: "hidden",
};

const screenRail: CSSProperties = {
  borderRight: "1px solid var(--ob-edge)",
  background:
    "linear-gradient(var(--ob-ink) 0 0) 18px 24px / 38px 7px no-repeat, linear-gradient(var(--ob-fill) 0 0) 18px 48px / 30px 7px no-repeat, linear-gradient(var(--ob-fill) 0 0) 18px 72px / 34px 7px no-repeat, var(--ob-surface)",
};

const screenContent: CSSProperties = {
  padding: 26,
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
  background: "var(--ob-accent-soft)",
  color: "var(--ob-accent-text)",
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: ".04em",
  textTransform: "uppercase",
};

const screenLines: CSSProperties = {
  display: "grid",
  gap: 8,
  maxWidth: 360,
};

const screenLine: CSSProperties = {
  display: "block",
  height: 9,
  borderRadius: 5,
  background: "var(--ob-fill)",
};

const laneStack: CSSProperties = {
  display: "grid",
  gap: 12,
  alignContent: "stretch",
};

const laneCard: CSSProperties = {
  width: "100%",
  minHeight: 254,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  textAlign: "left",
  gap: 10,
  padding: 20,
  borderRadius: 8,
  border: "1px solid var(--ob-edge)",
  background: "var(--ob-surface)",
  color: "var(--ob-ink)",
  cursor: "pointer",
  textDecoration: "none",
  boxShadow: "var(--shadow-1)",
};

const laneHead: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 9,
  color: "var(--ob-muted)",
};

const laneIcon: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 7,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--ob-paper)",
  border: "1px solid var(--ob-edge)",
  color: "var(--ob-ink-soft)",
};

const laneLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: ".06em",
  textTransform: "uppercase",
};

const laneTitle: CSSProperties = {
  marginTop: 6,
  color: "var(--ob-ink)",
  fontSize: 22,
  lineHeight: 1.12,
  fontWeight: 780,
  fontFamily: "var(--font-display, var(--rd-f-display, inherit))",
};

const laneBlurb: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ob-ink-soft)",
};

const miniSteps: CSSProperties = {
  marginTop: "auto",
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 6,
  width: "100%",
};

const miniStep: CSSProperties = {
  minHeight: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
  background: "var(--ob-paper)",
  border: "1px solid var(--ob-edge)",
  color: "var(--ob-muted)",
  fontSize: 10.5,
  fontWeight: 800,
  fontFamily: "var(--font-mono)",
};

const laneCta: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 34,
  padding: "0 11px",
  borderRadius: 7,
  background: "var(--ob-ink)",
  color: "var(--ob-paper)",
  fontSize: 12.5,
  fontWeight: 800,
};
