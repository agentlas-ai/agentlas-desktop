// Oberon — API 없는 코드 기반 모션그래픽 광고 렌더 패널.
"use client";
import type { FilmProduction } from "@/lib/oberon";
import type { OberonMotionAdFile, OberonMotionAdJob } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Glyph } from "./icons";
import { Card, GhostButton, Meter, PanelHead, PrimaryButton, toLocalMediaSrc } from "./ui";

export function MotionGraphicsPanel({
  production,
  generating,
  job,
  onStart,
  onReset,
  onOpenOutput,
}: {
  production: FilmProduction;
  generating: boolean;
  job?: OberonMotionAdJob | null;
  onStart: () => void;
  onReset: () => void;
  onOpenOutput?: (jobId: string) => void;
}) {
  const { locale } = useT();
  const files = job?.files ?? [];
  const mp4 = files.find((file) => file.kind === "motion_mp4");
  const preview = files.find((file) => file.kind === "html_preview");
  const promptPack = files.find((file) => file.kind === "prompt_pack");
  const statusTone =
    job?.status === "succeeded"
      ? "var(--ob-success)"
      : job?.status === "failed" || job?.status === "cancelled"
        ? "var(--ob-danger)"
        : "var(--ob-accent)";
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" }}>
      <PanelHead
        eyebrow={locale === "ko" ? "Step 05 · 모션그래픽" : "Step 05 · Motion Graphics"}
        title={locale === "ko" ? "코드 렌더 광고" : "Code-Rendered Ad"}
        subtitle={
          locale === "ko"
            ? `${production.brief.brandOrProduct || production.brief.title} · ${production.brief.durationSec || 30}초 · API 없는 로컬 렌더`
            : `${production.brief.brandOrProduct || production.brief.title} · ${production.brief.durationSec || 30}s · API-free local render`
        }
        icon={<Glyph name="layers" size={18} />}
        right={
          job ? (
            <GhostButton onClick={onReset}>
              <Glyph name="x" size={14} /> {locale === "ko" ? "리셋" : "Reset"}
            </GhostButton>
          ) : (
            <PrimaryButton onClick={onStart} disabled={generating}>
              <Glyph name="sparkle" size={14} />
              {locale === "ko" ? (generating ? "렌더 중…" : "Motion Ad 렌더") : generating ? "Rendering…" : "Render Motion Ad"}
            </PrimaryButton>
          )
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.25fr) minmax(260px, 0.85fr)", gap: 16, alignItems: "start" }}>
        <Card style={{ padding: 16 }}>
          {mp4 ? (
            <video controls src={toLocalMediaSrc(mp4.url)} style={{ width: "100%", borderRadius: 10, background: "#111", aspectRatio: production.brief.aspect === "9:16" ? "9 / 16" : "16 / 9", objectFit: "contain" }} />
          ) : (
            <div style={{ aspectRatio: production.brief.aspect === "9:16" ? "9 / 16" : "16 / 9", borderRadius: 10, background: "linear-gradient(135deg,#f7f7f2,#eef2ed 52%,#f6f1e8)", border: "1px solid var(--ob-edge)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 18, borderRadius: 14, border: "1px solid rgba(16,24,32,0.12)", background: "rgba(255,255,255,0.74)", boxShadow: "0 24px 70px rgba(16,24,32,0.14)" }} />
              <div style={{ position: "absolute", left: 42, top: 42, fontSize: 13, fontWeight: 800, color: "#0e6a66" }}>OBERON MOTION</div>
              <div style={{ position: "absolute", left: 42, bottom: 48, right: 42, fontSize: 30, lineHeight: 1.02, fontWeight: 830, color: "#101820" }}>
                Agentlas<br />Motion Ad
              </div>
            </div>
          )}
        </Card>

        <Card style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusTone }} />
            <span style={{ fontSize: 14, fontWeight: 750, color: "var(--ob-ink)" }}>
              {job?.message ?? (locale === "ko" ? "대기 중" : "Waiting")}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>{job?.progress.percent ?? 0}%</span>
          </div>
          <Meter value={job?.progress.percent ?? 0} max={100} color={statusTone} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
            <Metric label={locale === "ko" ? "엔진" : "Engine"} value="Chromium" />
            <Metric label={locale === "ko" ? "인코더" : "Encoder"} value="ffmpeg" />
            <Metric label={locale === "ko" ? "길이" : "Length"} value={`${job?.durationSec ?? production.brief.durationSec ?? 30}s`} />
            <Metric label="API" value="0" />
          </div>
          {job?.error && <div style={{ marginTop: 12, fontSize: 12, color: "var(--ob-danger)", lineHeight: 1.45 }}>{job.error}</div>}
          {files.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
              {mp4 && <FileLink file={mp4} label="MP4" />}
              {preview && <FileLink file={preview} label="HTML" />}
              {promptPack && <FileLink file={promptPack} label="Prompt" />}
            </div>
          )}
          {job && onOpenOutput && (
            <GhostButton onClick={() => onOpenOutput(job.id)} style={{ marginTop: 14 }}>
              {locale === "ko" ? "출력 폴더 열기" : "Open output folder"}
            </GhostButton>
          )}
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, background: "var(--ob-surface)", border: "1px solid var(--ob-edge)" }}>
      <div style={{ fontSize: 10.5, color: "var(--ob-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 750, color: "var(--ob-ink)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function FileLink({ file, label }: { file: OberonMotionAdFile; label: string }) {
  return (
    <a
      href={file.url}
      download={file.name}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 34, padding: "0 11px", borderRadius: 999, border: "1px solid var(--ob-edge)", color: "var(--ob-ink)", background: "var(--ob-paper)", fontSize: 12, fontWeight: 750, textDecoration: "none" }}
    >
      {label}
      <span style={{ color: "var(--ob-muted)", fontWeight: 500 }}>{formatBytes(file.sizeBytes)}</span>
    </a>
  );
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
