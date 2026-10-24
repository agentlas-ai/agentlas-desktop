import type { LiveCellLook, LiveChartGroupLook, LiveChartLook, LiveChartSeriesLook, LiveLookColor, LiveShapeLook } from "../../../shared/live-document";
import { relsPathFor, resolvePartPath, type ZipPackage } from "../zip";
import { attr, elements, parseXml, textContent, type XmlElement } from "../xml-lite";

/*
 * How a slide shape looks in the file, for document.render only (LiveShape.look): its preset outline, fill and line, a table's
 * cell fills, borders and type, a native chart's cached values and series colours, a picture's part. Nothing here is edited or
 * written back, and the outline (document.read) never shows it: it exists so the picture a model reviews is the deck's, not a
 * generic stand-in (2026-10-23: charts drawn as a "chart" box, ellipses as rectangles, a 14213D table header as fixed blue).
 *
 * Every reader is forgiving: a part it cannot read leaves the look out and render-html.ts draws the shape as before.
 */

const EMU_PER_PT = 12700;
const OFFICE_ACCENTS = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const PRESET_COLORS: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080", grey: "#808080", orange: "#ffa500" };

const child = (parent: XmlElement | undefined, local: string): XmlElement | undefined => parent ? elements(parent).find((el) => localNameOf(el) === local) : undefined;
const children = (parent: XmlElement | undefined, local: string): XmlElement[] => parent ? elements(parent).filter((el) => localNameOf(el) === local) : [];
function localNameOf(el: XmlElement): string { const colon = el.name.indexOf(":"); return colon < 0 ? el.name : el.name.slice(colon + 1); }
function deep(parent: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!parent) return undefined;
  for (const el of elements(parent)) { if (localNameOf(el) === local) return el; const found = deep(el, local); if (found) return found; }
  return undefined;
}
const val = (el: XmlElement | undefined): string | undefined => (el ? attr(el, "val") : undefined);
const num = (value: string | undefined): number | undefined => { const n = value === undefined ? Number.NaN : Number(value); return Number.isFinite(n) ? n : undefined; };
const flag = (el: XmlElement | undefined): boolean | undefined => { if (!el) return undefined; const v = attr(el, "val"); return v === undefined ? true : v === "1" || v === "true"; };

// ── colours ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]; }
function rgbToHex(rgb: number[]): string { return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`; }

function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]: number[]): number[] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** One DrawingML colour element (srgbClr, schemeClr, sysClr, prstClr) with its alpha, lumMod/lumOff, tint and shade. */
export function lookColor(el: XmlElement | undefined, theme: Map<string, string>): LiveLookColor | undefined {
  if (!el) return undefined;
  const kind = localNameOf(el), value = attr(el, "val") ?? "";
  let hex: string | undefined;
  if (kind === "srgbClr" && /^[0-9a-fA-F]{6}$/.test(value)) hex = `#${value.toLowerCase()}`;
  else if (kind === "schemeClr") hex = theme.get(value);
  else if (kind === "sysClr") { const last = attr(el, "lastClr"); hex = last && /^[0-9a-fA-F]{6}$/.test(last) ? `#${last.toLowerCase()}` : value === "window" ? "#ffffff" : value === "windowText" ? "#000000" : undefined; }
  else if (kind === "prstClr") hex = PRESET_COLORS[value];
  if (!hex) return undefined;
  let rgb: number[] = hexToRgb(hex), alpha: number | undefined;
  const mods = elements(el);
  const lumMod = num(val(mods.find((m) => localNameOf(m) === "lumMod"))), lumOff = num(val(mods.find((m) => localNameOf(m) === "lumOff")));
  if (lumMod !== undefined || lumOff !== undefined) {
    const [h, s, l] = rgbToHsl(rgb);
    rgb = hslToRgb([h, s, Math.max(0, Math.min(1, l * ((lumMod ?? 100000) / 100000) + (lumOff ?? 0) / 100000))]);
  }
  for (const mod of mods) {
    const amount = num(val(mod));
    if (amount === undefined) continue;
    if (localNameOf(mod) === "tint") rgb = rgb.map((c) => c * (amount / 100000) + 255 * (1 - amount / 100000));
    else if (localNameOf(mod) === "shade") rgb = rgb.map((c) => c * (amount / 100000));
    else if (localNameOf(mod) === "alpha") alpha = Math.max(0, Math.min(1, amount / 100000));
  }
  return { hex: rgbToHex(rgb), ...(alpha !== undefined && alpha < 1 ? { alpha } : {}) };
}

/** The fill a properties element declares: solid, the first gradient stop, a pattern's foreground, or explicit none. */
function lookFill(container: XmlElement | undefined, theme: Map<string, string>): LiveLookColor | "none" | undefined {
  if (!container) return undefined;
  for (const el of elements(container)) {
    const name = localNameOf(el);
    if (name === "noFill") return "none";
    if (name === "solidFill") return lookColor(elements(el)[0], theme);
    if (name === "gradFill") { const stop = deep(el, "gs"); return stop ? lookColor(elements(stop)[0], theme) : undefined; }
    if (name === "pattFill") return lookColor(elements(child(el, "fgClr") ?? el)[0], theme);
  }
  return undefined;
}

function lookLine(ln: XmlElement | undefined, theme: Map<string, string>): LiveShapeLook["line"] | "none" | undefined {
  if (!ln) return undefined;
  const fill = lookFill(ln, theme);
  if (fill === "none") return "none";
  if (!fill) return undefined;
  const width = (num(attr(ln, "w")) ?? 9525) / EMU_PER_PT;
  const dash = val(child(ln, "prstDash"));
  return { color: fill, width, ...(dash && dash !== "solid" ? { dash: true } : {}) };
}

// ── shapes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ANCHOR: Record<string, "top" | "middle" | "bottom"> = { t: "top", ctr: "middle", b: "bottom" };

/** sp, cxnSp, pic or graphicFrame: geometry, fill, line, rotation, and the text anchor a text shape sets itself. */
export function shapeLook(shape: XmlElement, theme: Map<string, string>): LiveShapeLook {
  const look: LiveShapeLook = {};
  const spPr = child(shape, "spPr");
  const xfrm = child(spPr, "xfrm") ?? child(shape, "xfrm");
  if (xfrm) {
    const rot = num(attr(xfrm, "rot"));
    if (rot) look.rot = rot / 60000;
    if (attr(xfrm, "flipH") === "1") look.flipH = true;
    if (attr(xfrm, "flipV") === "1") look.flipV = true;
  }
  const prst = child(spPr, "prstGeom");
  if (prst) {
    const geom = attr(prst, "prst");
    if (geom && geom !== "rect") look.geom = geom;
    const gd = deep(prst, "gd");
    const adj = gd ? /^val\s+(-?\d+)$/.exec(attr(gd, "fmla") ?? "")?.[1] : undefined;
    if (adj !== undefined) look.adj = Number(adj);
  } else if (child(spPr, "custGeom")) look.geom = "custom";
  if (localNameOf(shape) === "cxnSp" && !look.geom) look.geom = "line";
  // p:style holds the theme fill and line a shape drawn in PowerPoint inherits when spPr says nothing.
  const style = child(shape, "style");
  const fill = lookFill(spPr, theme) ?? (num(attr(child(style, "fillRef") ?? shape, "idx")) ? lookColor(elements(child(style, "fillRef")!)[0], theme) : undefined);
  if (fill) look.fill = fill;
  const line = lookLine(child(spPr, "ln"), theme);
  const styleLine = !line && num(attr(child(style, "lnRef") ?? shape, "idx")) ? lookColor(elements(child(style, "lnRef")!)[0], theme) : undefined;
  if (line && line !== "none") look.line = line;
  else if (styleLine) look.line = { color: styleLine, width: 0.75 };
  const anchor = attr(child(child(shape, "txBody"), "bodyPr") ?? shape, "anchor");
  if (anchor && ANCHOR[anchor] && child(shape, "txBody")) look.anchor = ANCHOR[anchor];
  return look;
}

/** Whether a look draws anything: a shape that has neither a fill, a line nor a picture is not worth a box. */
export function looksVisible(look: LiveShapeLook): boolean {
  return (!!look.fill && look.fill !== "none") || !!look.line || !!look.image || !!look.chart;
}

// ── relationships ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function relTarget(pkg: ZipPackage, part: string, rid: string | undefined): string | undefined {
  if (!rid) return undefined;
  const xml = pkg.text(relsPathFor(part));
  if (!xml) return undefined;
  try {
    const rel = elements(parseXml(xml).root).find((el) => attr(el, "Id") === rid);
    const target = rel ? attr(rel, "Target") : undefined;
    return target && attr(rel!, "TargetMode") !== "External" ? resolvePartPath(part, target) : undefined;
  } catch { return undefined; }
}

/** A picture's image part (its blip's embedded relationship). */
export function pictureLook(pkg: ZipPackage, slidePart: string, pic: XmlElement): LiveShapeLook["image"] | undefined {
  const blip = deep(child(pic, "blipFill"), "blip");
  const part = relTarget(pkg, slidePart, blip ? attr(blip, "r:embed") : undefined);
  return part && pkg.has(part) ? { part } : undefined;
}

// ── tables ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ALIGN: Record<string, "left" | "center" | "right"> = { l: "left", ctr: "center", r: "right" };

export function tableLook(tbl: XmlElement, slideHeightEmu: number, theme: Map<string, string>): NonNullable<LiveShapeLook["table"]> {
  const tblPr = child(tbl, "tblPr");
  const widths = children(child(tbl, "tblGrid"), "gridCol").map((col) => num(attr(col, "w")) ?? 0);
  const total = widths.reduce((sum, w) => sum + w, 0);
  const rows = children(tbl, "tr");
  const cell = (tc: XmlElement): LiveCellLook | null => {
    const look: LiveCellLook = {};
    const tcPr = child(tc, "tcPr");
    const fill = lookFill(tcPr, theme);
    if (fill && fill !== "none") look.fill = fill;
    const anchor = tcPr ? attr(tcPr, "anchor") : undefined;
    if (anchor && ANCHOR[anchor]) look.anchor = ANCHOR[anchor];
    const sides = ["lnL", "lnR", "lnT", "lnB"].map((side) => lookLine(child(tcPr, side), theme));
    if (sides.some((side) => side !== undefined)) look.borders = sides.map((side) => (side && side !== "none" ? { color: side.color.hex, width: side.width } : null));
    const p = deep(child(tc, "txBody"), "p");
    const run = p ? elements(p).find((el) => localNameOf(el) === "r") : undefined;
    const rPr = child(run, "rPr") ?? child(p, "endParaRPr");
    if (rPr) {
      const color = lookFill(rPr, theme);
      if (color && color !== "none") look.color = color.hex;
      if (attr(rPr, "b") === "1") look.bold = true;
      const size = num(attr(rPr, "sz"));
      if (size) look.size = size / 100;
    }
    const align = attr(child(p, "pPr") ?? tc, "algn");
    if (align && ALIGN[align]) look.align = ALIGN[align];
    return Object.keys(look).length ? look : null;
  };
  return {
    cols: total > 0 ? widths.map((w) => w / total) : [],
    rows: rows.map((tr) => (num(attr(tr, "h")) ?? 0) / slideHeightEmu),
    // A table style (PowerPoint's own tables, insert_table) draws header and banded rows; a cell's own fill and borders override it.
    styled: !!child(tblPr, "tableStyleId"),
    cells: rows.map((tr) => children(tr, "tc").map(cell)),
  };
}

// ── charts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const GROUP_TYPES: Record<string, LiveChartGroupLook["type"]> = {
  barChart: "bar", bar3DChart: "bar", lineChart: "line", line3DChart: "line", areaChart: "area", area3DChart: "area",
  pieChart: "pie", pie3DChart: "pie", ofPieChart: "pie", doughnutChart: "doughnut",
};
const UNDRAWN = ["scatterChart", "radarChart", "bubbleChart", "stockChart", "surfaceChart", "surface3DChart"];

/** The points of a cache (strCache, numCache, or the first level of a multi-level cache), by index. */
function cachePoints(ref: XmlElement | undefined): string[] {
  const cache = deep(ref, "strCache") ?? deep(ref, "numCache") ?? deep(deep(ref, "multiLvlStrCache"), "lvl") ?? ref;
  if (!cache) return [];
  const count = num(val(child(cache, "ptCount")));
  const out: string[] = count !== undefined && count <= 10_000 ? Array<string>(count).fill("") : [];
  for (const pt of children(cache, "pt")) {
    const index = num(attr(pt, "idx"));
    if (index !== undefined && index >= 0 && index < 10_000) out[index] = textContent(child(pt, "v") ?? pt);
  }
  return out;
}

function labelFlags(dLbls: XmlElement | undefined): LiveChartGroupLook["labels"] | undefined {
  if (!dLbls) return undefined;
  if (flag(child(dLbls, "delete"))) return {};
  const source = child(dLbls, "dLbl") ?? dLbls;
  const format = attr(child(source, "numFmt") ?? child(dLbls, "numFmt") ?? dLbls, "formatCode");
  return { value: !!flag(child(source, "showVal")), percent: !!flag(child(source, "showPercent")), category: !!flag(child(source, "showCatName")), ...(format && format !== "General" ? { format } : {}) };
}

function seriesLook(ser: XmlElement, type: LiveChartGroupLook["type"], theme: Map<string, string>): LiveChartSeriesLook & { categories: string[]; labels?: LiveChartGroupLook["labels"] } {
  const tx = child(ser, "tx");
  const name = tx ? (cachePoints(child(tx, "strRef"))[0] ?? textContent(child(tx, "v") ?? tx)).trim() : "";
  const spPr = child(ser, "spPr");
  const fill = lookFill(spPr, theme);
  const stroke = lookLine(child(spPr, "ln"), theme);
  const color = type === "line" ? (stroke && stroke !== "none" ? stroke.color.hex : fill && fill !== "none" ? fill.hex : undefined) : fill && fill !== "none" ? fill.hex : undefined;
  const values = cachePoints(child(ser, "val")).map((v) => { const n = Number(v); return v === "" || !Number.isFinite(n) ? null : n; });
  const points: Array<string | null> = [];
  for (const dPt of children(ser, "dPt")) {
    const index = num(val(child(dPt, "idx")));
    const pointFill = lookFill(child(dPt, "spPr"), theme);
    if (index !== undefined && index >= 0 && index < 10_000 && pointFill && pointFill !== "none") points[index] = pointFill.hex;
  }
  const labels = labelFlags(child(ser, "dLbls"));
  return {
    name, values, categories: cachePoints(child(ser, "cat")),
    ...(color ? { color } : {}), ...(points.length ? { points: Array.from(points, (p) => p ?? null) } : {}),
    ...(type === "line" && stroke && stroke !== "none" ? { width: stroke.width } : {}), ...(labels ? { labels } : {}),
  };
}

/** A graphicFrame's chart, read from the chart part's cached values (the numbers PowerPoint draws until the data is edited). */
export function chartLook(pkg: ZipPackage, slidePart: string, frame: XmlElement, theme: Map<string, string>): LiveChartLook | undefined {
  const ref = deep(frame, "chart");
  const part = relTarget(pkg, slidePart, ref ? attr(ref, "r:id") : undefined);
  const xml = part ? pkg.text(part) : undefined;
  if (!xml) return undefined;
  let space: XmlElement;
  try { space = parseXml(xml).root; } catch { return undefined; }
  const chart = child(space, "chart");
  const plot = child(chart, "plotArea");
  if (!chart || !plot) return undefined;
  const palette = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((name, i) => theme.get(name) ?? OFFICE_ACCENTS[i]);
  const groups: LiveChartGroupLook[] = [];
  let categories: string[] = [];
  let unsupported: string | undefined;
  for (const el of elements(plot)) {
    const kind = localNameOf(el);
    if (UNDRAWN.includes(kind)) { unsupported ??= kind.replace(/Chart$/, ""); continue; }
    const type = GROUP_TYPES[kind];
    if (!type) continue;
    const groupLabels = labelFlags(child(el, "dLbls"));
    const series = children(el, "ser").map((ser) => seriesLook(ser, type, theme));
    if (!categories.length) categories = series.find((s) => s.categories.length)?.categories ?? [];
    const firstLabels = series.find((s) => s.labels)?.labels;
    const dir = val(child(el, "barDir"));
    const grouping = val(child(el, "grouping"));
    const hole = num(val(child(el, "holeSize")));
    groups.push({
      type, series: series.map(({ categories: _c, labels: _l, ...rest }) => rest),
      ...(type === "bar" ? { dir: dir === "bar" ? "bar" as const : "col" as const } : {}),
      ...(grouping === "stacked" || grouping === "percentStacked" || grouping === "clustered" || grouping === "standard" ? { grouping } : {}),
      ...(firstLabels ?? groupLabels ? { labels: firstLabels ?? groupLabels } : {}),
      ...(type === "doughnut" ? { holeSize: hole ?? 50 } : {}),
      ...(flag(child(el, "varyColors")) ? { varyColors: true } : {}),
    });
  }
  if (!groups.length && !unsupported) return undefined;
  const length = Math.max(categories.length, ...groups.flatMap((g) => g.series.map((s) => s.values.length)));
  if (categories.length < length) categories = Array.from({ length }, (_, i) => categories[i] ?? String(i + 1));
  const title = child(chart, "title");
  const titleText = title ? children(title, "tx").flatMap((tx) => [...collect(tx, "t")]).map((t) => textContent(t)).join("").trim() : "";
  const deleted = flag(child(chart, "autoTitleDeleted"));
  const onlySeries = groups.length === 1 && groups[0].series.length === 1 ? groups[0].series[0].name : "";
  const legend = child(chart, "legend");
  const legendPos = val(child(legend, "legendPos")) ?? "r";
  const catAx = child(plot, "catAx") ?? child(plot, "dateAx");
  const valAx = child(plot, "valAx");
  const scaling = child(valAx, "scaling");
  const sizeEl = deep(child(space, "txPr"), "defRPr") ?? deep(child(valAx, "txPr"), "defRPr") ?? deep(child(catAx, "txPr"), "defRPr");
  const textSize = num(sizeEl ? attr(sizeEl, "sz") : undefined);
  const textColor = sizeEl ? lookFill(sizeEl, theme) : undefined;
  const background = lookFill(child(space, "spPr"), theme);
  const min = num(val(child(scaling, "min"))), max = num(val(child(scaling, "max")));
  return {
    categories, groups, ...(unsupported ? { unsupported } : {}),
    ...(titleText ? { title: titleText } : title && !deleted && onlySeries ? { title: onlySeries } : {}),
    ...(legend && ["r", "l", "t", "b", "tr"].includes(legendPos) ? { legend: legendPos as LiveChartLook["legend"] } : {}),
    categoryAxis: !!catAx && !flag(child(catAx, "delete")),
    valueAxis: !!valAx && !flag(child(valAx, "delete")),
    gridlines: !!child(valAx, "majorGridlines"),
    ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
    ...(textSize ? { textSize: textSize / 100 } : {}),
    ...(textColor && textColor !== "none" ? { textColor: textColor.hex } : {}),
    ...(background && background !== "none" ? { background: background.hex } : {}),
    palette,
  };
}

function* collect(parent: XmlElement, local: string): Generator<XmlElement> {
  for (const el of elements(parent)) { if (localNameOf(el) === local) yield el; else yield* collect(el, local); }
}
