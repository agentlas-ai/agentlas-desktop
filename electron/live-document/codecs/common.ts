import type { LiveDocumentModel, LiveFlowBlock } from "../../../shared/live-document";

export interface LiveDocumentCodec {
  /** Deterministic: the same bytes always give the same ids (the journal folds over this). */
  parse(bytes: Uint8Array): LiveDocumentModel;
  /** Writes `final` into the original package, touching only what differs from `original`. */
  write(bytes: Uint8Array, original: LiveDocumentModel, final: LiveDocumentModel): Uint8Array;
}

export class LiveDocumentCodecError extends Error {
  constructor(readonly reason: string, detail?: string) { super(detail ? `${reason}: ${detail}` : reason); }
}

export function flowBlocks(model: LiveDocumentModel): LiveFlowBlock[] {
  if (model.kind !== "flow") throw new LiveDocumentCodecError("model_kind_mismatch", model.kind);
  return model.blocks;
}

/**
 * Where new blocks go relative to the original ones. Key: id of the closest preceding ORIGINAL block in the final
 * order ("^" = before every original block). Deleted originals simply drop out.
 */
export function planFlowInsertions(originalIds: ReadonlySet<string>, finalBlocks: LiveFlowBlock[]): Map<string, LiveFlowBlock[]> {
  const plan = new Map<string, LiveFlowBlock[]>();
  let anchor = "^";
  for (const block of finalBlocks) {
    if (originalIds.has(block.id)) { anchor = block.id; continue; }
    const list = plan.get(anchor) ?? [];
    list.push(block);
    plan.set(anchor, list);
  }
  return plan;
}

export function blockChanged(before: LiveFlowBlock | undefined, after: LiveFlowBlock): boolean {
  return !before || JSON.stringify(before) !== JSON.stringify(after);
}

/** Lines of a table-cell text mapped onto `count` existing paragraphs: extra lines fold into the last one. */
export function spreadLines(text: string, count: number): string[] {
  const lines = text.split("\n");
  if (count <= 0) return [text];
  if (lines.length <= count) return [...lines, ...Array(count - lines.length).fill("")];
  return [...lines.slice(0, count - 1), lines.slice(count - 1).join("\n")];
}

export function displayNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || raw.trim() === "") return raw;
  if (Number.isInteger(value)) return String(value);
  return String(Number.parseFloat(value.toPrecision(15)));
}
