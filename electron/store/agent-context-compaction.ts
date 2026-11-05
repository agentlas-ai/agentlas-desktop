import { createHash } from "node:crypto";

/**
 * Compaction of the agent context journal rows that no reader uses after a few days (db-retention-policy.ts rows
 * `agent_context_entries.tool` and `agent_context_entries.turn-context`). Pure functions: the row keeps its seq, event_id,
 * kind, digest and producer_binding, so cursors, citations and the idempotent append check (event_id + digest) are untouched.
 *
 * What the readers use (runtime/agent-context.ts materializeAgentContextHistory, memory/session-checkpoints.ts):
 *   tool          name, callId, isError, artifactPaths, imageDataUrl, createdAt, the first 160 characters of arguments, and
 *                 whether `result` is PRESENT (an absent result marks an unresolved call). The result itself is never replayed.
 *   turn-context  nothing in replay; acknowledgeDelivery hashes payload.stableBlocks of the rows of its own delivery range.
 */

export const COMPACTED_MARK = "compacted";
export const TOOL_ARGUMENT_KEEP_CHARS = 2048;
const SUPERSEDED_ARGUMENT_CHARS = 256;
const SHA256 = /^[a-f0-9]{64}$/;

/** Same function the journal store hashes a stable block with (store/agent-context.ts hash). */
export function agentContextBlockHash(block: string): string {
  return createHash("sha256").update(JSON.stringify(block)).digest("hex");
}

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

function parseObject(payloadJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** The text a replay shows of an `arguments` value, whichever way it was stored. */
function argumentText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/**
 * @param superseded the row is NOT the last row of its callId: the replay skips it, so only identity stays.
 * @returns the replacement payload, or null when nothing would shrink.
 */
export function compactToolPayload(payloadJson: string, superseded: boolean): string | null {
  const payload = parseObject(payloadJson);
  if (!payload || payload[COMPACTED_MARK] === true) return null;
  const next: Record<string, unknown> = { ...payload };
  if (superseded) {
    for (const key of Object.keys(next)) {
      if (!["name", "createdAt", "callId", "isError", "origin", "channel"].includes(key) && key !== "arguments") delete next[key];
    }
    if (next.arguments !== undefined) next.arguments = argumentText(next.arguments).slice(0, SUPERSEDED_ARGUMENT_CHARS);
  } else {
    if (next.arguments !== undefined) {
      const text = argumentText(next.arguments);
      next.arguments = text.length > TOOL_ARGUMENT_KEEP_CHARS ? text.slice(0, TOOL_ARGUMENT_KEEP_CHARS) : next.arguments;
    }
    if (next.result !== undefined) {
      const text = typeof next.result === "string" ? next.result : JSON.stringify(next.result) ?? "";
      // PRESENT, never deleted: session-checkpoints.ts lists a call as unresolved when `result === undefined`.
      next.result = `[result compacted: ${Buffer.byteLength(text)} bytes, sha256 ${sha256(text)}]`;
    }
  }
  next[COMPACTED_MARK] = true;
  const out = JSON.stringify(next);
  return out.length < payloadJson.length ? out : null;
}

export function compactTurnContextPayload(payloadJson: string): string | null {
  const payload = parseObject(payloadJson);
  if (!payload || payload[COMPACTED_MARK] === true) return null;
  const text = typeof payload.text === "string" ? payload.text : "";
  const blocks = Array.isArray(payload.stableBlocks) ? payload.stableBlocks.filter((block): block is string => typeof block === "string" && block !== "") : [];
  const next: Record<string, unknown> = { text: "", textBytes: Buffer.byteLength(text), textSha256: sha256(text), [COMPACTED_MARK]: true };
  if (blocks.length) next.stableBlockHashes = blocks.map(agentContextBlockHash);
  if (Array.isArray(payload.stableBlockHashes)) next.stableBlockHashes = payload.stableBlockHashes;
  if (typeof payload.generation === "number") next.generation = payload.generation;
  const out = JSON.stringify(next);
  return out.length < payloadJson.length ? out : null;
}

/** Hashes a compacted turn-context row contributes to the stable-block ACK index. */
export function stableBlockHashesOf(payload: Record<string, unknown>): string[] {
  const hashes = Array.isArray(payload.stableBlockHashes)
    ? payload.stableBlockHashes.filter((hash): hash is string => typeof hash === "string" && SHA256.test(hash)) : [];
  return hashes;
}
