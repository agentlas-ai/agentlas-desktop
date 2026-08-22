"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import styles from "./LiveOutputViewer.module.css";

const UniversalFileViewerEngine = dynamic(
  () => import("./UniversalFileViewerEngine").then((module) => module.UniversalFileViewerEngine),
  {
    ssr: false,
    loading: () => <div className={styles.loading} role="status"><span /></div>,
  },
);

export type LiveOutputKind = "image" | "video" | "audio" | "pdf" | "document" | "spreadsheet" | "presentation" | "archive" | "data";

export function LiveOutputViewer({
  source,
  name,
  kind,
  mimeType,
  size,
  locale,
  compact = false,
  fill = false,
}: {
  source: string;
  name: string;
  kind: LiveOutputKind;
  mimeType?: string;
  size?: number;
  locale: "ko" | "en";
  compact?: boolean;
  /** The in-app result sidebar occupies the whole available viewer stage. */
  fill?: boolean;
}) {
  const [mediaState, setMediaState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => setMediaState("loading"), [source]);

  if (kind === "image") {
    return <div className={styles.mediaStage} data-media-kind="image" data-compact={compact} data-fill={fill} data-state={mediaState}>
      {/* Opaque Main capabilities and authorized local media URLs only. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={source} alt={name} draggable={false} decoding="async" loading="eager" onLoad={() => setMediaState("ready")} onError={() => setMediaState("error")} />
      <MediaStatus state={mediaState} locale={locale} />
    </div>;
  }
  if (kind === "video") {
    return <div className={styles.mediaStage} data-media-kind="video" data-compact={compact} data-fill={fill} data-state={mediaState}>
      <video src={source} aria-label={name} controls playsInline preload="auto" disablePictureInPicture={false} onCanPlay={() => setMediaState("ready")} onError={() => setMediaState("error")} />
      <MediaStatus state={mediaState} locale={locale} />
    </div>;
  }
  if (kind === "audio") {
    return <div className={`${styles.mediaStage} ${styles.audioStage}`} data-media-kind="audio" data-compact={compact} data-fill={fill} data-state={mediaState}>
      <div className={styles.audioPulse} aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <audio src={source} aria-label={name} controls preload="auto" onCanPlay={() => setMediaState("ready")} onError={() => setMediaState("error")} />
      <MediaStatus state={mediaState} locale={locale} />
    </div>;
  }
  return <UniversalFileViewerEngine source={source} name={name} mimeType={mimeType} size={size} locale={locale} compact={compact} fill={fill} />;
}

function MediaStatus({ state, locale }: { state: "loading" | "ready" | "error"; locale: "ko" | "en" }) {
  if (state === "ready") return null;
  return <div className={styles.mediaStatus} data-state={state} role={state === "error" ? "alert" : "status"}>
    {state === "loading" && <span />}
    {state === "error"
      ? (locale === "ko" ? "이 미디어를 인앱에서 재생하지 못했습니다." : "This media could not play in the app.")
      : (locale === "ko" ? "재생 준비 중…" : "Preparing playback…")}
  </div>;
}
