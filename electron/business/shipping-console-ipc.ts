import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { createBusinessShippingConsole, type BusinessShippingConsole } from './shipping-console';

export interface BusinessShippingIpcInput {
  ipc: Pick<IpcMain, 'handle'>;
  /** Existing Main renderer-ingress guard; this module creates no new trust rule. */
  assertTrustedSender(event: IpcMainInvokeEvent): BrowserWindow | void;
}

/** One Main registration. Dedicated HTTPS company windows have no preload and
 * never become a trusted local IPC sender or native execution authority. */
export function registerBusinessShippingIpc(input: BusinessShippingIpcInput): { console: BusinessShippingConsole; dispose(): void } {
  const ipc = input.ipc, handle = ipc.handle.bind(ipc), guard = input.assertTrustedSender.bind(input);
  const console = createBusinessShippingConsole();
  const callers = new Set<WebContents>();
  let closed = false;
  const register = (channel: string, arity: 0 | 1, invoke: (args: unknown[]) => unknown): void => {
    handle(channel, async (event, ...args: unknown[]) => {
      if (closed) throw Error('business_console_closed');
      guard(event);
      if (args.length !== arity) throw Error('business_request_invalid');
      callers.add(event.sender);
      const result = await invoke(args);
      if (closed || event.sender.isDestroyed()) throw Error('business_console_closed');
      guard(event);
      return result;
    });
  };
  register('business:snapshot', 0, () => console.snapshot());
  register('business:eligibility:read', 0, () => console.readEligibility!());
  register('business:account:read', 0, () => console.account.read());
  register('business:account:signIn', 0, () => console.account.signIn());
  register('business:account:joinOrganization', 1, args => console.account.joinOrganization(args[0] as Parameters<typeof console.account.joinOrganization>[0]));
  register('business:account:selectOrganization', 1, args => console.account.selectOrganization(args[0] as Parameters<typeof console.account.selectOrganization>[0]));
  register('business:account:logout', 1, args => console.account.logout(args[0] as Parameters<typeof console.account.logout>[0]));
  register('business:account:openAdmin', 1, args => console.account.openAdmin(args[0] as Parameters<typeof console.account.openAdmin>[0]));
  register('business:account:selectPersonal', 0, () => console.account.selectPersonal());
  register('business:openDashboard', 1, args => console.openDashboard!(args[0] as Parameters<NonNullable<typeof console.openDashboard>>[0]));
  const unsubscribe = console.onInvalidated!(() => {
    for (const caller of callers) {
      if (caller.isDestroyed()) { callers.delete(caller); continue; }
      try { caller.send('business:invalidated'); } catch { callers.delete(caller); }
    }
  });
  return Object.freeze({ console, dispose() { if (closed) return; closed = true; unsubscribe(); callers.clear(); console.dispose(); } });
}
