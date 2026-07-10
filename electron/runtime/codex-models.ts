import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_MODEL_CACHE_BYTES = 2 * 1024 * 1024;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

type CodexModelCache = {
  models?: Array<{
    slug?: unknown;
    visibility?: unknown;
  }>;
};

/**
 * Read the account-scoped model list that the installed Codex CLI fetched.
 * Modern Codex uses the GPT family directly (for example gpt-5.6-terra), so
 * Agentlas must not invent a parallel `*-codex` name or expose models that the
 * signed-in workspace cannot actually select.
 */
export async function readCodexModelIds(
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
): Promise<string[]> {
  const cachePath = path.join(codexHome, "models_cache.json");
  try {
    const stat = await fs.stat(cachePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MODEL_CACHE_BYTES) return [];
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8")) as CodexModelCache;
    if (!Array.isArray(parsed.models)) return [];

    const seen = new Set<string>();
    const ids: string[] = [];
    for (const model of parsed.models) {
      // `hide` entries are internal surfaces such as auto-review, not picker models.
      if (model?.visibility !== "list" || typeof model.slug !== "string") continue;
      const id = model.slug.trim();
      if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch {
    // First launch/offline/corrupt cache: caller deliberately falls back to the
    // small built-in public catalog instead of failing runtime detection.
    return [];
  }
}
