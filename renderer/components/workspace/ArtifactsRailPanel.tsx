"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileThumb } from "./FileThumb";
import { IconArrowLeft, IconFileText, IconFileUp, IconFolder, IconImage, IconLayers } from "@/components/Icon";
import { ChartBlock } from "@/components/ChartBlock";
import { HtmlVisualBlock } from "@/components/HtmlVisualBlock";
import { formatChatFileSize, isChatFileItem, requestChatFileOpen, viewerKindForChatFile, type ChatFileItem } from "@/lib/chat-files";
import { requestOneArtifactOpen } from "@/lib/one-artifact-open";
import type { OneActivityArtifact } from "@/lib/one-activity";
import {
  CHAT_FILES_SEEN_EVENT,
  VISUAL_OPEN_EVENT,
  VISUAL_SEEN_EVENT,
  isVisualArtifact,
  type VisualArtifact,
} from "@/lib/visual-artifacts";
import styles from "./ArtifactsRailPanel.module.css";

type Locale = "ko" | "en";

/**
 * 이 대화에서 생긴 것 — 차트·시각물·파일 칩·실행 산출물 — 을 한 목록으로. 누르면 **이미 있는** 뷰어로
 * 연다(엑셀·CSV 는 @file-viewer 스프레드시트 그리드, 문서·PDF 는 쪽 미리보기). 새 뷰어를 만들지 않는다.
 *
 * 목록은 블록·칩이 그려질 때 스스로 알린다(셸 수정 없음). 같은 대화(chatId)의 것만 받는다.
 */
export function useArtifactsRail(chatId: string | null) {
  const [files, setFiles] = useState<ChatFileItem[]>([]);
  const [visuals, setVisuals] = useState<VisualArtifact[]>([]);
  const [opened, setOpened] = useState<VisualArtifact | null>(null);
  const [openRequest, setOpenRequest] = useState(0);

  useEffect(() => {
    setFiles([]);
    setVisuals([]);
    setOpened(null);
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return undefined;
    const onFiles = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!Array.isArray(detail)) return;
      const mine = detail.filter((file): file is ChatFileItem => isChatFileItem(file) && file.chatId === chatId);
      if (mine.length === 0) return;
      setFiles((current) => {
        const known = new Set(current.map((file) => file.tabId));
        const added = mine.filter((file) => !known.has(file.tabId));
        return added.length ? [...current, ...added] : current;
      });
    };
    const onSeen = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isVisualArtifact(detail) || detail.chatId !== chatId) return;
      setVisuals((current) => current.some((item) => item.id === detail.id) ? current : [...current, detail]);
    };
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isVisualArtifact(detail) || detail.chatId !== chatId) return;
      setVisuals((current) => current.some((item) => item.id === detail.id) ? current : [...current, detail]);
      setOpened(detail);
      setOpenRequest((value) => value + 1);
    };
    window.addEventListener(CHAT_FILES_SEEN_EVENT, onFiles);
    window.addEventListener(VISUAL_SEEN_EVENT, onSeen);
    window.addEventListener(VISUAL_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(CHAT_FILES_SEEN_EVENT, onFiles);
      window.removeEventListener(VISUAL_SEEN_EVENT, onSeen);
      window.removeEventListener(VISUAL_OPEN_EVENT, onOpen);
    };
  }, [chatId]);

  return { files, visuals, opened, setOpened, openRequest };
}

function kindLabel(name: string, locale: Locale): string {
  const kind = viewerKindForChatFile(name, "file");
  const ko: Record<string, string> = {
    spreadsheet: "스프레드시트", document: "문서", pdf: "PDF", presentation: "발표자료", image: "이미지", video: "영상",
    audio: "소리", markdown: "마크다운", json: "JSON", text: "텍스트", archive: "압축", browser: "링크", binary: "파일",
  };
  const en: Record<string, string> = {
    spreadsheet: "Spreadsheet", document: "Document", pdf: "PDF", presentation: "Slides", image: "Image", video: "Video",
    audio: "Audio", markdown: "Markdown", json: "JSON", text: "Text", archive: "Archive", browser: "Link", binary: "File",
  };
  return (locale === "ko" ? ko : en)[kind] ?? (locale === "ko" ? "파일" : "File");
}

function ChartGlyph() {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M2.5 13.5h11" /><path d="M4.5 11V7.5" /><path d="M8 11V4" /><path d="M11.5 11V6" />
  </svg>;
}

function SheetGlyph() {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11" />
  </svg>;
}

function fileGlyph(name: string, directory: boolean) {
  if (directory) return <IconFolder size={14} />;
  const kind = viewerKindForChatFile(name, "file");
  if (kind === "spreadsheet") return <SheetGlyph />;
  if (kind === "image") return <IconImage size={14} />;
  if (kind === "presentation") return <IconLayers size={14} />;
  if (kind === "document" || kind === "pdf" || kind === "markdown" || kind === "text") return <IconFileText size={14} />;
  return <IconFileUp size={14} />;
}

async function openChatFileFromList(file: ChatFileItem): Promise<void> {
  const needsText = file.kind === "file"
    && ["markdown", "json", "text", "browser"].includes(file.viewer.viewerKind)
    && Boolean(file.fileUrl)
    && !file.viewer.content;
  if (!needsText) { requestChatFileOpen(file); return; }
  try {
    const response = await fetch(file.fileUrl!);
    if (!response.ok) throw new Error(String(response.status));
    requestChatFileOpen({ ...file, viewer: { ...file.viewer, content: await response.text(), available: true, reason: undefined } });
  } catch {
    requestChatFileOpen({ ...file, viewer: { ...file.viewer, available: false } });
  }
}

function extensionOf(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? name;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toUpperCase().slice(0, 6) : "FILE";
}

/** "스프레드시트 · XLSX" — 종류와 확장자가 같으면(PDF) 한 번만. */
function kindMeta(name: string, locale: Locale): string {
  const label = kindLabel(name, locale);
  const ext = extensionOf(name);
  return label.toUpperCase() === ext ? label : `${label} · ${ext}`;
}

function toneFor(kind: string): string {
  if (kind === "spreadsheet") return "green";
  if (kind === "pdf" || kind === "presentation") return "coral";
  if (kind === "document" || kind === "markdown" || kind === "text" || kind === "json") return "blue";
  if (kind === "image" || kind === "video") return "violet";
  return "neutral";
}

export function artifactsRailCount(input: { items: OneActivityArtifact[]; files: ChatFileItem[]; visuals: VisualArtifact[] }): number {
  return input.items.length + input.files.length + input.visuals.length;
}

export function ArtifactsRailPanel({
  chatId = null,
  locale,
  items,
  files,
  visuals,
  opened,
  onOpenVisual,
  onBack,
}: {
  chatId?: string | null;
  locale: Locale;
  items: OneActivityArtifact[];
  files: ChatFileItem[];
  visuals: VisualArtifact[];
  opened: VisualArtifact | null;
  onOpenVisual: (visual: VisualArtifact) => void;
  onBack: () => void;
}) {
  const ko = locale === "ko";
  const runOutputs = useMemo(
    () => items.filter((item) => !files.some((file) => file.name === item.label)),
    [files, items],
  );
  const openRun = useCallback((item: OneActivityArtifact) => requestOneArtifactOpen({ binding: item.binding, label: item.label }), []);
  // 파일 카드는 Claude 처럼 큰 파일 뷰어로 연다(레퍼런스 f011·f014: 카드 → 오른쪽 뷰어). xlsx 는 그 뷰어 안에
  // Data·Charts·표 도구 탭이 있다(정렬·필터·빠른 차트는 "표 도구"). 목록 안에서 따로 여는 길은 두지 않는다.
  const openFile = useCallback((file: ChatFileItem) => { void openChatFileFromList(file); }, []);

  if (opened) {
    return <section className={styles.viewer} data-artifacts-viewer={opened.kind}>
      <header className={styles.viewerHead}>
        <button type="button" className={styles.back} onClick={onBack} aria-label={ko ? "산출물 목록으로" : "Back to artifacts"}>
          <IconArrowLeft size={14} />
        </button>
        <strong title={opened.title}>{opened.title}</strong>
      </header>
      {opened.kind === "chart"
        ? <ChartBlock key={opened.id} code="" presetSpec={opened.spec} blockId={`panel:${opened.id}`} size="panel" fallback={null} />
        : <HtmlVisualBlock key={opened.id} html={opened.html} title={opened.title} blockId={`panel:${opened.id}`} size="panel" fallback={null} />}
    </section>;
  }

  const empty = visuals.length + files.length + runOutputs.length === 0;
  return <section className={styles.list} data-artifacts-list="true" aria-label={ko ? "이 대화의 산출물" : "Artifacts in this chat"}>
    <div className={styles.shell}>
      <h2 className={styles.title}>{ko ? "산출물" : "Artifacts"}</h2>
      {empty && <p className={styles.empty}>{ko ? "차트·표·문서가 만들어지면 여기에 모입니다." : "Charts, sheets and documents from this chat collect here."}</p>}
      {(files.length > 0 || runOutputs.length > 0) && <div className={styles.cards}>
        {files.map((file) => {
          const kind = file.kind === "directory" ? "directory" : viewerKindForChatFile(file.name, "file");
          return <button key={file.tabId} type="button" className={styles.card} data-artifact-row="file" data-artifact-kind={kind}
            onClick={() => openFile(file)} title={file.name}>
            <span className={styles.tile} data-tone={toneFor(kind)}>{fileGlyph(file.name, file.kind === "directory")}</span>
            <span className={styles.cardCopy}>
              <span className={styles.name}>{file.name}</span>
              <span className={styles.meta}>
                {file.kind === "directory" ? (ko ? "폴더" : "Folder") : kindMeta(file.name, locale)}
                {file.provenance === "user-attachment" ? (ko ? " · 내 첨부" : " · Yours") : ""}
              </span>
            </span>
            <span className={styles.open} aria-hidden="true"><IconFolder size={16} /></span>
          </button>;
        })}
        {runOutputs.map((item) => {
          const kind = item.kind === "image" ? "image" : viewerKindForChatFile(item.label, "file");
          return <button key={item.id} type="button" className={styles.card} data-artifact-row="run" data-artifact-kind={kind} onClick={() => openRun(item)} title={item.label}>
            <span className={styles.tile} data-tone={toneFor(kind)}>{item.kind === "image" ? <IconImage size={16} /> : fileGlyph(item.label, false)}</span>
            <span className={styles.cardCopy}>
              <span className={styles.name}>{item.label}</span>
              <span className={styles.meta}>{item.kind === "image" ? `${ko ? "이미지" : "Image"} · ${extensionOf(item.label)}` : kindMeta(item.label, locale)}</span>
            </span>
            <span className={styles.open} aria-hidden="true"><IconFolder size={16} /></span>
          </button>;
        })}
      </div>}
      {(visuals.length > 0 || files.some((file) => file.kind === "file")) && <>
        <h3 className={styles.groupTitle}>{ko ? "콘텐츠" : "Content"}</h3>
        <div className={styles.grid}>
          {files.filter((file) => file.kind === "file").map((file) => {
            const kind = viewerKindForChatFile(file.name, "file");
            return <button key={`thumb:${file.tabId}`} type="button" className={styles.thumb} data-artifact-row="file-thumb" data-artifact-kind={kind}
              onClick={() => openFile(file)} title={file.name} aria-label={file.name}>
              <span className={styles.thumbStage} aria-hidden="true"><FileThumb name={file.name} fileUrl={file.fileUrl} kind={kind} ko={ko} /></span>
              <span className={styles.thumbName}>{file.name}</span>
              <span className={styles.chip}>{extensionOf(file.name)}</span>
            </button>;
          })}
          {visuals.map((visual) => (
            <button key={visual.id} type="button" className={styles.thumb} data-artifact-row="visual" data-visual-kind={visual.kind}
              onClick={() => onOpenVisual(visual)} title={visual.title} aria-label={visual.title}>
              <span className={styles.thumbStage} aria-hidden="true">
                {visual.kind === "chart"
                  ? <ChartBlock code="" presetSpec={visual.spec} blockId={`thumb:${visual.id}`} size="thumb" fallback={null} />
                  : <HtmlVisualBlock html={visual.html} title={visual.title} blockId={`thumb:${visual.id}`} size="thumb" fallback={null} />}
              </span>
              <span className={styles.thumbName}>{visual.title}</span>
              <span className={styles.chip}>{visual.kind === "chart" ? (ko ? "차트" : "CHART") : "HTML"}</span>
            </button>
          ))}
        </div>
      </>}
    </div>
  </section>;
}
