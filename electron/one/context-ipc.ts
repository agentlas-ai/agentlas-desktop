import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { isAppControlEvent } from '../app-control/ipc-registry';
import { oneContextService, OneContextError } from './context-service';

export function registerOneContextIpc(input: {
  ipc: Pick<IpcMain, 'handle'>;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
  openPermissions(value: unknown): Promise<void>;
}): void {
  input.ipc.handle('oneContext:snapshot', (event, value) => {
    input.assertTrustedSender(event); return oneContextService().snapshot(value);
  });
  input.ipc.handle('oneContext:targets', (event, value) => {
    input.assertTrustedSender(event); return oneContextService().targets(value);
  });
  input.ipc.handle('oneContext:grant', (event, value) => {
    input.assertTrustedSender(event);
    if (isAppControlEvent(event)) throw new OneContextError('one-context-owner-interaction-required');
    return oneContextService().grant(value);
  });
  input.ipc.handle('oneContext:revoke', (event, value) => {
    input.assertTrustedSender(event); return oneContextService().revoke(value);
  });
  input.ipc.handle('oneContext:capture', (event, value) => {
    input.assertTrustedSender(event); return oneContextService().capture(value);
  });
  input.ipc.handle('oneContext:openPermissions', (event, value) => {
    input.assertTrustedSender(event);
    if (isAppControlEvent(event)) throw new OneContextError('one-context-owner-interaction-required');
    return input.openPermissions(value);
  });
}
