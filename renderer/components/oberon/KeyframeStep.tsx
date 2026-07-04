// Oberon — Step 04 컷 이미지. 샷별 첫/끝 프레임을 이미지 엔진으로 병렬 생성.
// GATE C (머니 게이트): 싼 키프레임과 비싼 영상 사이의 default-deny 게이트.
// 승인 전에 총 예상 비용을 보여주고, 사람이 승인해야 영상 단계가 열린다.
"use client";
import { useEffect, useState } from "react";
import { getMultimodalProvider } from "@shared/multimodal";
import { ipc } from "@/lib/ipc";
import type { FilmProduction, ModelSettings } from "@/lib/oberon";
import type { OberonKeyframeJob } from "@/lib/types";
import { useT, type Locale } from "@/lib/i18n";
import { Glyph, OberonBadge } from "./icons";
import { Card, FilmFrame, GhostButton, Meter, PanelHead, PrimaryButton, formatCost } from "./ui";

/** getMultimodalProvider() 결과의 locale-aware 라벨 (label=en / labelKo=ko). */
function providerLabel(p: { label: string; labelKo: string } | null | undefined, locale: Locale): string | undefined {
  if (!p) return undefined;
  return locale === "ko" ? p.labelKo : p.label;
}

export function KeyframeStep({
  production,
  model,
  progress,
  generating,
  done,
  approved,
  job,
  onStart,
  onApprove,
  onOpenOutput,
}: {
  production: FilmProduction;
  model?: ModelSettings;
  progress: number;
  generating: boolean;
  done: boolean;
  approved: boolean;
  job?: OberonKeyframeJob | null;
  onStart: () => void;
  onApprove: () => void;
  onOpenOutput?: (jobId: string) => void;
}) {
  const { locale } = useT();
  const [hasGoogleKey, setHasGoogleKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const shots = production.shots;
  const total = shots.length;
  const started = generating || done || progress > 0 || !!job;
  const usesGoogleImage = model?.imageProvider === "google-image";
  const canRestart =
    started &&
    !done &&
    !generating &&
    job?.status !== "running" &&
    job?.status !== "queued";

  const imgLabel = model?.imageProvider
    ? providerLabel(getMultimodalProvider(model.imageProvider), locale)
    : locale === "ko"
      ? "이미지 엔진"
      : "Image Engine";
  const videoLabels = (model?.videoProviders ?? [])
    .map((id) => providerLabel(getMultimodalProvider(id), locale))
    .filter(Boolean)
    .join(", ");

  // 총비용 = 영상비(1테이크) × 테이크 수 + 이미지 비용. 헤더/코스트 레저와 같은 소스.
  const takesPerShot = production.cost.takesPerShot || 3;
  const projected = production.cost.totalUsd;
  const budget = production.cost.budgetUsd;
  const withinBudget = projected <= budget;

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

  return (
    <div style={panelStyle}>
      <PanelHead
        eyebrow={locale === "ko" ? "Step 04 · 컷 이미지" : "Step 04 · Cut Images"}
        title={locale === "ko" ? "첫 장면 먼저 만들기" : "Make the First Frame First"}
        subtitle={
          locale === "ko"
            ? `각 컷의 첫 장면을 먼저 이미지로 만듭니다 (${imgLabel}). 여기서 확인하고 OK한 장면만 영상으로 만들기 때문에, 비싼 영상에 돈을 낭비하지 않아요.`
            : `Generates each cut's first frame as an image first (${imgLabel}). Only frames you review and approve here get turned into video, so you never waste money on expensive video generation.`
        }
        icon={<Glyph name="keyframe" size={18} />}
        right={
          canRestart ? (
            <PrimaryButton onClick={onStart} disabled={usesGoogleImage && hasGoogleKey === false}>
              {locale === "ko" ? "다시 생성" : "Regenerate"}
            </PrimaryButton>
          ) : started ? null : (
            <PrimaryButton onClick={onStart} disabled={generating || (usesGoogleImage && hasGoogleKey === false)}>
              {generating ? (locale === "ko" ? "생성 중…" : "Generating…") : locale === "ko" ? "실제 키프레임 생성" : "Generate Real Keyframes"}
            </PrimaryButton>
          )
        }
      />

      {usesGoogleImage && hasGoogleKey === false && (
        <GoogleImageKeyGate
          value={keyDraft}
          saving={savingKey}
          onChange={setKeyDraft}
          onSave={saveGoogleKey}
          locale={locale}
        />
      )}

      {/* 머니 게이트 — 예상 영상비 */}
      <Card style={{ padding: 22, marginBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <OberonBadge name="video" size={24} glyphSize={13} />
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ob-ink)" }}>{locale === "ko" ? "총 예상 비용" : "Total Estimated Cost"}</span>
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: withinBudget ? "var(--ob-success)" : "var(--ob-danger)" }}>
            {withinBudget ? (locale === "ko" ? "예산 내" : "Within Budget") : locale === "ko" ? "예산 초과" : "Over Budget"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <span style={{ fontSize: 34, fontWeight: 500, fontFamily: "var(--font-display, serif)", color: withinBudget ? "var(--ob-ink)" : "var(--ob-danger)", lineHeight: 1, fontVariantNumeric: "tabular-nums", letterSpacing: 0 }}>{formatCost(projected)}</span>
          <span style={{ fontSize: 13, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>
            {locale === "ko"
              ? `영상 ${total}컷 × 후보 ${takesPerShot}개 + 이미지 ${formatCost(production.cost.imageCostUsd)} · 예산 ${formatCost(budget)}`
              : `Video ${total} cuts × ${takesPerShot} candidates + images ${formatCost(production.cost.imageCostUsd)} · budget ${formatCost(budget)}`}
          </span>
        </div>
        <Meter value={projected} max={budget} color={withinBudget ? "var(--ob-ink)" : "var(--ob-danger)"} />
        <div style={{ fontSize: 12.5, color: "var(--ob-muted)", marginTop: 10 }}>
          {locale === "ko"
            ? `영상 엔진 ${videoLabels || "미선택"} · 승인하면 영상 생성 단계가 열리고, 다음 화면에서 실렌더를 시작합니다.`
            : `Video engine: ${videoLabels || "none selected"} · Approving unlocks the video generation step, where you'll start the real render.`}
        </div>
      </Card>

      {job && <KeyframeJobCard job={job} onOpenOutput={onOpenOutput} locale={locale} />}

      {started && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--ob-muted)", marginBottom: 6, fontVariantNumeric: "tabular-nums" }}>
            <span>{locale === "ko" ? "키프레임 생성" : "Generating keyframes"} {Math.min(progress, total)} / {total}</span>
            <span>{Math.round((Math.min(progress, total) / Math.max(1, total)) * 100)}%</span>
          </div>
          <Meter value={Math.min(progress, total)} max={total} color="var(--ob-ink)" />
        </div>
      )}

      {started ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 12, marginBottom: 24 }}>
          {shots.map((shot, i) => {
            // START/END 체이닝으로 last_frame 자산이 섞여 있어도 갤러리는 첫 프레임을 보여준다.
            const asset = production.keyframeAssets?.find((item) => item.shotId === shot.shotId && item.kind !== "last_frame");
            const ready = !!asset || i < progress;
            return (
              <FilmFrame
                key={shot.shotId}
                aspect={production.brief.aspect}
                size={shot.camera.size}
                code={shot.shotId.split("_").slice(-1)[0]}
                imageUrl={asset?.url}
                state={ready ? "ready" : generating ? "generating" : "idle"}
              />
            );
          })}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "56px 20px", color: "var(--ob-muted)" }}>
          <div style={{ display: "inline-flex" }}><OberonBadge name="keyframe" size={40} /></div>
          <p style={{ fontSize: 14, marginTop: 14 }}>
            {locale === "ko"
              ? `"병렬 생성 시작"을 누르면 ${total}개 샷의 첫 프레임이 병렬로 생성됩니다.`
              : `Press "Start Parallel Generation" to generate the first frame of all ${total} shots in parallel.`}
          </p>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {approved ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--ob-success)" }}>
            <Glyph name="check" size={16} strokeWidth={2.4} />{" "}
            {locale === "ko" ? "컷 이미지 확정 — 영상 생성 단계가 열렸습니다." : "Cut images confirmed — the video generation step is unlocked."}
          </span>
        ) : done ? (
          <PrimaryButton onClick={onApprove}>
            {locale === "ko" ? "컷 이미지 승인하고 영상 단계로" : "Approve Cut Images and Continue to Video"} · {formatCost(projected)}{" "}
            <Glyph name="chevron" size={14} strokeWidth={2.4} />
          </PrimaryButton>
        ) : (
          <span style={{ fontSize: 12.5, color: "var(--ob-muted)" }}>
            {locale === "ko" ? "키프레임 생성을 완료하면 영상 생성을 승인할 수 있습니다." : "Finish keyframe generation to approve video generation."}
          </span>
        )}
      </div>
    </div>
  );
}

function GoogleImageKeyGate({
  value,
  saving,
  onChange,
  onSave,
  locale,
}: {
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  locale: Locale;
}) {
  return (
    <Card style={{ padding: 18, marginBottom: 18, borderColor: "var(--ob-accent)", boxShadow: "0 0 0 3px var(--ob-accent-soft)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr minmax(260px, 0.8fr) auto", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ob-ink)", marginBottom: 4 }}>
            {locale === "ko" ? "Google 이미지 키가 필요합니다" : "A Google image key is required"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ob-muted)", lineHeight: 1.5 }}>
            {locale === "ko"
              ? "Gemini API 키를 저장하면 Electron main process가 Google Imagen으로 첫 프레임을 생성합니다. 키 값은 Keychain env vault에만 저장됩니다."
              : "Once you save your Gemini API key, the Electron main process generates first frames with Google Imagen. The key is stored only in the Keychain env vault."}
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
          {saving ? (locale === "ko" ? "저장 중…" : "Saving…") : locale === "ko" ? "키 저장" : "Save Key"}
        </PrimaryButton>
      </div>
    </Card>
  );
}

function KeyframeJobCard({
  job,
  onOpenOutput,
  locale,
}: {
  job: OberonKeyframeJob;
  onOpenOutput?: (jobId: string) => void;
  locale: Locale;
}) {
  const statusTone =
    job.status === "succeeded"
      ? "var(--ob-success)"
      : job.status === "failed" || job.status === "cancelled"
        ? "var(--ob-danger)"
        : "var(--ob-accent)";
  return (
    <Card style={{ padding: 18, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <OberonBadge name="keyframe" tone="accent" size={26} glyphSize={14} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ob-ink)" }}>
            {job.provider === "google-imagen"
              ? locale === "ko"
                ? "Google Imagen 작업"
                : "Google Imagen Job"
              : locale === "ko"
                ? "Codex image_gen 작업"
                : "Codex image_gen Job"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ob-muted)", marginTop: 3 }}>
            {job.model} · {job.message}
          </div>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: statusTone }}>
          {job.status}
        </span>
        {onOpenOutput && (
          <GhostButton onClick={() => onOpenOutput(job.id)} style={{ minHeight: 34 }}>
            {locale === "ko" ? "출력 폴더" : "Output Folder"}
          </GhostButton>
        )}
      </div>
      {(job.error || job.warnings.length > 0) && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "var(--ob-surface)", color: job.error ? "var(--ob-danger)" : "var(--ob-muted)", fontSize: 12, lineHeight: 1.55 }}>
          {job.error || job.warnings.slice(0, 3).join(" · ")}
        </div>
      )}
    </Card>
  );
}

const panelStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" };
