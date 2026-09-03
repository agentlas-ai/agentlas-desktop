"use client";

import { useMemo, useState } from "react";
import FileViewer, { type ViewerOptions } from "@file-viewer/react";
import officePreset from "@file-viewer/preset-office";
import litePreset from "@file-viewer/preset-lite";
import { archiveRenderer } from "@file-viewer/renderer-archive";
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
}: {
  source: string;
  name: string;
  mimeType?: string;
  size?: number;
  locale: "ko" | "en";
  compact?: boolean;
  fill?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const options = useMemo<ViewerOptions>(() => {
    const assetRoot = resolveFileViewerAssetRoot();
    return ({
    theme: "system" as const,
    locale: locale === "ko" ? "ko-KR" : "en-US",
    styleIsolation: "shadow" as const,
    rendererMode: "replace" as const,
    preset: [litePreset, officePreset],
    renderers: [archiveRenderer] as unknown as NonNullable<ViewerOptions["renderers"]>,
    toolbar: {
      download: false,
      print: true,
      exportHtml: false,
      zoom: true,
      search: true,
      theme: false,
      position: "top" as const,
    },
    search: true,
    ai: false,
    fit: "width" as const,
    ui: { density: "compact" as const, surfaceBackground: "transparent" },
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
  }, [locale]);

  return (
    <div className={styles.documentEngine} data-compact={compact ? "true" : "false"} data-fill={fill ? "true" : "false"} data-testid="universal-file-viewer">
      <FileViewer
        key={`${source}:${name}:${mimeType ?? ""}`}
        url={source}
        name={name}
        filename={name}
        type={resolveViewerType(name, mimeType)}
        size={size}
        options={options}
        className={styles.documentEngineRoot}
        onStateChange={(state) => {
          if (state.error) setError(state.error instanceof Error ? state.error.message : String(state.error));
          else if (state.ready) setError(null);
        }}
      />
      {error && <div className={styles.documentError} role="alert"><strong>{locale === "ko" ? "문서를 렌더링하지 못했습니다" : "Could not render this document"}</strong><small>{error}</small></div>}
    </div>
  );
}
