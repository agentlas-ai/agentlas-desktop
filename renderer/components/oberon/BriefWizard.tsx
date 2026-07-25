// Oberon — Step 00 시작. 단순하게: 제목 + 만들고 싶은 영상(자유 프롬프트) + 참고자료.
// 나머지(장르·톤·캐릭터·설정·샷)는 에이전트가 추론해 기획안(01) 단계에서 채워두고, 거기서 수정/승인.
"use client";
import { useState, type ReactNode } from "react";
import {
  GENRE_TEMPLATES,
  getBriefPresets,
  inferBriefFromPrompt,
  judgeBriefFromPrompt,
  taxonomyText,
  type FilmBrief,
  type FilmFormat,
  type FilmProduction,
  type OberonStudio,
} from "@/lib/oberon";
import { IconPlus, IconClose, IconSparkles } from "@/components/Icon";
import { useT, type Locale } from "@/lib/i18n";
import { Chip, GhostButton, PanelHead, PrimaryButton } from "./ui";
import { Glyph } from "./icons";
import { LoadProjectModal } from "./LoadProjectModal";

const FORMATS: { id: FilmFormat | ""; label: string; labelEn: string }[] = [
  { id: "", label: "자동 감지", labelEn: "Auto-detect" },
  { id: "motion_graphics_30", label: "30초 모션그래픽", labelEn: "30s Motion Graphics" },
  { id: "motion_graphics_60", label: "60초 모션그래픽", labelEn: "60s Motion Graphics" },
  { id: "social_short", label: "소셜 숏폼", labelEn: "Social Short" },
  { id: "commercial_30", label: "30초 광고", labelEn: "30s Commercial" },
  { id: "commercial_60", label: "60초 광고", labelEn: "60s Commercial" },
  { id: "trailer", label: "트레일러", labelEn: "Trailer" },
  { id: "music_video", label: "뮤직비디오", labelEn: "Music Video" },
  { id: "short_drama", label: "단편 드라마", labelEn: "Short Drama" },
  { id: "cinematic_short", label: "시네마틱 단편", labelEn: "Cinematic Short" },
];

export function BriefWizard({
  initial,
  studio,
  onPlan,
  planning,
  openCrabReady = false,
  useOpenCrab = false,
  onUseOpenCrabChange,
  onLoad,
  headerSlot,
}: {
  initial?: FilmBrief;
  studio?: OberonStudio | null;
  onPlan: (brief: FilmBrief, premium: boolean) => void;
  planning: boolean;
  openCrabReady?: boolean;
  useOpenCrab?: boolean;
  onUseOpenCrabChange?: (value: boolean) => void;
  onLoad?: (prod: FilmProduction) => void;
  headerSlot?: ReactNode;
}) {
  const { locale } = useT();
  const presets = getBriefPresets(locale);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.synopsis || initial?.logline || "");
  const [refs, setRefs] = useState<string[]>(initial?.visualReferences ?? []);
  const [format, setFormat] = useState<FilmFormat | "">(initial?.format ?? "");
  const [premium, setPremium] = useState(true);
  const [loadOpen, setLoadOpen] = useState(false);
  // 모션그래픽 포맷 전용 입력 — 고객 브랜드/로고.
  const [brandName, setBrandName] = useState(initial?.brandOrProduct ?? "");
  const [logoSrc, setLogoSrc] = useState(initial?.logoSource ?? "");

  function loadPreset(id: string) {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setTitle(p.brief.title);
    setPrompt(p.brief.synopsis || p.brief.logline);
    setRefs(p.brief.visualReferences);
    setFormat(p.brief.format);
  }

  const canPlan = !!title.trim() && !!prompt.trim() && !planning;
  const tpl = format ? GENRE_TEMPLATES[format] : null;
  const isMotionFormat = format === "motion_graphics_30" || format === "motion_graphics_60";

  async function generate() {
    // The judged inference decides format/genre/tone/setting before the flow
    // starts; an explicit user-picked format is closed-form, and the keyword
    // tables remain the labeled fallback when no bridge/model is available.
    const base = await judgeBriefFromPrompt({ title, prompt, references: refs, format, locale })
      .catch(() => inferBriefFromPrompt({ title, prompt, references: refs, format, locale }));
    const brief =
      isMotionFormat
        ? { ...base, brandOrProduct: brandName.trim() || base.brandOrProduct, logoSource: logoSrc.trim() || undefined }
        : base;
    onPlan(brief, premium);
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 56px" }}>
      <PanelHead
        eyebrow={locale === "ko" ? "제작 · 시작" : "Production · Start"}
        title={
          locale === "ko"
            ? "무엇을 만들까요?"
            : "What should we make?"
        }
        subtitle={
          locale === "ko"
            ? "제목과 만들고 싶은 영상을 자유롭게 적으면, 에이전트가 장르·톤·캐릭터·샷을 알아서 잡습니다. 다음 단계에서 확인하고 고치면 돼요."
            : "Write a title and freely describe the video you want — the agent will work out genre, tone, characters, and shots. You'll review and adjust it in the next step."
        }
        icon={<Glyph name="sparkle" size={18} />}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setPremium((v) => !v)}
              title={
                locale === "ko"
                  ? "켜면 Seedance·Veo 등 최고 화질 엔진을 우선 사용합니다 (비용 ↑)"
                  : "When on, prioritizes top-quality engines like Seedance and Veo (higher cost)"
              }
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, minHeight: 38, padding: "0 14px",
                borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                background: premium ? "var(--ob-accent-soft)" : "var(--ob-surface)",
                color: premium ? "var(--ob-accent-text)" : "var(--ob-ink-soft)",
                border: `1px solid ${premium ? "transparent" : "var(--ob-edge-strong)"}`,
              }}
            >
              <Glyph name={premium ? "check" : "sparkle"} size={13} strokeWidth={2.2} /> {locale === "ko" ? "최고 품질" : "Best Quality"}
            </button>
            <GhostButton onClick={() => setLoadOpen(true)}>
              <Glyph name="layers" size={14} /> {locale === "ko" ? "저장된 프로젝트" : "Saved Projects"}
            </GhostButton>
          </div>
        }
      />

      {headerSlot}

      {/* 예제 */}
      <div style={{ marginTop: 22, marginBottom: 20 }}>
        <Label>{locale === "ko" ? "빠른 시작 (예제로 채우기)" : "Quick Start (fill from an example)"}</Label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {presets.map((p) => (
            <GhostButton key={p.id} onClick={() => loadPreset(p.id)}>
              {p.label}
            </GhostButton>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 860 }}>
        <Field label={locale === "ko" ? "제목" : "Title"}>
          <input style={inputStyle} value={title} placeholder="e.g. MIDNIGHT BLOOM" onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <Field label={locale === "ko" ? "무엇을 만들고 싶나요?" : "What do you want to make?"}>
          <textarea
            style={{ ...inputStyle, minHeight: 140, resize: "vertical", lineHeight: 1.6 }}
            value={prompt}
            placeholder={
              locale === "ko"
                ? "만들고 싶은 영상을 편하게 설명해 주세요.\n예) 도시의 밤, 한 여인이 향수 한 방울로 군중 속에서 자신만의 빛을 찾는 30초 광고. 네온·세련되고 관능적인 톤. 제품 클로즈업과 브랜드 로고로 마무리."
                : "Describe the video you want in your own words.\nExample: A 30-second ad where, in the city at night, a woman finds her own light in the crowd with a single drop of perfume. Neon, sleek, sensual tone. Ends on a product close-up and the brand logo."
            }
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <TagField
          label={locale === "ko" ? "참고자료 (선택) — 레퍼런스 작품·룩·분위기" : "References (optional) — reference works, looks, moods"}
          values={refs}
          onChange={setRefs}
          placeholder="e.g. Blade Runner 2049 lighting"
          locale={locale}
        />

        <Field label={locale === "ko" ? "포맷" : "Format"}>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {FORMATS.map((f) => (
              <Chip key={f.id || "auto"} active={format === f.id} onClick={() => setFormat(f.id)}>
                {locale === "ko" ? f.label : f.labelEn}
              </Chip>
            ))}
          </div>
          {tpl && (
            <div style={{ fontSize: 12, color: "var(--ob-muted)", marginTop: 8 }}>
              {taxonomyText(tpl.label, tpl.labelEn, locale)} ·{" "}
              {locale === "ko" ? `평균 ${tpl.avgShotLenSec}초 컷` : `avg ${tpl.avgShotLenSec}s cuts`} ·{" "}
              {taxonomyText(tpl.pacing, tpl.pacingEn, locale)}
            </div>
          )}
        </Field>

        {isMotionFormat && (
          <>
            <Field label={locale === "ko" ? "브랜드명" : "Brand name"}>
              <input style={inputStyle} value={brandName} placeholder={locale === "ko" ? "예: 원코치" : "e.g. Oncoach"} onChange={(e) => setBrandName(e.target.value)} />
            </Field>
            <Field label={locale === "ko" ? "로고 (이미지 URL 또는 파일 경로 · 선택)" : "Logo (image URL or file path · optional)"}>
              <input style={inputStyle} value={logoSrc} placeholder="https://… or /Users/…/logo.png" onChange={(e) => setLogoSrc(e.target.value)} />
            </Field>
          </>
        )}
      </div>

      {/* 액션 — 인라인 (플로팅 아님) */}
      <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 12, maxWidth: 860 }}>
        <PrimaryButton onClick={generate} disabled={!canPlan} style={{ padding: "0 26px", minHeight: 46 }}>
          <IconSparkles size={16} />
          {planning ? (locale === "ko" ? "기획 만드는 중…" : "Drafting the plan…") : locale === "ko" ? "기획안 만들기" : "Create Plan"}
        </PrimaryButton>
        {openCrabReady && onUseOpenCrabChange && (
          <button
            type="button"
            onClick={() => onUseOpenCrabChange(!useOpenCrab)}
            title={
              locale === "ko"
                ? "제목과 기획 요약(로그라인·대상·톤·배경·필수요소)을 OpenCrab에 검색합니다. 로컬 경로가 포함된 값과 로고 필드는 보내지 않습니다."
                : "Searches OpenCrab with the title and planning summary (logline, audience, tone, setting, and must-haves). Values containing local paths and the logo field are omitted."
            }
            style={{
              minHeight: 42,
              padding: "0 14px",
              borderRadius: 8,
              border: `1px solid ${useOpenCrab ? "var(--ob-accent)" : "var(--ob-edge-strong)"}`,
              background: useOpenCrab ? "var(--ob-accent-soft)" : "var(--ob-surface)",
              color: useOpenCrab ? "var(--ob-accent-text)" : "var(--ob-ink-soft)",
              fontSize: 12.5,
              fontWeight: 650,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Glyph name={useOpenCrab ? "check" : "layers"} size={13} />
            {locale === "ko" ? "OpenCrab 근거" : "OpenCrab evidence"} {useOpenCrab ? "✓" : "○"}
          </button>
        )}
        {(!title.trim() || !prompt.trim()) && (
          <span style={{ fontSize: 12.5, color: "var(--ob-muted)" }}>
            {locale === "ko" ? "제목과 설명을 적어 주세요." : "Enter a title and description."}
          </span>
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
  borderRadius: 8,
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
  locale,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  locale: Locale;
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
          borderRadius: 8,
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
          {locale === "ko" ? "이미지·파일·링크를 여기로 끌어다 놓아도 돼요" : "You can also drag images, files, or links here"}
        </div>
        {values.length > 0 && (
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>
            {values.map((v) => (
              <span
                key={v}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 12px",
                  borderRadius: 7, fontSize: 12.5, background: "var(--ob-paper)",
                  color: "var(--ob-ink-soft)", border: "1px solid var(--ob-edge)",
                }}
              >
                {v}
                <button
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  aria-label={locale === "ko" ? "삭제" : "Remove"}
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ob-muted)", display: "inline-flex", padding: 0 }}
                >
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
