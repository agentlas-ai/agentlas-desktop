import { list, num, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { FAINT, H, INK, INK2, KINDS, badgeOf, circle, clipDef, fileFields, fit, hash, optList, plural, r1, rect, shadow, shadowDefs, skeleton, tile, tileCss, txt, wholeNum, wrap } from "./_shared";

/** The document-like files: a page of a PDF, a Word page, a spreadsheet grid and a presentation slide, each drawn from what the block supplies. */

// ---- pdf_file ---------------------------------------------------------------------------------------------------------------------------
export const pdfFile = defineAsset({
  type: "pdf_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A PDF file as a preview tile: the first page with its title and opening lines, the page count and size.",
  useKo: "PDF 파일을 미리보기 타일로 보여줍니다: 첫 페이지의 제목과 첫 줄들, 페이지 수와 크기.",
  tags: ["pdf", "file", "thumbnail", "document", "report", "preview", "파일", "문서", "썸네일", "미리보기"],
  notes: "heading is the page title (at most two lines); lines are short rows of the first page (about 40 characters each, up to 8). Leave both out for a blank page.",
  fields: { ...fileFields, pages: wholeNum, heading: optionalText(70), lines: optList(text(90), 0, 8) },
  sample: { name: "Q3-2026-financial-report.pdf", pages: 14, size: "2.4 MB", modified: "Oct 28", heading: "Q3 2026 Financial Report", lines: ["Revenue reached $48.2M, up 18% year over", "year, led by enterprise renewals and the", "new usage-based tier. Operating margin", "improved to 21% as hosting costs fell 6%.", "Cash and equivalents closed the quarter at", "$112M with no debt outstanding."] },
  render(b, { uid, ko, T }) {
    const px = 84, pw = 220, ix = px + 18, iw = pw - 36, multi = (b.pages ?? 1) > 1;
    let s = `<defs>${shadowDefs(uid)}</defs>`, y = 40;
    if (multi) s += rect(px + 12, 5, pw, 330, "#eceeec", { rx: 3, stroke: "#dde2df" });
    s += rect(px, 12, pw, 330, "#fff", { rx: 3, filter: shadow(uid) });
    s += `<path d="M${px + pw - 30} 12V38l8-6 8 6V12Z" fill="${KINDS.pdf.color}"/>`;
    if (b.heading) { for (const l of wrap(b.heading, 13.5, iw - 20, 2, true)) { s += txt(ix, y, l, 13.5, { w: 800 }); y += 17; } }
    else { s += rect(ix, y - 9, iw * 0.55, 9, "#cfd6d2", { rx: 4.5 }); y += 12; }
    s += rect(ix, y - 6, 26, 2.8, KINDS.pdf.color, { rx: 1.4 }); y += 15;
    if (b.lines?.length) for (const l of b.lines) { s += txt(ix, y, fit(l, 8.6, iw), 8.6, { fill: INK2, w: 500 }); y += 12.8; }
    else s += skeleton(ix, y - 6, iw, 8, 12.8, hash(b.name));
    return tile({ label: "PDF", name: b.name, meta: [b.pages ? plural(b.pages, "page", "pages", "쪽", ko) : undefined, b.size, b.modified && `${T("Edited", "수정")} ${b.modified}`], svg: s });
  },
  summary: b => `PDF ${b.name}${b.pages ? `, ${b.pages} pages` : ""}${b.size ? `, ${b.size}` : ""}${b.modified ? `, modified ${b.modified}` : ""}${b.heading ? `. First page: ${b.heading}` : ""}.`,
  css: tileCss("pdf_file", KINDS.pdf.color),
});

// ---- word_file --------------------------------------------------------------------------------------------------------------------------
export const wordFile = defineAsset({
  type: "word_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A Word or text document as a preview tile: a page with its heading and the first paragraphs.",
  useKo: "워드·텍스트 문서를 미리보기 타일로 보여줍니다: 제목과 첫 문단이 있는 페이지.",
  tags: ["word", "docx", "document", "doc", "memo", "letter", "워드", "문서", "문서 파일", "썸네일"],
  notes: "paragraphs are the first one to four paragraphs (each wraps to three lines and is cut after that). words is the document length.",
  fields: { ...fileFields, pages: wholeNum, words: wholeNum, heading: optionalText(70), paragraphs: optList(text(260), 0, 4) },
  sample: { name: "Partnership-proposal.docx", pages: 6, words: 2140, size: "184 KB", modified: "Yesterday", heading: "Partnership Proposal: Northwind × Atlas", paragraphs: ["Northwind and Atlas Labs propose a twelve-month co-marketing and integration partnership beginning in January 2027.", "The programme pairs a joint launch and shared webinars with a revenue-share on referred accounts.", "We ask for a decision by November 20 so that engineering can reserve capacity for the integration work."] },
  render(b, { uid, ko }) {
    const px = 76, pw = 248, ix = px + 22, iw = pw - 44;
    let ticks = ""; for (let x = ix, i = 0; x <= ix + iw; x += 6.2, i++) ticks += `M${r1(x)} 13V${i % 8 === 0 ? 7 : i % 4 === 0 ? 9 : 11}`;
    let s = `<defs>${shadowDefs(uid)}</defs>${rect(0, 0, 400, 14, "#e5ebf8")}<path d="${ticks}" stroke="#9db0de" stroke-width=".7" fill="none"/>`;
    s += rect(px, 22, pw, 330, "#fff", { rx: 2, filter: shadow(uid) });
    let y = 50;
    if (b.heading) for (const l of wrap(b.heading, 14, iw, 2, true)) { s += txt(ix, y, l, 14, { fill: "#1d3f9c", w: 800 }); y += 17.5; } else { s += rect(ix, y - 9, iw * 0.5, 9, "#c9d6f3", { rx: 4.5 }); y += 12; }
    s += rect(ix, y - 5, iw, 1.1, "#c6d3f1"); y += 12;
    if (b.paragraphs?.length) for (const p of b.paragraphs) { for (const l of wrap(p, 8.3, iw, 3)) { s += txt(ix, y, l, 8.3, { fill: INK2, w: 500 }); y += 11.8; } y += 6.5; }
    else for (let i = 0; i < 3; i++) { s += skeleton(ix, y - 5, iw, 3, 11.8, hash(b.name) + i); y += 3 * 11.8 + 6.5; }
    return tile({ label: badgeOf(b.name, "word"), name: b.name, meta: [b.pages ? plural(b.pages, "page", "pages", "쪽", ko) : undefined, b.words ? plural(b.words, "word", "words", "단어", ko) : undefined, b.size, b.modified], svg: s });
  },
  summary: b => `Word document ${b.name}${b.pages ? `, ${b.pages} pages` : ""}${b.words ? `, ${b.words} words` : ""}${b.modified ? `, modified ${b.modified}` : ""}${b.heading ? `. ${b.heading}` : ""}.`,
  css: tileCss("word_file", KINDS.word.color),
});

// ---- sheet_file -------------------------------------------------------------------------------------------------------------------------
const NUMERIC = /^[−+-]?[$€£¥₩]?\d[\d,.]*\s?(?:%|[KMBkmb]|x)?$/;
export const sheetFile = defineAsset({
  type: "sheet_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A spreadsheet as a preview tile: a mini grid with its header row and the first rows of figures.",
  useKo: "스프레드시트를 미리보기 타일로 보여줍니다: 머리글 행과 첫 몇 행의 숫자가 있는 작은 표.",
  tags: ["sheet", "xlsx", "excel", "spreadsheet", "csv", "table", "엑셀", "스프레드시트", "시트", "썸네일"],
  notes: "columns are 1-6 header cells; rows are up to 8 rows of cells (numbers are right-aligned, a leading minus turns red). total is the row count of the whole sheet.",
  fields: { ...fileFields, sheets: wholeNum, total: wholeNum, columns: list(text(16), 1, 6), rows: list(list(text(16), 1, 6), 1, 8) },
  sample: { name: "Sales-forecast-2027.xlsx", sheets: 4, total: 1240, size: "86 KB", modified: "Oct 30", columns: ["Region", "Q1", "Q2", "Q3", "YoY"], rows: [["North", "1,240", "1,310", "1,425", "+12%"], ["South", "980", "1,020", "1,105", "+8%"], ["East", "1,515", "1,490", "1,602", "+5%"], ["West", "870", "905", "842", "−3%"], ["Online", "2,310", "2,780", "3,150", "+31%"], ["Total", "6,915", "7,505", "8,124", "+14%"]] },
  render(b, { uid, ko }) {
    const gx = 22, gw = 356, gutter = 20, n = b.columns.length, cw = (gw - gutter) / n, rh = 17.5, top = 14, hdr = 15, green = KINDS.sheet.color;
    let s = `<defs>${clipDef(`${uid}-g`, gx, top, gw, 300, 8)}</defs>${rect(gx, top, gw, 300, "#fff", { rx: 8, stroke: "#d9dfdb" })}<g clip-path="url(#${uid}-g)">`;
    s += rect(gx, top, gw, hdr, "#eef2ef") + rect(gx, top, gutter, 300, "#eef2ef");
    for (let c = 0; c < n; c++) s += txt(gx + gutter + c * cw + cw / 2, top + 10.8, String.fromCharCode(65 + c), 7.6, { fill: FAINT, w: 700, anchor: "middle" });
    const rows = [b.columns, ...b.rows];
    rows.forEach((row, ri) => {
      const y = top + hdr + ri * rh;
      if (ri === 0) s += rect(gx + gutter, y, gw - gutter, rh, "#e2f3ea");
      s += rect(gx + gutter, y + rh - 0.5, gw - gutter, 0.7, "#e4e8e5") + txt(gx + gutter / 2, y + 12, String(ri + 1), 7.2, { fill: FAINT, w: 600, anchor: "middle" });
      for (let c = 0; c < n; c++) {
        const cell = row[c]; if (cell === undefined) continue;
        const isNum = ri > 0 && NUMERIC.test(cell), neg = isNum && /^[−-]/.test(cell), x0 = gx + gutter + c * cw;
        s += txt(isNum ? x0 + cw - 7 : x0 + 7, y + 12, fit(cell, 8.8, cw - 14, ri === 0), 8.8, { fill: ri === 0 ? "#0b5d3f" : neg ? "#cf3545" : INK, w: ri === 0 ? 800 : 600, anchor: isNum ? "end" : "start" });
        if (c > 0) s += rect(x0, y, 0.7, rh, "#e4e8e5");
      }
    });
    for (let ri = rows.length, y = top + hdr + ri * rh; y < H + rh; ri++, y += rh) {
      s += rect(gx + gutter, y + rh - 0.5, gw - gutter, 0.7, "#eceeec") + txt(gx + gutter / 2, y + 12, String(ri + 1), 7.2, { fill: "#c3c9c6", w: 600, anchor: "middle" });
      for (let c = 1; c < n; c++) s += rect(gx + gutter + c * cw, y, 0.7, rh, "#eceeec");
    }
    if (rows.length > 3 && n > 1) s += rect(gx + gutter + cw, top + hdr + 3 * rh, cw, rh, "none", { stroke: green, sw: 1.8 }) + rect(gx + gutter + 2 * cw - 2.5, top + hdr + 4 * rh - 2.5, 5, 5, green, { stroke: "#fff", sw: 1 });
    return tile({ label: badgeOf(b.name, "sheet"), name: b.name, meta: [b.total ? plural(b.total, "row", "rows", "행", ko) : undefined, b.sheets ? plural(b.sheets, "sheet", "sheets", "시트", ko) : undefined, b.size, b.modified], svg: `${s}</g>` });
  },
  summary: b => `Spreadsheet ${b.name}${b.sheets ? `, ${b.sheets} sheets` : ""}${b.total ? `, ${b.total} rows` : ""}${b.size ? `, ${b.size}` : ""}. Columns: ${b.columns.join(", ")}.`,
  css: tileCss("sheet_file", KINDS.sheet.color),
});

// ---- slides_file ------------------------------------------------------------------------------------------------------------------------
export const slidesFile = defineAsset({
  type: "slides_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A presentation as a preview tile: its current slide (title with bullets or a small bar chart) beside a strip of slide miniatures.",
  useKo: "프레젠테이션을 미리보기 타일로 보여줍니다: 제목과 글머리표 또는 작은 막대 그래프가 있는 슬라이드 한 장과 슬라이드 목록.",
  tags: ["slides", "pptx", "powerpoint", "deck", "presentation", "keynote", "슬라이드", "발표", "프레젠테이션", "썸네일"],
  notes: "heading is the slide title (two lines); bullets up to 4; bars 2-6 numbers for a small chart (beside the bullets when both are given); slides is the deck length.",
  fields: { ...fileFields, slides: wholeNum, heading: text(80), bullets: optList(text(60), 0, 4), bars: optList(num, 2, 6) },
  sample: { name: "Q3-growth-review.pptx", slides: 24, size: "8.6 MB", modified: "Oct 29", heading: "Where the new users came from", bullets: ["Organic search: 41%", "Referrals doubled", "Paid flat at 12%"], bars: [12, 18, 24, 31, 44] },
  render(b, { uid, ko }) {
    const ox = 78, oy = 10, sw = 312, sh = 175.5, ix = ox + 22, iw = sw - 44, orange = KINDS.slides.color, total = b.slides ?? 3, minis = Math.min(3, Math.max(1, total));
    let s = `<defs>${shadowDefs(uid)}</defs>`;
    for (let i = 0; i < minis; i++) {
      const y = 12 + i * 39, on = i === 0;
      s += rect(12, y, 52, 29.3, "#fff", { rx: 2.5, stroke: on ? orange : "#d9dfdb", sw: on ? 1.8 : 1 }) + rect(18, y + 6, 20, 2.6, i === 0 ? orange : "#c9d0cc", { rx: 1.3 }) + rect(18, y + 12, 34 - i * 4, 1.8, "#d8dedb", { rx: 0.9 }) + rect(18, y + 17, 26 + i * 4, 1.8, "#d8dedb", { rx: 0.9 });
      if (i === 2) s += rect(42, y + 15, 3, 8, orange, { opacity: 0.5 }) + rect(47, y + 12, 3, 11, orange, { opacity: 0.8 }) + rect(52, y + 18, 3, 5, orange, { opacity: 0.5 });
    }
    s += rect(ox, oy, sw, sh, "#fff", { rx: 6, filter: shadow(uid) }) + rect(ox, oy + 6, 5, 18, orange, { rx: 0 }) + rect(ix, oy + 24, 24, 3.4, orange, { rx: 1.7 });
    let y = oy + 49; for (const l of wrap(b.heading, 17, iw, 2, true)) { s += txt(ix, y, l, 17, { w: 800 }); y += 21; }
    const top = y - 2, bottom = oy + sh - 18, hasBars = !!b.bars && b.bars.length >= 2, bullets = b.bullets ?? [], bx0 = bullets.length ? ix + 150 : ix, bw = ix + iw - bx0;
    let by = top + 14;
    for (const t of bullets) {
      const ls = wrap(t, 10.2, hasBars ? bx0 - ix - 22 : iw - 14, hasBars ? 2 : 1); if (by > bottom) break;
      s += circle(ix + 3, by - 3.4, 2.4, orange); ls.forEach((l, k) => { s += txt(ix + 12, by + k * 12.5, l, 10.2, { fill: INK2, w: 560 }); }); by += (ls.length - 1) * 12.5 + 17;
    }
    if (hasBars) {
      const vals = b.bars!, max = Math.max(...vals, 1), bh = Math.min(64, bottom - top - 2), slot = bw / vals.length;
      s += rect(bx0, bottom - 0.5, bw, 1, "#d9dfdb");
      vals.forEach((v, i) => { const h = Math.max(3, (Math.max(0, v) / max) * bh), last = i === vals.length - 1; s += rect(bx0 + i * slot + slot * 0.18, bottom - h, slot * 0.64, h, last ? orange : "#f6c79d", { rx: 2 }); });
    }
    s += txt(ox + sw - 12, oy + sh - 8, `1 / ${total}`, 7.6, { fill: FAINT, w: 700, anchor: "end" });
    return tile({ label: badgeOf(b.name, "slides"), name: b.name, meta: [b.slides ? plural(b.slides, "slide", "slides", "슬라이드", ko) : undefined, b.size, b.modified], svg: s });
  },
  summary: b => `Presentation ${b.name}${b.slides ? `, ${b.slides} slides` : ""}${b.size ? `, ${b.size}` : ""}. Current slide: ${b.heading}${b.bullets?.length ? ` (${b.bullets.join("; ")})` : ""}.`,
  css: tileCss("slides_file", KINDS.slides.color),
});

export const ASSETS: readonly AnyAsset[] = [pdfFile, wordFile, sheetFile, slidesFile];
