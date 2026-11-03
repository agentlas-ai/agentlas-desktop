"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconClose, IconFileUp, IconFolder } from "../Icon";
import { MediaViewer } from "./MediaViewer";
import styles from "./MediaStrip.module.css";

/**
 * One message's (or one composer's) pictures, videos and files as a horizontal strip of real thumbnails (owner:
 * "좌우 스와이프 되면서 사진 보여지게"). The strip scrolls sideways with a trackpad swipe or ←/→ when it has focus; a picture or
 * video opens the full-screen viewer (←/→, swipe, Esc). Shared by One/Hope, Work and the Build composer.
 */
export type MediaStripKind = "image" | "video" | "file" | "folder";

export interface MediaStripItem {
  key: string;
  kind: MediaStripKind;
  name: string;
  /** Full-size source for the viewer (pictures and videos). */
  src?: string;
  /** Small source for the tile (a picture, or a video's poster). */
  thumbSrc?: string;
  /** A short line under a file's name (its size). */
  meta?: string;
  /** Files and folders open with this instead of the viewer. */
  onOpenFile?: () => void;
  /** Composer only: the × on the tile. */
  onRemove?: () => void;
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm|ogv|3gp|3g2|mkv|avi)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;

/** Picture, video or file, from a media type with the name as the fallback. */
export function mediaKindOf(mediaType: string | undefined, name: string): MediaStripKind {
  const type = (mediaType ?? "").toLowerCase();
  if (type === "application/vnd.agentlas.directory+json") return "folder";
  if (type.startsWith("video/") || (!type.startsWith("image/") && VIDEO_EXTENSIONS.test(name))) return "video";
  if (type.startsWith("image/") || IMAGE_EXTENSIONS.test(name)) return "image";
  return "file";
}

/** A thumbnail-sized source for an attachment capability URL (Main resizes; electron/media/attachment-preview.ts). */
export function mediaThumbSrc(src: string | undefined, edge = 264): string | undefined {
  if (!src) return undefined;
  if (/^agentlas:\/\/chat-attachment\/[0-9a-f-]{36}$/i.test(src)) return `${src}?w=${edge}`;
  return src;
}

function Tile({ item, variant, locale, onOpen, onKeyDown }: {
  item: MediaStripItem;
  variant: "message" | "composer";
  locale: "ko" | "en";
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [frameFailed, setFrameFailed] = useState(false);
  const ko = locale === "ko";
  const media = item.kind === "image" || item.kind === "video";
  const thumb = media && !thumbFailed ? item.thumbSrc ?? (item.kind === "image" ? item.src : undefined) : undefined;
  // A video whose poster could not be made (a just-picked file, a host without a thumbnailer) shows its own first frame.
  const frame = item.kind === "video" && !thumb && !frameFailed && item.src ? `${item.src}#t=0.1` : undefined;
  return (
    <div style={{ position: "relative", flex: "0 0 auto" }} data-media-tile={item.kind}>
      <button
        type="button"
        className={styles.tile}
        data-kind={media && !thumb && item.kind === "image" ? "file" : item.kind}
        title={item.name}
        aria-label={item.kind === "video" ? `${item.name} (${ko ? "영상" : "video"})` : item.name}
        onClick={onOpen}
        onKeyDown={onKeyDown}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.thumb} src={thumb} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setThumbFailed(true)} />
        ) : frame ? (
          <video className={styles.thumb} src={frame} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" onError={() => setFrameFailed(true)} />
        ) : (
          <span className={styles.fileBody}>
            <span className={styles.fileIcon} aria-hidden="true">{item.kind === "folder" ? <IconFolder size={16} /> : <IconFileUp size={16} />}</span>
            <span className={styles.fileName}>{item.name}</span>
            {item.meta && <span className={styles.fileMeta}>{item.meta}</span>}
          </span>
        )}
        {item.kind === "video" && <span className={styles.play} aria-hidden="true" />}
        {media && (thumb || frame) && variant === "message" && item.kind === "video" && item.meta && <span className={styles.badge}>{item.meta}</span>}
      </button>
      {item.onRemove && (
        <button type="button" className={styles.remove} aria-label={ko ? `${item.name} 빼기` : `Remove ${item.name}`} onClick={item.onRemove}>
          <IconClose size={12} />
        </button>
      )}
    </div>
  );
}

export function MediaStrip({ items, variant = "message", align = "start", locale, label }: {
  items: readonly MediaStripItem[];
  variant?: "message" | "composer";
  align?: "start" | "end";
  locale: "ko" | "en";
  /** Accessible name of the strip. */
  label?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const viewable = useMemo(() => items.filter((item) => (item.kind === "image" || item.kind === "video") && item.src), [items]);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const closeViewer = useCallback(() => setViewerAt(null), []);
  useEffect(() => { if (viewerAt !== null && viewerAt >= viewable.length) setViewerAt(null); }, [viewerAt, viewable.length]);

  const moveFocus = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tiles = Array.from(stripRef.current?.querySelectorAll<HTMLButtonElement>(`.${styles.tile}`) ?? []);
    if (!tiles.length) return;
    event.preventDefault();
    const current = tiles.indexOf(document.activeElement as HTMLButtonElement);
    const next = current < 0 ? (event.key === "ArrowRight" ? 0 : tiles.length - 1)
      : Math.max(0, Math.min(tiles.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
    tiles[next].focus({ preventScroll: true });
    tiles[next].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, []);

  if (!items.length) return null;
  const ko = locale === "ko";
  return (
    <>
      <div className={styles.frame} data-align={align} data-variant={variant}>
      <div
        ref={stripRef}
        className={styles.strip}
        data-variant={variant}
        data-align={align}
        data-media-strip={variant}
        role="list"
        aria-label={label ?? (ko ? `첨부 ${items.length}개` : `${items.length} attachments`)}
        tabIndex={-1}
        onKeyDown={moveFocus}
      >
        {items.map((item) => (
          <div role="listitem" key={item.key} style={{ display: "contents" }}>
            <Tile
              item={item}
              variant={variant}
              locale={locale}
              onKeyDown={moveFocus}
              onOpen={() => {
                const at = viewable.indexOf(item);
                if (at >= 0) setViewerAt(at);
                else item.onOpenFile?.();
              }}
            />
          </div>
        ))}
        {variant === "composer" && items.length > 1 && <span className={styles.count}>{ko ? `${items.length}개` : `${items.length} items`}</span>}
      </div>
      </div>
      {viewerAt !== null && <MediaViewer items={viewable} start={viewerAt} locale={locale} onClose={closeViewer} />}
    </>
  );
}
