import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { oneHarness } from './harness';
import { oneToolReadiness } from './tool-readiness';
import type { OneHarnessActionRequest, OneHarnessResultRequest } from '../../shared/one-harness';

export function registerOneHarnessIpc(input: { ipc: Pick<IpcMain, 'handle'>; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  input.ipc.handle('oneHarness:getResult', (event, value: OneHarnessResultRequest) => {
    input.assertTrustedSender(event); return oneHarness().getResult(value);
  });
  input.ipc.handle('oneHarness:action', (event, value: OneHarnessActionRequest) => {
    input.assertTrustedSender(event); return oneHarness().action(value);
  });
  input.ipc.handle('oneHarness:readiness', (event, value) => {
    input.assertTrustedSender(event); return oneToolReadiness(value);
  });
}
