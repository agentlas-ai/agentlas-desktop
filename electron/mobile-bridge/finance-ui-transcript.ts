import { createHash } from 'node:crypto';
import { nativePortOwnerScope, resultRead } from '../harness/tool-dispatch';
import type { HarnessCallContext } from '../harness/capability-ports';
import { FINANCE_NATIVE_VIEW, FinanceNativeResultSchema, financeNativeTranscriptContents, mobileDomainPorts } from '../finance/mobile-bridge';
export { mobileDomainPorts };
import { mergeInlineUiTranscript } from '../../shared/inline-ui-transcript';
import { redactMobileInlineContent } from './sanitize';
import type { InlineUiPresentationContent } from '../../shared/inline-ui-presentation';
import type { ChatHistoryEntry } from '../../shared/types';
import type { UiInstanceView } from '../../shared/ui-instances';

/** How many of a chat's newest cards one read loads; a history page leaves the rest for the next page (history-page.ts). */
export const MOBILE_CARD_WINDOW = 16;
/** The largest drawn card (HTML bytes) a poll-driven snapshot carries, so a snapshot is no larger than it was; a history page allows the full wire budget. */
export const MOBILE_SNAPSHOT_VISUAL_BYTES = 56 * 1024;
/** A retained result card this module reads for the phone (the Finance native view, port-bound result). */
export const isMobileCardInstance = (instance: UiInstanceView): boolean => !instance.content && instance.state !== 'closed' && !instance.closedAt
  && instance.presentation.kind === 'native' && instance.presentation.viewId === FINANCE_NATIVE_VIEW
  && /^np_[0-9a-f-]{36}$/.test(instance.callId) && instance.resultRef === `result:${instance.callId}`
  && (!instance.structuredResultRef || instance.structuredResultRef === instance.resultRef);
/** One line, no code marks, bounded: the model writes a card's title. */
export const mobileCardHeading = (title: string): string => title.replace(/\s+/g, ' ').replace(/`/g, '').trim().slice(0, 120);

/** Mobile-only hydration of immutable, account-bound results. No service query, model call or UI-store write. */
export async function mergeMobileInlineUiTranscript(chatId: string, history: readonly ChatHistoryEntry[], instances: readonly UiInstanceView[], options: { maxVisualBytes?: number } = {}) {
  const contents = new Map<string, readonly InlineUiPresentationContent[]>();
  const titles = new Map<string, string>();
  const eligible = instances.filter(instance => instance.chatId === chatId && isMobileCardInstance(instance));
  if (!eligible.length) return mergeInlineUiTranscript(chatId, history, instances);
  // GUI authentication stays behind the authenticated read, never a new daemon import-time dependency.
  let account: HarnessCallContext['hostAccountBinding'];
  try { account = (await import('../auth')).getAuthenticatedSessionBinding(); } catch { return mergeInlineUiTranscript(chatId, history, instances); }
  if (!account) return mergeInlineUiTranscript(chatId, history, instances);
  const ctx: HarnessCallContext = { chatId: 'ui', runId: 'ui', hostAccountBinding: account, permission: 'read' };
  try {
    const ownerScope = await nativePortOwnerScope(ctx);
    let remaining = 1024 * 1024;
    // A result this view did not read is left out unless it waits for the owner: an older search or query card was one
    // "not loaded" line each, dozens in a long Finance chat. A proposal that waits keeps its line.
    const notLoaded = (instance: UiInstanceView): readonly InlineUiPresentationContent[] => instance.state !== 'awaiting-input' ? [] : [{ kind: 'native', document: {
      version: 1, id: `finance_${createHash('sha256').update(instance.instanceId).digest('hex').slice(0, 24)}`,
      children: [{ type: 'text', text: 'This Finance result was not loaded in this view.' }],
    } }];
    // Keep older anchors pageable without reading every retained payload on each snapshot poll.
    for (const instance of eligible.slice(0, -MOBILE_CARD_WINDOW)) contents.set(instance.instanceId, notLoaded(instance));
    const candidates = eligible.slice(-MOBILE_CARD_WINDOW).reverse();
    for (const instance of candidates) {
      if (remaining <= 0) { contents.set(instance.instanceId, notLoaded(instance)); continue; }
      try {
        let cursor: string | undefined, original = '', stamp: string | undefined;
        for (let page = 0; page < 4; page++) {
          const out = await resultRead({ chatId, resultRef: instance.resultRef, part: 'original', limit: 64_000, ...(cursor ? { cursor } : {}) }, ctx);
          if (out.status !== 'ok') throw new Error('finance_result_unavailable');
          const data = out.data as { content?: unknown; nativeBinding?: { kind?: string; chatId?: string; runId?: string; callId?: string; ownerScope?: string; operationId?: string }; storedSha256?: unknown; totalChars?: unknown; nextCursor?: unknown };
          const binding = data.nativeBinding;
          if (!binding || binding.kind !== 'native-port' || binding.chatId !== chatId || binding.runId !== instance.turnId || binding.callId !== instance.callId
            || binding.ownerScope !== ownerScope || typeof binding.operationId !== 'string' || !/^finance\.[a-z.]+$/.test(binding.operationId)
            || typeof data.storedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.storedSha256) || typeof data.content !== 'string'
            || typeof data.totalChars !== 'number' || !Number.isInteger(data.totalChars) || data.totalChars < 1) throw new Error('finance_result_binding_invalid');
          // A genuine result past the display budget gets the same line as one that runs out of budget while it is read, not silence.
          if (data.totalChars > 256 * 1024) throw new Error('finance_result_budget');
          const nextStamp = JSON.stringify([binding, data.storedSha256, data.totalChars]);
          if (stamp && stamp !== nextStamp) throw new Error('finance_result_changed');
          stamp = nextStamp;
          const bytes = Buffer.byteLength(data.content, 'utf8'); remaining -= bytes;
          if (remaining < 0 || Buffer.byteLength(original, 'utf8') + bytes > 256 * 1024) throw new Error('finance_result_budget');
          original += data.content;
          if (data.nextCursor === null) {
            if (original.length !== data.totalChars) throw new Error('finance_result_incomplete');
            if (createHash('sha256').update(original).digest('hex') !== data.storedSha256) throw new Error('finance_result_digest_invalid');
            const checked = FinanceNativeResultSchema.safeParse(JSON.parse(original));
            if (!checked.success || checked.data.ownerScope !== ownerScope || checked.data.operationId !== binding.operationId) throw new Error('finance_result_invalid');
            const shown = { state: instance.state, ...(options.maxVisualBytes ? { maxVisualBytes: options.maxVisualBytes } : {}) };
            contents.set(instance.instanceId, financeNativeTranscriptContents(checked.data, shown).map(redactMobileInlineContent));
            // The row's heading is the card's own title (the stored label names the Finance port whichever domain drew it).
            if (checked.data.view.kind === 'canvas' && mobileCardHeading(checked.data.view.title)) titles.set(instance.instanceId, mobileCardHeading(checked.data.view.title));
            break;
          }
          if (data.nextCursor !== String(original.length) || original.length >= data.totalChars || data.nextCursor === cursor) throw new Error('finance_result_cursor_invalid');
          cursor = data.nextCursor;
        }
        if (!contents.has(instance.instanceId)) contents.set(instance.instanceId, notLoaded(instance));
      } catch (error) {
        // A validated local page may exceed the display budget; no partial payload is sent.
        if (error instanceof Error && error.message === 'finance_result_budget') contents.set(instance.instanceId, notLoaded(instance));
      }
    }
    if (await nativePortOwnerScope(ctx) !== ownerScope) contents.clear();
  } catch { contents.clear(); }
  return mergeInlineUiTranscript(chatId, history, titles.size ? instances.map((instance): UiInstanceView => { const title = titles.get(instance.instanceId); return title ? { ...instance, presentation: { ...instance.presentation, fallbackText: title } } : instance; }) : instances, contents);
}
