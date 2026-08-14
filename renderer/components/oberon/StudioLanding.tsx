// Oberon production home — 실제 제작 단계와 로컬 프로젝트를 먼저 보여준다.
"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { OberonStudio, ProductionMeta } from "@/lib/oberon";
import { listProductions } from "@/lib/oberon";
import { useT } from "@/lib/i18n";
import { Glyph } from "./icons";

type StageRow = {
  code: string;
  ko: string;
  en: string;
  detailKo: string;
  detailEn: string;
  gateKo: string;
  gateEn: string;
  tone: "input" | "review" | "generate" | "deliver";
};

const STAGES: StageRow[] = [
  { code: "00", ko: "소스 · 모델", en: "Source · models", detailKo: "프롬프트, 레퍼런스, 실행 엔진", detailEn: "Prompt, references, execution engines", gateKo: "입력", gateEn: "Input", tone: "input" },
  { code: "01", ko: "기획안", en: "Plan", detailKo: "로그라인, 트리트먼트, 대본", detailEn: "Logline, treatment, script", gateKo: "승인", gateEn: "Review", tone: "review" },
  { code: "02", ko: "스토리보드", en: "Storyboard", detailKo: "씬, 비트, 샷, 카메라", detailEn: "Scenes, beats, shots, camera", gateKo: "승인", gateEn: "Review", tone: "review" },
  { code: "03", ko: "고정 에셋", en: "Locked assets", detailKo: "인물, 배경, 소품 레퍼런스", detailEn: "Character, setting, prop references", gateKo: "확정", gateEn: "Lock", tone: "review" },
  { code: "04", ko: "컷 이미지", en: "Cut images", detailKo: "샷별 첫·끝 프레임 생성", detailEn: "First and last frames per shot", gateKo: "생성", gateEn: "Generate", tone: "generate" },
  { code: "05", ko: "영상 · 모션", en: "Video · motion", detailKo: "샷별 테이크 생성과 QA", detailEn: "Per-shot takes and QA", gateKo: "생성", gateEn: "Generate", tone: "generate" },
  { code: "06", ko: "편집 · 납품", en: "Edit · delivery", detailKo: "타임라인, 마스터, 제작 문서", detailEn: "Timeline, masters, production docs", gateKo: "출력", gateEn: "Deliver", tone: "deliver" },
];

const FORMAT_LABELS: Record<string, { ko: string; en: string }> = {
  commercial_30: { ko: "30초 광고", en: "30s commercial" },
  commercial_60: { ko: "60초 광고", en: "60s commercial" },
  motion_graphics_30: { ko: "30초 모션그래픽", en: "30s motion graphics" },
  motion_graphics_60: { ko: "60초 모션그래픽", en: "60s motion graphics" },
  cinematic_short: { ko: "시네마틱 숏", en: "Cinematic short" },
  social_short: { ko: "소셜 숏", en: "Social short" },
  trailer: { ko: "트레일러", en: "Trailer" },
};

export function StudioLanding({
  onPick,
  onOpen,
}: {
  onPick: (studio: OberonStudio) => void;
  onOpen: (productionId: string) => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [recents, setRecents] = useState<ProductionMeta[]>([]);

  useEffect(() => {
    setRecents(listProductions().slice(0, 5));
  }, []);

  return (
    <div className="oberon-production-home" style={wrap}>
      <div style={inner}>
        <header style={homeHeader}>
          <div>
            <div style={kicker}>{ko ? "프로덕션 홈" : "PRODUCTION HOME"}</div>
            <h1 style={homeTitle}>{ko ? "무엇을 만들지 정하고, 단계마다 확인합니다." : "Set the production, then review every gate."}</h1>
            <p style={homeCopy}>
              {ko
                ? "기획부터 컷 생성, 영상, 납품까지 같은 프로젝트 기록을 사용합니다. 연결된 CLI와 선택한 미디어 엔진만 실제 작업을 실행합니다."
                : "Planning, cut generation, video, and delivery share one project record. Only your connected CLI and selected media engines execute work."}
            </p>
          </div>
          <button type="button" onClick={() => onPick("animation")} style={primaryAction}>
            <Glyph name="plus" size={14} strokeWidth={2.2} />
            {ko ? "새 제작 시작" : "New production"}
          </button>
        </header>

        <div className="oberon-home-grid" style={workspaceGrid}>
          <section style={pipelinePanel} aria-labelledby="oberon-pipeline-title">
            <div style={panelHead}>
              <div>
                <span style={panelIndex}>PIPELINE / 07</span>
                <h2 id="oberon-pipeline-title" style={panelTitle}>{ko ? "실제 제작 게이트" : "Production gates"}</h2>
              </div>
              <span style={localBadge}>{ko ? "로컬 프로젝트" : "LOCAL PROJECT"}</span>
            </div>
            <div style={stageTable}>
              {STAGES.map((stage) => (
                <div key={stage.code} className="oberon-stage-row" style={stageRow}>
                  <span style={stageCode}>{stage.code}</span>
                  <strong style={stageName}>{ko ? stage.ko : stage.en}</strong>
                  <span style={stageDetail}>{ko ? stage.detailKo : stage.detailEn}</span>
                  <span data-tone={stage.tone} className="oberon-stage-gate" style={stageGate}>{ko ? stage.gateKo : stage.gateEn}</span>
                </div>
              ))}
            </div>
          </section>

          <aside style={sideColumn}>
            <section style={boundaryPanel} aria-labelledby="oberon-runtime-boundary">
              <div style={panelHeadCompact}>
                <span style={panelIndex}>EXECUTION</span>
                <h2 id="oberon-runtime-boundary" style={panelTitleSmall}>{ko ? "누가 무엇을 실행하나" : "What executes each step"}</h2>
              </div>
              <BoundaryRow label={ko ? "기획" : "Plan"} value={ko ? "연결된 Claude · Codex · Antigravity" : "Connected Claude, Codex, or Antigravity"} />
              <BoundaryRow label={ko ? "이미지" : "Images"} value={ko ? "선택한 이미지 엔진 · 병렬 컷 생성" : "Selected image engine · parallel cuts"} />
              <BoundaryRow label={ko ? "영상" : "Video"} value={ko ? "선택한 영상 엔진 · 샷별 테이크" : "Selected video engine · per-shot takes"} />
              <BoundaryRow label={ko ? "승인" : "Review"} value={ko ? "기획·보드·에셋·테이크에서 중단 가능" : "Pause at plan, board, assets, and takes"} />
              <p style={boundaryNote}>
                {ko
                  ? "엔진이 연결되지 않았거나 호출이 실패하면 가짜 결과로 다음 단계에 넘어가지 않습니다."
                  : "If an engine is unavailable or a call fails, Oberon does not advance with a fake result."}
              </p>
            </section>

            <section style={recentPanel} aria-labelledby="oberon-recents-title">
              <div style={panelHeadCompact}>
                <span style={panelIndex}>PROJECTS</span>
                <h2 id="oberon-recents-title" style={panelTitleSmall}>{ko ? "최근 제작" : "Recent productions"}</h2>
              </div>
              {recents.length === 0 ? (
                <div style={emptyRecent}>
                  <strong>{ko ? "아직 저장된 제작이 없습니다." : "No saved production yet."}</strong>
                  <span>{ko ? "첫 기획을 만들면 이 Mac에 이어서 열 수 있게 저장됩니다." : "Your first plan will be saved on this Mac for reopening."}</span>
                </div>
              ) : (
                <div style={recentList}>
                  {recents.map((production) => (
                    <button key={production.id} type="button" onClick={() => onOpen(production.id)} className="oberon-recent-row" style={recentRow}>
                      <span style={recentMain}>
                        <strong>{production.title || (ko ? "제목 없는 제작" : "Untitled production")}</strong>
                        <small>{formatLabel(production.format, ko)} · {ko ? `${production.shotCount}개 샷` : `${production.shotCount} shots`}</small>
                      </span>
                      <span style={recentDate}>{formatDate(production.createdAtMs, locale)}</span>
                      <Glyph name="chevron" size={12} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .oberon-stage-row:first-child { border-top: 0 !important; }
        .oberon-stage-row:hover { background: color-mix(in srgb, var(--ob-fill) 48%, transparent); }
        .oberon-stage-gate[data-tone="input"] { color: #355c7d !important; border-color: rgba(53,92,125,.28) !important; }
        .oberon-stage-gate[data-tone="review"] { color: #765b19 !important; border-color: rgba(118,91,25,.28) !important; }
        .oberon-stage-gate[data-tone="generate"] { color: #0b6670 !important; border-color: rgba(11,102,112,.28) !important; }
        .oberon-stage-gate[data-tone="deliver"] { color: #235d36 !important; border-color: rgba(35,93,54,.28) !important; }
        .oberon-recent-row:hover { background: var(--ob-fill) !important; }
        .oberon-production-home button:focus-visible { outline: 2px solid var(--ob-accent); outline-offset: 2px; }
        @media (max-width: 980px) {
          .oberon-home-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 700px) {
          .oberon-production-home { padding: 18px 14px 28px !important; }
          .oberon-production-home > div > header { align-items: stretch !important; flex-direction: column !important; }
          .oberon-production-home > div > header button { width: 100%; }
          .oberon-stage-row { grid-template-columns: 38px minmax(0,1fr) auto !important; gap: 8px !important; }
          .oberon-stage-row > span:nth-child(3) { grid-column: 2 / 4; }
        }
      ` }} />
    </div>
  );
}

function BoundaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={boundaryRow}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function formatLabel(format: string, ko: boolean): string {
  const label = FORMAT_LABELS[format];
  return label ? (ko ? label.ko : label.en) : format.replaceAll("_", " ");
}

function formatDate(value: number, locale: string): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric" }).format(value);
}

const wrap: CSSProperties = { flex: 1, minHeight: 0, width: "100%", overflowY: "auto", padding: "30px", background: "var(--ob-bg)" };
const inner: CSSProperties = { width: "100%", maxWidth: 1240, margin: "0 auto", display: "grid", gap: 18 };
const homeHeader: CSSProperties = { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 28, padding: "8px 0 4px" };
const kicker: CSSProperties = { color: "var(--ob-muted)", font: "760 10px/1.2 var(--rd-f-mono, monospace)", letterSpacing: ".09em" };
const homeTitle: CSSProperties = { margin: "9px 0 0", maxWidth: 760, color: "var(--ob-ink)", fontSize: "clamp(26px, 3vw, 38px)", lineHeight: 1.12, letterSpacing: "-.035em", fontWeight: 820, wordBreak: "keep-all" };
const homeCopy: CSSProperties = { maxWidth: 780, margin: "12px 0 0", color: "var(--ob-ink-soft)", fontSize: 13.5, lineHeight: 1.65, wordBreak: "keep-all" };
const primaryAction: CSSProperties = { flex: "0 0 auto", minHeight: 42, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 16px", border: "1px solid var(--ob-ink)", borderRadius: 6, background: "var(--ob-ink)", color: "var(--ob-paper)", fontSize: 13, fontWeight: 780, cursor: "pointer" };
const workspaceGrid: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0,1.42fr) minmax(320px,.78fr)", gap: 12, alignItems: "start" };
const pipelinePanel: CSSProperties = { border: "1px solid var(--ob-edge-strong)", borderRadius: 7, background: "var(--ob-paper)", overflow: "hidden" };
const panelHead: CSSProperties = { minHeight: 72, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "14px 17px", borderBottom: "1px solid var(--ob-edge)" };
const panelHeadCompact: CSSProperties = { display: "grid", gap: 5, padding: "15px 16px 13px", borderBottom: "1px solid var(--ob-edge)" };
const panelIndex: CSSProperties = { color: "var(--ob-muted)", font: "740 9.5px/1 var(--rd-f-mono, monospace)", letterSpacing: ".09em" };
const panelTitle: CSSProperties = { margin: "6px 0 0", color: "var(--ob-ink)", fontSize: 17, lineHeight: 1.2, fontWeight: 790 };
const panelTitleSmall: CSSProperties = { margin: 0, color: "var(--ob-ink)", fontSize: 14.5, lineHeight: 1.25, fontWeight: 780 };
const localBadge: CSSProperties = { minHeight: 24, display: "inline-flex", alignItems: "center", padding: "0 8px", border: "1px solid var(--ob-edge-strong)", borderRadius: 4, color: "var(--ob-muted)", font: "720 9px/1 var(--rd-f-mono, monospace)", letterSpacing: ".06em" };
const stageTable: CSSProperties = { display: "grid" };
const stageRow: CSSProperties = { minHeight: 62, display: "grid", gridTemplateColumns: "44px 136px minmax(0,1fr) 58px", alignItems: "center", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--ob-edge)", transition: "background .12s ease" };
const stageCode: CSSProperties = { color: "var(--ob-muted)", font: "760 10.5px/1 var(--rd-f-mono, monospace)", fontVariantNumeric: "tabular-nums" };
const stageName: CSSProperties = { color: "var(--ob-ink)", fontSize: 13.5, fontWeight: 780 };
const stageDetail: CSSProperties = { minWidth: 0, color: "var(--ob-ink-soft)", fontSize: 12.5, lineHeight: 1.4 };
const stageGate: CSSProperties = { minHeight: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 7px", border: "1px solid var(--ob-edge-strong)", borderRadius: 4, background: "transparent", fontSize: 10.5, fontWeight: 760 };
const sideColumn: CSSProperties = { display: "grid", gap: 12 };
const boundaryPanel: CSSProperties = { border: "1px solid var(--ob-edge-strong)", borderRadius: 7, background: "var(--ob-paper)", overflow: "hidden" };
const boundaryRow: CSSProperties = { display: "grid", gridTemplateColumns: "68px minmax(0,1fr)", gap: 10, alignItems: "start", minHeight: 48, padding: "11px 15px", borderBottom: "1px solid var(--ob-edge)", color: "var(--ob-ink-soft)", fontSize: 11.5, lineHeight: 1.45 };
const boundaryNote: CSSProperties = { margin: 0, padding: "12px 15px 14px", color: "var(--ob-muted)", background: "var(--ob-surface)", fontSize: 11.5, lineHeight: 1.55 };
const recentPanel: CSSProperties = { border: "1px solid var(--ob-edge-strong)", borderRadius: 7, background: "var(--ob-paper)", overflow: "hidden" };
const emptyRecent: CSSProperties = { minHeight: 116, display: "grid", alignContent: "center", gap: 6, padding: 16, color: "var(--ob-muted)", fontSize: 11.5, lineHeight: 1.5 };
const recentList: CSSProperties = { display: "grid" };
const recentRow: CSSProperties = { width: "100%", minHeight: 54, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 14px", alignItems: "center", gap: 8, padding: "8px 13px", border: 0, borderBottom: "1px solid var(--ob-edge)", background: "transparent", color: "var(--ob-ink)", textAlign: "left", cursor: "pointer" };
const recentMain: CSSProperties = { minWidth: 0, display: "grid", gap: 3 };
const recentDate: CSSProperties = { color: "var(--ob-muted)", font: "680 9.5px/1 var(--rd-f-mono, monospace)" };
