import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userDataPath } from '../runtime-paths';

/**
 * Where an exported card (a picture) is written: under the app's generated-assets root, which the conversation's outputs panel and the
 * phone already read (fs/access.ts GENERATED_ROOT_NAMES), at `canvas-exports/<chat>/<digest>/<name>`. Content-addressed like the Science output
 * files (science-host/shared-output-file.ts): exporting the same bytes again lands on the same file and writes nothing. No database row, no copy of the
 * card: the file is the only trace. A write is atomic (a temporary name in the same folder, then a rename), so a crash or a full disk leaves no half file.
 * No electron import (the daemon loads the harness).
 */
export const EXPORT_BYTES_MAX = 64 * 1024 * 1024;

/** A file name from the card's title: letters, digits and Hangul, the rest becomes a dash; never empty. */
export function exportFileStem(title: string): string {
  const stem = title.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return stem || 'card';
}

export function writeCanvasExportFile(chatId: string, stem: string, extension: 'png', bytes: Buffer): string {
  if (!chatId || bytes.length < 1 || bytes.length > EXPORT_BYTES_MAX) throw new Error('canvas_export_invalid');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const scope = createHash('sha256').update(chatId, 'utf8').digest('hex').slice(0, 32);
  const directory = userDataPath('generated-assets', 'canvas-exports', scope, digest.slice(0, 32));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The app's data folder may itself sit behind a link (a /var → /private/var on macOS, a junction on Windows); nothing INSIDE the subtree we created may.
  if (fs.realpathSync(directory) !== path.join(fs.realpathSync(userDataPath()), 'generated-assets', 'canvas-exports', scope, digest.slice(0, 32))) throw new Error('canvas_export_invalid');
  const output = path.join(directory, `${exportFileStem(stem)}.${extension}`);
  const holds = (): boolean => {
    try {
      const fd = fs.openSync(output, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { return fs.fstatSync(fd).isFile() && createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === digest; } finally { fs.closeSync(fd); }
    } catch { return false; }
  };
  if (holds()) return output;
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, output);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* the temporary name is ours alone */ }
    if (!holds()) throw error;
  }
  if (!holds()) throw new Error('canvas_export_invalid');
  return output;
}
