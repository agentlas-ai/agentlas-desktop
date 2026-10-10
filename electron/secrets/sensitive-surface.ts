/** Native input barrier. A visible dedicated secret form disables product observation/input.
 * It grants no permission and contains no secret bytes. External OS capture is outside this host. */
const surfaces = new Map<number, string>();
let epoch = 0;
let activeOperations = 0;
export function oneSensitiveSurfaceActive(): boolean { return surfaces.size !== 0; }
export function assertOneSensitiveIpcChannel(webContentsId:number,channel:string):void {
  if(!surfaces.has(webContentsId))return;
  if(!['oneVault:bootstrap','oneVault:registerSender','oneVault:submit','oneVault:reconcile','oneVault:cancel'].includes(channel))throw new Error('one_sensitive_surface_channel_denied');
}
export function acquireOneSensitiveSurface(webContentsId: number, requestId: string): () => void {
  if (!Number.isSafeInteger(webContentsId) || webContentsId < 1 || !requestId || activeOperations > 0 || surfaces.size > 0) {
    throw new Error('one_sensitive_surface_unavailable');
  }
  surfaces.set(webContentsId, requestId); epoch += 1;
  let released = false;
  return () => { if (!released && surfaces.get(webContentsId) === requestId) { released = true; surfaces.delete(webContentsId); epoch += 1; } };
}
export function assertOneSensitiveOperationAllowed(): void {
  if (oneSensitiveSurfaceActive()) throw new Error('one_sensitive_surface_active');
}
/** All observable native work must drain before entry is enabled. Check again before publishing bytes. */
export async function withOneSensitiveOperation<T>(operation: () => Promise<T>): Promise<T> {
  assertOneSensitiveOperationAllowed(); const admitted = epoch; activeOperations += 1;
  try { const result = await operation(); if (admitted !== epoch) throw new Error('one_sensitive_surface_changed'); assertOneSensitiveOperationAllowed(); return result; }
  finally { activeOperations -= 1; }
}
