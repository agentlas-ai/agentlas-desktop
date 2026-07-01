// Oberon — Shot Board. 비트를 커버리지 문법으로 분해한 샷 카드 그리드.
// "수백~수천 샷을 병렬로" 보여주는 감독실의 핵심 화면.
"use client";
import { useMemo, useState } from "react";
import {
  ANGLES,
  LENSES,
  MOVEMENTS,
  TRANSITIONS,
  VIDEO_PROVIDERS,
  providerById,
  summarizeContinuity,
  taxonomyText,
  threadContinuity,
  type FilmProduction,
  type ShotSpec,
} from "@/lib/oberon";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n";
import { IconChevronDown, IconChevronRight, IconLayers, IconRoute, IconRefresh, IconTrash } from "@/components/Icon";
import { CHARCOAL, Card, Chip, PanelHead, Tag, aspectCss, formatCost } from "./ui";

export function ShotBoard({
  production,
  editable,
  onUpdateShots,
}: {
  production: FilmProduction;
  editable?: boolean;
  onUpdateShots?: (mutate: (shots: ShotSpec[]) => ShotSpec[]) => void;
}) {
  const { locale } = useT();
  const [sceneFilter, setSceneFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const scenes = production.scenes;
  const shots = useMemo(
    () => (sceneFilter === "all" ? production.shots : production.shots.filter((s) => s.sceneId === sceneFilter)),
    [production.shots, sceneFilter],
  );

  // 연속성 메모리 스레드 — 씬별로 메모리가 이어지는지 한눈에. (목표 4)
  const continuitySpans = useMemo(() => {
    const chain = threadContinuity({
      shots: production.shots,
      scenes: production.scenes,
      beats: production.beats,
      bible: production.bible,
      brief: production.brief,
      locale,
    });
    return summarizeContinuity(production.shots, production.scenes, chain);
  }, [production.shots, production.scenes, production.beats, production.bible, production.brief, locale]);

  function swapProvider(shotId: string) {
    onUpdateShots?.((all) => {
      const ids = VIDEO_PROVIDERS.map((p) => p.id);
      return all.map((s) => {
        if (s.shotId !== shotId) return s;
        const cur = ids.indexOf(s.providerId);
        const nextId = ids[(cur + 1) % ids.length];
        const prov = providerById(nextId);
        return { ...s, providerId: nextId, estCostUsd: Number((prov?.approxCostUsd ?? s.estCostUsd).toFixed(2)) };
      });
    });
  }
  function deleteShot(shotId: string) {
    onUpdateShots?.((all) => (all.length > 1 ? all.filter((s) => s.shotId !== shotId) : all));
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 40px" }}>
      <PanelHead
        eyebrow={locale === "ko" ? "Step 02 · 스토리보드" : "Step 02 · Storyboard"}
        title={locale === "ko" ? "장면을 컷으로 나눴어요" : "Scenes Split into Shots"}
        subtitle={
          locale === "ko"
            ? `한 장면을 여러 각도의 컷 ${production.stats.shotCount}개로 나눴습니다. 각 컷의 카메라·엔진·비용을 확인하세요.${editable ? " 엔진을 바꾸거나 필요 없는 컷을 지울 수 있어요." : ""}`
            : `Each scene has been split into ${production.stats.shotCount} shots from different angles. Check the camera, engine, and cost for each shot.${editable ? " You can swap the engine or delete shots you don't need." : ""}`
        }
        icon={<IconLayers size={18} />}
      />

      {/* 연속성 메모리 스레드 (목표 4) */}
      <ContinuityThread spans={continuitySpans} locale={locale} />

      {/* 씬 필터 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        <Chip active={sceneFilter === "all"} onClick={() => setSceneFilter("all")}>
          {locale === "ko" ? "전체" : "All"} {production.stats.shotCount}
        </Chip>
        {scenes.map((sc) => {
          const count = production.shots.filter((s) => s.sceneId === sc.id).length;
          return (
            <Chip key={sc.id} active={sceneFilter === sc.id} onClick={() => setSceneFilter(sc.id)} title={sc.heading}>
              {sc.id.toUpperCase()} · {count}
            </Chip>
          );
        })}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        {shots.map((shot) => (
          <ShotCard
            key={shot.shotId}
            shot={shot}
            aspect={production.brief.aspect}
            editable={editable}
            onSwapProvider={() => swapProvider(shot.shotId)}
            onDelete={() => deleteShot(shot.shotId)}
            expanded={expanded === shot.shotId}
            onToggle={() => setExpanded((e) => (e === shot.shotId ? null : shot.shotId))}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}

function ShotCard({
  shot,
  aspect,
  editable,
  onSwapProvider,
  onDelete,
  expanded,
  onToggle,
  locale,
}: {
  shot: ShotSpec;
  aspect?: string;
  editable?: boolean;
  onSwapProvider?: () => void;
  onDelete?: () => void;
  expanded: boolean;
  onToggle: () => void;
  locale: Locale;
}) {
  const provider = providerById(shot.providerId);

  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      {/* 컨택트시트 프레임 */}
      <div
        style={{
          position: "relative",
          aspectRatio: aspectCss(aspect),
          background: CHARCOAL,
          borderBottom: "1px solid var(--ob-edge)",
        }}
      >
        <div style={{ position: "absolute", top: 7, left: 8, display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600, color: "rgba(255,255,255,0.78)", letterSpacing: 0.3 }}>{shot.camera.size}</span>
          {shot.firstFrameAssetId && (
            <span title={locale === "ko" ? "실제 첫 프레임 생성 완료" : "Actual first frame generated"} style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.78)" }}>KF</span>
          )}
          {!shot.firstFrameAssetId && shot.requiresKeyframe && (
            <span title={locale === "ko" ? "첫 프레임 생성 필요" : "First frame needs to be generated"} style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.5)" }}>KF?</span>
          )}
          {shot.speed && shot.speed !== "real" && (
            <span title={locale === "ko" ? "속도 연출" : "Speed treatment"} style={{ fontSize: 8, fontFamily: "var(--font-mono)", fontWeight: 700, color: "#FFD27A", letterSpacing: 0.4 }}>{speedLabel(shot.speed)}</span>
          )}
          {shot.chainFromShotId && (
            <span
              title={
                locale === "ko"
                  ? `연속성 체인 — ${shot.chainFromShotId}의 마지막 프레임에서 이어짐`
                  : `Continuity chain — continues from ${shot.chainFromShotId}'s last frame`
              }
              style={{ display: "inline-flex", color: "rgba(120,200,255,0.95)" }}
            >
              <IconRoute size={9} />
            </span>
          )}
        </div>
        <div style={{ position: "absolute", top: 7, right: 8, fontSize: 10, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.7)", fontVariantNumeric: "tabular-nums" }}>
          {shot.durationSec}s
        </div>
        <div style={{ position: "absolute", bottom: 7, left: 8, fontSize: 9, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.52)", fontVariantNumeric: "tabular-nums" }}>
          {shot.shotId}
        </div>
      </div>

      {/* 본문 */}
      <div style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 9, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 500, color: "var(--ob-ink-soft)" }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ob-ink-soft)" }} />
            {provider?.name ?? shot.providerId}
          </span>
          <span style={{ fontSize: 11, color: "var(--ob-muted)" }}>· {modeLabel(shot.providerMode)}</span>
        </div>

        {/* 7차원 스코어드 라우팅 결정 (점수 + 박빙 플래그, 전체 결정로그는 hover) */}
        {shot.routing && (
          <div
            title={shot.routing.log.join("\n")}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--ob-muted)" }}
          >
            <span style={{ padding: "1px 6px", borderRadius: 5, background: "var(--ob-edge)", color: "var(--ob-ink-soft)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {locale === "ko" ? `라우팅 ${shot.routing.total}점` : `Routing ${shot.routing.total} pts`}
            </span>
            {shot.routing.runnerUpId != null && typeof shot.routing.margin === "number" && shot.routing.margin < 4 && (
              <span
                style={{ color: "var(--ob-accent-text)", fontWeight: 600 }}
                title={
                  locale === "ko"
                    ? `2위 ${providerById(shot.routing.runnerUpId)?.name ?? shot.routing.runnerUpId} ${shot.routing.runnerUpTotal}점 (격차 ${shot.routing.margin})`
                    : `Runner-up ${providerById(shot.routing.runnerUpId)?.name ?? shot.routing.runnerUpId} ${shot.routing.runnerUpTotal} pts (margin ${shot.routing.margin})`
                }
              >
                {locale === "ko" ? "박빙" : "Close call"}
              </span>
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{shot.routing.reason}</span>
          </div>
        )}

        <div style={{ fontSize: 13, color: "var(--ob-ink)", lineHeight: 1.5 }}>{shot.action}</div>

        {shot.dialogue && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 10, borderLeft: "2px solid var(--ob-edge-strong)" }}>
            <div style={{ fontSize: 13, color: "var(--ob-ink-soft)", fontStyle: "italic" }}>“{shot.dialogue}”</div>
            {shot.dialogueLine && (
              <div style={{ fontSize: 10.5, color: "var(--ob-muted)" }}>
                {shot.dialogueLine.speaker} · {deliveryLabel(shot.dialogueLine.delivery, locale)}
                {shot.dialogueLine.voiceover ? " · V.O." : ""}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <Tag>{taxonomyText(ANGLES[shot.camera.angle].ko, ANGLES[shot.camera.angle].koEn, locale)}</Tag>
          <Tag>{taxonomyText(MOVEMENTS[shot.camera.movement].ko, MOVEMENTS[shot.camera.movement].koEn, locale)}</Tag>
          <Tag>{taxonomyText(LENSES[shot.camera.lens].ko, LENSES[shot.camera.lens].koEn, locale)}</Tag>
        </div>

        {/* 연속성 — 씬 시작 / 적용 규칙 (목표 4) */}
        {(shot.isSceneOpening || (shot.appliedContinuityRules?.length ?? 0) > 0) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--ob-muted)" }}>
            {shot.isSceneOpening ? (
              <span style={{ fontWeight: 700, color: "var(--ob-accent-text)" }}>● {locale === "ko" ? "씬 시작" : "Scene start"}</span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <IconRoute size={10} /> {locale === "ko" ? "이어받음" : "Continued"}
              </span>
            )}
            {(shot.appliedContinuityRules?.length ?? 0) > 0 && (
              <span title={shot.appliedContinuityRules!.join("\n")} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                · {locale === "ko" ? `${shot.appliedContinuityRules!.length}개 연속성 규칙` : `${shot.appliedContinuityRules!.length} continuity rules`}
              </span>
            )}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--ob-muted)" }}>
          <span title={locale === "ko" ? "전환" : "Transition"}>
            {taxonomyText(TRANSITIONS[shot.transitionIn].ko, TRANSITIONS[shot.transitionIn].koEn, locale)} →{" "}
            {taxonomyText(TRANSITIONS[shot.transitionOut].ko, TRANSITIONS[shot.transitionOut].koEn, locale)}
          </span>
          <span style={{ marginLeft: "auto", color: "var(--ob-ink)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCost(shot.estCostUsd)}</span>
        </div>

        {editable && (
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button onClick={onSwapProvider} title={locale === "ko" ? "영상 엔진 변경" : "Change video engine"} style={editBtn}>
              <IconRefresh size={12} /> {locale === "ko" ? "엔진 변경" : "Change engine"}
            </button>
            <button onClick={onDelete} title={locale === "ko" ? "샷 삭제" : "Delete shot"} style={{ ...editBtn, color: "var(--ob-danger)", marginLeft: "auto", paddingInline: 9 }}>
              <IconTrash size={12} />
            </button>
          </div>
        )}

        <button
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "transparent",
            border: "none",
            color: "var(--ob-muted)",
            fontSize: 11,
            cursor: "pointer",
            padding: "2px 0",
            marginTop: editable ? 0 : "auto",
          }}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          {locale === "ko" ? "생성 프롬프트" : "Generation prompt"}
        </button>

        {expanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {shot.continuityNote && <PromptBlock label="CONTINUITY" text={shot.continuityNote} muted />}
            <PromptBlock label="PROMPT" text={shot.generationPrompt} />
            {shot.motionPhrase && (
              <PromptBlock label={locale === "ko" ? "MOTION · 초단위 안무" : "MOTION · Second-by-second choreography"} text={shot.motionPhrase} />
            )}
            {shot.audioDirection && (
              <PromptBlock label={locale === "ko" ? "AUDIO · 동기 오디오" : "AUDIO · Synced audio"} text={shot.audioDirection} />
            )}
            <PromptBlock label="NEGATIVE" text={shot.negativePrompt} muted />
            {shot.continuityRefs.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--muted-deep)" }}>
                refs: {shot.continuityRefs.map((r) => <code key={r} style={codeStyle}>{r}</code>)}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function PromptBlock({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        lineHeight: 1.5,
        color: muted ? "var(--muted-deep)" : "var(--ink-soft)",
        background: "var(--fill-1)",
        border: "1px solid var(--paper-edge)",
        borderRadius: 8,
        padding: "7px 9px",
      }}
    >
      <div style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", letterSpacing: 0.5, color: "var(--muted-deep)", marginBottom: 3 }}>{label}</div>
      {text}
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  fontSize: 9.5,
  fontFamily: "var(--font-mono)",
  background: "var(--fill-1)",
  padding: "1px 4px",
  borderRadius: 4,
  marginRight: 3,
};

const editBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ob-ink-soft)",
  background: "var(--ob-surface)",
  border: "1px solid var(--ob-edge-strong)",
  borderRadius: 999,
  padding: "5px 11px",
  cursor: "pointer",
};

function modeLabel(mode: string): string {
  return (
    {
      text_to_video: "T2V",
      image_to_video: "I2V",
      first_last_frame: "First/Last",
      video_extend: "Extend",
      video_to_video: "V2V",
      image: "Image",
    } as Record<string, string>
  )[mode] ?? mode;
}

function speedLabel(speed: string): string {
  return ({ slow_mo: "SLO", ramp: "RAMP", time_lapse: "TL" } as Record<string, string>)[speed] ?? "";
}

function deliveryLabel(delivery: string, locale: Locale): string {
  const ko: Record<string, string> = {
    neutral: "담담하게",
    whisper: "속삭임",
    intense: "긴장된 저음",
    warm: "따뜻하게",
    cold: "차갑게",
    urgent: "다급하게",
    playful: "경쾌하게",
    broken: "울먹이며",
  };
  const en: Record<string, string> = {
    neutral: "neutral",
    whisper: "whisper",
    intense: "intense, low tone",
    warm: "warm",
    cold: "cold",
    urgent: "urgent",
    playful: "playful",
    broken: "breaking, tearful",
  };
  return (locale === "ko" ? ko[delivery] : en[delivery]) ?? delivery;
}

// ── 연속성 메모리 스레드 (목표 4) ─────────────────────────
// 씬별로 "메모리가 이어지는지"를 가로 스트립으로 보여준다. 체이닝된 샷 수와
// 감정 흐름(arc)을 함께 표시해 전체 영상의 연속성을 한눈에 검수.

function ContinuityThread({ spans, locale }: { spans: ReturnType<typeof summarizeContinuity>; locale: Locale }) {
  if (!spans.length) return null;
  const totalChained = spans.reduce((a, s) => a + s.chainedShots, 0);
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <IconRoute size={13} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ob-ink-soft)" }}>
          {locale === "ko" ? "연속성 메모리 스레드" : "Continuity Memory Thread"}
        </span>
        <span style={{ fontSize: 11, color: "var(--ob-muted)" }}>
          {locale === "ko"
            ? `이전 샷 → 현재 샷으로 상태가 이어집니다 · 정밀 연결 ${totalChained}샷`
            : `State carries from the previous shot to the current one · precisely chained: ${totalChained} shots`}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {spans.map((span, i) => (
          <div key={span.sceneId} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <div
              style={{
                minWidth: 132,
                padding: "9px 11px",
                borderRadius: 10,
                border: "1px solid var(--ob-edge)",
                background: "var(--ob-surface)",
              }}
            >
              <div style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--ob-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {span.heading}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ob-ink)" }}>
                  {locale === "ko" ? `${span.shotCount}샷` : `${span.shotCount} shots`}
                </span>
                {span.chainedShots > 0 && (
                  <span
                    title={locale === "ko" ? "키프레임 정밀 연결" : "Precise keyframe chaining"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10, color: "var(--ob-accent-text)" }}
                  >
                    <IconRoute size={9} /> {span.chainedShots}
                  </span>
                )}
              </div>
              {span.emotionalArc.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--ob-muted)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {span.emotionalArc.slice(0, 3).join(" → ")}
                </div>
              )}
            </div>
            {i < spans.length - 1 && <span style={{ color: "var(--ob-muted)", fontSize: 12 }}>→</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
