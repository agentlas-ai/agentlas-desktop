import { cellAddress, LIVE_DOCUMENT_RENDER_LIMITS, parseCellAddress, type LiveDocumentModel, type LiveFlowBlock, type LiveFormat, type LivePage, type LiveShape, type LiveSlide } from "../../shared/live-document";
import { chartSvg, cssColor, shapeSvg } from "./render-look";

/*
 * Standalone HTML for each page of a live document, laid out the way the Document tab lays it out (the same shape boxes,
 * point sizes, page paper and margins), so document.render can photograph what a reviewer would check: text running out
 * of its box, boxes overlapping, a table running off the page.
 *
 * Two differences from the tab, both on purpose: text is never clipped (Office lets it run out of the box, and clipping
 * would hide the very fault a reviewer looks for), and every text box carries data-box so render.ts can measure overflow.
 * No script, no network: the page is our own markup; the window that loads it runs no page script.
 *
 * No electron import: the layout is tested without a window.
 */

export const RENDER_SLIDE_WIDTH = 1280;
const MM = 96 / 25.4;
const A4: LivePage = { width: 210, height: 297, margin: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } };
const SHEET_MAX_ROWS = 60;
const SHEET_MAX_COLS = 20;

/**
 * A page this layout cannot draw: a size or margins outside LIVE_DOCUMENT_RENDER_LIMITS. The reason is the typed refusal
 * document.render answers with and the detail is the plain-words explanation; render.ts reads both off any error that has them.
 */
export class RenderGeometryError extends Error {
  readonly reason = "render_page_size_invalid";
  constructor(readonly detail: string) { super(`render_page_size_invalid: ${detail}`); }
}

const FILE_ADVICE = "Fix the page size in the file; document.read still shows its text.";
const mmText = (value: number): string => String(Number(value.toFixed(1)));

/** A flow document's paper and margins must leave a page to draw on. */
export function assertFlowPage(page: LivePage): void {
  const { minPageMm, maxPageMm } = LIVE_DOCUMENT_RENDER_LIMITS;
  const sane = (value: number) => Number.isFinite(value) && value >= minPageMm && value <= maxPageMm;
  if (!sane(page.width) || !sane(page.height)) {
    throw new RenderGeometryError(`This document's page is ${mmText(page.width)} x ${mmText(page.height)} mm, which cannot be drawn (each side must be ${minPageMm}-${maxPageMm} mm). ${FILE_ADVICE}`);
  }
  const { top, right, bottom, left } = page.margin;
  if (![top, right, bottom, left].every((value) => Number.isFinite(value) && value >= 0) || page.height - top - bottom < 10 || page.width - left - right < 10) {
    throw new RenderGeometryError(`This document's margins (top ${mmText(top)}, bottom ${mmText(bottom)}, left ${mmText(left)}, right ${mmText(right)} mm) leave no room to write on a ${mmText(page.width)} x ${mmText(page.height)} mm page. ${FILE_ADVICE}`);
  }
}

/** A deck's slide shape (width : height) must be one a slide can have. */
export function assertSlideAspect(aspect: number): void {
  const { minAspect, maxAspect } = LIVE_DOCUMENT_RENDER_LIMITS;
  if (!Number.isFinite(aspect) || aspect < minAspect || aspect > maxAspect) {
    throw new RenderGeometryError(`This deck's slides are ${Number.isFinite(aspect) ? `${Number(aspect.toPrecision(3))}:1` : "not a number"} (width to height), which cannot be drawn (between ${1 / maxAspect}:1 and ${maxAspect}:1). Fix the slide size in the file; document.read still shows its text.`);
  }
}

export interface RenderPageHtml {
  label: string;
  html: string;
  width: number;
  height: number;
}

/** A flow document is one tall column the window paginates (render.ts) at `pageHeight`. */
export interface RenderFlowHtml {
  html: string;
  width: number;
  pageHeight: number;
}

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const color = (value: string | undefined): string | undefined => (value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined);

function textCss(format: LiveFormat | undefined): string {
  if (!format) return "";
  return [format.bold !== undefined ? `font-weight:${format.bold ? 700 : 400}` : "", format.italic ? "font-style:italic" : "",
    format.underline ? "text-decoration:underline" : "", color(format.color) ? `color:${format.color}` : "",
    format.align ? `text-align:${format.align}` : "", color(format.fill) ? `background:${format.fill}` : ""].filter(Boolean).join(";");
}

function documentShell(css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;padding:0;background:#ffffff}${css}</style></head><body>${body}</body></html>`;
}

function isDark(hex: string | undefined): boolean {
  const value = color(hex);
  if (!value) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** Picture formats the render window decodes; anything else (EMF, WMF, TIFF) keeps its labelled box. */
export const RENDER_IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };
const imageType = (part: string): string | undefined => RENDER_IMAGE_TYPES[(/\.([a-z0-9]+)$/i.exec(part)?.[1] ?? "").toLowerCase()];
const VANCHOR = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

function tableHtml(shape: LiveShape, pct: string, width: number, height: number, pxPerPt: number): string {
  const rows = shape.rows ?? [];
  const cols = Math.max(...rows.map((row) => row.length));
  const look = shape.look?.table;
  const widths = shape.colWidths?.length === cols ? shape.colWidths : look?.cols.length === cols ? look.cols : undefined;
  // A table without a style draws only what its cells say (pptxgenjs writes every fill and border); a styled one keeps the
  // banded default under the cells' own values.
  const plain = !!look && !look.styled;
  const cell = (text: string, r: number, c: number): string => {
    const own = look?.cells[r]?.[c] ?? null;
    const css: string[] = [];
    if (own?.fill) { const fill = cssColor(own.fill); if (fill) css.push(`background:${fill}`); }
    if (own?.color && color(own.color)) css.push(`color:${own.color}`);
    if (own?.bold !== undefined) css.push(`font-weight:${own.bold ? 700 : 400}`);
    if (own?.size) css.push(`font-size:${(own.size * pxPerPt).toFixed(2)}px`);
    if (own?.align) css.push(`text-align:${own.align}`);
    if (own?.anchor) css.push(`vertical-align:${own.anchor}`);
    if (own?.borders) own.borders.forEach((side, i) => {
      const name = ["left", "right", "top", "bottom"][i];
      css.push(side && color(side.color) ? `border-${name}:${Math.max(1, side.width * pxPerPt).toFixed(2)}px solid ${side.color}` : `border-${name}:none`);
    });
    const tag = !plain && r === 0 ? "th" : "td";
    return `<${tag}${css.length ? ` style="${css.join(";")}"` : ""}>${esc(text)}</${tag}>`;
  };
  return `<table class="tb${plain ? " plain" : ""}" data-box="${esc(shape.id)}" style="${pct.replace(/height:[^;]+/, `max-height:${shape.h * 100}%`)}">`
    + (widths ? `<colgroup>${widths.map((w) => `<col style="width:${w * 100}%">`).join("")}</colgroup>` : "")
    + rows.map((row, r) => `<tr${look?.rows[r] ? ` style="height:${(look.rows[r] * height).toFixed(1)}px"` : ""}>${Array.from({ length: cols }, (_, c) => cell(row[c] ?? "", r, c)).join("")}</tr>`).join("")
    + `</table>`;
}

function slideHtml(slide: LiveSlide, aspect: number): RenderPageHtml & { boxes: string[]; images: string[] } {
  const width = RENDER_SLIDE_WIDTH;
  const height = Math.round(width / aspect);
  const widthPt = aspect >= 1.5 ? 960 : 720;
  const pxPerPt = width / widthPt;
  const boxes: string[] = [];
  const images: string[] = [];
  const pct = (shape: LiveShape) => `left:${shape.x * 100}%;top:${shape.y * 100}%;width:${shape.w * 100}%;height:${shape.h * 100}%`;
  const px = (shape: LiveShape) => ({ left: shape.x * width, top: shape.y * height, width: Math.max(0, shape.w * width), height: Math.max(0, shape.h * height) });
  const turn = (shape: LiveShape) => (shape.look?.rot ? `;transform:rotate(${shape.look.rot}deg)` : "");
  const shapes = slide.shapes.map((shape) => {
    const look = shape.look;
    if (shape.role === "object" && shape.rows) {
      boxes.push(shape.id);
      return tableHtml(shape, pct(shape), width, height, pxPerPt);
    }
    if (shape.role === "object") {
      const fill = color(shape.format?.fill ?? shape.fill);
      if (look?.chart) {
        const box = px(shape);
        return `<div class="ch" data-chart-box="${esc(shape.id)}" style="${pct(shape)}${turn(shape)}">${chartSvg(look.chart, box.width, box.height, pxPerPt)}</div>`;
      }
      if (look?.image) {
        const type = imageType(look.image.part);
        const placeholder = `<div class="o" style="${pct(shape)}"><span>${type ? "image" : `image (${esc((/\.([a-z0-9]+)$/i.exec(look.image.part)?.[1] ?? "?").toUpperCase())}, not drawn)`}</span></div>`;
        if (!type) return placeholder;
        images.push(look.image.part);
        return `${placeholder}<img class="pic" alt="" data-part="${esc(look.image.part)}" style="${pct(shape)}${turn(shape)}${look.flipH ? ";scale:-1 1" : look.flipV ? ";scale:1 -1" : ""}">`;
      }
      if (look && (look.geom || look.line || look.fill)) return shapeSvg(look, px(shape), pxPerPt, fill);
      return `<div class="o" style="${pct(shape)}${fill ? `;background:${fill}` : ""}">${shape.label ? `<span>${esc(shape.label)}</span>` : ""}</div>`;
    }
    const size = shape.format?.size ?? (shape.role === "title" ? 40 : shape.role === "body" ? 24 : 18);
    const background = color(shape.format?.fill ?? shape.fill);
    // A text shape with an outline, a non-rectangular preset or a fill the format cannot carry (gradient, transparency) has its
    // geometry drawn under the text; the text box itself stays the measured box.
    const underlay = !!look && (!!look.geom || !!look.line || (!!look.fill && look.fill !== "none" && (!background || look.fill.alpha !== undefined)));
    const shapeFill = look?.fill && look.fill !== "none" ? look.fill.hex : background;
    const ink = color(shape.format?.color) ?? (isDark(slide.background) || isDark(shapeFill) ? "#ffffff" : "#1b1b1b");
    const weight = shape.format?.bold ?? shape.role === "title" ? 700 : 400;
    const anchor = look?.anchor ? `;justify-content:${VANCHOR[look.anchor]}` : "";
    boxes.push(shape.id);
    return (underlay && look ? shapeSvg(look, px(shape), pxPerPt, background) : "")
      + `<div class="t${shape.role === "body" ? " b" : ""}" data-box="${esc(shape.id)}" style="${pct(shape)};font-size:${((size / widthPt) * width).toFixed(2)}px;font-weight:${weight};color:${ink}${textCss(shape.format) ? `;${textCss(shape.format).replace(/;?background:[^;]+/, "")}` : ""}${background && !underlay ? `;background:${background}` : ""}${anchor}${turn(shape)}">${esc(shape.text)}</div>`;
  }).join("");
  const background = color(slide.background) ?? "#ffffff";
  const css = `.slide{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${background};font-family:"Noto Sans KR","Apple SD Gothic Neo","Pretendard","Malgun Gothic",sans-serif}`
    + `.t{position:absolute;box-sizing:border-box;padding:${(width * 0.006).toFixed(1)}px ${(width * 0.01).toFixed(1)}px;line-height:1.2;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere;overflow:visible;display:flex;flex-direction:column;justify-content:center}`
    + `.b{justify-content:flex-start}`
    + `.o{position:absolute;display:grid;place-items:center;color:rgba(0,0,0,.35);font-size:${(width * 0.014).toFixed(1)}px}.o span{padding:4px 10px;border:1px dashed rgba(0,0,0,.25);border-radius:3px}`
    + `.g{position:absolute;overflow:visible}.ch{position:absolute}.ch svg{display:block;overflow:visible}.pic{position:absolute;object-fit:fill;box-sizing:border-box}.pic:not([src]){display:none}`
    + `.tb{position:absolute;border-collapse:collapse;table-layout:fixed;font-size:${(width * 0.015).toFixed(1)}px;color:#1b1b1b;background:#ffffff}`
    + `.tb th,.tb td{border:1px solid rgba(68,114,196,.45);padding:6px 9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}.tb th{background:#4472c4;color:#ffffff;font-weight:700}.tb tr:nth-child(odd) td{background:rgba(68,114,196,.12)}`
    + `.tb.plain{background:transparent}.tb.plain tr:nth-child(n) td{border:none;background:transparent;font-weight:400}`;
  return { label: "", html: documentShell(css, `<div class="slide">${shapes}</div>`), width, height, boxes, images };
}

/** One page per slide; `images` are the package parts render.ts loads into the page's pictures after it opens. */
export function slidePagesHtml(model: Extract<LiveDocumentModel, { kind: "slides" }>): Array<RenderPageHtml & { slideId: string; boxes: string[]; images: string[] }> {
  const aspect = model.aspect || 16 / 9;
  assertSlideAspect(aspect);
  return model.slides.map((slide, index) => ({ ...slideHtml(slide, aspect), label: `slide ${index + 1}`, slideId: slide.id }));
}

function flowBlockHtml(block: LiveFlowBlock): string {
  if (block.type === "object") return `<div class="blk obj" data-block="${esc(block.id)}">${esc(block.label)}</div>`;
  if (block.type === "table") {
    return `<table class="blk dt" data-block="${esc(block.id)}"${block.colWidths ? ` style="table-layout:fixed"` : ""}>`
      + (block.colWidths ? `<colgroup>${block.colWidths.map((w) => `<col style="width:${w * 100}%">`).join("")}</colgroup>` : "")
      + block.rows.map((row) => `<tr>${row.map((cell) => cell ? `<td${cell.colSpan ? ` colspan="${cell.colSpan}"` : ""}${cell.rowSpan ? ` rowspan="${cell.rowSpan}"` : ""} style="${textCss(cell.format)}">${esc(cell.text)}</td>` : "").join("")}</tr>`).join("")
      + `</table>`;
  }
  const level = block.heading ? Math.min(block.heading, 3) : 0;
  const breakBefore = block.pageBreak === "before" ? ` data-break="before"` : block.pageBreak === "after" ? ` data-break="after"` : "";
  return `<div class="blk p${level ? ` h${level}` : ""}" data-block="${esc(block.id)}"${breakBefore} style="${textCss(block.format)}">${esc(block.text)}</div>`;
}

/** The whole flow document as one column of page width; render.ts moves blocks to the next page and photographs each page. */
export function flowHtml(model: Extract<LiveDocumentModel, { kind: "flow" }>): RenderFlowHtml {
  const page = model.page ?? A4;
  assertFlowPage(page);
  const width = Math.round(page.width * MM);
  const pageHeight = Math.round(page.height * MM);
  const m = page.margin;
  const css = `.doc{box-sizing:border-box;width:${width}px;padding:${m.top * MM}px ${m.right * MM}px ${m.bottom * MM}px ${m.left * MM}px;color:#191919;font-size:${model.defaultSize ?? 10.5}pt;line-height:1.55;font-family:"함초롬바탕","HCR Batang","Noto Serif KR","AppleMyungjo","Apple SD Gothic Neo","Malgun Gothic",serif}`
    + `.p{min-height:1.55em;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere}.h1{font-size:1.6em;font-weight:700;margin:.4em 0}.h2{font-size:1.3em;font-weight:700;margin:.35em 0}.h3{font-size:1.12em;font-weight:700;margin:.3em 0}`
    + `.dt{width:100%;border-collapse:collapse;margin:.4em 0}.dt td{border:1px solid #8c8c8c;padding:3px 6px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}`
    + `.obj{margin:.4em 0;padding:6px 10px;border:1px dashed #9c9c9c;color:#777;font-size:.9em;display:inline-block}`;
  return { html: documentShell(css, `<div class="doc" data-page-top="${Math.round(m.top * MM)}" data-page-bottom="${Math.round(m.bottom * MM)}">${model.blocks.map(flowBlockHtml).join("")}</div>`), width, pageHeight };
}

/** One page per sheet: its used range (first 60 rows x 20 columns) with column letters and row numbers. */
export function sheetPagesHtml(model: Extract<LiveDocumentModel, { kind: "sheet" }>): Array<RenderPageHtml & { truncated: boolean }> {
  return model.sheets.map((sheet) => {
    let rows = 1, cols = 1;
    for (const address of Object.keys(sheet.cells)) { const p = parseCellAddress(address); if (p) { rows = Math.max(rows, p.row); cols = Math.max(cols, p.col); } }
    const shownRows = Math.min(rows, SHEET_MAX_ROWS), shownCols = Math.min(cols, SHEET_MAX_COLS);
    const head = `<tr><th></th>${Array.from({ length: shownCols }, (_, c) => `<th>${cellAddress(c + 1, 1).replace(/\d+$/, "")}</th>`).join("")}</tr>`;
    const body = Array.from({ length: shownRows }, (_, r) => `<tr><th>${r + 1}</th>${Array.from({ length: shownCols }, (_, c) => {
      const cell = sheet.cells[cellAddress(c + 1, r + 1)];
      const numeric = cell && /^[-+]?[\d,.]+%?$/.test(cell.v.replace(/[원$€£¥\s]/g, ""));
      return `<td style="${numeric ? "text-align:right;" : ""}${textCss(cell?.format)}">${esc(cell?.v ?? "")}</td>`;
    }).join("")}</tr>`).join("");
    const charts = (sheet.charts ?? []).map((chart) => `<div class="ch">chart ${esc(chart.type)}${chart.title ? ` "${esc(chart.title)}"` : ""}: ${esc(chart.values.join(", "))} by ${esc(chart.categories)}</div>`).join("");
    const css = `table{border-collapse:collapse;font-family:"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-size:13px;color:#1b1b1b}th,td{border:1px solid #d0d0d0;padding:3px 7px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}th{background:#f2f2f2;color:#555;font-weight:500}`
      + `.wrap{display:inline-block;padding:12px}.ch{margin-top:10px;padding:6px 10px;border:1px dashed #9c9c9c;color:#555;font:12px sans-serif}`;
    return { label: `sheet ${sheet.name}`, html: documentShell(css, `<div class="wrap"><table>${head}${body}</table>${charts}</div>`), width: 0, height: 0, truncated: rows > SHEET_MAX_ROWS || cols > SHEET_MAX_COLS };
  });
}
