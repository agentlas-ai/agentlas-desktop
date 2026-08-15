"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ```mermaid 코드블록을 그림으로 그린다.
 *
 * 어떤 라이브러리를 쓸지는 실제 채택 사례에서 골랐다. mermaid 본체(89.8K★)는 사실상
 * 표준이지만 수 MB에 비동기 렌더라 스트리밍 중 답변에는 무겁다. beautiful-mermaid
 * (10.9K★, MIT)는 의존성이 둘뿐이고 336KB이며 **동기** SVG 렌더를 제공한다 —
 * lobe-ui 가 mermaid 대신 이것을 쓴다. 지원 종류는 6종(플로우·상태·시퀀스·클래스·
 * ER·XY 차트)으로 적지만, 대화에서 실제로 나오는 것은 대부분 그 안에 있다.
 *
 * 세 가지를 지킨다:
 *  1. 번들을 초기 로드에 넣지 않는다 — 다이어그램이 실제로 나올 때만 import 한다.
 *  2. 만들어진 SVG 는 그대로 믿지 않는다 — 문자열을 innerHTML 로 넣는 자리라
 *     DOMPurify 를 거친다(open-webui·LibreChat·chat-ui 가 모두 그렇게 한다).
 *  3. 그리지 못하면 조용히 사라지지 않는다 — 원문 코드를 그대로 보여준다. 사람이 쓴
 *     내용을 렌더 실패로 없애는 것은 이 제품이 이미 한 번 겪은 실수다.
 */
export function MermaidBlock({ code, fallback }: { code: string; fallback: React.ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 스트리밍 중에는 코드가 계속 자란다 — 같은 내용에 재렌더를 반복하지 않는다.
  const source = useMemo(() => code.trim(), [code]);

  useEffect(() => {
    let cancelled = false;
    if (!source) return;
    (async () => {
      try {
        const [{ renderMermaidSVG }, purify] = await Promise.all([
          import("beautiful-mermaid"),
          import("dompurify"),
        ]);
        const raw = renderMermaidSVG(source, { theme: prefersDark() ? "dark" : "light" } as never);
        if (cancelled) return;
        const clean = purify.default.sanitize(raw, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_ATTR: ["dominant-baseline", "text-anchor"],
        });
        setSvg(clean);
        setFailed(false);
      } catch {
        // 문법이 아직 덜 왔거나(스트리밍) 지원하지 않는 종류다. 원문을 보여준다.
        if (!cancelled) { setSvg(null); setFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  if (failed || !svg) return <>{fallback}</>;
  return (
    <div
      ref={hostRef}
      className="agentlas-mermaid"
      // 위 sanitize 를 통과한 SVG 만 들어온다.
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{
        margin: "8px 0",
        padding: "12px",
        border: "1px solid var(--line, rgba(0,0,0,0.08))",
        borderRadius: "var(--radius-md, 10px)",
        background: "var(--surface-muted, rgba(0,0,0,0.02))",
        overflowX: "auto",
      }}
    />
  );
}

function prefersDark(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") return true;
    if (attr === "light") return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  } catch {
    return false;
  }
}
