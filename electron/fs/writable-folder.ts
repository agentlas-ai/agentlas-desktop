// Can this process make a file in a folder?
//
// `fs.accessSync(dir, W_OK)` is the answer on macOS and Linux and stays the answer there. On Windows it only reads the read-only attribute, never the
// ACL: a folder this account may not write (a deny entry, a read-only share) passes it, and the move or write that follows then fails half way
// (win-vm-3 `probes4.log`: accessSync passed, the real write got EPERM). So on Windows the answer is a file made and removed in the folder.
// Plain Node, no Electron import.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { rmSyncWithRetry } from "./retry";

/** True when `dir` can take a new file now. The Windows probe leaves nothing behind: the empty file is removed before this returns (retried while a scanner holds it). */
export function folderIsWritable(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { return false; }
  if (platform !== "win32") return true;
  const probe = path.join(dir, `.agentlas-write-check-${process.pid}-${randomBytes(4).toString("hex")}`);
  try { fs.closeSync(fs.openSync(probe, "wx")); } catch { return false; }
  try { rmSyncWithRetry(probe); } catch { /* the account could make the file, so the folder is writable; a held leftover is taken by the next check's own name only */ }
  return true;
}
