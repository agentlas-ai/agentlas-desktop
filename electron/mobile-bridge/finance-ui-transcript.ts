import { createHash } from 'node:crypto';
import { nativePortOwnerScope, resultRead } from '../harness/tool-dispatch';
import type { HarnessCallContext } from '../harness/capability-ports';
import { FINANCE_NATIVE_VIEW, FinanceNativeResultSchema } from '../../shared/finance-native-ui';
import { financeNativeTranscriptContents } from '../../shared/finance-native-transcript';
import { mergeInlineUiTranscript } from '../../shared/inline-ui-transcript';
import type { InlineUiPresentationContent } from '../../shared/inline-ui-presentation';
import type { ChatHistoryEntry } from '../../shared/types';
import type { UiInstanceView } from '../../shared/ui-instances';

/** Mobile-only hydration of immutable, account-bound results. No service query, model call or UI-store write. */
export async function mergeMobileInlineUiTranscript(chatId: string, history: readonly ChatHistoryEntry[], instances: readonly UiInstanceView[]) {
  const contents = new Map<string, readonly InlineUiPresentationContent[]>();
  const eligible = instances.filter(instance => instance.chatId === chatId && !instance.content && instance.state !== 'closed' && !instance.closedAt
    && instance.presentation.kind === 'native' && instance.presentation.viewId === FINANCE_NATIVE_VIEW
    && /^np_[0-9a-f-]{36}$/.test(instance.callId) && instance.resultRef === `result:${instance.callId}`
    && (!instance.structuredResultRef || instance.structuredResultRef === instance.resultRef));
  if (!eligible.length) return mergeInlineUiTranscript(chatId, history, instances);
  // GUI authentication stays behind the authenticated read, never a new daemon import-time dependency.
  let account: HarnessCallContext['hostAccountBinding'];
  try { account = (await import('../auth')).getAuthenticatedSessionBinding(); } catch { return mergeInlineUiTranscript(chatId, history, instances); }
  if (!account) return mergeInlineUiTranscript(chatId, history, instances);
  const ctx: HarnessCallContext = { chatId: 'ui', runId: 'ui', hostAccountBinding: account, permission: 'read' };
  try {
    const ownerScope = await nativePortOwnerScope(ctx);
    let remaining = 1024 * 1024;
    const notLoaded = (instance: UiInstanceView): readonly InlineUiPresentationContent[] => [{ kind: 'native', document: {
      version: 1, id: `finance_${createHash('sha256').update(instance.instanceId).digest('hex').slice(0, 24)}`,
      children: [{ type: 'text', text: 'This Finance result was not loaded in this view.' }],
    } }];
    // Keep older anchors pageable without reading every retained payload on each snapshot poll.
    for (const instance of eligible.slice(0, -16)) contents.set(instance.instanceId, notLoaded(instance));
    const candidates = eligible.slice(-16).reverse();
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
            || typeof data.totalChars !== 'number' || !Number.isInteger(data.totalChars) || data.totalChars < 1 || data.totalChars > 256 * 1024) throw new Error('finance_result_binding_invalid');
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
            contents.set(instance.instanceId, financeNativeTranscriptContents(checked.data, { state: instance.state }));
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
  return mergeInlineUiTranscript(chatId, history, instances, contents);
}
