// Oberon — Step 00 시작. 단순하게: 제목 + 만들고 싶은 영상(자유 프롬프트) + 참고자료.
// 나머지(장르·톤·캐릭터·설정·샷)는 에이전트가 추론해 기획안(01) 단계에서 채워두고, 거기서 수정/승인.
"use client";
import { useState, type ReactNode } from "react";
import {
  BRIEF_PRESETS,
  GENRE_TEMPLATES,
  inferBriefFromPrompt,
  type FilmBrief,
  type FilmFormat,
  type FilmProduction,
  type OberonStudio,
} from "@/lib/oberon";
import { IconPlus, IconClose, IconSparkles } from "@/components/Icon";
import { Chip, GhostButton, PanelHead, PrimaryButton } from "./ui";
import { Glyph } from "./icons";
import { LoadProjectModal } from "./LoadProjectModal";

const FORMATS: { id: FilmFormat | ""; label: string }[] = [
  { id: "", label: "자동 감지" },
  { id: "motion_graphics_30", label: "30초 모션그래픽" },
  { id: "motion_graphics_60", label: "60초 모션그래픽" },
  { id: "social_short", label: "소셜 숏폼" },
  { id: "commercial_30", label: "30초 광고" },
  { id: "commercial_60", label: "60초 광고" },
  { id: "trailer", label: "트레일러" },
  { id: "music_video", label: "뮤직비디오" },
  { id: "short_drama", label: "단편 드라마" },
  { id: "cinematic_short", label: "시네마틱 단편" },
];

export function BriefWizard({
  initial,
  studio,
  onPlan,
  planning,
  onLoad,
  headerSlot,
}: {
  initial?: FilmBrief;
  studio?: OberonStudio | null;
  onPlan: (brief: FilmBrief, premium: boolean) => void;
  planning: boolean;
  onLoad?: (prod: FilmProduction) => void;
  headerSlot?: ReactNode;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.synopsis || initial?.logline || "");
  const [refs, setRefs] = useState<string[]>(initial?.visualReferences ?? []);
  const [format, setFormat] = useState<FilmFormat | "">(
    initial?.format ?? (studio === "motion" ? "motion_graphics_30" : ""),
  );
  const [premium, setPremium] = useState(true);
  const [loadOpen, setLoadOpen] = useState(false);
  // 모션그래픽 스튜디오 전용 입력 — 고객 브랜드/로고.
  const [brandName, setBrandName] = useState(initial?.brandOrProduct ?? "");
  const [logoSrc, setLogoSrc] = useState(initial?.logoSource ?? "");

  function loadPreset(id: string) {
    const p = BRIEF_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setTitle(p.brief.title);
    setPrompt(p.brief.synopsis || p.brief.logline);
    setRefs(p.brief.visualReferences);
    setFormat(p.brief.format);
  }

  const canPlan = !!title.trim() && !!prompt.trim() && !planning;
  const tpl = format ? GENRE_TEMPLATES[format] : null;

  function generate() {
    const base = inferBriefFromPrompt({ title, prompt, references: refs, format });
    const brief =
      studio === "motion"
        ? { ...base, brandOrProduct: brandName.trim() || base.brandOrProduct, logoSource: logoSrc.trim() || undefined }
        : base;
    onPlan(brief, premium);
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 56px" }}>
      <PanelHead
        eyebrow={studio === "motion" ? "모션그래픽 · 시작" : studio === "animation" ? "애니메이션 · 시작" : "Step 00 · 시작"}
        title={studio === "motion" ? "어떤 모션그래픽을 만들까요?" : studio === "animation" ? "어떤 애니메이션을 만들까요?" : "무엇을 만들까요?"}
        subtitle="제목과 만들고 싶은 영상을 자유롭게 적으면, 에이전트가 장르·톤·캐릭터·샷을 알아서 잡습니다. 다음 단계에서 확인하고 고치면 돼요."
        icon={<Glyph name="sparkle" size={18} />}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setPremium((v) => !v)}
              title="켜면 Seedance·Veo 등 최고 화질 엔진을 우선 사용합니다 (비용 ↑)"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, minHeight: 38, padding: "0 14px",
                borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: "pointer",
                background: premium ? "var(--ob-accent-soft)" : "var(--ob-surface)",
                color: premium ? "var(--ob-accent-text)" : "var(--ob-ink-soft)",
                border: `1px solid ${premium ? "transparent" : "var(--ob-edge-strong)"}`,
              }}
            >
              <Glyph name={premium ? "check" : "sparkle"} size={13} strokeWidth={2.2} /> 최고 품질
            </button>
            <GhostButton onClick={() => setLoadOpen(true)}>
              <Glyph name="layers" size={14} /> 저장된 프로젝트
            </GhostButton>
          </div>
        }
      />

      {headerSlot}

      {/* 예제 */}
      <div style={{ marginTop: 22, marginBottom: 20 }}>
        <Label>빠른 시작 (예제로 채우기)</Label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {BRIEF_PRESETS.map((p) => (
            <GhostButton key={p.id} onClick={() => loadPreset(p.id)}>
              {p.label}
            </GhostButton>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 860 }}>
        <Field label="제목">
          <input style={inputStyle} value={title} placeholder="예: MIDNIGHT BLOOM" onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <Field label="무엇을 만들고 싶나요?">
          <textarea
            style={{ ...inputStyle, minHeight: 140, resize: "vertical", lineHeight: 1.6 }}
            value={prompt}
            placeholder={"만들고 싶은 영상을 편하게 설명해 주세요.\n예) 도시의 밤, 한 여인이 향수 한 방울로 군중 속에서 자신만의 빛을 찾는 30초 광고. 네온·세련되고 관능적인 톤. 제품 클로즈업과 브랜드 로고로 마무리."}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <TagField
          label="참고자료 (선택) — 레퍼런스 작품·룩·분위기"
          values={refs}
          onChange={setRefs}
          placeholder="예: Blade Runner 2049 lighting"
        />

        <Field label="포맷">
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {FORMATS.map((f) => (
              <Chip key={f.id || "auto"} active={format === f.id} onClick={() => setFormat(f.id)}>
                {f.label}
              </Chip>
            ))}
          </div>
          {tpl && (
            <div style={{ fontSize: 12, color: "var(--ob-muted)", marginTop: 8 }}>
              {tpl.label} · 평균 {tpl.avgShotLenSec}초 컷 · {tpl.pacing}
            </div>
          )}
        </Field>

        {studio === "motion" && (
          <>
            <Field label="브랜드명">
              <input style={inputStyle} value={brandName} placeholder="예: 원코치" onChange={(e) => setBrandName(e.target.value)} />
            </Field>
            <Field label="로고 (이미지 URL 또는 파일 경로 · 선택)">
              <input style={inputStyle} value={logoSrc} placeholder="https://… 또는 /Users/…/logo.png" onChange={(e) => setLogoSrc(e.target.value)} />
            </Field>
          </>
        )}
      </div>

      {/* 액션 — 인라인 (플로팅 아님) */}
      <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 12, maxWidth: 860 }}>
        <PrimaryButton onClick={generate} disabled={!canPlan} style={{ padding: "0 26px", minHeight: 46 }}>
          <IconSparkles size={16} />
          {planning ? "기획 만드는 중…" : "기획안 만들기"}
        </PrimaryButton>
        {(!title.trim() || !prompt.trim()) && (
          <span style={{ fontSize: 12.5, color: "var(--ob-muted)" }}>제목과 설명을 적어 주세요.</span>
        )}
      </div>

      <LoadProjectModal
        open={loadOpen}
        onClose={() => setLoadOpen(false)}
        onLoad={(prod) => {
          setLoadOpen(false);
          onLoad?.(prod);
        }}
      />
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ob-ink-soft)", marginBottom: 8 }}>{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 14px",
  borderRadius: 12,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  color: "var(--ob-ink)",
  fontSize: 14.5,
  fontFamily: "var(--font-body, inherit)",
  outline: "none",
};

function TagField({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [over, setOver] = useState(false);

  function addMany(items: string[]) {
    const next = [...values];
    for (const raw of items) {
      const v = raw.trim();
      if (v && !next.includes(v)) next.push(v);
    }
    onChange(next);
  }
  function addDraft() {
    addMany([draft]);
    setDraft("");
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const items: string[] = [];
    if (e.dataTransfer.files?.length) {
      for (const f of Array.from(e.dataTransfer.files)) items.push(f.name);
    }
    const txt = e.dataTransfer.getData("text");
    if (txt) items.push(...txt.split(/\r?\n/));
    addMany(items);
  }

  return (
    <Field label={label}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        style={{
          border: `1.5px dashed ${over ? "var(--ob-accent)" : "var(--ob-edge-strong)"}`,
          background: over ? "var(--ob-accent-soft)" : "var(--ob-surface)",
          borderRadius: 14,
          padding: 12,
          transition: "all 0.14s",
        }}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...inputStyle, background: "var(--ob-paper)" }}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
            }}
          />
          <GhostButton onClick={addDraft} style={{ flexShrink: 0 }}>
            <IconPlus size={14} />
          </GhostButton>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: over ? "var(--ob-accent-text)" : "var(--ob-muted)" }}>
          <Glyph name="image" size={13} />
          이미지·파일·링크를 여기로 끌어다 놓아도 돼요
        </div>
        {values.length > 0 && (
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>
            {values.map((v) => (
              <span
                key={v}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 12px",
                  borderRadius: 999, fontSize: 12.5, background: "var(--ob-paper)",
                  color: "var(--ob-ink-soft)", border: "1px solid var(--ob-edge)",
                }}
              >
                {v}
                <button onClick={() => onChange(values.filter((x) => x !== v))} aria-label="삭제" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ob-muted)", display: "inline-flex", padding: 0 }}>
                  <IconClose size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}
