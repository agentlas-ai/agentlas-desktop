import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

// One operates Agentlas through the same IPC handlers the screens call (owner 2026-10-04: "사소한 설정과 기능 심지어
// 사이언스도 조작이 되야"). developmentIpcBoundary records every Main handler here as it registers it, so One reaches
// exactly the code a click reaches: same validation, same stores, same side effects. Nothing here decides what One
// may call; that is ./policy.

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const handlers = new Map<string, RegisteredHandler>();
const domainHandlers = new Map<string, (...args: unknown[]) => unknown>();
const rendererEvents = new Map<number, IpcMainInvokeEvent>();
const trackedSenders = new WeakSet<object>();
const callScope = new AsyncLocalStorage<{ live: boolean; operation: string; event?: IpcMainInvokeEvent; window: BrowserWindow | null; ownerInteraction: boolean }>();
let interactionValidator: ((event: IpcMainInvokeEvent) => void) | null = null;

export function configureAppControlInteractionValidator(validator: (event: IpcMainInvokeEvent) => void): void {
  interactionValidator = validator;
}

export function recordAppControlHandler(channel: string, handler: RegisteredHandler): void {
  handlers.set(channel, handler);
}
/** Domain adapters are registered explicitly; they never impersonate a renderer. */
export function recordAppControlDomainHandler(channel: string, handler: (...args: unknown[]) => unknown): void {
  domainHandlers.set(channel, handler);
}
/** Explicitly extracted services share their real IPC entry and validation, without a renderer event argument. */
export function registerAppControlDomainIpc(ipc: Pick<IpcMain, "handle">, channel: string, handler: (...args: any[]) => unknown): void {
  ipc.handle(channel, (_event, ...args) => handler(...args));
  recordAppControlDomainHandler(channel, (...args) => {
    // Lazy imports avoid the development boundary -> registry initialization cycle.
    (require("../ipc-args-normalize") as typeof import("../ipc-args-normalize")).normalizeIpcArgsInPlace(args);
    (require("../development-effect-policy") as typeof import("../development-effect-policy")).assertDevelopmentIpcAllowed(channel, args);
    return handler(...args);
  });
}
/** Keep the actual top-frame IPC sender for interaction routes, without fake events. */
export function recordAppControlRendererEvent(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) return;
  if (!interactionValidator) return;
  try { interactionValidator(event); } catch { return; }
  rendererEvents.set(event.sender.id, event);
  if (!trackedSenders.has(event.sender)) {
    trackedSenders.add(event.sender);
    event.sender.once("destroyed", () => rendererEvents.delete(event.sender.id));
    event.sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) rendererEvents.delete(event.sender.id);
    });
  }
}

export function appControlHandlerRegistered(channel: string): boolean {
  return handlers.has(channel) || domainHandlers.has(channel);
}

/** True only inside the live call using the owner's actual validated event. */
export function isAppControlEvent(event: unknown): boolean {
  const scope = callScope.getStore();
  return !!scope?.live && scope.event === event;
}

export function appControlInteractionWindowAvailable(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !interactionValidator) return false;
  const event = rendererEvents.get(window.webContents.id);
  if (!event || event.senderFrame !== window.webContents.mainFrame) return false;
  try { interactionValidator(event); return true; } catch { return false; }
}

export function appControlDomainHandlerRegistered(channel: string): boolean { return domainHandlers.has(channel); }

export class AppControlError extends Error {
  constructor(readonly code: string, message: string) {
    // The code leads the message: it is what reaches One through the control server.
    super(`${code}: ${message}`);
    this.name = "AppControlError";
  }
}

// A dialog needs an explicit owner turn and the current registered interaction
// surface. Autonomous/domain calls fail immediately; owner interactions attach
// to the existing One/Main window. Work left running after the call is separate.
const DIALOG_METHODS = ["showOpenDialog", "showSaveDialog", "showMessageBox", "showOpenDialogSync", "showSaveDialogSync",
  "showMessageBoxSync", "showErrorBox", "showCertificateTrustDialog"] as const;
let dialogGuardInstalled = false;
function installDialogGuard(): void {
  if (dialogGuardInstalled) return;
  dialogGuardInstalled = true;
  // Loaded here, not at import: developmentIpcBoundary imports this module and also runs in plain-Node gates.
  const target = (require("electron") as typeof import("electron")).dialog as unknown as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") return;
  for (const name of DIALOG_METHODS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function guardedDialog(this: unknown, ...args: unknown[]) {
      const scope = callScope.getStore();
      if (scope?.live) {
        if (!scope.ownerInteraction || !appControlInteractionWindowAvailable(scope.window)) throw new AppControlError("needs-owner-dialog", `${scope.operation} needs the owner's live interaction (${name}).`);
        // Options-only dialog overloads must still attach to the existing One/Main surface.
        if (["showOpenDialog", "showSaveDialog", "showMessageBox", "showOpenDialogSync", "showSaveDialogSync", "showMessageBoxSync"].includes(name)
          && args.length === 1) args.unshift(scope.window);
      }
      return (original as (...input: unknown[]) => unknown).apply(this, args);
    };
  }
}

export async function invokeAppControlIpc(input: { window: BrowserWindow | null; channel: string; args: unknown[]; operation: string; ownerInteraction?: boolean }): Promise<unknown> {
  installDialogGuard();
  const domain = domainHandlers.get(input.channel);
  if (domain) {
    const scope = { live: true, operation: input.operation, window: null, ownerInteraction: false };
    try { return await callScope.run(scope, () => domain(...input.args)); }
    finally { scope.live = false; }
  }
  const handler = handlers.get(input.channel);
  if (!handler) throw new AppControlError("operation-unavailable", `${input.operation} is not available in this app session.`);
  if (!input.window || input.window.isDestroyed() || input.window.webContents.isDestroyed()) throw new AppControlError("needs-owner-interaction", "This operation needs an authenticated interaction surface.");
  if (!appControlInteractionWindowAvailable(input.window)) throw new AppControlError("needs-owner-interaction", "This operation needs the owner's live authenticated interaction surface.");
  const event = rendererEvents.get(input.window.webContents.id)!;
  const scope = { live: true, operation: input.operation, event, window: input.window, ownerInteraction: input.ownerInteraction === true };
  try {
    return await callScope.run(scope, () => handler(event, ...input.args));
  } finally {
    scope.live = false;
  }
}
