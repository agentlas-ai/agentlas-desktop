/** Public metadata only. Retrieval time is never substituted for an event/publication date. */
export const FINANCE_FEED_IDS = ['finance-news', 'finance-sec', 'finance-economy', 'finance-earnings'] as const;
export type FinanceFeedId = typeof FINANCE_FEED_IDS[number];
export interface FinanceDashboardFeedItem {
  id:string; kind:'article'|'filing'|'event'; title:string; url:string;
  publishedAt:string|null; startsAt:string|null; assetSymbol:string|null; sourceId:FinanceFeedId;
  session?:'before-market'|'after-market'|'during-market'|'unknown';
  datePrecision?:'instant'|'day'; publisher?:string;
  /** Provider estimate only; never an issuer confirmation or inferred market session. */
  scheduleStatus?:'estimated';
}
export interface FinanceDashboardFeedSection {
  id:FinanceFeedId; status:'ok'|'partial'|'unavailable'|'disabled'|'error';
  items:FinanceDashboardFeedItem[]; sourceUrls:string[]; warnings:string[]; errorCode?:string;
}
export interface FinanceDashboardFeedsResult {
  fetchedAt:string; expiresAt:string; sections:FinanceDashboardFeedSection[];
}
