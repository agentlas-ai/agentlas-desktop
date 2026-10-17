import type { LiveFormat, LiveFormatPatch, LiveShape, LiveSlide } from "../../../shared/live-document";
import { relsPathFor, resolvePartPath, ZipPackage } from "../zip";
import {
  attr, createElement, elements, escapeXmlAttr, escapeXmlText, firstElement, localName, markDirty, markPath, parseXml,
  serializeNode, serializeXml, setAttr, textContent, type XmlDocument, type XmlElement,
} from "../xml-lite";
import { LiveDocumentCodecError, type LiveDocumentCodec } from "./common";
import { el, formatDelta, hex6, isEmptyFormat, removeChildren } from "./format";

const ALGN_IN: Record<string, LiveFormat["align"]> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" };
const ALGN_OUT: Record<NonNullable<LiveFormat["align"]>, string> = { left: "l", center: "ctr", right: "r", justify: "just" };

/*
 * PPTX: slides in presentation order; text shapes (placeholders and text boxes, also inside groups) are editable.
 * A changed shape keeps its body properties, list style and each paragraph's properties and first-run formatting.
 * New slides use the master's "Title and Content" layout (or the last slide's layout) with explicit positions;
 * a deleted slide leaves the slide list together with its own part, notes and comments.
 */

const PRESENTATION = "ppt/presentation.xml";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_SLIDE = `${REL}/slide`;
const REL_LAYOUT = `${REL}/slideLayout`;
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

interface Box { x: number; y: number; w: number; h: number }
interface ShapeRef { shape: LiveShape; element: XmlElement }
interface SlideInfo { id: string; part: string; doc: XmlDocument; sldId: XmlElement; rid: string; shapes: ShapeRef[]; slide: LiveSlide }

interface PresentationInfo {
  pkg: ZipPackage;
  presentation: XmlDocument;
  rels: XmlDocument;
  cx: number;
  cy: number;
  theme: Map<string, string>;
  slides: SlideInfo[];
}

function rels(pkg: ZipPackage, part: string): Array<{ id: string; type: string; target: string }> {
  const xml = pkg.text(relsPathFor(part));
  if (!xml) return [];
  return elements(parseXml(xml).root).map((rel) => ({ id: attr(rel, "Id") ?? "", type: attr(rel, "Type") ?? "", target: resolvePartPath(part, attr(rel, "Target") ?? "") }));
}

function readTheme(pkg: ZipPackage, masterPart: string | undefined): Map<string, string> {
  const colors = new Map<string, string>();
  const themePart = masterPart ? rels(pkg, masterPart).find((rel) => rel.type.endsWith("/theme"))?.target : undefined;
  const xml = themePart ? pkg.text(themePart) : undefined;
  if (!xml) return colors;
  const scheme = findDeep(parseXml(xml).root, "clrScheme");
  for (const entry of scheme ? elements(scheme) : []) {
    const value = elements(entry)[0];
    const hex = value ? (attr(value, "val") ?? attr(value, "lastClr")) : undefined;
    if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) colors.set(localName(entry), `#${hex.toLowerCase()}`);
  }
  colors.set("tx1", colors.get("dk1") ?? "#000000"); colors.set("bg1", colors.get("lt1") ?? "#ffffff");
  colors.set("tx2", colors.get("dk2") ?? "#1f1f1f"); colors.set("bg2", colors.get("lt2") ?? "#eeeeee");
  return colors;
}

function findDeep(element: XmlElement, local: string): XmlElement | undefined {
  for (const child of elements(element)) {
    if (localName(child) === local) return child;
    const found = findDeep(child, local);
    if (found) return found;
  }
  return undefined;
}

function solidColor(container: XmlElement | undefined, theme: Map<string, string>): string | undefined {
  const fill = container ? elements(container).find((el) => localName(el) === "solidFill") : undefined;
  const color = fill ? elements(fill)[0] : undefined;
  if (!color) return undefined;
  const value = attr(color, "val") ?? "";
  if (localName(color) === "srgbClr" && /^[0-9a-fA-F]{6}$/.test(value)) return `#${value.toLowerCase()}`;
  if (localName(color) === "schemeClr") return theme.get(value);
  if (localName(color) === "sysClr") { const last = attr(color, "lastClr"); return last ? `#${last.toLowerCase()}` : undefined; }
  return undefined;
}

function xfrmBox(spPr: XmlElement | undefined): Box | null {
  const xfrm = spPr ? elements(spPr).find((el) => localName(el) === "xfrm") : undefined;
  const off = xfrm ? firstElement(xfrm, "a:off") : undefined;
  const ext = xfrm ? firstElement(xfrm, "a:ext") : undefined;
  if (!off || !ext) return null;
  return { x: Number(attr(off, "x") ?? 0), y: Number(attr(off, "y") ?? 0), w: Number(attr(ext, "cx") ?? 0), h: Number(attr(ext, "cy") ?? 0) };
}

function placeholder(sp: XmlElement): { type: string; idx: string } | null {
  const nv = elements(sp).find((el) => localName(el).startsWith("nv"));
  const nvPr = nv ? firstElement(nv, "p:nvPr") : undefined;
  const ph = nvPr ? firstElement(nvPr, "p:ph") : undefined;
  return ph ? { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") ?? "" } : null;
}

const normType = (type: string) => (type === "ctrTitle" ? "title" : type === "subTitle" || type === "obj" ? "body" : type);

function inheritedBox(pkg: ZipPackage, slidePart: string, ph: { type: string; idx: string }): Box | null {
  const layout = rels(pkg, slidePart).find((rel) => rel.type === REL_LAYOUT)?.target;
  const chain = layout ? [layout, rels(pkg, layout).find((rel) => rel.type.endsWith("/slideMaster"))?.target] : [];
  for (const part of chain) {
    const xml = part ? pkg.text(part) : undefined;
    if (!xml) continue;
    const tree = findDeep(parseXml(xml).root, "spTree");
    const candidates = tree ? elements(tree).filter((el) => localName(el) === "sp") : [];
    const match = candidates.find((sp) => { const p = placeholder(sp); return !!p && !!ph.idx && p.idx === ph.idx; })
      ?? candidates.find((sp) => { const p = placeholder(sp); return !!p && normType(p.type) === normType(ph.type); });
    const box = match ? xfrmBox(firstElement(match, "p:spPr")) : null;
    if (box) return box;
  }
  return null;
}

function inheritedBackground(pkg: ZipPackage, slidePart: string, doc: XmlDocument, theme: Map<string, string>): string | undefined {
  const own = (root: XmlElement) => { const bg = findDeep(root, "bg"); const bgPr = bg ? firstElement(bg, "p:bgPr") : undefined; return solidColor(bgPr, theme); };
  const direct = own(doc.root);
  if (direct) return direct;
  const layout = rels(pkg, slidePart).find((rel) => rel.type === REL_LAYOUT)?.target;
  const master = layout ? rels(pkg, layout).find((rel) => rel.type.endsWith("/slideMaster"))?.target : undefined;
  for (const part of [layout, master]) {
    const xml = part ? pkg.text(part) : undefined;
    const color = xml ? own(parseXml(xml).root) : undefined;
    if (color) return color;
  }
  return undefined;
}

export function pptxShapeText(txBody: XmlElement | undefined): string {
  if (!txBody) return "";
  return elements(txBody).filter((el) => localName(el) === "p").map((p) => {
    let line = "";
    for (const child of elements(p)) {
      const name = localName(child);
      if (name === "r" || name === "fld") { const t = firstElement(child, "a:t"); if (t) line += textContent(t); }
      else if (name === "br") line += "\n";
    }
    return line;
  }).join("\n");
}

function shapeFormat(txBody: XmlElement | undefined, theme: Map<string, string>): LiveFormat | undefined {
  const p = txBody ? elements(txBody).find((el) => localName(el) === "p") : undefined;
  if (!p) return undefined;
  const pPr = firstElement(p, "a:pPr");
  const run = elements(p).find((el) => localName(el) === "r");
  const rPr = run ? firstElement(run, "a:rPr") : firstElement(p, "a:endParaRPr");
  const format: LiveFormat = {};
  const size = rPr ? Number(attr(rPr, "sz")) : Number.NaN;
  if (Number.isFinite(size) && size > 0) format.size = size / 100;
  if (rPr && attr(rPr, "b") === "1") format.bold = true;
  if (rPr && attr(rPr, "i") === "1") format.italic = true;
  if (rPr && (attr(rPr, "u") ?? "none") !== "none") format.underline = true;
  const color = solidColor(rPr, theme);
  if (color) format.color = color;
  const align = pPr ? ALGN_IN[attr(pPr, "algn") ?? ""] : undefined;
  if (align) format.align = align;
  return isEmptyFormat(format) ? undefined : format;
}

/** Writes a format change into every paragraph and run of a text body (run properties are attributes + solidFill). */
function setShapeFormat(root: XmlElement, sp: XmlElement, delta: LiveFormatPatch): void {
  if (delta.fill !== undefined) {
    // spPr sequence: xfrm, geometry, fill, ln, effects…
    let spPr = firstElement(sp, "p:spPr");
    if (!spPr) { spPr = el("<p:spPr/>"); sp.children.splice(1, 0, spPr); }
    removeChildren(spPr, "solidFill", "noFill", "gradFill", "blipFill", "pattFill", "grpFill");
    if (delta.fill) {
      const after = [...spPr.children].reverse().find((node) => node.type === "el" && ["xfrm", "custGeom", "prstGeom"].includes(localName(node)));
      spPr.children.splice(after ? spPr.children.indexOf(after) + 1 : 0, 0, el(`<a:solidFill><a:srgbClr val="${hex6(delta.fill)}"/></a:solidFill>`));
      spPr.selfClosing = false;
    }
    markDirty(spPr);
    markPath(root, spPr);
  }
  const txBody = firstElement(sp, "p:txBody");
  if (!txBody) return;
  const runProps = (rPr: XmlElement) => {
    if (delta.bold !== undefined) setAttr(rPr, "b", delta.bold === null ? null : delta.bold ? "1" : "0");
    if (delta.italic !== undefined) setAttr(rPr, "i", delta.italic === null ? null : delta.italic ? "1" : "0");
    if (delta.underline !== undefined) setAttr(rPr, "u", delta.underline === null ? null : delta.underline ? "sng" : "none");
    if (delta.size !== undefined) setAttr(rPr, "sz", delta.size === null ? null : String(Math.round(delta.size * 100)));
    if (delta.color === null) removeChildren(rPr, "solidFill");
    else if (delta.color !== undefined) {
      removeChildren(rPr, "solidFill", "gradFill", "noFill", "pattFill", "blipFill", "grpFill");
      const fill = el(`<a:solidFill><a:srgbClr val="${hex6(delta.color)}"/></a:solidFill>`);
      const ln = rPr.children.findIndex((node) => node.type === "el" && localName(node) === "ln");
      rPr.children.splice(ln >= 0 ? ln + 1 : 0, 0, fill);
      rPr.selfClosing = false;
    }
    markDirty(rPr);
  };
  for (const p of elements(txBody).filter((node) => localName(node) === "p")) {
    if (delta.align !== undefined) {
      let pPr = firstElement(p, "a:pPr");
      if (!pPr) { pPr = el("<a:pPr/>"); p.children.unshift(pPr); }
      setAttr(pPr, "algn", delta.align === null ? null : ALGN_OUT[delta.align]);
    }
    for (const run of elements(p).filter((node) => localName(node) === "r" || localName(node) === "fld")) {
      let rPr = firstElement(run, "a:rPr");
      if (!rPr) { rPr = el('<a:rPr lang="ko-KR"/>'); run.children.unshift(rPr); }
      runProps(rPr);
      markDirty(run);
    }
    const end = firstElement(p, "a:endParaRPr");
    if (end) runProps(end);
    markDirty(p);
  }
  markDirty(txBody);
  markPath(root, txBody);
}

function collectShapes(info: { pkg: ZipPackage; cx: number; cy: number; theme: Map<string, string> }, part: string, tree: XmlElement, slideId: string): ShapeRef[] {
  const out: ShapeRef[] = [];
  const walk = (container: XmlElement, map: (box: Box) => Box) => {
    for (const child of elements(container)) {
      const name = localName(child);
      if (name === "grpSp") {
        const grpSpPr = firstElement(child, "p:grpSpPr");
        const xfrm = grpSpPr ? firstElement(grpSpPr, "a:xfrm") : undefined;
        const off = xfrm ? firstElement(xfrm, "a:off") : undefined; const ext = xfrm ? firstElement(xfrm, "a:ext") : undefined;
        const chOff = xfrm ? firstElement(xfrm, "a:chOff") : undefined; const chExt = xfrm ? firstElement(xfrm, "a:chExt") : undefined;
        if (off && ext && chOff && chExt) {
          const ox = Number(attr(off, "x")), oy = Number(attr(off, "y")), ew = Number(attr(ext, "cx")), eh = Number(attr(ext, "cy"));
          const cx = Number(attr(chOff, "x")), cy = Number(attr(chOff, "y")), cw = Number(attr(chExt, "cx")) || 1, ch = Number(attr(chExt, "cy")) || 1;
          walk(child, (box) => map({ x: ox + (box.x - cx) * ew / cw, y: oy + (box.y - cy) * eh / ch, w: box.w * ew / cw, h: box.h * eh / ch }));
        } else walk(child, map);
        continue;
      }
      if (!["sp", "pic", "graphicFrame", "cxnSp"].includes(name)) continue;
      const spPr = elements(child).find((el) => localName(el) === "spPr") ?? (name === "graphicFrame" ? child : undefined);
      const ph = name === "sp" ? placeholder(child) : null;
      const raw = name === "graphicFrame" ? xfrmBox(child) : (xfrmBox(spPr) ?? (ph ? inheritedBox(info.pkg, part, ph) : null));
      if (!raw) continue;
      const box = map(raw);
      const frac = { x: box.x / info.cx, y: box.y / info.cy, w: box.w / info.cx, h: box.h / info.cy };
      const id = `${slideId}.sh${out.length + 1}`;
      const txBody = name === "sp" ? firstElement(child, "p:txBody") : undefined;
      if (name === "sp" && (txBody || ph)) {
        const type = ph ? normType(ph.type) : "";
        const role: LiveShape["role"] = type === "title" ? "title" : ph && ["body", ""].includes(type) ? "body" : ph && ["dt", "ftr", "sldNum"].includes(type) ? "object" : "text";
        if (role === "object") continue;
        const textFormat = shapeFormat(txBody, info.theme);
        const shapeFill = solidColor(spPr, info.theme);
        const format = shapeFill ? { ...(textFormat ?? {}), fill: shapeFill } : textFormat;
        out.push({ element: child, shape: { id, role, text: pptxShapeText(txBody), ...frac, ...(format ? { format } : {}) } });
      } else {
        const label = name === "pic" ? "image" : name === "graphicFrame" ? (findDeep(child, "tbl") ? "table" : findDeep(child, "chart") ? "chart" : "object") : undefined;
        const fill = solidColor(spPr, info.theme);
        if (!label && !fill) continue;
        out.push({ element: child, shape: { id, role: "object", text: "", ...frac, ...(label ? { label } : {}), ...(fill ? { fill } : {}) } });
      }
    }
  };
  walk(tree, (box) => box);
  return out;
}

function load(bytes: Uint8Array): PresentationInfo {
  const pkg = new ZipPackage(bytes);
  const xml = pkg.text(PRESENTATION);
  if (!xml) throw new LiveDocumentCodecError("pptx_presentation_missing");
  const presentation = parseXml(xml);
  const relsXml = pkg.text(relsPathFor(PRESENTATION));
  if (!relsXml) throw new LiveDocumentCodecError("pptx_rels_missing");
  const relDoc = parseXml(relsXml);
  const targets = new Map(elements(relDoc.root).map((rel) => [attr(rel, "Id") ?? "", resolvePartPath(PRESENTATION, attr(rel, "Target") ?? "")]));
  const size = findDeep(presentation.root, "sldSz");
  const cx = Number(size ? attr(size, "cx") : 12192000) || 12192000;
  const cy = Number(size ? attr(size, "cy") : 6858000) || 6858000;
  const list = findDeep(presentation.root, "sldIdLst");
  const sldIds = list ? elements(list).filter((el) => localName(el) === "sldId") : [];
  const firstPart = sldIds.length ? targets.get(attr(sldIds[0], "r:id") ?? "") : undefined;
  const layout = firstPart ? rels(pkg, firstPart).find((rel) => rel.type === REL_LAYOUT)?.target : undefined;
  const master = layout ? rels(pkg, layout).find((rel) => rel.type.endsWith("/slideMaster"))?.target : undefined;
  const theme = readTheme(pkg, master);
  const slides: SlideInfo[] = [];
  sldIds.forEach((sldId, index) => {
    const rid = attr(sldId, "r:id") ?? "";
    const part = targets.get(rid);
    const slideXml = part ? pkg.text(part) : undefined;
    if (!part || !slideXml) return;
    const doc = parseXml(slideXml);
    const id = `s${index + 1}`;
    const tree = findDeep(doc.root, "spTree");
    const shapes = tree ? collectShapes({ pkg, cx, cy, theme }, part, tree, id) : [];
    const background = inheritedBackground(pkg, part, doc, theme);
    slides.push({ id, part, doc, sldId, rid, shapes, slide: { id, ...(background ? { background } : {}), shapes: shapes.map((ref) => ref.shape) } });
  });
  return { pkg, presentation, rels: relDoc, cx, cy, theme, slides };
}

function setShapeText(root: XmlElement, sp: XmlElement, text: string): void {
  let txBody = firstElement(sp, "p:txBody");
  if (!txBody) {
    txBody = createElement(`<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>`);
    sp.children.push(txBody);
  }
  const paragraphs = elements(txBody).filter((el) => localName(el) === "p");
  const lines = text.split("\n");
  const built = lines.map((line, index) => {
    const template = paragraphs[Math.min(index, paragraphs.length - 1)];
    const pPr = template ? firstElement(template, "a:pPr") : undefined;
    const run = template ? elements(template).find((el) => localName(el) === "r") : undefined;
    const rPr = run ? firstElement(run, "a:rPr") : undefined;
    const end = template ? firstElement(template, "a:endParaRPr") : undefined;
    const rPrMarkup = rPr ? serializeNode(rPr) : end ? serializeNode(end).replace(/^<a:endParaRPr/, "<a:rPr").replace(/<\/a:endParaRPr>$/, "</a:rPr>") : "";
    const runMarkup = line ? `<a:r>${rPrMarkup}<a:t>${escapeXmlText(line)}</a:t></a:r>` : "";
    return createElement(`<a:p>${pPr ? serializeNode(pPr) : ""}${runMarkup}${end ? serializeNode(end) : ""}</a:p>`);
  });
  const firstIndex = paragraphs.length ? txBody.children.indexOf(paragraphs[0]) : txBody.children.length;
  txBody.children = txBody.children.filter((node) => node.type !== "el" || localName(node) !== "p");
  txBody.children.splice(Math.min(firstIndex, txBody.children.length), 0, ...built);
  markDirty(txBody);
  markPath(root, txBody);
}

function chooseLayout(info: PresentationInfo, anchor: SlideInfo | undefined): string | undefined {
  const reference = anchor ?? info.slides[info.slides.length - 1];
  const fallback = reference ? rels(info.pkg, reference.part).find((rel) => rel.type === REL_LAYOUT)?.target : undefined;
  const master = fallback ? rels(info.pkg, fallback).find((rel) => rel.type.endsWith("/slideMaster"))?.target : undefined;
  if (master) {
    for (const rel of rels(info.pkg, master)) {
      if (rel.type !== REL_LAYOUT) continue;
      const xml = info.pkg.text(rel.target);
      if (xml && /<p:sldLayout[^>]*\stype="obj"/.test(xml)) return rel.target;
    }
  }
  return fallback;
}

function relativeTarget(fromPart: string, toPart: string): string {
  const from = fromPart.split("/").slice(0, -1);
  const to = toPart.split("/");
  let common = 0;
  while (common < from.length && from[common] === to[common]) common++;
  return [...Array(from.length - common).fill(".."), ...to.slice(common)].join("/");
}

function boxXfrm(shape: LiveShape, info: PresentationInfo): string {
  const r = (value: number) => Math.round(value);
  return `<a:xfrm><a:off x="${r(shape.x * info.cx)}" y="${r(shape.y * info.cy)}"/><a:ext cx="${r(shape.w * info.cx)}" cy="${r(shape.h * info.cy)}"/></a:xfrm>`;
}

function paragraphsMarkup(text: string, format: LiveFormat | undefined): string {
  const attrs = [format?.bold !== undefined ? ` b="${format.bold ? 1 : 0}"` : "", format?.italic !== undefined ? ` i="${format.italic ? 1 : 0}"` : "",
    format?.underline !== undefined ? ` u="${format.underline ? "sng" : "none"}"` : "", format?.size ? ` sz="${Math.round(format.size * 100)}"` : ""].join("");
  const fill = format?.color ? `<a:solidFill><a:srgbClr val="${hex6(format.color)}"/></a:solidFill>` : "";
  const rPr = (tag: string) => fill ? `<a:${tag} lang="ko-KR" altLang="en-US"${attrs} dirty="0">${fill}</a:${tag}>` : `<a:${tag} lang="ko-KR" altLang="en-US"${attrs} dirty="0"/>`;
  const pPr = format?.align ? `<a:pPr algn="${ALGN_OUT[format.align]}"/>` : "";
  return text.split("\n").map((line) => line ? `<a:p>${pPr}<a:r>${rPr("rPr")}<a:t>${escapeXmlText(line)}</a:t></a:r></a:p>` : `<a:p>${pPr}${rPr("endParaRPr")}</a:p>`).join("");
}

function newSlideXml(slide: LiveSlide, info: PresentationInfo): string {
  const shapes = slide.shapes.filter((shape) => shape.role !== "object").map((shape, index) => {
    const ph = shape.role === "title" ? `<p:ph type="title"/>` : shape.role === "body" ? `<p:ph idx="1"/>` : "";
    const name = shape.role === "title" ? `Title ${index + 1}` : shape.role === "body" ? `Content Placeholder ${index + 1}` : `TextBox ${index + 1}`;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="${escapeXmlAttr(name)}"/><p:cNvSpPr>${ph ? `<a:spLocks noGrp="1"/>` : ""}</p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${boxXfrm(shape, info)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsMarkup(shape.text, shape.format)}</p:txBody></p:sp>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="${NS_A}" xmlns:r="${REL}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function removeSlideParts(info: PresentationInfo, slide: SlideInfo): void {
  const owned = rels(info.pkg, slide.part).filter((rel) => rel.type.endsWith("/notesSlide") || rel.type.endsWith("/comments"));
  const parts = [slide.part, ...owned.map((rel) => rel.target)];
  let ct = info.pkg.text("[Content_Types].xml") ?? "";
  for (const part of parts) {
    info.pkg.remove(part);
    info.pkg.remove(relsPathFor(part));
    ct = ct.replace(new RegExp(`<Override[^>]*PartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`, "g"), "");
  }
  info.pkg.setText("[Content_Types].xml", ct);
}

export const pptxCodec: LiveDocumentCodec = {
  parse(bytes) {
    const info = load(bytes);
    return { kind: "slides", aspect: info.cx / info.cy, slides: info.slides.map((slide) => slide.slide) };
  },
  write(bytes, original, final) {
    if (original.kind !== "slides" || final.kind !== "slides") throw new LiveDocumentCodecError("model_kind_mismatch");
    const info = load(bytes);
    const byId = new Map(info.slides.map((slide) => [slide.id, slide]));
    const priorShapes = new Map(original.slides.flatMap((slide) => slide.shapes).map((shape) => [shape.id, shape]));
    const touched = new Set<SlideInfo>();
    for (const slide of final.slides) {
      const source = byId.get(slide.id);
      if (!source) continue;
      for (const shape of slide.shapes) {
        if (shape.role === "object") continue;
        const prior = priorShapes.get(shape.id);
        const delta = formatDelta(prior?.format, shape.format);
        if (prior?.text === shape.text && isEmptyFormat(delta)) continue;
        const ref = source.shapes.find((item) => item.shape.id === shape.id);
        if (!ref) continue;
        if (prior?.text !== shape.text) setShapeText(source.doc.root, ref.element, shape.text);
        if (!isEmptyFormat(delta)) setShapeFormat(source.doc.root, ref.element, delta);
        touched.add(source);
      }
    }
    for (const slide of touched) info.pkg.setText(slide.part, serializeXml(slide.doc));

    const finalIds = new Set(final.slides.map((slide) => slide.id));
    const structural = final.slides.some((slide) => !byId.has(slide.id)) || info.slides.some((slide) => !finalIds.has(slide.id));
    if (!structural) return touched.size ? info.pkg.toBytes() : bytes;

    const list = findDeep(info.presentation.root, "sldIdLst");
    if (!list) throw new LiveDocumentCodecError("pptx_slide_list_missing");
    const usedIds = info.slides.map((slide) => Number(attr(slide.sldId, "id") ?? 256));
    let nextSldId = Math.max(255, ...usedIds) + 1;
    const relIds = new Set(elements(info.rels.root).map((rel) => attr(rel, "Id")));
    let nextPart = Math.max(0, ...info.pkg.names().map((name) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0))) + 1;
    let ct = info.pkg.text("[Content_Types].xml") ?? "";
    const entries: XmlElement[] = [];
    let previous: SlideInfo | undefined;
    for (const slide of final.slides) {
      const source = byId.get(slide.id);
      if (source) { entries.push(source.sldId); previous = source; continue; }
      const layout = chooseLayout(info, previous);
      const part = `ppt/slides/slide${nextPart++}.xml`;
      info.pkg.setText(part, newSlideXml(slide, info));
      info.pkg.setText(relsPathFor(part), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}">${layout ? `<Relationship Id="rId1" Type="${REL_LAYOUT}" Target="${escapeXmlAttr(relativeTarget(part, layout))}"/>` : ""}</Relationships>`);
      ct = ct.replace("</Types>", `<Override PartName="/${part}" ContentType="${CT_SLIDE}"/></Types>`);
      let r = 1;
      while (relIds.has(`rId${r}`)) r++;
      relIds.add(`rId${r}`);
      info.rels.root.children.push(createElement(`<Relationship Id="rId${r}" Type="${REL_SLIDE}" Target="${escapeXmlAttr(relativeTarget(PRESENTATION, part))}"/>`));
      const prefix = list.name.includes(":") ? `${list.name.split(":")[0]}:` : "";
      const declareR = /\sxmlns:r=/.test(info.presentation.root.attrs) ? "" : ` xmlns:r="${REL}"`;
      entries.push(createElement(`<${prefix}sldId${declareR} id="${nextSldId++}" r:id="rId${r}"/>`));
    }
    info.pkg.setText("[Content_Types].xml", ct);
    for (const slide of info.slides) {
      if (finalIds.has(slide.id)) continue;
      info.rels.root.children = info.rels.root.children.filter((node) => node.type !== "el" || attr(node, "Id") !== slide.rid);
      removeSlideParts(info, slide);
    }
    list.children = entries;
    markDirty(list, info.rels.root);
    markPath(info.presentation.root, list);
    info.pkg.setText(PRESENTATION, serializeXml(info.presentation));
    info.pkg.setText(relsPathFor(PRESENTATION), serializeXml(info.rels));
    return info.pkg.toBytes();
  },
};
