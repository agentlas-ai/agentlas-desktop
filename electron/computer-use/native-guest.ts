// Main-owned virtual computer-use apps. No OS input, CDP endpoint, cookie store,
// or renderer-provided WebContents is accepted by this adapter.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { WebContents } from "electron";
import { captureNativeBrowserGuest, dispatchNativeBrowserGuestInput, releaseNativeBrowserGuestPressedInput, nativeBrowserGuestInputFrame, type NativeGuestDirectInput } from "../work-live-view";
import { saveScreenCaptureArtifact } from "../media/capture-artifacts";

export interface NativeGuestComputerUseCapability { endpoint: string; token: string; scopeId: string }
type Page = { id: string; wc: WebContents };
type Frame = NonNullable<ReturnType<typeof nativeBrowserGuestInputFrame>>;
type Capture = { id: string; pageId: string; frame: Frame; width: number; height: number };
type Scope = { id: string; token: string; ownerId: number; chatId: string; runId: string; permission: "read" | "write" | "full";
  signal: AbortSignal; current: () => boolean; pages: () => Page[]; capture: Capture | null; order: Promise<void>; queued: number; dispose: () => void };
const scopes = new Map<string, Scope>();
export function revokeNativeGuestComputerUseScopes(): void { for (const scope of [...scopes.values()]) scope.dispose(); }
const UUID = /^[a-f0-9-]{36}$/i;
function failure(error: string) { return { ok: false as const, error, message: error }; }
function pageApp(scope: Scope, id: string): string { return `native-guest:${scope.id}:${id}`; }
function live(scope: Scope): boolean { return scopes.get(scope.id) === scope && !scope.signal.aborted && scope.current(); }
function exactPage(scope: Scope, app: unknown): Page | null {
  if (typeof app !== "string" || !app.startsWith(`native-guest:${scope.id}:`)) return null;
  const id = app.slice(`native-guest:${scope.id}:`.length);
  return scope.pages().find(page => page.id === id && !page.wc.isDestroyed()) ?? null;
}
function sameFrame(a: Frame | null, b: Frame): boolean { return !!a && JSON.stringify(a) === JSON.stringify(b); }
function finite(value: unknown, low: number, high: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high; }

export function registerNativeGuestComputerUseScope(input: {
  ownerId: number; chatId: string; runId: string; permission: "read" | "write" | "full"; signal: AbortSignal;
  current: () => boolean; pages: () => Page[];
}): { scopeId: string; token: string; release: () => void } {
  if (!input.runId || !input.chatId || input.signal.aborted || !input.current() || scopes.size >= 128) throw new Error("native-guest-scope-unavailable");
  const id = randomUUID(), token = randomBytes(32).toString("hex");
  const release = () => { scopes.delete(id); scope.capture = null; input.signal.removeEventListener("abort", release); };
  const scope: Scope = { ...input, id, token, capture: null, order: Promise.resolve(), queued: 0, dispose: release };
  scopes.set(id, scope);
  input.signal.addEventListener("abort", release, { once: true });
  return { scopeId: id, token, release };
}

/** Only this separate Main control route accepts the run-scoped token. */
export async function handleNativeGuestComputerUse(route: string, authorization: string | undefined, body: Record<string, unknown>): Promise<unknown> {
  const scopeId = typeof body.scopeId === "string" && UUID.test(body.scopeId) ? body.scopeId : "";
  const scope = scopes.get(scopeId);
  const expected = scope ? `Bearer ${scope.token}` : "";
  if (!scope || typeof authorization !== "string" || Buffer.byteLength(authorization) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected)) || !live(scope)) return failure("native-guest-scope-denied");
  if (route === "status") return { ok: true, available: true, platform: process.platform, interactionDriver: "native-guest", scopeId };
  if (route === "action" && body.action === "listApps") return { ok: true, apps: scope.pages().filter(page => !page.wc.isDestroyed())
    .map(page => ({ name: pageApp(scope, page.id), id: pageApp(scope, page.id), kind: "native-guest" })) };
  const page = exactPage(scope, body.app);
  if (!page) return failure("native-guest-target-denied");
  const valid = () => live(scope) && exactPage(scope, body.app)?.wc === page.wc;
  const frame = () => nativeBrowserGuestInputFrame(scope.ownerId, scope.chatId, page.id);
  if (route === "observe") return { ok: true, app: { name: body.app, kind: "native-guest" }, elements: [],
    observationAvailable: false, message: "Use get_screen and guest coordinates; OS accessibility element actions are unavailable for this native guest." };
  let effectPossible = false;
  let pressed: NativeGuestDirectInput | null = null;
  const operation = async () => {
    if (!valid()) return failure("native-guest-scope-denied");
    if (route === "capture") {
      const before = frame();
      if (!before || before.width < 1 || before.height < 1) return failure("native-guest-capture-unavailable");
      const image = await captureNativeBrowserGuest(scope.ownerId, scope.chatId, page.id, undefined, scope.signal);
      if (!valid() || !sameFrame(frame(), before) || image.isEmpty()) return failure("native-guest-capture-stale");
      const size = image.getSize();
      const capture: Capture = { id: randomUUID(), pageId: page.id, frame: before, width: size.width, height: size.height };
      scope.capture = capture;
      const dataUrl = image.toDataURL();
      if (dataUrl.length > 5_500_000) return failure("native-guest-capture-budget-exceeded");
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      if (png.length < 24 || png.readUInt32BE(16) !== size.width || png.readUInt32BE(20) !== size.height) {
        scope.capture = null; return failure("native-guest-capture-geometry-mismatch");
      }
      let savedPath: string | null = null;
      try { savedPath = saveScreenCaptureArtifact(dataUrl); } catch { /* The measured image remains available. */ }
      const sourceId = `native-guest:${scope.id}:${capture.id}`;
      return { ok: true, preview: { dataUrl, capturedAt: new Date().toISOString(), selectedSourceId: sourceId, captureMode: "native-guest",
        interactionAvailable: scope.permission !== "read", observationAvailable: false, interactionDriver: "native-guest", fileUploadAvailable: false, clipboardAvailable: false,
        sources: [{ id: sourceId, kind: "native-guest", name: body.app, width: size.width, height: size.height }],
        provenance: { scopeId: scope.id, runId: scope.runId, chatId: scope.chatId, viewId: page.id, captureId: capture.id, ...before },
        ...(savedPath ? { savedPath } : {}) } };
    }
    if (route !== "action") return failure("native-guest-route-denied");
    if (body.action === "focusApp") return { ok: true, app: body.app, kind: "native-guest", focused: false };
    if (scope.permission === "read") return failure("native-guest-read-only");
    const capture = scope.capture;
    if (!capture || capture.pageId !== page.id || body.sourceId !== `native-guest:${scope.id}:${capture.id}` || !sameFrame(frame(), capture.frame)) {
      return failure("native-guest-capture-stale");
    }
    const authorized = () => valid() && scope.capture === capture && sameFrame(frame(), capture.frame);
    const point = (prefix = "") => {
      const x = body[`${prefix}x`], y = body[`${prefix}y`];
      if (!finite(x, 0, capture.width - 1) || !finite(y, 0, capture.height - 1)) return null;
      return { x: x / capture.width * capture.frame.width, y: y / capture.height * capture.frame.height };
    };
    const send = async (input: NativeGuestDirectInput) => {
      if (!authorized()) throw new Error("native-guest-input-stale");
      effectPossible = true;
      if ((input.kind === "pointer" || input.kind === "key") && input.phase === "down") pressed = input;
      await dispatchNativeBrowserGuestInput(scope.ownerId, scope.chatId, page.id, input, authorized);
      if ((input.kind === "pointer" || input.kind === "key") && input.phase === "up") pressed = null;
    };
    const button = body.button ?? "left";
    if (!["left", "right", "middle"].includes(String(button))) return failure("native-guest-input-invalid");
    if (["move", "click", "drag"].includes(String(body.action))) {
      const start = point(body.action === "drag" ? "from_" : ""), end = body.action === "drag" ? point("to_") : start;
      if (!start || !end || (body.clickCount !== undefined && ![1, 2].includes(Number(body.clickCount)))) return failure("native-guest-input-invalid");
      await send({ kind: "pointer", phase: "move", ...start, button: button as "left" });
      if (body.action !== "move") {
        await send({ kind: "pointer", phase: "down", ...start, button: button as "left", clickCount: Number(body.clickCount) || 1 });
        if (body.action === "drag") {
          for (let step = 1; step <= 8; step++) { await send({ kind: "pointer", phase: "move", x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8, button: button as "left", dragging: true }); }
        }
        await send({ kind: "pointer", phase: "up", ...end, button: button as "left", clickCount: Number(body.clickCount) || 1 });
      }
    } else if (body.action === "scroll") {
      const deltaX = body.deltaX ?? 0, deltaY = body.deltaY ?? 0;
      if (!finite(deltaX, -4_000, 4_000) || !finite(deltaY, -4_000, 4_000)) return failure("native-guest-input-invalid");
      await send({ kind: "wheel", x: capture.frame.width / 2, y: capture.frame.height / 2, deltaX, deltaY });
    } else if (body.action === "typeText") {
      if (typeof body.text !== "string" || !body.text || Buffer.byteLength(body.text) > 16 * 1024) return failure("native-guest-input-invalid");
      await send({ kind: "text", text: body.text });
    } else if (body.action === "key") {
      const aliases: Record<string, string> = { RETURN: "Enter", ENTER: "Enter", TAB: "Tab", BACKSPACE: "Backspace", DELETE: "Delete", ESC: "Escape", ESCAPE: "Escape", SPACE: "Space", ARROWLEFT: "Left", ARROWRIGHT: "Right", ARROWUP: "Up", ARROWDOWN: "Down", HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown" };
      const key = typeof body.key === "string" ? aliases[body.key.toUpperCase()] ?? body.key : "";
      const allowed = /^(?:[A-Za-z0-9]|Enter|Tab|Backspace|Delete|Escape|Space|Left|Right|Up|Down|Home|End|PageUp|PageDown)$/;
      const modifiers = body.modifiers ?? [];
      if (typeof body.key !== "string" || !allowed.test(key) || !Array.isArray(modifiers)
        || modifiers.some(value => !["shift"].includes(String(value)))) return failure("native-guest-input-invalid");
      // Global/app shortcuts and clipboard chords are not supported.
      if (body.repeat !== undefined && body.repeat !== 1) return failure("native-guest-input-invalid");
      await send({ kind: "key", phase: "down", key, modifiers });
      await send({ kind: "key", phase: "up", key, modifiers });
    } else return failure("native-guest-action-unsupported");
    // The dispatched click/key may legitimately navigate. Never turn its effect into a retryable stale failure.
    scope.capture = null;
    return { ok: true, app: body.app, kind: "native-guest", action: body.action, captureId: capture.id };
  };
  if (scope.queued >= 8) return failure("native-guest-queue-full");
  scope.queued++;
  const orderedOperation = async () => {
    try { return await operation(); } catch (error) {
      const code = error instanceof Error && /^native-(?:guest|browser)-[a-z-]+$/.test(error.message) ? error.message : "native-guest-operation-failed";
      if (effectPossible) scope.capture = null;
      return { ...failure(code), effectPossible, retrySafe: !effectPossible };
    } finally {
      scope.queued--;
      if (pressed) { try { releaseNativeBrowserGuestPressedInput(page.wc, pressed); } catch { /* terminal cleanup is best effort */ } }
    }
  };
  const next = scope.order.then(orderedOperation, orderedOperation);
  scope.order = next.then(() => undefined, () => undefined);
  return next;
}
