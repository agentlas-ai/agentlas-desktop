"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  VISUAL_MAX_HEIGHT,
  VISUAL_CSP,
  VISUAL_SANDBOX,
  VISUAL_PROMPT_MESSAGE,
  VISUAL_SIZE_MESSAGE,
  buildStandaloneVisualHtml,
  buildVisualSrcdoc,
  screenVisualHtml,
  visualRejectMessage,
  visualTitle,
} from "@/lib/visual-html";
import {
  announceVisual,
  documentIsKorean,
  fillComposer,
  downloadDataUrl,
  readVisualTheme,
  requestVisualOpen,
  safeFileStem,
  useVisualChatScope,
  type VisualArtifact,
} from "@/lib/visual-artifacts";
import styles from "./VisualBlock.module.css";

/** <html data-theme> 이 바뀌면 시각물을 새 토큰으로 다시 그린다. */
export function useVisualThemeKey(): string {
  const [key, setKey] = useState("");
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const read = () => setKey(document.documentElement.getAttribute("data-theme") ?? "");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return key;
}

/**
 * 에이전트가 만든 독립 HTML 시각물을 대화 안에 — 테두리 없이, 내용 높이만큼, 스크롤바 없이.
 * 격리: sandbox="allow-scripts" 하나(same-origin·top navigation·팝업·폼 없음), 문서 첫머리 CSP
 * + iframe csp 속성으로 네트워크 0. 문서가 스스로 다른 곳으로 넘어가면(두 번째 load) 내린다.
 */
export function HtmlVisualBlock({
  html,
  blockId,
  fallback,
  size = "inline",
  title: givenTitle,
}: {
  html: string;
  blockId: string;
  fallback: ReactNode;
  size?: "inline" | "panel" | "thumb";
  title?: string;
}) {
  const chatId = useVisualChatScope();
  const ko = documentIsKorean();
  const themeKey = useVisualThemeKey();
  const reactId = useId();
  const frameId = useMemo(() => `${blockId}:${reactId}`, [blockId, reactId]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const loadsRef = useRef(0);
  const [height, setHeight] = useState(size === "panel" ? 360 : 160);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const screened = useMemo(() => screenVisualHtml(html), [html]);
  const title = useMemo(() => givenTitle ?? visualTitle(html, ko ? "시각물" : "Visual"), [givenTitle, html, ko]);
  // themeKey 는 토큰을 다시 읽게 하는 신호다.
  const srcdoc = useMemo(
    () => (screened.ok ? buildVisualSrcdoc(html, readVisualTheme(), frameId) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, screened.ok, frameId, themeKey],
  );

  useEffect(() => {
    loadsRef.current = 0;
    setNavigatedAway(false);
  }, [srcdoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; id?: unknown; height?: unknown; text?: unknown } | null;
      if (!data || data.id !== frameId) return;
      // sendPrompt(text) — 작성창을 채우기만 한다(보내지 않는다). Claude show_widget 계약의 그 자리.
      if (data.type === VISUAL_PROMPT_MESSAGE) {
        if (typeof data.text === "string") fillComposer(data.text, frame);
        return;
      }
      if (data.type !== VISUAL_SIZE_MESSAGE) return;
      const next = typeof data.height === "number" && Number.isFinite(data.height) ? Math.max(24, Math.ceil(data.height)) : null;
      if (next === null) return;
      if (next > VISUAL_MAX_HEIGHT) {
        setHeight(VISUAL_MAX_HEIGHT);
        // 아주 긴 시각물만 안에서 스크롤한다.
        frame.contentWindow?.postMessage({ type: "agentlas-visual:overflow" }, "*");
      } else {
        setHeight(next);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId]);

  const visual: VisualArtifact | null = useMemo(() => (screened.ok && chatId
    ? { id: `html:${blockId}`, chatId, kind: "html", title, html }
    : null), [screened.ok, chatId, blockId, title, html]);
  useEffect(() => {
    if (visual && size === "inline") announceVisual(visual);
  }, [visual, size]);

  if (!screened.ok) {
    return <>
      {fallback}
      {screened.code !== "empty" && <p className={styles.refusal} data-visual-refusal={screened.code}>{visualRejectMessage(screened.code, ko)}</p>}
    </>;
  }
  if (navigatedAway) {
    return <p className={styles.refusal} data-visual-refusal="navigated">
      {ko ? "이 시각물이 다른 주소로 넘어가려 해서 내렸어요." : "This visual tried to navigate away, so it was taken down."}
    </p>;
  }
  const save = () => {
    const doc = buildStandaloneVisualHtml(html, readVisualTheme(), title);
    const url = URL.createObjectURL(new Blob([doc], { type: "text/html;charset=utf-8" }));
    downloadDataUrl(url, `${safeFileStem(title)}.html`);
    window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
  };
  return (
    <figure className={styles.visual} data-size={size} data-visual-kind="html" aria-label={title}>
      {size !== "thumb" && <div className={styles.tools} role="toolbar" aria-label={ko ? "시각물 도구" : "Visual tools"}>
        {visual && size === "inline" && <button type="button" onClick={() => requestVisualOpen(visual)}>{ko ? "패널에서 열기" : "Open in panel"}</button>}
        <button type="button" onClick={save}>{ko ? "HTML 저장" : "Save HTML"}</button>
      </div>}
      <iframe
        ref={frameRef}
        className={styles.frame}
        title={title}
        sandbox={VISUAL_SANDBOX}
        // CSP Embedded Enforcement — 문서 안 메타와 같은 정책을 부모가 한 번 더 요구한다.
        {...({ csp: VISUAL_CSP } as Record<string, string>)}
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        scrolling="no"
        tabIndex={size === "thumb" ? -1 : undefined}
        style={{ height }}
        data-visual-frame="true"
        onLoad={() => {
          loadsRef.current += 1;
          if (loadsRef.current > 1) setNavigatedAway(true);
        }}
      />
    </figure>
  );
}
