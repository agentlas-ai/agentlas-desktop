import fs from "node:fs";
import path from "node:path";
import { DAY_MS } from "./storage-policy";

/**











 */
const PACKAGE_DIR = /^(.+)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

async function newestTree(target: string): Promise<{ newestMs: number; bytes: number }> {
  let newestMs = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(current); } catch { continue; }
    newestMs = Math.max(newestMs, stat.mtimeMs);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) { bytes += stat.size; continue; }
    try { for (const name of await fs.promises.readdir(current)) stack.push(path.join(current, name)); } catch { newestMs = Number.POSITIVE_INFINITY; }
  }
  return { newestMs, bytes };
}

export async function retireCloudAgentPackages(
  root: string,
  options: { keepDays: number; now?: number },
): Promise<{ dirs: number; bytes: number }> {
  const result = { dirs: 0, bytes: 0 };
  const now = options.now ?? Date.now();
  try {
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
  } catch { return result; }
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return result; }
  const bySlug = new Map<string, Array<{ name: string; stampMs: number }>>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = PACKAGE_DIR.exec(entry.name);
    if (!match) continue;
    const stampMs = Date.parse(`${match[2]}T${match[3]}:${match[4]}:${match[5]}.${match[6]}Z`);
    if (!Number.isFinite(stampMs)) continue;
    const list = bySlug.get(match[1]) ?? [];
    list.push({ name: entry.name, stampMs });
    bySlug.set(match[1], list);
  }
  for (const list of bySlug.values()) {
    list.sort((a, b) => b.stampMs - a.stampMs || b.name.localeCompare(a.name));
    for (const { name, stampMs } of list.slice(1)) {
      if (now - stampMs < options.keepDays * DAY_MS) continue;
      const folder = path.join(root, name);
      const tree = await newestTree(folder);
      if (now - tree.newestMs < options.keepDays * DAY_MS) continue;
      try { await fs.promises.rm(folder, { recursive: true, force: true }); } catch { continue; }
      result.dirs += 1;
      result.bytes += tree.bytes;
    }
  }
  return result;
}
