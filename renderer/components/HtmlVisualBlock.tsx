"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  VISUAL_MAX_HEIGHT,
  VISUAL_CSP,
  CHARTJS_ASSET_PATH,
  usesKnownChartJs,
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
  copyPngDataUrl,
  documentIsKorean,
  fillComposer,
  loadChartJsSource,
  downloadDataUrl,
  readVisualTheme,
  requestVisualOpen,
  safeFileStem,
  useVisualChatScope,
  type VisualArtifact,
} from "@/lib/visual-artifacts";
import styles from "./VisualBlock.module.css";
import { VisualMenu } from "./VisualMenu";

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
  // Chart.js 를 쓰는 위젯(Claude show_widget 그대로)은 앱에 묶인 사본을 인라인으로 — 읽을 때까지 그리지 않는다.
  const needsChartJs = useMemo(() => screened.ok && usesKnownChartJs(html), [html, screened.ok]);
  const [chartJs, setChartJs] = useState<{ ready: boolean; source: string | null }>({ ready: false, source: null });
  useEffect(() => {
    if (!needsChartJs) return undefined;
    let cancelled = false;
    void loadChartJsSource(CHARTJS_ASSET_PATH).then((source) => { if (!cancelled) setChartJs({ ready: true, source }); });
    return () => { cancelled = true; };
  }, [needsChartJs]);
  // themeKey 는 토큰을 다시 읽게 하는 신호다.
  const srcdoc = useMemo(
    () => (screened.ok && (!needsChartJs || chartJs.ready) ? buildVisualSrcdoc(html, readVisualTheme(), frameId, chartJs.source) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, screened.ok, frameId, themeKey, needsChartJs, chartJs],
  );
  const snapshotWaiters = useRef(new Map<string, (url: string | null) => void>());

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
      if (data.type === "agentlas-visual:snapshot-result") {
        const result = data as { nonce?: unknown; dataUrl?: unknown };
        const waiter = typeof result.nonce === "string" ? snapshotWaiters.current.get(result.nonce) : undefined;
        if (waiter) {
          snapshotWaiters.current.delete(result.nonce as string);
          waiter(typeof result.dataUrl === "string" && result.dataUrl.startsWith("data:image/png") ? result.dataUrl : null);
        }
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
  const snapshot = () => new Promise<string | null>((resolve) => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) { resolve(null); return; }
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    snapshotWaiters.current.set(nonce, resolve);
    window.setTimeout(() => { if (snapshotWaiters.current.delete(nonce)) resolve(null); }, 5_000);
    frame.contentWindow.postMessage({ type: "agentlas-visual:snapshot", nonce, background: readVisualTheme().paper }, "*");
  });
  const save = () => {
    const doc = buildStandaloneVisualHtml(html, readVisualTheme(), title, chartJs.source);
    const url = URL.createObjectURL(new Blob([doc], { type: "text/html;charset=utf-8" }));
    downloadDataUrl(url, `${safeFileStem(title)}.html`);
    window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
  };
  return (
    <figure className={styles.visual} data-size={size} data-visual-kind="html" aria-label={title}>
      {size !== "thumb" && <VisualMenu ko={ko} label={ko ? "시각물 메뉴" : "Visual menu"} items={[
        { key: "copy", label: ko ? "클립보드에 복사" : "Copy to clipboard", run: async () => { const url = await snapshot(); return url ? copyPngDataUrl(url) : false; } },
        { key: "download", label: ko ? "파일 다운로드" : "Download file", run: () => { save(); } },
        ...(visual && size === "inline" ? [{ key: "panel", label: ko ? "패널에서 열기" : "Open in panel", run: () => { requestVisualOpen(visual); } }] : []),
      ]} />}
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
