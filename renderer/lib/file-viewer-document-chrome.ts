import { findFileViewerZoomProvider, type FileViewerZoomState } from "@file-viewer/core";
import {
  renderFileViewerSpreadsheet,
  spreadsheetRenderer,
} from "@file-viewer/renderer-spreadsheet";

const SPREADSHEET_CELL_EVENT = "agentlas-spreadsheet-cell-focus";
const SPREADSHEET_BRIDGE_MARK = Symbol.for("agentlas.spreadsheet-cell-bridge.v1");
const MAX_FORMULA_WORKBOOK_BYTES = 32 * 1024 * 1024;
const MAX_FORMULA_XML_BYTES = 16 * 1024 * 1024;

type SpreadsheetCellDetail = {
  selectionId: number;
  address: string;
  sheetName: string;
  displayValue: string;
  formula?: string;
  formulaState: "loading" | "ready" | "unavailable";
  rect: { x: number; y: number; width: number; height: number };
};

type SpreadsheetCell = {
  type?: string;
  rowIndex?: number;
  colIndex?: number;
  displayText?: unknown;
  value?: unknown;
  drawX?: number;
  drawY?: number;
  visibleWidth?: number;
  visibleHeight?: number;
  width?: number;
  height?: number;
  getDisplayText?: () => unknown;
};

type SpreadsheetTable = {
  ctx?: { containerElement?: HTMLElement };
  on: (event: string, callback: (...args: unknown[]) => void) => void;
};

type SpreadsheetTableConstructor = {
  prototype: SpreadsheetTable & { [SPREADSHEET_BRIDGE_MARK]?: boolean };
};

let spreadsheetBridgePromise: Promise<string> | null = null;
let spreadsheetSelectionId = 0;

function spreadsheetColumnLabel(columnIndex: number): string {
  let value = Math.max(1, Math.floor(columnIndex));
  let label = "";
  while (value > 0) {
    const digit = (value - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function spreadsheetDisplayValue(cell: SpreadsheetCell): string {
  const display = cell.displayText ?? cell.getDisplayText?.() ?? cell.value ?? "";
  if (typeof display === "string") return display;
  if (typeof display === "number" || typeof display === "boolean" || typeof display === "bigint") return String(display);
  if (display instanceof Date) return display.toLocaleString();
  return "";
}

async function installSpreadsheetCellBridge(): Promise<string> {
  if (spreadsheetBridgePromise) return spreadsheetBridgePromise;
  spreadsheetBridgePromise = (async () => {
    const before = new Set(Array.from(document.head.querySelectorAll("style")));
    // Match the renderer package's exact module specifier. Vite may otherwise
    // instantiate the package root and the explicit ESM entry separately,
    // leaving us with a different prototype than the table on screen.
    // The package exposes declarations only for its root despite the renderer
    // intentionally importing this concrete ESM entry.
    // @ts-expect-error -- runtime entry is present in e-virt-table/dist.
    const module = await import("e-virt-table/dist/index.es.js");
    const Table = module.default as unknown as SpreadsheetTableConstructor;
    const prototype = Table.prototype;
    if (!prototype[SPREADSHEET_BRIDGE_MARK]) {
      const originalOn = prototype.on;
      prototype.on = function patchedSpreadsheetOn(event, callback) {
        if (!Object.prototype.hasOwnProperty.call(this, SPREADSHEET_BRIDGE_MARK)) {
          Object.defineProperty(this, SPREADSHEET_BRIDGE_MARK, { value: true });
          originalOn.call(this, "cellFocusChange", (candidate: unknown) => {
            const cell = candidate as SpreadsheetCell;
            const rowIndex = Number(cell.rowIndex);
            const colIndex = Number(cell.colIndex);
            const container = this.ctx?.containerElement;
            if (!container || cell.type === "index" || !Number.isInteger(rowIndex) || !Number.isInteger(colIndex) || colIndex < 1) return;
            const root = container.closest<HTMLElement>("[data-file-viewer-spreadsheet-root]");
            const sheetName = root?.querySelector<HTMLElement>(".sheet-tab.active")?.title ?? "";
            const detail: SpreadsheetCellDetail = {
              selectionId: ++spreadsheetSelectionId,
              address: `${spreadsheetColumnLabel(colIndex)}${rowIndex + 1}`,
              sheetName,
              displayValue: spreadsheetDisplayValue(cell),
              formulaState: "loading",
              rect: {
                x: Number(cell.drawX) || 0,
                y: Number(cell.drawY) || 0,
                width: Math.max(1, Number(cell.visibleWidth) || Number(cell.width) || 1),
                height: Math.max(1, Number(cell.visibleHeight) || Number(cell.height) || 1),
              },
            };
            container.dispatchEvent(new CustomEvent<SpreadsheetCellDetail>(SPREADSHEET_CELL_EVENT, {
              bubbles: true,
              composed: true,
              detail,
            }));
          });
        }
        originalOn.call(this, event, callback);
      };
      Object.defineProperty(prototype, SPREADSHEET_BRIDGE_MARK, { value: true });
    }
    const injected = Array.from(document.head.querySelectorAll("style")).filter((style) => !before.has(style));
    const vendorStyle = injected.map((style) => style.textContent ?? "").find((css) => css.includes(".e-virt-table-container") && css.includes(".e-virt-table-overlayer")) ?? "";
    injected.forEach((style) => style.remove());
    return vendorStyle;
  })();
  return spreadsheetBridgePromise;
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function normalizeZipTarget(target: string): string | null {
  const parts = (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
    } else normalized.push(part);
  }
  const value = normalized.join("/");
  return value.startsWith("xl/") ? value : null;
}

class BoundedZipReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly entries = new Map<string, { method: number; compressedSize: number; size: number; offset: number }>();

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    const lowerBound = Math.max(0, this.bytes.length - 65_557);
    let eocd = -1;
    for (let offset = this.bytes.length - 22; offset >= lowerBound; offset -= 1) {
      if (readUint32(this.view, offset) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error("XLSX ZIP directory is missing");
    const count = this.view.getUint16(eocd + 10, true);
    let cursor = readUint32(this.view, eocd + 16);
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > this.bytes.length || readUint32(this.view, cursor) !== 0x02014b50) throw new Error("Invalid XLSX ZIP directory");
      const method = this.view.getUint16(cursor + 10, true);
      const compressedSize = readUint32(this.view, cursor + 20);
      const size = readUint32(this.view, cursor + 24);
      const nameLength = this.view.getUint16(cursor + 28, true);
      const extraLength = this.view.getUint16(cursor + 30, true);
      const commentLength = this.view.getUint16(cursor + 32, true);
      const offset = readUint32(this.view, cursor + 42);
      if ([compressedSize, size, offset].includes(0xffffffff)) throw new Error("ZIP64 formula lookup is unavailable");
      const nameStart = cursor + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > this.bytes.length) throw new Error("Invalid XLSX ZIP filename");
      const name = new TextDecoder().decode(this.bytes.subarray(nameStart, nameEnd));
      this.entries.set(name, { method, compressedSize, size, offset });
      cursor = nameEnd + extraLength + commentLength;
    }
  }

  async text(path: string): Promise<string> {
    const entry = this.entries.get(path);
    if (!entry || entry.size > MAX_FORMULA_XML_BYTES) throw new Error("XLSX formula XML is unavailable");
    const { offset, compressedSize, method, size } = entry;
    if (offset + 30 > this.bytes.length || readUint32(this.view, offset) !== 0x04034b50) throw new Error("Invalid XLSX ZIP entry");
    const nameLength = this.view.getUint16(offset + 26, true);
    const extraLength = this.view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + compressedSize;
    if (end > this.bytes.length) throw new Error("Truncated XLSX ZIP entry");
    let output: Uint8Array;
    if (method === 0) output = this.bytes.slice(start, end);
    else if (method === 8 && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([this.bytes.slice(start, end)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > size || total > MAX_FORMULA_XML_BYTES) {
          await reader.cancel();
          throw new Error("XLSX ZIP output exceeds its declared size");
        }
        chunks.push(value);
      }
      output = new Uint8Array(total);
      let outputOffset = 0;
      for (const chunk of chunks) {
        output.set(chunk, outputOffset);
        outputOffset += chunk.byteLength;
      }
    } else throw new Error("Unsupported XLSX ZIP compression");
    if (output.byteLength !== size || output.byteLength > MAX_FORMULA_XML_BYTES) throw new Error("Invalid XLSX ZIP output size");
    return new TextDecoder().decode(output);
  }
}

function parseXml(xml: string): XMLDocument {
  if (/<!DOCTYPE/iu.test(xml)) throw new Error("XLSX XML declarations are unavailable");
  const documentNode = new DOMParser().parseFromString(xml, "application/xml");
  if (documentNode.querySelector("parsererror")) throw new Error("Invalid XLSX XML");
  return documentNode;
}

function spreadsheetColumnNumber(label: string): number {
  let value = 0;
  for (const character of label.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function formulaSegments(formula: string): Array<{ text: string; referenceSafe: boolean }> {
  const segments: Array<{ text: string; referenceSafe: boolean }> = [];
  let plainStart = 0;
  let cursor = 0;
  const pushPlain = (end: number) => {
    if (end > plainStart) segments.push({ text: formula.slice(plainStart, end), referenceSafe: true });
  };
  while (cursor < formula.length) {
    const token = formula[cursor];
    if (token === '"') {
      pushPlain(cursor);
      const start = cursor++;
      while (cursor < formula.length) {
        if (formula[cursor] !== '"') { cursor += 1; continue; }
        if (formula[cursor + 1] === '"') { cursor += 2; continue; }
        cursor += 1;
        break;
      }
      segments.push({ text: formula.slice(start, cursor), referenceSafe: false });
      plainStart = cursor;
      continue;
    }
    if (token === "'") {
      pushPlain(cursor);
      const start = cursor++;
      while (cursor < formula.length) {
        if (formula[cursor] !== "'") { cursor += 1; continue; }
        if (formula[cursor + 1] === "'") { cursor += 2; continue; }
        cursor += 1;
        break;
      }
      segments.push({ text: formula.slice(start, cursor), referenceSafe: false });
      plainStart = cursor;
      continue;
    }
    if (token === "[") {
      pushPlain(cursor);
      const start = cursor++;
      let depth = 1;
      while (cursor < formula.length && depth > 0) {
        if (formula[cursor] === "[") depth += 1;
        else if (formula[cursor] === "]") depth -= 1;
        cursor += 1;
      }
      segments.push({ text: formula.slice(start, cursor), referenceSafe: false });
      plainStart = cursor;
      continue;
    }
    cursor += 1;
  }
  pushPlain(formula.length);
  return segments;
}

function shiftSharedFormula(formula: string, sourceAddress: string, targetAddress: string): string | undefined {
  const addressPattern = /^([A-Z]{1,3})(\d+)$/u;
  const source = sourceAddress.toUpperCase().match(addressPattern);
  const target = targetAddress.toUpperCase().match(addressPattern);
  if (!source || !target) return undefined;
  const columnDelta = spreadsheetColumnNumber(target[1]) - spreadsheetColumnNumber(source[1]);
  const rowDelta = Number(target[2]) - Number(source[2]);
  const sheetPrefix = "((?:'(?:[^']|'')+'|[A-Z_][A-Z0-9_.]*)!)?";
  const shiftColumn = (label: string, absolute: string) => {
    const column = spreadsheetColumnNumber(label) + (absolute ? 0 : columnDelta);
    return column >= 1 && column <= 16_384 ? `${absolute}${spreadsheetColumnLabel(column)}` : "#REF!";
  };
  const shiftRow = (label: string, absolute: string) => {
    const row = Number(label) + (absolute ? 0 : rowDelta);
    return row >= 1 && row <= 1_048_576 ? `${absolute}${row}` : "#REF!";
  };
  const columnRangePattern = new RegExp(`(?<![A-Z0-9_.$])${sheetPrefix}(\\$?)([A-Z]{1,3}):(\\$?)([A-Z]{1,3})(?![A-Z0-9_.\\d])`, "giu");
  const rowRangePattern = new RegExp(`(?<![A-Z0-9_.$])${sheetPrefix}(\\$?)(\\d+):(\\$?)(\\d+)(?![A-Z0-9_.])`, "giu");
  const cellPattern = new RegExp(`(?<![A-Z0-9_.$])${sheetPrefix}(\\$?)([A-Z]{1,3})(\\$?)(\\d+)(?![A-Z0-9_.([])`, "giu");
  const shiftSegment = (segment: string) => segment
    .replace(columnRangePattern, (_whole, sheet: string | undefined, firstAbsolute: string, firstLabel: string, lastAbsolute: string, lastLabel: string) => (
      `${sheet ?? ""}${shiftColumn(firstLabel, firstAbsolute)}:${shiftColumn(lastLabel, lastAbsolute)}`
    ))
    .replace(rowRangePattern, (_whole, sheet: string | undefined, firstAbsolute: string, firstLabel: string, lastAbsolute: string, lastLabel: string) => (
      `${sheet ?? ""}${shiftRow(firstLabel, firstAbsolute)}:${shiftRow(lastLabel, lastAbsolute)}`
    ))
    .replace(cellPattern,
    (_whole, sheet: string | undefined, columnAbsolute: string, columnLabel: string, rowAbsolute: string, rowLabel: string) => {
      const column = spreadsheetColumnNumber(columnLabel) + (columnAbsolute ? 0 : columnDelta);
      const row = Number(rowLabel) + (rowAbsolute ? 0 : rowDelta);
      if (column < 1 || column > 16_384 || row < 1 || row > 1_048_576) return "#REF!";
      return `${sheet ?? ""}${columnAbsolute}${spreadsheetColumnLabel(column)}${rowAbsolute}${row}`;
    },
  );
  return formulaSegments(formula).map((segment) => segment.referenceSafe ? shiftSegment(segment.text) : segment.text).join("");
}

async function createFormulaResolver(buffer: ArrayBuffer): Promise<(sheetName: string, address: string) => Promise<string | undefined>> {
  if (buffer.byteLength > MAX_FORMULA_WORKBOOK_BYTES) throw new Error("Workbook exceeds formula lookup limit");
  const zip = new BoundedZipReader(buffer.slice(0));
  const [workbookXml, relationsXml] = await Promise.all([
    zip.text("xl/workbook.xml"),
    zip.text("xl/_rels/workbook.xml.rels"),
  ]);
  const workbook = parseXml(workbookXml);
  const relations = parseXml(relationsXml);
  const targetById = new Map<string, string>();
  for (const relation of Array.from(relations.getElementsByTagNameNS("*", "Relationship"))) {
    if (relation.getAttribute("TargetMode")?.toLowerCase() === "external") continue;
    const id = relation.getAttribute("Id");
    const target = relation.getAttribute("Target");
    const normalized = target ? normalizeZipTarget(target) : null;
    if (id && normalized) targetById.set(id, normalized);
  }
  const pathBySheet = new Map<string, string>();
  for (const sheet of Array.from(workbook.getElementsByTagNameNS("*", "sheet"))) {
    const name = sheet.getAttribute("name");
    const relationId = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? sheet.getAttribute("r:id");
    const target = relationId ? targetById.get(relationId) : undefined;
    if (name && target) pathBySheet.set(name, target);
  }
  const formulasBySheet = new Map<string, Promise<Map<string, string>>>();
  return async (sheetName, address) => {
    const path = pathBySheet.get(sheetName);
    if (!path) return undefined;
    let formulas = formulasBySheet.get(sheetName);
    if (!formulas) {
      formulas = zip.text(path).then((xml) => {
        const sheet = parseXml(xml);
        const result = new Map<string, string>();
        const shared = new Map<string, { address: string; formula: string }>();
        const pendingShared: Array<{ address: string; id: string }> = [];
        for (const cell of Array.from(sheet.getElementsByTagNameNS("*", "c"))) {
          const reference = cell.getAttribute("r")?.toUpperCase();
          const formulaNode = Array.from(cell.childNodes).find((child): child is Element => child.nodeType === 1 && (child as Element).localName === "f");
          const formula = formulaNode?.textContent?.trim();
          if (!reference || !formulaNode) continue;
          const sharedId = formulaNode.getAttribute("t") === "shared" ? formulaNode.getAttribute("si") : null;
          if (formula) {
            const normalized = formula.startsWith("=") ? formula : `=${formula}`;
            result.set(reference, normalized);
            if (sharedId) shared.set(sharedId, { address: reference, formula: normalized });
          } else if (sharedId) pendingShared.push({ address: reference, id: sharedId });
        }
        for (const pending of pendingShared) {
          const master = shared.get(pending.id);
          const shifted = master ? shiftSharedFormula(master.formula, master.address, pending.address) : undefined;
          if (shifted) result.set(pending.address, shifted);
        }
        return result;
      });
      formulasBySheet.set(sheetName, formulas);
    }
    return (await formulas).get(address.toUpperCase());
  };
}

export const agentlasSpreadsheetRenderer = {
  ...spreadsheetRenderer,
  id: "agentlas-spreadsheet-renderer",
  label: "Agentlas spreadsheet renderer with cell identity",
  handlers: spreadsheetRenderer.handlers?.map((registration) => ({
    ...registration,
    handler: async (...args: Parameters<typeof renderFileViewerSpreadsheet>) => {
      const [buffer, target] = args;
      const vendorStyle = await installSpreadsheetCellBridge();
      const style = target.ownerDocument.createElement("style");
      style.dataset.agentlasEVirtTableBridge = "true";
      style.textContent = vendorStyle;
      target.ownerDocument.head.append(style);
      const formulaResolver = createFormulaResolver(buffer).catch(() => null);
      let disposed = false;
      const handleCell = (event: Event) => {
        const custom = event as CustomEvent<SpreadsheetCellDetail>;
        if (custom.detail.formulaState !== "loading") return;
        const selected = custom.detail;
        void formulaResolver.then((resolver) => resolver?.(selected.sheetName, selected.address)).then((formula) => {
          if (disposed) return;
          const detail: SpreadsheetCellDetail = {
            ...selected,
            ...(formula ? { formula } : {}),
            formulaState: formula ? "ready" : "unavailable",
          };
          target.dispatchEvent(new CustomEvent<SpreadsheetCellDetail>(SPREADSHEET_CELL_EVENT, { bubbles: true, composed: true, detail }));
        }).catch(() => {
          if (disposed) return;
          target.dispatchEvent(new CustomEvent<SpreadsheetCellDetail>(SPREADSHEET_CELL_EVENT, {
            bubbles: true,
            composed: true,
            detail: { ...selected, formulaState: "unavailable" },
          }));
        });
      };
      target.addEventListener(SPREADSHEET_CELL_EVENT, handleCell);
      try {
        const rendered = await renderFileViewerSpreadsheet(...args);
        if ("unmount" in rendered && typeof rendered.unmount === "function") {
          const originalUnmount = rendered.unmount.bind(rendered);
          rendered.unmount = () => {
            disposed = true;
            target.removeEventListener(SPREADSHEET_CELL_EVENT, handleCell);
            return originalUnmount();
          };
        } else if ("$destroy" in rendered && typeof rendered.$destroy === "function") {
          const originalDestroy = rendered.$destroy.bind(rendered);
          rendered.$destroy = () => {
            disposed = true;
            target.removeEventListener(SPREADSHEET_CELL_EVENT, handleCell);
            return originalDestroy();
          };
        }
        return rendered;
      } catch (error) {
        disposed = true;
        target.removeEventListener(SPREADSHEET_CELL_EVENT, handleCell);
        throw error;
      } finally {
        style.remove();
      }
    },
  })),
};

const DOCUMENT_CHROME_STYLE = `
:host { display: block; height: 100%; min-height: 0; }
.file-render-shadow-target { height: 100%; min-height: 0; }
.pdf-toolbar { display: none !important; }
.pdf-shell { position: relative; background: #edf0f4 !important; }
.pdf-content { grid-template-columns: 132px minmax(0, 1fr) !important; }
.pdf-nav-pane { background: #f7f8fa !important; border-right-color: #d9dde3 !important; }
.pdf-nav-head, .pdf-nav-tabs { display: none !important; }
.pdf-page-list { gap: 10px !important; padding: 12px 10px !important; }
.pdf-page-button { grid-template-columns: minmax(0, 1fr) !important; gap: 4px !important; padding: 5px !important; border-radius: 7px !important; background: transparent !important; }
.pdf-page-button--with-thumbnail { min-height: 0 !important; }
.pdf-page-thumb--thumbnail { width: 100% !important; height: auto !important; border-radius: 3px !important; background: #fff !important; box-shadow: 0 1px 4px rgba(15,23,42,.12); }
.pdf-page-thumb--thumbnail img { width: 100% !important; height: auto !important; object-fit: contain !important; }
.pdf-page-label { text-align: center !important; font-size: 11px !important; color: #69717d !important; }
.pdf-page-button--active { border-color: #6b73ff !important; background: #eef0ff !important; box-shadow: inset 3px 0 0 #6366f1 !important; }
.pdf-wrapper { background: #edf0f4 !important; overflow: hidden !important; }
.pdfViewer { min-height: 100%; padding: 22px 20px var(--agentlas-pdf-tail-space, 34px) !important; }
.pdfViewer .page { margin: 0 auto !important; }
.pdf-shell[data-agentlas-single-page-ready='true'] .pdfViewer .page:not([data-agentlas-active-page='true']) { visibility: hidden !important; pointer-events: none !important; }
.agentlas-pptx-nav { min-width: 0; min-height: 0; overflow-y: auto; padding: 12px 10px; border-right: 1px solid #d9dde3; background: #f7f8fa; }
.agentlas-pptx-thumb { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: start; gap: 5px; width: 100%; margin: 0 0 10px; padding: 5px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: #69717d; font: 11px/1.2 system-ui, sans-serif; cursor: pointer; }
.agentlas-pptx-thumb:hover { background: #f0f2f5; }
.agentlas-pptx-thumb:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
.agentlas-pptx-thumb[data-active='true'] { border-color: #6b73ff; background: #eef0ff; box-shadow: inset 3px 0 0 #6366f1; color: #343a46; }
.agentlas-pptx-thumb-preview { min-width: 0; min-height: 54px; overflow: hidden; position: relative; border: 1px solid #d7dbe1; border-radius: 3px; background: #fff; box-shadow: 0 1px 4px rgba(15,23,42,.12); pointer-events: none; }
.agentlas-pptx-thumb-preview > * { position: absolute !important; inset: 0 auto auto 0 !important; margin: 0 !important; transform-origin: 0 0 !important; pointer-events: none !important; }
.file-viewer-web-content > .file-render:has(> .pptx-viewer-shell) { height: 100% !important; min-height: 0 !important; }
.pptx-viewer-shell { position: relative; box-sizing: border-box !important; width: 100%; height: 100%; min-height: 0 !important; display: grid !important; grid-template-columns: 132px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); padding: 0 !important; overflow: hidden; background: #edf0f4 !important; }
.pptx-viewer-shell > .agentlas-pptx-nav { grid-column: 1; grid-row: 1; }
.pptx-viewer-shell > .pptx-render-surface { grid-column: 2; grid-row: 1; }
.pptx-loading, .pptx-error { position: absolute !important; z-index: 5 !important; }
.pptx-render-surface { min-width: 0; min-height: 0 !important; height: 100%; overflow: auto; box-sizing: border-box; padding: 22px 20px 34px; background: #edf0f4; }
.pptx-render-surface [data-agentlas-paged-slide='true']:not([data-agentlas-active-slide='true']) { display: none !important; }
.pptx-render-surface > [data-slide-index],
.pptx-render-surface > .slide,
.pptx-render-surface > .flyfish-pptx-slide-slot { margin-inline: auto !important; box-shadow: 0 2px 12px rgba(15,23,42,.14); }
.pptx-slideshow-button { display: none !important; }
.agentlas-document-nav-toggle { display: none; position: absolute; top: 10px; left: 10px; z-index: 8; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid #d5dae1; border-radius: 7px; background: rgba(255,255,255,.94); color: #515966; box-shadow: 0 2px 8px rgba(15,23,42,.10); font: 600 16px/1 system-ui, sans-serif; cursor: pointer; }
.agentlas-document-nav-toggle:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
.pdf-shell[data-agentlas-layout='compact'] .pdf-content { grid-template-columns: minmax(0, 1fr) !important; }
.pptx-viewer-shell[data-agentlas-layout='compact'] { grid-template-columns: minmax(0, 1fr) !important; }
.pptx-viewer-shell[data-agentlas-layout='compact'] > .pptx-render-surface { grid-column: 1; }
.pdf-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] .pdf-content { grid-template-columns: 132px minmax(0, 1fr) !important; }
.pdf-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] .pdf-nav-pane { grid-column: 1; grid-row: 1; position: relative; inset: auto; width: auto; z-index: auto; box-shadow: none; }
.pdf-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] .pdf-wrapper { grid-column: 2; grid-row: 1; min-width: 0; }
.pptx-viewer-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] { grid-template-columns: 132px minmax(0, 1fr) !important; }
.pptx-viewer-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] > .agentlas-pptx-nav { grid-column: 1; grid-row: 1; position: relative; inset: auto; width: auto; z-index: auto; box-shadow: none; }
.pptx-viewer-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] > .pptx-render-surface { grid-column: 2; grid-row: 1; }
.pdf-shell[data-agentlas-layout='compact'] .agentlas-document-nav-toggle,
.pptx-viewer-shell[data-agentlas-layout='compact'] .agentlas-document-nav-toggle { display: inline-flex; }
.pdf-shell[data-agentlas-layout='compact'] .pdf-nav-pane,
.pptx-viewer-shell[data-agentlas-layout='compact'] .agentlas-pptx-nav { position: absolute; z-index: 7; inset: 0 auto 0 0; width: 132px; box-sizing: border-box; box-shadow: 8px 0 20px rgba(15,23,42,.14); }
.pdf-shell[data-agentlas-layout='compact']:not([data-agentlas-nav-open='true']) .pdf-nav-pane,
.pptx-viewer-shell[data-agentlas-layout='compact']:not([data-agentlas-nav-open='true']) .agentlas-pptx-nav { display: none !important; }
.pdf-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] .agentlas-document-nav-toggle,
.pptx-viewer-shell[data-agentlas-layout='compact'][data-agentlas-nav-open='true'] .agentlas-document-nav-toggle { left: 142px; }
.pdf-shell[data-agentlas-layout='compact'] .pdfViewer { padding-inline: 12px !important; }
.pptx-viewer-shell[data-agentlas-layout='compact'] .pptx-render-surface { padding-inline: 12px; }
.excel-wrapper[data-file-viewer-spreadsheet-root] { --evt-select-border-color: #6366f1; --evt-select-area-color: rgba(99,102,241,.08); }
.excel-wrapper[data-file-viewer-spreadsheet-root] > .toolbar > .summary { display: none; }
.excel-wrapper[data-file-viewer-spreadsheet-root] > .toolbar > .btn-group { flex: 1 1 0; min-width: 0; overflow-x: auto; }
.agentlas-sheet-formula-bar { flex: 0 0 34px; min-height: 34px; display: grid; grid-template-columns: 64px 32px minmax(0,1fr); align-items: center; border-bottom: 1px solid #d9dde3; background: #fff; color: #303743; font: 12px/1.2 system-ui,sans-serif; }
.agentlas-sheet-cell-address { align-self: stretch; display: flex; align-items: center; justify-content: center; border-right: 1px solid #d9dde3; font-weight: 650; font-variant-numeric: tabular-nums; }
.agentlas-sheet-fx { color: #6b7280; text-align: center; font: italic 600 13px/1 Georgia,serif; }
.agentlas-sheet-cell-value { min-width: 0; overflow: hidden; padding: 0 10px; white-space: nowrap; text-overflow: ellipsis; }
.agentlas-sheet-selection-outline { position: absolute; z-index: 46; box-sizing: border-box; border: 2px solid #6366f1; box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset; pointer-events: none; }
.excel-wrapper[data-spreadsheet-theme='dark'] .agentlas-sheet-formula-bar { background: #111827; border-color: #374151; color: #e5e7eb; }
.excel-wrapper[data-spreadsheet-theme='dark'] .agentlas-sheet-cell-address { border-color: #374151; }
`;

export interface PagedDocumentChrome {
  refresh: () => void;
  fitSelectedPage: () => Promise<FileViewerZoomState | null>;
  dispose: () => void;
}

function prepareThumbnailClone(root: HTMLElement, prefix: string): void {
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("inert", "");
  const idMap = new Map<string, string>();
  for (const [idIndex, element] of [root, ...root.querySelectorAll<HTMLElement>("[id]")].entries()) {
    const id = element.id;
    if (!id) continue;
    const next = `${prefix}-${idIndex}-${id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
    idMap.set(id, next);
    element.id = next;
  }
  for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("tabindex");
    for (const attribute of Array.from(element.attributes)) {
      let value = attribute.value.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gu, (whole, quote: string, id: string) => idMap.has(id) ? `url(${quote}#${idMap.get(id)}${quote})` : whole);
      if (["for", "aria-controls", "aria-describedby", "aria-labelledby"].includes(attribute.name)) {
        value = value.split(/\s+/u).map((id) => idMap.get(id)).filter(Boolean).join(" ");
        if (!value) { element.removeAttribute(attribute.name); continue; }
      }
      if ((attribute.name === "href" || attribute.name === "xlink:href") && value.startsWith("#")) {
        const mapped = idMap.get(value.slice(1));
        value = mapped ? `#${mapped}` : "";
      } else if (attribute.name === "href") {
        value = "";
      }
      if (value) element.setAttribute(attribute.name, value);
      else element.removeAttribute(attribute.name);
    }
    if (element instanceof HTMLStyleElement && element.textContent) {
      element.textContent = element.textContent.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gu, (whole, quote: string, id: string) => idMap.has(id) ? `url(${quote}#${idMap.get(id)}${quote})` : whole);
    }
    if (element.matches("button, input, select, textarea, audio, video, iframe")) {
      element.setAttribute("inert", "");
      element.setAttribute("tabindex", "-1");
    }
  }
}

function presentationSlides(surface: HTMLElement): HTMLElement[] {
  const slots = Array.from(surface.querySelectorAll<HTMLElement>(".flyfish-pptx-slide-slot"));
  if (slots.length > 0) return slots;
  return Array.from(surface.querySelectorAll<HTMLElement>("[data-slide-index], .slide"));
}

function ensureNavigationToggle(shell: HTMLElement, locale: "ko" | "en", kind: "page" | "slide", onToggle?: () => void): void {
  if (shell.querySelector(":scope > .agentlas-document-nav-toggle")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agentlas-document-nav-toggle";
  const label = locale === "ko"
    ? `${kind === "page" ? "페이지" : "슬라이드"} 목록`
    : `${kind === "page" ? "Page" : "Slide"} thumbnails`;
  const sync = () => {
    const open = shell.dataset.agentlasNavOpen === "true";
    button.textContent = open ? "‹" : "›";
    button.setAttribute("aria-label", `${label} ${open ? (locale === "ko" ? "접기" : "collapse") : (locale === "ko" ? "펼치기" : "expand")}`);
    button.setAttribute("aria-expanded", String(open));
  };
  shell.addEventListener("agentlas-navigation-sync", sync);
  button.addEventListener("click", () => {
    shell.dataset.agentlasNavOpen = shell.dataset.agentlasNavOpen === "true" ? "false" : "true";
    sync();
    onToggle?.();
  });
  sync();
  shell.append(button);
}

function closeCompactNavigation(shell: HTMLElement): void {
  if (shell.dataset.agentlasLayout !== "compact") return;
  shell.dataset.agentlasNavOpen = "false";
  shell.dispatchEvent(new Event("agentlas-navigation-sync"));
}

function observeCodexPanelLayout(shell: HTMLElement, onResize?: () => void): ResizeObserver | null {
  const apply = (width: number) => {
    const next = width <= 688 ? "compact" : "desktop";
    if (shell.dataset.agentlasLayout !== next) {
      shell.dataset.agentlasLayout = next;
      if (next === "desktop") shell.dataset.agentlasNavOpen = "false";
    }
    onResize?.();
  };
  apply(shell.getBoundingClientRect().width);
  if (typeof ResizeObserver === "undefined") return null;
  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (typeof width === "number" && width > 0) apply(width);
  });
  observer.observe(shell);
  return observer;
}

function renderPresentationThumb(preview: HTMLElement, slide: HTMLElement, index: number): void {
  const clone = slide.cloneNode(true) as HTMLElement;
  const sourceCanvases = [slide, ...slide.querySelectorAll<HTMLElement>("canvas")].filter((node): node is HTMLCanvasElement => node instanceof HTMLCanvasElement);
  const cloneCanvases = [clone, ...clone.querySelectorAll<HTMLElement>("canvas")].filter((node): node is HTMLCanvasElement => node instanceof HTMLCanvasElement);
  sourceCanvases.forEach((sourceCanvas, canvasIndex) => {
    const cloneCanvas = cloneCanvases[canvasIndex];
    if (!cloneCanvas) return;
    cloneCanvas.width = sourceCanvas.width;
    cloneCanvas.height = sourceCanvas.height;
    try { cloneCanvas.getContext("2d")?.drawImage(sourceCanvas, 0, 0); } catch { /* A tainted canvas stays blank rather than leaking pixels. */ }
  });
  prepareThumbnailClone(clone, `agentlas-pptx-thumb-${index}`);
  const width = Math.max(1, slide.scrollWidth || slide.offsetWidth || 960);
  const height = Math.max(1, slide.scrollHeight || slide.offsetHeight || 540);
  const availableWidth = Math.max(72, preview.clientWidth || 92);
  const scale = Math.min(availableWidth / width, 72 / height);
  preview.style.height = `${Math.max(54, Math.round(height * scale))}px`;
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.transform = `scale(${scale})`;
  preview.replaceChildren(clone);
}

async function fitPresentationSurface(surface: HTMLElement): Promise<FileViewerZoomState | null> {
  const activeSlide = presentationSlides(surface).find((slide) => slide.dataset.agentlasActiveSlide === "true");
  const slideContent = activeSlide?.matches(".slide")
    ? activeSlide
    : activeSlide?.querySelector<HTMLElement>(":scope > .slide") ?? activeSlide?.querySelector<HTMLElement>(".slide");
  // The presentation provider is registered on the owning shell, not on its
  // child surface. A surface-only lookup misses it and falls back to generic
  // fit, which repeatedly scales the already-scaled presentation.
  const provider = findFileViewerZoomProvider(surface.closest<HTMLElement>(".pptx-viewer-shell") ?? surface);
  if (!slideContent || !provider?.setZoom) return null;
  const style = getComputedStyle(surface);
  const availableWidth = Math.max(1, surface.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0"));
  const availableHeight = Math.max(1, surface.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0"));
  const naturalWidth = Math.max(1, slideContent.offsetWidth || slideContent.scrollWidth);
  const naturalHeight = Math.max(1, slideContent.offsetHeight || slideContent.scrollHeight);
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const targetScale = Math.min(2, Math.max(0.25, Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight)));
  await provider.setZoom(targetScale);
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  return provider.getState();
}

export function installPagedDocumentChrome(host: HTMLElement, locale: "ko" | "en", onPageSelected?: () => void): PagedDocumentChrome {
  let disposed = false;
  let discoveryTimer = 0;
  let discoveryStop = 0;
  let surfaceObserver: MutationObserver | null = null;
  let thumbObserver: IntersectionObserver | null = null;
  let activeSlideObserver: IntersectionObserver | null = null;
  let managedSurface: HTMLElement | null = null;
  let managedSlides: HTMLElement[] = [];
  let pdfRoot: ShadowRoot | null = null;
  let pdfShell: HTMLElement | null = null;
  let pdfObserver: MutationObserver | null = null;
  let pdfClickHandler: ((event: Event) => void) | null = null;
  let pdfResizeObserver: ResizeObserver | null = null;
  let presentationResizeObserver: ResizeObserver | null = null;
  let presentationFitFrame = 0;
  let spreadsheetRoot: ShadowRoot | null = null;
  let spreadsheetShell: HTMLElement | null = null;
  let spreadsheetCellHandler: ((event: Event) => void) | null = null;
  let spreadsheetWheelHandler: (() => void) | null = null;
  let spreadsheetClickHandler: ((event: Event) => void) | null = null;
  let pdfAlignTimer = 0;
  let pdfSelectionFrame = 0;
  let pdfSettleFrame = 0;
  let pdfSelectionRevision = 0;
  let rebuildFrame = 0;

  const stopDiscovery = () => {
    if (discoveryTimer) window.clearInterval(discoveryTimer);
    if (discoveryStop) window.clearTimeout(discoveryStop);
    discoveryTimer = 0;
    discoveryStop = 0;
  };

  const disconnectPresentation = () => {
    surfaceObserver?.disconnect();
    thumbObserver?.disconnect();
    activeSlideObserver?.disconnect();
    surfaceObserver = null;
    thumbObserver = null;
    activeSlideObserver = null;
    managedSurface = null;
    managedSlides = [];
    presentationResizeObserver?.disconnect();
    presentationResizeObserver = null;
    if (presentationFitFrame) window.cancelAnimationFrame(presentationFitFrame);
    presentationFitFrame = 0;
    if (rebuildFrame) window.cancelAnimationFrame(rebuildFrame);
    rebuildFrame = 0;
  };

  const cancelPdfAlignment = () => {
    pdfSelectionRevision += 1;
    if (pdfSelectionFrame) window.cancelAnimationFrame(pdfSelectionFrame);
    if (pdfSettleFrame) window.cancelAnimationFrame(pdfSettleFrame);
    if (pdfAlignTimer) window.clearTimeout(pdfAlignTimer);
    pdfSelectionFrame = 0;
    pdfSettleFrame = 0;
    pdfAlignTimer = 0;
  };

  const disconnectPdf = () => {
    pdfObserver?.disconnect();
    pdfResizeObserver?.disconnect();
    cancelPdfAlignment();
    if (pdfRoot && pdfClickHandler) pdfRoot.removeEventListener("click", pdfClickHandler, true);
    pdfShell?.removeAttribute("data-agentlas-single-page-ready");
    pdfRoot = null;
    pdfShell = null;
    pdfObserver = null;
    pdfResizeObserver = null;
    pdfClickHandler = null;
    pdfAlignTimer = 0;
  };

  const disconnectSpreadsheet = () => {
    if (spreadsheetRoot && spreadsheetCellHandler) spreadsheetRoot.removeEventListener(SPREADSHEET_CELL_EVENT, spreadsheetCellHandler);
    if (spreadsheetRoot && spreadsheetWheelHandler) spreadsheetRoot.removeEventListener("wheel", spreadsheetWheelHandler, true);
    if (spreadsheetRoot && spreadsheetClickHandler) spreadsheetRoot.removeEventListener("click", spreadsheetClickHandler, true);
    spreadsheetShell?.querySelector(":scope > .agentlas-sheet-formula-bar")?.remove();
    spreadsheetShell?.querySelector(".agentlas-sheet-selection-outline")?.remove();
    spreadsheetRoot = null;
    spreadsheetShell = null;
    spreadsheetCellHandler = null;
    spreadsheetWheelHandler = null;
    spreadsheetClickHandler = null;
  };

  const installSpreadsheet = (root: ShadowRoot): boolean => {
    const shell = root.querySelector<HTMLElement>("[data-file-viewer-spreadsheet-root]");
    const tableWrapper = shell?.querySelector<HTMLElement>(":scope > .table-wrapper");
    const tableHost = tableWrapper?.querySelector<HTMLElement>(".table-host");
    if (!shell || !tableWrapper || !tableHost) return false;
    if (spreadsheetRoot === root && spreadsheetShell === shell && spreadsheetCellHandler) return true;
    disconnectSpreadsheet();
    spreadsheetRoot = root;
    spreadsheetShell = shell;

    const bar = document.createElement("div");
    bar.className = "agentlas-sheet-formula-bar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    const address = document.createElement("span");
    address.className = "agentlas-sheet-cell-address";
    address.textContent = "—";
    const fx = document.createElement("span");
    fx.className = "agentlas-sheet-fx";
    fx.textContent = "fx";
    fx.setAttribute("aria-hidden", "true");
    const value = document.createElement("span");
    value.className = "agentlas-sheet-cell-value";
    value.textContent = locale === "ko" ? "셀을 선택하세요" : "Select a cell";
    bar.append(address, fx, value);
    shell.insertBefore(bar, tableWrapper);

    const outline = document.createElement("span");
    outline.className = "agentlas-sheet-selection-outline";
    outline.hidden = true;
    tableHost.append(outline);
    let latestSelectionId = 0;
    spreadsheetCellHandler = (event) => {
      const detail = (event as CustomEvent<SpreadsheetCellDetail>).detail;
      if (!detail || detail.selectionId < latestSelectionId) return;
      const isNewSelection = detail.selectionId > latestSelectionId;
      latestSelectionId = detail.selectionId;
      address.textContent = detail.address;
      address.title = detail.sheetName ? `${detail.sheetName}!${detail.address}` : detail.address;
      const shownValue = detail.formulaState === "ready" && detail.formula ? detail.formula : detail.displayValue;
      value.textContent = shownValue;
      value.title = shownValue;
      if (isNewSelection) {
        outline.hidden = false;
        outline.style.left = `${detail.rect.x}px`;
        outline.style.top = `${detail.rect.y}px`;
        outline.style.width = `${detail.rect.width}px`;
        outline.style.height = `${detail.rect.height}px`;
      }
    };
    spreadsheetWheelHandler = () => { outline.hidden = true; };
    spreadsheetClickHandler = (event) => {
      const target = event.target instanceof Element ? event.target.closest(".sheet-tab") : null;
      if (!target) return;
      latestSelectionId = 0;
      address.textContent = "—";
      address.removeAttribute("title");
      value.textContent = locale === "ko" ? "셀을 선택하세요" : "Select a cell";
      value.removeAttribute("title");
      outline.hidden = true;
    };
    root.addEventListener(SPREADSHEET_CELL_EVENT, spreadsheetCellHandler);
    root.addEventListener("wheel", spreadsheetWheelHandler, true);
    root.addEventListener("click", spreadsheetClickHandler, true);
    return true;
  };

  const installPdf = (root: ShadowRoot): boolean => {
    const viewer = root.querySelector<HTMLElement>(".pdfViewer");
    const nav = root.querySelector<HTMLElement>(".pdf-page-list");
    const shell = root.querySelector<HTMLElement>(".pdf-shell");
    const state = root.querySelector<HTMLElement>(".pdf-state");
    if (!viewer || !nav || !shell || !state?.hidden) return false;
    if (pdfRoot === root && pdfObserver) return true;
    disconnectPdf();
    pdfRoot = root;
    pdfShell = shell;
    ensureNavigationToggle(shell, locale, "page", onPageSelected);
    const wrapper = root.querySelector<HTMLElement>(".pdf-wrapper");
    const navigationButtons = () => Array.from(nav.querySelectorAll<HTMLElement>(".pdf-page-button"));
    const initialActive = nav.querySelector<HTMLElement>(".pdf-page-button--active");
    let selectedPage = Math.max(1, initialActive ? navigationButtons().indexOf(initialActive) + 1 : 1);
    const showPage = (page: number) => {
      if (disposed || pdfRoot !== root) return;
      const pages = Array.from(viewer.querySelectorAll<HTMLElement>(".page[data-page-number]"));
      selectedPage = Math.max(1, Math.min(page, Math.max(1, pages.length)));
      pages.forEach((pageNode) => {
        const active = Number(pageNode.dataset.pageNumber) === selectedPage;
        pageNode.dataset.agentlasActivePage = active ? "true" : "false";
      });
      navigationButtons().forEach((button, index) => {
        const active = index + 1 === selectedPage;
        button.classList.toggle("pdf-page-button--active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      const activePage = pages.find((pageNode) => Number(pageNode.dataset.pageNumber) === selectedPage);
      if (wrapper && activePage) {
        viewer.style.setProperty("--agentlas-pdf-tail-space", `${Math.max(34, wrapper.clientHeight)}px`);
        wrapper.scrollTop = Math.max(0, activePage.offsetTop - 12);
        wrapper.scrollLeft = Math.max(0, activePage.offsetLeft - 12);
      }
    };
    pdfResizeObserver = observeCodexPanelLayout(shell, () => {
      if (disposed || pdfRoot !== root) return;
      showPage(selectedPage);
      onPageSelected?.();
    });
    pdfClickHandler = (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".pdf-page-button") : null;
      if (!target) return;
      const page = navigationButtons().indexOf(target) + 1;
      cancelPdfAlignment();
      const revision = pdfSelectionRevision;
      const isCurrentSelection = () => !disposed && pdfRoot === root && revision === pdfSelectionRevision;
      showPage(page);
      closeCompactNavigation(shell);
      pdfSelectionFrame = window.requestAnimationFrame(() => {
        pdfSelectionFrame = 0;
        if (!isCurrentSelection()) return;
        showPage(page);
        onPageSelected?.();
        if (!isCurrentSelection()) return;
        pdfSettleFrame = window.requestAnimationFrame(() => {
          pdfSettleFrame = 0;
          if (isCurrentSelection()) showPage(page);
        });
        pdfAlignTimer = window.setTimeout(() => {
          pdfAlignTimer = 0;
          if (isCurrentSelection()) showPage(page);
        }, 120);
      });
    };
    root.addEventListener("click", pdfClickHandler, true);
    pdfObserver = new MutationObserver(() => showPage(selectedPage));
    pdfObserver.observe(viewer, { childList: true, subtree: true });
    showPage(selectedPage);
    shell.dataset.agentlasSinglePageReady = "true";
    return true;
  };

  const installPresentation = (root: ShadowRoot): boolean => {
    const shell = root.querySelector<HTMLElement>(".pptx-viewer-shell");
    const surface = shell?.querySelector<HTMLElement>(":scope > .pptx-render-surface");
    if (!shell || !surface) return false;
    let schedulePresentationFit = () => {};
    ensureNavigationToggle(shell, locale, "slide", () => schedulePresentationFit());
    let nav = shell.querySelector<HTMLElement>(":scope > .agentlas-pptx-nav");
    if (!nav) {
      nav = document.createElement("aside");
      nav.className = "agentlas-pptx-nav";
      nav.setAttribute("aria-label", locale === "ko" ? "슬라이드" : "Slides");
      shell.insertBefore(nav, surface);
    }
    if (managedSurface === surface && surfaceObserver) return true;

    schedulePresentationFit = () => {
      if (presentationFitFrame) window.cancelAnimationFrame(presentationFitFrame);
      // The provider updates fitScale in its own resize frame after a compact
      // rail opens or closes. Wait for that layout, then run a second fit after
      // the provider's resize pass so the selected slide uses the live scale.
      const waitForLayout = (frames: number, afterLayout: () => void): void => {
        presentationFitFrame = window.requestAnimationFrame(() => {
          if (frames > 1) {
            waitForLayout(frames - 1, afterLayout);
            return;
          }
          afterLayout();
        });
      };
      waitForLayout(3, () => {
        if (disposed || managedSurface !== surface) return;
        onPageSelected?.();
        waitForLayout(4, () => {
          presentationFitFrame = 0;
          if (!disposed && managedSurface === surface) onPageSelected?.();
        });
      });
    };

    const setActive = (active: number) => {
      presentationSlides(surface).forEach((slide, index) => {
        slide.dataset.agentlasPagedSlide = "true";
        slide.dataset.agentlasActiveSlide = index === active ? "true" : "false";
      });
      nav.querySelectorAll<HTMLElement>(".agentlas-pptx-thumb").forEach((button, index) => {
        button.dataset.active = index === active ? "true" : "false";
        if (index === active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
    };

    const syncActiveFallback = () => {
      const slides = presentationSlides(surface);
      if (slides.length === 0) return;
      const surfaceTop = surface.getBoundingClientRect().top;
      let active = 0;
      let distance = Number.POSITIVE_INFINITY;
      slides.forEach((slide, index) => {
        const next = Math.abs(slide.getBoundingClientRect().top - surfaceTop - 12);
        if (next < distance) { active = index; distance = next; }
      });
      setActive(active);
    };

    const dirtySlides = new Set<number>();
    const visibleRatios = new Map<number, number>();
    const configureActiveSlides = (slides: HTMLElement[]) => {
      activeSlideObserver?.disconnect();
      visibleRatios.clear();
      if (typeof IntersectionObserver !== "function") {
        syncActiveFallback();
        return;
      }
      const indexBySlide = new Map(slides.map((slide, index) => [slide, index]));
      activeSlideObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const index = indexBySlide.get(entry.target as HTMLElement);
          if (index === undefined) continue;
          if (entry.isIntersecting) visibleRatios.set(index, entry.intersectionRatio);
          else visibleRatios.delete(index);
        }
        let active = 0;
        let best = -1;
        for (const [index, ratio] of visibleRatios) {
          if (ratio > best) { active = index; best = ratio; }
        }
        setActive(active);
      }, { root: surface, threshold: [0, 0.2, 0.5, 0.8, 1] });
      slides.forEach((slide) => activeSlideObserver?.observe(slide));
    };

    const rebuild = () => {
      rebuildFrame = 0;
      const slides = presentationSlides(surface);
      const current = Array.from(nav.querySelectorAll<HTMLElement>(".agentlas-pptx-thumb"));
      const sameSlides = slides.length === managedSlides.length && slides.every((slide, index) => slide === managedSlides[index]);
      if (slides.length === current.length && slides.length > 0 && sameSlides) {
        for (const index of dirtySlides) {
          const preview = current[index]?.querySelector<HTMLElement>(".agentlas-pptx-thumb-preview");
          if (preview?.childElementCount && slides[index]) renderPresentationThumb(preview, slides[index], index);
        }
        dirtySlides.clear();
        return;
      }
      dirtySlides.clear();
      managedSlides = slides;
      thumbObserver?.disconnect();
      nav.replaceChildren();
      thumbObserver = typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const button = entry.target as HTMLButtonElement;
              const index = Number(button.dataset.slideIndex);
              const slide = presentationSlides(surface)[index];
              const preview = button.querySelector<HTMLElement>(".agentlas-pptx-thumb-preview");
              if (slide && preview) renderPresentationThumb(preview, slide, index);
              thumbObserver?.unobserve(button);
            }
          }, { root: nav, rootMargin: "160px 0px" })
        : null;
      slides.forEach((slide, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "agentlas-pptx-thumb";
        button.dataset.slideIndex = String(index);
        button.setAttribute("aria-label", locale === "ko" ? `${index + 1}번 슬라이드로 이동` : `Go to slide ${index + 1}`);
        const number = document.createElement("span");
        number.textContent = String(index + 1);
        const preview = document.createElement("span");
        preview.className = "agentlas-pptx-thumb-preview";
        button.append(number, preview);
        button.addEventListener("click", () => {
          setActive(index);
          closeCompactNavigation(shell);
          schedulePresentationFit();
        });
        nav.append(button);
        if (thumbObserver) thumbObserver.observe(button);
        else renderPresentationThumb(preview, slide, index);
      });
      configureActiveSlides(slides);
      syncActiveFallback();
      schedulePresentationFit();
    };

    disconnectPresentation();
    managedSurface = surface;
    presentationResizeObserver = observeCodexPanelLayout(shell, schedulePresentationFit);
    surfaceObserver = new MutationObserver((records) => {
      const slides = presentationSlides(surface);
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const slide = target?.closest<HTMLElement>(".flyfish-pptx-slide-slot, [data-slide-index], .slide");
        const index = slide ? slides.indexOf(slide) : -1;
        if (index >= 0) dirtySlides.add(index);
        else if (record.target === surface) slides.forEach((_item, slideIndex) => dirtySlides.add(slideIndex));
      }
      if (rebuildFrame) return;
      rebuildFrame = window.requestAnimationFrame(rebuild);
    });
    surfaceObserver.observe(surface, { childList: true, subtree: true });
    rebuild();
    return true;
  };

  const apply = (): boolean => {
    if (disposed) return true;
    const viewerHost = Array.from(host.children).find((child) => child instanceof HTMLElement && child.shadowRoot);
    const root = viewerHost instanceof HTMLElement ? viewerHost.shadowRoot : null;
    if (!root) return false;
    let style = root.querySelector<HTMLStyleElement>("style[data-agentlas-document-chrome]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.agentlasDocumentChrome = "true";
      style.textContent = DOCUMENT_CHROME_STYLE;
    }
    // Renderer packages append their own stylesheet while loading. Keep the
    // host compatibility layer last without duplicating it.
    root.append(style);
    if (root.querySelector(".pptx-viewer-shell")) return installPresentation(root);
    if (root.querySelector(".pdf-shell")) return installPdf(root);
    if (root.querySelector("[data-file-viewer-spreadsheet-root]")) return installSpreadsheet(root);
    return Boolean(root.querySelector(".pdf-shell, .docx-fit-viewer"));
  };

  const refresh = () => {
    if (apply()) stopDiscovery();
  };
  if (!apply()) {
    discoveryTimer = window.setInterval(refresh, 100);
    discoveryStop = window.setTimeout(stopDiscovery, 10_000);
  }

  return {
    refresh,
    fitSelectedPage: () => managedSurface ? fitPresentationSurface(managedSurface) : Promise.resolve(null),
    dispose: () => {
      disposed = true;
      stopDiscovery();
      disconnectPresentation();
      disconnectPdf();
      disconnectSpreadsheet();
    },
  };
}
