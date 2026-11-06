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
function useAssets(needed: boolean): boolean {
  const [, ready] = useState(0);
  useEffect(() => {
    if (!needed || assetsInstalled()) return;
    let live = true;
    assetsLoading ??= import("@shared/canvas/blocks/registry").catch(() => { assetsLoading = null; });
    void assetsLoading.then(() => { if (live) ready(n => n + 1); });
    return () => { live = false; };
  }, [needed]);
  return !needed || assetsInstalled();
}

export function FinancePresentBody({ view }: { view: AnyView; locale?: "ko" | "en" }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const canvas = financeCanvasFromLegacy(view);
  const loaded = useAssets(!!canvas && canvas.blocks.some(block => !isBaseCanvasBlock(block)));
  installCss();
  // Until the assets are loaded the card is not drawn at all (a figure card, which needs none, draws at once).
  if (canvas && !loaded) return null;
  if (canvas) installAssetCss(canvas.blocks);
  return canvas ? <div className="fpc" data-finance-present={canvas.kind} dangerouslySetInnerHTML={{ __html: financeCanvasBodyHtml(canvas, uid) }}/> : null;
}
