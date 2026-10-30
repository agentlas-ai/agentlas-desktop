/**
 * Confirm that a finished turn's answer can be read back from the chat, and settle it on its own when it cannot.
 *
 * The rule this serves (invocation/service.ts, the `final` event): a completion is published only after reopening the chat
 * can read the exact answer back. Treating "the row I looked up byte-for-byte is not there" as "the answer is lost" turned
 * finished answers into `result-not-durable` errors (observed in use, one millisecond after the row was saved) and,
 * behind the error, a second "Interrupted answer" copy of the same text. Nothing was wrong with the answer: the saved body and
 * the event's body differ legitimately (the store repairs mistyped ask markers; a firm or swarm producer saves the raw model
 * text where the event carries the cleaned copy; the 10-29/30 marker changes strip [quiet] and NEEDS-INPUT from the saved copy).
 *
 * Order, each step cheaper and stricter than the next:
 *  1. find the row (store/chats.ts findDurableAssistantMessage: by the producer's own message id, then the exact body, then
 *     the same body after the shared cleaning), with the store-lock retry of runWithStoreBusyRetry;
 *  2. a producer that saved no row (or whose row is gone) and is expected to have saved one: write it ONCE from the verified
 *     in-memory body, then read it back. Idempotent by construction: step 1 has just proved no row carries this body, and the
 *     write is skipped when a row appeared in between;
 *  3. the store cannot be read at all (still locked after the bounded retry) but the producer holds the id of a row it already
 *     committed: the write is the evidence, a refused read is not evidence of loss, so the answer stands.
 * `null` is returned only when the answer cannot be shown to be saved and could not be saved again (a real storage failure);
 * the caller then raises result-not-durable exactly as before.
 *
 * No electron import: Main and the daemon both finish runs.
 */
import { appendChatMessage, findDurableAssistantMessage, type DurableAssistantMatch } from "../store/chats";
import { isStoreBusyError, runWithStoreBusyRetry } from "../store/store-busy-retry";
import { applyFinalDisplayBackstop } from "../mcp/final-display-backstop";
import { stripAgentControlMarkers } from "../../shared/agent-control-markers";
import { stripPermissionEscalationMarker } from "../../shared/permission-escalation";
import { stripStrayProtocolTokens } from "../../shared/protocol-token-strip";

/**
 * The one cleaning both sides of a saved-answer comparison go through when the saved body is not byte-equal to the event's:
 * the display backstop's durable copy (surface fences, protocol payloads, ask fences made canonical), the permission-escalation
 * marker line, stray protocol tokens, the [quiet] / NEEDS-INPUT markers, CRLF and outer whitespace. Idempotent, so a row that
 * already holds the cleaned copy and a row that holds the model's raw text both reduce to the same string.
 */
export function canonicalFinalBody(value: string, locale: string): string {
  try {
    return stripAgentControlMarkers(stripStrayProtocolTokens(stripPermissionEscalationMarker(
      applyFinalDisplayBackstop(value, { locale, allowSurfaceRender: true }).durableText))).replace(/\r\n/g, "\n").trim();
  } catch {
    return value.replace(/\r\n/g, "\n").trim();
  }
}

export interface DurableResultConfirmation {
  /** The saved row. */
  messageId: string;
  /** The saved body, which is what a Goal binding must name. */
  text: string;
  via: DurableAssistantMatch["via"] | "restored" | "producer-committed";
}

export interface ConfirmDurableResultInput {
  chatId: string;
  /** The body the producer saved (durableTextForVerification), else the event's displayed body. */
  text: string;
  notBefore?: string;
  /** The id the producer got back when it saved the answer. */
  messageId?: string | null;
  canonical?: (value: string) => string;
  /** Present only for a producer that is expected to have saved this answer: a missing row is then written once. */
  restore?: { speakerAgentId?: string | null } | null;
  /** Test seams. */
  find?: typeof findDurableAssistantMessage;
  append?: typeof appendChatMessage;
  retry?: typeof runWithStoreBusyRetry;
}

export function confirmDurableAssistantResult(input: ConfirmDurableResultInput): DurableResultConfirmation | null {
  const find = input.find ?? findDurableAssistantMessage;
  const append = input.append ?? appendChatMessage;
  const retry = input.retry ?? runWithStoreBusyRetry;
  const messageId = typeof input.messageId === "string" && input.messageId.trim() ? input.messageId.trim() : null;
  const lookup = (): DurableAssistantMatch | null => find(input.chatId, input.text, {
    ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    ...(messageId ? { messageId } : {}),
    ...(input.canonical ? { canonical: input.canonical } : {}),
  });
  let found: DurableAssistantMatch | null;
  try {
    found = retry(lookup);
  } catch (error) {
    // Reading is what the store refused; the producer's own committed write is the evidence that the answer was saved.
    if (isStoreBusyError(error) && messageId) {
      console.warn(`[invocation] saved answer not re-read: store busy chat=${input.chatId} message=${messageId}`);
      return { messageId, text: input.text, via: "producer-committed" };
    }
    throw error;
  }
  if (found) return { messageId: found.id, text: found.text, via: found.via };
  if (!input.restore) return null;
  // Step 2. The write is the only thing that can fail here for a reason of the store, and it is not the model turn.
  const entry = retry(() => {
    const raced = lookup();
    if (raced) return null;
    return append(input.chatId, "assistant", input.text,
      input.restore?.speakerAgentId ? { speakerAgentId: input.restore.speakerAgentId } : undefined);
  });
  const reread = retry(() => find(input.chatId, entry ? entry.text : input.text, {
    ...(entry ? { messageId: entry.id } : {}),
    ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    ...(input.canonical ? { canonical: input.canonical } : {}),
  }));
  if (!reread) return null;
  return { messageId: reread.id, text: reread.text, via: entry ? "restored" : reread.via };
}
