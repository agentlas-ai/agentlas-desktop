// Oberon — Step 01 기획안. BYOK CLI가 쓴 트리트먼트·대본·에셋리스트. 사람이 읽고 수정·승인.
// GATE A: 이걸 승인해야 어떤 이미지/영상 생성도 시작되지 않는다.
"use client";
import { useState } from "react";
import {
  FORMAT_DEFAULT_DURATION,
  GENRE_TEMPLATES,
  type AspectRatio,
  type FilmBrief,
  type FilmFormat,
  type FilmProduction,
  type Genre,
  type ModelSettings,
} from "@/lib/oberon";
import { Glyph, OberonBadge, type GlyphName } from "./icons";
import { Card, Chip, GhostButton, PanelHead, PrimaryButton, Tag } from "./ui";

const ASSET_PREFIX: Record<string, string> = {
  character: "CHAR",
  location: "LOC",
  wardrobe: "WARD",
  prop: "PROP",
  vehicle: "VEH",
  style: "STYLE",
};

const FORMATS: { id: FilmFormat; label: string }[] = [
  { id: "social_short", label: "소셜 숏폼" },
  { id: "commercial_30", label: "30초 광고" },
  { id: "commercial_60", label: "60초 광고" },
  { id: "trailer", label: "트레일러" },
  { id: "music_video", label: "뮤직비디오" },
  { id: "short_drama", label: "단편 드라마" },
  { id: "cinematic_short", label: "시네마틱 단편" },
];
const GENRES: Genre[] = ["commercial", "drama", "action", "thriller", "romance", "scifi", "documentary", "fantasy", "horror", "comedy"];
const GENRE_KO: Record<Genre, string> = { commercial: "광고", drama: "드라마", action: "액션", thriller: "스릴러", romance: "로맨스", scifi: "SF", documentary: "다큐", fantasy: "판타지", horror: "호러", comedy: "코미디" };
const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1", "2.39:1", "4:5"];
const TONE_PALETTE = ["cinematic", "warm", "cold", "neon", "sleek", "epic", "tense", "melancholic", "energetic", "sensual", "gritty", "bright"];

export function PlanStep({
  production,
  model,
  approved,
  planning,
  onApprove,
  onPatchBrief,
  onReplan,
}: {
  production: FilmProduction;
  model?: ModelSettings;
  approved: boolean;
  planning?: boolean;
  onApprove: () => void;
  onPatchBrief?: (patch: Partial<FilmBrief>) => void;
  onReplan?: () => void;
}) {
  const [logline, setLogline] = useState(production.brief.logline);
  const [treatment, setTreatment] = useState(
    production.brief.synopsis ||
      `${production.brief.title}. ${production.brief.logline} — ${production.brief.tone.join(", ")} 톤의 ${production.stats.totalDurationSec}초 ${formatLabel(production.brief.format)}.`,
  );
  const planningRun = production.planningRun;
  const cli = planningRun?.runtimeLabel || model?.textRuntimeLabel || "BYOK CLI";
  const usedCli = planningRun?.ok === true;

  return (
    <div style={panelStyle}>
      <PanelHead
        eyebrow="Step 01 · 기획안"
        title="기획안 확인하기"
        subtitle={
          usedCli
            ? `${cli}가 제목·설명을 바탕으로 기획을 잡았어요. 읽어보고 고친 뒤 승인하면 다음 단계로 넘어가요. 승인 전에는 비용이 드는 생성이 시작되지 않습니다.`
            : "CLI 기획을 실행할 수 없어 로컬 플래너로 기본 기획안을 만들었습니다. 승인 전에는 비용이 드는 생성이 시작되지 않습니다."
        }
        icon={<Glyph name="plan" size={18} />}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: usedCli ? "var(--ob-success)" : "var(--ob-warning)" }}>
              <OberonBadge name="cli" size={22} glyphSize={13} /> {usedCli ? `via ${cli}` : "local fallback"}
            </span>
            {!approved && onReplan && (
              <GhostButton onClick={onReplan} style={{ minHeight: 38 }}>
                <Glyph name="sparkle" size={14} /> {planning ? "생성 중…" : "AI로 다시 생성"}
              </GhostButton>
            )}
          </div>
        }
      />

      {planningRun && !planningRun.ok && (
        <Card style={{ padding: 14, marginBottom: 16, background: "var(--ob-surface)" }}>
          <div style={{ fontSize: 12.5, color: "var(--ob-warning)", fontWeight: 700, marginBottom: 4 }}>CLI 기획 미완료</div>
          <div style={{ fontSize: 12, color: "var(--ob-muted)", lineHeight: 1.55 }}>
            {planningRun.error || planningRun.warnings[0] || "CLI planner failed. 로컬 플래너 결과를 표시합니다."}
          </div>
        </Card>
      )}

      {/* 에이전트가 잡은 제작 설정 — 확인·수정 */}
      <SettingsCard brief={production.brief} disabled={approved} onPatchBrief={onPatchBrief} />

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
        {/* 좌: 트리트먼트 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="로그라인">
            <input style={input} value={logline} onChange={(e) => setLogline(e.target.value)} onBlur={() => onPatchBrief?.({ logline })} disabled={approved} />
          </Field>
          <Field label="트리트먼트">
            <textarea style={{ ...input, minHeight: 120, resize: "vertical", lineHeight: 1.6 }} value={treatment} onChange={(e) => setTreatment(e.target.value)} onBlur={() => onPatchBrief?.({ synopsis: treatment })} disabled={approved} />
          </Field>

          <Field label={`장면 구성 — ${production.stats.beatCount}개 비트`}>
            <Card style={{ padding: 12, maxHeight: 280, overflowY: "auto" }}>
              {production.sequences.map((seq) => (
                <div key={seq.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ob-ink)", marginBottom: 5 }}>{seq.title} <span style={{ color: "var(--ob-muted,#9aa0ad)", fontWeight: 500 }}>· {seq.purpose}</span></div>
                  {production.scenes.filter((s) => seq.sceneIds.includes(s.id)).map((sc) =>
                    production.beats.filter((b) => sc.beatIds.includes(b.id)).map((b) => (
                      <div key={b.id} style={{ display: "flex", gap: 8, fontSize: 11.5, color: "var(--ob-ink-soft,#3a3d47)", padding: "2px 0" }}>
                        <span style={{ fontWeight: 700, minWidth: 64 }}>{b.name}</span>
                        <span style={{ color: "var(--ob-muted)", fontSize: 11 }}>{b.emotion}</span>
                        <span style={{ color: "var(--ob-muted,#9aa0ad)", fontSize: 10.5 }}>{b.shotIds.length}샷</span>
                      </div>
                    )),
                  )}
                </div>
              ))}
            </Card>
          </Field>
        </div>

        {/* 우: 에셋 리스트 (stable IDs) */}
        <div>
          <Field label="등장 요소 (인물·배경·소품)">
            <Card style={{ padding: 12 }}>
              <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--ob-muted,#6b7280)", lineHeight: 1.5 }}>
                기획에서 뽑아낸 인물·배경·소품이에요. 03 단계에서 참고 이미지로 만들어지고, 모든 컷이 이걸 참고합니다.
              </p>
              {production.bible.references.map((r) => {
                const id = `${ASSET_PREFIX[r.kind] ?? "ASSET"}_${r.id.split("_").pop()}`;
                return (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px dashed var(--ob-edge,#eff0f3)" }}>
                    <OberonBadge name={catGlyph(r.kind)} color={catColor(r.kind)} size={22} glyphSize={12} />
                    <code style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--ob-ink,#16171d)" }}>{id}</code>
                    <span style={{ fontSize: 11.5, color: "var(--ob-ink-soft,#3a3d47)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                    <Tag>{r.kind}</Tag>
                  </div>
                );
              })}
            </Card>
          </Field>
        </div>
      </div>

      <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 12 }}>
        {approved ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--ob-success)" }}>
            <Glyph name="check" size={16} strokeWidth={2.4} /> 기획 승인됨 — 스토리보드 단계가 열렸습니다.
          </span>
        ) : (
          <PrimaryButton onClick={onApprove}>
            <Glyph name="check" size={15} strokeWidth={2.4} /> 기획 승인하고 스토리보드로
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

function SettingsCard({ brief, disabled, onPatchBrief }: { brief: FilmBrief; disabled?: boolean; onPatchBrief?: (p: Partial<FilmBrief>) => void }) {
  const tpl = GENRE_TEMPLATES[brief.format];
  function toggleTone(t: string) {
    if (disabled) return;
    const next = brief.tone.includes(t) ? brief.tone.filter((x) => x !== t) : [...brief.tone, t];
    onPatchBrief?.({ tone: next });
  }
  return (
    <Card style={{ padding: 18, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 15 }}>
        <OberonBadge name="sparkle" tone="accent" size={24} glyphSize={13} />
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ob-ink)" }}>제작 설정 — 에이전트가 잡았어요</div>
          <div style={{ fontSize: 12, color: "var(--ob-muted)" }}>확인하고 바꾸세요. 포맷·길이를 바꿨다면 위 “AI로 다시 생성”을 누르면 반영됩니다.</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="포맷">
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {FORMATS.map((f) => (
              <Chip key={f.id} active={brief.format === f.id} onClick={() => !disabled && onPatchBrief?.({ format: f.id, durationSec: FORMAT_DEFAULT_DURATION[f.id] })}>
                {f.label}
              </Chip>
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr", gap: 12 }}>
          <Field label="장르">
            <select style={input} value={brief.genre} disabled={disabled} onChange={(e) => onPatchBrief?.({ genre: e.target.value as Genre })}>
              {GENRES.map((g) => <option key={g} value={g}>{GENRE_KO[g]}</option>)}
            </select>
          </Field>
          <Field label="화면비">
            <select style={input} value={brief.aspect} disabled={disabled} onChange={(e) => onPatchBrief?.({ aspect: e.target.value as AspectRatio })}>
              {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label={`길이 — ${brief.durationSec}초 · 평균 ${tpl.avgShotLenSec}초 컷`}>
            <input type="range" min={10} max={600} step={5} value={brief.durationSec} disabled={disabled} onChange={(e) => onPatchBrief?.({ durationSec: Number(e.target.value) })} style={{ width: "100%", accentColor: "var(--ob-accent)", marginTop: 8 }} />
          </Field>
        </div>
        <Field label="톤 & 무드">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TONE_PALETTE.map((t) => (
              <Chip key={t} active={brief.tone.includes(t)} accentSelect onClick={() => toggleTone(t)}>{t}</Chip>
            ))}
          </div>
        </Field>
        <Field label="주 배경">
          <input style={input} value={brief.setting} disabled={disabled} placeholder="예: 심야의 네온 도시 거리" onChange={(e) => onPatchBrief?.({ setting: e.target.value })} />
        </Field>
      </div>
    </Card>
  );
}

function catGlyph(kind: string): GlyphName {
  return (({ character: "character", location: "background", wardrobe: "style", prop: "prop", vehicle: "prop", style: "style" } as Record<string, GlyphName>)[kind] ?? "assets");
}
function catColor(kind: string): string {
  return ({ character: "var(--ob-ink-soft)", location: "var(--ob-ink-soft)", wardrobe: "var(--ob-ink-soft)", prop: "var(--ob-ink-soft)", vehicle: "var(--ob-ink-soft)", style: "var(--ob-ink-soft)" } as Record<string, string>)[kind] ?? "var(--ob-ink-soft)";
}
function formatLabel(f: string): string {
  return ({ commercial_30: "광고", commercial_60: "광고", trailer: "트레일러", short_drama: "드라마", music_video: "뮤직비디오", cinematic_short: "단편", social_short: "숏폼" } as Record<string, string>)[f] ?? "영상";
}

const panelStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "10px 13px",
  borderRadius: 8,
  border: "1px solid var(--ob-edge-strong)",
  background: "var(--ob-paper)",
  color: "var(--ob-ink)",
  fontSize: 14,
  lineHeight: 1.5,
  outline: "none",
  fontFamily: "inherit",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ob-ink-soft)", marginBottom: 7 }}>{label}</div>
      {children}
    </div>
  );
}
