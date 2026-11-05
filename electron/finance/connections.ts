import type { FinanceDataConnectionRequest, FinanceDataConnectionResult } from '../../shared/finance';
import { FINANCE_FREE_SOURCE_ID } from '../../shared/finance';

/**
 * Finance runs on the keyless free engine, so there is no credential to hold and nothing to probe. The status call exists for the
 * app-control contract and answers from the host without any network request, secret read or model call.
 */
export async function financeDataConnection(_request: FinanceDataConnectionRequest, options: { assertCurrent(): void }): Promise<FinanceDataConnectionResult> {
  options.assertCurrent();
  return { providerId: FINANCE_FREE_SOURCE_ID, credential: 'present', access: 'not-tested', checkedAt: null, probe: null };
}
