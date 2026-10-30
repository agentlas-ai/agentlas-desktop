"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./Icon";
import { useT } from "@/lib/i18n";
import { chatMediaBadge, type ChatMediaKind } from "@/lib/chat-media";
import styles from "./ChatMediaTile.module.css";

export interface ChatMediaItem<F> {
  kind: ChatMediaKind;
  label: string;
  /** Absolute local path, already resolved by the Markdown layer. */
  path: string;
  /** agentlas://localfile URL of the same path. */
  src: string;
  /** What the right panel opens. */
  file: F;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Enlarged picture: no frame; the close mark stays faint until the pointer reaches it. */
export function ChatMediaLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const { locale } = useT();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); opener?.focus?.({ preventScroll: true }); };
  }, [onClose]);
  return createPortal(
    <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.lightboxImage} src={src} alt={name} />
      <button ref={close} type="button" className={styles.lightboxClose} aria-label={locale === "ko" ? "닫기" : "Close"}
        onClick={(event) => { event.stopPropagation(); onClose(); }}><IconClose size={20} /></button>
    </div>,
    document.body,
  );
}

/** A picture in the conversation. `onMissing` lets the caller show what it shows for a file that is gone. */
export function ChatPicture({ src, name, onMissing }: { src: string; name: string; onMissing: () => void }) {
  const [open, setOpen] = useState(false);
  const closeViewer = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className={styles.pictureButton} title={name} aria-label={name} onClick={() => setOpen(true)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.picture} src={src} alt={name} onError={onMissing} />
      </button>
      {open && <ChatMediaLightbox src={src} name={name} onClose={closeViewer} />}
    </>
  );
}

function AudioTile({ src, name, onMissing }: { src: string; name: string; onMissing: () => void }) {
  const { locale } = useT();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const toggle = () => { const element = audio.current; if (!element) return; if (element.paused) void element.play().catch(onMissing); else element.pause(); };
  return (
    <div className={styles.audio}>
      <button type="button" className={styles.audioPlay} onClick={toggle} aria-label={playing ? (locale === "ko" ? "일시정지" : "Pause") : (locale === "ko" ? "재생" : "Play")}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          {playing ? <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" /> : <path d="M3.5 1.2v11.6L12.5 7z" />}
        </svg>
      </button>
      <div className={styles.audioBody}>
        <span className={styles.audioName} title={name}>{name}</span>
        <span className={styles.audioTrack}>
          <input className={styles.audioRange} type="range" min={0} max={duration || 0} step={0.1} value={Math.min(time, duration || 0)} aria-label={name}
            onChange={(event) => { const element = audio.current; if (element) element.currentTime = Number(event.target.value); }} />
          <span className={styles.audioTime}>{formatTime(time)} / {formatTime(duration)}</span>
        </span>
      </div>
      <audio ref={audio} src={src} preload="metadata" onError={onMissing} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
    </div>
  );
}

function DocumentTile<F>({ item, onOpen }: { item: ChatMediaItem<F>; onOpen: (file: F) => void }) {
  const [hasCover, setHasCover] = useState(true);
  const mark = chatMediaBadge(item.path);
  return (
    <button type="button" className={styles.document} data-kind={item.kind} data-mark={mark} data-blank={hasCover ? undefined : "true"}
      title={item.label} aria-label={`${mark}: ${item.label}`} onClick={() => onOpen(item.file)}>
      {hasCover
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className={styles.cover} src={`agentlas://localthumb/?w=640&p=${encodeURIComponent(item.path)}`} alt="" onError={() => setHasCover(false)} />
        : <span className={styles.blank}><span className={styles.blankName}>{item.label}</span></span>}
      <span className={styles.mark} aria-hidden="true">{mark}</span>
    </button>
  );
}

function Tile<F>({ item, onOpen }: { item: ChatMediaItem<F>; onOpen: (file: F) => void }) {
  const [missing, setMissing] = useState(false);
  const markMissing = useCallback(() => setMissing(true), []);
  // A file that cannot be shown stays what it was before: a link to the panel, which says why.
  if (missing) return <a href={item.src} onClick={(event) => { event.preventDefault(); onOpen(item.file); }} style={{ color: "var(--accent)", textDecoration: "underline" }}>{item.label}</a>;
  if (item.kind === "image") return <ChatPicture src={item.src} name={item.label} onMissing={markMissing} />;
  if (item.kind === "video") return <video className={styles.video} src={`${item.src}#t=0.05`} controls playsInline preload="metadata" aria-label={item.label} title={item.label} onError={markMissing} />;
  if (item.kind === "audio") return <AudioTile src={item.src} name={item.label} onMissing={markMissing} />;
  return <DocumentTile item={item} onOpen={onOpen} />;
}

export function ChatMediaGroup<F>({ items, onOpen }: { items: ChatMediaItem<F>[]; onOpen: (file: F) => void }) {
  return <div className={styles.group} data-chat-media="true">{items.map((item) => <Tile key={item.path} item={item} onOpen={onOpen} />)}</div>;
}
