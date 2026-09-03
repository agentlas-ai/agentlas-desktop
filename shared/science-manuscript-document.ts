import { createHash, randomUUID } from "node:crypto";

/**
 * Durable, editor-facing manuscript document model.
 *
 * The publication renderer still consumes the established Science Markdown
 * dialect. This model adds stable identities and optimistic-concurrency data
 * around each editable block without making renderer output depend on those
 * identities. A legacy Markdown import is always a new identity epoch: it must
 * never guess that two similar paragraphs are the same historical node.
 */

export const SCIENCE_MANUSCRIPT_DOCUMENT_SCHEMA = "agentlas.science.manuscript-document/v1" as const;

export const SCIENCE_MANUSCRIPT_NODE_KINDS = [
  "heading",
  "paragraph",
  "equation",
  "figure",
  "table",
  "list",
  "blockquote",
  "code",
  "rule",
] as const;

export type ScienceManuscriptNodeKind = typeof SCIENCE_MANUSCRIPT_NODE_KINDS[number];
export type ScienceManuscriptTableAlignment = "left" | "center" | "right" | null;
export type ScienceManuscriptCitationSyntax = "placeholder" | "pandoc";

export interface ScienceManuscriptCitationMark {
  id: string;
  revision: number;
  contentSha256: string;
  from: number;
  to: number;
  syntax: ScienceManuscriptCitationSyntax;
  locators: string[];
}

export type ScienceManuscriptCitationMarkInput = Omit<ScienceManuscriptCitationMark, "contentSha256">;

interface ScienceManuscriptNodeIdentity {
  id: string;
  revision: number;
  contentSha256: string;
}

interface ScienceManuscriptNodeInputIdentity {
  id: string;
  revision: number;
}

export interface ScienceManuscriptHeadingNode extends ScienceManuscriptNodeIdentity {
  kind: "heading";
  level: 1 | 2 | 3 | 4;
  text: string;
}

export interface ScienceManuscriptParagraphNode extends ScienceManuscriptNodeIdentity {
  kind: "paragraph";
  markdown: string;
  citationMarks: ScienceManuscriptCitationMark[];
}

export interface ScienceManuscriptEquationNode extends ScienceManuscriptNodeIdentity {
  kind: "equation";
  tex: string;
  label: string | null;
}

export interface ScienceManuscriptFigureNode extends ScienceManuscriptNodeIdentity {
  kind: "figure";
  locator: string;
  caption: string;
}

export interface ScienceManuscriptArtifactTableNode extends ScienceManuscriptNodeIdentity {
  kind: "table";
  mode: "artifact";
  locator: string;
  caption: string;
}

export interface ScienceManuscriptInlineTableNode extends ScienceManuscriptNodeIdentity {
  kind: "table";
  mode: "inline";
  caption: string;
  label: string | null;
  align: ScienceManuscriptTableAlignment[];
  header: string[];
  rows: string[][];
}

export interface ScienceManuscriptListItem {
  nodes: ScienceManuscriptNode[];
}

export interface ScienceManuscriptListNode extends ScienceManuscriptNodeIdentity {
  kind: "list";
  ordered: boolean;
  start: number;
  items: ScienceManuscriptListItem[];
}

export interface ScienceManuscriptBlockquoteNode extends ScienceManuscriptNodeIdentity {
  kind: "blockquote";
  children: ScienceManuscriptNode[];
}

export interface ScienceManuscriptCodeNode extends ScienceManuscriptNodeIdentity {
  kind: "code";
  language: string | null;
  text: string;
}

export interface ScienceManuscriptRuleNode extends ScienceManuscriptNodeIdentity {
  kind: "rule";
}

export type ScienceManuscriptNode =
  | ScienceManuscriptHeadingNode
  | ScienceManuscriptParagraphNode
  | ScienceManuscriptEquationNode
  | ScienceManuscriptFigureNode
  | ScienceManuscriptArtifactTableNode
  | ScienceManuscriptInlineTableNode
  | ScienceManuscriptListNode
  | ScienceManuscriptBlockquoteNode
  | ScienceManuscriptCodeNode
  | ScienceManuscriptRuleNode;

export type ScienceManuscriptNodeInput =
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptHeadingNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptParagraphNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptEquationNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptFigureNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptArtifactTableNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptInlineTableNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptListNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptBlockquoteNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptCodeNode, keyof ScienceManuscriptNodeIdentity>)
  | (ScienceManuscriptNodeInputIdentity & Omit<ScienceManuscriptRuleNode, keyof ScienceManuscriptNodeIdentity>);

export interface ScienceManuscriptDocument {
  schemaVersion: typeof SCIENCE_MANUSCRIPT_DOCUMENT_SCHEMA;
  documentId: string;
  /** A fresh UUID for each baseline/import. It prevents accidental identity reconciliation. */
  identityEpoch: string;
  revision: number;
  nodes: ScienceManuscriptNode[];
  documentSha256: string;
}

export interface SealScienceManuscriptDocumentInput {
  documentId: string;
  identityEpoch: string;
  revision: number;
  nodes: ScienceManuscriptNode[];
}

interface ScienceManuscriptAnchorExpectation {
  /** null means insert/move at the beginning of the top-level document. */
  afterNodeId: string | null;
  expectedAfterNodeRevision: number | null;
  expectedAfterNodeContentSha256: string | null;
}

export type ScienceManuscriptOperation =
  | ({
    kind: "insert-node";
    node: ScienceManuscriptNode;
  } & ScienceManuscriptAnchorExpectation)
  | ({
    kind: "insert-artifact";
    nodeId: string;
    nodeKind: "figure" | "table";
    locator: string;
    caption: string;
    validationReceiptId: string;
  } & ScienceManuscriptAnchorExpectation)
  | {
    kind: "replace-node";
    nodeId: string;
    expectedRevision: number;
    expectedContentSha256: string;
    replacement: ScienceManuscriptNode;
  }
  | {
    kind: "delete-node";
    nodeId: string;
    expectedRevision: number;
    expectedContentSha256: string;
  }
  | ({
    kind: "move-node";
    nodeId: string;
    expectedRevision: number;
    expectedContentSha256: string;
  } & ScienceManuscriptAnchorExpectation);

export interface ParseLegacyScienceManuscriptOptions {
  /** Injection point used by deterministic contracts. Production callers omit it. */
  createUuid?: () => string;
  /** Optional caller-created fresh identity. It is validated but never inferred from content. */
  documentId?: string;
  /** Optional caller-created fresh epoch. It is validated but never inferred from content. */
  identityEpoch?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const LOCATOR_RE = /^[^\s|{}][^\r\n|{}]{0,239}$/u;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const LANGUAGE_RE = /^[A-Za-z0-9_+.-]{1,80}$/u;
const MAX_NODES = 20_000;
const MAX_DEPTH = 16;
const MAX_TEXT = 2_000_000;
const MAX_TABLE_COLUMNS = 512;
const MAX_TABLE_ROWS = 100_000;
const MAX_LIST_ITEMS = 10_000;

type JsonRecord = Record<string, unknown>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(Object.keys(record).sort().flatMap((key) => {
      const child = record[key];
      return child === undefined ? [] : [[key, canonicalValue(child)]];
    }));
  }
  return value;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(value)) {
    throw new Error(`science-manuscript-${field}-invalid`);
  }
  return value.toLowerCase();
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`science-manuscript-${field}-invalid`);
  return Number(value);
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`science-manuscript-${field}-invalid`);
  return value;
}

function text(value: unknown, maximum: number, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new Error(`science-manuscript-${field}-invalid`);
  }
  return value.replace(/\r\n?/gu, "\n");
}

function oneLine(value: unknown, maximum: number, field: string, allowEmpty = false): string {
  const result = text(value, maximum, field, allowEmpty);
  if (/[\r\n]/u.test(result)) throw new Error(`science-manuscript-${field}-invalid`);
  return result;
}

function locator(value: unknown, field: string): string {
  const result = oneLine(value, 240, field).trim();
  if (!LOCATOR_RE.test(result)) throw new Error(`science-manuscript-${field}-invalid`);
  return result;
}

function label(value: unknown, field: string): string | null {
  if (value === null) return null;
  const result = oneLine(value, 120, field).trim();
  if (!LABEL_RE.test(result)) throw new Error(`science-manuscript-${field}-invalid`);
  return result;
}

function nodeSemanticValue(node: ScienceManuscriptNode | ScienceManuscriptNodeInput): unknown {
  switch (node.kind) {
    case "heading": return { kind: node.kind, level: node.level, text: node.text };
    case "paragraph": return {
      kind: node.kind,
      markdown: node.markdown,
      citationMarks: node.citationMarks.map((mark) => ({
        from: mark.from,
        to: mark.to,
        syntax: mark.syntax,
        locators: mark.locators,
      })),
    };
    case "equation": return { kind: node.kind, tex: node.tex, label: node.label };
    case "figure": return { kind: node.kind, locator: node.locator, caption: node.caption };
    case "table": return node.mode === "artifact"
      ? { kind: node.kind, mode: node.mode, locator: node.locator, caption: node.caption }
      : { kind: node.kind, mode: node.mode, caption: node.caption, label: node.label, align: node.align, header: node.header, rows: node.rows };
    case "list": return {
      kind: node.kind,
      ordered: node.ordered,
      start: node.start,
      items: node.items.map((item) => ({ nodes: item.nodes.map(nodeSemanticValue) })),
    };
    case "blockquote": return { kind: node.kind, children: node.children.map(nodeSemanticValue) };
    case "code": return { kind: node.kind, language: node.language, text: node.text };
    case "rule": return { kind: node.kind };
  }
}

function citationSemanticValue(mark: ScienceManuscriptCitationMark | ScienceManuscriptCitationMarkInput): unknown {
  return { from: mark.from, to: mark.to, syntax: mark.syntax, locators: mark.locators };
}

export function scienceManuscriptCitationMarkContentSha256(mark: ScienceManuscriptCitationMark | ScienceManuscriptCitationMarkInput): string {
  return sha256Json(citationSemanticValue(mark));
}

export function scienceManuscriptNodeContentSha256(node: ScienceManuscriptNode | ScienceManuscriptNodeInput): string {
  return sha256Json(nodeSemanticValue(node));
}

function documentHashValue(document: Omit<ScienceManuscriptDocument, "documentSha256">): unknown {
  return document;
}

export function scienceManuscriptDocumentSha256(document: Omit<ScienceManuscriptDocument, "documentSha256"> | ScienceManuscriptDocument): string {
  const { documentSha256: _ignored, ...unsigned } = document as ScienceManuscriptDocument;
  return sha256Json(documentHashValue(unsigned));
}

function parseCitationSegment(segment: string, syntax: ScienceManuscriptCitationSyntax): string[] | null {
  if (syntax === "placeholder") {
    const match = /^\{\{\s*cite\s*:\s*([^}]+?)\s*\}\}$/u.exec(segment);
    if (!match) return null;
    return match[1].split(/[;,]/u).map((item) => item.trim()).filter(Boolean);
  }
  const match = /^\[(@[^\]]+)\]$/u.exec(segment);
  if (!match) return null;
  return match[1].split(/;/u).map((item) => item.trim().replace(/^@/u, "")).filter(Boolean);
}

export function sealScienceManuscriptCitationMark(input: ScienceManuscriptCitationMarkInput): ScienceManuscriptCitationMark {
  const candidate = {
    id: uuid(input.id, "citation-mark-id"),
    revision: revision(input.revision, "citation-mark-revision"),
    from: input.from,
    to: input.to,
    syntax: input.syntax,
    locators: input.locators,
  } as ScienceManuscriptCitationMarkInput;
  const contentSha256 = scienceManuscriptCitationMarkContentSha256(candidate);
  return validateScienceManuscriptCitationMark({ ...candidate, contentSha256 });
}

export function validateScienceManuscriptCitationMark(value: unknown, source?: string): ScienceManuscriptCitationMark {
  const mark = record(value);
  if (!mark || !exactKeys(mark, ["id", "revision", "contentSha256", "from", "to", "syntax", "locators"])) {
    throw new Error("science-manuscript-citation-mark-invalid");
  }
  const result: ScienceManuscriptCitationMark = {
    id: uuid(mark.id, "citation-mark-id"),
    revision: revision(mark.revision, "citation-mark-revision"),
    contentSha256: hash(mark.contentSha256, "citation-mark-content-sha256"),
    from: Number(mark.from),
    to: Number(mark.to),
    syntax: mark.syntax as ScienceManuscriptCitationSyntax,
    locators: [],
  };
  if (!Number.isSafeInteger(result.from) || !Number.isSafeInteger(result.to) || result.from < 0 || result.to <= result.from
    || (result.syntax !== "placeholder" && result.syntax !== "pandoc") || !Array.isArray(mark.locators)
    || mark.locators.length < 1 || mark.locators.length > 128) {
    throw new Error("science-manuscript-citation-mark-invalid");
  }
  result.locators = mark.locators.map((item) => locator(item, "citation-locator"));
  if (new Set(result.locators).size !== result.locators.length) throw new Error("science-manuscript-citation-locators-duplicate");
  if (scienceManuscriptCitationMarkContentSha256(result) !== result.contentSha256) throw new Error("science-manuscript-citation-mark-hash-invalid");
  if (source !== undefined) {
    if (result.to > source.length) throw new Error("science-manuscript-citation-mark-range-invalid");
    const parsed = parseCitationSegment(source.slice(result.from, result.to), result.syntax);
    if (!parsed || parsed.length !== result.locators.length || parsed.some((item, index) => item !== result.locators[index])) {
      throw new Error("science-manuscript-citation-mark-source-mismatch");
    }
  }
  return result;
}

function validateCitationMarks(value: unknown, source: string, identities: Set<string>): ScienceManuscriptCitationMark[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("science-manuscript-citation-marks-invalid");
  const marks = value.map((entry) => validateScienceManuscriptCitationMark(entry, source));
  let end = -1;
  for (const mark of marks) {
    if (identities.has(mark.id)) throw new Error("science-manuscript-identity-duplicate");
    identities.add(mark.id);
    if (mark.from < end) throw new Error("science-manuscript-citation-marks-overlap");
    end = mark.to;
  }
  return marks;
}

function validateNode(value: unknown, identities: Set<string>, depth: number, count: { value: number }): ScienceManuscriptNode {
  const node = record(value);
  if (!node || depth > MAX_DEPTH || count.value >= MAX_NODES) throw new Error("science-manuscript-node-invalid");
  count.value += 1;
  const id = uuid(node.id, "node-id");
  if (identities.has(id)) throw new Error("science-manuscript-identity-duplicate");
  identities.add(id);
  const common = {
    id,
    revision: revision(node.revision, "node-revision"),
    contentSha256: hash(node.contentSha256, "node-content-sha256"),
  };
  let result: ScienceManuscriptNode;
  switch (node.kind) {
    case "heading": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "level", "text"])
        || ![1, 2, 3, 4].includes(Number(node.level))) throw new Error("science-manuscript-heading-invalid");
      result = { ...common, kind: "heading", level: Number(node.level) as 1 | 2 | 3 | 4, text: oneLine(node.text, 8_000, "heading-text") };
      break;
    }
    case "paragraph": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "markdown", "citationMarks"])) throw new Error("science-manuscript-paragraph-invalid");
      const markdown = text(node.markdown, MAX_TEXT, "paragraph-markdown");
      result = { ...common, kind: "paragraph", markdown, citationMarks: validateCitationMarks(node.citationMarks, markdown, identities) };
      break;
    }
    case "equation": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "tex", "label"])) throw new Error("science-manuscript-equation-invalid");
      result = { ...common, kind: "equation", tex: text(node.tex, 200_000, "equation-tex"), label: label(node.label, "equation-label") };
      break;
    }
    case "figure": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "locator", "caption"])) throw new Error("science-manuscript-figure-invalid");
      const caption = oneLine(node.caption, 100_000, "figure-caption", true);
      if (caption.includes("}}")) throw new Error("science-manuscript-figure-caption-invalid");
      result = { ...common, kind: "figure", locator: locator(node.locator, "figure-locator"), caption };
      break;
    }
    case "table": {
      if (node.mode === "artifact") {
        if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "mode", "locator", "caption"])) throw new Error("science-manuscript-table-invalid");
        const caption = oneLine(node.caption, 100_000, "table-caption", true);
        if (caption.includes("}}")) throw new Error("science-manuscript-table-caption-invalid");
        result = { ...common, kind: "table", mode: "artifact", locator: locator(node.locator, "table-locator"), caption };
      } else if (node.mode === "inline") {
        if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "mode", "caption", "label", "align", "header", "rows"])
          || !Array.isArray(node.align) || !Array.isArray(node.header) || !Array.isArray(node.rows)
          || node.header.length < 1 || node.header.length > MAX_TABLE_COLUMNS || node.align.length !== node.header.length
          || node.rows.length > MAX_TABLE_ROWS) throw new Error("science-manuscript-table-invalid");
        const align = node.align.map((item) => {
          if (item !== null && item !== "left" && item !== "center" && item !== "right") throw new Error("science-manuscript-table-alignment-invalid");
          return item;
        });
        const header = node.header.map((item) => oneLine(item, 100_000, "table-header", true));
        const rows = node.rows.map((row) => {
          if (!Array.isArray(row) || row.length !== header.length) throw new Error("science-manuscript-table-row-invalid");
          return row.map((item) => oneLine(item, 100_000, "table-cell", true));
        });
        result = {
          ...common,
          kind: "table",
          mode: "inline",
          caption: oneLine(node.caption, 100_000, "table-caption", true),
          label: label(node.label, "table-label"),
          align,
          header,
          rows,
        };
        if (result.label !== null && !result.caption.trim()) throw new Error("science-manuscript-table-caption-invalid");
      } else {
        throw new Error("science-manuscript-table-invalid");
      }
      break;
    }
    case "list": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "ordered", "start", "items"])
        || typeof node.ordered !== "boolean" || !Number.isSafeInteger(node.start) || Number(node.start) < 1 || Number(node.start) > 999
        || !Array.isArray(node.items) || node.items.length < 1 || node.items.length > MAX_LIST_ITEMS) throw new Error("science-manuscript-list-invalid");
      const items = node.items.map((item) => {
        const itemRecord = record(item);
        if (!itemRecord || !exactKeys(itemRecord, ["nodes"]) || !Array.isArray(itemRecord.nodes) || itemRecord.nodes.length < 1) {
          throw new Error("science-manuscript-list-item-invalid");
        }
        const nodes = itemRecord.nodes.map((child) => validateNode(child, identities, depth + 1, count));
        if (nodes[0].kind !== "paragraph") throw new Error("science-manuscript-list-item-first-node-invalid");
        return { nodes };
      });
      result = { ...common, kind: "list", ordered: node.ordered, start: Number(node.start), items };
      break;
    }
    case "blockquote": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "children"])
        || !Array.isArray(node.children) || node.children.length < 1) throw new Error("science-manuscript-blockquote-invalid");
      result = { ...common, kind: "blockquote", children: node.children.map((child) => validateNode(child, identities, depth + 1, count)) };
      break;
    }
    case "code": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256", "language", "text"])) throw new Error("science-manuscript-code-invalid");
      const language = node.language === null ? null : oneLine(node.language, 80, "code-language");
      if (language !== null && !LANGUAGE_RE.test(language)) throw new Error("science-manuscript-code-language-invalid");
      result = { ...common, kind: "code", language, text: text(node.text, MAX_TEXT, "code-text", true) };
      break;
    }
    case "rule": {
      if (!exactKeys(node, ["id", "kind", "revision", "contentSha256"])) throw new Error("science-manuscript-rule-invalid");
      result = { ...common, kind: "rule" };
      break;
    }
    default: throw new Error("science-manuscript-node-kind-invalid");
  }
  if (scienceManuscriptNodeContentSha256(result) !== result.contentSha256) throw new Error("science-manuscript-node-hash-invalid");
  return result;
}

export function validateScienceManuscriptNode(value: unknown): ScienceManuscriptNode {
  return validateNode(value, new Set<string>(), 0, { value: 0 });
}

/** Adds the semantic content hash after validating the supplied stable identity and fields. */
export function sealScienceManuscriptNode(input: ScienceManuscriptNodeInput): ScienceManuscriptNode {
  const candidate = { ...input, contentSha256: scienceManuscriptNodeContentSha256(input) } as ScienceManuscriptNode;
  return validateScienceManuscriptNode(candidate);
}

export function sealScienceManuscriptDocument(input: SealScienceManuscriptDocumentInput): ScienceManuscriptDocument {
  const unsigned: Omit<ScienceManuscriptDocument, "documentSha256"> = {
    schemaVersion: SCIENCE_MANUSCRIPT_DOCUMENT_SCHEMA,
    documentId: uuid(input.documentId, "document-id"),
    identityEpoch: uuid(input.identityEpoch, "identity-epoch"),
    revision: revision(input.revision, "document-revision"),
    nodes: input.nodes,
  };
  return validateScienceManuscriptDocument({ ...unsigned, documentSha256: scienceManuscriptDocumentSha256(unsigned) });
}

export function validateScienceManuscriptDocument(value: unknown): ScienceManuscriptDocument {
  const document = record(value);
  if (!document || !exactKeys(document, ["schemaVersion", "documentId", "identityEpoch", "revision", "nodes", "documentSha256"])
    || document.schemaVersion !== SCIENCE_MANUSCRIPT_DOCUMENT_SCHEMA || !Array.isArray(document.nodes) || document.nodes.length > MAX_NODES) {
    throw new Error("science-manuscript-document-invalid");
  }
  const identities = new Set<string>();
  const documentId = uuid(document.documentId, "document-id");
  const identityEpoch = uuid(document.identityEpoch, "identity-epoch");
  if (documentId === identityEpoch) throw new Error("science-manuscript-document-identities-invalid");
  identities.add(documentId);
  identities.add(identityEpoch);
  const count = { value: 0 };
  const result: ScienceManuscriptDocument = {
    schemaVersion: SCIENCE_MANUSCRIPT_DOCUMENT_SCHEMA,
    documentId,
    identityEpoch,
    revision: revision(document.revision, "document-revision"),
    nodes: document.nodes.map((node) => validateNode(node, identities, 0, count)),
    documentSha256: hash(document.documentSha256, "document-sha256"),
  };
  if (scienceManuscriptDocumentSha256(result) !== result.documentSha256) throw new Error("science-manuscript-document-hash-invalid");
  return result;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|");
}

function tableSeparator(align: ScienceManuscriptTableAlignment): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

function codeFence(textValue: string): string {
  const runs = textValue.match(/`+/gu) ?? [];
  const longest = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function indentMarkdown(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function serializeNode(node: ScienceManuscriptNode): string {
  switch (node.kind) {
    case "heading": return `${"#".repeat(node.level)} ${node.text}`;
    case "paragraph": return node.markdown;
    case "equation": return `$$\n${node.tex}\n$$${node.label ? ` {#eq:${node.label}}` : ""}`;
    case "figure": return `{{figure:${node.locator}${node.caption ? ` | ${node.caption}` : ""}}}`;
    case "table": {
      if (node.mode === "artifact") return `{{table:${node.locator}${node.caption ? ` | ${node.caption}` : ""}}}`;
      const caption = node.caption || node.label ? `Table: ${node.caption}${node.label ? ` {#tab:${node.label}}` : ""}\n\n` : "";
      const header = `| ${node.header.map(escapeTableCell).join(" | ")} |`;
      const separator = `| ${node.align.map(tableSeparator).join(" | ")} |`;
      const rows = node.rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`).join("\n");
      return `${caption}${header}\n${separator}${rows ? `\n${rows}` : ""}`;
    }
    case "list": return node.items.map((item, index) => {
      const marker = node.ordered ? `${node.start + index}.` : "-";
      const [first, ...rest] = item.nodes.map(serializeNode);
      const firstLines = first.split("\n");
      const head = `${marker} ${firstLines[0]}`;
      const continuation = firstLines.slice(1).map((line) => `  ${line}`);
      const tail = rest.map((child) => indentMarkdown(child, 2));
      return [head, ...continuation, ...tail].join("\n");
    }).join("\n");
    case "blockquote": return node.children.map(serializeNode).join("\n\n").split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
    case "code": {
      const fence = codeFence(node.text);
      return `${fence}${node.language ?? ""}\n${node.text}\n${fence}`;
    }
    case "rule": return "---";
  }
}

/** Renderer-compatible, deterministic Markdown. Identity metadata is intentionally not rendered. */
export function serializeScienceManuscriptDocument(value: ScienceManuscriptDocument): string {
  const document = validateScienceManuscriptDocument(value);
  return document.nodes.map(serializeNode).join("\n\n");
}

function parseTableRow(value: string): string[] {
  const source = value.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1] === "|") { current += "|"; index += 1; continue; }
    if (source[index] === "|") { cells.push(current.trim()); current = ""; continue; }
    current += source[index];
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlign(value: string): ScienceManuscriptTableAlignment[] {
  return parseTableRow(value).map((cell) => {
    const trimmed = cell.trim();
    if (!/^:?-{3,}:?$/u.test(trimmed)) throw new Error("science-manuscript-legacy-table-separator-invalid");
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
    if (trimmed.startsWith(":")) return "left";
    if (trimmed.endsWith(":")) return "right";
    return null;
  });
}

function isTableSeparator(value: string): boolean {
  try { return parseTableAlign(value).length > 0; } catch { return false; }
}

function citationMarks(markdown: string, nextUuid: () => string): ScienceManuscriptCitationMark[] {
  const codeRanges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < markdown.length;) {
    if (markdown[index] !== "`") { index += 1; continue; }
    let run = 1;
    while (markdown[index + run] === "`") run += 1;
    const marker = "`".repeat(run);
    const close = markdown.indexOf(marker, index + run);
    if (close < 0) { index += run; continue; }
    codeRanges.push({ from: index, to: close + run });
    index = close + run;
  }
  const matches: Array<{ from: number; to: number; syntax: ScienceManuscriptCitationSyntax; locators: string[] }> = [];
  const pattern = /\{\{\s*cite\s*:\s*([^}]+?)\s*\}\}|\[(@[^\]]+)\]/gu;
  for (const match of markdown.matchAll(pattern)) {
    if (match.index === undefined || codeRanges.some((range) => match.index! >= range.from && match.index! < range.to)) continue;
    let escapes = 0;
    for (let cursor = match.index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) escapes += 1;
    if (escapes % 2 === 1) continue;
    const syntax: ScienceManuscriptCitationSyntax = match[1] !== undefined ? "placeholder" : "pandoc";
    const locators = syntax === "placeholder"
      ? match[1].split(/[;,]/u).map((item) => item.trim()).filter(Boolean)
      : match[2].split(/;/u).map((item) => item.trim().replace(/^@/u, "")).filter(Boolean);
    if (!locators.length) continue;
    matches.push({ from: match.index, to: match.index + match[0].length, syntax, locators });
  }
  return matches.map((match) => sealScienceManuscriptCitationMark({ id: nextUuid(), revision: 1, ...match }));
}

interface LegacyLine { text: string; number: number }

interface LegacyParser {
  nextUuid: () => string;
}

function paragraphNode(markdown: string, parser: LegacyParser): ScienceManuscriptParagraphNode {
  return sealScienceManuscriptNode({
    id: parser.nextUuid(),
    revision: 1,
    kind: "paragraph",
    markdown,
    citationMarks: citationMarks(markdown, parser.nextUuid),
  }) as ScienceManuscriptParagraphNode;
}

function startsBlock(lines: LegacyLine[], index: number): boolean {
  const value = lines[index]?.text ?? "";
  const next = lines[index + 1]?.text ?? "";
  return /^#{1,4}\s+/u.test(value) || /^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(value)
    || /^(`{3,}|~{3,})/u.test(value) || /^\$\$/u.test(value)
    || /^\{\{\s*(?:figure|table)\s*:/u.test(value) || /^>\s?/u.test(value)
    || /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)/u.test(value)
    || (value.includes("|") && isTableSeparator(next));
}

function parseLegacyBlocks(lines: LegacyLine[], parser: LegacyParser): ScienceManuscriptNode[] {
  const nodes: ScienceManuscriptNode[] = [];
  let index = 0;
  let pendingCaption: { caption: string; label: string | null } | null = null;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.text.trim()) { index += 1; continue; }

    const heading = /^(#{1,4})\s+(.+?)\s*#*\s*$/u.exec(line.text);
    if (heading) {
      nodes.push(sealScienceManuscriptNode({ id: parser.nextUuid(), revision: 1, kind: "heading", level: heading[1].length as 1 | 2 | 3 | 4, text: heading[2] }));
      index += 1;
      continue;
    }

    const fence = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)\s*$/u.exec(line.text);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].text.trim().startsWith(fence[1])) { body.push(lines[index].text); index += 1; }
      if (index >= lines.length) throw new Error(`science-manuscript-legacy-code-fence-unclosed-line-${line.number}`);
      index += 1;
      nodes.push(sealScienceManuscriptNode({ id: parser.nextUuid(), revision: 1, kind: "code", language: fence[2] || null, text: body.join("\n") }));
      continue;
    }

    if (/^\$\$/u.test(line.text)) {
      const body: string[] = [];
      let first = line.text.replace(/^\$\$\s*/u, "");
      let equationLabel: string | null = null;
      if (first && /\$\$/u.test(first)) {
        const close = first.lastIndexOf("$$");
        const suffix = first.slice(close + 2).trim();
        const labelMatch = /^\{#eq:([A-Za-z0-9_-]+)\}$/u.exec(suffix);
        equationLabel = labelMatch?.[1] ?? null;
        body.push(first.slice(0, close).trim());
        index += 1;
      } else {
        if (first) body.push(first);
        index += 1;
        let closed = false;
        while (index < lines.length) {
          const close = /^(.*?)\$\$\s*(?:\{#eq:([A-Za-z0-9_-]+)\})?\s*$/u.exec(lines[index].text);
          if (close) { if (close[1]) body.push(close[1]); equationLabel = close[2] ?? null; index += 1; closed = true; break; }
          body.push(lines[index].text);
          index += 1;
        }
        if (!closed) throw new Error(`science-manuscript-legacy-equation-unclosed-line-${line.number}`);
      }
      nodes.push(sealScienceManuscriptNode({ id: parser.nextUuid(), revision: 1, kind: "equation", tex: body.join("\n").trim(), label: equationLabel }));
      continue;
    }

    const placeholder = /^\{\{\s*(figure|table)\s*:\s*([^|}]+?)\s*(?:\|\s*(.*?))?\s*\}\}\s*$/u.exec(line.text);
    if (placeholder) {
      nodes.push(sealScienceManuscriptNode(placeholder[1] === "figure"
        ? { id: parser.nextUuid(), revision: 1, kind: "figure", locator: placeholder[2].trim(), caption: placeholder[3]?.trim() ?? "" }
        : { id: parser.nextUuid(), revision: 1, kind: "table", mode: "artifact", locator: placeholder[2].trim(), caption: placeholder[3]?.trim() ?? "" }));
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line.text)) {
      nodes.push(sealScienceManuscriptNode({ id: parser.nextUuid(), revision: 1, kind: "rule" }));
      index += 1;
      continue;
    }

    if (/^>\s?/u.test(line.text)) {
      const quote: LegacyLine[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index].text)) {
        quote.push({ text: lines[index].text.replace(/^>\s?/u, ""), number: lines[index].number });
        index += 1;
      }
      nodes.push(sealScienceManuscriptNode({ id: parser.nextUuid(), revision: 1, kind: "blockquote", children: parseLegacyBlocks(quote, parser) }));
      continue;
    }

    const listStart = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line.text);
    if (listStart) {
      const indent = listStart[1].length;
      const ordered = /^\d/u.test(listStart[2]);
      const start = ordered ? Number.parseInt(listStart[2], 10) : 1;
      const items: ScienceManuscriptListItem[] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(lines[index].text);
        if (!item || item[1].length !== indent || /^\d/u.test(item[2]) !== ordered) break;
        const itemLines: LegacyLine[] = [{ text: item[3], number: lines[index].number }];
        index += 1;
        while (index < lines.length) {
          if (!lines[index].text.trim()) { itemLines.push({ ...lines[index], text: "" }); index += 1; continue; }
          const following = /^(\s*)([-*+]|\d{1,3}[.)])\s+/u.exec(lines[index].text);
          if (following && following[1].length === indent && /^\d/u.test(following[2]) === ordered) break;
          const availableIndent = /^\s*/u.exec(lines[index].text)?.[0].length ?? 0;
          if (availableIndent <= indent) break;
          itemLines.push({ text: lines[index].text.slice(Math.min(lines[index].text.length, indent + 2)), number: lines[index].number });
          index += 1;
        }
        const itemNodes = parseLegacyBlocks(itemLines, parser);
        items.push({ nodes: itemNodes.length ? itemNodes : [paragraphNode(item[3], parser)] });
      }
      nodes.push(sealScienceManuscriptNode({ id: parser.nextUuid(), revision: 1, kind: "list", ordered, start, items }));
      continue;
    }

    const captionMatch = /^(?:Table|표)\s*[:.]\s*(.*?)\s*(?:\{#tab:([A-Za-z0-9_-]+)\})?\s*$/iu.exec(line.text);
    let tableIndex = index;
    if (captionMatch) {
      let lookahead = index + 1;
      while (lookahead < lines.length && !lines[lookahead].text.trim()) lookahead += 1;
      if (lookahead + 1 < lines.length && lines[lookahead].text.includes("|") && isTableSeparator(lines[lookahead + 1].text)) {
        pendingCaption = { caption: captionMatch[1], label: captionMatch[2] ?? null };
        tableIndex = lookahead;
      }
    }
    if (lines[tableIndex]?.text.includes("|") && isTableSeparator(lines[tableIndex + 1]?.text ?? "")) {
      const header = parseTableRow(lines[tableIndex].text);
      const align = parseTableAlign(lines[tableIndex + 1].text);
      if (header.length !== align.length) throw new Error(`science-manuscript-legacy-table-width-invalid-line-${lines[tableIndex].number}`);
      const rows: string[][] = [];
      index = tableIndex + 2;
      while (index < lines.length && lines[index].text.includes("|") && lines[index].text.trim()) {
        const row = parseTableRow(lines[index].text);
        if (row.length !== header.length) throw new Error(`science-manuscript-legacy-table-width-invalid-line-${lines[index].number}`);
        rows.push(row);
        index += 1;
      }
      nodes.push(sealScienceManuscriptNode({
        id: parser.nextUuid(), revision: 1, kind: "table", mode: "inline",
        caption: pendingCaption?.caption ?? "", label: pendingCaption?.label ?? null, align, header, rows,
      }));
      pendingCaption = null;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].text.trim() && (!paragraph.length || !startsBlock(lines, index))) {
      paragraph.push(lines[index].text);
      index += 1;
    }
    if (!paragraph.length) throw new Error(`science-manuscript-legacy-block-unhandled-line-${line.number}`);
    nodes.push(paragraphNode(paragraph.join("\n"), parser));
  }
  return nodes;
}

/**
 * Creates a fresh structured baseline from legacy Markdown. Every invocation
 * creates fresh identities unless the caller supplies explicitly fresh UUIDs;
 * no node identity is inferred from text, position, or content hashes.
 */
export function parseLegacyScienceManuscriptMarkdown(markdownValue: string, options: ParseLegacyScienceManuscriptOptions = {}): ScienceManuscriptDocument {
  const markdown = text(markdownValue, 20_000_000, "legacy-markdown", true);
  const seen = new Set<string>();
  const factory = options.createUuid ?? randomUUID;
  const nextUuid = (): string => {
    const id = uuid(factory(), "generated-id");
    if (seen.has(id)) throw new Error("science-manuscript-generated-identity-duplicate");
    seen.add(id);
    return id;
  };
  const supplied = (value: string | undefined, field: string): string => {
    if (value === undefined) return nextUuid();
    const id = uuid(value, field);
    if (seen.has(id)) throw new Error("science-manuscript-generated-identity-duplicate");
    seen.add(id);
    return id;
  };
  const documentId = supplied(options.documentId, "document-id");
  const identityEpoch = supplied(options.identityEpoch, "identity-epoch");
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n").map((line, index) => ({ text: line, number: index + 1 }));
  const nodes = parseLegacyBlocks(lines, { nextUuid });
  return sealScienceManuscriptDocument({ documentId, identityEpoch, revision: 1, nodes });
}

function validateAnchor(operation: ScienceManuscriptAnchorExpectation, nodes: ScienceManuscriptNode[]): number {
  if (operation.afterNodeId === null) {
    if (operation.expectedAfterNodeRevision !== null || operation.expectedAfterNodeContentSha256 !== null) {
      throw new Error("science-manuscript-operation-anchor-invalid");
    }
    return 0;
  }
  const anchorId = uuid(operation.afterNodeId, "operation-anchor-id");
  const anchorIndex = nodes.findIndex((node) => node.id === anchorId);
  if (anchorIndex < 0) throw new Error("science-manuscript-operation-anchor-missing");
  if (revision(operation.expectedAfterNodeRevision, "operation-anchor-revision") !== nodes[anchorIndex].revision
    || hash(operation.expectedAfterNodeContentSha256, "operation-anchor-content-sha256") !== nodes[anchorIndex].contentSha256) {
    throw new Error("science-manuscript-operation-anchor-stale");
  }
  return anchorIndex + 1;
}

function assertExpectedNode(operation: { nodeId: string; expectedRevision: number; expectedContentSha256: string }, nodes: ScienceManuscriptNode[]): number {
  const nodeId = uuid(operation.nodeId, "operation-node-id");
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new Error("science-manuscript-operation-node-missing");
  if (revision(operation.expectedRevision, "operation-node-revision") !== nodes[index].revision
    || hash(operation.expectedContentSha256, "operation-node-content-sha256") !== nodes[index].contentSha256) {
    throw new Error("science-manuscript-operation-node-stale");
  }
  return index;
}

export function validateScienceManuscriptOperation(value: unknown): ScienceManuscriptOperation {
  const operation = record(value);
  if (!operation || typeof operation.kind !== "string") throw new Error("science-manuscript-operation-invalid");
  const validateAnchorFields = (): ScienceManuscriptAnchorExpectation => {
    const result: ScienceManuscriptAnchorExpectation = {
      afterNodeId: operation.afterNodeId === null ? null : uuid(operation.afterNodeId, "operation-anchor-id"),
      expectedAfterNodeRevision: operation.expectedAfterNodeRevision === null ? null : revision(operation.expectedAfterNodeRevision, "operation-anchor-revision"),
      expectedAfterNodeContentSha256: operation.expectedAfterNodeContentSha256 === null ? null : hash(operation.expectedAfterNodeContentSha256, "operation-anchor-content-sha256"),
    };
    const empty = result.afterNodeId === null && result.expectedAfterNodeRevision === null && result.expectedAfterNodeContentSha256 === null;
    const anchored = result.afterNodeId !== null && result.expectedAfterNodeRevision !== null && result.expectedAfterNodeContentSha256 !== null;
    if (!empty && !anchored) throw new Error("science-manuscript-operation-anchor-invalid");
    return result;
  };
  if (operation.kind === "insert-node") {
    if (!exactKeys(operation, ["kind", "afterNodeId", "expectedAfterNodeRevision", "expectedAfterNodeContentSha256", "node"])) throw new Error("science-manuscript-operation-invalid");
    const node = validateScienceManuscriptNode(operation.node);
    // The pure model permits revision > 1 so a private inverse can restore a
    // deleted stable identity without an ABA reset. Public transaction entry
    // points enforce revision === 1 for ordinary user/assistant insertions.
    return { kind: "insert-node", ...validateAnchorFields(), node };
  }
  if (operation.kind === "insert-artifact") {
    if (!exactKeys(operation, ["kind", "afterNodeId", "expectedAfterNodeRevision", "expectedAfterNodeContentSha256", "nodeId", "nodeKind", "locator", "caption", "validationReceiptId"])) {
      throw new Error("science-manuscript-operation-invalid");
    }
    if (operation.nodeKind !== "figure" && operation.nodeKind !== "table") throw new Error("science-manuscript-operation-artifact-kind-invalid");
    return {
      kind: "insert-artifact", ...validateAnchorFields(), nodeId: uuid(operation.nodeId, "operation-node-id"),
      nodeKind: operation.nodeKind, locator: locator(operation.locator, "operation-artifact-locator"),
      caption: oneLine(operation.caption, 100_000, "operation-artifact-caption", true),
      validationReceiptId: uuid(operation.validationReceiptId, "operation-validation-receipt-id"),
    };
  }
  if (operation.kind === "replace-node") {
    if (!exactKeys(operation, ["kind", "nodeId", "expectedRevision", "expectedContentSha256", "replacement"])) throw new Error("science-manuscript-operation-invalid");
    return {
      kind: "replace-node", nodeId: uuid(operation.nodeId, "operation-node-id"), expectedRevision: revision(operation.expectedRevision, "operation-node-revision"),
      expectedContentSha256: hash(operation.expectedContentSha256, "operation-node-content-sha256"), replacement: validateScienceManuscriptNode(operation.replacement),
    };
  }
  if (operation.kind === "delete-node") {
    if (!exactKeys(operation, ["kind", "nodeId", "expectedRevision", "expectedContentSha256"])) throw new Error("science-manuscript-operation-invalid");
    return {
      kind: "delete-node", nodeId: uuid(operation.nodeId, "operation-node-id"), expectedRevision: revision(operation.expectedRevision, "operation-node-revision"),
      expectedContentSha256: hash(operation.expectedContentSha256, "operation-node-content-sha256"),
    };
  }
  if (operation.kind === "move-node") {
    if (!exactKeys(operation, ["kind", "nodeId", "expectedRevision", "expectedContentSha256", "afterNodeId", "expectedAfterNodeRevision", "expectedAfterNodeContentSha256"])) {
      throw new Error("science-manuscript-operation-invalid");
    }
    return {
      kind: "move-node", nodeId: uuid(operation.nodeId, "operation-node-id"), expectedRevision: revision(operation.expectedRevision, "operation-node-revision"),
      expectedContentSha256: hash(operation.expectedContentSha256, "operation-node-content-sha256"), ...validateAnchorFields(),
    };
  }
  throw new Error("science-manuscript-operation-kind-invalid");
}

/** Applies an ordered transaction to top-level blocks. The caller persists the returned revision atomically. */
export function applyScienceManuscriptOperations(value: ScienceManuscriptDocument, values: ScienceManuscriptOperation[]): ScienceManuscriptDocument {
  const document = validateScienceManuscriptDocument(value);
  if (!Array.isArray(values) || values.length < 1 || values.length > 1_000) throw new Error("science-manuscript-operations-invalid");
  const nodes = [...document.nodes];
  for (const raw of values) {
    const operation = validateScienceManuscriptOperation(raw);
    if (operation.kind === "insert-node") {
      if (nodes.some((node) => node.id === operation.node.id)) throw new Error("science-manuscript-operation-node-duplicate");
      nodes.splice(validateAnchor(operation, nodes), 0, operation.node);
      continue;
    }
    if (operation.kind === "insert-artifact") {
      if (nodes.some((node) => node.id === operation.nodeId)) throw new Error("science-manuscript-operation-node-duplicate");
      const node = sealScienceManuscriptNode(operation.nodeKind === "figure"
        ? { id: operation.nodeId, revision: 1, kind: "figure", locator: operation.locator, caption: operation.caption }
        : { id: operation.nodeId, revision: 1, kind: "table", mode: "artifact", locator: operation.locator, caption: operation.caption });
      nodes.splice(validateAnchor(operation, nodes), 0, node);
      continue;
    }
    if (operation.kind === "replace-node") {
      const index = assertExpectedNode(operation, nodes);
      if (operation.replacement.id !== operation.nodeId || operation.replacement.revision !== operation.expectedRevision + 1) {
        throw new Error("science-manuscript-operation-replacement-identity-invalid");
      }
      if (operation.replacement.contentSha256 === operation.expectedContentSha256) throw new Error("science-manuscript-operation-no-change");
      nodes[index] = operation.replacement;
      continue;
    }
    if (operation.kind === "delete-node") {
      nodes.splice(assertExpectedNode(operation, nodes), 1);
      continue;
    }
    const sourceIndex = assertExpectedNode(operation, nodes);
    if (operation.afterNodeId === operation.nodeId) throw new Error("science-manuscript-operation-move-self-invalid");
    const [moved] = nodes.splice(sourceIndex, 1);
    const targetIndex = validateAnchor(operation, nodes);
    nodes.splice(targetIndex, 0, moved);
  }
  return sealScienceManuscriptDocument({
    documentId: document.documentId,
    identityEpoch: document.identityEpoch,
    revision: document.revision + 1,
    nodes,
  });
}
