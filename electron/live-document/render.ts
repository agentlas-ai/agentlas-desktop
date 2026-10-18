import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { flowHtml, RENDER_SLIDE_WIDTH, sheetPagesHtml, slidePagesHtml } from "./render-html";
import { liveDocumentSnapshot, LiveDocumentError } from "./store";
import type { LiveDocumentRenderReply } from "../../shared/live-document";

/*
 * Main only (it opens a window): photographs each slide, page or sheet of a live document for document.render. The daemon
 * reaches it through app.call liveDocument.render over the device bridge, like every Main-only operation. The page images
 * leave here as data URLs; app-control saves them as observation captures before the reply is clipped (service.ts
 * saveResultImages), and the harness hands those files to models that read images.
 *
 * The window is isolated like an artifact observation (app-factory/artifact-render.ts): its own session partition, every
 * request but the data: page refused, no preload. Only our own markup is loaded; the scripts run here are ours.
 */

type LiveDocumentRenderResult = LiveDocumentRenderReply;
type LiveDocumentRenderPage = Extract<LiveDocumentRenderReply, { ok: true }>["pages"][number];
type LiveDocumentRenderOverflow = Extract<LiveDocumentRenderReply, { ok: true }>["overflow"][number];

const MAX_PAGES = 30;
const MAX_SHEET_PX = { width: 2400, height: 3000 };
const LOAD_TIMEOUT_MS = 15_000;
const NOTE = "Agentlas's own layout of the saved document (the Document tab's): fonts and line breaks can differ from Office. Text is not clipped, so a box that overflows shows it.";

let queue: Promise<unknown> = Promise.resolve();

async function withWindow<T>(width: number, height: number, use: (window: BrowserWindow) => Promise<T>): Promise<T> {
  const partition = session.fromPartition(`document-render-${randomUUID()}`);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  const window = new BrowserWindow({ show: false, width, height, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("data:")) event.preventDefault(); });
  try { return await use(window); }
  finally { if (!window.isDestroyed()) window.destroy(); }
}

async function load(window: BrowserWindow, html: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    window.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new LiveDocumentError("render_timeout")), LOAD_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)", true);
}

async function photograph(window: BrowserWindow, width: number): Promise<string> {
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  return `data:image/png;base64,${(size.width > width ? image.resize({ width, quality: "best" }) : image).toPNG().toString("base64")}`;
}

/** Boxes whose text runs past the box, or out of the page. */
const MEASURE = `(() => { const page = document.querySelector('.slide') || document.body; const p = page.getBoundingClientRect(); const out = [];
  for (const el of document.querySelectorAll('[data-box]')) { const r = el.getBoundingClientRect();
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) out.push([el.dataset.box, 'text_overflows_box']);
    else if (r.right > p.right + 1 || r.bottom > p.bottom + 1 || r.left < p.left - 1 || r.top < p.top - 1) out.push([el.dataset.box, 'outside_page']); }
  return out; })()`;

/** Moves a block that would cross a page edge to the next page (a break marks a page start/end); returns the page count. */
const PAGINATE = (pageHeight: number) => `(() => { const doc = document.querySelector('.doc'); const H = ${pageHeight};
  const top = Number(doc.dataset.pageTop) || 0, bottom = Number(doc.dataset.pageBottom) || 0, body = H - top - bottom; let page = 0, forceNext = false;
  const push = (el) => { const target = (page + 1) * H + top; el.style.marginTop = ((parseFloat(getComputedStyle(el).marginTop) || 0) + target - el.offsetTop) + 'px'; page += 1; };
  for (const el of doc.querySelectorAll('.blk')) {
    if ((forceNext || el.dataset.break === 'before') && el.offsetTop > page * H + top + 1) push(el);
    forceNext = false;
    if (el.offsetTop + el.offsetHeight > (page + 1) * H - bottom && el.offsetHeight <= body && el.offsetTop > page * H + top + 1) push(el);
    while (el.offsetTop + el.offsetHeight > (page + 1) * H - bottom) page += 1;
    if (el.dataset.break === 'after') forceNext = true;
  }
  doc.style.minHeight = ((page + 1) * H) + 'px'; return page + 1; })()`;

async function renderNow(sessionId: string): Promise<LiveDocumentRenderResult> {
  const { model, meta } = await liveDocumentSnapshot(sessionId);
  const pages: LiveDocumentRenderPage[] = [];
  const overflow: LiveDocumentRenderOverflow[] = [];
  let truncated: string | undefined;
  if (model.kind === "slides") {
    const all = slidePagesHtml(model);
    if (all.length > MAX_PAGES) truncated = `first ${MAX_PAGES} of ${all.length} slides`;
    const shown = all.slice(0, MAX_PAGES);
    if (shown.length) await withWindow(shown[0].width, shown[0].height, async (window) => {
      for (const [index, page] of shown.entries()) {
        window.setContentSize(page.width, page.height);
        await load(window, page.html);
        for (const [box, kind] of await window.webContents.executeJavaScript(MEASURE, true) as Array<[string, LiveDocumentRenderOverflow["kind"]]>) overflow.push({ page: index + 1, box, kind });
        pages.push({ index: index + 1, label: page.label, width: page.width, height: page.height, dataUrl: await photograph(window, RENDER_SLIDE_WIDTH) });
      }
    });
  } else if (model.kind === "flow") {
    const flow = flowHtml(model);
    await withWindow(flow.width, flow.pageHeight, async (window) => {
      await load(window, flow.html);
      const count = Number(await window.webContents.executeJavaScript(PAGINATE(flow.pageHeight), true)) || 1;
      if (count > MAX_PAGES) truncated = `first ${MAX_PAGES} of ${count} pages`;
      const wide = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.blk')].filter((el) => el.scrollWidth > document.querySelector('.doc').clientWidth + 2 || el.getBoundingClientRect().right > document.querySelector('.doc').getBoundingClientRect().right + 1).map((el) => el.dataset.block)`, true) as string[];
      for (let index = 0; index < Math.min(count, MAX_PAGES); index += 1) {
        await window.webContents.executeJavaScript(`window.scrollTo(0, ${index * flow.pageHeight}); new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`, true);
        pages.push({ index: index + 1, label: `page ${index + 1}`, width: flow.width, height: flow.pageHeight, dataUrl: await photograph(window, flow.width) });
      }
      for (const box of wide) overflow.push({ page: 0, box, kind: "outside_page" });
    });
  } else {
    const sheets = sheetPagesHtml(model);
    if (sheets.length > MAX_PAGES) truncated = `first ${MAX_PAGES} of ${sheets.length} sheets`;
    const cut = sheets.filter((sheet) => sheet.truncated).map((sheet) => sheet.label);
    if (cut.length) truncated = [truncated, `${cut.join(", ")}: first 60 rows x 20 columns`].filter(Boolean).join("; ");
    if (sheets.length) await withWindow(1200, 900, async (window) => {
      for (const [index, sheet] of sheets.slice(0, MAX_PAGES).entries()) {
        window.setContentSize(1200, 900);
        await load(window, sheet.html);
        const [w, h] = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('.wrap').getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)]; })()`, true) as [number, number];
        const width = Math.max(200, Math.min(MAX_SHEET_PX.width, w)), height = Math.max(120, Math.min(MAX_SHEET_PX.height, h));
        window.setContentSize(width, height);
        await window.webContents.executeJavaScript("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))", true);
        pages.push({ index: index + 1, label: sheet.label, width, height, dataUrl: await photograph(window, width) });
      }
    });
  }
  return { ok: true, format: meta.format, renderer: "agentlas-layout", note: NOTE, pages, overflow, ...(truncated ? { truncated } : {}) };
}

/** One render at a time: each opens a window. */
export function renderLiveDocument(sessionId: string): Promise<LiveDocumentRenderResult> {
  const run = queue.then(() => renderNow(sessionId)).catch((error: unknown): LiveDocumentRenderResult => {
    if (error instanceof LiveDocumentError) return { ok: false, code: error.reason, ...(error.detail ? { message: error.detail } : {}) };
    return { ok: false, code: "render_failed", message: error instanceof Error ? error.message.slice(0, 200) : "render failed" };
  });
  queue = run.catch(() => undefined);
  return run;
}
