"use client";

import dynamic from "next/dynamic";
import { LiveOutputViewer, type LiveOutputKind } from "@/components/LiveOutputViewer";
import { IconClose } from "@/components/Icon";
import { filePreviewUrl } from "@shared/file-preview";
import type { SciencePreviewItem } from "@shared/science-preview-panel";
import styles from "./SciencePreviewPane.module.css";

/*
 * The Preview tab body: the Universal File Viewer Work's right rail uses for files, fed by agentlas://file-preview/<token>
 * (electron/document/file-preview.ts). Read-only on purpose. The Document tab is the editor and replays the AI's edits;
 * this shows a docx, pdf, spreadsheet or deck the way it renders, page by page and sheet by sheet, so the owner can
 * look at a manuscript draft or a data table before deciding to save or edit it.
 */

// The workbook view (Data, Charts, Table tools) reads the xlsx itself, so it loads only when an xlsx is previewed.
const WorkbookView = dynamic(() => import("@/components/workspace/WorkbookView").then((module) => module.WorkbookView), { ssr: false });

const KIND: Record<SciencePreviewItem["kind"], LiveOutputKind> = {
  document: "document",
  pdf: "pdf",
  spreadsheet: "spreadsheet",
  presentation: "presentation",
};

const MEDIA_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  hwpx: "application/vnd.hancom.hwpx",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function SciencePreviewPane({ items, activeToken, locale, onSelect, onClose }: {
  items: SciencePreviewItem[];
  activeToken: string | null;
  locale: "ko" | "en";
  onSelect: (token: string) => void;
  onClose: (token: string) => void;
}) {
  const ko = locale === "ko";
  const active = items.find((item) => item.token === activeToken) ?? items[items.length - 1] ?? null;
  if (!active) return null;
  const source = filePreviewUrl(active.token);
  const viewer = (
    <LiveOutputViewer
      key={active.token}
      source={source}
      name={active.name}
      kind={KIND[active.kind]}
      mimeType={MEDIA_TYPE[active.extension]}
      size={active.size}
      locale={locale}
      fill
      placement="sidebar"
    />
  );
  return (
    <div className={styles.pane} data-science-preview-pane="true">
      <p className={styles.note} data-science-preview-note="true">
        {ko
          ? "읽기 전용 미리보기입니다. 저장한 파일이 아니라 지금 Science가 만든 내용을 그대로 보여 줍니다. 원고를 고치려면 내보낸 docx·hwpx 파일을 문서 탭에서 여세요."
          : "Read-only preview of what Science just built, not a saved file. To edit a manuscript, export it and open the docx or hwpx in the Document tab."}
      </p>
      <div className={styles.chips} role="tablist" aria-label={ko ? "열린 미리보기" : "Open previews"}>
        {items.map((item) => (
          <span key={item.token} className={styles.chip} data-active={item.token === active.token ? "true" : "false"}>
            <button type="button" role="tab" aria-selected={item.token === active.token} className={styles.chipName} onClick={() => onSelect(item.token)} title={item.name}>
              {item.name}
            </button>
            <button type="button" className={styles.chipClose} onClick={() => onClose(item.token)} aria-label={ko ? `${item.name} 닫기` : `Close ${item.name}`} title={ko ? "미리보기 닫기" : "Close preview"}>
              <IconClose size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className={styles.stage}>
        {/* xlsx gets the same workbook view Work's rail gives it (Data, Charts, Table tools); csv/tsv are the grid alone. */}
        {active.extension === "xlsx" || active.extension === "xlsm"
          ? <WorkbookView name={active.name} fileUrl={source} chatId={null} locale={locale} data={viewer} />
          : viewer}
      </div>
    </div>
  );
}
