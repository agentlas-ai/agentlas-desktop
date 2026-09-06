// DOCX renderer for Science manuscripts.
//
// Journals still ask for Word files, and co-authors edit in Word. This writes a
// real WordprocessingML package with fflate (no docx library dependency):
// title block with affiliation superscripts, abstract, numbered headings,
// paragraphs with bold/italic/code runs, bullet and numbered lists via
// numbering.xml, editable tables (w:tbl) built from the exact artifact rows,
// inline figures (w:drawing + media relationships) with numbered captions,
// display equations as OMML when the expression is simple enough to convert,
// otherwise as a LaTeX literal run (never silently dropped), and a numbered
// reference list. Everything is deterministic for the same input bytes.

import { strToU8, zipSync } from "fflate";
import { SCIENCE_MANUSCRIPT_COLOURS } from "../../../shared/science-manuscript-colours";
import { scienceTextSegments } from "../../../shared/science-exponent-text";
import type { ScienceManuscriptLayoutSpec, ScienceSubmissionMetadata } from "../../../shared/science-contract";
import { citationMarker, formatReference, orderReferences, type BibliographyStyle, type FormattedReference } from "./bibliography";
import type { RasterAsset, ResolvedManuscriptAssets, ResolvedTable } from "./assets";
import { formatCell } from "./render-html";
import { inlineToPlainText, type BlockNode, type InlineNode, type ManuscriptDocument } from "./document-model";
import type { ScienceManuscriptDraftBoundary } from "./journal-render-profile";

export interface DocxRenderOptions {
  style: BibliographyStyle;
  metadata: ScienceSubmissionMetadata | null;
  /** PNG bytes per figure locator (SVG figures must be rasterized by the packager before calling). */
  figureRasters: Map<string, RasterAsset>;
  layout: ScienceManuscriptLayoutSpec;
  draftBoundary?: ScienceManuscriptDraftBoundary | null;
}

export interface DocxRenderResult {
  bytes: Uint8Array;
  references: FormattedReference[];
  /** Equations that could not be converted to OMML and were emitted as LaTeX text. */
  equationFallbacks: string[];
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const EMU_PER_INCH = 914_400;
const MM_PER_INCH = 25.4;
const TWIPS_PER_MM = 1440 / MM_PER_INCH;

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

interface RunStyle { bold?: boolean; italic?: boolean; code?: boolean; superscript?: boolean; color?: string; size?: number }

function run(text: string, style: RunStyle = {}): string {
  const props: string[] = [];
  if (style.bold) props.push("<w:b/>");
  if (style.italic) props.push("<w:i/>");
  if (style.code) props.push("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/>");
  if (style.superscript) props.push("<w:vertAlign w:val=\"superscript\"/>");
  if (style.color) props.push(`<w:color w:val="${style.color}"/>`);
  if (style.size) props.push(`<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  const parts = text.split("\n");
  return parts.map((part, index) => `<w:r>${rPr}${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`).join("");
}

/**
 * A run whose caret exponents are raised, for text that carries units.
 *
 * A table cell reading `angstrom^3` next to a figure axis reading `angstrom³` tells the reader
 * the two are different quantities. See shared/science-exponent-text.ts.
 */
function unitRun(text: string, style: RunStyle = {}): string {
  return scienceTextSegments(text)
    .map((segment) => run(segment.text, segment.superscript ? { ...style, superscript: true } : style))
    .join("");
}

function paragraph(inner: string, props = ""): string { return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`; }

/** Converts a bounded subset of LaTeX to OMML. Returns null when the expression uses anything outside the subset. */
export function latexToOmml(tex: string): string | null {
  type Node = string;
  let position = 0;
  const source = tex.replace(/\\,|\\;|\\!|\\quad|\\qquad|\\ /g, " ").replace(/\\left|\\right/g, "");
  const GREEK: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", infty: "∞", pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", propto: "∝", partial: "∂", nabla: "∇", rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", in: "∈", subset: "⊂", cup: "∪", cap: "∩", forall: "∀", exists: "∃", ldots: "…", cdots: "⋯", prime: "′", hbar: "ℏ", ell: "ℓ", degree: "°" };
  const FUNCTIONS = new Set(["sin", "cos", "tan", "log", "ln", "exp", "max", "min", "arg", "det", "lim", "sup", "inf", "sinh", "cosh", "tanh", "sec", "csc", "cot"]);
  const text = (value: string) => `<m:r><m:t xml:space="preserve">${xmlEscape(value)}</m:t></m:r>`;
  const peek = () => source[position];
  const parseGroup = (): Node[] | null => {
    if (peek() !== "{") { const single = parseAtom(); return single === null ? null : [single]; }
    position += 1;
    const nodes: Node[] = [];
    while (position < source.length && peek() !== "}") { const node = parseAtom(); if (node === null) return null; nodes.push(node); }
    if (peek() !== "}") return null;
    position += 1;
    return nodes;
  };
  const parseAtom = (): Node | null => {
    const char = peek();
    if (char === undefined) return null;
    if (char === " ") { position += 1; return text(" "); }
    if (char === "\\") {
      const match = /^\\([A-Za-z]+|.)/.exec(source.slice(position));
      if (!match) return null;
      position += match[0].length;
      const name = match[1];
      if (name === "frac") { const num = parseGroup(); const den = parseGroup(); if (!num || !den) return null; return `<m:f><m:num>${num.join("")}</m:num><m:den>${den.join("")}</m:den></m:f>`; }
      if (name === "sqrt") { const body = parseGroup(); if (!body) return null; return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${body.join("")}</m:e></m:rad>`; }
      if (name === "sum" || name === "prod" || name === "int") {
        const symbol = name === "sum" ? "∑" : name === "prod" ? "∏" : "∫";
        let sub = "", sup = "";
        while (peek() === "_" || peek() === "^") { const marker = peek(); position += 1; const group = parseGroup(); if (!group) return null; if (marker === "_") sub = group.join(""); else sup = group.join(""); }
        const body = parseAtom();
        return `<m:nary><m:naryPr><m:chr m:val="${symbol}"/><m:limLoc m:val="${name === "int" ? "subSup" : "undOvr"}"/></m:naryPr><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup><m:e>${body ?? ""}</m:e></m:nary>`;
      }
      if (name === "hat" || name === "bar" || name === "vec" || name === "tilde" || name === "dot") {
        const body = parseGroup(); if (!body) return null;
        const chr = name === "hat" ? "̂" : name === "bar" ? "̄" : name === "vec" ? "⃗" : name === "tilde" ? "̃" : "̇";
        return `<m:acc><m:accPr><m:chr m:val="${chr}"/></m:accPr><m:e>${body.join("")}</m:e></m:acc>`;
      }
      if (name === "mathrm" || name === "text" || name === "mathbf" || name === "operatorname" || name === "textrm") { const body = parseGroup(); if (!body) return null; return `<m:r><m:rPr><m:sty m:val="${name === "mathbf" ? "b" : "p"}"/></m:rPr><m:t xml:space="preserve">${xmlEscape(rawText(body))}</m:t></m:r>`; }
      if (name === "{" || name === "}" || name === "%" || name === "&" || name === "#" || name === "_") return text(name);
      if (GREEK[name]) return text(GREEK[name]);
      if (FUNCTIONS.has(name)) return `<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>${name}</m:t></m:r>`;
      return null;
    }
    if (char === "{") { const group = parseGroup(); return group ? group.join("") : null; }
    if (char === "}") return null;
    if (char === "^" || char === "_") {
      // Script attached to the previous atom; handled by the caller loop.
      return null;
    }
    position += 1;
    return text(char);
  };
  const rawText = (nodes: Node[]) => nodes.map((node) => node.replace(/<[^>]+>/g, "")).join("");
  const parseSequence = (): string | null => {
    const output: Node[] = [];
    while (position < source.length) {
      if (peek() === "}") return null;
      if (peek() === "^" || peek() === "_") {
        const base = output.pop();
        if (base === undefined) return null;
        let sub = "", sup = "";
        while (peek() === "^" || peek() === "_") { const marker = peek(); position += 1; const group = parseGroup(); if (!group) return null; if (marker === "_") sub = group.join(""); else sup = group.join(""); }
        if (sub && sup) output.push(`<m:sSubSup><m:e>${base}</m:e><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup></m:sSubSup>`);
        else if (sub) output.push(`<m:sSub><m:e>${base}</m:e><m:sub>${sub}</m:sub></m:sSub>`);
        else output.push(`<m:sSup><m:e>${base}</m:e><m:sup>${sup}</m:sup></m:sSup>`);
        continue;
      }
      const atom = parseAtom();
      if (atom === null) return null;
      output.push(atom);
    }
    return output.join("");
  };
  try {
    const body = parseSequence();
    if (body === null || position < source.length) return null;
    return body;
  } catch { return null; }
}

class DocxWriter {
  readonly relationships: Array<{ id: string; type: string; target: string }> = [];
  readonly media: Array<{ name: string; bytes: Uint8Array; contentType: string }> = [];
  readonly equationFallbacks: string[] = [];
  private drawingId = 1;
  constructor(private readonly doc: ManuscriptDocument, private readonly assets: ResolvedManuscriptAssets, private readonly options: DocxRenderOptions) {}

  private textWidthEmu(): number {
    const pageWidthMm = this.options.layout.pageSize === "letter" ? 215.9 : 210;
    return Math.round(Math.max(60, pageWidthMm - this.options.layout.marginsMm.left - this.options.layout.marginsMm.right) / MM_PER_INCH * EMU_PER_INCH);
  }

  private citationEntries(locators: string[]) {
    return locators.map((locator) => {
      const resolved = this.assets.citations.get(locator);
      const ordinal = this.doc.citations.find((item) => item.locator === locator)?.ordinal ?? 0;
      return resolved ? { ...resolved.entry, ordinal } : { locator, ordinal, title: locator, authors: [], year: null, containerTitle: null, publisher: null, canonicalUri: "", kind: "unknown", doi: null, unresolved: true };
    });
  }

  inline(nodes: InlineNode[], style: RunStyle = {}): string {
    return nodes.map((node) => {
      switch (node.kind) {
        // Prose carries units too; raise the exponent as the table does.
        case "text": return unitRun(node.text, style);
        case "strong": return this.inline(node.children, { ...style, bold: true });
        case "emphasis": return this.inline(node.children, { ...style, italic: true });
        case "code": return run(node.text, { ...style, code: true });
        case "link": return `<w:hyperlink r:id="${this.hyperlink(node.href)}">${this.inline(node.children, { ...style, color: SCIENCE_MANUSCRIPT_COLOURS.link })}</w:hyperlink>`;
        case "math": { const omml = latexToOmml(node.tex); if (omml) return `<m:oMath>${omml}</m:oMath>`; this.equationFallbacks.push(node.tex); return run(`$${node.tex}$`, { ...style, code: true }); }
        case "cite": {
          const marker = citationMarker(this.citationEntries(node.locators), this.options.style);
          return run(marker, { ...style, superscript: this.options.style === "nature" });
        }
        case "ref": {
          const label = node.target === "fig" ? "Figure" : node.target === "tab" ? "Table" : node.target === "eq" ? "Eq." : "Section";
          return run(node.number ? `${label} ${node.number}` : `${label} ??`, style);
        }
        case "break": return "<w:r><w:br/></w:r>";
        default: return "";
      }
    }).join("");
  }

  private hyperlink(href: string): string {
    const id = `rId${this.relationships.length + 10}`;
    this.relationships.push({ id, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", target: href });
    return id;
  }

  private image(raster: RasterAsset, alt: string): string {
    const extension = raster.mimeType === "image/jpeg" ? "jpeg" : raster.mimeType === "image/webp" ? "webp" : "png";
    const name = `image${this.media.length + 1}.${extension}`;
    this.media.push({ name, bytes: raster.bytes, contentType: raster.mimeType });
    const id = `rId${this.relationships.length + 10}`;
    this.relationships.push({ id, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", target: `media/${name}` });
    const width = raster.width > 0 ? raster.width : 1200;
    const height = raster.height > 0 ? raster.height : 800;
    const cx = Math.min(this.textWidthEmu(), Math.round(width / 300 * EMU_PER_INCH));
    const cy = Math.round(cx * height / width);
    const drawingId = this.drawingId++;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="${xmlEscape(alt).slice(0, 60)}" descr="${xmlEscape(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${xmlEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  private table(table: ResolvedTable): string {
    const columns = table.columns;
    const gridWidth = Math.floor(this.textWidthEmu() / EMU_PER_INCH * 1440 / Math.max(columns.length, 1));
    const cell = (content: string, header: boolean, numeric: boolean, bottom: boolean) => {
      const borders = `<w:tcBorders>${header ? "<w:top w:val=\"single\" w:sz=\"12\" w:space=\"0\" w:color=\"000000\"/><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"0\" w:color=\"000000\"/>" : bottom ? "<w:bottom w:val=\"single\" w:sz=\"12\" w:space=\"0\" w:color=\"000000\"/>" : ""}</w:tcBorders>`;
      return `<w:tc><w:tcPr><w:tcW w:w="${gridWidth}" w:type="dxa"/>${borders}</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/>${numeric ? "<w:jc w:val=\"right\"/>" : ""}</w:pPr>${content}</w:p></w:tc>`;
    };
    const rows = table.rows.slice(0, 5_000);
    const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map((column) => cell(unitRun(column.label, { bold: true, size: 18 }), true, column.type === "number" || column.type === "integer", false)).join("")}</w:tr>`;
    const bodyRows = rows.map((row, index) => `<w:tr>${columns.map((column) => cell(unitRun(formatCell(row[column.key] ?? null, column.type), { size: 18 }), false, column.type === "number" || column.type === "integer", index === rows.length - 1)).join("")}</w:tr>`).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${columns.map(() => `<w:gridCol w:w="${gridWidth}"/>`).join("")}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`;
  }

  private captionParagraph(label: string, number: number, caption: InlineNode[], fallback: string): string {
    return paragraph(`${run(`${label} ${number}. `, { bold: true, size: 20 })}${caption.length ? this.inline(caption, { size: 20 }) : run(fallback, { size: 20 })}`, "<w:pStyle w:val=\"Caption\"/><w:keepNext/>");
  }

  block(node: BlockNode): string {
    switch (node.kind) {
      case "heading": {
        const styleId = `Heading${Math.min(Math.max(node.level, 1), 4)}`;
        const number = node.number ? run(`${node.number} `) : "";
        return paragraph(`${number}${this.inline(node.children)}`, `<w:pStyle w:val="${styleId}"/>`);
      }
      case "paragraph": return paragraph(this.inline(node.children));
      case "list": {
        const numId = node.ordered ? 2 : 1;
        return node.items.map((item) => item.children.map((child, index) => {
          if (child.kind === "paragraph" && index === 0) return paragraph(this.inline(child.children), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
          return this.block(child);
        }).join("")).join("");
      }
      case "blockquote": return node.children.map((child) => child.kind === "paragraph" ? paragraph(this.inline(child.children, { italic: true }), "<w:ind w:left=\"567\"/>") : this.block(child)).join("");
      case "code": return paragraph(run(node.text, { code: true, size: 18 }), "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/>");
      case "rule": return paragraph("", "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"999999\"/></w:pBdr>");
      case "math": {
        const omml = latexToOmml(node.tex);
        const numberRun = node.number ? run(`\t(${node.number})`) : "";
        if (omml) return `<w:p><w:pPr><w:jc w:val="center"/><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr><m:oMathPara><m:oMath>${omml}</m:oMath></m:oMathPara>${numberRun}</w:p>`;
        this.equationFallbacks.push(node.tex);
        return paragraph(`${run(`$$ ${node.tex} $$`, { code: true })}${numberRun}`, "<w:jc w:val=\"center\"/><w:tabs><w:tab w:val=\"right\" w:pos=\"9000\"/></w:tabs>");
      }
      case "figure": {
        const raster = this.options.figureRasters.get(node.locator);
        const figure = this.assets.figures.get(node.locator);
        const body = raster ? paragraph(this.image(raster, figure?.title ?? node.locator), "<w:jc w:val=\"center\"/><w:keepNext/>") : paragraph(run(`[Missing figure asset: ${node.locator}]`, { italic: true, color: SCIENCE_MANUSCRIPT_COLOURS.absence }), "<w:jc w:val=\"center\"/>");
        return body + this.captionParagraph("Figure", node.number, node.caption, figure?.title ?? node.locator);
      }
      case "bound-table": {
        const table = this.assets.tables.get(node.locator);
        const caption = this.captionParagraph("Table", node.number, node.caption, table?.caption ?? table?.title ?? node.locator);
        if (!table || !table.editable || !table.columns.length) {
          const raster = table?.raster ?? this.options.figureRasters.get(`table:${node.locator}`);
          const body = raster ? paragraph(this.image(raster, table?.title ?? node.locator), "<w:jc w:val=\"center\"/>") : paragraph(run(`[Missing table asset: ${node.locator}]`, { italic: true, color: SCIENCE_MANUSCRIPT_COLOURS.absence }));
          return caption + body;
        }
        const notes = table.notes.length ? paragraph(run(table.notes.join(" "), { size: 17 })) : "";
        return caption + this.table(table) + notes + paragraph("");
      }
      case "table": {
        const columns = node.header.map((cell, index) => ({ key: String(index), label: inlineToPlainText(cell), type: "string" as const }));
        const rows = node.rows.map((row) => Object.fromEntries(row.map((cell, index) => [String(index), inlineToPlainText(cell)])));
        const caption = node.number ? this.captionParagraph("Table", node.number, node.caption ?? [], "") : "";
        return caption + this.table({ role: "table", locator: node.key ?? "", ordinal: 0, title: "", caption: null, columns, rows, notes: [], raster: null, editable: true, provenance: {} }) + paragraph("");
      }
      default: return "";
    }
  }

  titleBlock(): string {
    const metadata = this.options.metadata;
    const parts: string[] = [paragraph(run(this.doc.title || "Untitled manuscript", { bold: true, size: 32 }), "<w:pStyle w:val=\"Title\"/><w:jc w:val=\"center\"/>")];
    if (metadata?.authors.length) {
      const affiliations: string[] = [];
      const affiliationIndex = (affiliation: string) => { let index = affiliations.indexOf(affiliation); if (index < 0) { affiliations.push(affiliation); index = affiliations.length - 1; } return index + 1; };
      const authorRuns = metadata.authors.map((author, index) => `${index ? run(", ") : ""}${run(author.name)}${run(`${author.affiliations.map(affiliationIndex).join(",")}${author.corresponding ? "*" : ""}`, { superscript: true })}`).join("");
      parts.push(paragraph(authorRuns, "<w:jc w:val=\"center\"/>"));
      affiliations.forEach((affiliation, index) => parts.push(paragraph(`${run(String(index + 1), { superscript: true })}${run(affiliation, { size: 19 })}`, "<w:jc w:val=\"center\"/><w:spacing w:after=\"0\"/>")));
      const corresponding = metadata.authors.filter((author) => author.corresponding && author.email);
      if (corresponding.length) parts.push(paragraph(run(`* Correspondence: ${corresponding.map((author) => `${author.name} (${author.email})`).join("; ")}`, { size: 18 }), "<w:jc w:val=\"center\"/>"));
    }
    return parts.join("");
  }

  abstractBlock(): string {
    if (!this.doc.abstract.length && !this.doc.keywords.length) return "";
    const parts = [paragraph(run("Abstract", { bold: true }), "<w:pStyle w:val=\"Heading1\"/>")];
    parts.push(...this.doc.abstract.map((block) => this.block(block)));
    if (this.doc.keywords.length) parts.push(paragraph(`${run("Keywords: ", { bold: true })}${run(this.doc.keywords.join("; "))}`));
    return parts.join("");
  }

  statementsBlock(): string {
    const metadata = this.options.metadata;
    if (!metadata) return "";
    const statements: Array<[string, string | null]> = [
      ["Data availability", metadata.dataAvailabilityStatement], ["Code availability", metadata.codeAvailabilityStatement], ["Author contributions", metadata.authorContributionsStatement],
      ["Funding", metadata.fundingStatement], ["Competing interests", metadata.competingInterestsStatement], ["Ethics", metadata.ethicsStatement],
    ];
    return statements.filter(([, text]) => text).map(([heading, text]) => paragraph(run(heading), "<w:pStyle w:val=\"Heading1\"/>") + paragraph(run(text!))).join("");
  }

  referencesBlock(): { xml: string; references: FormattedReference[] } {
    const entries = this.doc.citations.map((citation) => {
      const resolved = this.assets.citations.get(citation.locator);
      return resolved ? { ...resolved.entry, ordinal: citation.ordinal } : { locator: citation.locator, ordinal: citation.ordinal, title: citation.locator, authors: [], year: null, containerTitle: null, publisher: null, canonicalUri: "", kind: "unknown", doi: null, unresolved: true };
    });
    if (!entries.length) return { xml: "", references: [] };
    const references = orderReferences(entries, this.options.style).map((entry) => formatReference(entry, this.options.style));
    const hasHeading = this.doc.headings.some((heading) => heading.role === "references");
    const heading = hasHeading ? "" : paragraph(run("References"), "<w:pStyle w:val=\"Heading1\"/>");
    const items = references.map((reference) => {
      const prefix = this.options.style === "apa" ? "" : `${reference.ordinal}. `;
      return paragraph(run(`${prefix}${reference.text}`, { size: 20 }), "<w:ind w:left=\"567\" w:hanging=\"567\"/><w:spacing w:after=\"80\"/>");
    }).join("");
    return { xml: heading + items, references };
  }
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="FONT_FAMILY" w:hAnsi="FONT_FAMILY" w:eastAsia="Malgun Gothic" w:cs="FONT_FAMILY"/><w:sz w:val="FONT_SIZE"/><w:szCs w:val="FONT_SIZE"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="LINE_SPACING" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:jc w:val="left"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:jc w:val="left"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="60" w:after="200"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

export function renderManuscriptDocx(doc: ManuscriptDocument, assets: ResolvedManuscriptAssets, options: DocxRenderOptions): DocxRenderResult {
  const writer = new DocxWriter(doc, assets, options);
  const layout = options.layout;
  const pageSize = layout.pageSize === "letter" ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 };
  const margins = Object.fromEntries(Object.entries(layout.marginsMm).map(([key, value]) => [key, Math.round(value * TWIPS_PER_MM)])) as Record<"top" | "right" | "bottom" | "left", number>;
  const columns = layout.columnCount ?? 1;
  const columnSpace = Math.round((layout.columnGapMm ?? 7) * TWIPS_PER_MM);
  const sectionProperties = (columnCount: 1 | 2, type: "continuous" | null = null) => `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ""}${layout.lineNumbers ? "<w:lnNumType w:countBy=\"1\" w:restart=\"continuous\"/>" : ""}<w:cols w:num="${columnCount}" w:space="${columnSpace}"/><w:pgSz w:w="${pageSize.width}" w:h="${pageSize.height}"/><w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  const frontMatterBreak = columns === 2
    ? paragraph("", sectionProperties(1, "continuous"))
    : "";
  const titlePageBreak = layout.titlePageMode === "separate"
    ? paragraph("<w:r><w:br w:type=\"page\"/></w:r>")
    : "";
  const draftBoundary = options.draftBoundary
    ? paragraph(run("DRAFT — NOT FOR SUBMISSION", { bold: true, size: 20 }), "<w:jc w:val=\"center\"/><w:spacing w:after=\"160\"/>")
    : "";
  const bodyParts = [writer.titleBlock(), draftBoundary, titlePageBreak, writer.abstractBlock(), frontMatterBreak, ...doc.body.map((block) => writer.block(block)), writer.statementsBlock()];
  const references = writer.referencesBlock();
  bodyParts.push(references.xml);
  const sectPr = sectionProperties(columns);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:m="${M}"><w:body>${bodyParts.join("")}${sectPr}</w:body></w:document>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${writer.relationships.map((relationship) => `<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${xmlEscape(relationship.target)}"${relationship.type.endsWith("/hyperlink") ? " TargetMode=\"External\"" : ""}/>`).join("")}</Relationships>`;
  const mediaDefaults = [...new Set(writer.media.map((item) => item.name.split(".").pop()!))].map((extension) => `<Default Extension="${extension}" ContentType="${extension === "png" ? "image/png" : extension === "jpeg" ? "image/jpeg" : "image/webp"}"/>`).join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const keywords = [...doc.keywords, ...(options.draftBoundary ? [options.draftBoundary.machineReadableToken] : [])];
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(doc.title || "Untitled manuscript")}</dc:title><dc:creator>${xmlEscape(options.metadata?.authors.map((author) => author.name).join("; ") ?? "")}</dc:creator><dc:subject>${xmlEscape(options.draftBoundary ? `Agentlas draft ${options.draftBoundary.machineReadableToken}; manuscript sha256 ${options.draftBoundary.manuscriptContentSha256}; journal profile ${options.draftBoundary.journalProfileId ?? "none"}@${options.draftBoundary.journalProfileVersion ?? "none"}; profile sha256 ${options.draftBoundary.journalProfileContentSha256 ?? "none"}` : "Agentlas manuscript ready")}</dc:subject><cp:keywords>${xmlEscape(keywords.join("; "))}</cp:keywords></cp:coreProperties>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "docProps/core.xml": strToU8(core),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(STYLES
      .replaceAll("FONT_FAMILY", layout.fontFamily === "sans-serif" ? "Arial" : "Times New Roman")
      .replaceAll("FONT_SIZE", String(layout.fontSizePt * 2))
      .replace("LINE_SPACING", layout.lineSpacing === "double" ? "480" : layout.lineSpacing === "one-and-half" ? "360" : "240")),
    "word/numbering.xml": strToU8(NUMBERING),
    "word/_rels/document.xml.rels": strToU8(documentRels),
  };
  for (const item of writer.media) files[`word/media/${item.name}`] = item.bytes;
  // Deterministic archive: fixed modification time for every entry.
  const bytes = zipSync(files, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") });
  return { bytes, references: references.references, equationFallbacks: writer.equationFallbacks };
}
