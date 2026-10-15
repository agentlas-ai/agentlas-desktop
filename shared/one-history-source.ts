/** Native-only source contract. No grant, execution tuple or original text crosses IPC. */
export const HISTORY_METADATA_POLICY='agentlas.history.metadata-whitelist.v1' as const;
export interface HistorySourceFence {consent:'on'|'off';revision:string;clearedBefore:string|null}
export interface HistorySourceScope {from:string;to:string;buckets:Array<'10min'|'6h'>;maxEntries:number;retentionMs:number}
export interface HistoryMetadataEntry {source:'10min'|'6h';occurredAt:string;categories:Array<'browser'|'editor'|'terminal'|'spreadsheet'|'presentation'|'communication'>;sourceRef:string;revision:string}
/** Local-only custody pins; never projected as a History observation body. */
export interface HistoryMetadataSnapshot {policy:typeof HISTORY_METADATA_POLICY;fence:HistorySourceFence;scope:HistorySourceScope;entries:HistoryMetadataEntry[];files:Array<{file:string;root:string;source:'10min'|'6h';fingerprint:string}>}
