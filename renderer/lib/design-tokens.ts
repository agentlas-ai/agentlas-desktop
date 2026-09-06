/**
 * 색의 정본은 renderer/app/globals.css 의 :root 토큰 블록 하나뿐이다(오너 결정 2026-09-05).
 * 그런데 캔버스·WebGL·지도 엔진처럼 CSS 밖에서 그리는 곳은 `var(--token)` 을 해석하지 못한다.
 * 그런 자리에서는 색을 다시 적지 말고 이 함수로 같은 토큰을 읽어 쓴다.
 */
export function resolveCssColour(value: string, fallback = "#000000"): string {
  const token = /^var\(\s*(--[a-z0-9-]+)\s*(?:,([^)]*))?\)$/i.exec(value.trim());
  if (!token) return value;
  if (typeof window === "undefined" || typeof document === "undefined") return (token[2] ?? fallback).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(token[1]).trim();
  if (resolved) return resolveCssColour(resolved, fallback);
  return (token[2] ?? fallback).trim();
}
