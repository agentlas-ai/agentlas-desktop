// HTML renderer for Science manuscripts.
//
// One HTML renderer serves three consumers: the in-app manuscript preview, the
// Chromium print-to-PDF path (always available inside Electron, no external
// toolchain), and the journal-upload HTML copy. Math is rendered by KaTeX to
// MathML so no web fonts have to be embedded; Chromium's MathML Core renders it
// natively. Figures are embedded as data URLs from the verified bytes; tables
// are real <table> elements built from the exact artifact rows so they stay
// selectable, copyable, and — in the preview — editable.

import katex from "katex";
import { scienceTextSegments } from "../../../shared/science-exponent-text";
import { manuscriptColourCss } from "../../../shared/science-manuscript-colours";
import type { ScienceManuscriptLayoutSpec, ScienceSubmissionMetadata } from "../../../shared/science-contract";
import { citationMarker, formatReference, orderReferences, type BibliographyStyle, type FormattedReference } from "./bibliography";
import type { ResolvedManuscriptAssets, ResolvedTable, TableCell } from "./assets";
import { inlineToPlainText, type BlockNode, type InlineNode, type ManuscriptDocument } from "./document-model";
import type { ScienceManuscriptDraftBoundary } from "./journal-render-profile";

export interface HtmlRenderOptions {
  style: BibliographyStyle;
  /** "preview" adds editing hooks; "print" adds page rules for PDF. */
  mode: "preview" | "print";
  metadata: ScienceSubmissionMetadata | null;
  /** When false, figures render as placeholders that name the locator (fast preview without bytes). */
  embedAssets: boolean;
  layout: ScienceManuscriptLayoutSpec;
  draftBoundary?: ScienceManuscriptDraftBoundary | null;
  /** Language hint for hyphenation and quotes. */
  lang?: string;
}

export interface HtmlRenderResult {
  html: string;
  bodyHtml: string;
  css: string;
  references: FormattedReference[];
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Escapes text for HTML and raises a caret exponent into a real superscript.
 *
 * Used for table cells and column headers, where units live. See shared/science-exponent-text.ts
 * for why every presentation surface has to do this the same way.
 */
export function escapeHtmlWithExponents(value: string): string {
  return scienceTextSegments(value)
    .map((segment) => (segment.superscript ? `<sup>${escapeHtml(segment.text)}</sup>` : escapeHtml(segment.text)))
    .join("");
}

function base64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }

export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, output: "mathml", throwOnError: true, strict: "ignore", trust: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `<code class="manuscriptPaperMathError" title="${escapeHtml(reason)}">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  }
}

export function formatCell(value: TableCell, type: string): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (type === "integer" || Number.isInteger(value)) return String(value);
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e6)) return value.toExponential(3);
    return String(Number(value.toPrecision(6)));
  }
  return value;
}


/**
 * How one COLUMN of numbers is written, decided once for the whole column.
 *
 * `formatCell` sees one value at a time, so an integer-valued number comes out bare: a magnitude
 * column printed 2.9, then 3, then 3.1, and a fitted column mixed 0.988862 with 0.0928959. Down a
 * printed column that reads as three different quantities, and it is the first thing a reviewer
 * catches. A column is a single measurement, so its decimals are a property of the column.
 *
 * Only real, finite, non-integer-typed numbers participate. A column of counts keeps its integers,
 * a text column is untouched, and a column that mixes text and numbers falls back to per-cell
 * formatting rather than inventing a shape for it.
 */
export function formatColumnCells(values: readonly TableCell[], type: string): string[] {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const usesColumnScale = type !== "integer"
    && numeric.length > 0
    && numeric.length === values.filter((value) => value !== null && typeof value !== "boolean").length
    && numeric.some((value) => !Number.isInteger(value))
    && numeric.every((value) => Math.abs(value) === 0 || (Math.abs(value) >= 1e-4 && Math.abs(value) < 1e6));
  if (!usesColumnScale) return values.map((value) => formatCell(value, type));
  // The decimals the widest cell needs, so no value in the column loses precision to its neighbours.
  const decimals = Math.min(6, Math.max(...numeric.map((value) => {
    const text = String(Number(value.toPrecision(6)));
    const dot = text.indexOf(".");
    return dot < 0 ? 0 : text.length - dot - 1;
  })));
  return values.map((value) => (typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(decimals)
    : formatCell(value, type)));
}

class HtmlWriter {
  readonly warnings: string[] = [];
  constructor(private readonly doc: ManuscriptDocument, private readonly assets: ResolvedManuscriptAssets, private readonly options: HtmlRenderOptions) {}

  private citationEntries(locators: string[]) {
    return locators.map((locator) => {
      const resolved = this.assets.citations.get(locator);
      const ordinal = this.doc.citations.find((item) => item.locator === locator)?.ordinal ?? 0;
      return resolved ? { ...resolved.entry, ordinal } : { locator, ordinal, title: locator, authors: [], year: null, containerTitle: null, publisher: null, canonicalUri: "", kind: "unknown", doi: null, unresolved: true };
    });
  }

  inline(nodes: InlineNode[]): string {
    return nodes.map((node) => {
      switch (node.kind) {
        // Prose carries units too ("a cell volume of 23.4 angstrom^3"), and it must raise the
        // exponent the same way the table beside it does.
        case "text": return escapeHtmlWithExponents(node.text);
        case "strong": return `<strong>${this.inline(node.children)}</strong>`;
        case "emphasis": return `<em>${this.inline(node.children)}</em>`;
        case "code": return `<code>${escapeHtml(node.text)}</code>`;
        case "link": return `<a href="${escapeHtml(node.href)}" rel="noreferrer">${this.inline(node.children)}</a>`;
        case "math": return renderMath(node.tex, false);
        case "cite": {
          const entries = this.citationEntries(node.locators);
          const marker = citationMarker(entries, this.options.style);
          const unresolved = entries.some((entry) => entry.unresolved);
          const body = this.options.style === "nature" ? `<sup>${escapeHtml(marker)}</sup>` : escapeHtml(marker);
          return `<a class="manuscriptPaperCite${unresolved ? " isUnresolved" : ""}" href="#ref-${escapeHtml(node.locators[0])}" data-cite="${escapeHtml(node.locators.join(";"))}">${body}</a>`;
        }
        case "ref": {
          const label = node.target === "fig" ? "Figure" : node.target === "tab" ? "Table" : node.target === "eq" ? "Eq." : "Section";
          const text = node.number ? `${label} ${node.number}` : `${label} ??`;
          return `<a class="manuscriptPaperRef${node.number ? "" : " isUnresolved"}" href="#${node.target}-${escapeHtml(node.key)}">${escapeHtml(text)}</a>`;
        }
        case "break": return "<br>";
        default: return "";
      }
    }).join("");
  }

  private figureMarkup(locator: string, number: number, caption: InlineNode[]): string {
    const figure = this.assets.figures.get(locator);
    const captionHtml = `<figcaption><span class="manuscriptPaperLabel">Figure ${number}.</span> ${this.inline(caption) || escapeHtml(figure?.title ?? "")}</figcaption>`;
    if (!figure || (!figure.svg && !figure.raster)) {
      return `<figure class="manuscriptPaperFigure isMissing" id="fig-${escapeHtml(locator)}" data-locator="${escapeHtml(locator)}"><div class="manuscriptPaperFigureMissing">Figure asset “${escapeHtml(locator)}” is not bound to a verified artifact capture.</div>${captionHtml}</figure>`;
    }
    let img: string;
    if (!this.options.embedAssets) {
      img = `<div class="manuscriptPaperFigurePlaceholder">${escapeHtml(figure.title)}</div>`;
    } else if (figure.svg) {
      img = `<img alt="${escapeHtml(figure.title)}" src="data:image/svg+xml;base64,${base64(figure.svg.bytes)}">`;
    } else {
      const raster = figure.raster!;
      img = `<img alt="${escapeHtml(figure.title)}" width="${raster.width}" height="${raster.height}" src="data:${raster.mimeType};base64,${base64(raster.bytes)}">`;
    }
    const provenance = escapeHtml(JSON.stringify(figure.provenance));
    return `<figure class="manuscriptPaperFigure" id="fig-${escapeHtml(locator)}" data-locator="${escapeHtml(locator)}" data-provenance="${provenance}">${img}${captionHtml}</figure>`;
  }

  private tableRows(table: ResolvedTable): string {
    const rows = table.rows.slice(0, 5_000);
    const header = `<thead><tr>${table.columns.map((column) => `<th scope="col" data-type="${column.type}">${escapeHtmlWithExponents(column.label)}</th>`).join("")}</tr></thead>`;
    const body = `<tbody>${rows.map((row) => `<tr>${table.columns.map((column) => `<td data-type="${column.type}"${column.type === "number" || column.type === "integer" ? " class=\"isNumeric\"" : ""}>${escapeHtmlWithExponents(formatCell(row[column.key] ?? null, column.type))}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return header + body;
  }

  private boundTableMarkup(locator: string, number: number, caption: InlineNode[]): string {
    const table = this.assets.tables.get(locator);
    const captionText = this.inline(caption) || escapeHtml(table?.caption ?? table?.title ?? "");
    const captionHtml = `<caption><span class="manuscriptPaperLabel">Table ${number}.</span> ${captionText}</caption>`;
    if (!table) {
      return `<div class="manuscriptPaperTableWrap isMissing" id="tab-${escapeHtml(locator)}"><table class="manuscriptPaperTable">${captionHtml}<tbody><tr><td>Table asset “${escapeHtml(locator)}” is not bound to a verified artifact.</td></tr></tbody></table></div>`;
    }
    const provenance = escapeHtml(JSON.stringify(table.provenance));
    if (!table.editable || !table.columns.length) {
      const image = table.raster && this.options.embedAssets ? `<img alt="${escapeHtml(table.title)}" src="data:${table.raster.mimeType};base64,${base64(table.raster.bytes)}">` : `<div class="manuscriptPaperFigurePlaceholder">${escapeHtml(table.title)}</div>`;
      return `<figure class="manuscriptPaperTableImage" id="tab-${escapeHtml(locator)}" data-locator="${escapeHtml(locator)}" data-provenance="${provenance}">${image}<figcaption><span class="manuscriptPaperLabel">Table ${number}.</span> ${captionText}</figcaption></figure>`;
    }
    const notes = table.notes.length ? `<div class="manuscriptPaperTableNotes">${table.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}</div>` : "";
    const editable = this.options.mode === "preview" ? " data-editable=\"true\"" : "";
    return `<div class="manuscriptPaperTableWrap" id="tab-${escapeHtml(locator)}" data-locator="${escapeHtml(locator)}" data-provenance="${provenance}"${editable}><table class="manuscriptPaperTable">${captionHtml}${this.tableRows(table)}</table>${notes}</div>`;
  }

  block(node: BlockNode): string {
    switch (node.kind) {
      case "heading": {
        const number = node.number ? `<span class="manuscriptPaperHeadingNumber">${escapeHtml(node.number)}</span> ` : "";
        return `<h${node.level} id="sec-${escapeHtml(node.slug)}" data-role="${node.role}">${number}${this.inline(node.children)}</h${node.level}>`;
      }
      case "paragraph": return `<p>${this.inline(node.children)}</p>`;
      case "list": {
        const tag = node.ordered ? "ol" : "ul";
        const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : "";
        return `<${tag}${start}>${node.items.map((item) => `<li>${item.children.map((child) => child.kind === "paragraph" ? this.inline(child.children) : this.block(child)).join("")}</li>`).join("")}</${tag}>`;
      }
      case "blockquote": return `<blockquote>${node.children.map((child) => this.block(child)).join("")}</blockquote>`;
      case "code": return `<pre><code${node.language ? ` class="language-${escapeHtml(node.language)}"` : ""}>${escapeHtml(node.text)}</code></pre>`;
      case "rule": return "<hr>";
      case "math": {
        const label = node.number ? `<span class="manuscriptPaperEquationNumber">(${node.number})</span>` : "";
        return `<div class="manuscriptPaperEquation"${node.label ? ` id="eq-${escapeHtml(node.label)}"` : ""}>${renderMath(node.tex, true)}${label}</div>`;
      }
      case "figure": return this.figureMarkup(node.locator, node.number, node.caption);
      case "bound-table": return this.boundTableMarkup(node.locator, node.number, node.caption);
      case "table": {
        const caption = node.number ? `<caption><span class="manuscriptPaperLabel">Table ${node.number}.</span> ${node.caption ? this.inline(node.caption) : ""}</caption>` : "";
        const align = (index: number) => node.align[index] ? ` style="text-align:${node.align[index]}"` : "";
        const header = `<thead><tr>${node.header.map((cell, index) => `<th scope="col"${align(index)}>${this.inline(cell)}</th>`).join("")}</tr></thead>`;
        const body = `<tbody>${node.rows.map((row) => `<tr>${row.map((cell, index) => `<td${align(index)}>${this.inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
        return `<div class="manuscriptPaperTableWrap"${node.key ? ` id="tab-${escapeHtml(node.key)}"` : ""}><table class="manuscriptPaperTable isInline">${caption}${header}${body}</table></div>`;
      }
      default: return "";
    }
  }

  titleBlock(title: string): string {
    const metadata = this.options.metadata;
    const parts: string[] = [`<h1 class="manuscriptPaperTitle">${escapeHtml(title || "Untitled manuscript")}</h1>`];
    if (metadata?.authors.length) {
      const affiliations: string[] = [];
      const affiliationIndex = (affiliation: string) => { let index = affiliations.indexOf(affiliation); if (index < 0) { affiliations.push(affiliation); index = affiliations.length - 1; } return index + 1; };
      const authors = metadata.authors.map((author) => {
        const marks = author.affiliations.map(affiliationIndex).join(",");
        return `<span class="manuscriptPaperAuthor">${escapeHtml(author.name)}<sup>${marks}${author.corresponding ? "*" : ""}</sup></span>`;
      }).join(", ");
      parts.push(`<p class="manuscriptPaperAuthors">${authors}</p>`);
      parts.push(`<ol class="manuscriptPaperAffiliations">${affiliations.map((affiliation) => `<li>${escapeHtml(affiliation)}</li>`).join("")}</ol>`);
      const corresponding = metadata.authors.filter((author) => author.corresponding && author.email);
      if (corresponding.length) parts.push(`<p class="manuscriptPaperCorresponding">* Correspondence: ${corresponding.map((author) => `${escapeHtml(author.name)} (${escapeHtml(author.email!)})`).join("; ")}</p>`);
    }
    return `<header class="manuscriptPaperHeader">${parts.join("")}</header>`;
  }

  abstractBlock(): string {
    if (!this.doc.abstract.length && !this.doc.keywords.length) return "";
    const body = this.doc.abstract.map((block) => this.block(block)).join("");
    const keywords = this.doc.keywords.length ? `<p class="manuscriptPaperKeywords"><span class="manuscriptPaperLabel">Keywords:</span> ${this.doc.keywords.map(escapeHtml).join("; ")}</p>` : "";
    return `<section class="manuscriptPaperAbstract" id="sec-abstract"><h2 data-role="abstract">Abstract</h2>${body}${keywords}</section>`;
  }

  referencesBlock(): { html: string; references: FormattedReference[] } {
    const entries = this.doc.citations.map((citation) => {
      const resolved = this.assets.citations.get(citation.locator);
      return resolved ? { ...resolved.entry, ordinal: citation.ordinal } : { locator: citation.locator, ordinal: citation.ordinal, title: citation.locator, authors: [], year: null, containerTitle: null, publisher: null, canonicalUri: "", kind: "unknown", doi: null, unresolved: true };
    });
    if (!entries.length) return { html: "", references: [] };
    const ordered = orderReferences(entries, this.options.style);
    const references = ordered.map((entry) => formatReference(entry, this.options.style));
    const hasHeading = this.doc.headings.some((heading) => heading.role === "references");
    const items = references.map((reference) => `<li id="ref-${escapeHtml(reference.locator)}" value="${reference.ordinal}"${reference.text.startsWith("[Unresolved") ? " class=\"isUnresolved\"" : ""}>${reference.html}</li>`).join("");
    const list = this.options.style === "apa" ? `<ul class="manuscriptPaperReferences isApa">${items}</ul>` : `<ol class="manuscriptPaperReferences">${items}</ol>`;
    return { html: `<section class="manuscriptPaperReferencesSection" id="sec-references">${hasHeading ? "" : "<h2 data-role=\"references\">References</h2>"}${list}</section>`, references };
  }

  statementsBlock(): string {
    const metadata = this.options.metadata;
    if (!metadata) return "";
    const statements: Array<[string, string | null]> = [
      ["Data availability", metadata.dataAvailabilityStatement], ["Code availability", metadata.codeAvailabilityStatement], ["Author contributions", metadata.authorContributionsStatement],
      ["Funding", metadata.fundingStatement], ["Competing interests", metadata.competingInterestsStatement], ["Ethics", metadata.ethicsStatement],
    ];
    const present = statements.filter(([, text]) => text);
    if (!present.length) return "";
    return `<section class="manuscriptPaperStatements">${present.map(([heading, text]) => `<h2 data-role="other">${escapeHtml(heading)}</h2><p>${escapeHtml(text!)}</p>`).join("")}</section>`;
  }
}

export const MANUSCRIPT_PAPER_CSS = `
.manuscriptPaper{font-family:"Times New Roman","Nimbus Roman No9 L","Liberation Serif",Times,serif;font-size:11pt;line-height:1.35;color:#111;max-width:180mm;margin:0 auto;padding:0 0 24pt;word-break:normal;overflow-wrap:anywhere;hyphens:auto}
.manuscriptPaper *{box-sizing:border-box}
.manuscriptPaperHeader{text-align:center;margin:0 0 18pt}
.manuscriptPaperDraftBoundary{font-size:9pt;font-weight:700;letter-spacing:.08em;text-align:center;color:#444;border-bottom:1px solid #888;padding:0 0 4pt;margin:0 0 12pt}
.manuscriptPaperTitle{font-size:18pt;font-weight:700;line-height:1.3;margin:0 0 10pt}
.manuscriptPaperAuthors{font-size:11pt;margin:0 0 4pt}
.manuscriptPaperAffiliations{list-style:none;padding:0;margin:0 0 4pt;font-size:9.5pt;color:#333}
.manuscriptPaperAffiliations li::before{content:counter(affil) " ";counter-increment:affil}
.manuscriptPaperAffiliations{counter-reset:affil}
.manuscriptPaperCorresponding{font-size:9pt;color:#333;margin:0}
.manuscriptPaperAbstract{border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:8pt 0;margin:0 0 14pt}
.manuscriptPaperAbstract h2{font-size:11pt;margin:0 0 4pt}
.manuscriptPaperKeywords{font-size:10pt;margin:6pt 0 0}
.manuscriptPaper h2{font-size:13pt;margin:16pt 0 6pt;line-height:1.3}
.manuscriptPaper h3{font-size:11.5pt;margin:12pt 0 4pt}
.manuscriptPaper h4{font-size:11pt;font-style:italic;margin:10pt 0 4pt}
.manuscriptPaperHeadingNumber{margin-right:.4em}
.manuscriptPaper p{margin:0 0 8pt;text-align:justify}
.manuscriptPaper ul,.manuscriptPaper ol{margin:0 0 8pt 18pt;padding:0}
.manuscriptPaper blockquote{margin:0 0 8pt 12pt;padding-left:8pt;border-left:2px solid #ccc;color:#333}
.manuscriptPaper pre{border:1px solid #ddd;padding:6pt;font-size:9pt;overflow:auto;white-space:pre-wrap;border-left:2px solid #ddd;padding-left:8pt}
.manuscriptPaper code{font-family:"JetBrains Mono","SF Mono",Menlo,monospace;font-size:.92em}
.manuscriptPaper hr{border:0;border-top:1px solid #ccc;margin:12pt 0}
.manuscriptPaperEquation{display:flex;align-items:center;justify-content:center;gap:12pt;margin:8pt 0;overflow-x:auto}
.manuscriptPaperEquation math{font-size:1.05em}
.manuscriptPaperEquationNumber{margin-left:auto;color:#333}
.manuscriptPaperMathError{color:${manuscriptColourCss("failure")};background:rgba(179,38,30,.08)}
.manuscriptPaperFigure,.manuscriptPaperTableImage{margin:12pt 0;text-align:center;break-inside:avoid;page-break-inside:avoid}
.manuscriptPaperFigure img,.manuscriptPaperTableImage img{max-width:100%;height:auto;background:#fff}
.manuscriptPaperFigure figcaption,.manuscriptPaperTableImage figcaption{font-size:9.5pt;text-align:left;margin-top:5pt;line-height:1.4}
.manuscriptPaperFigureMissing,.manuscriptPaperFigurePlaceholder{border:1px dashed #b0b0b8;color:${manuscriptColourCss("absence")};padding:24pt 12pt;font-size:9.5pt;background:transparent}
.manuscriptPaperTableWrap{margin:12pt 0;overflow-x:auto;break-inside:avoid;page-break-inside:avoid}
.manuscriptPaperTable{border-collapse:collapse;width:100%;font-size:9.5pt;line-height:1.35}
.manuscriptPaperTable caption{caption-side:top;text-align:left;font-size:9.5pt;padding:0 0 4pt}
.manuscriptPaperTable th,.manuscriptPaperTable td{padding:3pt 6pt;vertical-align:top;border:0}
.manuscriptPaperTable thead th{border-top:1.5px solid #111;border-bottom:1px solid #111;font-weight:600;text-align:left}
.manuscriptPaperTable tbody tr:last-child td{border-bottom:1.5px solid #111}
.manuscriptPaperTable td.isNumeric,.manuscriptPaperTable th[data-type="number"],.manuscriptPaperTable th[data-type="integer"]{text-align:right;font-variant-numeric:tabular-nums}
.manuscriptPaperTableNotes{font-size:8.5pt;color:#333;margin-top:3pt}
.manuscriptPaperTableNotes p{margin:0}
.manuscriptPaperTableWrap[data-editable="true"] td{outline:0}
@media screen{.manuscriptPaperTableWrap[data-editable="true"] td:focus{background:#f4f4f5;outline:2px solid #1a1a1c;outline-offset:-2px}}
.manuscriptPaperLabel{font-weight:600}
.manuscriptPaperCite,.manuscriptPaperRef{color:inherit;text-decoration:none}
.manuscriptPaperCite.isUnresolved,.manuscriptPaperRef.isUnresolved,.manuscriptPaperReferences .isUnresolved{color:${manuscriptColourCss("failure")};background:rgba(179,38,30,.08);border-radius:3px;padding:0 2px}
.manuscriptPaperReferencesSection{margin-top:16pt}
.manuscriptPaperReferences{font-size:9.5pt;padding-left:22pt;margin:0}
.manuscriptPaperReferences.isApa{list-style:none;padding-left:0}
.manuscriptPaperReferences.isApa li{padding-left:2em;text-indent:-2em;margin-bottom:4pt}
.manuscriptPaperReferences li{margin-bottom:3pt;line-height:1.4}
.manuscriptPaperStatements h2{font-size:11pt;margin:12pt 0 3pt}
.manuscriptPaperStatements p{font-size:10pt}
.manuscriptPaper.isPrint{max-width:none;margin:0}
@media print{
  @page{size:A4;margin:22mm 20mm}
  .manuscriptPaper{font-size:11pt}
  .manuscriptPaper h2,.manuscriptPaper h3{break-after:avoid;page-break-after:avoid}
  a{color:inherit;text-decoration:none}
}
.manuscriptPaper.hasLineNumbers{counter-reset:line}
.manuscriptPaper.hasLineNumbers p{position:relative}
.manuscriptPaper.hasLineNumbers p::before{content:counter(line);counter-increment:line;position:absolute;left:-28pt;width:22pt;text-align:right;font-size:8pt;color:#999}
`;

function manuscriptLayoutCss(layout: ScienceManuscriptLayoutSpec): string {
  const family = layout.fontFamily === "sans-serif"
    ? 'Arial,"Helvetica Neue",Helvetica,"Malgun Gothic",sans-serif'
    : '"Times New Roman",Times,"Malgun Gothic",serif';
  const lineHeight = layout.lineSpacing === "double" ? 2 : layout.lineSpacing === "one-and-half" ? 1.5 : 1.35;
  const pageWidthMm = layout.pageSize === "letter" ? 215.9 : 210;
  const contentWidthMm = Math.max(60, pageWidthMm - layout.marginsMm.left - layout.marginsMm.right);
  const pageSize = layout.pageSize === "letter" ? "letter" : "A4";
  const columnCount = layout.columnCount ?? 1;
  const columnGapMm = layout.columnGapMm ?? 7;
  const titleBreak = layout.titlePageMode === "separate" ? "break-after:page;page-break-after:always" : "";
  return `
.manuscriptPaper{font-family:${family};font-size:${layout.fontSizePt}pt;line-height:${lineHeight};max-width:${contentWidthMm}mm}
.manuscriptPaperHeader{${titleBreak}}
.manuscriptPaperBody{column-count:${columnCount};column-gap:${columnGapMm}mm;column-fill:auto}
.manuscriptPaperBody>h2,.manuscriptPaperBody>h3,.manuscriptPaperBody>h4{column-span:none}
@media print{@page{size:${pageSize};margin:${layout.marginsMm.top}mm ${layout.marginsMm.right}mm ${layout.marginsMm.bottom}mm ${layout.marginsMm.left}mm}.manuscriptPaper{font-size:${layout.fontSizePt}pt;line-height:${lineHeight}}}
`;
}

export function renderManuscriptHtml(doc: ManuscriptDocument, assets: ResolvedManuscriptAssets, options: HtmlRenderOptions): HtmlRenderResult {
  const writer = new HtmlWriter(doc, assets, options);
  const title = doc.title || "Untitled manuscript";
  const body = doc.body.map((block) => writer.block(block)).join("\n");
  const references = writer.referencesBlock();
  const classes = ["manuscriptPaper", options.mode === "print" ? "isPrint" : "isPreview", options.layout.lineNumbers ? "hasLineNumbers" : ""].filter(Boolean).join(" ");
  const draft = options.draftBoundary;
  const draftMarkup = draft
    ? `<div class="manuscriptPaperDraftBoundary" data-draft-token="${escapeHtml(draft.machineReadableToken)}">${escapeHtml(draft.literalText)}</div>`
    : "";
  const bodyHtml = `<article class="${classes}" lang="${escapeHtml(options.lang ?? "en")}" data-render-target="${escapeHtml(options.layout.renderTarget ?? "initial-submission")}" data-latex-template="${escapeHtml(options.layout.latexTemplate ?? "generic-article")}"${options.layout.latexJournalStyle ? ` data-latex-journal="${escapeHtml(options.layout.latexJournalStyle)}"` : ""} data-columns="${options.layout.columnCount ?? 1}" data-figures="${doc.figures.length}" data-tables="${doc.tables.length}" data-references="${references.references.length}" data-draft-status="${draft ? "draft" : "ready"}">${draftMarkup}${writer.titleBlock(title)}${writer.abstractBlock()}<main class="manuscriptPaperBody">${body}</main>${writer.statementsBlock()}${references.html}</article>`;
  const css = `${MANUSCRIPT_PAPER_CSS}${manuscriptLayoutCss(options.layout)}`;
  const draftMetadata = draft
    ? `<meta name="agentlas-manuscript-status" content="draft"><meta name="agentlas-draft-token" content="${escapeHtml(draft.machineReadableToken)}"><meta name="agentlas-manuscript-content-sha256" content="${escapeHtml(draft.manuscriptContentSha256)}">${draft.journalProfileId ? `<meta name="agentlas-journal-profile-id" content="${escapeHtml(draft.journalProfileId)}"><meta name="agentlas-journal-profile-version" content="${escapeHtml(String(draft.journalProfileVersion))}"><meta name="agentlas-journal-profile-content-sha256" content="${escapeHtml(draft.journalProfileContentSha256 ?? "")}">` : ""}`
    : `<meta name="agentlas-manuscript-status" content="ready">`;
  const html = `<!doctype html><html lang="${escapeHtml(options.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${draftMetadata}<title>${escapeHtml(title)}</title><style>${css}</style></head><body style="margin:0;background:#fff">${bodyHtml}</body></html>`;
  return { html, bodyHtml, css, references: references.references };
}
