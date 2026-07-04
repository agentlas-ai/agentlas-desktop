"use client";
// 문서 스튜디오 로컬 영속 — 소스(참고문헌) + 인용 스타일을 localStorage에 저장.
// 데스크톱 단일 사용자 로컬 앱이라 localStorage로 충분(서버/DB 불필요).
import type { CitationStyle, Reference } from "./citations";

const REF_KEY = "agentlas.docstudio.references.v1";
const STYLE_KEY = "agentlas.docstudio.style.v1";

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
