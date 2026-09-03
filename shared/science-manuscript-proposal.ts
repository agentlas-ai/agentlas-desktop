import { createHash } from "node:crypto";
import {
  serializeScienceManuscriptDocument,
  validateScienceManuscriptDocument,
  validateScienceManuscriptOperation,
  type ScienceManuscriptDocument,
  type ScienceManuscriptNode,
  type ScienceManuscriptOperation,
} from "./science-manuscript-document";

export const SCIENCE_MANUSCRIPT_SELECTION_CONTEXT_SCHEMA = "agentlas.science.manuscript-selection-context/v1" as const;
export const SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_SCHEMA = "agentlas.science.manuscript-edit-proposal/v1" as const;
export const SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_DECISION_SCHEMA = "agentlas.science.manuscript-edit-proposal-decision/v1" as const;

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface ScienceManuscriptSelectionContext {
  schemaVersion: typeof SCIENCE_MANUSCRIPT_SELECTION_CONTEXT_SCHEMA;
  id: string;
  requestId: string;
  projectId: string;
  manuscriptId: string;
  manuscriptVersion: number;
  manuscriptContentSha256: string;
  manuscriptDocumentSha256: string;
  nodeId: string;
  nodeRevision: number;
  nodeContentSha256: string;
  /** UTF-16 offsets into `scienceManuscriptNodeSelectionText(node)`. */
  startOffset: number;
  endOffset: number;
  selectedText: string;
  selectedTextSha256: string;
  sourceTextSha256: string;
  contextSha256: string;
  createdAt: string;
}

export interface CreateScienceManuscriptSelectionContextInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedDocumentSha256: string;
  nodeId: string;
  expectedNodeRevision: number;
  expectedNodeContentSha256: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
}

export interface ScienceManuscriptEditProposalDecision {
  schemaVersion: typeof SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_DECISION_SCHEMA;
  id: string;
  requestId: string;
  projectId: string;
  manuscriptId: string;
  proposalId: string;
  decision: "applied" | "rejected";
  resultingTransactionId: string | null;
  resultVersion: number | null;
  resultContentSha256: string | null;
  resultDocumentSha256: string | null;
  reason: string | null;
  decisionSha256: string;
  createdAt: string;
}

export type ScienceManuscriptEditProposalStatus = "pending" | "stale" | "applied" | "rejected";

/** Immutable assistant-authored payload plus a read-time decision/status projection. */
export interface ScienceManuscriptEditProposal {
  schemaVersion: typeof SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_SCHEMA;
  id: string;
  requestId: string;
  projectId: string;
  manuscriptId: string;
  baseVersion: number;
  baseContentSha256: string;
  baseDocumentSha256: string;
  operations: ScienceManuscriptOperation[];
  operationsSha256: string;
  previewMarkdown: string;
  previewContentSha256: string;
  previewDocument: ScienceManuscriptDocument;
  previewDocumentSha256: string;
  summary: string;
  rationale: string;
  conversationId: string | null;
  messageId: string | null;
  selectionContextIds: string[];
  payloadSha256: string;
  createdAt: string;
  status: ScienceManuscriptEditProposalStatus;
  decision: ScienceManuscriptEditProposalDecision | null;
}

export interface CreateScienceManuscriptEditProposalInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedDocumentSha256: string;
  operations: ScienceManuscriptOperation[];
  summary: string;
  rationale: string;
  conversationId?: string | null;
  messageId?: string | null;
  selectionContextIds?: string[];
}

export interface ApplyScienceManuscriptEditProposalInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  proposalId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedDocumentSha256: string;
}

export interface RejectScienceManuscriptEditProposalInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  proposalId: string;
  reason: string | null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().flatMap((key) => (
    record[key] === undefined ? [] : [[key, canonicalValue(record[key])]]
  )));
}

export function scienceManuscriptProposalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function scienceManuscriptProposalSha256(value: unknown): string {
  return createHash("sha256").update(scienceManuscriptProposalJson(value), "utf8").digest("hex");
}

export function scienceManuscriptProposalTextSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`science-manuscript-${field}-invalid`);
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`science-manuscript-${field}-invalid`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`science-manuscript-${field}-invalid`);
  }
  return Number(value);
}

function text(value: unknown, maximum: number, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new Error(`science-manuscript-${field}-invalid`);
  }
  return value.replace(/\r\n?/gu, "\n");
}

function timestamp(value: unknown, field: string): string {
  const normalized = text(value, 64, field);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`science-manuscript-${field}-invalid`);
  return normalized;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function nullableHash(value: unknown, field: string): string | null {
  return value === null ? null : hash(value, field);
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, 1, Number.MAX_SAFE_INTEGER, field);
}

function nullableText(value: unknown, maximum: number, field: string): string | null {
  return value === null ? null : text(value, maximum, field);
}

function nodeSelectionText(node: ScienceManuscriptNode): string {
  if (node.kind === "heading") return node.text;
  if (node.kind === "paragraph") return node.markdown;
  if (node.kind === "equation") return node.tex;
  if (node.kind === "figure") return node.caption;
  if (node.kind === "table") {
    if (node.mode === "artifact") return node.caption;
    return [node.caption, node.header.join("\t"), ...node.rows.map((row) => row.join("\t"))].join("\n");
  }
  if (node.kind === "code") return node.text;
  if (node.kind === "rule") return "";
  if (node.kind === "blockquote") return node.children.map(nodeSelectionText).join("\n\n");
  return node.items.flatMap((item) => item.nodes.map(nodeSelectionText)).join("\n");
}

export function scienceManuscriptNodeSelectionText(node: ScienceManuscriptNode): string {
  return nodeSelectionText(node);
}

export function findScienceManuscriptNode(documentValue: ScienceManuscriptDocument, nodeId: string): ScienceManuscriptNode | null {
  const document = validateScienceManuscriptDocument(documentValue);
  const wanted = uuid(nodeId, "selection-node-id");
  const visit = (nodes: ScienceManuscriptNode[]): ScienceManuscriptNode | null => {
    for (const node of nodes) {
      if (node.id === wanted) return node;
      if (node.kind === "blockquote") {
        const found = visit(node.children);
        if (found) return found;
      }
      if (node.kind === "list") {
        for (const item of node.items) {
          const found = visit(item.nodes);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(document.nodes);
}

function selectionIntegrityInput(value: Omit<ScienceManuscriptSelectionContext, "contextSha256">): Record<string, unknown> {
  const { contextSha256: _contextSha256, ...unsigned } = value as ScienceManuscriptSelectionContext;
  return unsigned;
}

export function scienceManuscriptSelectionContextSha256(
  value: Omit<ScienceManuscriptSelectionContext, "contextSha256">,
): string {
  return scienceManuscriptProposalSha256(selectionIntegrityInput(value));
}

export function validateScienceManuscriptSelectionContext(value: unknown): ScienceManuscriptSelectionContext {
  const item = record(value);
  const keys = ["schemaVersion", "id", "requestId", "projectId", "manuscriptId", "manuscriptVersion", "manuscriptContentSha256",
    "manuscriptDocumentSha256", "nodeId", "nodeRevision", "nodeContentSha256", "startOffset", "endOffset", "selectedText",
    "selectedTextSha256", "sourceTextSha256", "contextSha256", "createdAt"];
  if (!item || !exactKeys(item, keys) || item.schemaVersion !== SCIENCE_MANUSCRIPT_SELECTION_CONTEXT_SCHEMA) {
    throw new Error("science-manuscript-selection-integrity-failed");
  }
  try {
    const context: ScienceManuscriptSelectionContext = {
      schemaVersion: SCIENCE_MANUSCRIPT_SELECTION_CONTEXT_SCHEMA,
      id: uuid(item.id, "selection-id"),
      requestId: uuid(item.requestId, "selection-request-id"),
      projectId: uuid(item.projectId, "selection-project-id"),
      manuscriptId: uuid(item.manuscriptId, "selection-manuscript-id"),
      manuscriptVersion: integer(item.manuscriptVersion, 1, Number.MAX_SAFE_INTEGER, "selection-version"),
      manuscriptContentSha256: hash(item.manuscriptContentSha256, "selection-content-sha256"),
      manuscriptDocumentSha256: hash(item.manuscriptDocumentSha256, "selection-document-sha256"),
      nodeId: uuid(item.nodeId, "selection-node-id"),
      nodeRevision: integer(item.nodeRevision, 1, Number.MAX_SAFE_INTEGER, "selection-node-revision"),
      nodeContentSha256: hash(item.nodeContentSha256, "selection-node-content-sha256"),
      startOffset: integer(item.startOffset, 0, 2_000_000, "selection-start-offset"),
      endOffset: integer(item.endOffset, 0, 2_000_000, "selection-end-offset"),
      selectedText: text(item.selectedText, 2_000_000, "selection-text", true),
      selectedTextSha256: hash(item.selectedTextSha256, "selection-text-sha256"),
      sourceTextSha256: hash(item.sourceTextSha256, "selection-source-text-sha256"),
      contextSha256: hash(item.contextSha256, "selection-context-sha256"),
      createdAt: timestamp(item.createdAt, "selection-created-at"),
    };
    if (context.startOffset > context.endOffset
      || scienceManuscriptProposalTextSha256(context.selectedText) !== context.selectedTextSha256
      || scienceManuscriptSelectionContextSha256(context) !== context.contextSha256) {
      throw new Error("integrity");
    }
    return context;
  } catch {
    throw new Error("science-manuscript-selection-integrity-failed");
  }
}

function decisionIntegrityInput(value: Omit<ScienceManuscriptEditProposalDecision, "decisionSha256">): Record<string, unknown> {
  const { decisionSha256: _decisionSha256, ...unsigned } = value as ScienceManuscriptEditProposalDecision;
  return unsigned;
}

export function scienceManuscriptEditProposalDecisionSha256(
  value: Omit<ScienceManuscriptEditProposalDecision, "decisionSha256">,
): string {
  return scienceManuscriptProposalSha256(decisionIntegrityInput(value));
}

export function validateScienceManuscriptEditProposalDecision(value: unknown): ScienceManuscriptEditProposalDecision {
  const item = record(value);
  const keys = ["schemaVersion", "id", "requestId", "projectId", "manuscriptId", "proposalId", "decision", "resultingTransactionId",
    "resultVersion", "resultContentSha256", "resultDocumentSha256", "reason", "decisionSha256", "createdAt"];
  if (!item || !exactKeys(item, keys) || item.schemaVersion !== SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_DECISION_SCHEMA
    || (item.decision !== "applied" && item.decision !== "rejected")) {
    throw new Error("science-manuscript-proposal-decision-integrity-failed");
  }
  try {
    const decision: ScienceManuscriptEditProposalDecision = {
      schemaVersion: SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_DECISION_SCHEMA,
      id: uuid(item.id, "proposal-decision-id"),
      requestId: uuid(item.requestId, "proposal-decision-request-id"),
      projectId: uuid(item.projectId, "proposal-decision-project-id"),
      manuscriptId: uuid(item.manuscriptId, "proposal-decision-manuscript-id"),
      proposalId: uuid(item.proposalId, "proposal-decision-proposal-id"),
      decision: item.decision,
      resultingTransactionId: nullableUuid(item.resultingTransactionId, "proposal-transaction-id"),
      resultVersion: nullablePositiveInteger(item.resultVersion, "proposal-result-version"),
      resultContentSha256: nullableHash(item.resultContentSha256, "proposal-result-content-sha256"),
      resultDocumentSha256: nullableHash(item.resultDocumentSha256, "proposal-result-document-sha256"),
      reason: nullableText(item.reason, 4_000, "proposal-decision-reason"),
      decisionSha256: hash(item.decisionSha256, "proposal-decision-sha256"),
      createdAt: timestamp(item.createdAt, "proposal-decision-created-at"),
    };
    const appliedComplete = decision.decision === "applied" && decision.resultingTransactionId !== null
      && decision.resultVersion !== null && decision.resultContentSha256 !== null && decision.resultDocumentSha256 !== null;
    const rejectedComplete = decision.decision === "rejected" && decision.resultingTransactionId === null
      && decision.resultVersion === null && decision.resultContentSha256 === null && decision.resultDocumentSha256 === null;
    if ((!appliedComplete && !rejectedComplete) || scienceManuscriptEditProposalDecisionSha256(decision) !== decision.decisionSha256) {
      throw new Error("integrity");
    }
    return decision;
  } catch {
    throw new Error("science-manuscript-proposal-decision-integrity-failed");
  }
}

type ProposalPayload = Omit<ScienceManuscriptEditProposal, "payloadSha256" | "status" | "decision">;

export function scienceManuscriptEditProposalPayloadSha256(value: ProposalPayload): string {
  return scienceManuscriptProposalSha256(value);
}

export function validateScienceManuscriptEditProposalPayload(value: unknown): Omit<ScienceManuscriptEditProposal, "status" | "decision"> {
  const item = record(value);
  const keys = ["schemaVersion", "id", "requestId", "projectId", "manuscriptId", "baseVersion", "baseContentSha256", "baseDocumentSha256",
    "operations", "operationsSha256", "previewMarkdown", "previewContentSha256", "previewDocument", "previewDocumentSha256", "summary",
    "rationale", "conversationId", "messageId", "selectionContextIds", "payloadSha256", "createdAt"];
  if (!item || !exactKeys(item, keys) || item.schemaVersion !== SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_SCHEMA || !Array.isArray(item.operations)
    || item.operations.length < 1 || item.operations.length > 1_000 || !Array.isArray(item.selectionContextIds) || item.selectionContextIds.length > 100) {
    throw new Error("science-manuscript-proposal-integrity-failed");
  }
  try {
    const operations = item.operations.map(validateScienceManuscriptOperation);
    const selectionContextIds = item.selectionContextIds.map((id) => uuid(id, "proposal-selection-context-id"));
    if (new Set(selectionContextIds).size !== selectionContextIds.length) throw new Error("duplicate");
    const previewDocument = validateScienceManuscriptDocument(item.previewDocument);
    const proposal: Omit<ScienceManuscriptEditProposal, "status" | "decision"> = {
      schemaVersion: SCIENCE_MANUSCRIPT_EDIT_PROPOSAL_SCHEMA,
      id: uuid(item.id, "proposal-id"),
      requestId: uuid(item.requestId, "proposal-request-id"),
      projectId: uuid(item.projectId, "proposal-project-id"),
      manuscriptId: uuid(item.manuscriptId, "proposal-manuscript-id"),
      baseVersion: integer(item.baseVersion, 1, Number.MAX_SAFE_INTEGER, "proposal-base-version"),
      baseContentSha256: hash(item.baseContentSha256, "proposal-base-content-sha256"),
      baseDocumentSha256: hash(item.baseDocumentSha256, "proposal-base-document-sha256"),
      operations,
      operationsSha256: hash(item.operationsSha256, "proposal-operations-sha256"),
      previewMarkdown: text(item.previewMarkdown, 2_000_000, "proposal-preview-markdown", true),
      previewContentSha256: hash(item.previewContentSha256, "proposal-preview-content-sha256"),
      previewDocument,
      previewDocumentSha256: hash(item.previewDocumentSha256, "proposal-preview-document-sha256"),
      summary: text(item.summary, 1_000, "proposal-summary"),
      rationale: text(item.rationale, 20_000, "proposal-rationale"),
      conversationId: nullableUuid(item.conversationId, "proposal-conversation-id"),
      messageId: nullableUuid(item.messageId, "proposal-message-id"),
      selectionContextIds,
      payloadSha256: hash(item.payloadSha256, "proposal-payload-sha256"),
      createdAt: timestamp(item.createdAt, "proposal-created-at"),
    };
    const { payloadSha256: _payloadSha256, ...payload } = proposal;
    if ((proposal.messageId !== null && proposal.conversationId === null)
      || scienceManuscriptProposalSha256(operations) !== proposal.operationsSha256
      || previewDocument.documentSha256 !== proposal.previewDocumentSha256
      || serializeScienceManuscriptDocument(previewDocument) !== proposal.previewMarkdown
      || scienceManuscriptProposalTextSha256(proposal.previewMarkdown) !== proposal.previewContentSha256
      || scienceManuscriptEditProposalPayloadSha256(payload) !== proposal.payloadSha256) {
      throw new Error("integrity");
    }
    return proposal;
  } catch {
    throw new Error("science-manuscript-proposal-integrity-failed");
  }
}
