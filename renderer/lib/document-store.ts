"use client";
// 문서 스튜디오 로컬 영속 — 소스(참고문헌), 인용 스타일, 작성 중인 문서 초안.
// 데스크톱 단일 사용자 로컬 앱이라 localStorage로 충분(서버/DB 불필요).
import type { CitationStyle, Reference } from "./citations";

const REF_KEY = "agentlas.docstudio.references.v1";
const STYLE_KEY = "agentlas.docstudio.style.v1";
export const DOCUMENT_DRAFT_KEY = "agentlas.docstudio.draft.v1";
export const DOCUMENT_DRAFT_VERSION = 1 as const;
// Keep generated images comfortably below Chromium's per-origin localStorage
// budget. The editor text is the durable priority; large figures stay visible
// in the current session but are deliberately omitted from the saved record.
export const DOCUMENT_DRAFT_FIGURE_MAX_CHARS = 1_500_000;

export type DocumentDraftFigurePersistence =
  | "none"
  | "stored"
  | "omitted-size"
  | "omitted-quota";

export type DocumentDraftSaveResult =
  | {
      status: "saved";
      figurePersistence: "none" | "stored";
      updatedAt: string;
    }
  | {
      status: "saved-without-figure";
      figurePersistence: "omitted-size" | "omitted-quota";
      updatedAt: string;
    }
  | {
      status: "cleared";
      figurePersistence: "none";
      updatedAt: string;
    }
  | {
      status: "failed";
      figurePersistence: "unknown";
      updatedAt: string;
    };

export interface DocumentStudioDraftV1 {
  version: typeof DOCUMENT_DRAFT_VERSION;
  title: string;
  body: string;
  figureSrc: string;
  figureCaption: string;
  figurePersistence: DocumentDraftFigurePersistence;
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

function normalizeFigurePersistence(
  value: unknown,
  figureSrc: string,
): DocumentDraftFigurePersistence {
  if (figureSrc) return "stored";
  if (value === "omitted-size" || value === "omitted-quota") return value;
  return "none";
}

function saveResultForDraft(draft: DocumentStudioDraftV1): DocumentDraftSaveResult {
  if (draft.figurePersistence === "omitted-size" || draft.figurePersistence === "omitted-quota") {
    return {
      status: "saved-without-figure",
      figurePersistence: draft.figurePersistence,
      updatedAt: draft.updatedAt,
    };
  }
  return {
    status: "saved",
    figurePersistence: draft.figurePersistence,
    updatedAt: draft.updatedAt,
  };
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
      figurePersistence: normalizeFigurePersistence(
        parsed.figurePersistence,
        isSupportedFigureSrc(figureSrc) ? figureSrc : "",
      ),
      updatedAt: cleanDraftString(parsed.updatedAt),
    };
  } catch {
    return null;
  }
}

export function saveDocumentDraft(input: DocumentStudioDraftInput): DocumentDraftSaveResult {
  const attemptedAt = new Date().toISOString();
  try {
    if (typeof localStorage === "undefined") {
      return { status: "failed", figurePersistence: "unknown", updatedAt: attemptedAt };
    }
    const figureSrc = isSupportedFigureSrc(input.figureSrc) ? input.figureSrc : "";
    if (!input.title && !input.body && !figureSrc && !input.figureCaption) {
      localStorage.removeItem(DOCUMENT_DRAFT_KEY);
      return { status: "cleared", figurePersistence: "none", updatedAt: attemptedAt };
    }

    // If a prior restart restored a text-only fallback, preserve that warning
    // until the figure caption changes or a replacement figure is generated.
    const previous = loadDocumentDraft();
    const previousOmission =
      !figureSrc &&
      previous?.figureSrc === "" &&
      previous.figureCaption === input.figureCaption &&
      (previous.figurePersistence === "omitted-size" || previous.figurePersistence === "omitted-quota")
        ? previous.figurePersistence
        : null;
    const figurePersistence: DocumentDraftFigurePersistence = figureSrc
      ? "stored"
      : previousOmission ?? "none";
    const draft: DocumentStudioDraftV1 = {
      version: DOCUMENT_DRAFT_VERSION,
      title: input.title,
      body: input.body,
      figureSrc,
      figureCaption: input.figureCaption,
      figurePersistence,
      updatedAt: attemptedAt,
    };

    if (figureSrc.length > DOCUMENT_DRAFT_FIGURE_MAX_CHARS) {
      const textOnlyDraft: DocumentStudioDraftV1 = {
        ...draft,
        figureSrc: "",
        figurePersistence: "omitted-size",
      };
      localStorage.setItem(DOCUMENT_DRAFT_KEY, JSON.stringify(textOnlyDraft));
      return saveResultForDraft(textOnlyDraft);
    }

    try {
      localStorage.setItem(DOCUMENT_DRAFT_KEY, JSON.stringify(draft));
      return saveResultForDraft(draft);
    } catch {
      if (!figureSrc) throw new Error("draft-storage-unavailable");

      // setItem is atomic: a failed oversized write leaves the prior value
      // intact. Replace it with the bounded text record so title/body survive.
      const textOnlyDraft: DocumentStudioDraftV1 = {
        ...draft,
        figureSrc: "",
        figurePersistence: "omitted-quota",
      };
      localStorage.setItem(DOCUMENT_DRAFT_KEY, JSON.stringify(textOnlyDraft));
      return saveResultForDraft(textOnlyDraft);
    }
  } catch {
    // Editing remains available, but callers receive a truthful failure state
    // instead of silently presenting the current snapshot as durable.
    return { status: "failed", figurePersistence: "unknown", updatedAt: attemptedAt };
  }
}

export function clearDocumentDraft(): DocumentDraftSaveResult {
  const attemptedAt = new Date().toISOString();
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(DOCUMENT_DRAFT_KEY);
    else return { status: "failed", figurePersistence: "unknown", updatedAt: attemptedAt };
    return { status: "cleared", figurePersistence: "none", updatedAt: attemptedAt };
  } catch {
    // Storage can be unavailable in hardened renderer contexts.
    return { status: "failed", figurePersistence: "unknown", updatedAt: attemptedAt };
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
