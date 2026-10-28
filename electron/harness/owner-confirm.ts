import { OWNER_CONFIRM_VIEW } from "../../shared/ui-instances";
import type { HarnessCallContext } from "./capability-ports";

/*
 * Owner confirmation card: the common way a tool proposes something only the owner may save.
 *
 *   model -> <domain>.<x>.draft (validates, presents this card, saves nothing)
 *   owner presses the card's button -> ui.action (renderer chat "ui", or the paired phone) -> the bound <domain>.<x>.save port
 *
 * The save port runs only when ownerConfirmedAction says the call is that press: the dispatcher's command key names a card of this
 * host-owned view in the same chat, still waiting for the owner, whose current action is bound to exactly this operation, and the press
 * came from the owner's own surface (run "ui" or "mobile:<device>"; a model run that calls ui.action itself carries its own run id).
 * The model cannot present, update or close this view (ui-instances.ts HOST_OWNED_VIEWS), so the card it shows is the host's.
 * Any domain uses the same three calls; nothing here knows a domain. No electron import (the daemon loads harness modules).
 */

export { OWNER_CONFIRM_VIEW };
const TEXT_BLOCK_CHARS = 2_000;

export interface OwnerConfirmationRequest {
  /** The proposing operation (it owns the retained result). */
  operationId: string;
  title: string;
  /** What the owner reviews, in plain text; split into readable blocks. */
  body: string;
  /** One line shown when the result cannot be read (and to the phone). */
  summary: string;
  confirm: { label: string; operationId: string; fixedArgs: Record<string, unknown> };
}

/** Plain text as MCP text blocks (the card's generic result preview reads the standard content envelope), paragraphs kept together. */
function textBlocks(body: string): { type: "text"; text: string }[] {
  const pieces = body.split(/\n{2,}/).flatMap((paragraph) => {
    const out: string[] = [];
    for (let at = 0; at < paragraph.length; at += TEXT_BLOCK_CHARS) out.push(paragraph.slice(at, at + TEXT_BLOCK_CHARS));
    return out;
  });
  const blocks: string[] = [];
  for (const piece of pieces) {
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    if (last !== null && last.length + piece.length + 2 <= TEXT_BLOCK_CHARS) blocks[blocks.length - 1] = `${last}\n\n${piece}`;
    else blocks.push(piece);
  }
  return blocks.slice(0, 16).map((text) => ({ type: "text" as const, text }));
}

/** Present the card for this run. A newer proposal of the same operation in the chat replaces an open older one. */
export async function presentOwnerConfirmation(ctx: HarnessCallContext, request: OwnerConfirmationRequest): Promise<{ status: "presented"; instanceId: string } | { status: "unavailable"; reason: string }> {
  if (ctx.dryRun || ctx.chatId === "ui" || !ctx.runId) return { status: "unavailable", reason: "owner_confirmation_needs_a_conversation" };
  try {
    const { nativePortOwnerScope, retainNativePortResult } = await import("./tool-dispatch");
    const ownerScope = await nativePortOwnerScope(ctx);
    const retained = await retainNativePortResult(ctx, request.operationId, request.confirm.fixedArgs, { content: textBlocks(request.body) }, ownerScope);
    const { uiPresent, uiUpdate, listUiInstances } = await import("./ui-instances");
    const shown = await uiPresent({ ...retained, structuredResultRef: retained.resultRef, viewId: OWNER_CONFIRM_VIEW, title: request.title.slice(0, 160),
      fallbackText: request.summary.slice(0, 4000), state: "awaiting-input", reason: "decision", display: "inline",
      actions: [{ actionId: "confirm", label: request.confirm.label.slice(0, 60), intent: "host-action", operationId: request.confirm.operationId, fixedArgs: request.confirm.fixedArgs }] }, ctx);
    const instance = shown.status === "ok" ? (shown.data as { instance?: { instanceId?: string; sequence?: number } }).instance : undefined;
    if (!instance?.instanceId) return { status: "unavailable", reason: "owner_confirmation_not_presented" };
    for (const older of await listUiInstances(ctx.chatId)) {
      if (older.instanceId === instance.instanceId || older.presentation.viewId !== OWNER_CONFIRM_VIEW || older.state !== "awaiting-input" || older.closedAt) continue;
      if (!older.actions.some((action) => action.operationId === request.confirm.operationId) || older.sequence > (instance.sequence ?? 0)) continue;
      try { await uiUpdate({ instanceId: older.instanceId, state: "cancelled", reason: "result", actions: [] }, ctx); } catch { /* the newest card is already shown */ }
    }
    return { status: "presented", instanceId: instance.instanceId };
  } catch { return { status: "unavailable", reason: "owner_confirmation_not_presented" }; }
}

/** The card instance when this call is the owner's press of an open confirmation card bound to `operationId`; otherwise null. */
export async function ownerConfirmedAction(ctx: HarnessCallContext, operationId: string): Promise<{ instanceId: string; chatId: string } | null> {
  const match = /^action:(ui_[A-Za-z0-9_-]{1,64}):/.exec(ctx.commandId ?? "");
  if (!match || !(ctx.runId === "ui" || /^mobile:/.test(ctx.runId)) || ctx.dryRun) return null;
  const { listUiInstances } = await import("./ui-instances");
  const card = (await listUiInstances(ctx.chatId)).find((instance) => instance.instanceId === match[1]);
  if (!card || card.presentation.viewId !== OWNER_CONFIRM_VIEW || card.state !== "awaiting-input" || card.closedAt) return null;
  return card.actions.some((action) => action.intent === "host-action" && action.operationId === operationId) ? { instanceId: card.instanceId, chatId: card.chatId } : null;
}

/** After the owner's save: the card says what happened and offers nothing more to press. */
export async function settleOwnerConfirmation(card: { instanceId: string; chatId: string }, summary: string): Promise<void> {
  try {
    const { uiUpdate } = await import("./ui-instances");
    await uiUpdate({ chatId: card.chatId, instanceId: card.instanceId, state: "ready", reason: "result", fallbackText: summary.slice(0, 4000), actions: [] }, { chatId: "ui", runId: "ui" });
  } catch { /* the save already happened; the card's state is display only */ }
}
