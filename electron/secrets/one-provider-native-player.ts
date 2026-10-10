import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { OneProviderReceipt } from '../../shared/one-provider';
import { OneProviderError } from '../../shared/one-provider';
import { verifyOneWav } from './one-provider-broker';

/** A native result surface receives only verified audio; it exposes no application or credential bridge. */
export class OneProviderNativePlayer {
  private windows = new Set<BrowserWindow>();
  constructor(private readonly isOwnerWindow: (window: BrowserWindow) => boolean) {}
  async play(bytes: Uint8Array, receipt: Readonly<OneProviderReceipt>, stillCurrent: () => boolean): Promise<void> {
    const owner = BrowserWindow.getFocusedWindow();
    if (!owner || owner.isDestroyed() || !this.isOwnerWindow(owner) || !stillCurrent()
      || receipt.state !== 'audio_ready' || !receipt.audio || bytes.byteLength !== receipt.audio.sizeBytes
      || bytes.byteLength > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== receipt.audio.sha256) {
      throw new OneProviderError('authority_denied');
    }
    verifyOneWav(bytes);
    const window = new BrowserWindow({ parent: owner, width: 420, height: 190, minWidth: 320, minHeight: 160,
      title: 'One 음성 결과', show: false, resizable: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false,
        autoplayPolicy: 'no-user-gesture-required', partition: `one-audio-${receipt.operationId}` } });
    this.windows.add(window);
    const close = (): void => { if (!window.isDestroyed()) window.destroy(); };
    const valid = (): boolean => !owner.isDestroyed() && this.isOwnerWindow(owner) && stillCurrent();
    const timer = setInterval(() => { try { if (!valid()) close(); } catch { close(); } }, 250);
    timer.unref?.();
    window.on('closed', () => { clearInterval(timer); this.windows.delete(window); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const audio = Buffer.from(bytes).toString('base64');
    const html = '<!doctype html><html lang="ko"><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; media-src data:; base-uri \'none\'; form-action \'none\'">'
      + '<title>One 음성 결과</title><body style="margin:24px;font-family:system-ui;color:#171717;background:#fafafa">'
      + '<p>검증된 음성 결과</p><audio controls autoplay style="width:100%" src="data:audio/wav;base64,' + audio + '"></audio></body></html>';
    try {
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      if (!valid()) throw new OneProviderError('authority_denied');
      window.show();
    } catch (error) { close(); throw error; }
  }
  close(): void { for (const window of this.windows) if (!window.isDestroyed()) window.destroy(); this.windows.clear(); }
}
