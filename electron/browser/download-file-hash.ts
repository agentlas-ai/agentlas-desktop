import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DOWNLOAD_HASH_CHUNK_BYTES = 256 * 1024;
export interface DownloadFileIdentity {
  dev: string; ino: string; bytes: number; mtimeNs: string; ctimeNs: string;
}
function identity(stat: fs.BigIntStats): DownloadFileIdentity {
  const bytes = Number(stat.size);
  if (!stat.isFile() || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("download_file_not_regular");
  return {dev:String(stat.dev),ino:String(stat.ino),bytes,mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)};
}
const same = (a: DownloadFileIdentity, b: DownloadFileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.bytes === b.bytes && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Metadata only. Reject every symlink component before opening any bytes. */
export function captureDownloadFile(root: string, relativePath: string) {
  if (!root || !relativePath || root.length > 4096 || relativePath.length > 4096 || relativePath.includes("\0")
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)
    || relativePath.split(/[\\/]+/).some(part => part === "..")) throw new Error("download_file_scope_invalid");
  const canonicalRoot = fs.realpathSync(root), target = path.resolve(canonicalRoot,relativePath);
  const relative = path.relative(canonicalRoot,target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || !fs.statSync(canonicalRoot).isDirectory()) throw new Error("download_file_scope_invalid");
  const inspect = () => {
    let component = canonicalRoot;
    for (const part of relative.split(path.sep)) {
      component = path.join(component,part);
      if (fs.lstatSync(component).isSymbolicLink()) throw new Error("download_file_symlink");
    }
    if (fs.realpathSync(root) !== canonicalRoot || fs.realpathSync(target) !== target) throw new Error("download_file_scope_changed");
    return identity(fs.statSync(target,{bigint:true}));
  };
  return {target,identity:inspect(),inspect};
}

/** One fixed buffer per FD, regardless of file size. Every read yields to the
 * host; Stop and ownership changes are checked before and after each read. */
export async function hashDownloadFile(root: string, relativePath: string, options: {
  signal?: AbortSignal; current?: () => boolean; expectedIdentity?: DownloadFileIdentity;
  onProgress?: (bytes: number) => void;
} = {}): Promise<{sha256:string;bytes:number;identity:DownloadFileIdentity}> {
  let handle: fs.promises.FileHandle | undefined;
  const check = () => {
    options.signal?.throwIfAborted();
    if (options.current && !options.current()) throw new Error("download_file_scope_changed");
  };
  try {
    check();
    const captured = captureDownloadFile(root,relativePath);
    const expected = options.expectedIdentity ?? captured.identity;
    if (!same(captured.identity,expected)) throw new Error("download_file_changed");
    handle = await fs.promises.open(captured.target,fs.constants.O_RDONLY
      | (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)));
    check();
    const opened = identity(await handle.stat({bigint:true}));
    if (!same(opened,expected) || !same(captured.inspect(),opened)) throw new Error("download_file_changed");
    const buffer = Buffer.allocUnsafe(DOWNLOAD_HASH_CHUNK_BYTES), hash = createHash("sha256");
    let bytes = 0;
    while (bytes < opened.bytes) {
      check();
      const read = await handle.read(buffer,0,Math.min(buffer.length,opened.bytes-bytes),bytes);
      check();
      if (!read.bytesRead) throw new Error("download_file_changed");
      hash.update(buffer.subarray(0,read.bytesRead)); bytes += read.bytesRead;
      options.onProgress?.(bytes);
    }
    if ((await handle.read(buffer,0,1,bytes)).bytesRead) throw new Error("download_file_changed");
    check();
    if (!same(identity(await handle.stat({bigint:true})),opened) || !same(captured.inspect(),opened)) throw new Error("download_file_changed");
    const closing = handle; handle = undefined;
    await closing.close();
    check();
    if (!same(captured.inspect(),opened)) throw new Error("download_file_changed");
    return {sha256:hash.digest("hex"),bytes,identity:opened};
  } finally { await handle?.close(); }
}
