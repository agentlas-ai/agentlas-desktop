import { canvasDocument } from "./render";
import type { CanvasView } from "./schema";

/**
 * The page a card is drawn from when it becomes a picture: the card's own HTML and styles (only the assets it uses), a white ground, no lead line.
 * `chrome: false` leaves the block alone (no card frame, header or source line), which is how a single asset or a slide is exported on its own.
 * The same markup the desktop and the phone draw, so the picture is the card the owner saw.
 */
export function canvasExportHtml(view: CanvasView, options: { chrome?: boolean } = {}): string {
  const doc = canvasDocument(view, { lead: false, background: "#ffffff" });
  const css = options.chrome === false
    ? "body{padding:0}.fpc-card{box-shadow:none;border:0;padding:0;margin:0;animation:none;background:transparent}.fpc .ch,.fpc .foot{display:none}.fpc .grid{margin-top:0}"
    : "body{padding:24px}.fpc-card{animation:none}";
  return doc.replace("</style>", `${css}</style>`);
}
