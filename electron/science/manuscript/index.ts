// Science manuscript render service.
//
// Entry point that the IPC layer, the journal submission exporter, and the
// Research Director's MCP tool all call. It composes the pipeline:
//   store manuscript (markdown + bindings)
//     → document model (numbered figures/tables/equations/citations, warnings)
//     → resolved assets (exact bytes and rows from the store)
//     → HTML (preview + Chromium PDF), LaTeX (+ .bib), DOCX, package files
// Every output is derived from the same parsed document, so numbering and
// references agree across formats. Nothing here mutates the store.

import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ScienceManuscript, ScienceManuscriptBinding, ScienceManuscriptLayoutSpec, ScienceSubmissionMetadata } from "../../../shared/science-contract";
import type { ScienceStore } from "../store";
import { resolveManuscriptAssets, tableToCsv, type RasterAsset, type ResolvedManuscriptAssets } from "./assets";
import type { BibliographyStyle, FormattedReference } from "./bibliography";
import { renderScienceChartSvg } from "../statistics-figure-export";
import { inlineToPlainText, parseManuscript, type InlineNode, type ManuscriptDocument, type ManuscriptWarning } from "./document-model";
import { renderManuscriptDocx } from "./render-docx";
import { renderManuscriptHtml } from "./render-html";
import { renderManuscriptLatex } from "./render-latex";
import { renderManuscriptPdf, resolveTectonic, type LatexCompileDiagnostics, type ManuscriptPdfEngine, type ManuscriptPdfResult, type TectonicToolchainReceipt } from "./render-pdf";
import {
  DEFAULT_MANUSCRIPT_LAYOUT,
  countScienceManuscriptWords,
  draftBoundaryForProfile,
  deriveScienceJournalRenderProfile,
  legacyScienceWordCountPolicy,
  type ScienceJournalRenderProfileReceipt,
  type ScienceJournalWordCountPolicy,
  type ScienceManuscriptDraftBoundary,
  type ScienceManuscriptWordCountReport,
} from "./journal-render-profile";

export const SCIENCE_MANUSCRIPT_RENDER_SCHEMA = "agentlas.science.manuscript-render/v1" as const;

export interface ManuscriptRenderOptions {
  style?: BibliographyStyle;
  metadata?: ScienceSubmissionMetadata | null;
  lineNumbers?: boolean;
  /** Exact page and typography settings derived from an evidence-backed journal rule. */
  layout?: ScienceManuscriptLayoutSpec;
  /** Resolve this exact verified profile inside the render service before rendering. */
  journalProfileId?: string;
  expectedJournalProfileVersion?: number;
  expectedJournalProfileContentSha256?: string;
  /** Internal submission path may pass its already-derived receipt to avoid a second lookup. */
  journalRenderProfile?: ScienceJournalRenderProfileReceipt | null;
  /** Ordinary preview/render output is explicitly DRAFT; submission export passes null. */
  draftBoundary?: ScienceManuscriptDraftBoundary | null;
  /** Backward-compatible caller input. Prefer layout.lineSpacing. */
  doubleSpacing?: boolean;
  /** Which outputs to produce. Preview callers ask for html only; the exporter asks for everything. */
  outputs?: Array<"html" | "latex" | "docx" | "pdf" | "package">;
  pdfEngine?: ManuscriptPdfEngine;
  lang?: string;
  /**
   * Exporter override: figure locator → path (relative to the .tex file) that the packager
   * will place in the bundle itself. When set, the renderer emits no figure/table files.
   */
  figurePaths?: Map<string, string>;
}

export interface ManuscriptRenderFile { name: string; bytes: Uint8Array; sha256: string; mimeType: string }

export interface ManuscriptRenderResult {
  schema: typeof SCIENCE_MANUSCRIPT_RENDER_SCHEMA;
  manuscriptId: string | null;
  manuscriptVersion: number | null;
  manuscriptContentSha256: string;
  style: BibliographyStyle;
  layout: ScienceManuscriptLayoutSpec;
  journalRenderProfile: ScienceJournalRenderProfileReceipt | null;
  draftBoundary: ScienceManuscriptDraftBoundary | null;
  document: {
    title: string;
    wordCount: number;
    wordCountReport: ScienceManuscriptWordCountReport;
    figures: Array<{ locator: string; number: number; caption: string; resolved: boolean }>;
    tables: Array<{ locator: string | null; number: number; caption: string | null; bound: boolean; editable: boolean; rows: number }>;
    equations: Array<{ label: string; number: number }>;
    citations: Array<{ locator: string; ordinal: number; resolved: boolean }>;
    headings: ManuscriptDocument["headings"];
    keywords: string[];
  };
  references: FormattedReference[];
  warnings: ManuscriptWarning[];
  html: string | null;
  bodyHtml: string | null;
  css: string | null;
  latex: string | null;
  bibtex: string | null;
  docx: Uint8Array | null;
  pdf: {
    bytes: Uint8Array;
    engine: ManuscriptPdfEngine;
    degraded: ManuscriptPdfResult["degraded"] | null;
    degradedReason: string | null;
    typesetDiagnostics: LatexCompileDiagnostics | null;
    toolchain: TectonicToolchainReceipt | null;
  } | null;
  pdfFailure: string | null;
  /** Figure/table asset files for a submission package (figures/NNN-*.png|svg, tables/NNN-*.csv). */
  files: ManuscriptRenderFile[];
  equationFallbacks: string[];
  capabilities: { tectonic: boolean };
}

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

export { DEFAULT_MANUSCRIPT_LAYOUT } from "./journal-render-profile";
export type { ScienceJournalRenderProfileReceipt, ScienceJournalWordCountPolicy, ScienceManuscriptDraftBoundary, ScienceManuscriptWordCountReport } from "./journal-render-profile";

async function rasterizeSvg(bytes: Uint8Array, sha: string): Promise<RasterAsset> {
  const image = sharp(Buffer.from(bytes), { density: 300 });
  const metadata = await image.metadata();
  const width = Math.min(Math.max(metadata.width ?? 1800, 600), 6000);
  const buffer = await sharp(Buffer.from(bytes), { density: 300 }).resize({ width, withoutEnlargement: false }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  return { bytes: buffer.data, mimeType: "image/png", width: buffer.info.width, height: buffer.info.height, sha256: sha256(buffer.data) || sha };
}

function pad(value: number): string { return String(value).padStart(3, "0"); }

/** Builds the transient manuscript shape the pipeline expects from an unsaved draft. */
export function draftManuscript(projectId: string, title: string, markdown: string, bindings: ScienceManuscriptBinding[]): ScienceManuscript {
  const now = new Date(0).toISOString();
  return {
    id: "draft", projectId, title, status: "draft", currentVersion: 0, createdAt: now, updatedAt: now,
    version: { id: "draft", manuscriptId: "draft", version: 0, markdown, contentSha256: sha256(markdown), bindingManifestSha256: sha256(JSON.stringify(bindings)), bindings, createdAt: now },
  };
}

export class ScienceManuscriptRenderService {
  constructor(private readonly store: ScienceStore) {}

  private resolveJournalRenderProfile(manuscript: ScienceManuscript, options: ManuscriptRenderOptions): ScienceJournalRenderProfileReceipt | null {
    const hasProfileId = options.journalProfileId !== undefined;
    const hasExpectedProfile = options.expectedJournalProfileVersion !== undefined || options.expectedJournalProfileContentSha256 !== undefined;
    if (hasProfileId) {
      if (!options.journalProfileId) throw new Error("science-journal-render-profile-precondition-invalid");
      if (!Number.isSafeInteger(options.expectedJournalProfileVersion) || !/^[a-f0-9]{64}$/u.test(options.expectedJournalProfileContentSha256 ?? "")) throw new Error("science-journal-render-profile-precondition-invalid");
      const profile = this.store.getJournalProfileForProject(manuscript.projectId, options.journalProfileId);
      if (!profile) throw new Error("science-journal-profile-not-found");
      if (profile.currentVersion !== options.expectedJournalProfileVersion || profile.version.version !== options.expectedJournalProfileVersion || profile.version.contentSha256 !== options.expectedJournalProfileContentSha256) throw new Error("science-journal-profile-version-conflict");
      const derived = deriveScienceJournalRenderProfile(profile);
      if (options.journalRenderProfile && options.journalRenderProfile.contentSha256 !== derived.contentSha256) throw new Error("science-journal-render-profile-version-conflict");
      return derived;
    }
    if (hasExpectedProfile) throw new Error("science-journal-render-profile-precondition-invalid");
    return options.journalRenderProfile ?? null;
  }

  private effectiveOptions(manuscript: ScienceManuscript, options: ManuscriptRenderOptions): ManuscriptRenderOptions {
    const journalRenderProfile = this.resolveJournalRenderProfile(manuscript, options);
    return {
      ...options,
      journalRenderProfile,
      style: journalRenderProfile?.bibliographyStyle ?? options.style,
      layout: journalRenderProfile?.layout ?? options.layout,
      draftBoundary: options.draftBoundary === undefined
        ? draftBoundaryForProfile(journalRenderProfile, manuscript)
        : options.draftBoundary,
    };
  }

  parse(manuscript: ScienceManuscript): { document: ManuscriptDocument; assets: ResolvedManuscriptAssets } {
    const bindings = manuscript.version.bindings;
    const document = parseManuscript(manuscript.version.markdown, {
      figureLocators: bindings.filter((binding) => binding.role === "figure").map((binding) => binding.locator),
      tableLocators: bindings.filter((binding) => binding.role === "table").map((binding) => binding.locator),
      citationLocators: bindings.filter((binding) => binding.role === "citation").map((binding) => binding.locator),
    });
    if (!document.title) document.title = manuscript.title;
    const assets = resolveManuscriptAssets(this.store, manuscript);
    return { document, assets };
  }

  /**
   * Synchronous core used by the submission exporter (which must stay synchronous for
   * idempotent replay). Figures use the verified PNG capture; SVG exports are packaged
   * alongside but not rasterized here. No PDF.
   */
  renderSync(manuscript: ScienceManuscript, options: ManuscriptRenderOptions = {}): ManuscriptRenderResult {
    const { document, assets } = this.parse(manuscript);
    return this.renderSyncWithAssets(manuscript, document, assets, this.effectiveOptions(manuscript, options));
  }

  private renderSyncWithAssets(manuscript: ScienceManuscript, document: ManuscriptDocument, assets: ResolvedManuscriptAssets, options: ManuscriptRenderOptions): ManuscriptRenderResult {
    const style = options.style ?? "numeric";
    const journalRenderProfile = options.journalRenderProfile ?? null;
    const wordCountPolicy: ScienceJournalWordCountPolicy = journalRenderProfile?.wordCountPolicy ?? legacyScienceWordCountPolicy();
    const layout: ScienceManuscriptLayoutSpec = options.layout ?? {
      ...DEFAULT_MANUSCRIPT_LAYOUT,
      marginsMm: { ...DEFAULT_MANUSCRIPT_LAYOUT.marginsMm },
      lineSpacing: options.doubleSpacing ? "double" : DEFAULT_MANUSCRIPT_LAYOUT.lineSpacing,
      lineNumbers: options.lineNumbers ?? DEFAULT_MANUSCRIPT_LAYOUT.lineNumbers,
    };
    const outputs = new Set(options.outputs ?? ["html"]);
    const metadata = options.metadata ?? null;
    const warnings = [...document.warnings, ...assets.warnings];
    const files: ManuscriptRenderFile[] = [];
    const figureFiles = new Map<string, string>();
    const figureRasters = new Map<string, RasterAsset>();
    const wantsBinary = outputs.has("docx") || outputs.has("latex") || outputs.has("pdf") || outputs.has("package");
    if (wantsBinary && options.figurePaths) {
      for (const figure of document.figures) {
        const asset = assets.figures.get(figure.locator);
        const target = options.figurePaths.get(figure.locator);
        if (!asset) continue;
        if (asset.raster) figureRasters.set(figure.locator, asset.raster);
        if (target) figureFiles.set(figure.locator, target);
      }
      for (const table of document.tables) {
        const target = table.locator ? options.figurePaths.get(`table:${table.locator}`) : undefined;
        if (target) figureFiles.set(`table:${table.locator}`, target);
      }
    } else if (wantsBinary) {
      for (const figure of document.figures) {
        const asset = assets.figures.get(figure.locator);
        if (!asset) continue;
        const base = `figures/${pad(figure.number)}-figure`;
        if (asset.svg) files.push({ name: `${base}.svg`, bytes: asset.svg.bytes, sha256: asset.svg.sha256, mimeType: "image/svg+xml" });
        if (asset.raster) {
          const extension = asset.raster.mimeType === "image/jpeg" ? "jpg" : asset.raster.mimeType === "image/webp" ? "webp" : "png";
          figureRasters.set(figure.locator, asset.raster);
          files.push({ name: `${base}.${extension}`, bytes: asset.raster.bytes, sha256: asset.raster.sha256, mimeType: asset.raster.mimeType });
          figureFiles.set(figure.locator, `${base}.${extension}`);
        } else if (asset.svg) {
          warnings.push({ code: "figure-raster-missing", message: `Vector figure "${figure.locator}" has no verified PNG capture; LaTeX/DOCX embed requires the asynchronous renderer or a capture.`, line: null });
        }
      }
      for (const table of document.tables) {
        if (!table.locator || !table.bound) continue;
        const asset = assets.tables.get(table.locator);
        if (!asset) continue;
        const base = `tables/${pad(table.number)}-table`;
        if (asset.editable && asset.columns.length) {
          const csv = tableToCsv(asset);
          files.push({ name: `${base}.csv`, bytes: Buffer.from(csv, "utf8"), sha256: sha256(csv), mimeType: "text/csv" });
        }
        if (asset.raster) {
          files.push({ name: `${base}.png`, bytes: asset.raster.bytes, sha256: asset.raster.sha256, mimeType: asset.raster.mimeType });
          figureFiles.set(`table:${table.locator}`, `${base}.png`);
        }
      }
    }
    const html = outputs.has("html") || outputs.has("pdf") || outputs.has("package")
      ? renderManuscriptHtml(document, assets, { style, mode: outputs.has("pdf") || outputs.has("package") ? "print" : "preview", metadata, embedAssets: true, layout, draftBoundary: options.draftBoundary, lang: options.lang })
      : null;
    const latex = outputs.has("latex") || outputs.has("pdf") || outputs.has("package")
      ? renderManuscriptLatex(document, assets, { style, metadata, figureFiles, layout, draftBoundary: options.draftBoundary })
      : null;
    const docx = outputs.has("docx") || outputs.has("package")
      ? renderManuscriptDocx(document, assets, { style, metadata, figureRasters, layout, draftBoundary: options.draftBoundary })
      : null;
    const references = html?.references ?? latex?.references ?? docx?.references ?? [];
    const wordCountReport = countScienceManuscriptWords(document, references, wordCountPolicy);
    return {
      schema: SCIENCE_MANUSCRIPT_RENDER_SCHEMA,
      manuscriptId: manuscript.id === "draft" ? null : manuscript.id,
      manuscriptVersion: manuscript.id === "draft" ? null : manuscript.currentVersion,
      manuscriptContentSha256: manuscript.version.contentSha256,
      style,
      layout,
      journalRenderProfile,
      draftBoundary: options.draftBoundary === undefined ? draftBoundaryForProfile(journalRenderProfile, manuscript) : options.draftBoundary,
      document: {
        title: document.title,
        wordCount: wordCountReport.total,
        wordCountReport,
        figures: document.figures.map((figure) => ({ locator: figure.locator, number: figure.number, caption: plain(figure.caption), resolved: Boolean(assets.figures.get(figure.locator)?.raster || assets.figures.get(figure.locator)?.svg) })),
        tables: document.tables.map((table) => { const asset = table.locator ? assets.tables.get(table.locator) : undefined; return { locator: table.locator, number: table.number, caption: table.caption ? plain(table.caption) : null, bound: table.bound, editable: table.bound ? Boolean(asset?.editable) : true, rows: table.bound ? (asset?.rows.length ?? 0) : (table.rowCount ?? 0) }; }),
        equations: document.equations,
        citations: document.citations.map((citation) => ({ locator: citation.locator, ordinal: citation.ordinal, resolved: Boolean(assets.citations.get(citation.locator)?.source) })),
        headings: document.headings,
        keywords: document.keywords,
      },
      references,
      warnings,
      html: html?.html ?? null,
      bodyHtml: html?.bodyHtml ?? null,
      css: html?.css ?? null,
      latex: latex?.tex ?? null,
      bibtex: latex?.bibtex ?? null,
      docx: docx?.bytes ?? null,
      pdf: null,
      pdfFailure: null,
      files,
      equationFallbacks: docx?.equationFallbacks ?? [],
      capabilities: { tectonic: resolveTectonic() !== null },
    };
  }

  /**
   * Full renderer: rasterizes vector figures at 300 dpi for DOCX/LaTeX (better than the
   * screen capture) and produces the PDF (tectonic when installed, else Chromium).
   */
  async render(manuscript: ScienceManuscript, options: ManuscriptRenderOptions = {}): Promise<ManuscriptRenderResult> {
    const effective = this.effectiveOptions(manuscript, options);
    const outputs = new Set(effective.outputs ?? ["html"]);
    const wantsBinary = outputs.has("docx") || outputs.has("latex") || outputs.has("pdf") || outputs.has("package");
    if (!wantsBinary) {
      const { document, assets } = this.parse(manuscript);
      return this.renderSyncWithAssets(manuscript, document, assets, effective);
    }
    const { document, assets } = this.parse(manuscript);
    const upgraded = new Map<string, RasterAsset>();
    const warnings: ManuscriptWarning[] = [];
    // A domain figure -- a magnitude-frequency fit, a light curve, a spectrum -- is a chart.vega
    // artifact just like a statistics figure, but only statistics figures have a persisted vector
    // export. Without this pass a paper mixing the two carries one figure as vector and the next as
    // a screen raster, which no journal would accept and no reader could explain. Render the
    // bound artifact's own spec here; it is the same sanitised renderer the export path uses.
    for (const figure of document.figures) {
      const asset = assets.figures.get(figure.locator);
      if (!asset || asset.svg) continue;
      const artifactId = asset.provenance.artifactId;
      const artifactVersion = asset.provenance.artifactVersion;
      if (typeof artifactId !== "string" || typeof artifactVersion !== "number") continue;
      const context = this.store.getArtifactContextForProject(manuscript.projectId, artifactId, artifactVersion);
      const payload = context?.selectedVersion.payload as { spec?: unknown; originalSpecSha256?: unknown } | undefined;
      if (context?.artifact.kind !== "chart.vega" || !payload?.spec) continue;
      try {
        const rendered = await renderScienceChartSvg(payload.spec, context.selectedVersion.contentSha256);
        asset.svg = { bytes: Buffer.from(rendered.svg, "utf8"), sha256: rendered.sha256 };
      } catch (error) {
        warnings.push({ code: "figure-vectorize-failed", line: null, message: `Figure "${figure.locator}" could not be rendered as a vector: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    // Upgrade vector figures to a 300-dpi raster before the synchronous core builds DOCX/LaTeX.
    for (const figure of document.figures) {
      const asset = assets.figures.get(figure.locator);
      if (!asset?.svg) continue;
      try { upgraded.set(figure.locator, await rasterizeSvg(asset.svg.bytes, asset.svg.sha256)); }
      catch (error) { warnings.push({ code: "figure-rasterize-failed", message: `Vector figure "${figure.locator}" could not be rasterized at 300 dpi: ${error instanceof Error ? error.message : String(error)}; the verified capture is used instead.`, line: null }); }
    }
    for (const [locator, raster] of upgraded) { const asset = assets.figures.get(locator); if (asset) asset.raster = raster; }
    const result = this.renderSyncWithAssets(manuscript, document, assets, effective);
    result.warnings.push(...warnings);
    if (outputs.has("pdf") || outputs.has("package")) {
      const pdf = await renderManuscriptPdf({
        html: result.html!,
        latex: result.latex ? { tex: result.latex, files: result.files.filter((file) => file.name.startsWith("figures/") || file.name.startsWith("tables/")) } : null,
        prefer: options.pdfEngine ?? "tectonic",
      });
      if (pdf.ok && pdf.bytes) result.pdf = {
        bytes: pdf.bytes,
        engine: pdf.engine!,
        degraded: pdf.degraded ?? null,
        degradedReason: pdf.degradedReason ?? null,
        typesetDiagnostics: pdf.diagnostics ?? null,
        toolchain: pdf.toolchain ?? null,
      };
      else result.pdfFailure = pdf.reason ?? "pdf export failed";
      if (pdf.degraded) result.warnings.push({ code: `pdf-${pdf.degraded}`, message: pdf.degraded === "toolchain-missing" ? "LaTeX toolchain (tectonic) is not installed; the PDF was printed from the HTML rendering." : `LaTeX typesetting failed (${pdf.degradedReason ?? "unknown"}); the PDF was printed from the HTML rendering.`, line: null });
    }
    return result;
  }

  /** Preview for the editor: unsaved markdown + the bindings the draft carries. */
  async renderPreview(projectId: string, title: string, markdown: string, bindings: ScienceManuscriptBinding[], options: Omit<ManuscriptRenderOptions, "outputs"> = {}): Promise<ManuscriptRenderResult> {
    return this.render(draftManuscript(projectId, title, markdown, bindings), { ...options, outputs: ["html"] });
  }

  async renderStored(projectId: string, manuscriptId: string, options: ManuscriptRenderOptions = {}): Promise<ManuscriptRenderResult> {
    const manuscript = this.store.getManuscriptForProject(projectId, manuscriptId);
    if (!manuscript) throw new Error("science-manuscript-not-found");
    return this.render(manuscript, options);
  }
}

function plain(nodes: InlineNode[]): string { return inlineToPlainText(nodes); }
