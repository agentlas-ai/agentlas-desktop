import { BrowserWindow, session, type Session } from "electron";
import { APP_CONTROL_MAIN_BUDGET_MS } from "../daemon/device-bridge";
import { flowHtml, RENDER_SLIDE_WIDTH, sheetPagesHtml, slidePagesHtml } from "./render-html";
import { liveDocumentSnapshot, LiveDocumentError } from "./store";
import { LIVE_DOCUMENT_RENDER_MAX_PAGES, type LiveDocumentRenderReply } from "../../shared/live-document";

/*
 * Main only (it opens a window): photographs the slides, pages or sheets of a live document for document.render. The daemon
 * reaches it through app.call liveDocument.render over the device bridge, like every Main-only operation. The page images
 * leave here as data URLs; app-control saves them as observation captures before the reply is clipped (service.ts
 * saveResultImages), and the harness hands those files to models that read images.
 *
 * The window is isolated like an artifact observation (app-factory/artifact-render.ts): one session partition shared by every
 * render (nothing is stored in it), every request but the data: page refused, no preload. Only our own markup is loaded; the
 * scripts run here are ours.
 *
 * Paging: a call returns at most LIVE_DOCUMENT_RENDER_MAX_PAGES images starting at `from`, with the document's `total` and a
 * `next` hint, so a long document is seen whole by walking it. The call has one deadline for everything it does (waiting for
 * an earlier render, layout, scripts, capture): it is shorter than the time Main gives the daemon's request, it destroys the
 * window, and it always lets the next render start. Pages finished before the deadline are returned (`stopped: "deadline"`).
 */

type LiveDocumentRenderResult = LiveDocumentRenderReply;
type LiveDocumentRenderOk = Extract<LiveDocumentRenderReply, { ok: true }>;
type LiveDocumentRenderPage = LiveDocumentRenderOk["pages"][number];
type LiveDocumentRenderOverflow = LiveDocumentRenderOk["overflow"][number];

const MAX_SHEET_PX = { width: 2400, height: 3000 };
/**
 * The whole call, queue wait included, answers before Main's own limit for a daemon request (device-bridge.ts
 * APP_CONTROL_MAIN_BUDGET_MS): a render that is too slow is reported here with its reason instead of as "did not finish".
 */
export const RENDER_DEADLINE_MS = APP_CONTROL_MAIN_BUDGET_MS - 1_500;
/** A render that gets its turn behind another with less than this left would not finish a page: it says "busy". */
const MIN_START_MS = 1_000;
const NOTE = "Agentlas's own layout of the document's current working state (the Document tab's), including edits not yet saved with document.save: fonts and line breaks can differ from Office. Text is not clipped, so a box that overflows shows it.";

let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
let renderPartition: Session | null = null;

/** One in-memory partition for every render window: a partition per render is never released by Electron. */
function renderSession(): Session {
  if (renderPartition) return renderPartition;
  const created = session.fromPartition("document-render");
  created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  renderPartition = created;
  return created;
}

interface Budget {
  remaining(): number;
  /** The work, or render_timeout when the deadline comes first (a hung page or capture never settles on its own). */
  within<T>(work: Promise<T>): Promise<T>;
}

const seconds = (ms: number): string => { const whole = Math.max(1, Math.floor(ms / 1000)); return `${whole} second${whole === 1 ? "" : "s"}`; };

function budgetUntil(at: number, startedAt: number): Budget {
  const expired = () => new LiveDocumentError("render_timeout",
    `Rendering this document took longer than ${seconds(at - startedAt)} and was stopped before the first page was done. Ask for fewer pages (count) or a later range (from), or read the text with document.read.`);
  return {
    remaining: () => at - Date.now(),
    within: <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const left = at - Date.now();
      // Always attach the handlers: a rejection of work that lost the race must not surface as an unhandled rejection.
      if (left <= 0) { work.then(() => undefined, () => undefined); reject(expired()); return; }
      const timer = setTimeout(() => reject(expired()), left);
      work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    }),
  };
}

async function withWindow<T>(width: number, height: number, budget: Budget, progress: Progress, use: (window: BrowserWindow) => Promise<T>): Promise<T> {
  // enableLargerThanScreen: an A0 page or a tall slide deck is taller than the screen (macOS clamps a window to it otherwise;
  // the other systems allow it already).
  const window = new BrowserWindow({ show: false, width, height, useContentSize: true, paintWhenInitiallyHidden: true, enableLargerThanScreen: true,
    webPreferences: { session: renderSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  // renderOne destroys it at the deadline too: a script that never returns or a capture that never settles would otherwise keep
  // the `finally` below from ever running.
  progress.window = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("data:")) event.preventDefault(); });
  try { return await use(window); }
  finally { if (!window.isDestroyed()) window.destroy(); }
}

async function load(window: BrowserWindow, html: string, budget: Budget): Promise<void> {
  await budget.within(window.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`));
  await budget.within(window.webContents.executeJavaScript("document.fonts.ready.then(() => true)", true));
}

async function photograph(window: BrowserWindow, width: number, budget: Budget): Promise<string> {
  const image = await budget.within(window.webContents.capturePage());
  const size = image.getSize();
  return `data:image/png;base64,${(size.width > width ? image.resize({ width, quality: "best" }) : image).toPNG().toString("base64")}`;
}

/** Boxes whose text runs past the box, or out of the page. */
const MEASURE = `(() => { const page = document.querySelector('.slide') || document.body; const p = page.getBoundingClientRect(); const out = [];
  for (const el of document.querySelectorAll('[data-box]')) { const r = el.getBoundingClientRect();
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) out.push([el.dataset.box, 'text_overflows_box']);
    else if (r.right > p.right + 1 || r.bottom > p.bottom + 1 || r.left < p.left - 1 || r.top < p.top - 1) out.push([el.dataset.box, 'outside_page']); }
  return out; })()`;

/**
 * Moves a block that would cross a page edge to the next page (a break marks a page start/end); returns the page count.
 * The page a block ends on is arithmetic, never a loop that waits for the page edge to pass it (a page height of 0 never would);
 * a page height under 100 px (render-html.ts already refused those) answers -1.
 */
const PAGINATE = (pageHeight: number) => `(() => { const doc = document.querySelector('.doc'); const H = ${pageHeight}; if (!(H >= 100)) return -1;
  const top = Number(doc.dataset.pageTop) || 0, bottom = Number(doc.dataset.pageBottom) || 0, body = H - top - bottom; let page = 0, forceNext = false;
  const push = (el) => { const target = (page + 1) * H + top; el.style.marginTop = ((parseFloat(getComputedStyle(el).marginTop) || 0) + target - el.offsetTop) + 'px'; page += 1; };
  for (const el of doc.querySelectorAll('.blk')) {
    if ((forceNext || el.dataset.break === 'before') && el.offsetTop > page * H + top + 1) push(el);
    forceNext = false;
    if (el.offsetTop + el.offsetHeight > (page + 1) * H - bottom && el.offsetHeight <= body && el.offsetTop > page * H + top + 1) push(el);
    page = Math.max(page, Math.ceil((el.offsetTop + el.offsetHeight + bottom) / H) - 1);
    if (el.dataset.break === 'after') forceNext = true;
  }
  doc.style.minHeight = ((page + 1) * H) + 'px'; return page + 1; })()`;

interface RenderRange { from: number; count: number }

function rangeOf(options: { from?: unknown; count?: unknown }): RenderRange {
  const from = typeof options.from === "number" && Number.isSafeInteger(options.from) && options.from >= 1 ? options.from : 1;
  const count = typeof options.count === "number" && Number.isSafeInteger(options.count) && options.count >= 1 ? Math.min(options.count, LIVE_DOCUMENT_RENDER_MAX_PAGES) : LIVE_DOCUMENT_RENDER_MAX_PAGES;
  return { from, count };
}

/** What a render has produced so far; a deadline in the middle still returns it. */
interface Progress {
  format: string;
  unit: "slide" | "page" | "sheet";
  total: number;
  from: number;
  pages: LiveDocumentRenderPage[];
  overflow: LiveDocumentRenderOverflow[];
  truncated?: string;
  /** The render window, so the deadline can destroy it whatever the page or the capture is doing. */
  window?: BrowserWindow;
}

/** The 0-based index of the first image, or the typed refusal for a `from` past the end. */
function startOf(range: RenderRange, total: number, unit: Progress["unit"]): number {
  if (total === 0) return 0;
  if (range.from > total) throw new LiveDocumentError("page_out_of_range", `This document has ${total} ${unit}${total === 1 ? "" : "s"}; from must be 1-${total}.`);
  return range.from - 1;
}

async function renderNow(sessionId: string, range: RenderRange, budget: Budget, progress: Progress): Promise<void> {
  const { model, meta } = await budget.within(liveDocumentSnapshot(sessionId));
  progress.format = meta.format;
  if (model.kind === "slides") {
    const all = slidePagesHtml(model);
    progress.unit = "slide"; progress.total = all.length;
    const start = startOf(range, all.length, "slide");
    progress.from = start + 1;
    const shown = all.slice(start, start + range.count);
    if (shown.length) await withWindow(shown[0].width, shown[0].height, budget, progress, async (window) => {
      for (const [offset, page] of shown.entries()) {
        window.setContentSize(page.width, page.height);
        await load(window, page.html, budget);
        const index = start + offset + 1;
        for (const [box, kind] of await budget.within(window.webContents.executeJavaScript(MEASURE, true)) as Array<[string, LiveDocumentRenderOverflow["kind"]]>) progress.overflow.push({ page: index, box, kind });
        progress.pages.push({ index, label: page.label, width: page.width, height: page.height, dataUrl: await photograph(window, RENDER_SLIDE_WIDTH, budget) });
      }
    });
  } else if (model.kind === "flow") {
    const flow = flowHtml(model);
    progress.unit = "page";
    await withWindow(flow.width, flow.pageHeight, budget, progress, async (window) => {
      await load(window, flow.html, budget);
      const count = Number(await budget.within(window.webContents.executeJavaScript(PAGINATE(flow.pageHeight), true)));
      if (!(count >= 1)) throw new LiveDocumentError("render_failed", "the pages could not be laid out");
      progress.total = count;
      const start = startOf(range, count, "page");
      progress.from = start + 1;
      const wide = await budget.within(window.webContents.executeJavaScript(`[...document.querySelectorAll('.blk')].filter((el) => el.scrollWidth > document.querySelector('.doc').clientWidth + 2 || el.getBoundingClientRect().right > document.querySelector('.doc').getBoundingClientRect().right + 1).map((el) => el.dataset.block)`, true)) as string[];
      for (const box of wide) progress.overflow.push({ page: 0, box, kind: "outside_page" });
      for (let index = start; index < Math.min(count, start + range.count); index += 1) {
        await budget.within(window.webContents.executeJavaScript(`window.scrollTo(0, ${index * flow.pageHeight}); new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`, true));
        progress.pages.push({ index: index + 1, label: `page ${index + 1}`, width: flow.width, height: flow.pageHeight, dataUrl: await photograph(window, flow.width, budget) });
      }
    });
  } else {
    const sheets = sheetPagesHtml(model);
    progress.unit = "sheet"; progress.total = sheets.length;
    const start = startOf(range, sheets.length, "sheet");
    progress.from = start + 1;
    const shown = sheets.slice(start, start + range.count);
    const cut = shown.filter((sheet) => sheet.truncated).map((sheet) => sheet.label);
    if (cut.length) progress.truncated = `${cut.join(", ")}: first 60 rows x 20 columns`;
    if (shown.length) await withWindow(1200, 900, budget, progress, async (window) => {
      for (const [offset, sheet] of shown.entries()) {
        window.setContentSize(1200, 900);
        await load(window, sheet.html, budget);
        const [w, h] = await budget.within(window.webContents.executeJavaScript(`(() => { const r = document.querySelector('.wrap').getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)]; })()`, true)) as [number, number];
        const width = Math.max(200, Math.min(MAX_SHEET_PX.width, w)), height = Math.max(120, Math.min(MAX_SHEET_PX.height, h));
        window.setContentSize(width, height);
        await budget.within(window.webContents.executeJavaScript("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))", true));
        progress.pages.push({ index: start + offset + 1, label: sheet.label, width, height, dataUrl: await photograph(window, width, budget) });
      }
    });
  }
}

function replyOf(progress: Progress, stopped?: "deadline"): LiveDocumentRenderOk {
  const last = progress.from - 1 + progress.pages.length;
  const rest = progress.total - last;
  const next = rest > 0 ? `${rest} more ${progress.unit}${rest === 1 ? "" : "s"} (${last + 1}-${progress.total} of ${progress.total}) not shown: call document.render again with from: ${last + 1}` : undefined;
  return { ok: true, format: progress.format, renderer: "agentlas-layout", note: NOTE, total: progress.total, from: progress.from,
    pages: [...progress.pages], overflow: [...progress.overflow], ...(progress.truncated ? { truncated: progress.truncated } : {}),
    ...(next ? { next } : {}), ...(stopped ? { stopped } : {}) };
}

/** A typed refusal: the reason of a LiveDocumentError (or of render-html's RenderGeometryError) with its words, else render_failed. */
function refusal(error: unknown): LiveDocumentRenderResult {
  const reason = (error as { reason?: unknown } | null)?.reason;
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof reason === "string") return { ok: false, code: reason, ...(typeof detail === "string" && detail ? { message: detail } : {}) };
  return { ok: false, code: "render_failed", message: error instanceof Error ? error.message.slice(0, 200) : "render failed" };
}

async function renderOne(sessionId: string, range: RenderRange, startedAt: number, deadlineAt: number, behindAnother: boolean): Promise<LiveDocumentRenderResult> {
  const budget = budgetUntil(deadlineAt, startedAt);
  if (behindAnother && budget.remaining() < MIN_START_MS) {
    return { ok: false, code: "render_busy", message: "Another document is still being photographed. Try again in a few seconds." };
  }
  const progress: Progress = { format: "", unit: "page", total: 0, from: range.from, pages: [], overflow: [] };
  try {
    await budget.within(renderNow(sessionId, range, budget, progress));
    return replyOf(progress);
  } catch (error) {
    if (error instanceof LiveDocumentError && error.reason === "render_timeout" && progress.pages.length) return replyOf(progress, "deadline");
    return refusal(error);
  } finally {
    // Before the reply is returned: a render that ran out of time leaves no window behind it, however the page is stuck.
    if (progress.window && !progress.window.isDestroyed()) progress.window.destroy();
  }
}

/**
 * One render at a time: each opens a window. `deadlineMs` can only shorten RENDER_DEADLINE_MS (the gates use it); it is not an
 * argument of the IPC.
 */
export function renderLiveDocument(sessionId: string, options: { from?: unknown; count?: unknown; deadlineMs?: number } = {}): Promise<LiveDocumentRenderResult> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(1, Math.min(options.deadlineMs ?? RENDER_DEADLINE_MS, RENDER_DEADLINE_MS));
  const range = rangeOf(options);
  const behindAnother = waiting > 0;
  waiting += 1;
  // renderOne settles by the deadline whatever the page does and never throws: the next render always gets its turn.
  const run = queue.then(() => renderOne(sessionId, range, startedAt, deadlineAt, behindAnother))
    .catch((error: unknown) => refusal(error))
    .finally(() => { waiting -= 1; });
  queue = run;
  return run;
}
