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
/**
 * How long a picture is kept: while its conversation exists (removeChat calls removeCanvasExports), and at most this many pictures per conversation
 * (the oldest go when a new one is written). The owner's own copy is the file they saved from the outputs panel; this folder only backs that panel.
 */
export const EXPORTS_PER_CHAT_MAX = 40;

const exportsRoot = (): string => userDataPath('generated-assets', 'canvas-exports');
const exportScope = (chatId: string): string => createHash('sha256').update(chatId, 'utf8').digest('hex').slice(0, 32);

/** A real folder (never a link) directly inside `parent`; anything else is left alone. */
function ownFolder(parent: string, name: string): string | null {
  try {
    const target = path.join(parent, name);
    return fs.lstatSync(target).isDirectory() ? target : null;
  } catch { return null; }
}

/** A removed conversation has nobody left to read its pictures: its whole folder goes. Never throws (a conversation is removed whatever the disk says). */
export function removeCanvasExports(chatId: string): void {
  try {
    if (!chatId) return;
    const folder = ownFolder(exportsRoot(), exportScope(chatId));
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  } catch { /* the cap prunes the rest on the conversation's next export; nothing else reads this folder */ }
}

/** Keeps the newest EXPORTS_PER_CHAT_MAX pictures of a conversation; the one just written is never a candidate. */
function pruneCanvasExports(scopeFolder: string, keep: string): void {
  try {
    const entries = fs.readdirSync(scopeFolder).filter(name => name !== keep)
      .map(name => ({ name, time: (() => { try { return fs.lstatSync(path.join(scopeFolder, name)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.time - a.time);
    for (const old of entries.slice(Math.max(0, EXPORTS_PER_CHAT_MAX - 1))) {
      const folder = ownFolder(scopeFolder, old.name);
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
    }
  } catch { /* a folder that could not be pruned is pruned by the next export */ }
}

/** A file name from the card's title: letters, digits and Hangul, the rest becomes a dash; never empty. */
export function exportFileStem(title: string): string {
  const stem = title.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return stem || 'card';
}

export function writeCanvasExportFile(chatId: string, stem: string, extension: 'png', bytes: Buffer): string {
  if (!chatId || bytes.length < 1 || bytes.length > EXPORT_BYTES_MAX) throw new Error('canvas_export_invalid');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const scope = exportScope(chatId);
  const directory = path.join(exportsRoot(), scope, digest.slice(0, 32));
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
  if (holds()) { try { const now = new Date(); fs.utimesSync(directory, now, now); } catch { /* recency only orders the cap */ } return output; }
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, output);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* the temporary name is ours alone */ }
    if (!holds()) throw error;
  }
  if (!holds()) throw new Error('canvas_export_invalid');
  pruneCanvasExports(path.join(exportsRoot(), scope), digest.slice(0, 32));
  return output;
}
