// LaTeX renderer for Science manuscripts.
//
// Produces a self-contained `article` source with the usual journal preamble
// (amsmath, graphicx, booktabs, hyperref, natbib-free thebibliography) plus a
// figures/ directory of the exact bound assets. Figures are written as PNG
// (raster capture) or SVG (vector export); LaTeX cannot include SVG directly,
// so the SVG is kept for the journal and a 300-dpi PNG sibling is used by
// \includegraphics. Tables are real tabular environments built from the exact
// artifact rows. Math is passed through verbatim — the manuscript dialect already
// uses LaTeX syntax inside $…$ / $$…$$.

import { citationMarker, formatReference, orderReferences, type BibliographyStyle, type FormattedReference } from "./bibliography";
import type { ResolvedManuscriptAssets, ResolvedTable } from "./assets";
import { formatCell, formatColumnCells } from "./render-html";
import type { ScienceManuscriptLayoutSpec, ScienceSubmissionMetadata } from "../../../shared/science-contract";
import { inlineToPlainText, type BlockNode, type InlineNode, type ManuscriptDocument } from "./document-model";
import { escapeLatex } from "../../../shared/science-latex-text";
import type { ScienceManuscriptDraftBoundary } from "./journal-render-profile";

export interface LatexRenderOptions {
  style: BibliographyStyle;
  metadata: ScienceSubmissionMetadata | null;
  /** File names (relative to the .tex) to use for each figure locator; provided by the packager. */
  figureFiles: Map<string, string>;
  layout: ScienceManuscriptLayoutSpec;
  draftBoundary?: ScienceManuscriptDraftBoundary | null;
  documentClass?: "article" | "revtex-like";
}

export interface LatexRenderResult {
  tex: string;
  bibtex: string;
  references: FormattedReference[];
}

/** A running head has one line. Cut on a word boundary and mark the cut. */
function shortenForHead(value: string): string {
  const flat = String(value || "").replace(/\s+/g, " ").trim();
  if (flat.length <= 58) return flat;
  const cut = flat.slice(0, 58);
  const at = cut.lastIndexOf(" ");
  return `${(at > 20 ? cut.slice(0, at) : cut).trim()}\\,\\dots`;
}

/** The head names the paper, not every affiliation: first author, then "et al." */
/**
 * The author names, as PLAIN TEXT, for the running head.
 *
 * The old version stripped markup with three hand-written patterns and hoped what was left was
 * safe. It was not: `{\small $^{1}$Agentlas}` was matched only as far as the first closing brace
 * -- which sits inside the superscript -- so a trailing `}` survived, ended `\newcommand` early,
 * and every PDF died with "Too many }'s". It went unnoticed because the other paper's author list
 * had a comma, and the split before it happened to cut the damage away.
 *
 * So: take the names only (everything before the first explicit line break, which is where the
 * affiliation block starts), then remove ANY character that can unbalance or shift LaTeX mode. A
 * running head has no markup in it, so nothing of value is lost.
 */
function headAuthor(value: string): string {
  const namesOnly = String(value || "").split(/\\\\\[/)[0];
  const flat = namesOnly
    // Affiliation markers are not part of a name. Strip the whole superscript group first --
    // stripping only the punctuation leaves the digits behind ("Mason Lee 1 et al.").
    .replace(/\$\^\{[^}]*\}\$/g, "")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}$^_~\\&#%]/g, " ")
    // Affiliation markers survive stripping as bare digits and asterisks, and a running head that
    // reads "Gate 1*" is worse than one that reads "Gate".
    .replace(/(?:^|\s)[\d*†‡§¶,;]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const first = flat.split(",")[0].trim();
  return flat.includes(",") ? `${first} et al.` : first;
}

function latexLabel(kind: string, key: string): string { return `${kind}:${key.replace(/[^A-Za-z0-9:_-]/g, "-")}`; }

class LatexWriter {
  constructor(private readonly doc: ManuscriptDocument, private readonly assets: ResolvedManuscriptAssets, private readonly options: LatexRenderOptions) {}

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
        case "text": return escapeLatex(node.text);
        case "strong": return `\\textbf{${this.inline(node.children)}}`;
        case "emphasis": return `\\emph{${this.inline(node.children)}}`;
        case "code": return `\\texttt{${escapeLatex(node.text)}}`;
        case "link": return `\\href{${node.href.replace(/[%#]/g, (char) => `\\${char}`)}}{${this.inline(node.children)}}`;
        case "math": return `$${node.tex}$`;
        case "cite": {
          if (this.options.style === "apa") return escapeLatex(citationMarker(this.citationEntries(node.locators), "apa"));
          if (this.options.style === "nature") {
            // Nature-style citations are superscript numerals without the
            // square brackets emitted by LaTeX's default citation command.
            // Keep each numeral linked to its exact bibliography entry without
            // relying on a journal-specific natbib/biblatex package.
            const markers = this.citationEntries(node.locators).map((entry) =>
              `\\hyperlink{${latexLabel("ref", entry.locator)}}{${entry.ordinal || "?"}}`,
            ).join(",");
            return `\\textsuperscript{${markers}}`;
          }
          const keys = node.locators.map((locator) => latexLabel("ref", locator)).join(",");
          return `\\cite{${keys}}`;
        }
        case "ref": {
          const label = node.target === "fig" ? "Figure" : node.target === "tab" ? "Table" : node.target === "eq" ? "Eq." : "Section";
          return node.number ? `${label}~\\ref{${latexLabel(node.target, node.key)}}` : `${label}~??`;
        }
        case "break": return "\\\\\n";
        default: return "";
      }
    }).join("");
  }

  private tabular(table: ResolvedTable): string {
    const columns = table.columns;
    const contentWidth = (index: number) => Math.max(
      columns[index].label.length,
      ...table.rows.slice(0, 5_000).map((row) => formatCell(row[columns[index].key] ?? null, columns[index].type).length),
    );
    const WRAP_AT = 26;
    const TEXT_BLOCK_CM = 16;
    const COLUMN_PADDING_CM = 0.42;
    const HEADER_WRAP_AT = 14;
    const headerWidth = (index: number) => columns[index].label.length;
    const wrapped = columns.map((column, index) => column.type === "string" && contentWidth(index) > WRAP_AT);
    // A numeric column whose width comes from its heading, not its values, gets a stacked heading
    // instead: the cells stay on one line and the column stops being wide.
    const stackedHeader = columns.map((column, index) => column.type !== "string"
      && headerWidth(index) > HEADER_WRAP_AT
      && headerWidth(index) > contentWidth(index) - 2);
    const wrapCount = wrapped.filter(Boolean).length;
    const characterWidth = (size: string) => (size === "\\footnotesize" ? 0.155 : size === "\\small" ? 0.172 : 0.19);
    const fixedCost = (size: string) => columns.reduce((total, _column, index) => (
      wrapped[index] ? total + COLUMN_PADDING_CM : total + contentWidth(index) * characterWidth(size) + COLUMN_PADDING_CM
    ), 0);
    // Pick the largest size whose wrapping columns still get a usable width.
    const chosenSize = ["", "\\small", "\\footnotesize"].find((size) => (
      wrapCount === 0
        ? fixedCost(size) <= TEXT_BLOCK_CM
        // 2.2cm is about twelve characters — a wrapping column that narrow breaks almost every
        // phrase. Journal tables normally set smaller than the body text, so stepping down a size
        // to buy width is the right trade, not a compromise.
        : (TEXT_BLOCK_CM - fixedCost(size)) / wrapCount >= 3.0
    )) ?? "\\footnotesize";
    // Wrapping columns share the leftover width in proportion to how much text they carry.
    // Splitting it evenly gave a 28-character column the same width as an 85-character one, so
    // both wrapped to several lines and the table grew far taller than it needed to be.
    const leftover = TEXT_BLOCK_CM - fixedCost(chosenSize);
    const wrapDemand = columns.map((_column, index) => (wrapped[index] ? contentWidth(index) : 0));
    const demandTotal = wrapDemand.reduce((total, value) => total + value, 0);
    const wrapWidthFor = (index: number): number => {
      if (!wrapped[index] || wrapCount === 0) return 0;
      if (demandTotal <= 0) return Math.max(1.8, leftover / wrapCount);
      const share = leftover * (wrapDemand[index] / demandTotal);
      // Never below the readable floor, and never wider than the text it must hold.
      const needed = wrapDemand[index] * characterWidth(chosenSize);
      return Math.max(1.8, Math.min(share, needed));
    };
    const spec = columns.map((column, index) => {
      // \raggedright already stops justification; turning hyphenation off as well keeps a narrow
      // column from breaking a word at a wrong point ("nonparamet-ric" appeared in a rendered table).
      if (wrapped[index]) return `>{\\raggedright\\arraybackslash\\hyphenpenalty=10000\\exhyphenpenalty=10000}p{${wrapWidthFor(index).toFixed(2)}cm}`;
      return column.type === "number" || column.type === "integer" ? "r" : "l";
    }).join("");
    const stackedLabel = (label: string): string => {
      const midpoint = Math.floor(label.length / 2);
      const breakAt = label.lastIndexOf(" ", midpoint) > 0 ? label.lastIndexOf(" ", midpoint) : label.indexOf(" ", midpoint);
      if (breakAt <= 0) return escapeLatex(label);
      return `${escapeLatex(label.slice(0, breakAt))}\\\\${escapeLatex(label.slice(breakAt + 1))}`;
    };
    const header = columns.map((column, index) => (stackedHeader[index]
      ? `\\textbf{\\makecell[c]{${stackedLabel(column.label)}}}`
      : `\\textbf{${escapeLatex(column.label)}}`)).join(" & ");
    // Formatted a COLUMN at a time, not a cell at a time. Per-cell formatting printed 2.9, then 3,
    // then 3.1 down a magnitude column -- three different shapes for one measurement, which is the
    // first thing a reader notices in a printed table.
    const columnCells = columns.map((column) => formatColumnCells(
      table.rows.slice(0, 5_000).map((row) => row[column.key] ?? null),
      column.type,
    ));
    const rows = table.rows.slice(0, 5_000).map((row, rowIndex) => columns.map((column, columnIndex) => escapeLatex(columnCells[columnIndex][rowIndex] ?? formatCell(row[column.key] ?? null, column.type))).join(" & ")).join(" \\\\\n");
    const widest = columns.map((column, index) => Math.max(
      column.label.length,
      ...(columnCells[index] ?? []).map((cell) => cell.length),
    ));
    const characters = widest.reduce((total, value, index) => total + (wrapped[index] ? 14 : value) + 2, 0);
    const size = chosenSize;
    const body = `\\begin{tabular}{${spec}}\n\\toprule\n${header} \\\\\n\\midrule\n${rows}${rows ? " \\\\" : ""}\n\\bottomrule\n\\end{tabular}`;
    // Let TeX measure the table and decide, instead of guessing from character counts here.
    //
    // The previous version estimated the width from column text lengths, compared that estimate
    // against a 0.6 floor, and otherwise wrapped the table in \resizebox{\linewidth}. When the
    // estimate was optimistic -- which it was for a twelve-column table -- the floor never fired
    // and \resizebox quietly shrank the table to whatever fitted: measured in the rendered PDF,
    // 4.2pt against a 9.7pt body, 43%. Type that small is not a table a journal will set.
    //
    // \sbox measures the real thing. Under one line width it is left alone; up to 5/3 of a line
    // width (the reciprocal of the 0.6 floor) it may be shrunk to fit; wider than that it goes
    // sideways on its own page, bounded by the text height, because a table that needs more than
    // that is a landscape table and shrinking it further only makes it unreadable in a new way.
    const fitted = wrapCount === 0
      ? [
        `\\sbox\\sciencetablebox{${body}}%`,
        "\\ifdim\\wd\\sciencetablebox>\\dimexpr\\linewidth*5/3\\relax",
        "\\begin{sideways}\\resizebox{\\ifdim\\wd\\sciencetablebox>\\textheight\\textheight\\else\\wd\\sciencetablebox\\fi}{!}{\\usebox\\sciencetablebox}\\end{sideways}%",
        "\\else\\ifdim\\wd\\sciencetablebox>\\linewidth",
        "\\resizebox{\\linewidth}{!}{\\usebox\\sciencetablebox}%",
        "\\else\\usebox\\sciencetablebox\\fi\\fi",
      ].join("\n")
      : body;
    return `${size}\n${fitted}`;
  }

  block(node: BlockNode): string {
    switch (node.kind) {
      case "heading": {
        const command = node.level === 1 ? "section" : node.level === 2 ? "section" : node.level === 3 ? "subsection" : "subsubsection";
        const star = node.role === "abstract" || node.role === "references" || node.role === "acknowledgements" || node.number === null && node.level > 1 ? "*" : "";
        return `\\${command}${star}{${this.inline(node.children)}}\\label{${latexLabel("sec", node.slug)}}`;
      }
      case "paragraph": return this.inline(node.children);
      case "list": {
        const env = node.ordered ? "enumerate" : "itemize";
        const start = node.ordered && node.start !== 1 ? `\\setcounter{enumi}{${node.start - 1}}\n` : "";
        return `\\begin{${env}}\n${start}${node.items.map((item) => `\\item ${item.children.map((child) => child.kind === "paragraph" ? this.inline(child.children) : this.block(child)).join("\n\n")}`).join("\n")}\n\\end{${env}}`;
      }
      case "blockquote": return `\\begin{quote}\n${node.children.map((child) => this.block(child)).join("\n\n")}\n\\end{quote}`;
      case "code": return `\\begin{verbatim}\n${node.text.replace(/\\end\{verbatim\}/g, "\\end {verbatim}")}\n\\end{verbatim}`;
      case "rule": return "\\begin{center}\\rule{0.5\\linewidth}{0.4pt}\\end{center}";
      case "math": return node.label
        ? `\\begin{equation}\n${node.tex}\n\\label{${latexLabel("eq", node.label)}}\n\\end{equation}`
        : `\\begin{equation*}\n${node.tex}\n\\end{equation*}`;
      case "figure": {
        const file = this.options.figureFiles.get(node.locator);
        const figure = this.assets.figures.get(node.locator);
        const caption = this.inline(node.caption) || escapeLatex(figure?.title ?? node.locator);
        const graphic = file ? `\\includegraphics[width=\\linewidth,height=0.42\\textheight,keepaspectratio]{${file}}` : `\\fbox{\\parbox{0.9\\linewidth}{\\centering Missing figure asset: ${escapeLatex(node.locator)}}}`;
        return `\\begin{figure}[!htbp]\n\\centering\n${graphic}\n\\caption{${caption}}\n\\label{${latexLabel("fig", node.locator)}}\n\\end{figure}`;
      }
      case "bound-table": {
        const table = this.assets.tables.get(node.locator);
        const caption = this.inline(node.caption) || escapeLatex(table?.caption ?? table?.title ?? node.locator);
        if (!table || !table.editable || !table.columns.length) {
          const file = this.options.figureFiles.get(`table:${node.locator}`);
          const graphic = file ? `\\includegraphics[width=\\linewidth]{${file}}` : `\\fbox{\\parbox{0.9\\linewidth}{\\centering Missing table asset: ${escapeLatex(node.locator)}}}`;
          return `\\begin{table}[!htbp]\n\\centering\n\\caption{${caption}}\n\\label{${latexLabel("tab", node.locator)}}\n${graphic}\n\\end{table}`;
        }
        const notes = table.notes.length ? `\n\\begin{flushleft}\\footnotesize ${table.notes.map(escapeLatex).join(" ")}\\end{flushleft}` : "";
        return `\\begin{table}[!htbp]\n\\centering\n\\caption{${caption}}\n\\label{${latexLabel("tab", node.locator)}}\n${this.tabular(table)}${notes}\n\\end{table}`;
      }
      case "table": {
        const spec = node.align.map((align) => align === "right" ? "r" : align === "center" ? "c" : "l").join("");
        const header = node.header.map((cell) => `\\textbf{${this.inline(cell)}}`).join(" & ");
        const rows = node.rows.map((row) => row.map((cell) => this.inline(cell)).join(" & ")).join(" \\\\\n");
        const caption = node.caption ? `\\caption{${this.inline(node.caption)}}\n` : node.number ? `\\caption{Table ${node.number}}\n` : "";
        const label = node.key ? `\\label{${latexLabel("tab", node.key)}}\n` : "";
        return `\\begin{table}[!htbp]\n\\centering\n${caption}${label}\\begin{tabular}{${spec}}\n\\toprule\n${header} \\\\\n\\midrule\n${rows}${rows ? " \\\\" : ""}\n\\bottomrule\n\\end{tabular}\n\\end{table}`;
      }
      default: return "";
    }
  }
}

export function renderManuscriptLatex(doc: ManuscriptDocument, assets: ResolvedManuscriptAssets, options: LatexRenderOptions): LatexRenderResult {
  const writer = new LatexWriter(doc, assets, options);
  const metadata = options.metadata;
  const title = escapeLatex(doc.title || "Untitled manuscript");
  const affiliations: string[] = [];
  const affiliationIndex = (affiliation: string) => { let index = affiliations.indexOf(affiliation); if (index < 0) { affiliations.push(affiliation); index = affiliations.length - 1; } return index + 1; };
  const authorLine = metadata?.authors.length
    ? metadata.authors.map((author) => `${escapeLatex(author.name)}$^{${author.affiliations.map(affiliationIndex).join(",")}${author.corresponding ? "*" : ""}}$`).join(", ")
    : "";
  const affiliationLines = affiliations
    .map((affiliation, index) => `{\\small $^{${index + 1}}$${escapeLatex(affiliation)}}`)
    .join(" \\\\\n");
  const corresponding = metadata?.authors.filter((author) => author.corresponding && author.email) ?? [];
  const correspondingLine = corresponding.length ? `\\\\[4pt] {\\small $^{*}$Correspondence: ${corresponding.map((author) => `${escapeLatex(author.name)} (\\texttt{${escapeLatex(author.email!)}})`).join("; ")}}` : "";
  const author = [authorLine, affiliationLines ? `\\\\[6pt]\n${affiliationLines}` : "", correspondingLine].filter(Boolean).join("\n");

  const entries = doc.citations.map((citation) => {
    const resolved = assets.citations.get(citation.locator);
    return resolved ? { ...resolved.entry, ordinal: citation.ordinal } : { locator: citation.locator, ordinal: citation.ordinal, title: citation.locator, authors: [], year: null, containerTitle: null, publisher: null, canonicalUri: "", kind: "unknown", doi: null, unresolved: true };
  });
  const ordered = orderReferences(entries, options.style);
  const references = ordered.map((entry) => formatReference(entry, options.style));
  const abstract = doc.abstract.length ? `\\begin{abstract}\n${doc.abstract.map((block) => writer.block(block)).join("\n\n")}${doc.keywords.length ? `\n\n\\noindent\\textbf{Keywords:} ${doc.keywords.map(escapeLatex).join("; ")}` : ""}\n\\end{abstract}` : "";
  const body = doc.body.map((block) => writer.block(block)).join("\n\n");
  const hasReferencesHeading = doc.headings.some((heading) => heading.role === "references");
  const numberedBibliography = `\\begin{thebibliography}{${references.length}}\n${references.map((reference) => `${options.style === "nature" ? `\\hypertarget{${latexLabel("ref", reference.locator)}}{}` : ""}\\bibitem{${latexLabel("ref", reference.locator)}} ${escapeLatex(reference.text)}`).join("\n")}\n\\end{thebibliography}`;
  const bibliography = references.length
    ? options.style === "apa"
      ? `${hasReferencesHeading ? "" : "\\section*{References}\n"}\\begin{flushleft}\n${references.map((reference) => `\\hangindent=2em \\hangafter=1 \\noindent ${escapeLatex(reference.text)}\\par`).join("\n")}\n\\end{flushleft}`
      // article.cls makes thebibliography print its own References heading. Preserve an
      // author-written heading (and any prose beneath it), but suppress the environment's
      // duplicate heading inside a local group. With no source heading, the environment owns it.
      : hasReferencesHeading
        ? `\\begingroup\n\\def\\section#1#2{}\n${numberedBibliography}\n\\endgroup`
        : numberedBibliography
    : "";

  const statements: Array<[string, string | null]> = metadata ? [
    ["Data availability", metadata.dataAvailabilityStatement], ["Code availability", metadata.codeAvailabilityStatement], ["Author contributions", metadata.authorContributionsStatement],
    ["Funding", metadata.fundingStatement], ["Competing interests", metadata.competingInterestsStatement], ["Ethics", metadata.ethicsStatement],
  ] : [];
  const statementBlock = statements.filter(([, text]) => text).map(([heading, text]) => `\\section*{${escapeLatex(heading)}}\n${escapeLatex(text!)}`).join("\n\n");

  const layout = options.layout;
  const geometry = `top=${layout.marginsMm.top}mm,right=${layout.marginsMm.right}mm,bottom=${layout.marginsMm.bottom}mm,left=${layout.marginsMm.left}mm`;
  const template = layout.latexTemplate ?? "generic-article";
  const spacing = template === "aps-revtex4-2"
    ? layout.lineSpacing === "double" ? "\\linespread{1.6}\\selectfont" : layout.lineSpacing === "one-and-half" ? "\\linespread{1.25}\\selectfont" : ""
    : layout.lineSpacing === "double" ? "\\doublespacing" : layout.lineSpacing === "one-and-half" ? "\\onehalfspacing" : "\\singlespacing";
  const renderTarget = layout.renderTarget ?? "initial-submission";
  const columnCount = layout.columnCount ?? 1;
  const documentClass = template === "aps-revtex4-2"
    ? `\\documentclass[aps${layout.latexJournalStyle ? `,${layout.latexJournalStyle}` : ""},${renderTarget === "published-approximation" || columnCount === 2 ? "reprint" : "preprint"},superscriptaddress]{revtex4-2}`
    : `\\documentclass[${layout.fontSizePt}pt,${layout.pageSize}paper${columnCount === 2 ? ",twocolumn" : ""}]{article}`;
  const templatePreamble = template === "aps-revtex4-2"
    ? []
    : [`\\usepackage[${geometry}]{geometry}`, "\\usepackage{caption}", "\\captionsetup{font=small,labelfont=bf}"];
  const frontMatter = template === "aps-revtex4-2"
    ? [
      `\\title{${title}}`,
      ...(metadata?.authors.length ? metadata.authors.flatMap((entry) => [
        `\\author{${escapeLatex(entry.name)}}`,
        ...(entry.email ? [`\\email{${escapeLatex(entry.email)}}`] : []),
        ...entry.affiliations.map((affiliation) => `\\affiliation{${escapeLatex(affiliation)}}`),
      ]) : ["\\author{~}"]),
      "\\date{}",
    ]
    : [`\\title{${title}}`, `\\author{${author || "~"}}`, "\\date{}"];
  // REVTeX initializes its front-matter state at \begin{document}; its author
  // commands must therefore follow that boundary. Generic article expects them
  // in the preamble. Keeping this explicit also makes the template compile gate
  // catch accidental cross-template front-matter reuse.
  const preambleFrontMatter = template === "aps-revtex4-2" ? [] : frontMatter;
  const titlePageBreak = layout.titlePageMode === "separate" ? "\\clearpage" : "";
  const draftBoundary = options.draftBoundary
    ? "\\begin{center}\\textbf{DRAFT --- NOT FOR SUBMISSION}\\end{center}"
    : "";
  const genericFloatPreamble = template === "aps-revtex4-2" ? [] : [
    "\\usepackage{float}",
    "\\usepackage[section]{placeins}",
    "\\renewcommand{\\topfraction}{0.92}",
    "\\renewcommand{\\bottomfraction}{0.82}",
    "\\renewcommand{\\textfraction}{0.06}",
    "\\renewcommand{\\floatpagefraction}{0.78}",
    "\\setcounter{topnumber}{4}",
    "\\setcounter{bottomnumber}{2}",
    "\\setcounter{totalnumber}{6}",
    "\\setlength{\\textfloatsep}{12pt plus 2pt minus 3pt}",
    "\\setlength{\\floatsep}{10pt plus 2pt minus 2pt}",
    "\\makeatletter",
    "\\setlength{\\@fptop}{0pt}",
    "\\setlength{\\@fpsep}{10pt plus 2pt minus 2pt}",
    "\\setlength{\\@fpbot}{0pt plus 1fil}",
    "\\makeatother",
  ];
  const documentOpening = template === "aps-revtex4-2"
    ? ["\\begin{document}", ...frontMatter, abstract, "\\maketitle", draftBoundary, titlePageBreak]
    : ["\\begin{document}", "\\maketitle", draftBoundary, titlePageBreak, abstract];
  const tex = [
    "% Generated by Agentlas Science manuscript renderer. Figures live in figures/; tables are inline tabular environments built from exact artifact rows.",
    `% Render target: ${renderTarget}; template: ${template}; columns: ${columnCount}`,
    ...(options.draftBoundary
      ? [`% Agentlas manuscript status: DRAFT; token: ${options.draftBoundary.machineReadableToken}; manuscript sha256: ${options.draftBoundary.manuscriptContentSha256}; journal profile: ${options.draftBoundary.journalProfileId ?? "none"}@${options.draftBoundary.journalProfileVersion ?? "none"}; profile sha256: ${options.draftBoundary.journalProfileContentSha256 ?? "none"}`, "% Agentlas draft boundary literal: DRAFT — NOT FOR SUBMISSION"]
      : ["% Agentlas manuscript status: ready"]),
    documentClass,
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{amsmath,amssymb,amsfonts}",
    "\\usepackage{graphicx}",
    "\\usepackage{booktabs}",
    "\\usepackage{array}",
    // makecell sets a multi-line heading inside one cell, so a long numeric heading stops widening
    // its column; rotating gives a table too wide to shrink legibly its own landscape page.
    // The table renderer below uses both plus \sciencetablebox, so they load under every template.
    "\\usepackage{makecell}",
    "\\usepackage{rotating}",
    // One reusable box so a table can be measured before it is placed; see the table renderer.
    "\\newsavebox{\\sciencetablebox}",
    ...templatePreamble,
    // A running head is standard in journal typesetting: from page two the reader can see whose
    // paper this is and what it is called. A rendered paper had none -- page two opened straight
    // into a figure caption with no identification at all. REVTeX runs its own head, so this is
    // only for the generic article template.
    ...(template === "aps-revtex4-2" ? [] : [
      "\\usepackage{fancyhdr}",
      "\\pagestyle{fancy}",
      "\\fancyhf{}",
      "\\renewcommand{\\headrulewidth}{0pt}",
      "\\fancyhead[L]{\\footnotesize\\itshape\\runningauthor}",
      "\\fancyhead[R]{\\footnotesize\\itshape\\runningtitle}",
      "\\fancyfoot[C]{\\thepage}",
      "\\fancypagestyle{plain}{\\fancyhf{}\\renewcommand{\\headrulewidth}{0pt}\\fancyfoot[C]{\\thepage}}",
    ]),
    "\\usepackage[hidelinks]{hyperref}",
    "\\usepackage{microtype}",
    // Real long-form manuscripts expose unlucky line-breaking combinations
    // that short fixtures never exercise. Give TeX bounded paragraph-level
    // flexibility while keeping any genuine overflow visible in the compile
    // diagnostics gate.
    "\\setlength{\\emergencystretch}{2em}",
    template === "aps-revtex4-2" ? "" : "\\usepackage{setspace}",
    spacing,
    layout.fontFamily === "sans-serif" ? "\\renewcommand{\\familydefault}{\\sfdefault}" : "",
    layout.lineNumbers ? "\\usepackage{lineno}\n\\linenumbers" : "",
    columnCount === 2 ? `\\setlength{\\columnsep}{${layout.columnGapMm ?? 7}mm}` : "",
    ...genericFloatPreamble,
    "\\setlength{\\parskip}{4pt}",
    // The running head must stay on one line. A long title is shortened here, not in the header,
    // so the reader still sees a recognisable phrase rather than a broken second line.
    ...(template === "aps-revtex4-2" ? [] : [
      `\\newcommand{\\runningtitle}{${shortenForHead(title)}}`,
      `\\newcommand{\\runningauthor}{${shortenForHead(headAuthor(author))}}`,
    ]),
    ...preambleFrontMatter,
    ...documentOpening,
    body,
    statementBlock,
    bibliography,
    "\\end{document}",
    "",
  ].filter((line) => line !== "").join("\n");
  const bibtex = references.map((reference) => reference.bibtex).join("\n\n");
  return { tex, bibtex, references };
}

export function latexPlainText(nodes: InlineNode[]): string { return inlineToPlainText(nodes); }
