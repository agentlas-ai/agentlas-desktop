// Oberon 애니메이션 스튜디오 — image-to-video(i2v) 패널.
//   키프레임 이미지 → 모션 프롬프트 → 영상. BYOK(Runway/Luma) 키 필요.
//   no-fallback: 키 없으면 생성 막고 명시적 안내(Environment Keys로 유도).
"use client";
import { useState } from "react";
import Link from "next/link";
import type { FilmProduction } from "@/lib/oberon";
import type { OberonAnimateFile, OberonAnimateJob, OberonAnimateKeyStatus } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Glyph } from "./icons";
import { Card, GhostButton, Meter, PanelHead, PrimaryButton, toLocalMediaSrc } from "./ui";

const PROVIDER_LABELS: Record<string, string> = {
  grok: "Grok Imagine",
  veo: "Google Veo",
  kling: "Kling",
  seedance: "Seedance",
  runway: "Runway",
  luma: "Luma",
};

// 실행 중이면 job.provider, 아니면 준비된 키 중 사다리 우선순위로 표시할 엔진.
// grok(구독 키리스)이 맨 앞 — page.tsx resolveAnimateProvider의 사다리와 순서를 맞춘다.
function providerLabel(jobProvider: string | undefined, keyStatus?: OberonAnimateKeyStatus | null): string {
  if (jobProvider && PROVIDER_LABELS[jobProvider]) return PROVIDER_LABELS[jobProvider];
  if (keyStatus?.grok) return PROVIDER_LABELS.grok;
  if (keyStatus?.veo) return PROVIDER_LABELS.veo;
  if (keyStatus?.kling) return PROVIDER_LABELS.kling;
  if (keyStatus?.seedance) return PROVIDER_LABELS.seedance;
  if (keyStatus?.runway) return PROVIDER_LABELS.runway;
  if (keyStatus?.luma) return PROVIDER_LABELS.luma;
  return PROVIDER_LABELS.veo;
}

export function AnimatePanel({
  production,
  generating,
  job,
  keyStatus,
  hasKeyframe,
  onStart,
  onReset,
  onOpenOutput,
  onSaveKey,
}: {
  production: FilmProduction;
  generating: boolean;
  job?: OberonAnimateJob | null;
  keyStatus?: OberonAnimateKeyStatus | null;
  hasKeyframe: boolean;
  onStart: () => void;
  onReset: () => void;
  onOpenOutput?: (jobId: string) => void;
  onSaveKey?: (provider: "runway" | "luma", value: string) => void | Promise<void>;
}) {
  const { locale } = useT();
  const mp4 = (job?.files ?? []).find((f) => f.kind === "animation_mp4");
  const hasKey = Boolean(
    keyStatus?.runway || keyStatus?.luma || keyStatus?.veo || keyStatus?.seedance || keyStatus?.kling ||
      keyStatus?.grok,
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const statusTone =
    job?.status === "succeeded"
      ? "var(--ob-success)"
      : job?.status === "failed" || job?.status === "cancelled"
        ? "var(--ob-danger)"
        : "var(--ob-accent)";
  const ratio = production.brief.aspect === "9:16" ? "9 / 16" : "16 / 9";

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" }}>
      <PanelHead
        eyebrow={locale === "ko" ? "애니메이션 · 영상" : "Animation · Video"}
        title={locale === "ko" ? "이미지 → 영상" : "Image → Video"}
        subtitle={
          locale === "ko"
            ? `${production.brief.title} · 컷 이미지를 image-to-video로 애니메이션`
            : `${production.brief.title} · Animate the cut images with image-to-video`
        }
        icon={<Glyph name="sparkle" size={18} />}
        right={
          job ? (
            <GhostButton onClick={onReset}>
              <Glyph name="x" size={14} /> {locale === "ko" ? "리셋" : "Reset"}
            </GhostButton>
          ) : (
            <PrimaryButton onClick={onStart} disabled={generating || !hasKey || !hasKeyframe}>
              <Glyph name="sparkle" size={14} />
              {generating ? (locale === "ko" ? "생성 중…" : "Generating…") : locale === "ko" ? "애니메이션 생성" : "Generate Animation"}
            </PrimaryButton>
          )
        }
      />

      {!hasKey ? (
        <Card style={{ padding: 18, borderColor: "var(--ob-accent)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ob-ink)", marginBottom: 6 }}>
            {locale === "ko" ? "API 키 입력" : "Enter API Key"}
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ob-ink-soft)", margin: "0 0 12px" }}>
            {locale === "ko"
              ? "애니메이션은 외부 image-to-video 모델로 생성합니다. 키를 입력하면 OS 키체인(공통 자격증명 볼트)에 안전하게 저장됩니다."
              : "Animation is generated with an external image-to-video model. Once you enter a key, it's stored securely in the OS keychain (the shared credentials vault)."}
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={locale === "ko" ? "RUNWAYML_API_SECRET (로컬 이미지 지원)" : "RUNWAYML_API_SECRET (supports local images)"}
              style={{ flex: 1, minHeight: 38, padding: "0 12px", borderRadius: 10, border: "1px solid var(--ob-edge)", background: "var(--ob-paper)", color: "var(--ob-ink)", fontSize: 13 }}
            />
            <PrimaryButton
              onClick={() => {
                const v = keyDraft.trim();
                if (!v || !onSaveKey) return;
                setSaving(true);
                Promise.resolve(onSaveKey("runway", v)).finally(() => {
                  setSaving(false);
                  setKeyDraft("");
                });
              }}
              disabled={!keyDraft.trim() || saving}
            >
              {saving ? (locale === "ko" ? "저장 중…" : "Saving…") : locale === "ko" ? "저장" : "Save"}
            </PrimaryButton>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--ob-muted)" }}>
            {locale === "ko" ? (
              <>
                Luma(공개 URL)를 쓰려면{" "}
                <Link href="/library/env" style={{ color: "var(--ob-accent-text)", textDecoration: "none" }}>
                  Environment Keys
                </Link>
                에서 LUMAAI_API_KEY를 추가하세요.
              </>
            ) : (
              <>
                To use Luma (public URLs), add LUMAAI_API_KEY in{" "}
                <Link href="/library/env" style={{ color: "var(--ob-accent-text)", textDecoration: "none" }}>
                  Environment Keys
                </Link>
                .
              </>
            )}
          </div>
        </Card>
      ) : !hasKeyframe ? (
        <Card style={{ padding: 18 }}>
          <div style={{ fontSize: 13, color: "var(--ob-ink-soft)", lineHeight: 1.55 }}>
            {locale === "ko" ? (
              <>
                먼저 <strong>컷 이미지</strong> 단계에서 키프레임 이미지를 생성하세요. 그 이미지를 영상으로 움직입니다.
              </>
            ) : (
              <>
                First generate keyframe images in the <strong>Cut Images</strong> step. Those images will be animated into video.
              </>
            )}
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.25fr) minmax(260px, 0.85fr)", gap: 16, alignItems: "start" }}>
          <Card style={{ padding: 16 }}>
            {mp4 ? (
              <video controls src={toLocalMediaSrc(mp4.url)} style={{ width: "100%", borderRadius: 10, background: "#111", aspectRatio: ratio, objectFit: "contain" }} />
            ) : (
              <div style={{ aspectRatio: ratio, borderRadius: 10, background: "var(--ob-surface)", border: "1px solid var(--ob-edge)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ob-muted)", fontSize: 13 }}>
                {generating
                  ? locale === "ko"
                    ? "생성 중…"
                    : "Generating…"
                  : locale === "ko"
                    ? "생성하면 여기서 바로 재생됩니다"
                    : "It will play here as soon as it's generated"}
              </div>
            )}
          </Card>

          <Card style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusTone }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ob-ink)" }}>{job?.message ?? (locale === "ko" ? "대기 중" : "Waiting")}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>{job?.progress.percent ?? 0}%</span>
            </div>
            <Meter value={job?.progress.percent ?? 0} max={100} color={statusTone} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
              <Metric label="provider" value={providerLabel(job?.provider, keyStatus)} />
              <Metric label={locale === "ko" ? "길이" : "Length"} value={`${clampLen(production.brief.durationSec)}s`} />
            </div>
            {job?.error && <div style={{ marginTop: 12, fontSize: 12, color: "var(--ob-danger)", lineHeight: 1.45 }}>{job.error}</div>}
            {mp4 && <div style={{ marginTop: 16 }}><FileLink file={mp4} /></div>}
            {job && onOpenOutput && (
              <GhostButton onClick={() => onOpenOutput(job.id)} style={{ marginTop: 14 }}>
                {locale === "ko" ? "출력 폴더 열기" : "Open Output Folder"}
              </GhostButton>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function clampLen(sec: number | undefined): number {
  return (sec ?? 5) >= 10 ? 10 : 5;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, background: "var(--ob-surface)", border: "1px solid var(--ob-edge)" }}>
      <div style={{ fontSize: 10.5, color: "var(--ob-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ob-ink)" }}>{value}</div>
    </div>
  );
}

function FileLink({ file }: { file: OberonAnimateFile }) {
  return (
    <a
      href={file.url}
      download={file.name}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 34, padding: "0 11px", borderRadius: 999, border: "1px solid var(--ob-edge)", color: "var(--ob-ink)", background: "var(--ob-paper)", fontSize: 12, fontWeight: 650, textDecoration: "none" }}
    >
      MP4 <span style={{ color: "var(--ob-muted)", fontWeight: 500 }}>{formatBytes(file.sizeBytes)}</span>
    </a>
  );
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
