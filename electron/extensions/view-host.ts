import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { app, BrowserWindow, nativeImage, nativeTheme, screen, WebContentsView } from "electron";
import type { Rectangle } from "electron";
import { onAskUserLifecycle, submitAskUserAnswer } from "../confirm/ask-user";
import { productExtensionSignedPayload, type ProductExtensionPermission, type ProductExtensionViewBounds, type ProductExtensionViewStatus } from "../../shared/product-extension";
import { activeScienceExtension, SCIENCE_EXTENSION_ID } from "./science";
import {
  SCIENCE_RENDERER_REQUEST_SCHEMA,
  SCIENCE_RENDERER_STATUS_SCHEMA,
  isScienceRendererGuestReport,
  scienceRendererBindingsEqual,
  type MountScienceRendererInput,
  type ScienceRendererBinding,
  type ScienceRendererBounds,
  type ScienceRendererGuestReport,
  type ScienceProteinStructureObservation,
  type ScienceChemistryDocumentObservation,
  type ScienceRendererRenderRequest,
  type ScienceRendererRuntimeStatus,
  type ScienceChemistryCommitInput,
  type ScienceMolstarCommitInput,
} from "agentlas-science/dist/contracts/science-renderer-runtime";

interface ActiveScienceRendererView {
  projectId: string;
  instanceId: string;
  renderRequestId: string;
  view: WebContentsView;
  releaseDir: string;
  entryPath: string;
  relativeBounds: ScienceRendererBounds;
  request: ScienceRendererRenderRequest;
  phase: ScienceRendererRuntimeStatus["phase"];
  sequence: number;
  sceneRevision: string | null;
  observation: ScienceProteinStructureObservation | ScienceChemistryDocumentObservation | null;
  timeout: NodeJS.Timeout | null;
}

export interface ScienceRendererLaunchSpec {
  projectId: string;
  releaseDir: string;
  entryPath: string;
  bounds: ScienceRendererBounds;
  request: ScienceRendererRenderRequest;
}

export interface ScienceRendererCapturedFrame {
  png: Buffer;
  renderContext: Record<string, unknown>;
  renderRequestId: string;
  rendererBinding: ScienceRendererBinding;
  sceneRevision: string;
  identity: {
    projectId: string;
    artifactId: string;
    artifactVersion: number;
    contentSha256: string;
  };
}

interface ActiveScienceView {
  ownerId: number;
  leaseId: string;
  window: BrowserWindow;
  view: WebContentsView;
  releaseDir: string;
  version: string;
  manifestDigest: string;
  permissions: ReadonlySet<ProductExtensionPermission>;
  send: (status: ProductExtensionViewStatus) => void;
  askUserDispose: (() => void) | null;
  askUserRequestIds: Set<string>;
  renderer: ActiveScienceRendererView | null;
}

const activeViews = new Map<number, ActiveScienceView>();

function safeBounds(bounds: ProductExtensionViewBounds, window: BrowserWindow): ProductExtensionViewBounds {
  const content = window.getContentBounds();
  const x = Number.isFinite(bounds?.x) ? Math.max(0, Math.min(Math.floor(bounds.x), Math.max(0, content.width - 1))) : 0;
  const y = Number.isFinite(bounds?.y) ? Math.max(0, Math.min(Math.floor(bounds.y), Math.max(0, content.height - 1))) : 0;
  const width = Number.isFinite(bounds?.width) ? Math.max(1, Math.min(Math.floor(bounds.width), content.width - x)) : 1;
  const height = Number.isFinite(bounds?.height) ? Math.max(1, Math.min(Math.floor(bounds.height), content.height - y)) : 1;
  return { x, y, width, height };
}

function safeRendererBounds(bounds: ScienceRendererBounds, active: ActiveScienceView): Rectangle {
  const parent = active.view.getBounds();
  const numbers = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) throw new Error("science-renderer-bounds-invalid");
  if (bounds.width < 1 || bounds.height < 1) throw new Error("science-renderer-bounds-out-of-range");
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(parent.width, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(parent.height, Math.ceil(bounds.y + bounds.height));
  if (x >= parent.width || y >= parent.height || right - x < 240 || bottom - y < 200) throw new Error("science-renderer-bounds-out-of-range");
  return { x: parent.x + x, y: parent.y + y, width: right - x, height: bottom - y };
}

function rendererStatus(renderer: ActiveScienceRendererView, phase: ScienceRendererRuntimeStatus["phase"] = renderer.phase, code: string | null = null, summary: string = phase): ScienceRendererRuntimeStatus {
  return {
    schema: SCIENCE_RENDERER_STATUS_SCHEMA,
    instanceId: renderer.instanceId,
    renderRequestId: renderer.renderRequestId,
    artifactId: renderer.request.artifactId,
    artifactVersion: renderer.request.artifactVersion,
    phase,
    code,
    summary,
    captured: phase === "ready",
  };
}

function notifyRenderer(active: ActiveScienceView, status: ScienceRendererRuntimeStatus): void {
  if (!active.view.webContents.isDestroyed()) active.view.webContents.send("science:rendererStatus", status);
}

function closeRenderer(active: ActiveScienceView, phase: "disposed" | "failed" = "disposed", code: string | null = null, summary: string = phase): void {
  const renderer = active.renderer;
  if (!renderer) return;
  active.renderer = null;
  if (renderer.timeout) clearTimeout(renderer.timeout);
  renderer.timeout = null;
  renderer.phase = phase;
  try { active.window.contentView.removeChildView(renderer.view); } catch {}
  try { renderer.view.webContents.close(); } catch {}
  notifyRenderer(active, rendererStatus(renderer, phase, code, summary));
}

function insideRelease(releaseDir: string, target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol !== "file:") return false;
    const decoded = decodeURIComponent(url.pathname);
    const candidate = path.resolve(process.platform === "win32" ? decoded.replace(/^\//, "") : decoded);
    const root = path.resolve(releaseDir);
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

function closeScienceQuestionSurface(active: ActiveScienceView): void {
  for (const requestId of active.askUserRequestIds) {
    const heldElsewhere = [...activeViews.values()].some((other) => other !== active && other.askUserRequestIds.has(requestId));
    if (!heldElsewhere) submitAskUserAnswer(requestId, null);
  }
  active.askUserRequestIds.clear();
  active.askUserDispose?.();
  active.askUserDispose = null;
}

function closeActive(active: ActiveScienceView, notify = true): void {
  if (activeViews.get(active.ownerId) !== active) return;
  activeViews.delete(active.ownerId);
  closeScienceQuestionSurface(active);
  closeRenderer(active);
  try { active.window.contentView.removeChildView(active.view); } catch {}
  try { active.view.webContents.close(); } catch {}
  if (notify) active.send({ id: SCIENCE_EXTENSION_ID, leaseId: active.leaseId, state: "closed" });
}

export function closeScienceExtensionView(ownerId: number, leaseId?: string): { ok: true } {
  const active = activeViews.get(ownerId);
  if (active && leaseId !== undefined && active.leaseId !== leaseId) return { ok: true };
  if (active) closeActive(active);
  return { ok: true };
}

export function closeAllScienceExtensionViews(): void {
  for (const active of [...activeViews.values()]) closeActive(active, false);
}

export function isScienceExtensionViewSender(senderId: number): boolean {
  return [...activeViews.values()].some((active) => !active.view.webContents.isDestroyed() && active.view.webContents.id === senderId);
}

export function sendScienceTurnEventToView(senderId: number, event: unknown): boolean {
  const active = activeViewForSender(senderId);
  if (!active || active.view.webContents.isDestroyed()) return false;
  active.view.webContents.send("science:turnEvent", event);
  return true;
}

export function assertScienceExtensionViewPermission(senderId: number, permission: ProductExtensionPermission): void {
  const active = activeViewForSender(senderId);
  if (!active) throw new Error("science-extension-sender-not-authorized");
  const release = activeScienceExtension();
  const digest = release ? createHash("sha256").update(productExtensionSignedPayload(release.manifest), "utf8").digest("hex") : "";
  if (!release || release.releaseDir !== active.releaseDir || release.manifest.version !== active.version || digest !== active.manifestDigest) {
    closeActive(active);
    throw new Error("science-extension-release-stale");
  }
  if (!active.permissions.has(permission)) throw new Error("science-extension-permission-denied");
}

function activeViewForSender(senderId: number): ActiveScienceView | null {
  for (const active of activeViews.values()) {
    if (!active.view.webContents.isDestroyed() && active.view.webContents.id === senderId) return active;
  }
  return null;
}

function safeCaptureRect(value: unknown, active: ActiveScienceView): Rectangle {
  if (!value || typeof value !== "object") throw new Error("science-capture-rect-invalid");
  const rect = value as Partial<Rectangle>;
  const numbers = [rect.x, rect.y, rect.width, rect.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) throw new Error("science-capture-rect-invalid");
  const x = Math.floor(rect.x as number);
  const y = Math.floor(rect.y as number);
  const right = Math.ceil((rect.x as number) + (rect.width as number));
  const bottom = Math.ceil((rect.y as number) + (rect.height as number));
  const width = right - x;
  const height = bottom - y;
  const bounds = active.view.getBounds();
  if (x < 0 || y < 0 || width < 1 || height < 1 || right > bounds.width || bottom > bounds.height) throw new Error("science-capture-rect-out-of-bounds");
  if (width > 4096 || height > 4096 || width * height > 12_000_000) throw new Error("science-capture-rect-too-large");
  return { x, y, width, height };
}

export async function captureScienceExtensionViewRegion(senderId: number, identity: { artifactId: string; artifactVersion: number; contentSha256: string }): Promise<{ png: Buffer; renderContext: Record<string, unknown> }> {
  const active = activeViewForSender(senderId);
  if (!active) throw new Error("science-extension-sender-not-authorized");
  const captureToken = randomUUID();
  const value = await active.view.webContents.executeJavaScript(`(async () => {
    const expected = ${JSON.stringify(identity)};
    const captureToken = ${JSON.stringify(captureToken)};
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const host = [...document.querySelectorAll('[data-artifact-host]')].find((node) =>
      node.dataset.artifactHost === expected.artifactId &&
      Number(node.dataset.artifactVersion) === expected.artifactVersion &&
      node.dataset.contentSha256 === expected.contentSha256
    );
    const target = host?.querySelector('[data-science-capture]');
    if (!host || !target) throw new Error('science-capture-target-missing');
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width < 1 || rect.height < 1) throw new Error('science-capture-target-hidden');
    Object.defineProperty(target, '__agentlasScienceCaptureRestore', {
      value: { style: target.getAttribute('style') },
      configurable: true,
    });
    target.dataset.scienceCaptureStage = captureToken;
    const opaqueBackground = style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent'
      ? 'rgb(255, 255, 255)'
      : style.backgroundColor;
    target.style.setProperty('position', 'fixed', 'important');
    target.style.setProperty('inset', '0 auto auto 0', 'important');
    target.style.setProperty('width', rect.width + 'px', 'important');
    target.style.setProperty('height', rect.height + 'px', 'important');
    target.style.setProperty('margin', '0', 'important');
    target.style.setProperty('transform', 'none', 'important');
    target.style.setProperty('z-index', '2147483647', 'important');
    target.style.setProperty('isolation', 'isolate', 'important');
    target.style.setProperty('background-color', opaqueBackground, 'important');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const staged = target.getBoundingClientRect();
    if (Math.abs(staged.x) > 0.5 || Math.abs(staged.y) > 0.5 || Math.abs(staged.width - rect.width) > 1 || Math.abs(staged.height - rect.height) > 1) {
      throw new Error('science-capture-stage-invalid');
    }
    return { x: 0, y: 0, width: staged.width, height: staged.height };
  })()`);
  const rect = safeCaptureRect(value, active);
  // Electron 43 can ignore non-zero capture origins for an embedded
  // WebContentsView. Stage the already-laid-out target at the renderer viewport
  // origin, preserving its measured dimensions, then capture that origin. This
  // avoids guessing between view, window, bitmap, and scrolled-document spaces.
  const debuggerWasAttached = active.view.webContents.debugger.isAttached();
  try {
    if (!debuggerWasAttached) active.view.webContents.debugger.attach("1.3");
    const result = await active.view.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
    }) as { data?: unknown };
    if (typeof result.data !== "string" || !result.data) throw new Error("science-capture-empty");
    const png = Buffer.from(result.data, "base64");
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error("science-capture-empty");
    const pixels = image.getSize();
    if (pixels.width < 1 || pixels.height < 1) throw new Error("science-capture-size-invalid");
    return {
      png,
      renderContext: {
        electronVersion: process.versions.electron ?? "unknown",
        chromiumVersion: process.versions.chrome ?? "unknown",
        platform: process.platform,
        architecture: process.arch,
        locale: app.getLocale(),
        colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
        deviceScaleFactor: screen.getDisplayMatching(active.window.getBounds()).scaleFactor,
        captureMethod: "cdp-staged-origin-clip",
        cssWidth: rect.width,
        cssHeight: rect.height,
        pixelWidth: pixels.width,
        pixelHeight: pixels.height,
      },
    };
  } finally {
    await active.view.webContents.executeJavaScript(`(() => {
      const target = document.querySelector('[data-science-capture-stage=${JSON.stringify(captureToken)}]');
      if (!target) return false;
      const restore = target.__agentlasScienceCaptureRestore;
      if (restore?.style === null) target.removeAttribute('style');
      else if (typeof restore?.style === 'string') target.setAttribute('style', restore.style);
      delete target.__agentlasScienceCaptureRestore;
      delete target.dataset.scienceCaptureStage;
      return true;
    })()`).catch(() => false);
    if (!debuggerWasAttached && active.view.webContents.debugger.isAttached()) active.view.webContents.debugger.detach();
  }
}

function rendererForGuest(senderId: number, instanceId: string): { active: ActiveScienceView; renderer: ActiveScienceRendererView } | null {
  for (const active of activeViews.values()) {
    const renderer = active.renderer;
    if (renderer && renderer.instanceId === instanceId && !renderer.view.webContents.isDestroyed() && renderer.view.webContents.id === senderId) return { active, renderer };
  }
  return null;
}

function assertCapturedImageHasSignal(
  image: Electron.NativeImage,
  observationKind: ScienceProteinStructureObservation["kind"] | ScienceChemistryDocumentObservation["kind"],
): void {
  if (image.isEmpty()) throw new Error("science-renderer-capture-empty");
  const size = image.getSize();
  const bitmap = image.toBitmap();
  if (size.width < 240 || size.height < 200 || bitmap.length < size.width * size.height * 4) throw new Error("science-renderer-capture-invalid");
  const colors = new Set<number>();
  let centralChromaticPixels = 0;
  let centralInkPixels = 0;
  let centralEdgePixels = 0;
  const total = size.width * size.height;
  const step = Math.max(1, Math.floor(total / 2048));
  for (let pixel = 0; pixel < total && colors.size < 24; pixel += step) {
    const offset = pixel * 4;
    colors.add((bitmap[offset] << 16) | (bitmap[offset + 1] << 8) | bitmap[offset + 2]);
  }
  if (colors.size < 8) throw new Error("science-renderer-capture-low-entropy");
  // Ketcher renders scientifically meaningful black/gray bond geometry on a
  // white canvas, while Mol* is a chromatic WebGL scene. Do not use one color
  // heuristic for both: it rejected valid chemical structures and encouraged
  // accepting a colorful toolbar as if it were the scientific scene.
  const chemistry = observationKind === "chemistry-document";
  const left = Math.floor(size.width * (chemistry ? 0.18 : 0.12));
  const right = Math.ceil(size.width * 0.88);
  const top = Math.floor(size.height * (chemistry ? 0.2 : 0.1));
  const bottom = Math.ceil(size.height * 0.82);
  const sampleStride = chemistry ? 2 : 3;
  for (let y = top; y < bottom; y += sampleStride) {
    for (let x = left; x < right; x += sampleStride) {
      const offset = (y * size.width + x) * 4;
      const red = bitmap[offset + 2];
      const green = bitmap[offset + 1];
      const blue = bitmap[offset];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      if (maximum - minimum > 22 && minimum < 225) centralChromaticPixels += 1;
      const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      if (luminance < 205) centralInkPixels += 1;
      if (chemistry && x + sampleStride < right && y + sampleStride < bottom) {
        const rightOffset = (y * size.width + x + sampleStride) * 4;
        const downOffset = ((y + sampleStride) * size.width + x) * 4;
        const rightDelta = Math.max(
          Math.abs(red - bitmap[rightOffset + 2]),
          Math.abs(green - bitmap[rightOffset + 1]),
          Math.abs(blue - bitmap[rightOffset]),
        );
        const downDelta = Math.max(
          Math.abs(red - bitmap[downOffset + 2]),
          Math.abs(green - bitmap[downOffset + 1]),
          Math.abs(blue - bitmap[downOffset]),
        );
        if (Math.max(rightDelta, downDelta) > 34) centralEdgePixels += 1;
      }
    }
  }
  if (chemistry) {
    if (centralInkPixels < 24 || centralEdgePixels < 12) throw new Error("science-renderer-capture-scene-missing");
  } else if (centralChromaticPixels < 20) {
    throw new Error("science-renderer-capture-scene-missing");
  }
}

export function updateScienceRendererViewBounds(senderId: number, input: MountScienceRendererInput): ScienceRendererRuntimeStatus {
  const active = activeViewForSender(senderId);
  if (!active || !active.renderer) throw new Error("science-renderer-not-mounted");
  const renderer = active.renderer;
  if (renderer.request.artifactId !== input.artifactId || renderer.request.artifactVersion !== input.artifactVersion || renderer.request.artifactContentSha256 !== input.contentSha256) throw new Error("science-renderer-identity-conflict");
  renderer.relativeBounds = input.bounds;
  renderer.view.setBounds(safeRendererBounds(input.bounds, active));
  renderer.view.setVisible(true);
  return rendererStatus(renderer);
}

export function setScienceRendererViewVisibility(senderId: number, visible: boolean): ScienceRendererRuntimeStatus {
  const active = activeViewForSender(senderId);
  if (!active || !active.renderer) throw new Error("science-renderer-not-mounted");
  active.renderer.view.setVisible(visible);
  return rendererStatus(active.renderer);
}

export async function mountScienceRendererView(senderId: number, launch: ScienceRendererLaunchSpec): Promise<ScienceRendererRuntimeStatus> {
  const active = activeViewForSender(senderId);
  if (!active) throw new Error("science-extension-sender-not-authorized");
  if (launch.request.schema !== SCIENCE_RENDERER_REQUEST_SCHEMA) throw new Error("science-renderer-request-invalid");
  if (launch.request.input.kind === "protein-structure") {
    if (launch.request.input.bytes.byteLength < 1 || launch.request.input.bytes.byteLength > 32 * 1024 * 1024) throw new Error("science-renderer-request-invalid");
  } else {
    const bytes = Buffer.byteLength(launch.request.input.ket, "utf8") + Buffer.byteLength(launch.request.input.canonicalSmiles, "utf8");
    if (bytes < 1 || bytes > 4 * 1024 * 1024) throw new Error("science-renderer-request-invalid");
  }
  if (!insideRelease(launch.releaseDir, pathToFileURL(launch.entryPath).toString())) throw new Error("science-renderer-entry-outside-release");
  const mounted = active.renderer;
  if (mounted
    && !mounted.view.webContents.isDestroyed()
    && mounted.projectId === launch.projectId
    && mounted.releaseDir === launch.releaseDir
    && mounted.entryPath === launch.entryPath
    && mounted.request.artifactId === launch.request.artifactId
    && mounted.request.artifactVersion === launch.request.artifactVersion
    && mounted.request.artifactKind === launch.request.artifactKind
    && mounted.request.artifactContentSha256 === launch.request.artifactContentSha256
    && scienceRendererBindingsEqual(mounted.request.binding, launch.request.binding)) {
    mounted.relativeBounds = launch.bounds;
    mounted.view.setBounds(safeRendererBounds(launch.bounds, active));
    mounted.view.setVisible(true);
    return rendererStatus(mounted);
  }
  closeRenderer(active);

  const rendererView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "science-renderer-preload.js"),
      additionalArguments: [
        `--agentlas-science-renderer-instance=${launch.request.instanceId}`,
        `--agentlas-science-renderer-id=${launch.request.binding.rendererId}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: false,
      partition: `agentlas-science-renderer-${launch.request.instanceId}`,
    },
  });
  const renderer: ActiveScienceRendererView = {
    projectId: launch.projectId,
    instanceId: launch.request.instanceId,
    renderRequestId: launch.request.renderRequestId,
    view: rendererView,
    releaseDir: launch.releaseDir,
    entryPath: launch.entryPath,
    relativeBounds: launch.bounds,
    request: launch.request,
    phase: "launching",
    sequence: 0,
    sceneRevision: null,
    observation: null,
    timeout: null,
  };
  active.renderer = renderer;
  rendererView.setBackgroundColor("#ffffff");
  rendererView.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  rendererView.webContents.session.setPermissionCheckHandler(() => false);
  rendererView.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = insideRelease(renderer.releaseDir, details.url);
    if (!allowed) {
      try {
        const protocol = new URL(details.url).protocol;
        allowed = protocol === "data:" || protocol === "blob:";
      } catch {
        allowed = false;
      }
    }
    callback({ cancel: !allowed });
  });
  rendererView.webContents.on("will-navigate", (event, target) => {
    if (!insideRelease(renderer.releaseDir, target)) event.preventDefault();
  });
  rendererView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  rendererView.webContents.session.on("will-download", (event) => event.preventDefault());
  rendererView.webContents.on("render-process-gone", (_event, details) => {
    if (active.renderer === renderer) closeRenderer(active, "failed", "science-renderer-process-gone", details.reason);
  });
  rendererView.webContents.on("unresponsive", () => {
    if (active.renderer === renderer) closeRenderer(active, "failed", "science-renderer-unresponsive", "Renderer stopped responding.");
  });
  active.window.contentView.addChildView(rendererView);
  rendererView.setBounds(safeRendererBounds(launch.bounds, active));
  rendererView.setVisible(true);
  renderer.timeout = setTimeout(() => {
    if (active.renderer === renderer && renderer.phase !== "ready") closeRenderer(active, "failed", "science-renderer-deadline", "Renderer did not become stable within 45 seconds.");
  }, 45_000);
  notifyRenderer(active, rendererStatus(renderer));
  try {
    await rendererView.webContents.loadURL(pathToFileURL(launch.entryPath).toString());
    return rendererStatus(renderer);
  } catch (error) {
    if (active.renderer === renderer) closeRenderer(active, "failed", "science-renderer-load-failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function disposeScienceRendererView(senderId: number): { ok: true } {
  const active = activeViewForSender(senderId);
  if (active) closeRenderer(active);
  return { ok: true };
}

export function scienceRendererHandshake(senderId: number, instanceId: string): ScienceRendererRenderRequest {
  const found = rendererForGuest(senderId, instanceId);
  if (!found) throw new Error("science-renderer-guest-not-authorized");
  return found.renderer.request;
}

export function authorizeScienceChemistryCommit(senderId: number, input: ScienceChemistryCommitInput): {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  rendererBinding: ScienceRendererBinding;
} {
  const found = rendererForGuest(senderId, input.instanceId);
  if (!found) throw new Error("science-renderer-guest-not-authorized");
  const { renderer } = found;
  const request = renderer.request;
  if (request.binding.rendererId !== "agentlas.ketcher" || request.input.kind !== "chemistry-document") throw new Error("science-chemistry-editor-not-mounted");
  if (input.renderRequestId !== request.renderRequestId
    || input.artifactId !== request.artifactId
    || input.artifactVersion !== request.artifactVersion
    || input.artifactContentSha256 !== request.artifactContentSha256) throw new Error("science-chemistry-commit-identity-conflict");
  if (renderer.phase !== "dirty") throw new Error("science-chemistry-editor-not-dirty");
  return {
    projectId: renderer.projectId,
    artifactId: request.artifactId,
    artifactVersion: request.artifactVersion,
    contentSha256: request.artifactContentSha256,
    rendererBinding: request.binding,
  };
}

export function authorizeScienceMolstarCommit(senderId: number, input: ScienceMolstarCommitInput): {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  rendererBinding: ScienceRendererBinding;
} {
  const found = rendererForGuest(senderId, input.instanceId);
  if (!found) throw new Error("science-renderer-guest-not-authorized");
  const { renderer } = found;
  const request = renderer.request;
  if (request.binding.rendererId !== "agentlas.molstar" || request.input.kind !== "protein-structure") throw new Error("science-molstar-editor-not-mounted");
  if (input.renderRequestId !== request.renderRequestId
    || input.artifactId !== request.artifactId
    || input.artifactVersion !== request.artifactVersion
    || input.artifactContentSha256 !== request.artifactContentSha256) throw new Error("science-molstar-commit-identity-conflict");
  if (renderer.phase !== "dirty") throw new Error("science-molstar-editor-not-dirty");
  return {
    projectId: renderer.projectId,
    artifactId: request.artifactId,
    artifactVersion: request.artifactVersion,
    contentSha256: request.artifactContentSha256,
    rendererBinding: request.binding,
  };
}

export function notifyScienceChemistryCommitted(instanceId: string, projectId: string, artifact: { id: string; currentVersion: number; version: { contentSha256: string } }): void {
  for (const active of activeViews.values()) {
    const renderer = active.renderer;
    if (!renderer || renderer.instanceId !== instanceId) continue;
    if (!active.view.webContents.isDestroyed()) {
      active.view.webContents.send("science:artifactChanged", {
        projectId,
        artifactId: artifact.id,
        artifactVersion: artifact.currentVersion,
        contentSha256: artifact.version.contentSha256,
      });
    }
    return;
  }
}

export function notifyScienceArtifactChanged(projectId: string, artifact: { id: string; currentVersion: number; version: { contentSha256: string } }): void {
  for (const active of activeViews.values()) {
    if (active.view.webContents.isDestroyed()) continue;
    active.view.webContents.send("science:artifactChanged", {
      projectId,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      contentSha256: artifact.version.contentSha256,
    });
  }
}

export function scienceRendererReport(senderId: number, instanceId: string, value: unknown): ScienceRendererRuntimeStatus {
  const found = rendererForGuest(senderId, instanceId);
  if (!found) throw new Error("science-renderer-guest-not-authorized");
  const { active, renderer } = found;
  if (!isScienceRendererGuestReport(value)) throw new Error("science-renderer-report-invalid");
  const report: ScienceRendererGuestReport = value;
  if (report.instanceId !== renderer.instanceId || report.renderRequestId !== renderer.renderRequestId || report.sequence <= renderer.sequence) throw new Error("science-renderer-report-conflict");
  const allowed: Record<string, readonly string[]> = {
    launching: ["probing", "failed"],
    probing: ["rendering", "failed"],
    rendering: ["rendering", "stable", "failed"],
    ready: ["dirty", "failed"],
    dirty: ["dirty", "clean", "failed"],
  };
  if (!(allowed[renderer.phase] ?? []).includes(report.phase)) throw new Error("science-renderer-phase-conflict");
  renderer.sequence = report.sequence;
  renderer.phase = report.phase === "clean" ? "ready" : report.phase;
  renderer.sceneRevision = report.sceneRevision;
  renderer.observation = report.observation;
  if (report.phase === "failed") {
    const status = rendererStatus(renderer, "failed", report.code ?? "science-renderer-adapter-failed", report.summary);
    notifyRenderer(active, status);
    closeRenderer(active, "failed", status.code, status.summary);
    return status;
  }
  notifyRenderer(active, rendererStatus(renderer, report.phase === "clean" ? "ready" : report.phase, report.code, report.summary));
  if (report.phase !== "stable") return rendererStatus(renderer);
  if (!report.observation || report.observation.kind !== renderer.request.input.kind || report.observation.engineVersion !== renderer.request.binding.rendererVersion || !report.sceneRevision) throw new Error("science-renderer-observation-invalid");
  if (report.observation.kind === "protein-structure") {
    if (!report.observation.webgl2
      || renderer.request.input.kind !== "protein-structure"
      || report.observation.representation !== renderer.request.input.representation
      || report.observation.colorTheme !== renderer.request.input.colorTheme
      || report.observation.interactionSha256 !== renderer.request.input.interactionSha256
      || report.observation.selectedResidueCount !== (renderer.request.input.interaction?.residues.length ?? 0)
      || report.observation.focusResolved !== Boolean(renderer.request.input.interaction?.focus)) throw new Error("science-renderer-observation-invalid");
  }
  if (report.observation.kind === "chemistry-document") {
    if (renderer.request.input.kind !== "chemistry-document"
      || !report.observation.editable
      || report.observation.atomCount < 1
      || report.observation.bondCount < 0
      || report.observation.documentSha256 !== renderer.request.input.ketSha256
      || report.observation.canonicalSmilesSha256 !== renderer.request.input.canonicalSmilesSha256) throw new Error("science-renderer-observation-invalid");
  }
  renderer.phase = "capturing";
  notifyRenderer(active, rendererStatus(renderer, "capturing", null, "Capturing the stable renderer output."));
  return rendererStatus(renderer, "capturing", null, "Capturing the stable renderer output.");
}

export async function captureStableScienceRenderer(instanceId: string): Promise<ScienceRendererCapturedFrame> {
  const found = [...activeViews.values()]
    .map((active) => ({ active, renderer: active.renderer }))
    .find((entry) => entry.renderer?.instanceId === instanceId);
  if (!found?.renderer || found.renderer.phase !== "capturing") throw new Error("science-renderer-not-capturing");
  const { active, renderer } = found;
  const observation = renderer.observation;
  const sceneRevision = renderer.sceneRevision;
  if (!observation || !sceneRevision) throw new Error("science-renderer-observation-invalid");
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (active.renderer !== renderer || renderer.view.webContents.isDestroyed()) throw new Error("science-renderer-disposed");
  const image = await renderer.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assertCapturedImageHasSignal(image, observation.kind);
  const pixels = image.getSize();
  const bounds = renderer.view.getBounds();
  return {
    png: image.toPNG(),
    renderContext: {
      electronVersion: process.versions.electron ?? "unknown",
      chromiumVersion: process.versions.chrome ?? "unknown",
      platform: process.platform,
      architecture: process.arch,
      locale: app.getLocale(),
      colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      deviceScaleFactor: screen.getDisplayMatching(active.window.getBounds()).scaleFactor,
      cssWidth: bounds.width,
      cssHeight: bounds.height,
      pixelWidth: pixels.width,
      pixelHeight: pixels.height,
      observation,
    },
    renderRequestId: renderer.renderRequestId,
    rendererBinding: renderer.request.binding,
    sceneRevision,
    identity: {
      projectId: renderer.projectId,
      artifactId: renderer.request.artifactId,
      artifactVersion: renderer.request.artifactVersion,
      contentSha256: renderer.request.artifactContentSha256,
    },
  };
}

export function markScienceRendererCaptured(instanceId: string): ScienceRendererRuntimeStatus {
  for (const active of activeViews.values()) {
    const renderer = active.renderer;
    if (!renderer || renderer.instanceId !== instanceId) continue;
    if (renderer.timeout) clearTimeout(renderer.timeout);
    renderer.timeout = null;
    renderer.phase = "ready";
    const status = rendererStatus(renderer, "ready", null, "Verified renderer capture stored.");
    notifyRenderer(active, status);
    return status;
  }
  throw new Error("science-renderer-not-mounted");
}

export function failScienceRendererCapture(instanceId: string, code: string, summary: string): ScienceRendererRuntimeStatus {
  for (const active of activeViews.values()) {
    const renderer = active.renderer;
    if (!renderer || renderer.instanceId !== instanceId) continue;
    const status = rendererStatus(renderer, "failed", code, summary);
    closeRenderer(active, "failed", code, summary);
    return status;
  }
  throw new Error("science-renderer-not-mounted");
}

export function setScienceExtensionViewBounds(ownerId: number, leaseId: string, bounds: ProductExtensionViewBounds): { ok: boolean } {
  const active = activeViews.get(ownerId);
  if (!active || active.leaseId !== leaseId || active.window.isDestroyed() || active.view.webContents.isDestroyed()) return { ok: false };
  active.view.setBounds(safeBounds(bounds, active.window));
  if (active.renderer && !active.renderer.view.webContents.isDestroyed()) {
    active.renderer.view.setBounds(safeRendererBounds(active.renderer.relativeBounds, active));
  }
  active.view.setVisible(true);
  return { ok: true };
}

export async function openScienceExtensionView(input: {
  ownerId: number;
  leaseId: string;
  window: BrowserWindow;
  bounds: ProductExtensionViewBounds;
  send: (status: ProductExtensionViewStatus) => void;
}): Promise<ProductExtensionViewStatus> {
  const release = activeScienceExtension();
  if (!release) return { id: SCIENCE_EXTENSION_ID, leaseId: input.leaseId, state: "error", errorCode: "science-extension-not-active", errorMessage: "Agentlas Science is not installed and enabled." };
  closeScienceExtensionView(input.ownerId);
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "science-preload.js"),
      additionalArguments: [`--agentlas-extension-id=${SCIENCE_EXTENSION_ID}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: false,
      partition: `agentlas-product-extension-${SCIENCE_EXTENSION_ID}-${input.ownerId}`,
    },
  });
  const active: ActiveScienceView = {
    ownerId: input.ownerId,
    leaseId: input.leaseId,
    window: input.window,
    view,
    releaseDir: release.releaseDir,
    version: release.manifest.version,
    manifestDigest: createHash("sha256").update(productExtensionSignedPayload(release.manifest), "utf8").digest("hex"),
    permissions: new Set(release.manifest.permissions),
    send: input.send,
    askUserDispose: null,
    askUserRequestIds: new Set(),
    renderer: null,
  };
  activeViews.set(input.ownerId, active);
  active.askUserDispose = onAskUserLifecycle((request) => {
    if (request.askedBy !== SCIENCE_EXTENSION_ID
      || activeViews.get(active.ownerId) !== active
      || active.view.webContents.isDestroyed()) return false;
    if (request.expiresAt <= 0) active.askUserRequestIds.delete(request.requestId);
    else active.askUserRequestIds.add(request.requestId);
    active.view.webContents.send("science:askUser", request);
    return true;
  });
  view.setBackgroundColor("#fcfaf9");
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  view.webContents.session.setPermissionCheckHandler(() => false);
  view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = insideRelease(active.releaseDir, details.url);
    if (!allowed) {
      try {
        const protocol = new URL(details.url).protocol;
        allowed = protocol === "data:" || protocol === "blob:";
      } catch {
        allowed = false;
      }
    }
    callback({ cancel: !allowed });
  });
  view.webContents.on("will-navigate", (event, target) => {
    if (insideRelease(active.releaseDir, target)) return;
    event.preventDefault();
  });
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("render-process-gone", (_event, details) => {
    active.send({ id: SCIENCE_EXTENSION_ID, leaseId: active.leaseId, state: "error", errorCode: "science-renderer-stopped", errorMessage: details.reason });
  });
  view.webContents.on("unresponsive", () => {
    active.send({ id: SCIENCE_EXTENSION_ID, leaseId: active.leaseId, state: "error", errorCode: "science-renderer-unresponsive", errorMessage: "The Science interface is not responding." });
  });
  view.webContents.once("destroyed", () => {
    if (activeViews.get(active.ownerId) === active) activeViews.delete(active.ownerId);
    closeScienceQuestionSurface(active);
    if (active.renderer) closeRenderer(active, "failed", "science-extension-view-destroyed", "The Science interface was closed.");
  });
  input.window.contentView.addChildView(view);
  view.setBounds(safeBounds(input.bounds, input.window));
  view.setVisible(true);
  input.window.once("closed", () => closeActive(active, false));
  const opening: ProductExtensionViewStatus = { id: SCIENCE_EXTENSION_ID, leaseId: active.leaseId, state: "opening" };
  active.send(opening);
  try {
    await view.webContents.loadURL(pathToFileURL(release.entryPath).toString());
    const ready: ProductExtensionViewStatus = { id: SCIENCE_EXTENSION_ID, leaseId: active.leaseId, state: "ready", title: view.webContents.getTitle() || "Agentlas Science" };
    active.send(ready);
    return ready;
  } catch (error) {
    closeActive(active, false);
    const failed: ProductExtensionViewStatus = {
      id: SCIENCE_EXTENSION_ID,
      leaseId: active.leaseId,
      state: "error",
      errorCode: "science-entry-load-failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    active.send(failed);
    return failed;
  }
}
