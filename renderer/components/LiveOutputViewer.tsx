"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMediaDisplayPreferences } from "@/lib/media-display-preferences";
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
  placement = "chat",
  imageActions = false,
  onOpenExternal,
  openExternalHint,
  onExpand,
  fileInfo,
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
  /** Sidebars respect the user's per-media visibility settings; chat does not. */
  placement?: "chat" | "sidebar";
  /** Real image results expose the same copy/download contract in every chat surface. */
  imageActions?: boolean;
  /** Present only when Main can really open the exact local file or URL. */
  onOpenExternal?: () => void | Promise<void>;
  /** Tells users whether Open targets an original path or a read-only copy. */
  openExternalHint?: string;
  /** Expands the owning rail; omitted when that surface has no width controller. */
  onExpand?: () => void;
  /** Optional exact binding metadata kept behind the toolbar's collapsed info control. */
  fileInfo?: { sha256: string; binding: string; tabId: string };
}) {
  const [observedMedia, setObservedMedia] = useState<{
    source: string;
    state: "loading" | "ready" | "error";
  }>({ source, state: "loading" });
  const mediaState = observedMedia.source === source ? observedMedia.state : "loading";
  const settleMedia = (state: "ready" | "error") => setObservedMedia({ source, state });
  const [imageActionState, setImageActionState] = useState<"idle" | "copying" | "copied" | "saving" | "saved" | "error">("idle");
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number } | null>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const { preferences } = useMediaDisplayPreferences();

  useLayoutEffect(() => {
    if (!imageMenu || !imageMenuRef.current) return;
    const rect = imageMenuRef.current.getBoundingClientRect();
    const nextX = Math.max(8, Math.min(imageMenu.x, window.innerWidth - rect.width - 8));
    const nextY = Math.max(8, Math.min(imageMenu.y, window.innerHeight - rect.height - 8));
    if (nextX !== imageMenu.x || nextY !== imageMenu.y) {
      setImageMenu({ x: nextX, y: nextY });
      return;
    }
    imageMenuRef.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [imageMenu]);

  useEffect(() => {
    if (!imageMenu) return;
    const dismiss = (event: Event) => {
      if (event instanceof PointerEvent && imageMenuRef.current?.contains(event.target as Node)) return;
      setImageMenu(null);
    };
    const dismissOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImageMenu(null);
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", dismissOnKey, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", dismissOnKey, true);
    };
  }, [imageMenu]);

  const runImageAction = async (action: "copy" | "save") => {
    setImageActionState(action === "copy" ? "copying" : "saving");
    try {
      const result = action === "copy"
        ? await window.agentlas.media.copyImage({ src: source, suggestedName: name })
        : await window.agentlas.media.saveImage({ src: source, suggestedName: name });
      if (result.ok) setImageActionState(action === "copy" ? "copied" : "saved");
      else if ("canceled" in result && result.canceled) setImageActionState("idle");
      else setImageActionState("error");
    } catch {
      setImageActionState("error");
    }
  };

  const hiddenMedia = placement === "sidebar"
    && ((kind === "image" && !preferences.image)
      || (kind === "video" && !preferences.video)
      || (kind === "audio" && !preferences.audio));

  if (hiddenMedia) {
    return <div className={styles.mediaHidden} role="status">
      {locale === "ko" ? "이 미디어는 설정에서 숨겨져 있습니다." : "This media is hidden by your settings."}
    </div>;
  }

  if (kind === "image") {
    const stage = <div className={styles.mediaStage} data-media-kind="image" data-compact={compact} data-fill={fill} data-state={mediaState}>
        {/* Opaque Main capabilities and authorized local media URLs only. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={source} alt={name} draggable={false} decoding="async" loading="eager" onLoad={() => settleMedia("ready")} onError={() => settleMedia("error")} />
        <MediaStatus state={mediaState} locale={locale} />
      </div>;
    if (!imageActions) return stage;
    const ko = locale === "ko";
    return <div
      className={styles.imageActionShell}
      data-fill={fill}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setImageMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {stage}
      <div className={styles.imageActionBar}>
        <button type="button" onClick={() => void runImageAction("copy")} disabled={imageActionState === "copying" || imageActionState === "saving"}>
          {imageActionState === "copying" ? (ko ? "복사 중…" : "Copying…") : (ko ? "이미지 복사" : "Copy image")}
        </button>
        <button type="button" onClick={() => void runImageAction("save")} disabled={imageActionState === "copying" || imageActionState === "saving"}>
          {imageActionState === "saving" ? (ko ? "준비 중…" : "Preparing…") : (ko ? "다운로드" : "Download")}
        </button>
        {imageActionState === "copied" || imageActionState === "saved" || imageActionState === "error" ? <span role="status" data-error={imageActionState === "error"}>
          {imageActionState === "copied" ? (ko ? "복사됨" : "Copied") : imageActionState === "saved" ? (ko ? "저장됨" : "Saved") : (ko ? "처리하지 못했습니다" : "Action failed")}
        </span> : null}
      </div>
      {imageMenu ? <div ref={imageMenuRef} className={styles.imageContextMenu} role="menu" style={{ left: imageMenu.x, top: imageMenu.y }}>
        <button type="button" role="menuitem" onClick={() => { setImageMenu(null); void runImageAction("copy"); }}>{ko ? "이미지 복사" : "Copy image"}</button>
        <button type="button" role="menuitem" onClick={() => { setImageMenu(null); void runImageAction("save"); }}>{ko ? "다운로드" : "Download"}</button>
      </div> : null}
    </div>;
  }
  if (kind === "video") {
    return <div className={styles.mediaStage} data-media-kind="video" data-compact={compact} data-fill={fill} data-state={mediaState}>
      <video src={source} aria-label={name} controls playsInline preload="auto" disablePictureInPicture={false} onCanPlay={() => settleMedia("ready")} onError={() => settleMedia("error")} />
      <MediaStatus state={mediaState} locale={locale} />
    </div>;
  }
  if (kind === "audio") {
    return <div className={`${styles.mediaStage} ${styles.audioStage}`} data-media-kind="audio" data-compact={compact} data-fill={fill} data-state={mediaState}>
      <div className={styles.audioPulse} aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <audio src={source} aria-label={name} controls preload="auto" onCanPlay={() => settleMedia("ready")} onError={() => settleMedia("error")} />
      <MediaStatus state={mediaState} locale={locale} />
    </div>;
  }
  return <UniversalFileViewerEngine source={source} name={name} mimeType={mimeType} size={size} locale={locale} compact={compact} fill={fill} onOpenExternal={onOpenExternal} openExternalHint={openExternalHint} onExpand={onExpand} fileInfo={fileInfo} />;
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
