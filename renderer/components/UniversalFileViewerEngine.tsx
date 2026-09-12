"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { findFileViewerZoomProvider } from "@file-viewer/core";
import FileViewer, { type FileViewerHandle, type ViewerOptions, type ViewerState } from "@file-viewer/react";
import officePreset from "@file-viewer/preset-office";
import litePreset from "@file-viewer/preset-lite";
import { archiveRenderer } from "@file-viewer/renderer-archive";
import { installPresentationLayoutCompatibility, type PresentationLayoutCompatibility } from "@/lib/file-viewer-layout-compat";
import {
  agentlasSpreadsheetRenderer,
  installPagedDocumentChrome,
  type DocumentChromeSelection,
  type PagedDocumentChrome,
} from "@/lib/file-viewer-document-chrome";
import {
  createOfficeDocumentSession,
  mainArtifactRevision,
  officeCapabilities,
  reduceOfficeDocumentSession,
  resolveOfficeFormat,
  type OfficeEditIntent,
  type OfficeTaskSelection,
} from "@/lib/office-document-session";
import { IconExpand } from "./Icon";
import { OfficeDocumentSessionBar } from "./OfficeDocumentSessionBar";
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

function resolveViewerType(name: string, mimeType?: string, signature?: Uint8Array): string | undefined {
  const extension = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const office = resolveOfficeFormat(name, mimeType, signature);
  if (office.format) return office.format;
  if (extension && !["pdf", "docx", "xlsx", "pptx", "hwp", "hwpx"].includes(extension)) return extension;
  const mimeFallbacks: Record<string, string> = {
    "application/zip": "zip",
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
  onOfficeSelection,
  onOfficeEditIntent,
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
  onOfficeSelection?: (selection: OfficeTaskSelection) => void | Promise<void>;
  onOfficeEditIntent?: (intent: OfficeEditIntent) => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [zoomLabel, setZoomLabel] = useState("100%");
  const [actionState, setActionState] = useState<"idle" | "downloading" | "opening" | "error">("idle");
  const [availability, setAvailability] = useState<ViewerState["availability"]>(null);
  const [viewerState, setViewerState] = useState<"loading" | "ready" | "failed">("loading");
  const [signatureProbe, setSignatureProbe] = useState<{ source: string; bytes: Uint8Array | null }>({ source: "", bytes: null });
  const signature = signatureProbe.source === source ? signatureProbe.bytes ?? undefined : undefined;
  const incomingFormat = resolveOfficeFormat(name, mimeType, signature);
  const incomingRevision = mainArtifactRevision(fileInfo);
  const [session, dispatchSession] = useReducer(
    reduceOfficeDocumentSession,
    undefined,
    () => createOfficeDocumentSession(incomingFormat.format, incomingRevision),
  );
  const [viewDocument, setViewDocument] = useState(() => ({ source, name, mimeType, size, fileInfo, signature, format: incomingFormat.format }));
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<FileViewerHandle>(null);
  const userZoomedRef = useRef(false);
  const layoutCompatibilityRef = useRef<PresentationLayoutCompatibility | null>(null);
  const documentChromeRef = useRef<PagedDocumentChrome | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomRevisionRef = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const unresolved = resolveOfficeFormat(name, mimeType);
    if (!unresolved.needsSignature) {
      setSignatureProbe((current) => current.source === source ? current : { source, bytes: null });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(source, { headers: { Range: "bytes=0-7" }, signal: controller.signal });
        if (!response.ok) throw new Error("signature-unavailable");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("signature-unavailable");
        const prefix = new Uint8Array(8);
        let offset = 0;
        while (offset < prefix.byteLength) {
          const next = await reader.read();
          if (next.done) break;
          const count = Math.min(prefix.byteLength - offset, next.value.byteLength);
          prefix.set(next.value.subarray(0, count), offset);
          offset += count;
          if (offset >= prefix.byteLength) await reader.cancel();
        }
        if (!controller.signal.aborted) setSignatureProbe({ source, bytes: prefix.slice(0, offset) });
      } catch {
        if (!controller.signal.aborted) setSignatureProbe({ source, bytes: new Uint8Array(0) });
      }
    })();
    return () => controller.abort();
  }, [source, name, mimeType]);

  useEffect(() => {
    dispatchSession({ type: "observe-document", format: incomingFormat.format, revision: incomingRevision });
    const active = sessionRef.current.activeRevision;
    const sameIdentity = Boolean(active && incomingRevision
      && active.sha256 === incomingRevision.sha256
      && active.binding === incomingRevision.binding
      && active.tabId === incomingRevision.tabId);
    if (sessionRef.current.pendingEdit && !sameIdentity) return;
    setViewDocument({ source, name, mimeType, size, fileInfo, signature, format: incomingFormat.format });
  }, [source, name, mimeType, size, fileInfo?.sha256, fileInfo?.binding, fileInfo?.tabId, incomingFormat.format]);
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
    setViewerState("loading");
    setError(null);
  }, [viewDocument.source, viewDocument.name, viewDocument.mimeType]);
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
    const documentChrome = installPagedDocumentChrome(hostRef.current, locale, fitSelectedPage, (selection: DocumentChromeSelection) => {
      dispatchSession({ type: "select", anchor: selection });
    });
    layoutCompatibilityRef.current = compatibility;
    documentChromeRef.current = documentChrome;
    return () => {
      if (layoutCompatibilityRef.current === compatibility) layoutCompatibilityRef.current = null;
      if (documentChromeRef.current === documentChrome) documentChromeRef.current = null;
      compatibility.dispose();
      documentChrome.dispose();
    };
  }, [viewDocument.source, viewDocument.name, viewDocument.mimeType, locale, fitSelectedPage]);
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
    fit: resolveViewerType(viewDocument.name, viewDocument.mimeType, viewDocument.signature) === "pptx" ? undefined
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
  }, [locale, viewDocument.name, viewDocument.mimeType, viewDocument.signature]);

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
    setViewerState(state.error ? "failed" : state.ready ? "ready" : "loading");
  }, [syncRenderedZoom]);

  const capabilities = officeCapabilities({
    format: session.format,
    viewerState,
    nativeOpenAvailable: Boolean(onOpenExternal),
  });

  const discardDraftAndLoad = () => {
    dispatchSession({ type: "discard-draft-and-load" });
    dispatchSession({ type: "observe-document", format: incomingFormat.format, revision: incomingRevision });
    setViewDocument({ source, name, mimeType, size, fileInfo, signature, format: incomingFormat.format });
  };

  const sendEdit = onOfficeEditIntent ? async (intent: OfficeEditIntent) => {
    dispatchSession({ type: "set-delivery", draftSequence: intent.draftSequence, delivery: "sending" });
    try {
      await onOfficeEditIntent(intent);
      dispatchSession({ type: "set-delivery", draftSequence: intent.draftSequence, delivery: "acknowledged" });
    } catch (sendError) {
      dispatchSession({ type: "set-delivery", draftSequence: intent.draftSequence, delivery: "failed" });
      throw sendError;
    }
  } : undefined;

  return (
    <div ref={hostRef} className={styles.documentEngine} data-compact={compact ? "true" : "false"} data-fill={fill ? "true" : "false"} data-testid="universal-file-viewer">
      <header className={styles.documentToolbar} data-document-viewer-toolbar="true" {...(viewDocument.fileInfo ? { "data-chat-file-header": "true" } : {})}>
        <div className={styles.documentIdentity}>
          <strong title={viewDocument.name}>{viewDocument.name}</strong>
          {typeof viewDocument.size === "number" && viewDocument.size >= 0 ? <span>{viewDocument.size < 1024 ? `${viewDocument.size} B` : viewDocument.size < 1024 * 1024 ? `${Math.round(viewDocument.size / 1024)} KB` : `${(viewDocument.size / (1024 * 1024)).toFixed(1)} MB`}</span> : null}
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
          {viewDocument.fileInfo ? <details className={styles.documentInfo} data-chat-file-info="true">
            <summary aria-label={locale === "ko" ? "파일 정보" : "File info"}>i</summary>
            <div><span>SHA-256: {viewDocument.fileInfo.sha256}</span><span>{locale === "ko" ? "바인딩" : "Binding"}: {viewDocument.fileInfo.binding}</span><span>{locale === "ko" ? "탭 ID" : "Tab ID"}: {viewDocument.fileInfo.tabId}</span></div>
          </details> : null}
        </div>
        {actionState === "error" ? <span className={styles.documentActionError} role="alert">{locale === "ko" ? "파일 작업을 완료하지 못했습니다." : "The file action could not be completed."}</span> : null}
      </header>
      {(session.format || incomingFormat.reason === "ambiguous-hwp-container" || incomingFormat.reason === "signature-conflict") ? <OfficeDocumentSessionBar
        locale={locale}
        session={session}
        capabilities={capabilities}
        formatReason={incomingFormat.reason}
        onDraftChange={(replacementValue) => dispatchSession({ type: "change-draft", replacementValue })}
        onClearDraft={session.conflict ? discardDraftAndLoad : () => dispatchSession({ type: "clear-draft" })}
        onDiscardDraftAndLoad={discardDraftAndLoad}
        onSendSelection={onOfficeSelection}
        onSendEdit={sendEdit}
      /> : null}
      <FileViewer
        ref={viewerRef}
        key={`${viewDocument.source}:${viewDocument.name}:${viewDocument.mimeType ?? ""}`}
        url={viewDocument.source}
        name={viewDocument.name}
        filename={viewDocument.name}
        type={resolveViewerType(viewDocument.name, viewDocument.mimeType, viewDocument.signature)}
        size={viewDocument.size}
        options={options}
        className={styles.documentEngineRoot}
        onStateChange={handleStateChange}
      />
      {error && <div className={styles.documentError} role="alert"><strong>{locale === "ko" ? "문서를 렌더링하지 못했습니다" : "Could not render this document"}</strong><small>{error}</small></div>}
    </div>
  );
}
