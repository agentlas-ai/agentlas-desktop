"use client";

import { useId } from "react";
import { FINANCE_CANVAS_CSS, financeCanvasBodyHtml, financeCanvasFromLegacy, financeCanvasLeadHtml } from "@shared/finance-canvas";
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

export function FinancePresentLead({ view }: { view: AnyView; asked?: string; locale?: "ko" | "en" }) {
  const canvas = financeCanvasFromLegacy(view);
  installCss();
  return canvas ? <div className={`fpc ${styles.lead}`} data-finance-lead={canvas.kind} dangerouslySetInnerHTML={{ __html: financeCanvasLeadHtml(canvas) }}/> : null;
}

export function FinancePresentBody({ view }: { view: AnyView; locale?: "ko" | "en" }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const canvas = financeCanvasFromLegacy(view);
  installCss();
  return canvas ? <div className="fpc" data-finance-present={canvas.kind} dangerouslySetInnerHTML={{ __html: financeCanvasBodyHtml(canvas, uid) }}/> : null;
}
