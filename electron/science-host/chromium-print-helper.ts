import { app, BrowserWindow, protocol, session } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHROMIUM_PRINT_HELPER_FLAG, CHROMIUM_PRINT_RESULT_PREFIX, CHROMIUM_PRINT_SCHEMA,
  chromiumPrintFailureReason, type ChromiumHelperResult, type ChromiumPrintReadiness,
} from "./chromium-print-protocol";

const DOCUMENT_URL = "agentlas-science-print://document/index.html";
const PRINT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

// Fixed host-owned observer in its own JS world. javascript:false remains set
// for the document; manuscript scripts, event handlers and Node never execute.
const ASSET_READINESS = `(async () => {
  document.documentElement.getBoundingClientRect();
  await document.fonts.ready;
  const images = Array.from(document.images);
  await Promise.all(images.map(async (image) => {
    image.loading = 'eager';
    if (!image.complete) await new Promise(resolve => {
      image.addEventListener('load', resolve, {once:true});
      image.addEventListener('error', resolve, {once:true});
    });
    if (image.complete && image.naturalWidth > 0) await image.decode();
  }));
  document.documentElement.getBoundingClientRect();
  await document.fonts.ready;
  const fonts = Array.from(document.fonts);
  const stylesheets = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'));
  let failedStylesheetCount = stylesheets.filter(link => !link.sheet).length;
  const visited = new Set();
  function inspectImports(sheet) {
    if (visited.has(sheet)) return;
    visited.add(sheet);
    try {
      for (const rule of Array.from(sheet.cssRules)) if (rule.type === CSSRule.IMPORT_RULE) {
        if (!rule.href.startsWith('data:') || !rule.styleSheet) failedStylesheetCount++;
        else inspectImports(rule.styleSheet);
      }
    } catch { failedStylesheetCount++; }
  }
  for (const sheet of Array.from(document.styleSheets)) inspectImports(sheet);
  return {fontCount:fonts.length, failedFontCount:fonts.filter(font => font.status === 'error').length,
    failedStylesheetCount, imageCount:images.length, loadedImageCount:images.filter(image => image.complete && image.naturalWidth > 0).length};
})()`;

let started = false;

/** Called only by the early packaged bootstrap or as the development app entry. */
export async function runChromiumPrintHelper(): Promise<void> {
  if (started) return;
  started = true;
  if (!process.argv.includes(CHROMIUM_PRINT_HELPER_FLAG)) throw new Error("science_chromium_helper_flag_required");
  const directory = process.argv.find(arg => arg.startsWith("--agentlas-science-print-dir="))?.slice("--agentlas-science-print-dir=".length);
  const parentPid = Number(process.argv.find(arg => arg.startsWith("--agentlas-science-print-parent="))?.slice("--agentlas-science-print-parent=".length));
  if (!directory || !path.isAbsolute(directory) || !/^agentlas-science-print-[A-Za-z0-9]+$/u.test(path.basename(directory))
    || !Number.isSafeInteger(parentPid) || parentPid <= 1 || parentPid === process.pid) throw new Error("science_chromium_helper_launch_invalid");
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(os.tmpdir())
    || (process.platform !== "win32" && ((directoryStat.mode & 0o777) !== 0o700
      || directoryStat.uid !== process.getuid?.()))) throw new Error("science_chromium_helper_directory_invalid");
  const profile = path.join(directory, "profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.disableHardwareAcceleration();
  protocol.registerSchemesAsPrivileged([{ scheme: "agentlas-science-print", privileges: { standard: true, secure: true } }]);
  let window: BrowserWindow | null = null;
  let finished = false;
  let requestId: string | null = null;
  let incoming = "";
  let orphaned = false;
  let parentWatch: NodeJS.Timeout;

  function finish(result: Omit<ChromiumHelperResult, "schema" | "requestId">): void {
    if (finished) return;
    finished = true;
    clearInterval(parentWatch);
    if (window && !window.isDestroyed()) window.destroy();
    if (orphaned) {
      try { fs.rmSync(directory!, { recursive: true, force: true }); } catch { /* OS may still hold profile files. */ }
      app.exit(1);
      return;
    }
    const outcome: ChromiumHelperResult = { schema: CHROMIUM_PRINT_SCHEMA, requestId: requestId || "unbound", ...result };
    process.stdout.write(`${CHROMIUM_PRINT_RESULT_PREFIX}${JSON.stringify(outcome)}\n`, () => app.exit(result.ok ? 0 : 1));
  }
  function parentGone(): void { orphaned = true; finish({ ok: false, reason: "science_chromium_parent_gone" }); }
  process.stdin.on("end", parentGone);
  process.stdin.on("error", parentGone);
  process.stdout.on("error", parentGone);
  process.stderr.on("error", () => {});
  process.on("SIGTERM", () => finish({ ok: false, reason: "science_chromium_cancelled" }));
  process.on("SIGINT", () => finish({ ok: false, reason: "science_chromium_cancelled" }));
  parentWatch = setInterval(() => {
    if (process.ppid !== parentPid) { parentGone(); return; }
    try { process.kill(parentPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") parentGone(); }
  }, 500);

  async function render(): Promise<void> {
    try {
      await app.whenReady();
      if (finished) return;
      app.dock?.hide();
      const html = fs.readFileSync(path.join(directory!, "input.html"), "utf8");
      const isolatedSession = session.fromPartition(`science-print-${requestId}`, { cache: false });
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.on("will-download", event => event.preventDefault());
      let blockedResource = false;
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        const allowed = (details.url === DOCUMENT_URL && details.resourceType === "mainFrame")
          || (details.url.startsWith("data:") && ["image", "font", "stylesheet"].includes(details.resourceType));
        if (!allowed) blockedResource = true;
        callback({ cancel: !allowed });
      });
      isolatedSession.protocol.handle("agentlas-science-print", request => request.url === DOCUMENT_URL
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "Content-Security-Policy": PRINT_CSP } })
        : new Response("Not found", { status: 404 }));
      window = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: {
        offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
        webSecurity: true, allowRunningInsecureContent: false, images: true, webgl: false,
        backgroundThrottling: false, session: isolatedSession, disableDialogs: true, safeDialogs: true,
      } });
      const contents = window.webContents;
      contents.debugger.attach("1.3");
      contents.debugger.on("message", (_event, method, params) => {
        if (method === "Network.loadingFailed" && ["Image", "Font", "Stylesheet"].includes(params.type)) blockedResource = true;
      });
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", event => event.preventDefault());
      contents.on("will-frame-navigate", event => event.preventDefault());
      contents.on("will-redirect", event => event.preventDefault());
      contents.on("render-process-gone", () => finish({ ok: false, reason: "science_chromium_renderer_gone" }));
      // A hidden offscreen window creates its renderer during navigation. Do
      // not await a DevTools command before giving that renderer a document.
      await Promise.all([contents.debugger.sendCommand("Network.enable"), window.loadURL(DOCUMENT_URL)]);
      if (finished) return;
      // Force print-only CSS/font faces into layout before awaiting font readiness.
      await contents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
      const readiness = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: ASSET_READINESS }]) as ChromiumPrintReadiness;
      if (finished) return;
      if (blockedResource || readiness.failedFontCount > 0 || readiness.failedStylesheetCount > 0 || readiness.loadedImageCount !== readiness.imageCount) {
        finish({ ok: false, reason: blockedResource ? "science_chromium_external_resource_blocked" : "science_chromium_assets_not_loaded", readiness });
        return;
      }
      const bytes = await contents.printToPDF({ printBackground: true, pageSize: "A4",
        margins: { top: 0.87, bottom: 0.87, left: 0.79, right: 0.79 }, preferCSSPageSize: true });
      if (finished) return;
      fs.writeFileSync(path.join(directory!, "output.pdf"), bytes, { flag: "wx", mode: 0o600 });
      finish({ ok: true, readiness });
    } catch (error) { if (!finished) finish({ ok: false, reason: chromiumPrintFailureReason(error) }); }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    incoming += chunk;
    if (incoming.length > 16_384) { finish({ ok: false, reason: "science_chromium_helper_request_invalid" }); return; }
    for (;;) {
      const newline = incoming.indexOf("\n");
      if (newline < 0) break;
      const line = incoming.slice(0, newline); incoming = incoming.slice(newline + 1);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.type === "cancel" && message.requestId === requestId) { finish({ ok: false, reason: "science_chromium_cancelled" }); return; }
        if (requestId !== null || message.type !== "render" || message.schema !== CHROMIUM_PRINT_SCHEMA
          || typeof message.requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(message.requestId)) throw new Error("protocol");
        requestId = message.requestId;
        void render();
      } catch { finish({ ok: false, reason: "science_chromium_helper_request_invalid" }); }
    }
  });
  process.stdin.resume();
  if (process.ppid !== parentPid) parentGone();
}

if (require.main === module) void runChromiumPrintHelper().catch(() => {
  process.stderr.write("science_chromium_helper_bootstrap_failed\n");
  app.exit(1);
});
