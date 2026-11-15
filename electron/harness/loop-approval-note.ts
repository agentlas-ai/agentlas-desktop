import { createHash } from "node:crypto";

/*
 * "The in-process loop already asked the owner for this exact call".
 *
 * The API and local-model runtimes (byok, agentlas, agentlas-local, ollama, lmstudio, mlx) reach an MCP server through the loop's own approval (runtime/local-tool-loop.ts)
 * AND through the Main proxy that fronts the server (mcp-tools/proxy-session.ts), so one call raised the same card twice (money twice, measured: dd3-parity-gate OBSERVATION).
 * The loop writes a note when its own window answered "go" for a call it treated as a change; the proxy takes the note once and does not ask the same card again. The note is
 * made ONLY after the loop's arbiter answered not-"deny", is keyed by server + tool + the call's own arguments, lives at most NOTE_MS and at most NOTE_MAX at once (oldest
 * first), and is read only by a proxy of an in-process-loop runtime. A call with no note (the loop asked nothing: a read, a collection) is decided by the proxy as before, so
 * no call ends up asked zero times. Memory only, nothing on disk. No Electron import.
 *
 * TR-desktop 4 (audit "low 4"): the note belongs to the EXECUTION that asked, not only to the call's words. The loop and the proxy of one turn share the turn's run-slot lease (selection.ts
 * `runWithSlotLease` wraps the whole runner, the launch is prepared inside it: `currentSlotLease()` on the loop's side, `gate.slotLease` on the proxy's), so a note made by one turn is
 * never taken by another turn's identical call (same tool, same arguments, within the minute: that call asks its own card). No lease on either side (a run with no slot) = no scope, the earlier behaviour.
 */
/** basis: the same ceiling the connected-app ticket keeps (host-call-ticket.ts TICKET_MS): the longest between a window's answer and the frame reaching the proxy. Reached: the note is dropped and the proxy asks (one card more, never one less). */
export const NOTE_MS = 60_000;
/** basis: the same 8 as TICKET_MAX (the server's concurrent-call 4 times two attempts). Reached: the oldest note is dropped (that call is asked again by the proxy). */
export const NOTE_MAX = 8;

const notes = new Map<string, number>();
/** One small number per turn scope (the lease object); the map holds no strong reference, so it ends with the turn. */
const scopeIds = new WeakMap<object, number>();
let scopeCount = 0;
const scopeOf = (scope: object | undefined): number => { if (!scope) return 0; let id = scopeIds.get(scope); if (id === undefined) { scopeCount += 1; id = scopeCount; scopeIds.set(scope, id); } return id; };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}
const digest = (serverKey: string, tool: string, args: unknown, scope?: object): string => createHash("sha256").update(`${scopeOf(scope)}\n${serverKey}\n${tool}\n${canonical(args ?? {})}`).digest("hex");

export function noteLoopApproval(serverKey: string, tool: string, args: unknown, now = Date.now(), scope?: object): void {
  for (const [key, expires] of notes) if (expires <= now) notes.delete(key);
  notes.set(`${digest(serverKey, tool, args, scope)}#${now}#${notes.size}`, now + NOTE_MS);
  while (notes.size > NOTE_MAX) { const oldest = notes.keys().next().value; if (oldest === undefined) break; notes.delete(oldest); }
}
/** Takes one note of this exact call; true when there was one. */
export function consumeLoopApproval(serverKey: string, tool: string, args: unknown, now = Date.now(), scope?: object): boolean {
  const want = `${digest(serverKey, tool, args, scope)}#`;
  for (const [key, expires] of notes) {
    if (expires <= now) { notes.delete(key); continue; }
    if (key.startsWith(want)) { notes.delete(key); return true; }
  }
  return false;
}
export function loopApprovalNoteCount(): number { return notes.size; }
