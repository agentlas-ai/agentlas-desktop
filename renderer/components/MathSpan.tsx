"use client";

import React, { useEffect, useState } from "react";

/**
 * 수식 — `$x^2$` 와 `$$...$$`.
 *
 * 조사한 챗 UI 여섯 곳(open-webui·lobe-chat·LibreChat·ai-chatbot·lobe-ui·chat-ui)이
 * 예외 없이 KaTeX 를 쓴다. 렌더가 동기이고 서버 없이 도는 것이 이유다 —
 * Electron 오프라인 환경에도 그대로 맞는다.
 *
 * KaTeX 는 `throwOnError: false` 로 두면 잘못된 수식을 붉은 원문으로 보여준다. 답변
 * 안의 `$100` 같은 평범한 달러 표기를 수식으로 잘못 잡는 일이 더 흔하므로, 판정은
 * 호출부의 정규식에서 좁게 하고 여기서는 실패해도 원문을 잃지 않는 것만 지킨다.
 */
export function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const katex = (await import("katex")).default;
        const out = katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          // \href 등으로 임의 링크를 만들지 못하게 한다 — 본문은 모델이 쓴 문자열이다.
          trust: false,
          strict: "ignore",
          output: "html",
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => { cancelled = true; };
  }, [tex, display]);

  // 아직 못 그렸거나 실패했으면 사람이 쓴 원문을 그대로 둔다.
  if (!html) {
    return display
      ? <div style={{ fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", margin: "8px 0" }}>{tex}</div>
      : <code style={{ fontFamily: "var(--font-mono)" }}>{tex}</code>;
  }
  // KaTeX 자체 출력이며 trust:false 라 임의 HTML 이 섞이지 않는다.
  return display
    ? <div className="agentlas-math-display" style={{ margin: "10px 0", overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: html }} />
    : <span className="agentlas-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}
