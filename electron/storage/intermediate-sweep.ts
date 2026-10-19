import fs from "node:fs";
import path from "node:path";

/**


























 */

const IMAGE = /\.(png|jpe?g|exr|tiff?|webp|bmp|dpx)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const TEMP = /\.(tmp|part|partial|crdownload)$/i;
const NUMBERED = /\d{3,}/;
const SKIP_DIRS = new Set(["node_modules", ".git", "inputs", ".agentlas"]);
const DELIVERED = /^(deliver(y|ables?)|exports?|publish(ed)?|release)$/i;
export const FRAME_SEQUENCE_MIN = 24;
export const FRAME_SEQUENCE_UNNAMED_MIN = 120;
const FRAME_FOLDER = /(^|[-_/])(frames?|renders?|seq|sequences?|samples?|encoded|qa|stills|evidence|previews?|tmp|temp|cache|scratch)([-_/]|$)/i;
const FINISH_MARKERS = new Set(["verification.json", ".agentlas-complete"]);
export const KEEP_MARKER = ".agentlas-keep";

export interface IntermediateSweepResult {
  removedFiles: number;
  removedBytes: number;
  frameDirs: string[];
}

interface DirInfo {
  frames: string[];
  newestFrameMs: number;
  /** Newest mtime of any file in this subtree. */
  newestMs: number;
  /** Newest video mtime in this subtree. */
  newestVideoMs: number;
  /** Newest verified-finish record in this subtree. */
  newestFinishMs: number;
  temps: Array<{ file: string; mtimeMs: number; size: number }>;
  keep: boolean;
}

// Asynchronous throughout: the sweep runs in the Desktop main process, whose
// event loop must never stall (a synchronous walk of the owner's workspace took 0.9 s).
async function scan(dir: string, infos: Map<string, DirInfo>, inheritedKeep: boolean): Promise<DirInfo> {
  const info: DirInfo = { frames: [], newestFrameMs: 0, newestMs: 0, newestVideoMs: 0, newestFinishMs: 0, temps: [], keep: inheritedKeep };
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return info; }
  if (entries.some((entry) => entry.name === KEEP_MARKER) || DELIVERED.test(path.basename(dir))) info.keep = true;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = await scan(full, infos, info.keep);
      info.newestMs = Math.max(info.newestMs, child.newestMs);
      info.newestVideoMs = Math.max(info.newestVideoMs, child.newestVideoMs);
      info.newestFinishMs = Math.max(info.newestFinishMs, child.newestFinishMs);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(full); } catch { continue; }
    info.newestMs = Math.max(info.newestMs, stat.mtimeMs);
    if (FINISH_MARKERS.has(entry.name)) info.newestFinishMs = Math.max(info.newestFinishMs, stat.mtimeMs);
    if (VIDEO.test(entry.name)) info.newestVideoMs = Math.max(info.newestVideoMs, stat.mtimeMs);
    else if (IMAGE.test(entry.name) && NUMBERED.test(entry.name)) {
      info.frames.push(full);
      info.newestFrameMs = Math.max(info.newestFrameMs, stat.mtimeMs);
    } else if (TEMP.test(entry.name)) info.temps.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  infos.set(dir, info);
  return info;
}

async function remove(file: string, root: string, result: IntermediateSweepResult, dryRun: boolean): Promise<void> {
  let parent: string;
  try { parent = await fs.promises.realpath(path.dirname(file)); } catch { return; }
  if (parent !== root && !parent.startsWith(root + path.sep)) return;
  let size = 0;
  try { size = (await fs.promises.lstat(file)).size; } catch { return; }
  if (!dryRun) {
    try { await fs.promises.unlink(file); } catch { return; }
  }
  result.removedFiles += 1;
  result.removedBytes += size;
}

export async function sweepAgentIntermediates(
  workspaceRoot: string,
  options: { idleMs: number; unverifiedIdleMs: number; now?: number; dryRun?: boolean },
): Promise<IntermediateSweepResult> {
  const result: IntermediateSweepResult = { removedFiles: 0, removedBytes: 0, frameDirs: [] };
  let root: string;
  try { root = await fs.promises.realpath(workspaceRoot); } catch { return result; }
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun === true;
  const infos = new Map<string, DirInfo>();
  await scan(root, infos, false);

  for (const [dir, info] of infos) {
    if (info.keep) continue;
    for (const temp of info.temps) {
      if (now - temp.mtimeMs >= options.idleMs) await remove(temp.file, root, result, dryRun);
    }
    if (info.frames.length < FRAME_SEQUENCE_MIN) continue;
    if (info.frames.length < FRAME_SEQUENCE_UNNAMED_MIN && !FRAME_FOLDER.test(path.relative(root, dir))) continue;
    // The project is the nearest folder (the frame folder itself, then up to
    // three levels above it) whose subtree holds a video written after the last frame.
    let project: DirInfo | null = info.newestVideoMs >= info.newestFrameMs ? info : null;
    let cursor = dir;
    for (let level = 0; !project && level < 3; level += 1) {
      cursor = path.dirname(cursor);
      if (cursor === root || !cursor.startsWith(root + path.sep)) break;
      const candidate = infos.get(cursor);
      if (candidate && candidate.newestVideoMs >= info.newestFrameMs) project = candidate;
    }
    if (!project) continue;
    const verified = project.newestFinishMs >= info.newestFrameMs && project.newestFinishMs > 0;
    if (now - project.newestMs < (verified ? options.idleMs : options.unverifiedIdleMs)) continue;
    for (const frame of info.frames) await remove(frame, root, result, dryRun);
    result.frameDirs.push(path.relative(root, dir));
    if (!dryRun) {
      try { if ((await fs.promises.readdir(dir)).length === 0) await fs.promises.rmdir(dir); } catch { /* keep the folder */ }
    }
  }
  return result;
}
