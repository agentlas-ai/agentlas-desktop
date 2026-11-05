/** Finance names for the result-card canvas, which moved to shared/canvas (one tool, ui.canvas; owner). Kept so every import and test still works. */
export {
  CANVAS_TONES as FINANCE_CANVAS_TONES,
  CANVAS_UNITS as FINANCE_CANVAS_UNITS,
  CANVAS_WIDTHS as FINANCE_CANVAS_WIDTHS,
  CANVAS_BLOCKS as FINANCE_CANVAS_BLOCKS,
  CanvasInputSchema as FinanceCanvasInputSchema,
  CanvasViewSchema as FinanceCanvasViewSchema,
  canvasFigure as financeCanvasFigure,
  canvasLine as financeCanvasLine,
  canvasKorean as financeCanvasKorean,
  canvasValue as financeCanvasValue,
  canvasSourceShortName as financeSourceShortName,
  canvasLeadHtml as financeCanvasLeadHtml,
  canvasBodyHtml as financeCanvasBodyHtml,
  CANVAS_CSS as FINANCE_CANVAS_CSS,
  canvasDocument as financeCanvasDocument,
  canvasFromLegacy as financeCanvasFromLegacy,
} from "./canvas";
export type {
  CanvasInput as FinanceCanvasInput,
  CanvasBlockInput as FinanceCanvasBlockInput,
  CanvasChart as FinanceCanvasChart,
  CanvasBlock as FinanceCanvasBlock,
  CanvasView as FinanceCanvasView,
  CanvasLine as FinanceCanvasLine,
} from "./canvas";
