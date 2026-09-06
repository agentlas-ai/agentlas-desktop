"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { findFileViewerZoomProvider } from "@file-viewer/core";
import FileViewer, { type FileViewerHandle, type ViewerOptions, type ViewerState } from "@file-viewer/react";
import officePreset from "@file-viewer/preset-office";
import litePreset from "@file-viewer/preset-lite";
import { archiveRenderer } from "@file-viewer/renderer-archive";
import { installPresentationLayoutCompatibility, type PresentationLayoutCompatibility } from "@/lib/file-viewer-layout-compat";
import {
  agentlasSpreadsheetRenderer,
  installPagedDocumentChrome,
  type PagedDocumentChrome,
} from "@/lib/file-viewer-document-chrome";
import { IconExpand } from "./Icon";
import styles from "./LiveOutputViewer.module.css";

const FILE_VIEWER_ASSET_ROOT = "file-viewer/";

function resolveFileViewerAssetRoot(): string {
  if (typeof document === "undefined") return `/${FILE_VIEWER_ASSET_ROOT}`;
  const current = new URL(window.location.href);
  if (current.protocol === "file:") {
    return new URL(`./${FILE_VIEWER_ASSET_ROOT}`, document.baseURI).href;
  }
  return new URL(`/${FILE_VIEWER_ASSET_ROOT}`, current.origin).href;
}

function runtimeAsset(root: string, path: string): string {
  return new URL(path, root).href;
}

function resolveViewerType(name: string, mimeType?: string): string | undefined {
  const extension = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension) return extension;
  const mimeFallbacks: Record<string, string> = {
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/x-hwp": "hwpx",
    "application/x-iwork-pages-sffpages": "pages",
    "application/x-iwork-numbers-sffnumbers": "numbers",
    "application/x-iwork-keynote-sffkey": "key",
  };
  return mimeType ? mimeFallbacks[mimeType.toLowerCase()] : undefined;
}

export function UniversalFileViewerEngine({
  source,
  name,
  mimeType,
  size,
  locale,
  compact = false,
  fill = false,
  onOpenExternal,
  openExternalHint,
  onExpand,
  fileInfo,
}: {
  source: string;
  name: string;
  mimeType?: string;
  size?: number;
  locale: "ko" | "en";
  compact?: boolean;
  fill?: boolean;
  onOpenExternal?: () => void | Promise<void>;
  openExternalHint?: string;
  onExpand?: () => void;
  fileInfo?: { sha256: string; binding: string; tabId: string };
}) {
  const [error, setError] = useState<string | null>(null);
  const [zoomLabel, setZoomLabel] = useState("100%");
  const [actionState, setActionState] = useState<"idle" | "downloading" | "opening" | "error">("idle");
  const [availability, setAvailability] = useState<ViewerState["availability"]>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<FileViewerHandle>(null);
  const userZoomedRef = useRef(false);
  const layoutCompatibilityRef = useRef<PresentationLayoutCompatibility | null>(null);
  const documentChromeRef = useRef<PagedDocumentChrome | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomRevisionRef = useRef(0);
  const syncRenderedZoom = useCallback(() => {
    const host = hostRef.current;
    const handle = viewerRef.current;
    const provider = host && findFileViewerZoomProvider(host);
    if (!host || !handle || !provider) return;
    const revision = ++zoomRevisionRef.current;
    if (zoomFrameRef.current !== null) window.cancelAnimationFrame(zoomFrameRef.current);
    // PPTX setZoom resolves before its scheduled resize updates provider state.
    // Read that same live provider after layout, never its earlier action result.
    zoomFrameRef.current = window.requestAnimationFrame(() => {
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        if (revision !== zoomRevisionRef.current || host !== hostRef.current
          || handle !== viewerRef.current || provider !== findFileViewerZoomProvider(host)) return;
        const state = provider.getState();
        if (state.label) setZoomLabel(state.label);
        else if (Number.isFinite(state.scale)) setZoomLabel(`${Math.round(state.scale * 100)}%`);
        setAvailability((current) => current ? {
          ...current, zoomIn: state.canZoomIn, zoomOut: state.canZoomOut,
        } : current);
      });
    });
  }, []);
  useLayoutEffect(() => () => {
    ++zoomRevisionRef.current;
    if (zoomFrameRef.current !== null) window.cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = null;
  }, [source, name, mimeType]);
  useEffect(() => {
    userZoomedRef.current = false;
    setZoomLabel("100%");
    setActionState("idle");
    setAvailability(null);
    setError(null);
  }, [source, name, mimeType]);
  const fitSelectedPage = useCallback(() => {
    if (userZoomedRef.current) {
      syncRenderedZoom();
      return;
    }
    const handle = viewerRef.current;
    const chrome = documentChromeRef.current;
    void (async () => {
      const presentationFit = await chrome?.fitSelectedPage();
      if (handle !== viewerRef.current || chrome !== documentChromeRef.current) return;
      if (!presentationFit) await handle?.fitToView();
      if (handle === viewerRef.current) syncRenderedZoom();
    })();
  }, [syncRenderedZoom]);
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const compatibility = installPresentationLayoutCompatibility(hostRef.current);
    const documentChrome = installPagedDocumentChrome(hostRef.current, locale, fitSelectedPage);
    layoutCompatibilityRef.current = compatibility;
    documentChromeRef.current = documentChrome;
    return () => {
      if (layoutCompatibilityRef.current === compatibility) layoutCompatibilityRef.current = null;
      if (documentChromeRef.current === documentChrome) documentChromeRef.current = null;
      compatibility.dispose();
      documentChrome.dispose();
    };
  }, [source, name, mimeType, locale, fitSelectedPage]);
  const options = useMemo<ViewerOptions>(() => {
    const assetRoot = resolveFileViewerAssetRoot();
    return ({
    theme: "system" as const,
    locale: locale === "ko" ? "ko-KR" : "en-US",
    styleIsolation: "shadow" as const,
    rendererMode: "replace" as const,
    preset: [litePreset, officePreset],
    // The final registration wins over the office preset's spreadsheet
    // handler and adds exact selected-cell identity plus bounded formula lookup.
    renderers: [archiveRenderer, agentlasSpreadsheetRenderer] as unknown as NonNullable<ViewerOptions["renderers"]>,
    // Agentlas owns one compact toolbar. Renderer-specific controls remain
    // available through the controller API without creating a second row.
    toolbar: false,
    search: false,
    ai: false,
    // Paged PPTX chrome fits the selected slide from its natural dimensions.
    // Generic auto-fit races that resize handler and measures scaled content.
    fit: resolveViewerType(name, mimeType) === "pptx" ? undefined
      : { mode: "contain" as const, resize: "until-interaction" as const, padding: 18, minScale: 0.25, maxScale: 2 },
    ui: { density: "compact" as const, surfaceBackground: "#edf0f4" },
    docx: {
      worker: true,
      workerUrl: runtimeAsset(assetRoot, "vendor/docx/docx.worker.js"),
      workerJsZipUrl: runtimeAsset(assetRoot, "vendor/docx/jszip.min.js"),
      progressive: true,
      visualPagination: true,
      externalLinkPolicy: "block" as const,
      renderPageBatchSize: 4,
      renderYieldEveryMs: 10,
    },
    spreadsheet: {
      // Parsing stays off the renderer thread even for small sheets so opening
      // a result never stalls chat scrolling or sidebar interaction.
      worker: true,
      workerUrl: runtimeAsset(assetRoot, "vendor/xlsx/sheet.worker.js"),
      textEncoding: "auto" as const,
      resizableColumns: true,
      resizableRows: true,
    },
    pdf: {
      toolbar: false,
      navigation: true,
      defaultNavigationVisible: true,
      thumbnails: true,
      assetBaseUrl: assetRoot,
      workerUrl: runtimeAsset(assetRoot, "vendor/pdf/pdf.worker.mjs"),
      cMapUrl: runtimeAsset(assetRoot, "vendor/pdf/cmaps/"),
      wasmUrl: runtimeAsset(assetRoot, "vendor/pdf/wasm/"),
      standardFontDataUrl: runtimeAsset(assetRoot, "vendor/pdf/standard_fonts/"),
      cjkFontFallbackPath: runtimeAsset(assetRoot, "vendor/pdf/fonts/"),
      cjkFontFallback: true,
      identityFontRepair: true,
    },
    presentation: {
      workerUrl: runtimeAsset(assetRoot, "vendor/pptx/pptx.worker.js"),
      workerType: "classic" as const,
      pptModuleUrl: runtimeAsset(assetRoot, "vendor/ppt/index.mjs"),
      pptWorkerUrl: runtimeAsset(assetRoot, "vendor/ppt/worker.mjs"),
      pptWasmUrl: runtimeAsset(assetRoot, "vendor/ppt/ppt-native.wasm"),
      pptFontUrl: runtimeAsset(assetRoot, "vendor/ppt/ppt-font-cjk.otf"),
      pptWorker: "auto" as const,
    },
    archive: {
      workerUrl: runtimeAsset(assetRoot, "vendor/libarchive/worker-bundle.js"),
      wasmUrl: runtimeAsset(assetRoot, "vendor/libarchive/libarchive.wasm"),
      cache: true,
    },
    hangul: {
      workerUrl: runtimeAsset(assetRoot, "vendor/hangul/hangul.worker.js"),
      useWorker: true,
    },
    iwork: {
      workerUrl: runtimeAsset(assetRoot, "vendor/iwork/iwork.worker.js"),
      useWorker: true,
      embeddedPreview: "fallback" as const,
    },
    wordPerfect: {
      workerUrl: runtimeAsset(assetRoot, "vendor/wordperfect/wordperfect.worker.js"),
      wasmUrl: runtimeAsset(assetRoot, "vendor/wordperfect/libwpd.wasm"),
      useWorker: true,
    },
  });
  }, [locale, name, mimeType]);

  const runViewerAction = async (kind: "download" | "open", action: () => void | Promise<void>) => {
    setActionState(kind === "download" ? "downloading" : "opening");
    try {
      await action();
      setActionState("idle");
    } catch {
      setActionState("error");
    }
  };

  const zoom = async (direction: "in" | "out" | "fit") => {
    const handle = viewerRef.current;
    if (!handle) return;
    userZoomedRef.current = direction !== "fit";
    if (direction === "in") await handle.zoomIn();
    else if (direction === "out") await handle.zoomOut();
    else if (!await documentChromeRef.current?.fitSelectedPage()) await handle.fitToView();
    if (handle === viewerRef.current) syncRenderedZoom();
  };

  // @file-viewer treats callback identity as part of its mount options. Keep
  // this stable: changing local toolbar state must not trigger controller
  // update/reload cycles while a document is still parsing.
  const handleStateChange = useCallback((state: ViewerState) => {
    if (state.ready) {
      layoutCompatibilityRef.current?.refresh();
      documentChromeRef.current?.refresh();
    }
    syncRenderedZoom();
    setAvailability(state.availability);
    if (state.error) setError(state.error instanceof Error ? state.error.message : String(state.error));
    else if (state.ready) setError(null);
  }, [syncRenderedZoom]);

  return (
    <div ref={hostRef} className={styles.documentEngine} data-compact={compact ? "true" : "false"} data-fill={fill ? "true" : "false"} data-testid="universal-file-viewer">
      <header className={styles.documentToolbar} data-document-viewer-toolbar="true" {...(fileInfo ? { "data-chat-file-header": "true" } : {})}>
        <div className={styles.documentIdentity}>
          <strong title={name}>{name}</strong>
          {typeof size === "number" && size >= 0 ? <span>{size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`}</span> : null}
        </div>
        <div className={styles.documentToolbarActions}>
          {availability?.zoom !== false ? <div className={styles.documentZoom} role="group" aria-label={locale === "ko" ? "문서 확대/축소" : "Document zoom"}>
            <button type="button" onClick={() => void zoom("out")} disabled={!availability?.zoomOut} aria-label={locale === "ko" ? "축소" : "Zoom out"}>−</button>
            <button type="button" className={styles.documentZoomLabel} onClick={() => void zoom("fit")} disabled={!availability?.zoom} aria-label={locale === "ko" ? "선택 페이지 화면에 맞춤" : "Fit selected page to view"} title={locale === "ko" ? "선택 페이지 화면에 맞춤" : "Fit selected page to view"}>{zoomLabel}</button>
            <button type="button" onClick={() => void zoom("in")} disabled={!availability?.zoomIn} aria-label={locale === "ko" ? "확대" : "Zoom in"}>+</button>
          </div> : null}
          <button type="button" onClick={() => void runViewerAction("download", async () => {
            if (!viewerRef.current) throw new Error("viewer-unavailable");
            await viewerRef.current.downloadOriginalFile();
          })} disabled={!availability?.download || actionState === "downloading" || actionState === "opening"}>
            {actionState === "downloading" ? (locale === "ko" ? "저장 중…" : "Saving…") : (locale === "ko" ? "다운로드" : "Download")}
          </button>
          {onOpenExternal ? <button type="button" onClick={() => void runViewerAction("open", onOpenExternal)} disabled={actionState === "downloading" || actionState === "opening"} aria-label={openExternalHint} title={openExternalHint}>
            {actionState === "opening" ? (locale === "ko" ? "여는 중…" : "Opening…") : (locale === "ko" ? "열기" : "Open")}
          </button> : null}
          {onExpand ? <button type="button" className={styles.documentIconButton} onClick={onExpand} aria-label={locale === "ko" ? "패널 확장" : "Expand panel"} title={locale === "ko" ? "패널 확장" : "Expand panel"}><IconExpand size={14} /></button> : null}
          {fileInfo ? <details className={styles.documentInfo} data-chat-file-info="true">
            <summary aria-label={locale === "ko" ? "파일 정보" : "File info"}>i</summary>
            <div><span>SHA-256: {fileInfo.sha256}</span><span>{locale === "ko" ? "바인딩" : "Binding"}: {fileInfo.binding}</span><span>{locale === "ko" ? "탭 ID" : "Tab ID"}: {fileInfo.tabId}</span></div>
          </details> : null}
        </div>
        {actionState === "error" ? <span className={styles.documentActionError} role="alert">{locale === "ko" ? "파일 작업을 완료하지 못했습니다." : "The file action could not be completed."}</span> : null}
      </header>
      <FileViewer
        ref={viewerRef}
        key={`${source}:${name}:${mimeType ?? ""}`}
        url={source}
        name={name}
        filename={name}
        type={resolveViewerType(name, mimeType)}
        size={size}
        options={options}
        className={styles.documentEngineRoot}
        onStateChange={handleStateChange}
      />
      {error && <div className={styles.documentError} role="alert"><strong>{locale === "ko" ? "문서를 렌더링하지 못했습니다" : "Could not render this document"}</strong><small>{error}</small></div>}
    </div>
  );
}
