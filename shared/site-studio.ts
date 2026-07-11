// Site design studio — shared contract between main, preload, and renderer.
//
// The "site" in-app generates DESIGN-ONLY screens: one self-contained HTML
// document per screen. Nothing is executed outside a sandboxed (opaque-origin)
// iframe; there is no dev server, no arbitrary process execution. This file
// owns the screen contract, the selection payload (adapted from Orca's MIT
// browser-grab contract, github.com/stablyai/orca), and the postMessage
// protocol used across the iframe boundary.

export const SITE_SCREEN_MAX_BYTES = 512_000;

/** Per-field clamp budgets for the selection payload (Orca-style). */
export const SITE_GRAB_BUDGET = {
  textSnippet: 400,
  htmlSnippet: 2_000,
  selector: 300,
  classes: 300,
  consoleMessage: 500,
} as const;

export type SiteScreenMeta = {
  id: string;
  projectId: string;
  name: string;
  fileName: string;
  createdAt: string;
  updatedAt: string;
  /** Non-null when this screen is one of N variants of the same brief. */
  variantGroup: string | null;
  variantLabel: string | null;
};

export type SiteProjectMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  screens: SiteScreenMeta[];
};

export type SiteProjectOperation = "generate" | "edit" | "handoff";

/**
 * 사람이 읽는 Site Copilot 대화 기록. 런타임에 넘기는 내부 HTML 프롬프트와 분리해
 * 프로젝트 폴더에만 저장한다. 따라서 재시작 뒤에도 사용자에게는 짧은 피드백만 복원된다.
 */
export type SiteConversationEntry = {
  id: string;
  projectId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** 사용자가 선택해 수정한 대상의 짧은 식별자. */
  context?: string | null;
};

/**
 * Site Studio에서 사용자가 고른 로컬 작업공간으로 넘긴 불변 디자인 리비전.
 * 실제 경로는 선택한 워크스페이스 내부의 상대 경로만 공개해, Build 프롬프트가
 * 어느 파일을 시각 기준으로 삼아야 하는지 명확히 한다.
 */
export type SiteWorkspaceHandoff = {
  projectId: string;
  revision: string;
  /** 워크스페이스 루트 기준의 디자인 레퍼런스 폴더. */
  relativePath: string;
  screenCount: number;
  /** Build 입력칸에 그대로 이어지는 사용자용 구현 요청. */
  buildPrompt: string;
};

/**
 * Site 실행 중 renderer로만 보내는 실시간 상태. 실제 처리 단계와 사용자용 피드백만
 * 노출하며, 모델의 비공개 추론이나 내부 프롬프트/HTML은 담지 않는다.
 */
export type SiteActivityEvent =
  | { type: "message"; projectId: string; runId: string; entry: SiteConversationEntry }
  | { type: "status"; projectId: string; runId: string; text: string }
  | { type: "feedback-reset"; projectId: string; runId: string }
  | { type: "feedback-delta"; projectId: string; runId: string; delta: string }
  | { type: "complete"; projectId: string; runId: string };

export type SiteSelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Curated computed-style subset captured on selection. Mirrors the fields a
 * designer actually reasons about; intentionally small to keep prompts cheap.
 */
export type SiteSelectionStyles = {
  display: string;
  position: string;
  width: string;
  height: string;
  margin: string;
  padding: string;
  color: string;
  backgroundColor: string;
  border: string;
  borderRadius: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  textAlign: string;
  zIndex: string;
};

export type SiteSelectionPayload = {
  /** data-agentlas-id of the selected element ("a" + source offset). */
  id: string;
  tagName: string;
  selector: string;
  role: string | null;
  ariaLabel: string | null;
  classes: string;
  textSnippet: string;
  htmlSnippet: string;
  styles: SiteSelectionStyles;
  /** Viewport-relative rect in CSS pixels. */
  rect: SiteSelectionRect;
  /** Page-relative rect (rect + scroll offsets). */
  pageRect: SiteSelectionRect;
  nearby: {
    parent: string | null;
    prev: string | null;
    next: string | null;
  };
  page: {
    title: string;
    viewportWidth: number;
    viewportHeight: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
};

/** Messages posted from the sandboxed design iframe to the host renderer. */
export type SiteGuestMessage =
  | { type: "ready" }
  | { type: "select"; payload: SiteSelectionPayload }
  | { type: "scroll"; x: number; y: number }
  | { type: "console"; level: "error" | "warn"; message: string }
  | { type: "pageError"; message: string };

/** Messages posted from the host renderer into the design iframe. */
export type SiteHostMessage =
  | { type: "setMode"; mode: "browse" | "select" }
  | { type: "restoreScroll"; x: number; y: number }
  | { type: "clearSelection" }
  | { type: "highlight"; id: string }
  | { type: "setOverlayVisible"; visible: boolean };

/** Envelope key carried by every message across the iframe boundary. */
export const SITE_MESSAGE_KEY = "__agentlasSite";

export type SiteGuestEnvelope = {
  [SITE_MESSAGE_KEY]: string;
  message: SiteGuestMessage;
};

export type SiteHostEnvelope = {
  [SITE_MESSAGE_KEY]: string;
  message: SiteHostMessage;
};

/** One taggable element extracted by the tagger; offsets index the SOURCE html. */
export type SiteTaggedElement = {
  id: string;
  tagName: string;
  /** Offset of "<" of the open tag in the source document. */
  start: number;
  /** Offset just past the element (past "</tag>" or past a void/self-closing open tag). */
  end: number;
};

export type SiteContractResult = {
  ok: boolean;
  errors: string[];
};

const EXTERNAL_RESOURCE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /<script[^>]*\ssrc\s*=/i, label: "외부 <script src>" },
  { re: /<link[^>]+href\s*=\s*["']?(?:https?:)?\/\//i, label: "외부 <link href>" },
  { re: /<img[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, label: "외부 <img src>" },
  { re: /<(?:video|audio|source|track)[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, label: "외부 미디어 src" },
  { re: /<iframe\b/i, label: "<iframe>" },
  { re: /url\(\s*["']?(?:https?:)?\/\//i, label: "CSS url() 외부 참조" },
  { re: /@import\b/i, label: "CSS @import" },
];

/**
 * Validate the generated screen against the design-only contract:
 * a complete, self-contained HTML document with no external resource loads.
 * (Anchors may point anywhere — the sandbox blocks navigation anyway.)
 */
export function validateSiteScreenHtml(html: string): SiteContractResult {
  const errors: string[] = [];
  const trimmed = html.trim();
  if (!trimmed) {
    return { ok: false, errors: ["빈 문서"] };
  }
  if (new TextEncoder().encode(trimmed).length > SITE_SCREEN_MAX_BYTES) {
    errors.push(`문서가 ${Math.round(SITE_SCREEN_MAX_BYTES / 1000)}KB 예산을 초과`);
  }
  if (!/<!doctype\s+html/i.test(trimmed) && !/<html[\s>]/i.test(trimmed)) {
    errors.push("완전한 HTML 문서가 아님 (<!doctype html> 또는 <html> 필요)");
  }
  if (!/<body[\s>]/i.test(trimmed)) {
    errors.push("<body>가 없음");
  }
  for (const { re, label } of EXTERNAL_RESOURCE_PATTERNS) {
    if (re.test(trimmed)) {
      errors.push(`외부 리소스 금지 위반: ${label}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function clampSiteText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Extract a fenced HTML document from a model reply (```html ... ``` or raw). */
export function extractSiteHtmlFromReply(reply: string): string | null {
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(reply);
  const candidate = (fence ? fence[1] : reply).trim();
  const docStart = candidate.search(/<!doctype\s+html|<html[\s>]/i);
  if (docStart < 0) return null;
  const endMatch = /<\/html\s*>/i.exec(candidate);
  const docEnd = endMatch ? endMatch.index + endMatch[0].length : candidate.length;
  return candidate.slice(docStart, docEnd).trim();
}
