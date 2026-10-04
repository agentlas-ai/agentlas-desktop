import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

// One operates Agentlas through the same IPC handlers the screens call (owner 2026-10-04: "사소한 설정과 기능 심지어
// 사이언스도 조작이 되야"). developmentIpcBoundary records every Main handler here as it registers it, so One reaches
// exactly the code a click reaches: same validation, same stores, same side effects. Nothing here decides what One
// may call; that is ./policy.

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const handlers = new Map<string, RegisteredHandler>();
const appControlEvents = new WeakSet<object>();
const callScope = new AsyncLocalStorage<{ live: boolean; operation: string }>();

export function recordAppControlHandler(channel: string, handler: RegisteredHandler): void {
  handlers.set(channel, handler);
}

export function appControlHandlerRegistered(channel: string): boolean {
  return handlers.has(channel);
}

/** True only for the event objects this module built: a renderer cannot send one, so handlers may trust it. */
export function isAppControlEvent(event: unknown): boolean {
  return !!event && typeof event === "object" && appControlEvents.has(event);
}

export class AppControlError extends Error {
  constructor(readonly code: string, message: string) {
    // The code leads the message: it is what reaches One through the control server.
    super(`${code}: ${message}`);
    this.name = "AppControlError";
  }
}

// A handler that asks for a native dialog (a folder pick, a save location, a confirm box) needs the owner's hand and
// would hang One's tool call until someone clicks. Inside a live One call it fails at once instead. A job the handler
// left running after it returned is not One's call any more and may ask normally.
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
      if (scope?.live) throw new AppControlError("needs-owner-dialog", `${scope.operation} opens a window the owner has to answer (${name}); ask the owner to do it in the app.`);
      return (original as (...input: unknown[]) => unknown).apply(this, args);
    };
  }
}

function syntheticEvent(window: BrowserWindow): IpcMainInvokeEvent {
  const sender = window.webContents;
  const frame = sender.mainFrame;
  // The main window is the sender: the trusted-sender checks then hold for the same reason they hold for a click.
  const event = Object.freeze({
    sender,
    senderFrame: frame,
    frameId: frame.routingId,
    processId: frame.processId,
    defaultPrevented: false,
    preventDefault() { /* not cancellable */ },
  });
  appControlEvents.add(event);
  return event as unknown as IpcMainInvokeEvent;
}

export async function invokeAppControlIpc(input: { window: BrowserWindow; channel: string; args: unknown[]; operation: string }): Promise<unknown> {
  const handler = handlers.get(input.channel);
  if (!handler) throw new AppControlError("operation-unavailable", `${input.operation} is not available in this app session.`);
  if (input.window.isDestroyed() || input.window.webContents.isDestroyed()) throw new AppControlError("app-window-closed", "The Agentlas window is closed.");
  installDialogGuard();
  const scope = { live: true, operation: input.operation };
  try {
    return await callScope.run(scope, () => handler(syntheticEvent(input.window), ...input.args));
  } finally {
    scope.live = false;
  }
}
