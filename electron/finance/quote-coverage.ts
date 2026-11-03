import type { FinanceAIResult } from '../../shared/finance';

/** Counts asset entries selected for processing, not provider HTTP calls. */
export interface FinanceQuoteCoverage {
  version: 1;
  total: number;
  attempted: number;
  succeeded: number;
  failed: number;
  unattempted: number;
}

/** Internal opt-in result; the existing Desktop and plugin contracts stay unchanged. */
export type FinanceQuoteRefreshResult = FinanceAIResult & { quoteCoverage?: FinanceQuoteCoverage };
