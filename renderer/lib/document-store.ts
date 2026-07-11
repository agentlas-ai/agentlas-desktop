"use client";
// 문서 스튜디오 로컬 영속 — 소스(참고문헌), 인용 스타일, 작성 중인 문서 초안.
// 데스크톱 단일 사용자 로컬 앱이라 localStorage로 충분(서버/DB 불필요).
import type { CitationStyle, Reference } from "./citations";

const REF_KEY = "agentlas.docstudio.references.v1";
const STYLE_KEY = "agentlas.docstudio.style.v1";
export const DOCUMENT_DRAFT_KEY = "agentlas.docstudio.draft.v1";
export const DOCUMENT_DRAFT_VERSION = 1 as const;

export interface DocumentStudioDraftV1 {
  version: typeof DOCUMENT_DRAFT_VERSION;
  title: string;
  body: string;
  figureSrc: string;
  figureCaption: string;
  updatedAt: string;
}

export type DocumentStudioDraftInput = Pick<
  DocumentStudioDraftV1,
  "title" | "body" | "figureSrc" | "figureCaption"
>;

function cleanDraftString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isSupportedFigureSrc(value: string): boolean {
  return value === "" || /^data:image\//i.test(value);
}

export function loadDocumentDraft(): DocumentStudioDraftV1 | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCUMENT_DRAFT_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DocumentStudioDraftV1> | null;
    if (!parsed || parsed.version !== DOCUMENT_DRAFT_VERSION) return null;
    const figureSrc = cleanDraftString(parsed.figureSrc);
    return {
      version: DOCUMENT_DRAFT_VERSION,
      title: cleanDraftString(parsed.title),
      body: cleanDraftString(parsed.body),
      figureSrc: isSupportedFigureSrc(figureSrc) ? figureSrc : "",
      figureCaption: cleanDraftString(parsed.figureCaption),
      updatedAt: cleanDraftString(parsed.updatedAt),
    };
  } catch {
    return null;
  }
}

export function saveDocumentDraft(input: DocumentStudioDraftInput): void {
  try {
    if (typeof localStorage === "undefined") return;
    const figureSrc = isSupportedFigureSrc(input.figureSrc) ? input.figureSrc : "";
    if (!input.title && !input.body && !figureSrc && !input.figureCaption) {
      localStorage.removeItem(DOCUMENT_DRAFT_KEY);
      return;
    }
    const draft: DocumentStudioDraftV1 = {
      version: DOCUMENT_DRAFT_VERSION,
      title: input.title,
      body: input.body,
      figureSrc,
      figureCaption: input.figureCaption,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(DOCUMENT_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota/permission failures must not interrupt editing. The next edit or
    // navigation boundary will retry the same current snapshot.
  }
}

export function clearDocumentDraft(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(DOCUMENT_DRAFT_KEY);
  } catch {
    // Storage can be unavailable in hardened renderer contexts.
  }
}

export function loadReferences(): Reference[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(REF_KEY) : null;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Reference[]) : [];
  } catch {
    return [];
  }
}

export function saveReferences(refs: Reference[]): void {
  try {
    localStorage.setItem(REF_KEY, JSON.stringify(refs));
  } catch {
    /* quota/무권한 — 무시 */
  }
}

export function loadStyle(): CitationStyle | null {
  try {
    const s = localStorage.getItem(STYLE_KEY);
    return (s as CitationStyle) || null;
  } catch {
    return null;
  }
}

export function saveStyle(style: CitationStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    /* 무시 */
  }
}

export function newReferenceId(): string {
  return `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
