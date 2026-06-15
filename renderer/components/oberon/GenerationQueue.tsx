// Oberon — Generation Queue + Cost Ledger. 프로바이더 호출 상태와 비용을 실시간 관리.
"use client";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { providerById, type FilmProduction, type Take } from "@/lib/oberon";
import type { OberonRenderFile, OberonRenderJob } from "@/lib/types";
import { IconBolt, IconCircleDollar, IconRefresh } from "@/components/Icon";
import { Card, GhostButton, Meter, PanelHead, PrimaryButton, formatCost } from "./ui";

export function GenerationQueue({
  production,
  generating,
  renderJob,
  onStart,
  onReset,
  onSelectTake,
  onOpenOutput,
}: {
  production: FilmProduction;
  generating: boolean;
  renderJob?: OberonRenderJob | null;
  onStart: () => void;
  onReset: () => void;
  onSelectTake?: (shotId: string, takeId: string) => void;
  onOpenOutput?: (jobId: string) => void;
}) {
  const [hasGoogleKey, setHasGoogleKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const takes = production.takes;
  const ready = takes.filter((t) => t.status === "ready" || t.status === "selected").length;
  const total = renderJob ? renderJob.progress.totalClips : takes.length || Math.min(3, production.shots.length);
  const started = takes.length > 0 || !!renderJob;
  const completed = renderJob?.progress.completedClips ?? ready;

  // 누적 실비용 (ready 테이크 기준)
  const cost = production.cost;

  useEffect(() => {
    let cancelled = false;
    const bridge = ipc();
    if (!bridge?.env) {
      setHasGoogleKey(false);
      return;
    }
    void Promise.all([bridge.env.has("GEMINI_API_KEY"), bridge.env.has("GOOGLE_API_KEY")])
      .then(([gemini, google]) => {
        if (!cancelled) setHasGoogleKey(gemini || google);
      })
      .catch(() => {
        if (!cancelled) setHasGoogleKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveGoogleKey() {
    const value = keyDraft.trim();
    if (!value) return;
    const bridge = ipc();
    if (!bridge?.env) return;
    setSavingKey(true);
    try {
      await bridge.env.set("GEMINI_API_KEY", value);
      setKeyDraft("");
      setHasGoogleKey(true);
    } finally {
      setSavingKey(false);
    }
  }

  // 프로바이더 분포
  const dist = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of production.shots) m.set(s.providerId, (m.get(s.providerId) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [production.shots]);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" }}>
      <PanelHead
        eyebrow="Step 05 · 영상 생성"
        title="Google Veo로 실제 영상 만들기"
        subtitle="비용 보호를 위해 먼저 앞 3컷만 실제 렌더합니다. 완료되면 바로 재생하고 MP4/MOV/WAV로 받을 수 있어요."
        icon={<IconBolt size={18} />}
        right={
          started ? (
            <GhostButton onClick={onReset}>
              <IconRefresh size={14} /> 큐 리셋
            </GhostButton>
          ) : (
            <PrimaryButton onClick={onStart} disabled={generating || hasGoogleKey === false}>
              {generating ? "Veo 렌더 중…" : "3컷 실렌더 시작"}
            </PrimaryButton>
          )
        }
      />

      {hasGoogleKey === false && (
        <GoogleKeyGate
          value={keyDraft}
          saving={savingKey}
          onChange={setKeyDraft}
          onSave={saveGoogleKey}
        />
      )}

      {/* 비용 레저 + 진행 */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, marginBottom: 20 }}>
        <Card style={{ padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14 }}>
            <IconCircleDollar size={15} style={{ color: "var(--ob-ink-soft)" }} />
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ob-ink)" }}>코스트 레저</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: cost.withinBudget ? "var(--ob-success)" : "var(--ob-danger)", fontWeight: 600 }}>
              {cost.withinBudget ? "예산 내" : "예산 초과"}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--ob-ink-soft)", marginBottom: 7 }}>
            <span>영상 {production.stats.shotCount}컷 × 후보 {cost.takesPerShot}개</span>
            <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCost(cost.videoCostUsd * cost.takesPerShot)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--ob-ink-soft)", marginBottom: 12 }}>
            <span>이미지 (캐릭터·배경 시트)</span>
            <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatCost(cost.imageCostUsd)}</span>
          </div>
          <Meter value={cost.totalUsd} max={cost.budgetUsd} color={cost.withinBudget ? "var(--ob-accent)" : "var(--ob-danger)"} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ob-muted)", marginTop: 8, fontVariantNumeric: "tabular-nums" }}>
            <span>예상 합계 {formatCost(cost.totalUsd)}</span>
            <span>예산 {formatCost(cost.budgetUsd)}</span>
          </div>
        </Card>

        <Card style={{ padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ob-ink)", marginBottom: 12 }}>프로바이더 분포</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {dist.map(([id, n]) => {
              const p = providerById(id);
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ob-ink-soft)", flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: "var(--ob-ink-soft)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p?.name ?? id}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ob-ink)", fontVariantNumeric: "tabular-nums" }}>{n}</span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {renderJob && (
        <RenderJobCard
          job={renderJob}
          outputs={production.renderOutputs ?? renderJob.files}
          onOpenOutput={onOpenOutput}
        />
      )}

      {/* 진행 바 */}
      {started && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--ob-muted)", marginBottom: 6, fontVariantNumeric: "tabular-nums" }}>
            <span>실제 렌더 {completed} / {total}</span>
            <span>{Math.round((completed / Math.max(1, total)) * 100)}%</span>
          </div>
          <Meter value={completed} max={total} color="var(--ob-ink)" />
        </div>
      )}

      {/* 샷별 테이크 */}
      {started ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {production.shots.map((shot) => {
            const shotTakes = takes.filter((t) => t.shotId === shot.shotId);
            return (
              <Card key={shot.shotId} style={{ padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 9 }}>
                  <code style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--ob-muted)" }}>{shot.shotId}</code>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ob-muted)", fontWeight: 500 }}>{providerById(shot.providerId)?.name}</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {shotTakes.map((t) => (
                    <TakeThumb
                      key={t.id}
                      take={t}
                      onSelect={
                        onSelectTake && (t.status === "ready" || t.status === "selected")
                          ? () => onSelectTake(t.shotId, t.id)
                          : undefined
                      }
                    />
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted-deep)" }}>
          <IconBolt size={28} style={{ opacity: 0.4 }} />
          <p style={{ fontSize: 13, marginTop: 12 }}>Google 키를 저장한 뒤 “3컷 실렌더 시작”을 누르면 실제 Veo 클립이 생성됩니다.</p>
        </div>
      )}
    </div>
  );
}

function GoogleKeyGate({
  value,
  saving,
  onChange,
  onSave,
}: {
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <Card style={{ padding: 18, marginBottom: 18, borderColor: "var(--ob-accent)", boxShadow: "0 0 0 3px var(--ob-accent-soft)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr minmax(260px, 0.8fr) auto", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ob-ink)", marginBottom: 4 }}>Google Veo 키가 필요합니다</div>
          <div style={{ fontSize: 12, color: "var(--ob-muted)", lineHeight: 1.5 }}>
            Gemini API 키를 저장하면 Electron main process가 Google Veo를 호출합니다. 키 값은 화면 상태에 남기지 않고 Keychain env vault에 저장됩니다.
          </div>
        </div>
        <input
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="GEMINI_API_KEY"
          style={{ minHeight: 40, borderRadius: 10, border: "1px solid var(--ob-edge)", padding: "0 12px", fontSize: 13, color: "var(--ob-ink)", background: "var(--ob-paper)", outline: "none" }}
        />
        <PrimaryButton onClick={onSave} disabled={saving || !value.trim()}>
          {saving ? "저장 중…" : "키 저장"}
        </PrimaryButton>
      </div>
    </Card>
  );
}

function RenderJobCard({
  job,
  outputs,
  onOpenOutput,
}: {
  job: OberonRenderJob;
  outputs: OberonRenderFile[];
  onOpenOutput?: (jobId: string) => void;
}) {
  const master = outputs.find((file) => file.kind === "master_mp4") ?? outputs.find((file) => file.kind === "clip_mp4");
  const downloadable = outputs.filter((file) => file.kind !== "clip_mp4" || outputs.length <= 3);
  const statusTone =
    job.status === "succeeded"
      ? "var(--ob-success)"
      : job.status === "failed" || job.status === "cancelled"
        ? "var(--ob-danger)"
        : "var(--ob-accent)";
  return (
    <Card style={{ padding: 18, marginBottom: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: master ? "minmax(260px, 1.2fr) 1fr" : "1fr", gap: 16, alignItems: "start" }}>
        {master && (
          <video
            controls
            src={master.url}
            style={{ width: "100%", borderRadius: 10, background: "#111", aspectRatio: "16 / 9", objectFit: "contain" }}
          />
        )}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusTone }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ob-ink)" }}>{job.message}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>{job.progress.percent}%</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--ob-muted)", lineHeight: 1.5, marginBottom: 12 }}>
            Google Veo · {job.model} · {job.progress.phase}
            {job.error ? <span style={{ color: "var(--ob-danger)" }}> · {job.error}</span> : null}
          </div>
          {job.warnings.length > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--ob-muted)", lineHeight: 1.5, marginBottom: 12 }}>
              {job.warnings.slice(0, 3).map((warning) => (
                <div key={warning}>주의: {warning}</div>
              ))}
            </div>
          )}
          {downloadable.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {downloadable.map((file) => (
                <a
                  key={file.id}
                  href={file.url}
                  download={file.name}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 34, padding: "0 11px", borderRadius: 999, border: "1px solid var(--ob-edge)", color: "var(--ob-ink)", background: "var(--ob-paper)", fontSize: 12, fontWeight: 700, textDecoration: "none" }}
                >
                  {labelForFile(file)}
                  <span style={{ color: "var(--ob-muted)", fontWeight: 500 }}>{formatBytes(file.sizeBytes)}</span>
                </a>
              ))}
            </div>
          )}
          {onOpenOutput && (
            <GhostButton onClick={() => onOpenOutput(job.id)}>
              출력 폴더 열기
            </GhostButton>
          )}
        </div>
      </div>
    </Card>
  );
}

function TakeThumb({ take, onSelect }: { take: Take; onSelect?: () => void }) {
  const selected = take.status === "selected";
  const statusColor =
    take.status === "generating" ? "var(--ob-accent)" : take.status === "failed" ? "var(--ob-danger)" : selected ? "var(--ob-accent)" : "var(--ob-muted)";
  const isPending = take.status === "queued" || take.status === "generating";
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        onClick={onSelect}
        title={onSelect ? (selected ? "선택됨" : "클릭해 이 테이크 선택") : undefined}
        style={{
          aspectRatio: "16 / 10",
          borderRadius: 6,
          background: take.previewUrl ? "#111" : take.thumbnailGradient,
          position: "relative",
          opacity: isPending ? 0.5 : 1,
          border: selected ? "2px solid var(--ob-accent)" : "1px solid var(--ob-edge)",
          boxShadow: selected ? "0 0 0 3px var(--ob-accent-soft)" : "inset 0 0 0 1px rgba(11,11,15,0.04)",
          overflow: "hidden",
          cursor: onSelect ? "pointer" : "default",
        }}
      >
        {take.previewUrl && (
          <video
            src={take.previewUrl}
            muted
            playsInline
            preload="metadata"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
        {take.status === "generating" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.25)", borderTopColor: "rgba(255,255,255,0.8)", borderRadius: "50%", animation: "agentlas-spin 1.1s linear infinite" }} />
          </div>
        )}
        {take.qa && (take.status === "ready" || selected) && (
          <span style={{ position: "absolute", bottom: 4, right: 4, fontSize: 9, fontWeight: 600, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.85)", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(take.qa.score * 100)}{take.qa.pass ? "" : "✕"}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: statusColor }} />
        <span style={{ fontSize: 9, color: "var(--ob-muted)", fontFamily: "var(--font-mono)" }}>T{take.attempt}</span>
      </div>
    </div>
  );
}

function labelForFile(file: OberonRenderFile): string {
  if (file.kind === "master_mp4") return "MP4";
  if (file.kind === "master_mov") return "MOV";
  if (file.kind === "master_wav") return "WAV";
  return "Clip";
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
