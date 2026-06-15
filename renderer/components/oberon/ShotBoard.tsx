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
  type FilmProduction,
  type ShotSpec,
} from "@/lib/oberon";
import { IconChevronDown, IconChevronRight, IconLayers, IconRefresh, IconTrash } from "@/components/Icon";
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
  const [sceneFilter, setSceneFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const scenes = production.scenes;
  const shots = useMemo(
    () => (sceneFilter === "all" ? production.shots : production.shots.filter((s) => s.sceneId === sceneFilter)),
    [production.shots, sceneFilter],
  );

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
        eyebrow="Step 02 · 스토리보드"
        title="장면을 컷으로 나눴어요"
        subtitle={`한 장면을 여러 각도의 컷 ${production.stats.shotCount}개로 나눴습니다. 각 컷의 카메라·엔진·비용을 확인하세요.${editable ? " 엔진을 바꾸거나 필요 없는 컷을 지울 수 있어요." : ""}`}
        icon={<IconLayers size={18} />}
      />

      {/* 씬 필터 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        <Chip active={sceneFilter === "all"} onClick={() => setSceneFilter("all")}>
          전체 {production.stats.shotCount}
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
}: {
  shot: ShotSpec;
  aspect?: string;
  editable?: boolean;
  onSwapProvider?: () => void;
  onDelete?: () => void;
  expanded: boolean;
  onToggle: () => void;
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
            <span title="실제 첫 프레임 생성 완료" style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.78)" }}>KF</span>
          )}
          {!shot.firstFrameAssetId && shot.requiresKeyframe && (
            <span title="첫 프레임 생성 필요" style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.5)" }}>KF?</span>
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

        <div style={{ fontSize: 13, color: "var(--ob-ink)", lineHeight: 1.5 }}>{shot.action}</div>

        {shot.dialogue && (
          <div style={{ fontSize: 13, color: "var(--ob-ink-soft)", fontStyle: "italic", paddingLeft: 10, borderLeft: "2px solid var(--ob-edge-strong)" }}>
            “{shot.dialogue}”
          </div>
        )}

        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <Tag>{ANGLES[shot.camera.angle].ko}</Tag>
          <Tag>{MOVEMENTS[shot.camera.movement].ko}</Tag>
          <Tag>{LENSES[shot.camera.lens].ko}</Tag>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--ob-muted)" }}>
          <span title="전환">{TRANSITIONS[shot.transitionIn].ko} → {TRANSITIONS[shot.transitionOut].ko}</span>
          <span style={{ marginLeft: "auto", color: "var(--ob-ink)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCost(shot.estCostUsd)}</span>
        </div>

        {editable && (
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button onClick={onSwapProvider} title="영상 엔진 변경" style={editBtn}>
              <IconRefresh size={12} /> 엔진 변경
            </button>
            <button onClick={onDelete} title="샷 삭제" style={{ ...editBtn, color: "var(--ob-danger)", marginLeft: "auto", paddingInline: 9 }}>
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
          생성 프롬프트
        </button>

        {expanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <PromptBlock label="PROMPT" text={shot.generationPrompt} />
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
