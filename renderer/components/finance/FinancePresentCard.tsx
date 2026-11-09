"use client";

import { useEffect, useId, useState } from "react";
import { FINANCE_CANVAS_CSS, financeCanvasBodyHtml, financeCanvasFromLegacy, financeCanvasLeadHtml } from "@shared/finance-canvas";
import { assetCssFor, assetsInstalled, isBaseCanvasBlock } from "@shared/canvas";
import styles from "./FinancePresentCard.module.css";

/** finance.present: the answer's own result card. Drawn by the same HTML the phone shows (shared/finance-canvas.ts): its lead line sits
 *  above the answer text, its body under it. Every string in it is escaped by the renderer; links open in the browser. */
type AnyView = { kind: string } & Record<string, unknown>;

let cssInstalled = false;
function installCss() {
  if (cssInstalled || typeof document === "undefined") return;
  cssInstalled = true;
  const style = document.createElement("style");
  style.id = "finance-canvas-css";
  style.textContent = FINANCE_CANVAS_CSS;
  document.head.appendChild(style);
}

/** An asset block's own styles (a diagram, a slide ...), installed the first time a card holds one; the base styles above cover the figure blocks. */
const installedAssets = new Set<string>();
function installAssetCss(blocks: readonly { type: string }[]) {
  if (typeof document === "undefined") return;
  for (const block of blocks) {
    if (isBaseCanvasBlock(block) || installedAssets.has(block.type)) continue;
    installedAssets.add(block.type);
    const css = assetCssFor([block.type]);
    if (!css) continue;
    const style = document.createElement("style");
    style.dataset.canvasAsset = block.type;
    style.textContent = css;
    document.head.appendChild(style);
  }
}

export function FinancePresentLead({ view }: { view: AnyView; asked?: string; locale?: "ko" | "en" }) {
  const canvas = financeCanvasFromLegacy(view);
  installCss();
  // A card of assets alone (a diagram, a slide) read no sources and has no lead line: nothing is drawn, and the answer text is not styled as a headline.
  const html = canvas ? financeCanvasLeadHtml(canvas) : "";
  return html ? <div className={`fpc ${styles.lead}`} data-finance-lead={canvas!.kind} dangerouslySetInnerHTML={{ __html: html }}/> : null;
}

/** The asset blocks (hundreds of KB of drawing code) are not in the app's main bundle: a card that holds one loads them once, then draws. */
let assetsLoading: Promise<unknown> | null = null;
function useAssets(needed: boolean): { status: "ready" | "loading" | "failed"; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<"loading" | "failed" | "ready">("loading");
  useEffect(() => {
    if (!needed || assetsInstalled()) return;
    let live = true;
    setResult("loading");
    const pending = assetsLoading ??= import("@shared/canvas/blocks/registry");
    void pending.then(() => {
      if (live) setResult(assetsInstalled() ? "ready" : "failed");
    }, () => {
      if (assetsLoading === pending) assetsLoading = null;
      if (live) setResult("failed");
    });
    return () => { live = false; };
  }, [needed, attempt]);
  return { status: !needed || assetsInstalled() ? "ready" : result, retry: () => setAttempt(value => value + 1) };
}

export function FinancePresentBody({ view, locale = "en" }: { view: AnyView; locale?: "ko" | "en" }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const canvas = financeCanvasFromLegacy(view);
  const assets = useAssets(!!canvas && canvas.blocks.some(block => !isBaseCanvasBlock(block)));
  installCss();
  if (!canvas) return null;
  if (assets.status === "loading") return <p role="status">{locale === "ko" ? "결과 화면을 불러오는 중…" : "Loading the result…"}</p>;
  if (assets.status === "failed") {
    // Preserve the base figures even when a separately loaded visual cannot be drawn.
    const blocks = canvas.blocks.filter(isBaseCanvasBlock);
    return <>
      {blocks.length > 0 && <div className="fpc" data-finance-present={canvas.kind} dangerouslySetInnerHTML={{ __html: financeCanvasBodyHtml({ ...canvas, blocks }, uid) }}/>}
      <div role="alert">
        <p>{locale === "ko" ? "일부 결과 화면을 불러오지 못했습니다. 다시 시도해도 표시되지 않으면 작업을 저장한 뒤 앱을 다시 열어 주세요." : "Some visuals could not be loaded. If retrying does not help, save your work and reopen the app."}</p>
        <button type="button" onClick={assets.retry}>{locale === "ko" ? "다시 시도" : "Try again"}</button>
      </div>
    </>;
  }
  installAssetCss(canvas.blocks);
  return <div className="fpc" data-finance-present={canvas.kind} dangerouslySetInnerHTML={{ __html: financeCanvasBodyHtml(canvas, uid) }}/>;
}
