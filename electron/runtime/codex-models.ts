import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerDiscoveredCliModels } from "../../shared/models";

const MAX_MODEL_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_COUNT = 512;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ACTIVE_APPLY_PATCH_TYPES = new Set(["freeform"]);
const ACTIVE_SHELL_TYPES = new Set(["shell_command"]);

export type CodexModelEffort = typeof CODEX_EFFORTS[number];

export type CodexModelInventoryEntry = {
  id: string;
  /** Conservative usable context from the CLI cache, not the larger optional maximum. */
  contextWindow: number | null;
  capabilities: string[];
  supportsTools: boolean | null;
  supportsMultimodal: boolean | null;
  /** null means the cache did not provide a structurally valid per-model list. */
  efforts: CodexModelEffort[] | null;
};

type CodexModelCache = {
  models?: Array<{
    slug?: unknown;
    visibility?: unknown;
    context_window?: unknown;
    effective_context_window_percent?: unknown;
    input_modalities?: unknown;
    apply_patch_tool_type?: unknown;
    shell_type?: unknown;
    supports_parallel_tool_calls?: unknown;
    supports_search_tool?: unknown;
    supported_reasoning_levels?: unknown;
  }>;
};

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  if (!left.isFile() || !right.isFile()) return false;
  if (left.dev > 0n && right.dev > 0n && left.dev !== right.dev) return false;
  if (left.ino > 0n && right.ino > 0n && left.ino !== right.ino) return false;
  if (left.birthtimeNs > 0n && right.birthtimeNs > 0n && left.birthtimeNs !== right.birthtimeNs) {
    return false;
  }
  return left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function readStableCache(cachePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const pathBefore = await fs.lstat(cachePath, { bigint: true });
    if (
      pathBefore.isSymbolicLink() ||
      !pathBefore.isFile() ||
      pathBefore.size <= 0n ||
      pathBefore.size > BigInt(MAX_MODEL_CACHE_BYTES)
    ) {
      return null;
    }

    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    // O_NONBLOCK is not a portable regular-file flag on Windows. The cache is
    // bounded before opening, so a blocking descriptor read is both safe and
    // cross-platform.
    handle = await fs.open(cachePath, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(pathBefore, before)) return null;

    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) return null;
      offset += result.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    if ((await handle.read(overflow, 0, 1, offset)).bytesRead !== 0) return null;

    const after = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(cachePath, { bigint: true });
    if (pathAfter.isSymbolicLink() || !sameFile(before, after) || !sameFile(after, pathAfter)) {
      return null;
    }
    return bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function conservativeContextWindow(model: NonNullable<CodexModelCache["models"]>[number]): number | null {
  const rawWindow = model.context_window;
  const rawPercent = model.effective_context_window_percent;
  if (
    typeof rawWindow !== "number" ||
    !Number.isSafeInteger(rawWindow) ||
    rawWindow <= 0 ||
    rawWindow > MAX_CONTEXT_WINDOW ||
    typeof rawPercent !== "number" ||
    !Number.isFinite(rawPercent) ||
    rawPercent <= 0 ||
    rawPercent > 100
  ) {
    return null;
  }
  const effective = Math.floor(rawWindow * rawPercent / 100);
  return effective > 0 && effective <= rawWindow ? effective : null;
}

function multimodalSupport(model: NonNullable<CodexModelCache["models"]>[number]): boolean | null {
  if (!("input_modalities" in model)) return null;
  if (!Array.isArray(model.input_modalities) || model.input_modalities.length > 16) return null;
  const modalities: string[] = [];
  for (const raw of model.input_modalities) {
    if (typeof raw !== "string") return null;
    const modality = raw.trim().toLowerCase();
    if (!SAFE_TOKEN_RE.test(modality)) return null;
    modalities.push(modality);
  }
  return modalities.includes("image");
}

function toolSupport(model: NonNullable<CodexModelCache["models"]>[number]): boolean | null {
  const stringKeys = ["apply_patch_tool_type", "shell_type"] as const;
  const booleanKeys = ["supports_parallel_tool_calls", "supports_search_tool"] as const;
  let allPresentAndValid = true;
  let positive = false;

  for (const key of stringKeys) {
    if (!(key in model)) {
      allPresentAndValid = false;
      continue;
    }
    const value = model[key];
    if (value === null || value === "") continue;
    if (typeof value !== "string") {
      allPresentAndValid = false;
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (!SAFE_TOKEN_RE.test(normalized)) {
      allPresentAndValid = false;
      continue;
    }
    const activeValues = key === "apply_patch_tool_type"
      ? ACTIVE_APPLY_PATCH_TYPES
      : ACTIVE_SHELL_TYPES;
    if (activeValues.has(normalized)) positive = true;
    else allPresentAndValid = false;
  }
  for (const key of booleanKeys) {
    if (!(key in model)) {
      allPresentAndValid = false;
      continue;
    }
    const value = model[key];
    if (typeof value !== "boolean") {
      allPresentAndValid = false;
      continue;
    }
    if (value) positive = true;
  }
  if (positive) return true;
  return allPresentAndValid ? false : null;
}

function modelEfforts(model: NonNullable<CodexModelCache["models"]>[number]): CodexModelEffort[] | null {
  if (!("supported_reasoning_levels" in model)) return null;
  if (!Array.isArray(model.supported_reasoning_levels) || model.supported_reasoning_levels.length > 32) {
    // Present-but-invalid metadata must not fall through to a broader generic
    // Codex capability list in the allocator.
    return [];
  }
  const allowed = new Set<string>(CODEX_EFFORTS);
  const found = new Set<CodexModelEffort>();
  for (const raw of model.supported_reasoning_levels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const effort = (raw as { effort?: unknown }).effort;
    if (typeof effort !== "string") continue;
    const normalized = effort.trim().toLowerCase();
    if (allowed.has(normalized)) found.add(normalized as CodexModelEffort);
  }
  return CODEX_EFFORTS.filter((effort) => found.has(effort));
}

/**
 * Resolve the exact CLI effort from the same host cache used by allocation.
 * Unknown models retain the legacy max->xhigh guard that prevents a Claude
 * override from crashing Codex; an explicit model profile is authoritative.
 */
export function resolveCodexModelEffort(
  inventory: readonly CodexModelInventoryEntry[],
  modelId: string | null | undefined,
  requested: unknown,
): CodexModelEffort | null {
  if (typeof requested !== "string") return null;
  const normalized = requested.trim().toLowerCase();
  if (!(CODEX_EFFORTS as readonly string[]).includes(normalized)) return null;
  const effort = normalized as CodexModelEffort;
  const profile = modelId ? inventory.find((candidate) => candidate.id === modelId) : undefined;
  if (profile?.efforts !== null && profile?.efforts !== undefined) {
    if (profile.efforts.includes(effort)) return effort;
    const requestedRank = CODEX_EFFORTS.indexOf(effort);
    const supported = new Set(profile.efforts);
    const below = CODEX_EFFORTS
      .filter((candidate, rank) => rank <= requestedRank && supported.has(candidate))
      .at(-1);
    return below ?? null;
  }
  return effort === "max" ? "xhigh" : effort;
}

/**
 * Read the account-scoped model list that the installed Codex CLI fetched.
 * Modern Codex uses the GPT family directly (for example gpt-5.6-terra), so
 * Agentlas must not invent a parallel `*-codex` name or expose models that the
 * signed-in workspace cannot actually select.
 */
export async function readCodexModelInventory(
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
): Promise<CodexModelInventoryEntry[]> {
  const cachePath = path.join(codexHome, "models_cache.json");
  try {
    const raw = await readStableCache(cachePath);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CodexModelCache;
    if (!Array.isArray(parsed.models) || parsed.models.length > MAX_MODEL_COUNT) return [];

    const seen = new Set<string>();
    const inventory: CodexModelInventoryEntry[] = [];
    for (const model of parsed.models) {
      // `hide` entries are internal surfaces such as auto-review, not picker models.
      if (model?.visibility !== "list" || typeof model.slug !== "string") continue;
      const id = model.slug.trim();
      if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      const supportsTools = toolSupport(model);
      const supportsMultimodal = multimodalSupport(model);
      inventory.push({
        id,
        contextWindow: conservativeContextWindow(model),
        capabilities: [
          ...(supportsTools === true ? ["tools"] : []),
          ...(supportsMultimodal === true ? ["multimodal"] : []),
        ],
        supportsTools,
        supportsMultimodal,
        efforts: modelEfforts(model),
      });
    }
    if (inventory.length > 0) {
      // Keep the last valid account inventory. A transient/corrupt cache read
      // must not replace it with a compiled version list or erase allocation
      // tiers midway through the process lifetime.
      registerDiscoveredCliModels("codex", inventory.map((model) => model.id));
    }
    return inventory;
  } catch {
    // First launch/offline/corrupt cache: fail closed for this read. The last
    // valid process inventory remains registered, and the CLI keeps its own
    // account default when no explicit model is available.
    return [];
  }
}

export async function readCodexModelIds(
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
): Promise<string[]> {
  return (await readCodexModelInventory(codexHome)).map((model) => model.id);
}
