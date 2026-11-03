"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChatFileItem } from "@/lib/chat-files";
import { formatChatFileSize } from "@/lib/chat-files";
import { announceChatFiles } from "@/lib/visual-artifacts";
import { ChatFileCards } from "../ChatFileExperience";
import { MediaStrip, mediaKindOf, mediaThumbSrc, type MediaStripItem } from "./MediaStrip";

/**
 * A message's attachments: the owner's pictures and videos as one horizontal strip of thumbnails, every other file as the
 * existing file card (media-carousel). A message whose file group also carries the legacy inline copies of its
 * pictures (store/chat-message-attachments.ts chatFileDisplayImages) shows each picture once: an inline copy whose bytes
 * equal a file of the group is not drawn again.
 */
const digests = new Map<string, Promise<string | null>>();

function digestOf(url: string): Promise<string | null> {
  let pending = digests.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
      .then((hash) => Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""))
      .catch(() => null);
    digests.set(url, pending);
    if (digests.size > 512) digests.delete(digests.keys().next().value as string);
  }
  return pending;
}

function isOwnerMedia(file: ChatFileItem): boolean {
  if (file.kind !== "file" || !file.fileUrl || file.provenance !== "user-attachment") return false;
  const kind = mediaKindOf(file.mediaType, file.name);
  return kind === "image" || kind === "video";
}

export function MessageAttachments({ files, imageUrls, locale, onOpenFile, align = "end" }: {
  files?: ChatFileItem[];
  imageUrls?: string[];
  locale: "ko" | "en";
  onOpenFile?: (file: ChatFileItem) => void;
  align?: "start" | "end";
}) {
  const allFiles = useMemo(() => files ?? [], [files]);
  const inline = useMemo(() => imageUrls ?? [], [imageUrls]);
  const media = useMemo(() => allFiles.filter(isOwnerMedia), [allFiles]);
  const others = useMemo(() => allFiles.filter((file) => !isOwnerMedia(file)), [allFiles]);
  const groupDigests = useMemo(() => new Set(media.map((file) => file.sha256.toLowerCase())), [media]);
  const needsCheck = inline.length > 0 && media.some((file) => mediaKindOf(file.mediaType, file.name) === "image");
  const [duplicates, setDuplicates] = useState<ReadonlySet<string> | null>(needsCheck ? null : new Set());

  useEffect(() => { if (media.length) announceChatFiles(media); }, [media]);
  useEffect(() => {
    if (!needsCheck) { setDuplicates(new Set()); return; }
    let current = true;
    setDuplicates(null);
    void Promise.all(inline.map(async (url) => { const sha = await digestOf(url); return sha && groupDigests.has(sha) ? url : null; }))
      .then((found) => { if (current) setDuplicates(new Set(found.filter((url): url is string => Boolean(url)))); })
      .catch(() => { if (current) setDuplicates(new Set()); });
    return () => { current = false; };
  }, [needsCheck, inline, groupDigests]);

  const items = useMemo<MediaStripItem[]>(() => {
    const inlineItems: MediaStripItem[] = duplicates === null ? [] : inline
      .filter((url) => !duplicates.has(url))
      .map((url, index) => ({ key: `inline:${index}:${url.slice(0, 80)}`, kind: "image", name: locale === "ko" ? `사진 ${index + 1}` : `Picture ${index + 1}`, src: url, thumbSrc: mediaThumbSrc(url) }));
    const fileItems: MediaStripItem[] = media.map((file) => {
      const kind = mediaKindOf(file.mediaType, file.name);
      return {
        key: `file:${file.id}`,
        kind,
        name: file.name,
        src: file.fileUrl ?? undefined,
        thumbSrc: mediaThumbSrc(file.fileUrl ?? undefined),
        meta: formatChatFileSize(file.size),
        ...(onOpenFile ? { onOpenFile: () => onOpenFile(file) } : {}),
      };
    });
    return [...inlineItems, ...fileItems];
  }, [duplicates, inline, media, locale, onOpenFile]);

  return (
    <>
      {items.length > 0 && <MediaStrip items={items} variant="message" align={align} locale={locale} />}
      {others.length > 0 && onOpenFile && <ChatFileCards files={others} locale={locale} onOpen={onOpenFile} />}
    </>
  );
}
