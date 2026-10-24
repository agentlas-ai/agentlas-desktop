import { relsPathFor, resolvePartPath, ZipPackage } from "./zip";
import { attr, descendants, elements, firstElement, localName, parseXml, textContent, type XmlElement } from "./xml-lite";

/*
 * Deterministic lint for a finished .pptx (document.deck.lint, live-document/deck-ports.ts), whoever made it: a pptxgenjs script
 * (document.deck.build), python-pptx, PowerPoint. It reads the slide XML only, so it needs no renderer and no font files.
 *
 * What it can and cannot tell: it finds a deck that is broken (text running out of its box or off the slide, unreadable colours,
 * boxes written over each other, type too small to read) and a deck that is plain (slides that hold only text on white). It
 * cannot tell a good design from a mediocre one; the render pass (document.render) is where that is looked at.
 *
 * Text size is estimated with fixed advance-width classes (Hangul and CJK 1.0 em, Latin 0.56 em, digits 0.58 em, space 0.28 em,
 * bold +4%) and 1.25 line height, rounded up on purpose: a finding says "does not fit with room to spare", and the fix is
 * always a shorter text, a bigger box or a smaller type size, never a guess about one font. Findings carry the numbers.
 *
 * No electron import: the daemon loads the harness ports.
 */

export interface DeckFinding {
  code: "text_overflow" | "text_overlap" | "outside_slide" | "font_too_small" | "low_contrast" | "margin_tight" | "plain_slide" | "too_many_words" | "font_face" | "layout_repeat";
  severity: "error" | "warn";
  slide: number;
  shape?: string;
  detail: string;
  fix: string;
}

export interface DeckLintReport {
  ok: boolean;
  slides: number;
  errors: number;
  warnings: number;
  /** Slides that hold at least one non-text visual: a picture, chart, table, a filled or outlined shape, or a text box with a fill. */
  visualSlides: number;
  findings: DeckFinding[];
  /** The numbers the rules use, so a finding can be argued with. */
  limits: { minFontError: number; minFontWarn: number; contrastNormal: number; contrastLarge: number; maxWords: number; marginInches: number };
}

export const DECK_LINT_LIMITS = { minFontError: 10, minFontWarn: 12, contrastNormal: 4.5, contrastLarge: 3, maxWords: 90, marginInches: 0.25 } as const;
const SAFE_FONTS = new Set(["malgun gothic", "맑은 고딕", "apple sd gothic neo", "noto sans kr", "pretendard", "arial", "calibri", "cambria", "times new roman", "courier new", "segoe ui", "helvetica", "helvetica neue", "georgia", "+mn-lt", "+mj-lt", "+mn-ea", "+mj-ea"]);
const MAX_FINDINGS = 60;
/** Wrap decisions give the text 6% of room: a finding must hold even if the real font is a little narrower than the estimate. */
const WRAP_SLACK = 1.06;
const EMU_PT = 12700;
const EMU_IN = 914400;

interface Box { x: number; y: number; w: number; h: number }
interface Run { text: string; size?: number; bold: boolean; color?: string; font?: string }
interface Para { runs: Run[]; align: "l" | "ctr" | "r" | "just"; lineSpacing: number; before: number; after: number; indent: number }
interface Item {
  kind: "text" | "shape" | "pic" | "chart" | "table" | "line";
  name: string;
  box: Box;
  fill?: string;
  fillAlpha: number;
  gradient: boolean;
  outlined: boolean;
  paras: Para[];
  insets: { l: number; t: number; r: number; b: number };
  wrap: boolean;
  anchor: "t" | "ctr" | "b";
  /** spAutoFit: the box follows the text, so its stored size is not a limit; normAutofit: PowerPoint shrinks the type when the text is edited. */
  autofit: "none" | "shape" | "shrink";
  styleColor?: string;
}

// ── colours ──────────────────────────────────────────────────────────────────────────────────────────────────────

const A = (element: XmlElement | undefined, name: string): string | undefined => (element ? attr(element, name) : undefined);
const hex6 = (value: string | undefined): string | undefined => (value && /^[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined);

function readTheme(pkg: ZipPackage, masterPart: string | undefined): Map<string, string> {
  const colors = new Map<string, string>();
  const rels = masterPart ? relsOf(pkg, masterPart) : [];
  const themePart = rels.find((rel) => rel.type.endsWith("/theme"))?.target;
  const xml = themePart ? pkg.text(themePart) : undefined;
  if (!xml) return colors;
  const scheme = descendants(parseXml(xml).root, "a:clrScheme")[0];
  for (const entry of scheme ? elements(scheme) : []) {
    const value = elements(entry)[0];
    const color = value ? hex6(attr(value, "val")) ?? hex6(attr(value, "lastClr")) : undefined;
    if (color) colors.set(localName(entry), color);
  }
  colors.set("tx1", colors.get("dk1") ?? "000000"); colors.set("bg1", colors.get("lt1") ?? "FFFFFF");
  colors.set("tx2", colors.get("dk2") ?? "1F1F1F"); colors.set("bg2", colors.get("lt2") ?? "EEEEEE");
  return colors;
}

function relsOf(pkg: ZipPackage, part: string): Array<{ id: string; type: string; target: string }> {
  const xml = pkg.text(relsPathFor(part));
  if (!xml) return [];
  return elements(parseXml(xml).root).map((rel) => ({ id: attr(rel, "Id") ?? "", type: attr(rel, "Type") ?? "", target: resolvePartPath(part, attr(rel, "Target") ?? "") }));
}

function colorOf(container: XmlElement | undefined, theme: Map<string, string>): { color?: string; alpha: number; gradient: boolean; none: boolean } {
  if (!container) return { alpha: 1, gradient: false, none: false };
  const solid = elements(container).find((el) => localName(el) === "solidFill");
  if (solid) {
    const value = elements(solid)[0];
    const alphaNode = value ? elements(value).find((el) => localName(el) === "alpha") : undefined;
    const alpha = alphaNode ? Math.max(0, Math.min(1, Number(attr(alphaNode, "val")) / 100000)) : 1;
    if (!value) return { alpha, gradient: false, none: false };
    const name = localName(value);
    const raw = attr(value, "val") ?? "";
    const color = name === "srgbClr" ? hex6(raw) : name === "schemeClr" ? theme.get(raw) : name === "sysClr" ? hex6(attr(value, "lastClr")) : undefined;
    return { ...(color ? { color } : {}), alpha, gradient: false, none: false };
  }
  if (elements(container).some((el) => localName(el) === "gradFill")) return { alpha: 1, gradient: true, none: false };
  if (elements(container).some((el) => localName(el) === "noFill")) return { alpha: 1, gradient: false, none: true };
  return { alpha: 1, gradient: false, none: false };
}

const luminance = (hex: string): number => {
  const channel = (i: number) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const blend = (fg: string, bg: string, alpha: number): string => {
  const mix = (i: number) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0");
  return `${mix(0)}${mix(2)}${mix(4)}`.toUpperCase();
};

// ── text size ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Advance of one character in em, rounded up (see the header). */
function advance(ch: string, bold: boolean): number {
  const code = ch.codePointAt(0) ?? 0;
  let width: number;
  if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f) || (code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x2190 && code <= 0x2bff)) width = 1;
  else if (ch === " " || ch === " ") width = 0.28;
  else if (code >= 0x30 && code <= 0x39) width = 0.58;
  else if (code >= 0x41 && code <= 0x5a) width = 0.68;
  else if (code >= 0x61 && code <= 0x7a) width = 0.56;
  else if (/[.,:;'`!|il]/.test(ch)) width = 0.34;
  else width = 0.48;
  return bold ? width * 1.04 : width;
}

interface Measured { lines: number; height: number; maxLine: number }

/** Word-wrapped size of the paragraphs inside a text area `widthPt` wide, in points. */
function measure(paras: Para[], widthPt: number, wrap: boolean): Measured {
  let height = 0, lines = 0, maxLine = 0;
  paras.forEach((para, index) => {
    const size = Math.max(...para.runs.map((r) => r.size ?? 18), 1);
    const room = Math.max(8, widthPt - para.indent);
    const atoms: Array<{ width: number; space: boolean; hard: boolean }> = [];
    for (const run of para.runs) {
      const unit = (run.size ?? 18);
      for (const part of run.text.split(/(\n)/)) {
        if (part === "\n") { atoms.push({ width: 0, space: false, hard: true }); continue; }
        let word = 0;
        for (const ch of part) {
          const w = advance(ch, run.bold) * unit;
          if (ch === " ") { if (word) atoms.push({ width: word, space: false, hard: false }); word = 0; atoms.push({ width: w, space: true, hard: false }); }
          else word += w;
        }
        if (word) atoms.push({ width: word, space: false, hard: false });
      }
    }
    let line = 0, paraLines = 1, longest = 0;
    for (const atom of atoms) {
      if (atom.hard) { longest = Math.max(longest, line); line = 0; paraLines += 1; continue; }
      if (wrap && !atom.space && line + atom.width > room * WRAP_SLACK && line > 0) { longest = Math.max(longest, line); line = 0; paraLines += 1; }
      if (wrap && atom.width > room * WRAP_SLACK) { // a single word longer than the line breaks by characters
        const extra = Math.floor(atom.width / room); paraLines += extra; line = atom.width - extra * room;
      } else line += atom.width;
    }
    longest = Math.max(longest, line);
    const lineHeight = size * 1.25 * para.lineSpacing;
    height += paraLines * lineHeight + (index > 0 ? para.before : 0) + para.after;
    lines += paraLines; maxLine = Math.max(maxLine, longest);
  });
  return { lines, height, maxLine };
}

// ── reading a slide ──────────────────────────────────────────────────────────────────────────────────────────────

function xfrmBox(spPr: XmlElement | undefined): Box | null {
  const xfrm = spPr ? elements(spPr).find((el) => localName(el) === "xfrm") : undefined;
  const off = xfrm ? firstElement(xfrm, "a:off") : undefined;
  const ext = xfrm ? firstElement(xfrm, "a:ext") : undefined;
  if (!off || !ext) return null;
  return { x: Number(attr(off, "x") ?? 0), y: Number(attr(off, "y") ?? 0), w: Number(attr(ext, "cx") ?? 0), h: Number(attr(ext, "cy") ?? 0) };
}

interface RunDefaults { size?: number; bold?: boolean; color?: string; font?: string }

/** Character properties a run falls back to: the paragraph's own defRPr (PowerPoint honours it), then the text body's list style. */
function defaultsOf(node: XmlElement | undefined, theme: Map<string, string>): RunDefaults {
  if (!node) return {};
  const sz = Number(attr(node, "sz"));
  const latin = firstElement(node, "a:latin");
  const color = colorOf(node, theme).color;
  return { ...(Number.isFinite(sz) && sz > 0 ? { size: sz / 100 } : {}), ...(attr(node, "b") !== undefined ? { bold: attr(node, "b") === "1" } : {}), ...(color ? { color } : {}), ...(latin && attr(latin, "typeface") ? { font: attr(latin, "typeface") as string } : {}) };
}

function readParas(txBody: XmlElement | undefined, theme: Map<string, string>): Para[] {
  if (!txBody) return [];
  const listStyle = firstElement(txBody, "a:lstStyle");
  const listDefaults = defaultsOf(listStyle ? firstElement(firstElement(listStyle, "a:lvl1pPr") ?? listStyle, "a:defRPr") : undefined, theme);
  return elements(txBody).filter((el) => localName(el) === "p").map((p) => {
    const pPr = firstElement(p, "a:pPr");
    const base: RunDefaults = { ...listDefaults, ...defaultsOf(pPr ? firstElement(pPr, "a:defRPr") : undefined, theme) };
    const spacing = (name: string) => { const node = pPr ? firstElement(pPr, name) : undefined; const pts = node ? firstElement(node, "a:spcPts") : undefined; return pts ? Number(attr(pts, "val")) / 100 : 0; };
    const lnPct = pPr ? firstElement(pPr, "a:lnSpc") : undefined;
    const pct = lnPct ? firstElement(lnPct, "a:spcPct") : undefined;
    const bulleted = pPr ? elements(pPr).some((el) => ["buChar", "buAutoNum"].includes(localName(el))) : false;
    const marL = pPr ? Number(attr(pPr, "marL") ?? 0) : 0;
    const runs: Run[] = [];
    for (const child of elements(p)) {
      const name = localName(child);
      if (name === "br") { runs.push({ text: "\n", bold: false }); continue; }
      if (name !== "r" && name !== "fld") continue;
      const rPr = firstElement(child, "a:rPr");
      const sz = rPr ? Number(attr(rPr, "sz")) : Number.NaN;
      const fill = rPr ? colorOf(rPr, theme) : undefined;
      const latin = rPr ? firstElement(rPr, "a:latin") : undefined;
      const t = firstElement(child, "a:t");
      const size = Number.isFinite(sz) && sz > 0 ? sz / 100 : base.size;
      const color = fill?.color ?? base.color;
      const font = latin && attr(latin, "typeface") ? (attr(latin, "typeface") as string) : base.font;
      runs.push({ text: t ? textContent(t) : "", bold: rPr && attr(rPr, "b") !== undefined ? attr(rPr, "b") === "1" : base.bold === true, ...(size !== undefined ? { size } : {}), ...(color ? { color } : {}), ...(font ? { font } : {}) });
    }
    const align = (A(pPr, "algn") ?? "l") as Para["align"];
    return { runs, align, lineSpacing: pct ? Number(attr(pct, "val")) / 100000 : 1, before: spacing("a:spcBef"), after: spacing("a:spcAft"), indent: ((bulleted ? Math.max(marL, 285750) : marL) / EMU_PT) };
  });
}

interface SlideRead { items: Item[]; background: string; words: number; fonts: Set<string> }

function readSlide(pkg: ZipPackage, part: string, doc: XmlElement, theme: Map<string, string>, slideBg: string): SlideRead {
  const items: Item[] = [];
  const fonts = new Set<string>();
  let words = 0;
  const tree = descendants(doc, "p:spTree")[0];
  const background = (() => {
    const bgPr = descendants(doc, "p:bgPr")[0];
    const fill = bgPr ? colorOf(bgPr, theme) : undefined;
    return fill?.color ?? slideBg;
  })();
  const layoutBoxFor = (ph: XmlElement): Box | null => {
    const layout = relsOf(pkg, part).find((rel) => rel.type.endsWith("/slideLayout"))?.target;
    const master = layout ? relsOf(pkg, layout).find((rel) => rel.type.endsWith("/slideMaster"))?.target : undefined;
    for (const owner of [layout, master]) {
      const xml = owner ? pkg.text(owner) : undefined;
      if (!xml) continue;
      for (const sp of descendants(parseXml(xml).root, "p:sp")) {
        const other = descendants(sp, "p:ph")[0];
        if (!other) continue;
        if ((attr(ph, "idx") && attr(other, "idx") === attr(ph, "idx")) || (!attr(ph, "idx") && (attr(other, "type") ?? "body") === (attr(ph, "type") ?? "body"))) {
          const box = xfrmBox(firstElement(sp, "p:spPr"));
          if (box) return box;
        }
      }
    }
    return null;
  };
  const walk = (container: XmlElement, map: (box: Box) => Box) => {
    for (const child of elements(container)) {
      const name = localName(child);
      if (name === "grpSp") {
        const xfrm = firstElement(firstElement(child, "p:grpSpPr") ?? child, "a:xfrm");
        const off = xfrm && firstElement(xfrm, "a:off"), ext = xfrm && firstElement(xfrm, "a:ext"), chOff = xfrm && firstElement(xfrm, "a:chOff"), chExt = xfrm && firstElement(xfrm, "a:chExt");
        if (off && ext && chOff && chExt) {
          const ox = Number(attr(off, "x")), oy = Number(attr(off, "y")), ew = Number(attr(ext, "cx")), eh = Number(attr(ext, "cy"));
          const cx = Number(attr(chOff, "x")), cy = Number(attr(chOff, "y")), cw = Number(attr(chExt, "cx")) || 1, ch = Number(attr(chExt, "cy")) || 1;
          walk(child, (box) => map({ x: ox + (box.x - cx) * ew / cw, y: oy + (box.y - cy) * eh / ch, w: box.w * ew / cw, h: box.h * eh / ch }));
        } else walk(child, map);
        continue;
      }
      if (!["sp", "pic", "graphicFrame", "cxnSp"].includes(name)) continue;
      const nv = elements(child).find((el) => localName(el).startsWith("nv"));
      const cNvPr = nv ? firstElement(nv, "p:cNvPr") : undefined;
      const label = A(cNvPr, "name") ?? `${name}`;
      const spPr = name === "graphicFrame" ? undefined : firstElement(child, "p:spPr");
      const ph = name === "sp" ? descendants(child, "p:ph")[0] : undefined;
      const frame = name === "graphicFrame" ? (() => { const x = firstElement(child, "p:xfrm"); const off = x && firstElement(x, "a:off"), ext = x && firstElement(x, "a:ext"); return off && ext ? { x: Number(attr(off, "x")), y: Number(attr(off, "y")), w: Number(attr(ext, "cx")), h: Number(attr(ext, "cy")) } : null; })() : null;
      const raw = name === "graphicFrame" ? null : (xfrmBox(spPr) ?? (ph ? layoutBoxFor(ph) : null));
      const box0 = frame ?? raw;
      if (!box0) continue;
      const box = map(box0);
      if (name === "pic") { items.push({ kind: "pic", name: label, box, fillAlpha: 1, gradient: false, outlined: false, paras: [], insets: { l: 0, t: 0, r: 0, b: 0 }, wrap: true, anchor: "t", autofit: "none" }); continue; }
      if (name === "graphicFrame") {
        const kind = descendants(child, "a:tbl").length ? "table" : "chart";
        items.push({ kind, name: label, box, fillAlpha: 1, gradient: false, outlined: false, paras: [], insets: { l: 0, t: 0, r: 0, b: 0 }, wrap: true, anchor: "t", autofit: "none" });
        continue;
      }
      if (name === "cxnSp") { items.push({ kind: "line", name: label, box, fillAlpha: 1, gradient: false, outlined: true, paras: [], insets: { l: 0, t: 0, r: 0, b: 0 }, wrap: true, anchor: "t", autofit: "none" }); continue; }
      const fill = colorOf(spPr, theme);
      const ln = spPr ? firstElement(spPr, "a:ln") : undefined;
      const outlined = !!ln && !elements(ln).some((el) => localName(el) === "noFill") && (elements(ln).some((el) => localName(el) === "solidFill") || attr(ln, "w") !== undefined);
      const txBody = firstElement(child, "p:txBody");
      const paras = readParas(txBody, theme).filter((p) => p.runs.some((r) => r.text.trim()));
      const bodyPr = txBody ? firstElement(txBody, "a:bodyPr") : undefined;
      const inset = (key: string, fallback: number) => (bodyPr && attr(bodyPr, key) !== undefined ? Number(attr(bodyPr, key)) : fallback) / EMU_PT;
      for (const para of paras) for (const run of para.runs) { if (run.font) fonts.add(run.font); words += run.text.split(/\s+/).filter(Boolean).length; }
      const fontRef = (() => { const style = firstElement(child, "p:style"); const ref = style ? firstElement(style, "a:fontRef") : undefined; const scheme = ref ? elements(ref).find((el) => localName(el) === "schemeClr") : undefined; return scheme ? theme.get(attr(scheme, "val") ?? "") : undefined; })();
      const styleColor = fontRef;
      const hasText = paras.length > 0;
      items.push({
        kind: hasText ? "text" : "shape", name: label, box, ...(fill.color && !fill.none ? { fill: fill.color } : {}), fillAlpha: fill.alpha, gradient: fill.gradient, outlined, paras,
        insets: { l: inset("lIns", 91440), t: inset("tIns", 45720), r: inset("rIns", 91440), b: inset("bIns", 45720) },
        wrap: !bodyPr || attr(bodyPr, "wrap") !== "none", anchor: (A(bodyPr, "anchor") === "ctr" ? "ctr" : A(bodyPr, "anchor") === "b" ? "b" : "t"),
        autofit: bodyPr && elements(bodyPr).some((el) => localName(el) === "spAutoFit") ? "shape" : bodyPr && elements(bodyPr).some((el) => localName(el) === "normAutofit") ? "shrink" : "none",
        ...(styleColor ? { styleColor } : {}),
      });
    }
  };
  if (tree) walk(tree, (box) => box);
  return { items, background, words, fonts };
}

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface TextRect { x: number; y: number; w: number; h: number; needed: number; available: number; widest: number; availableWidth: number }

function textRect(item: Item): TextRect {
  const widthPt = Math.max(1, item.box.w / EMU_PT - item.insets.l - item.insets.r);
  const heightPt = Math.max(1, item.box.h / EMU_PT - item.insets.t - item.insets.b);
  const m = measure(item.paras, widthPt, item.wrap);
  const used = item.wrap ? Math.min(widthPt, m.maxLine) : m.maxLine;
  const align = item.paras[0]?.align ?? "l";
  const left = item.box.x / EMU_PT + item.insets.l;
  const x = align === "ctr" ? left + (widthPt - used) / 2 : align === "r" ? left + widthPt - used : left;
  const top = item.box.y / EMU_PT + item.insets.t;
  const y = item.anchor === "ctr" ? top + (heightPt - m.height) / 2 : item.anchor === "b" ? top + heightPt - m.height : top;
  return { x, y, w: used, h: m.height, needed: m.height, available: heightPt, widest: m.maxLine, availableWidth: widthPt };
}

const overlapArea = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

export function lintDeck(bytes: Uint8Array): DeckLintReport {
  const pkg = new ZipPackage(bytes);
  const presentationXml = pkg.text("ppt/presentation.xml");
  if (!presentationXml) throw new Error("pptx_presentation_missing");
  const presentation = parseXml(presentationXml).root;
  const size = descendants(presentation, "p:sldSz")[0];
  const slideW = Number(size ? attr(size, "cx") : 12192000) || 12192000, slideH = Number(size ? attr(size, "cy") : 6858000) || 6858000;
  const presRels = relsOf(pkg, "ppt/presentation.xml");
  const targets = new Map(presRels.map((rel) => [rel.id, rel.target]));
  const slideParts = descendants(presentation, "p:sldId").map((el) => targets.get(attr(el, "r:id") ?? "")).filter((part): part is string => !!part && pkg.has(part));
  const masterPart = presRels.find((rel) => rel.type.endsWith("/slideMaster"))?.target;
  const theme = readTheme(pkg, masterPart);
  const masterBg = (() => { const xml = masterPart ? pkg.text(masterPart) : undefined; const bg = xml ? descendants(parseXml(xml).root, "p:bgPr")[0] : undefined; return (bg ? colorOf(bg, theme).color : undefined) ?? theme.get("bg1") ?? "FFFFFF"; })();
  const findings: DeckFinding[] = [];
  const add = (finding: DeckFinding) => { findings.push(finding); };
  const fontsSeen = new Set<string>();
  const signatures: string[] = [];
  let visualSlides = 0;

  slideParts.forEach((part, index) => {
    const slide = index + 1;
    const read = readSlide(pkg, part, parseXml(pkg.text(part) ?? "<p/>").root, theme, masterBg);
    read.fonts.forEach((f) => fontsSeen.add(f));
    const texts = read.items.filter((item) => item.kind === "text");
    const isVisual = read.items.some((item) => item.kind === "pic" || item.kind === "chart" || item.kind === "table" || item.kind === "line"
      || (item.kind === "shape" && (!!item.fill || item.outlined)) || (item.kind === "text" && (!!item.fill || item.outlined)));
    if (isVisual) visualSlides += 1;
    else if (texts.length) add({ code: "plain_slide", severity: "warn", slide, detail: "this slide holds only text boxes on the background: no shape, card, chart, table or picture", fix: "give it one visual: a card or panel behind the text, a big number callout, a chart, a table or a diagram" });
    if (read.words > DECK_LINT_LIMITS.maxWords) add({ code: "too_many_words", severity: "warn", slide, detail: `${read.words} words on one slide (limit ${DECK_LINT_LIMITS.maxWords})`, fix: "cut the words or split the slide; a slide carries one message" });
    signatures.push(read.items.map((item) => `${item.kind}${item.fill ? "f" : ""}`).join(","));

    const rects = new Map<Item, TextRect>();
    for (const item of texts) rects.set(item, textRect(item));
    read.items.forEach((item, z) => {
      const box = item.box;
      const slideBox = { x: 0, y: 0, w: slideW, h: slideH };
      const inside = overlapArea(box, slideBox);
      if (item.kind === "text") {
        const outside = box.x < -0.015 * slideW || box.y < -0.015 * slideH || box.x + box.w > 1.015 * slideW || box.y + box.h > 1.015 * slideH;
        if (outside) add({ code: "outside_slide", severity: "error", slide, shape: item.name, detail: `text box at (${(box.x / EMU_IN).toFixed(2)}, ${(box.y / EMU_IN).toFixed(2)}) in, ${(box.w / EMU_IN).toFixed(2)}x${(box.h / EMU_IN).toFixed(2)} in runs past the ${(slideW / EMU_IN).toFixed(2)}x${(slideH / EMU_IN).toFixed(2)} in slide`, fix: "move or shrink the box; remember the default 16:9 canvas is 10x5.625 in until pres.layout is set" });
        else {
          const m = DECK_LINT_LIMITS.marginInches * EMU_IN;
          const fullBleed = item.fill && box.w >= 0.9 * slideW;
          if (!fullBleed && (box.x < m || box.y < m || box.x + box.w > slideW - m || box.y + box.h > slideH - m)) add({ code: "margin_tight", severity: "warn", slide, shape: item.name, detail: `text box closer than ${DECK_LINT_LIMITS.marginInches} in to the slide edge`, fix: "keep text 0.5 in from the edge (0.35 in at the very least)" });
        }
        const rect = rects.get(item) as TextRect;
        const heightOver = rect.needed > rect.available * 1.04 + 2;
        const widthOver = !item.wrap && rect.widest > rect.availableWidth * 1.02 + 2;
        const bottomPt = rect.y + rect.h;
        if (item.autofit === "shape" && bottomPt > (slideH / EMU_PT) * 1.01) add({ code: "outside_slide", severity: "error", slide, shape: item.name, detail: `the text runs ${(bottomPt - slideH / EMU_PT).toFixed(0)} pt below the slide`, fix: "shorten the text or start the box higher" });
        else if ((heightOver || widthOver) && item.autofit === "none") add({ code: "text_overflow", severity: "error", slide, shape: item.name, detail: heightOver ? `needs about ${rect.needed.toFixed(0)} pt of height, the box has ${rect.available.toFixed(0)} pt` : `one line is about ${rect.widest.toFixed(0)} pt wide, the box has ${rect.availableWidth.toFixed(0)} pt`, fix: "shorten the text, widen or heighten the box, or lower the type size (not below 12 pt)" });
        else if ((heightOver || widthOver) && item.autofit === "shrink") add({ code: "text_overflow", severity: "warn", slide, shape: item.name, detail: `text may not fit (needs about ${rect.needed.toFixed(0)} pt, box ${rect.available.toFixed(0)} pt) and relies on shrink-on-overflow, which PowerPoint applies only when the text is edited`, fix: "size the box for the text instead of relying on autofit" });
        const sizes = item.paras.flatMap((para) => para.runs.filter((r) => r.text.trim()).map((r) => r.size)).filter((s): s is number => s !== undefined);
        const smallest = sizes.length ? Math.min(...sizes) : undefined;
        if (smallest !== undefined && smallest < DECK_LINT_LIMITS.minFontWarn) add({ code: "font_too_small", severity: smallest < DECK_LINT_LIMITS.minFontError ? "error" : "warn", slide, shape: item.name, detail: `${smallest} pt type (readable floor ${DECK_LINT_LIMITS.minFontWarn} pt)`, fix: "raise to 12 pt or more; if it does not fit, cut words or enlarge the box instead of shrinking the type" });
        // contrast: the text colour against whatever is painted under the text block
        const textColor = item.paras.flatMap((p) => p.runs).find((r) => r.text.trim())?.color ?? item.styleColor ?? theme.get("tx1") ?? "000000";
        let under: string | null = read.background; let unknown = false;
        for (let k = 0; k < z; k++) {
          const below = read.items[k];
          const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
          const bx = below.box.x / EMU_PT, by = below.box.y / EMU_PT, bw = below.box.w / EMU_PT, bh = below.box.h / EMU_PT;
          if (cx < bx || cx > bx + bw || cy < by || cy > by + bh) continue;
          if (below.kind === "pic") { unknown = true; continue; }
          if (below.gradient) { unknown = true; continue; }
          if (below.fill && below.kind !== "text") { under = below.fillAlpha < 1 && under ? blend(below.fill, under, below.fillAlpha) : below.fill; unknown = false; }
        }
        if (item.fill && !item.gradient) under = item.fillAlpha < 1 && under ? blend(item.fill, under, item.fillAlpha) : item.fill;
        if (item.gradient) unknown = true;
        if (under && !unknown) {
          const big = (smallest ?? 18) >= 24 || (item.paras.some((p) => p.runs.some((r) => r.bold)) && (smallest ?? 18) >= 18.66);
          const ratio = contrastRatio(textColor, under);
          const need = big ? DECK_LINT_LIMITS.contrastLarge : DECK_LINT_LIMITS.contrastNormal;
          if (ratio < need) add({ code: "low_contrast", severity: ratio < DECK_LINT_LIMITS.contrastLarge ? "error" : "warn", slide, shape: item.name, detail: `text #${textColor} on #${under} is ${ratio.toFixed(2)}:1 (needs ${need}:1)`, fix: "use a lighter or darker text colour, or change the fill behind it" });
        }
      } else if (inside === 0 && item.kind !== "line") add({ code: "outside_slide", severity: "warn", slide, shape: item.name, detail: "this shape lies completely outside the slide", fix: "delete it or move it onto the slide" });
    });
    for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
      const ra = rects.get(texts[a]) as TextRect, rb = rects.get(texts[b]) as TextRect;
      const common = overlapArea(ra, rb);
      const smaller = Math.min(ra.w * ra.h, rb.w * rb.h);
      if (smaller > 0 && common / smaller > 0.15) add({ code: "text_overlap", severity: "error", slide, shape: `${texts[a].name} × ${texts[b].name}`, detail: `the text of these two boxes overlaps (${Math.round(100 * common / smaller)}% of the smaller block)`, fix: "move one box, or give each its own row/column; check the larger one for overflow first" });
    }
  });

  for (const font of fontsSeen) if (!SAFE_FONTS.has(font.toLowerCase())) add({ code: "font_face", severity: "warn", slide: 0, detail: `font "${font}" is not in the safe list`, fix: "for Korean text use Malgun Gothic (PowerPoint substitutes a sans on a Mac); other fonts may fall back to a serif elsewhere" });
  for (let i = 0; i + 2 < signatures.length; i++) if (signatures[i] && signatures[i] === signatures[i + 1] && signatures[i] === signatures[i + 2]) { add({ code: "layout_repeat", severity: "warn", slide: i + 1, detail: `slides ${i + 1}-${i + 3} have the same structure`, fix: "vary the layout: columns, cards, a number callout, a timeline, a comparison" }); break; }

  const order: Record<DeckFinding["severity"], number> = { error: 0, warn: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.slide - b.slide);
  const errors = findings.filter((f) => f.severity === "error").length;
  return { ok: errors === 0, slides: slideParts.length, errors, warnings: findings.length - errors, visualSlides, findings: findings.slice(0, MAX_FINDINGS), limits: { ...DECK_LINT_LIMITS } };
}
