import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PRODUCT_HOME_ROOTS } from "../runtime/product-home-identity";
import { DAY_MS } from "./storage-policy";

/**
 * Product-home mirrors that mirror another mirror. Before 2026-10-17 a process that inherited a product run's
 * environment took the product home for the person's own CLI folder and mirrored it again (product-home-identity.ts).
 * Owner Mac, 2026-10-14: codex-product-home/10161a503527{,-isolated} = sha256("<root>/c183d58fa429-isolated")[:12], with its
 * own 609 MB state_5.sqlite and 75 MB thread history, 1.48 GB in all. The resolvers no longer select such a mirror, so
 * nothing reads it again.
 *
 * A mirror goes only when all of these hold:
 * - its folder name is sha256(<a sibling mirror's path>)[:12], plus that root's -isolated/-one suffix (nested by
 *   construction; a mirror of a person's real folder can never match);
 * - nothing anywhere inside it changed for `keepDays` (owner storage decision 2026-10-16: CLI originals unused for 30 days).
 * Removal never follows links: a codex mirror's sessions link points into the shared store. Other names, files and links
 * are never touched.
 */
const MIRROR_LEAF = /^([0-9a-f]{12})(-isolated|-one)?$/;

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

const hash12 = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

export async function retireNestedProductHomeMirrors(
  userDataRoot: string,
  options: { keepDays: number; now?: number },
): Promise<{ dirs: number; bytes: number }> {
  const result = { dirs: 0, bytes: 0 };
  const now = options.now ?? Date.now();
  for (const rootName of PRODUCT_HOME_ROOTS) {
    const root = path.join(userDataRoot, rootName);
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { continue; }
    const mirrors = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && MIRROR_LEAF.test(entry.name)).map((entry) => entry.name);
    const nestedPrefixes = new Set(mirrors.map((name) => hash12(path.join(root, name))));
    for (const name of mirrors) {
      const prefix = MIRROR_LEAF.exec(name)![1]!;
      if (!nestedPrefixes.has(prefix)) continue;
      const target = path.join(root, name);
      const { newestMs, bytes } = await newestTree(target);
      if (!(newestMs > 0) || now - newestMs < options.keepDays * DAY_MS) continue;
      try {
        await fs.promises.rm(target, { recursive: true, force: true });
        result.dirs += 1;
        result.bytes += bytes;
      } catch { /* busy or unreadable: the next pass tries again */ }
    }
  }
  return result;
}
