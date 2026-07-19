export const ONE_SEARCH_CONTRACT_VERSION = "1.0.0" as const;

export type OneSearchHitKind = "task" | "result" | "artifact" | "conversation" | "team";

export type OneSearchMatchKind =
  | "task_title"
  | "conversation_title"
  | "conversation_text"
  | "result_content"
  | "artifact_label"
  | "team_participant";

/**
 * A local Main-process search request. The renderer may choose only the query,
 * page size, cursor, and whether archived work is included. It cannot inject a
 * project, Task, result, or authority binding.
 */
export interface OneSearchRequestV1 {
  contractVersion: typeof ONE_SEARCH_CONTRACT_VERSION;
  query: string;
  limit?: number;
  cursor?: string | null;
  includeArchived?: boolean;
}

/** A safe pointer back to canonical work; raw messages and result JSON stay in Main. */
export interface OneSearchHitV1 {
  contractVersion: typeof ONE_SEARCH_CONTRACT_VERSION;
  hitId: string;
  kind: OneSearchHitKind;
  taskId: string | null;
  chatId: string;
  title: string;
  detail: string | null;
  status: "open" | "running" | "waiting-decision" | "partial" | "completed" | "failed" | "archived" | "conversation";
  updatedAt: string;
  archived: boolean;
  matchedBy: OneSearchMatchKind[];
}

export interface OneSearchPageV1 {
  contractVersion: typeof ONE_SEARCH_CONTRACT_VERSION;
  query: string;
  hits: OneSearchHitV1[];
  nextCursor: string | null;
}

export interface OneTaskArchiveMutationInputV1 {
  contractVersion: typeof ONE_SEARCH_CONTRACT_VERSION;
  taskId: string;
  expectedTaskVersion: number;
  expectedOriginChatUpdatedAt: string;
  operation: "archive" | "restore";
  confirmedByUser: true;
}

/**
 * A safe receipt for the single atomic Task + origin-chat archive mutation.
 * It intentionally contains no message, result, filesystem, or agent payload.
 */
export interface OneTaskArchiveMutationResultV1 {
  contractVersion: typeof ONE_SEARCH_CONTRACT_VERSION;
  operation: "archive" | "restore";
  taskId: string;
  chatId: string;
  priorTaskVersion: number;
  priorOriginChatUpdatedAt: string;
  taskVersion: number;
  originChatUpdatedAt: string;
  archived: boolean;
}
