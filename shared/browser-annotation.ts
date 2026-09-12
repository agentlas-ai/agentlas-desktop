/** Host-captured page references remain untrusted data, separate from user comments. */
export const BROWSER_ANNOTATION_SCHEMA = "agentlas.browser-annotation.v1" as const;
export interface BrowserAnnotationTarget { taskScopeId: string; viewId: string }
export interface BrowserAnnotationSession extends BrowserAnnotationTarget {
  sessionId: string;
  navigationEpoch: number;
  sourceUrl: string;
}
export interface BrowserAnnotationSelection extends BrowserAnnotationSession {
  selectionId: string;
  selectedAt: string;
  viewportScale: number;
  evidence: "untrusted-page-reference";
  element: {
    tagName: string;
    selector: string;
    textSnippet: string;
    role: string | null;
    ariaLabel: string | null;
    rect: { x: number; y: number; width: number; height: number };
  };
}
export interface BrowserAnnotationReceipt {
  schema: typeof BROWSER_ANNOTATION_SCHEMA;
  annotationId: string;
  status: "captured";
  capturedAt: string;
  userComment: string;
  selection: BrowserAnnotationSelection;
}
export type BrowserAnnotationResult<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; reason: string };
export interface BrowserAnnotationAPI {
  start: (input: BrowserAnnotationTarget) => Promise<BrowserAnnotationResult<{ session: BrowserAnnotationSession }>>;
  stop: (input: BrowserAnnotationTarget & { sessionId: string }) => Promise<BrowserAnnotationResult>;
  selection: (input: BrowserAnnotationTarget & { sessionId: string }) => Promise<BrowserAnnotationResult<{ selection: BrowserAnnotationSelection | null }>>;
  comment: (input: BrowserAnnotationTarget & { sessionId: string; selectionId: string; comment: string }) => Promise<BrowserAnnotationResult<{ receipt: BrowserAnnotationReceipt }>>;
}

/** Human-readable quoted reference; host identity stays in the typed receipt. */
export function browserAnnotationDraftText(receipt: BrowserAnnotationReceipt, locale: "ko" | "en" = "ko"): string {
  const ko = locale === "ko";
  return `${receipt.userComment}\n\n${ko ? "참고 페이지" : "Reference page"}: ${receipt.selection.sourceUrl}\n${ko ? "선택한 내용 (페이지 인용)" : "Selected text (page quotation)"}: ${JSON.stringify(receipt.selection.element.textSnippet)}`;
}
