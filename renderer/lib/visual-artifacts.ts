"use client";
/**
 * 대화 속 시각물(차트·HTML 시각물)과 파일 칩을 오른쪽 "산출물" 탭이 알게 하는 창구.
 *
 * 셸(OneShell·TaskCockpit)을 거치지 않는다 — 블록이 그려질 때 스스로 알리고, 같은 대화의
 * 패널만 받는다(chatId). 패널이 닫혀 있어도 목록은 쌓인다(TaskSidePanel 의 리스너는 늘 산다).
 */
import { createContext, useContext } from "react";
import type { ChatFileItem } from "./chat-files";
import type { VisualThemeTokens } from "./chart-spec";

export const VISUAL_SEEN_EVENT = "agentlas:visual-seen" as const;
export const VISUAL_OPEN_EVENT = "agentlas:visual-open" as const;
export const CHAT_FILES_SEEN_EVENT = "agentlas:chat-files-seen" as const;

export type VisualArtifact =
  | { id: string; chatId: string; kind: "chart"; title: string; spec: Record<string, unknown> }
  | { id: string; chatId: string; kind: "html"; title: string; html: string };

/** Markdown 이 대화 id 를 블록에 건네는 길. 없으면 목록·패널 열기를 숨긴다(저장은 된다). */
export const VisualChatScope = createContext<string | null>(null);
export function useVisualChatScope(): string | null {
  return useContext(VisualChatScope);
}

export function announceVisual(visual: VisualArtifact): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(VISUAL_SEEN_EVENT, { detail: visual }));
}

export function requestVisualOpen(visual: VisualArtifact): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(VISUAL_OPEN_EVENT, { detail: visual }));
}

export function announceChatFiles(files: ChatFileItem[]): void {
  if (typeof window === "undefined" || files.length === 0) return;
  window.dispatchEvent(new CustomEvent(CHAT_FILES_SEEN_EVENT, { detail: files }));
}

export function isVisualArtifact(value: unknown): value is VisualArtifact {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<VisualArtifact> & { html?: unknown; spec?: unknown };
  return typeof item.id === "string" && typeof item.chatId === "string" && typeof item.title === "string"
    && ((item.kind === "chart" && !!item.spec && typeof item.spec === "object")
      || (item.kind === "html" && typeof item.html === "string"));
}

/** 지금 화면의 테마 토큰을 읽는다 — 차트 config 와 HTML 시각물이 같은 값을 쓴다. */
export function readVisualTheme(): VisualThemeTokens {
  const fallback: VisualThemeTokens = {
    ink: "#001519", inkSoft: "#51504e", tick: "#868483", grid: "#dcdedb", paper: "#ffffff", paperAlt: "#f6f6f5",
    accent: "#6b6e52", font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", dark: false,
  };
  if (typeof document === "undefined") return fallback;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, value: string) => style.getPropertyValue(name).trim() || value;
  const attr = document.documentElement.getAttribute("data-theme");
  const dark = attr === "dark" || (attr !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  return {
    ink: read("--ink", fallback.ink),
    inkSoft: read("--ink-soft", fallback.inkSoft),
    tick: read("--muted-deep", fallback.tick),
    // 다크에서는 --paper-edge-strong 이 반투명 흰색이라 격자로는 너무 밝다 — 한 단계 옅은 --paper-edge.
    grid: dark ? read("--paper-edge", "#2c2d36") : read("--paper-edge-strong", fallback.grid),
    paper: read("--paper", fallback.paper),
    paperAlt: read("--paper-3", fallback.paperAlt),
    accent: read("--accent", fallback.accent),
    font: read("--design-font-sans", "") || read("--font-body", fallback.font),
    dark,
  };
}

const COMPOSER_FILL_LIMIT = 2_000;
let lastComposerFill = 0;

/**
 * 시각물의 sendPrompt(text) — 작성창을 **채우기만** 한다(보내지 않는다). 사람이 읽고 Enter 를 누른다.
 * 셸을 거치지 않고 화면의 작성창(One: [data-one-composer] textarea, Work: textarea[data-chat-input])에
 * 네이티브 setter + input 이벤트로 넣는다 — React 제어 입력이 그대로 받는다. 1초에 한 번, 2,000자까지.
 */
export function fillComposer(text: string, near?: Element | null, limit: number = COMPOSER_FILL_LIMIT): boolean {
  if (typeof document === "undefined") return false;
  const now = Date.now();
  if (now - lastComposerFill < 1_000) return false;
  const value = String(text).replace(/\u0000/g, "").slice(0, Math.min(limit, 20_000)).trim();
  if (!value) return false;
  const candidates = [
    ...document.querySelectorAll<HTMLTextAreaElement>('[data-one-composer="true"] textarea, textarea[data-chat-input="true"]'),
  ].filter((el) => el.offsetParent !== null && !el.disabled);
  if (candidates.length === 0) return false;
  // 여러 칸(분할 창)이 있으면 시각물에 가장 가까운 작성창.
  const target = near && candidates.length > 1
    ? candidates.reduce((best, el) => {
      const a = near.getBoundingClientRect();
      const d = (node: HTMLTextAreaElement) => Math.abs(node.getBoundingClientRect().left - a.left);
      return d(el) < d(best) ? el : best;
    })
    : candidates[0];
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus();
  lastComposerFill = now;
  return true;
}

export function documentIsKorean(): boolean {
  return typeof document !== "undefined" && (document.documentElement.lang || "").toLowerCase().startsWith("ko");
}

/** 데이터 URL 을 파일로 내려받는다 — 네트워크 없음. */
export function downloadDataUrl(href: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function safeFileStem(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "visual";
}

/** 앱에 묶인 정적 자산 주소(public/…) — dev 서버·정적 빌드·file:// 셋 다에서 같은 파일. */
export function appAssetUrl(path: string): string {
  const current = new URL(window.location.href);
  const root = current.protocol === "file:" ? new URL("./", document.baseURI) : new URL("/", current.origin);
  return new URL(path.replace(/^\//, ""), root).href;
}

let chartJsSourcePromise: Promise<string | null> | null = null;
/** Chart.js 4.4.1(MIT) 사본을 한 번만 읽는다. 못 읽으면 null — 위젯은 CSP 로 막힌 채 원래 모양으로 남는다. */
export function loadChartJsSource(assetPath: string): Promise<string | null> {
  if (!chartJsSourcePromise) {
    chartJsSourcePromise = fetch(appAssetUrl(assetPath))
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => (text && text.includes("Chart.js v4") ? text : null))
      .catch(() => null);
  }
  return chartJsSourcePromise;
}

/** PNG 데이터 URL → 클립보드(그림). 안 되면 false — 화면에 "복사하지 못했어요" 를 보인다. */
export async function copyPngDataUrl(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: new (items: Record<string, Blob>) => unknown }).ClipboardItem;
    if (!ClipboardItemCtor || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob }) as never]);
    return true;
  } catch {
    return false;
  }
}
