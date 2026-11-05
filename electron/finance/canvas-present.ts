import { FINANCE_NATIVE_VIEW, FinanceNativeResultSchema, type FinanceNativePresentation } from '../../shared/finance-native-ui';
import type { HarnessCallContext } from '../harness/capability-ports';
import type { CanvasView } from '../../shared/canvas';

/**
 * Show a built card under the answer: retain the result as the owner's native result and present it in the conversation. The phone reads
 * the same retained result, so both surfaces show the same card. The stored result keeps the `finance.native-result.v1` shape and the
 * operation id `finance.present` whichever port drew the card: the renderer, the phone transcript and old apps all read that id.
 */
export async function presentCanvasCard(data: { view: CanvasView; warnings: string[] }, raw: Record<string, unknown>, ctx: Pick<HarnessCallContext, 'chatId' | 'runId' | 'dryRun' | 'signal' | 'hostAccountBinding' | 'commandId'>, assertCurrent: () => void = () => undefined): Promise<FinanceNativePresentation | undefined> {
  if (ctx.dryRun || ctx.chatId === 'ui' || !ctx.runId) return undefined;
  try {
    assertCurrent(); ctx.signal?.throwIfAborted();
    const { nativePortOwnerScope, retainNativePortResult } = await import('../harness/tool-dispatch');
    const ownerScope = await nativePortOwnerScope(ctx as HarnessCallContext);
    const original = FinanceNativeResultSchema.parse({ schemaVersion: 'finance.native-result.v1', ownerScope, operationId: 'finance.present', view: data.view, operationResult: data });
    const retained = await retainNativePortResult(ctx as HarnessCallContext, 'finance.present', raw, original, ownerScope);
    assertCurrent(); ctx.signal?.throwIfAborted();
    const { uiPresent } = await import('../harness/ui-instances');
    const shown = await uiPresent({ ...retained, structuredResultRef: retained.resultRef, viewId: FINANCE_NATIVE_VIEW, title: 'Finance', fallbackText: 'Finance canvas', state: 'ready', display: 'inline', reason: 'result' }, ctx as HarnessCallContext);
    if (shown.status !== 'ok') return { status: 'unavailable', reason: 'finance_ui_not_presented' };
    const instance = (shown.data as { instance?: { instanceId?: string } }).instance;
    if (!instance?.instanceId) return { status: 'unavailable', reason: 'finance_ui_not_presented' };
    return { status: 'presented', ...retained, instanceId: instance.instanceId };
  } catch { return { status: 'unavailable', reason: 'finance_ui_not_presented' }; }
}
