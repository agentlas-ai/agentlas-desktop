import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Where an oversized current input of a conversation is kept as a file (runtime/oversized-input.ts): inside the folder the run works
 * in, at `<folder>/.agentlas/chat-input/<conversation scope>/<digest>.txt`, so the runtime's own file tools (and the sandbox of a CLI)
 * can read it. Content-addressed like the canvas exports: the same text lands on the same file and writes nothing. No database row.
 * No electron import (the daemon loads the runtime).
 *
 * Deletion rule (every path here is read by something; nothing is written without one):
 *   - removeChat calls removeChatInputSpills: the conversation's whole scope folder goes, in its working folder, its project folder and the default run folder;
 *   - sweepChatInputSpills (app start, work-inputs-startup-sweep.ts) removes a scope folder that no stored conversation owns once it has
 *     been untouched for ORPHAN_TTL_MS (a run without a stored conversation, or one removed while this app was not running). A scope a
 *     stored conversation owns stays until that conversation is removed.
 */
export const ORPHAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A file of a stored conversation is removed only when the conversation itself was not active (chats.updated_at) for this long and nothing wrote the file again. */
export const LIVE_FILE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** A paste larger than this is not kept as a file (the turn then goes as before). */
export const SPILL_BYTES_MAX = 128 * 1024 * 1024;
/** One folder's removal waits at most this long (a dead mount must not hold the app). */
const REMOVE_WAIT_MS = 5_000;
/** read_file returns at most 20,000 characters a call, so a line longer than this is wrapped to keep every slice readable. */
export const SPILL_LINE_MAX = 2000;
const SPILL_PARENT = [".agentlas", "chat-input"] as const;

export const chatInputScope = (chatId: string): string => createHash("sha256").update(chatId || "no-chat", "utf8").digest("hex").slice(0, 32);

function realDirectory(target: string): string | null {
  try { const stat = fs.lstatSync(target); return stat.isDirectory() && !stat.isSymbolicLink() ? target : null; } catch { return null; }
}

/** Lines longer than SPILL_LINE_MAX are cut into pieces of that size (a minified paste is one line); other bytes are kept. */
export function wrapLongLines(text: string): { text: string; wrapped: boolean } {
  if (!text.split("\n").some((line) => line.length > SPILL_LINE_MAX)) return { text, wrapped: false };
  return { wrapped: true, text: text.split("\n").map((line) => {
    if (line.length <= SPILL_LINE_MAX) return line;
    const pieces: string[] = [];
    for (let at = 0; at < line.length; at += SPILL_LINE_MAX) pieces.push(line.slice(at, at + SPILL_LINE_MAX));
    return pieces.join("\n");
  }).join("\n") };
}

export interface ChatInputSpill {
  /** Relative to the folder given to writeChatInputSpill. */
  relativePath: string;
  /** The conversation's own folder (absolute) and the file's name in it. */
  scopeDirectory: string; fileName: string;
  chars: number; lines: number; wrapped: boolean;
}

/** Writes `text` for the conversation under `folder`; throws when the folder cannot take it (the caller then leaves the input as it is). */
export function writeChatInputSpill(folder: string, chatId: string, text: string): ChatInputSpill {
  if (Buffer.byteLength(text, "utf8") > SPILL_BYTES_MAX) throw new Error("chat_input_spill_too_large");
  const body = wrapLongLines(text);
  const digest = createHash("sha256").update(body.text, "utf8").digest("hex").slice(0, 32);
  const scope = chatInputScope(chatId);
  // The project folder may sit behind a link; nothing INSIDE the subtree this code creates may: each level is made (or found) as a real
  // directory before the next one is created, so no write ever goes through a link.
  let directory = fs.realpathSync(folder);
  for (const part of [...SPILL_PARENT, scope]) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!realDirectory(directory)) throw new Error("chat_input_spill_path_changed");
  }
  // The folder is the owner's project: keep the copies out of version control.
  try { fs.writeFileSync(path.join(directory, "..", ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); } catch { /* present, or not needed */ }
  const file = path.join(directory, `${digest}.txt`);
  const size = Buffer.byteLength(body.text, "utf8");
  let present = false;
  try { const stat = fs.lstatSync(file); present = stat.isFile() && stat.size === size; } catch { /* written below */ }
  if (present) { try { const now = new Date(); fs.utimesSync(directory, now, now); fs.utimesSync(file, now, now); } catch { /* recency only orders the sweep */ } }
  else {
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try { fs.writeFileSync(temporary, body.text, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    catch (error) { try { fs.rmSync(temporary, { force: true }); } catch { /* ours alone */ } throw error; }
  }
  return { relativePath: [...SPILL_PARENT, scope, `${digest}.txt`].join("/"), scopeDirectory: directory, fileName: `${digest}.txt`, chars: body.text.length, lines: body.text.split("\n").length, wrapped: body.wrapped };
}

/**
 * A removed conversation has nobody left to read its files. Asynchronous and bounded per folder, so removeChat never waits on a disk
 * that does not answer; whatever is left is removed by the start-up sweep once no stored conversation owns it. Never rejects.
 */
export async function removeChatInputSpills(chatId: string, folders: ReadonlyArray<string | null | undefined>): Promise<void> {
  const scope = chatInputScope(chatId);
  const real = async (target: string): Promise<boolean> => { const stat = await fs.promises.lstat(target); return stat.isDirectory() && !stat.isSymbolicLink(); };
  let unresponsive = 0;
  for (const folder of new Set(folders.filter((value): value is string => typeof value === "string" && value.trim() !== ""))) {
    if (unresponsive >= 3) break; // like the start-up sweep: three folders that do not answer end the removal
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // .agentlas itself, the spill parent and the scope folder must each be a real directory (never a link) before anything is removed.
      const work = (async () => {
        const parent = path.join(folder, ...SPILL_PARENT), target = path.join(parent, scope);
        if (await real(path.join(folder, SPILL_PARENT[0])) && await real(parent) && await real(target)) await fs.promises.rm(target, { recursive: true, force: true });
      })();
      const outcome = await Promise.race([work.then(() => "done" as const), new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), REMOVE_WAIT_MS); })]); // cleared below
      if (outcome === "timeout") unresponsive += 1;
      work.catch(() => undefined);
    } catch { /* the sweep removes what is left once its conversation is gone */ }
    finally { if (timer) clearTimeout(timer); }
  }
}

/** One folder's sweep (see the deletion rule above). Never throws; returns the number of scope folders (or old files of a live one) removed. Asynchronous, so a folder that
 * does not answer (an unmounted network drive) never holds the event loop; the caller bounds the wait. */
export async function sweepChatInputSpills(folder: string, liveScopes: ReadonlyMap<string, number>, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    const parent = path.join(folder, ...SPILL_PARENT);
    const real = async (target: string): Promise<boolean> => { const stat = await fs.promises.lstat(target); return stat.isDirectory() && !stat.isSymbolicLink(); };
    if (!await real(path.join(folder, SPILL_PARENT[0])) || !await real(parent)) return 0;
    for (const name of await fs.promises.readdir(parent)) {
      if (!/^[0-9a-f]{32}$/.test(name)) continue;
      try {
        const target = path.join(parent, name);
        if (!await real(target)) continue;
        const activity = liveScopes.get(name); // the stored conversation's last activity (ms); absent: no stored conversation owns the scope
        if (activity !== undefined) {
          // A stored conversation keeps its files until it is removed; one idle for LIVE_FILE_TTL_MS loses the files nothing wrote again for that long.
          if (now - activity <= LIVE_FILE_TTL_MS) continue;
          for (const file of await fs.promises.readdir(target)) {
            const stat = await fs.promises.lstat(path.join(target, file));
            if (stat.isFile() && now - stat.mtimeMs > LIVE_FILE_TTL_MS) { await fs.promises.rm(path.join(target, file), { force: true }); removed += 1; }
          }
          continue;
        }
        if (now - (await fs.promises.lstat(target)).mtimeMs <= ORPHAN_TTL_MS) continue;
        await fs.promises.rm(target, { recursive: true, force: true }); removed += 1;
      } catch { /* looked at again at the next start */ }
    }
  } catch { /* a folder that does not answer is left as it is */ }
  return removed;
}
