"use client";
// Oberon 시네마틱 커버리지 워크플로우 — 단계별 화면.
//
// 엔진(shared/oberon-cinematic.ts)의 결정적 프롬프트 빌더를 감싸, 사용자가
// 단일 컷 → 커버리지 그리드 → 개별 추출 → 연속성 수정 → 영상화 순서를 밟게 한다.
// 생성 실행은 기존 oberon.startSheets / startKeyframes 브리지를 재사용한다.
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import {
  CINEMATIC_PIPELINE_STAGES,
  buildCinematicWorkflow,
  buildPanelExtractionPrompts,
  buildContinuityFixPrompt,
  lintCinematicPrompt,
  recommendPanelLayout,
  type CinematicSceneSixW,
  type ContinuityFix,
} from "@shared/oberon-cinematic";
import type { OberonKeyframeJob, OberonSheetKindInput } from "@shared/types";

type StageId = (typeof CINEMATIC_PIPELINE_STAGES)[number]["id"];

interface Props {
  /** 생성 실행에 필요한 컨텍스트 — 없으면 프롬프트 조립까지만(복사해서 어디든 사용). */
  productionId?: string;
  title?: string;
  /** 이미지 프로바이더 선택 (page의 model.imageProvider와 동일 값). */
  imageProvider?: "google-image" | string;
}

const EMPTY_6W: CinematicSceneSixW = { who: "", when: "", where: "", how: "", what: "", why: "" };

const SIXW_FIELDS: Array<{ key: keyof CinematicSceneSixW; label: string; hint: string }> = [
  { key: "who", label: "누가", hint: "피사체 — 인물, 나이/외형" },
  { key: "when", label: "언제", hint: "시간대와 광질 (낮/밤, 역광 등)" },
  { key: "where", label: "어디서", hint: "장소/배경" },
  { key: "what", label: "무엇을", hint: "행동/상태" },
  { key: "how", label: "어떻게", hint: "프레이밍·앵글·조명" },
  { key: "why", label: "왜", hint: "감정/분위기" },
];

export function CinematicWorkflowPanel({ productionId, title, imageProvider }: Props) {
  const { locale } = useT();
  const ko = locale !== "en";
  const [scene, setScene] = useState<CinematicSceneSixW>(EMPTY_6W);
  const [stage, setStage] = useState<StageId>("single_cut");
  const [layoutOverride, setLayoutOverride] = useState<"auto" | "grid_3x3" | "stack_4">("auto");
  const [withRowSpec, setWithRowSpec] = useState(false);
  const [selectedPanels, setSelectedPanels] = useState<Set<number>>(new Set());
  const [fixes, setFixes] = useState<ContinuityFix[]>([]);
  const [job, setJob] = useState<OberonKeyframeJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sceneFilled = SIXW_FIELDS.some((f) => scene[f.key].trim().length > 0);

  const plan = useMemo(() => {
    if (!sceneFilled) return null;
    return buildCinematicWorkflow({
      scene,
      layout: layoutOverride === "auto" ? undefined : layoutOverride,
      shotCount: withRowSpec ? 9 : undefined,
      withRowShotSpec: withRowSpec,
    });
  }, [scene, layoutOverride, withRowSpec, sceneFilled]);

  const layout = plan?.layout ?? recommendPanelLayout({});
  const panelCount = layout === "grid_3x3" ? 9 : 4;

  const extractionPrompts = useMemo(() => {
    const panels = [...selectedPanels].sort((a, b) => a - b);
    return panels.length ? buildPanelExtractionPrompts(panels) : [];
  }, [selectedPanels]);

  const canGenerate = Boolean(productionId && ipc()?.oberon?.startSheets);

  async function generateSheet(kind: OberonSheetKindInput, prompt: string, id: string) {
    const bridge = ipc();
    if (!productionId || !bridge?.oberon?.startSheets) {
      setError(ko ? "생성은 데스크톱 앱 + 프로덕션 컨텍스트에서만 됩니다. 프롬프트는 복사해 사용하세요." : "Generation needs the desktop app with a production. Copy the prompt instead.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const provider = imageProvider === "google-image" ? "google-imagen" : "codex-imagegen-cli";
      const started = await bridge.oberon.startSheets({
        productionId,
        title: title ?? "Cinematic coverage",
        sheets: [{ id, kind, prompt, aspectRatio: "16:9" }],
        provider,
        imageSize: "2K",
      });
      setJob(started);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={panelStyle}>
      <div style={{ marginBottom: 14 }}>
        <div style={eyebrowStyle}>{ko ? "시네마틱 커버리지 워크플로우" : "Cinematic coverage workflow"}</div>
        <div style={{ color: "var(--muted-deep)", fontSize: 12.5, marginTop: 4 }}>
          {ko
            ? "단일 컷으로 의도를 확인하고, 커버리지로 여러 샷을 뽑고, 골라 추출한 뒤 연속성을 다듬어 영상화로 넘깁니다."
            : "Confirm intent with a single cut, pull coverage, extract the keepers, fix continuity, then hand off to video."}
        </div>
      </div>

      {/* 스테이지 스텝퍼 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {CINEMATIC_PIPELINE_STAGES.map((s, i) => {
          const activeStage = s.id === stage;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStage(s.id)}
              style={{
                ...stepChip,
                background: activeStage ? "var(--accent-soft)" : "var(--paper-2)",
                border: `1px solid ${activeStage ? "var(--accent)" : "var(--paper-edge)"}`,
                color: activeStage ? "var(--accent-strong)" : "var(--ink-soft)",
                fontWeight: activeStage ? 750 : 600,
              }}
            >
              <span style={{ opacity: 0.6, marginRight: 6 }}>{i + 1}</span>
              {s.label}
            </button>
          );
        })}
      </div>

      {/* 1) 단일 컷 — 6하원칙 */}
      {stage === "single_cut" && (
        <div>
          <SectionTitle>{ko ? "6하원칙으로 장면 분해" : "Break the scene into 5W1H"}</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {SIXW_FIELDS.map((f) => (
              <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={fieldLabel}>{f.label}</span>
                <input
                  value={scene[f.key]}
                  onChange={(e) => setScene((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.hint}
                  style={inputStyle}
                />
              </label>
            ))}
          </div>
          {plan && (
            <>
              <PromptBlock label={ko ? "단일 컷 프롬프트" : "Single-cut prompt"} text={plan.singleCutPrompt} ko={ko} />
              {plan.lint.length > 0 && (
                <div style={warnBox}>
                  {plan.lint.map((f, i) => (
                    <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                      <span aria-hidden>⚠️</span>
                      <span>{f.message}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" style={primaryBtn} disabled={busy || !canGenerate} onClick={() => generateSheet("master_sheet_v2", plan.singleCutPrompt, "single_cut")}>
                  {ko ? "이 컷 1장 생성" : "Generate this cut"}
                </button>
                <button type="button" style={ghostBtn} onClick={() => setStage("grid_coverage")}>
                  {ko ? "의도 확인됨 → 커버리지" : "Intent confirmed → coverage"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 2) 커버리지 그리드/스택 */}
      {stage === "grid_coverage" && plan && (
        <div>
          <SectionTitle>{ko ? "커버리지 레이아웃" : "Coverage layout"}</SectionTitle>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            {(["auto", "grid_3x3", "stack_4"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setLayoutOverride(opt)}
                style={{ ...miniChip, ...(layoutOverride === opt ? activeMiniChip : {}) }}
              >
                {opt === "auto" ? (ko ? `자동(${layout === "grid_3x3" ? "3×3" : "4단"})` : `Auto (${layout === "grid_3x3" ? "3×3" : "stack"})`) : opt === "grid_3x3" ? "3×3 그리드" : "4단 스택"}
              </button>
            ))}
            <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--ink-soft)" }}>
              <input type="checkbox" checked={withRowSpec} onChange={(e) => setWithRowSpec(e.target.checked)} disabled={layout !== "grid_3x3"} />
              {ko ? "행별 샷 지정(9장 모두 살리기)" : "Row shot spec (keep all 9)"}
            </label>
          </div>
          <PromptBlock label={ko ? "커버리지 프롬프트 (캐릭터/장면 시트 첨부)" : "Coverage prompt (attach character/scene sheets)"} text={plan.coverageSheet.prompt} ko={ko} />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" style={primaryBtn} disabled={busy || !canGenerate} onClick={() => generateSheet(plan.coverageSheet.kind, plan.coverageSheet.prompt, plan.coverageSheet.id)}>
              {ko ? `${layout === "grid_3x3" ? "3×3 그리드" : "4단 스택"} 생성` : `Generate ${layout === "grid_3x3" ? "3×3 grid" : "stack"}`}
            </button>
            <button type="button" style={ghostBtn} onClick={() => setStage("panel_extract")}>
              {ko ? "패널 골라 추출 →" : "Pick panels → extract"}
            </button>
          </div>
        </div>
      )}

      {/* 3) 개별 추출 */}
      {stage === "panel_extract" && (
        <div>
          <SectionTitle>{ko ? `쓸 패널 선택 (1~${panelCount})` : `Select keeper panels (1–${panelCount})`}</SectionTitle>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {Array.from({ length: panelCount }, (_, i) => i + 1).map((n) => {
              const on = selectedPanels.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() =>
                    setSelectedPanels((prev) => {
                      const next = new Set(prev);
                      next.has(n) ? next.delete(n) : next.add(n);
                      return next;
                    })
                  }
                  style={{ ...panelChip, ...(on ? activePanelChip : {}) }}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <div style={{ color: "var(--muted-deep)", fontSize: 12, marginBottom: 8 }}>
            {ko ? "한 번에 전부는 실패하기 쉬워 2~3장씩 배치로 나눕니다." : "Batches of 2–3 — extracting all at once tends to fail."}
          </div>
          {extractionPrompts.map((p, i) => (
            <PromptBlock key={i} label={ko ? `추출 배치 ${i + 1}` : `Extraction batch ${i + 1}`} text={p} ko={ko} />
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" style={ghostBtn} onClick={() => setStage("continuity_fix")}>
              {ko ? "연속성 수정 →" : "Continuity fixes →"}
            </button>
          </div>
        </div>
      )}

      {/* 4) 연속성 수정 */}
      {stage === "continuity_fix" && (
        <div>
          <SectionTitle>{ko ? "연속성 수정 (180도 법칙 등)" : "Continuity fixes (180° rule, etc.)"}</SectionTitle>
          <div style={{ color: "var(--muted-deep)", fontSize: 12, marginBottom: 8 }}>
            {ko ? "좌우 반전·의상 불일치 등을 패널별로 지정합니다." : "Flag flips, wardrobe drift, etc. per panel."}
          </div>
          {[...selectedPanels].sort((a, b) => a - b).map((panel) => {
            const existing = fixes.find((f) => f.panel === panel);
            return (
              <div key={panel} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={{ ...panelChip, ...activePanelChip, cursor: "default" }}>{panel}</span>
                <input
                  value={existing?.instruction ?? ""}
                  onChange={(e) =>
                    setFixes((prev) => {
                      const rest = prev.filter((f) => f.panel !== panel);
                      return e.target.value.trim() ? [...rest, { panel, instruction: e.target.value }] : rest;
                    })
                  }
                  placeholder={ko ? "예: 좌우 반전 / 의상 변경" : "e.g. flip horizontally / change wardrobe"}
                  style={{ ...inputStyle, flex: 1 }}
                />
              </div>
            );
          })}
          {fixes.length > 0 && <PromptBlock label={ko ? "수정 지시" : "Fix instructions"} text={buildContinuityFixPrompt(fixes)} ko={ko} />}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" style={ghostBtn} onClick={() => setStage("animate_edit")}>
              {ko ? "영상화·편집 →" : "Animate & edit →"}
            </button>
          </div>
        </div>
      )}

      {/* 5) 영상화·편집 안내 */}
      {stage === "animate_edit" && (
        <div>
          <SectionTitle>{ko ? "영상화·편집" : "Animate & edit"}</SectionTitle>
          <div style={{ color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.6 }}>
            {ko
              ? "추출·수정된 컷들을 각각 image-to-video로 애니메이트한 뒤 순서를 배치해 하나의 씬을 만듭니다. 데스크톱의 Animate 단계(키프레임 → 영상)로 넘어가세요."
              : "Animate each finished cut with image-to-video, then sequence them into a scene. Continue in the desktop Animate step (keyframe → video)."}
          </div>
        </div>
      )}

      {/* 상태 */}
      {(job || error || busy) && (
        <div style={{ marginTop: 14, fontSize: 12.5 }}>
          {busy && <span style={{ color: "var(--muted-deep)" }}>{ko ? "생성 요청 중…" : "Requesting generation…"}</span>}
          {error && <span style={{ color: "var(--err, #b23)" }}>{error}</span>}
          {job && !error && (
            <span style={{ color: "var(--accent-strong)" }}>
              {ko ? `생성 잡 시작됨: ${job.id} (상태 ${job.status})` : `Job started: ${job.id} (${job.status})`}
            </span>
          )}
        </div>
      )}
      {!canGenerate && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted-deep)" }}>
          {ko ? "프로덕션 컨텍스트가 없어 프롬프트 조립만 됩니다 — 각 프롬프트를 복사해 사용하세요." : "No production context — prompts are assembled for copy/paste."}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", marginBottom: 8 }}>{children}</div>;
}

function PromptBlock({ label, text, ko }: { label: string; text: string; ko: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, fontWeight: 650, color: "var(--muted-deep)" }}>{label}</span>
        <button
          type="button"
          style={copyBtn}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? (ko ? "복사됨" : "Copied") : ko ? "복사" : "Copy"}
        </button>
      </div>
      <pre style={preStyle}>{text}</pre>
    </div>
  );
}

const panelStyle: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  borderRadius: 14,
  padding: 18,
};
const eyebrowStyle: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--accent)" };
const stepChip: CSSProperties = { padding: "6px 11px", borderRadius: 999, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" };
const fieldLabel: CSSProperties = { fontSize: 11.5, fontWeight: 650, color: "var(--ink-soft)" };
const inputStyle: CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink)", fontSize: 12.5 };
const preStyle: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--paper-2)", border: "1px solid var(--paper-edge)", borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.5, margin: 0, fontFamily: "var(--font-mono, monospace)", color: "var(--ink)" };
const warnBox: CSSProperties = { marginTop: 10, padding: 10, borderRadius: 8, background: "color-mix(in oklab, var(--warn, #b80) 12%, transparent)", border: "1px solid color-mix(in oklab, var(--warn, #b80) 40%, transparent)", fontSize: 12, color: "var(--ink)", display: "flex", flexDirection: "column", gap: 6 };
const primaryBtn: CSSProperties = { padding: "8px 14px", borderRadius: 9, border: 0, background: "var(--accent)", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" };
const ghostBtn: CSSProperties = { padding: "8px 14px", borderRadius: 9, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 12.5, fontWeight: 650, cursor: "pointer" };
const copyBtn: CSSProperties = { padding: "2px 8px", borderRadius: 6, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 11, cursor: "pointer" };
const miniChip: CSSProperties = { padding: "5px 10px", borderRadius: 999, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 12, cursor: "pointer" };
const activeMiniChip: CSSProperties = { border: "1px solid var(--accent)", background: "var(--accent-soft)", color: "var(--accent-strong)", fontWeight: 700 };
const panelChip: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 12.5, fontWeight: 700, cursor: "pointer" };
const activePanelChip: CSSProperties = { border: "1px solid var(--accent)", background: "var(--accent-soft)", color: "var(--accent-strong)" };
