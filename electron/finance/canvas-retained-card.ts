import { createHash } from 'node:crypto';
import type { HarnessCallContext } from '../harness/capability-ports';
import { FinanceNativeResultSchema, isResultCardInstance } from '../../shared/finance-native-ui';
import { canvasFromLegacy } from '../../shared/canvas';
import type { RetainedCard } from '../canvas/export';
import type { UiInstanceView } from '../../shared/ui-instances';

/**
 * A card the conversation showed, read back from the host's own record: the UI instance the owner saw and the result the host retained for it.
 * The same account-bound reads and checks the phone's transcript makes (electron/mobile-bridge/finance-ui-transcript.ts): the result belongs to this chat,
 * this run and this call, to the signed-in account, and its bytes match the digest the store recorded. A card that fails any of them is not exported.
 * Lives with Finance because the stored result is the Finance-shaped native envelope (finance.native-result.v1) every result card is kept in; the generic
 * canvas export (electron/canvas/export.ts) takes this reader as a dependency and names no Finance. No electron import (the daemon loads the harness).
 */
const MAX_CHARS = 256 * 1024;

export async function readRetainedCard(ctx: HarnessCallContext, instanceId?: string): Promise<RetainedCard> {
  const chatId = ctx.chatId;
  if (!chatId || chatId === 'ui') return { ok: false, reason: 'card_chat_required', next: 'Export a card from the conversation that showed it.' };
  const { listUiInstances } = await import('../harness/ui-instances');
  const cards = (await listUiInstances(chatId)).filter((item: UiInstanceView) => item.chatId === chatId && !item.closedAt && item.state !== 'closed' && isResultCardInstance(item)).sort((a: UiInstanceView, b: UiInstanceView) => a.sequence - b.sequence);
  const instance = instanceId ? cards.find((item: UiInstanceView) => item.instanceId === instanceId) : cards[cards.length - 1];
  if (!instance) return { ok: false, reason: instanceId ? 'card_unknown' : 'no_card', next: instanceId ? 'That card is not one this conversation showed (or it was closed). Omit instanceId to use the newest card.' : 'This conversation has shown no card yet. Show one with ui.canvas, then export it.' };
  try {
    const { nativePortOwnerScope, resultRead } = await import('../harness/tool-dispatch');
    const ownerScope = await nativePortOwnerScope(ctx);
    let cursor: string | undefined, original = '', stamp: string | undefined, remaining = 4;
    while (remaining-- > 0) {
      ctx.signal?.throwIfAborted();
      const out = await resultRead({ chatId, resultRef: instance.resultRef, part: 'original', limit: 64_000, ...(cursor ? { cursor } : {}) }, ctx);
      if (out.status !== 'ok') throw new Error('card_result_unavailable');
      const data = out.data as { content?: unknown; nativeBinding?: { kind?: string; chatId?: string; runId?: string; callId?: string; ownerScope?: string; operationId?: string }; storedSha256?: unknown; totalChars?: unknown; nextCursor?: unknown };
      const binding = data.nativeBinding;
      if (!binding || binding.kind !== 'native-port' || binding.chatId !== chatId || binding.runId !== instance.turnId || binding.callId !== instance.callId
        || binding.ownerScope !== ownerScope || typeof binding.operationId !== 'string' || !/^finance\.[a-z.]+$/.test(binding.operationId)
        || typeof data.storedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.storedSha256) || typeof data.content !== 'string'
        || typeof data.totalChars !== 'number' || !Number.isInteger(data.totalChars) || data.totalChars < 1 || data.totalChars > MAX_CHARS) throw new Error('card_result_binding_invalid');
      const next = JSON.stringify([binding, data.storedSha256, data.totalChars]);
      if (stamp && stamp !== next) throw new Error('card_result_changed');
      stamp = next; original += data.content;
      if (data.nextCursor === null) {
        if (original.length !== data.totalChars || createHash('sha256').update(original).digest('hex') !== data.storedSha256) throw new Error('card_result_digest_invalid');
        const checked = FinanceNativeResultSchema.safeParse(JSON.parse(original));
        if (!checked.success || checked.data.ownerScope !== ownerScope || checked.data.operationId !== binding.operationId) throw new Error('card_result_invalid');
        const view = canvasFromLegacy(checked.data.view as { kind: string } & Record<string, unknown>);
        if (!view) throw new Error('card_result_invalid');
        if (await nativePortOwnerScope(ctx) !== ownerScope) throw new Error('card_owner_changed');
        return { ok: true, instanceId: instance.instanceId, turnId: instance.turnId, view };
      }
      if (data.nextCursor !== String(original.length) || original.length >= data.totalChars || data.nextCursor === cursor) throw new Error('card_result_cursor_invalid');
      cursor = data.nextCursor;
    }
    throw new Error('card_result_incomplete');
  } catch (error) {
    ctx.signal?.throwIfAborted();
    const reason = error instanceof Error && /^card_[a-z_]+$/.test(error.message) ? error.message : 'card_result_unavailable';
    return { ok: false, reason, next: reason === 'card_owner_changed' || /owner|sign/.test(String((error as Error)?.message ?? '')) ? 'Sign in to the account that showed the card, then export it again.' : 'The card could not be read back. Show it again with ui.canvas, then export it.' };
  }
}
