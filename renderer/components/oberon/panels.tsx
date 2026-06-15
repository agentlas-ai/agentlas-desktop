// Oberon — 보조 스튜디오 패널들: Script / Keyframe / Approval / QA / Timeline / Delivery.
"use client";
import { useState } from "react";
import {
  QUALITY_GATES,
  SHOT_SIZES,
  TRANSITIONS,
  buildAllExports,
  composeKeyframePrompt,
  downloadText,
  providerById,
  type EditDecision,
  type FilmProduction,
  type Take,
} from "@/lib/oberon";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFileUp,
  IconImage,
  IconShield,
  IconLayers,
  IconFilm,
} from "@/components/Icon";
import { Card, Chip, GhostButton, Meter, PanelHead, PrimaryButton, SizeBadge, Tag, formatCost, formatDuration, providerColor } from "./ui";

// ── Script / Beat Board ──────────────────────────────────

export function ScriptBoard({ production }: { production: FilmProduction }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
      <PanelHead
        title="Script & Beat Board"
        subtitle={`${production.stats.totalDurationSec}초를 ${production.stats.sequenceCount}개 시퀀스 · ${production.stats.sceneCount}개 씬 · ${production.stats.beatCount}개 비트로 분해했습니다. 각 비트는 감정선과 커버리지 의도를 가집니다.`}
        icon={<IconFilm size={18} />}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {production.sequences.map((seq) => (
          <div key={seq.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 800, color: "var(--accent)" }}>{seq.id.toUpperCase()}</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{seq.title}</span>
              <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>— {seq.purpose}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 4 }}>
              {seq.sceneIds.map((sid) => {
                const scene = production.scenes.find((s) => s.id === sid);
                if (!scene) return null;
                const beats = production.beats.filter((b) => scene.beatIds.includes(b.id));
                const shotCount = production.shots.filter((s) => s.sceneId === sid).length;
                return (
                  <Card key={sid} style={{ padding: 13 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>{scene.heading}</span>
                      <Tag>{scene.type}</Tag>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted-deep)" }}>{shotCount}샷 · {scene.timeOfDay}</span>
                    </div>
                    <p style={{ margin: "0 0 9px", fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5 }}>{scene.summary}</p>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {beats.map((b) => (
                        <span key={b.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "4px 9px", borderRadius: 8, background: "var(--fill-1)", border: "1px solid var(--paper-edge)", color: "var(--ink-soft)" }}>
                          <strong style={{ color: "var(--ink)" }}>{b.name}</strong>
                          <span style={{ color: "var(--peach-ink)", fontSize: 10 }}>{b.emotion}</span>
                          <span style={{ color: "var(--muted-deep)", fontSize: 10 }}>{b.shotIds.length}샷</span>
                        </span>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Keyframe Lab ─────────────────────────────────────────

export function KeyframeLab({ production }: { production: FilmProduction }) {
  const kfShots = production.shots.filter((s) => s.requiresKeyframe || s.firstFrameAssetId);
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
      <PanelHead
        title="Keyframe Lab — 컷 이미지"
        subtitle={`정밀 컷 연결이 필요한 ${kfShots.length}개 샷은 비싼 영상 호출 전에 첫 프레임으로 구도·정체성을 먼저 확인합니다. 실제 파일이 생기기 전에는 완료로 보지 않습니다.`}
        icon={<IconImage size={18} />}
      />
      {kfShots.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted-deep)", fontSize: 13 }}>이 포맷에는 키프레임 필수 샷이 없습니다.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
          {kfShots.map((shot) => {
            const refs = production.bible.references.filter((r) => shot.continuityRefs.includes(r.id));
            const first = composeKeyframePrompt({ which: "first", shotAction: shot.action, camera: shot.camera, refs, bible: production.bible, aspect: production.brief.aspect });
            const last = composeKeyframePrompt({ which: "last", shotAction: shot.action, camera: shot.camera, refs, bible: production.bible, aspect: production.brief.aspect });
            return (
              <Card key={shot.shotId} style={{ padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                  <SizeBadge size={shot.camera.size} />
                  <code style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--muted-deep)" }}>{shot.shotId}</code>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: providerColor(shot.providerId), fontWeight: 700 }}>{providerById(shot.providerId)?.name}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <KeyframeSlot label="FIRST FRAME" grad="linear-gradient(135deg,#1e3a5f,#0b1020)" prompt={first} />
                  <KeyframeSlot label="LAST FRAME" grad="linear-gradient(135deg,#3a2438,#180c18)" prompt={last} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KeyframeSlot({ label, grad, prompt }: { label: string; grad: string; prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div style={{ height: 80, borderRadius: 8, background: grad, display: "flex", alignItems: "flex-end", padding: 7 }}>
        <span style={{ fontSize: 8.5, fontFamily: "var(--font-mono)", fontWeight: 800, color: "rgba(255,255,255,0.85)" }}>{label}</span>
      </div>
      <button onClick={() => setOpen((o) => !o)} style={{ marginTop: 4, fontSize: 10, color: "var(--muted-deep)", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
        {open ? "접기" : "프롬프트 보기"}
      </button>
      {open && <div style={{ fontSize: 10, color: "var(--ink-soft)", lineHeight: 1.5, marginTop: 4, background: "var(--fill-1)", borderRadius: 6, padding: 7, border: "1px solid var(--paper-edge)" }}>{prompt}</div>}
    </div>
  );
}

// ── Approval Gate ────────────────────────────────────────

export function ApprovalGate({ production, onApprove, approved }: { production: FilmProduction; onApprove: () => void; approved: boolean }) {
  const cost = production.cost;
  const requiredKeyframes = production.shots.filter((s) => s.requiresKeyframe);
  const approvedKeyframes = new Set((production.keyframeAssets ?? []).map((asset) => asset.shotId));
  const checks = [
    { gate: QUALITY_GATES[0], pass: !!production.brief.title && !!production.brief.logline },
    { gate: QUALITY_GATES[1], pass: production.stats.beatCount > 0 },
    { gate: QUALITY_GATES[2], pass: production.stats.shotCount > 0 },
    { gate: QUALITY_GATES[3], pass: production.bible.references.length > 0 },
    {
      gate: QUALITY_GATES[4],
      pass:
        requiredKeyframes.length === 0
          ? production.bible.references.length > 0
          : requiredKeyframes.every((shot) => approvedKeyframes.has(shot.shotId)),
    },
    { gate: QUALITY_GATES[5], pass: cost.withinBudget },
    { gate: QUALITY_GATES[6], pass: production.brief.mustAvoid.length >= 0 },
  ];
  const allPass = checks.every((c) => c.pass);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
      <PanelHead
        title="Approval Gate — 비용·권리·세이프티 승인"
        subtitle="비싼 영상 생성 전에 사람이 한 번 승인합니다. 7개 품질 게이트와 예산을 확인하고, 통과하면 생성 큐가 열립니다."
        icon={<IconShield size={18} />}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)", marginBottom: 12 }}>품질 게이트</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {checks.map(({ gate, pass }) => (
              <div key={gate.key} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                <span style={{ width: 18, height: 18, borderRadius: "50%", background: pass ? "var(--green-deep)" : "var(--red-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                  {pass ? <IconCheck size={11} style={{ color: "#fff" }} /> : <IconClose size={11} style={{ color: "#fff" }} />}
                </span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{gate.name}</div>
                  <div style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.4 }}>{gate.passCondition}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)", marginBottom: 10 }}>예상 비용</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: cost.withinBudget ? "var(--ink)" : "var(--red-deep)", lineHeight: 1 }}>{formatCost(cost.totalUsd)}</div>
            <div style={{ fontSize: 11, color: "var(--muted-deep)", margin: "4px 0 10px" }}>예산 {formatCost(cost.budgetUsd)} · 영상 {formatCost(cost.videoCostUsd)} + 이미지 {formatCost(cost.imageCostUsd)}</div>
            <Meter value={cost.totalUsd} max={cost.budgetUsd} color={cost.withinBudget ? "var(--accent)" : "var(--red-deep)"} />
          </Card>

          <Card style={{ padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)", marginBottom: 8 }}>권리 · 세이프티</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5, color: "var(--ink-soft)" }}>
              <SafetyRow ok label="실존 인물 likeness 없음 (가상 캐릭터)" />
              <SafetyRow ok label="저작권 캐릭터/IP 미사용" />
              <SafetyRow ok={production.brief.mustAvoid.length > 0} label={production.brief.mustAvoid.length > 0 ? `금지 요소 ${production.brief.mustAvoid.length}건 등록됨` : "금지 요소 미지정 (권장)"} />
              <SafetyRow ok label="라이선스 안전 음악 사용 예정" />
            </div>
          </Card>
        </div>
      </div>

      <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 14 }}>
        {approved ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--green-deep)" }}>
            <IconCheck size={16} /> 승인 완료 — 생성 큐가 열렸습니다.
          </span>
        ) : (
          <>
            <PrimaryButton onClick={onApprove} disabled={!allPass}>
              <IconShield size={15} /> 승인하고 생성 시작
            </PrimaryButton>
            {!allPass && <span style={{ fontSize: 12, color: "var(--red-deep)" }}>일부 게이트가 통과되지 않았습니다.</span>}
          </>
        )}
      </div>
    </div>
  );
}

function SafetyRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: ok ? "var(--green-deep)" : "var(--peach-ink)" }} />
      {label}
    </div>
  );
}

// ── QA / Take Compare ────────────────────────────────────

export function TakeCompare({ production, onSelectTake }: { production: FilmProduction; onSelectTake: (shotId: string, takeId: string) => void }) {
  const ready = production.takes.filter((t) => t.qa);
  if (ready.length === 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
        <PanelHead title="Vision QA — 테이크 비교" subtitle="생성 큐에서 테이크를 먼저 생성하세요." icon={<IconLayers size={18} />} />
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted-deep)", fontSize: 13 }}>아직 QA할 테이크가 없습니다.</div>
      </div>
    );
  }
  const passRate = Math.round((production.takes.filter((t) => t.qa?.pass).length / Math.max(1, ready.length)) * 100);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
      <PanelHead
        title="Vision QA — 테이크 비교 & 선택"
        subtitle={`각 테이크를 정체성·연결·편집성·모션·마감으로 채점합니다. 통과율 ${passRate}%. shot당 최고 점수 테이크가 자동 선택되며, 직접 바꿀 수 있습니다.`}
        icon={<IconLayers size={18} />}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {production.shots.map((shot) => {
          const takes = production.takes.filter((t) => t.shotId === shot.shotId && t.qa);
          if (!takes.length) return null;
          const selected = takes.find((t) => t.status === "selected") ?? takes.reduce((a, b) => ((b.qa?.score ?? 0) > (a.qa?.score ?? 0) ? b : a));
          return (
            <Card key={shot.shotId} style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                <SizeBadge size={shot.camera.size} />
                <code style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--muted-deep)" }}>{shot.shotId}</code>
                <span style={{ fontSize: 11.5, color: "var(--ink-soft)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shot.action}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${takes.length}, 1fr)`, gap: 10 }}>
                {takes.map((t) => (
                  <TakeQACard key={t.id} take={t} selected={t.id === selected.id} onSelect={() => onSelectTake(shot.shotId, t.id)} />
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const ACTION_KO: Record<string, string> = {
  accept: "채택",
  retry_same_provider: "동일 재시도",
  retry_stronger_reference: "레퍼런스 강화 재시도",
  switch_provider: "프로바이더 교체",
  resplit_shot: "샷 재분할",
};

function TakeQACard({ take, selected, onSelect }: { take: Take; selected: boolean; onSelect: () => void }) {
  const qa = take.qa!;
  return (
    <div style={{ borderRadius: 10, border: selected ? "2px solid var(--green-deep)" : "1px solid var(--paper-edge)", overflow: "hidden", background: "var(--paper)" }}>
      <div style={{ height: 70, background: take.thumbnailGradient, position: "relative" }}>
        <span style={{ position: "absolute", top: 5, left: 5, fontSize: 9, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.85)" }}>T{take.attempt}</span>
        <span style={{ position: "absolute", bottom: 5, right: 5, fontSize: 12, fontWeight: 800, fontFamily: "var(--font-mono)", color: "#fff", background: qa.pass ? "rgba(43,138,62,0.9)" : "rgba(201,42,42,0.9)", padding: "1px 6px", borderRadius: 5 }}>
          {Math.round(qa.score * 100)}
        </span>
      </div>
      <div style={{ padding: "8px 9px", display: "flex", flexDirection: "column", gap: 6 }}>
        {qa.findings.length === 0 ? (
          <div style={{ fontSize: 10.5, color: "var(--green-deep)" }}>결함 없음 — 클린</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {qa.findings.map((f, i) => (
              <div key={i} style={{ fontSize: 9.5, color: f.severity === "high" ? "var(--red-deep)" : "var(--muted-deep)", lineHeight: 1.3 }}>
                <span style={{ fontWeight: 700 }}>[{f.type}]</span> {f.note}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Tag color={qa.pass ? "var(--green-deep)" : "var(--peach-ink)"}>{ACTION_KO[qa.recommendedAction] ?? qa.recommendedAction}</Tag>
        </div>
        <button
          onClick={onSelect}
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "5px 0",
            borderRadius: 7,
            border: "none",
            cursor: "pointer",
            background: selected ? "var(--green-deep)" : "var(--fill-1)",
            color: selected ? "#fff" : "var(--ink-soft)",
          }}
        >
          {selected ? "✓ 선택됨" : "이 테이크 선택"}
        </button>
      </div>
    </div>
  );
}

// ── Timeline / Editor ────────────────────────────────────

export function TimelineEditor({ production }: { production: FilmProduction }) {
  const edl = production.edl;
  const totalDur = edl.reduce((a, e) => a + e.durationSec, 0);
  if (edl.length === 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
        <PanelHead title="Timeline — 편집 결정 리스트" subtitle="QA를 통과한 테이크를 선택하면 타임라인이 구성됩니다." icon={<IconLayers size={18} />} />
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted-deep)", fontSize: 13 }}>생성·QA 후 타임라인이 만들어집니다.</div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 40px" }}>
      <PanelHead
        eyebrow="Step 06 · 편집"
        title="영상 이어붙이기"
        subtitle={`고른 영상들을 순서대로 이어 붙인 편집표예요. 총 ${edl.length}개 컷 · ${formatDuration(totalDur)}. 컷 길이와 전환은 자동으로 정리돼 있습니다.`}
        icon={<IconFilm size={18} />}
      />

      {/* 타임라인 스트립 */}
      <Card style={{ padding: 14, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 2, height: 56, alignItems: "stretch", overflowX: "auto", paddingBottom: 6 }}>
          {edl.map((e) => {
            const shot = production.shots.find((s) => s.shotId === e.shotId);
            const w = Math.max(28, e.durationSec * 22);
            return (
              <div
                key={e.shotId}
                title={`${e.shotId} · ${e.durationSec}s · ${TRANSITIONS[e.transitionIn].ko}`}
                style={{
                  width: w,
                  flexShrink: 0,
                  borderRadius: 3,
                  background: "var(--ob-ink-soft)",
                  display: "flex",
                  alignItems: "flex-end",
                  padding: 4,
                  position: "relative",
                }}
              >
                <span style={{ fontSize: 8, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.85)", fontVariantNumeric: "tabular-nums" }}>{e.durationSec}s</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* EDL 리스트 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 90px 90px 70px", gap: 8, fontSize: 9.5, fontFamily: "var(--font-mono)", color: "var(--muted-deep)", padding: "0 10px", letterSpacing: 0.5 }}>
          <span>#</span><span>SHOT</span><span>전환</span><span>구간</span><span>길이</span>
        </div>
        {edl.map((e) => {
          const shot = production.shots.find((s) => s.shotId === e.shotId);
          return (
            <div key={e.shotId} style={{ display: "grid", gridTemplateColumns: "40px 1fr 90px 90px 70px", gap: 8, alignItems: "center", padding: "8px 10px", borderRadius: 8, background: "var(--paper)", border: "1px solid var(--paper-edge)", fontSize: 11.5 }}>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted-deep)" }}>{String(e.order).padStart(2, "0")}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                {shot && <SizeBadge size={shot.camera.size} />}
                <code style={{ fontSize: 10, color: "var(--muted-deep)" }}>{e.shotId}</code>
                <span style={{ color: "var(--ink-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shot?.action}</span>
              </span>
              <span><Tag>{TRANSITIONS[e.transitionIn].ko}</Tag></span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--muted-deep)" }}>{e.inSec}–{e.outSec}s</span>
              <span style={{ fontWeight: 700, color: "var(--ink)" }}>{e.durationSec}s</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Delivery / Export ────────────────────────────────────

const ASPECT_OUTPUTS: { aspect: string; platform: string; ratio: string }[] = [
  { aspect: "16:9", platform: "YouTube · TV · 와이드", ratio: "16 / 9" },
  { aspect: "9:16", platform: "Shorts · Reels · TikTok", ratio: "9 / 16" },
  { aspect: "1:1", platform: "Instagram 피드", ratio: "1 / 1" },
  { aspect: "2.39:1", platform: "시네마 스코프", ratio: "2.39 / 1" },
];

export function DeliveryPanel({ production }: { production: FilmProduction }) {
  const exports = buildAllExports(production);
  const renderOutputs = production.renderOutputs ?? [];
  const master = renderOutputs.find((file) => file.kind === "master_mp4") ?? renderOutputs.find((file) => file.kind === "clip_mp4");
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" }}>
      <PanelHead
        eyebrow="Step 06 · 납품"
        title="납품 패키지"
        subtitle={renderOutputs.length > 0 ? "실제 렌더 파일과 편집 가능한 제작 패키지를 함께 납품합니다." : "아직 실제 렌더 파일은 없습니다. 먼저 영상 생성 단계에서 Google Veo 렌더를 완료하세요."}
        icon={<IconFileUp size={18} />}
      />

      {renderOutputs.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginBottom: 12 }}>실제 렌더 파일</div>
          <Card style={{ padding: 16, marginBottom: 28 }}>
            <div style={{ display: "grid", gridTemplateColumns: master ? "minmax(280px, 1.2fr) 1fr" : "1fr", gap: 16 }}>
              {master && (
                <video
                  controls
                  src={master.url}
                  style={{ width: "100%", borderRadius: 10, background: "#111", aspectRatio: "16 / 9", objectFit: "contain" }}
                />
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {renderOutputs.map((file) => (
                  <a
                    key={file.id}
                    href={file.url}
                    download={file.name}
                    style={{ display: "grid", gridTemplateColumns: "46px 1fr auto", gap: 10, alignItems: "center", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--ob-edge)", color: "var(--ob-ink)", background: "var(--ob-paper)", textDecoration: "none" }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 800, color: "var(--ob-accent)" }}>{renderFileExt(file.name)}</span>
                    <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</span>
                    <span style={{ fontSize: 11, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>{renderFileSize(file.sizeBytes)}</span>
                  </a>
                ))}
              </div>
            </div>
          </Card>
        </>
      )}

      {/* 비율 출력 */}
      <div style={{ ...sectionLabel, marginBottom: 12 }}>멀티 비율 마스터</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 32 }}>
        {ASPECT_OUTPUTS.map((o) => (
          <Card key={o.aspect} style={{ padding: 14, width: 156 }}>
            <div style={{ aspectRatio: o.ratio, background: "linear-gradient(160deg,#2A2824,#3A3833)", borderRadius: 4, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", maxHeight: 110, boxShadow: "inset 0 0 0 1px rgba(35,33,29,0.04)" }}>
              <span style={{ fontSize: 12, fontWeight: 500, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.7)" }}>{o.aspect}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ob-ink)" }}>{o.aspect}</div>
              {o.aspect === production.brief.aspect && <span style={{ fontSize: 10, color: "var(--ob-accent)", fontWeight: 600 }}>기본</span>}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ob-muted)", marginTop: 1 }}>{o.platform}</div>
          </Card>
        ))}
      </div>

      {/* 산출물 다운로드 */}
      <div style={{ ...sectionLabel, marginBottom: 12 }}>산출물 — 지금 바로 사용 가능</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 12, marginBottom: 20 }}>
        {exports.map((f) => (
          <Card key={f.name} style={{ padding: 15, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--ob-ink-soft)", background: "var(--ob-fill)", borderRadius: 5, padding: "4px 7px", letterSpacing: 0.3 }}>{fileExt(f.name)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ob-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
              <div style={{ fontSize: 11, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>{(f.content.length / 1024).toFixed(1)} KB</div>
            </div>
            <GhostButton onClick={() => downloadText(f)} style={{ padding: "7px 11px" }}>
              <IconFileUp size={13} />
            </GhostButton>
          </Card>
        ))}
      </div>

      <PrimaryButton onClick={() => exports.forEach((f) => downloadText(f))}>
        <IconFileUp size={15} /> 전체 패키지 다운로드 ({exports.length})
      </PrimaryButton>
    </div>
  );
}

function fileExt(name: string): string {
  const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.length > 5 ? "FILE" : ext;
}

function renderFileExt(name: string): string {
  const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.length > 5 ? "FILE" : ext;
}

function renderFileSize(size: number): string {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const sectionLabel: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--ob-ink)" };
