import { createHash, randomUUID } from "node:crypto";
import {
  applyScienceManuscriptOperations,
  parseLegacyScienceManuscriptMarkdown,
  sealScienceManuscriptDocument,
  sealScienceManuscriptNode,
  serializeScienceManuscriptDocument,
  validateScienceManuscriptDocument,
  validateScienceManuscriptOperation,
  type ScienceManuscriptDocument,
  type ScienceManuscriptNode,
  type ScienceManuscriptNodeInput,
  type ScienceManuscriptOperation,
} from "../../../shared/science-manuscript-document";

/** Private result used by the store. Inverses are persisted but never accepted from an untrusted caller. */
export interface ScienceManuscriptOperationApplication {
  document: ScienceManuscriptDocument;
  inverseOperations: ScienceManuscriptOperation[];
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().flatMap((key) => (
    record[key] === undefined ? [] : [[key, canonicalValue(record[key])]]
  )));
}

export function scienceManuscriptTransactionJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function scienceManuscriptTransactionSha256(value: unknown): string {
  return createHash("sha256").update(scienceManuscriptTransactionJson(value), "utf8").digest("hex");
}

/**
 * Produces a fresh identity epoch for a raw Markdown version without ever
 * changing the renderer-facing bytes. Most manuscripts split into real blocks;
 * syntax outside the strict parser falls back to one addressable paragraph so
 * migration cannot rewrite or invalidate an already published version.
 */
export function createScienceManuscriptCompatibilityDocument(markdown: string): ScienceManuscriptDocument {
  let parsed: ScienceManuscriptDocument | null = null;
  try {
    parsed = parseLegacyScienceManuscriptMarkdown(markdown);
    if (serializeScienceManuscriptDocument(parsed) === markdown) return parsed;
  } catch {
    // The opaque block below deliberately preserves unsupported legacy syntax.
  }
  const opaque = sealScienceManuscriptNode({
    id: randomUUID(),
    revision: 1,
    kind: "paragraph",
    markdown,
    citationMarks: [],
  });
  return sealScienceManuscriptDocument({
    documentId: parsed?.documentId ?? randomUUID(),
    identityEpoch: parsed?.identityEpoch ?? randomUUID(),
    revision: 1,
    nodes: [opaque],
  });
}

function cloneNode(node: ScienceManuscriptNode): ScienceManuscriptNode {
  return JSON.parse(JSON.stringify(node)) as ScienceManuscriptNode;
}

function resealNode(node: ScienceManuscriptNode, revision: number): ScienceManuscriptNode {
  const { contentSha256: _contentSha256, ...input } = cloneNode(node);
  return sealScienceManuscriptNode({ ...input, revision } as ScienceManuscriptNodeInput);
}

function anchorBefore(
  desiredNodes: ScienceManuscriptNode[],
  nodeId: string,
  currentNodes: ScienceManuscriptNode[],
): {
  afterNodeId: string | null;
  expectedAfterNodeRevision: number | null;
  expectedAfterNodeContentSha256: string | null;
} {
  const desiredIndex = desiredNodes.findIndex((node) => node.id === nodeId);
  for (let index = desiredIndex - 1; index >= 0; index -= 1) {
    const anchor = currentNodes.find((node) => node.id === desiredNodes[index].id);
    if (anchor) {
      return {
        afterNodeId: anchor.id,
        expectedAfterNodeRevision: anchor.revision,
        expectedAfterNodeContentSha256: anchor.contentSha256,
      };
    }
  }
  return { afterNodeId: null, expectedAfterNodeRevision: null, expectedAfterNodeContentSha256: null };
}

function nodeAt(document: ScienceManuscriptDocument, nodeId: string): ScienceManuscriptNode {
  const node = document.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("science-manuscript-inverse-node-missing");
  return node;
}

/**
 * Applies one public edit transaction and derives a CAS-protected inverse.
 *
 * The inverse is generated against the final node state, not merely by reversing
 * the request JSON. This matters for multi-operation edits where a later move or
 * replacement changes the anchor/revision an earlier inverse must address.
 */
export function applyScienceManuscriptTransactionOperations(
  value: ScienceManuscriptDocument,
  rawOperations: ScienceManuscriptOperation[],
  options: { trustedRestore?: boolean } = {},
): ScienceManuscriptOperationApplication {
  const before = validateScienceManuscriptDocument(value);
  if (!Array.isArray(rawOperations) || rawOperations.length < 1 || rawOperations.length > 1_000) {
    throw new Error("science-manuscript-operations-invalid");
  }
  const operations = rawOperations.map(validateScienceManuscriptOperation);
  for (const operation of operations) {
    if (operation.kind === "insert-node" && operation.node.revision !== 1) {
      if (!options.trustedRestore) throw new Error("science-manuscript-operation-insert-revision-invalid");
    }
  }

  type ForwardRecord = {
    operation: ScienceManuscriptOperation;
    before: ScienceManuscriptDocument;
  };
  const records: ForwardRecord[] = [];
  let cursor = before;
  for (const operation of operations) {
    const next = applyScienceManuscriptOperations(cursor, [operation]);
    records.push({ operation, before: cursor });
    cursor = next;
  }
  const document = applyScienceManuscriptOperations(before, operations);
  if (scienceManuscriptTransactionJson(before.nodes) === scienceManuscriptTransactionJson(document.nodes)) {
    throw new Error("science-manuscript-transaction-noop");
  }

  const inverseOperations: ScienceManuscriptOperation[] = [];
  let inverseCursor = document;
  for (const record of [...records].reverse()) {
    const operation = record.operation;
    let inverse: ScienceManuscriptOperation;
    if (operation.kind === "insert-node") {
      const current = nodeAt(inverseCursor, operation.node.id);
      inverse = { kind: "delete-node", nodeId: current.id, expectedRevision: current.revision, expectedContentSha256: current.contentSha256 };
    } else if (operation.kind === "insert-artifact") {
      const current = nodeAt(inverseCursor, operation.nodeId);
      inverse = { kind: "delete-node", nodeId: current.id, expectedRevision: current.revision, expectedContentSha256: current.contentSha256 };
    } else if (operation.kind === "delete-node") {
      const deleted = nodeAt(record.before, operation.nodeId);
      inverse = {
        kind: "insert-node",
        ...anchorBefore(record.before.nodes, deleted.id, inverseCursor.nodes),
        node: resealNode(deleted, deleted.revision + 1),
      };
    } else if (operation.kind === "replace-node") {
      const current = nodeAt(inverseCursor, operation.nodeId);
      const original = nodeAt(record.before, operation.nodeId);
      inverse = {
        kind: "replace-node",
        nodeId: current.id,
        expectedRevision: current.revision,
        expectedContentSha256: current.contentSha256,
        replacement: resealNode(original, current.revision + 1),
      };
    } else {
      const current = nodeAt(inverseCursor, operation.nodeId);
      inverse = {
        kind: "move-node",
        nodeId: current.id,
        expectedRevision: current.revision,
        expectedContentSha256: current.contentSha256,
        ...anchorBefore(record.before.nodes, current.id, inverseCursor.nodes.filter((node) => node.id !== current.id)),
      };
    }
    inverseOperations.push(inverse);
    inverseCursor = applyScienceManuscriptOperations(inverseCursor, [inverse]);
  }

  // Applying the inverse to the result must restore the same semantics and order.
  // Node revisions can advance during undo to prevent ABA; document identity/epoch stay fixed.
  const restored = applyScienceManuscriptOperations(document, inverseOperations);
  const semantic = (nodes: ScienceManuscriptNode[]) => nodes.map((node) => {
    const { revision: _revision, contentSha256: _contentSha256, ...copy } = cloneNode(node);
    return copy;
  });
  if (scienceManuscriptTransactionJson(semantic(restored.nodes)) !== scienceManuscriptTransactionJson(semantic(before.nodes))) {
    throw new Error("science-manuscript-inverse-integrity-failed");
  }
  return { document, inverseOperations };
}
