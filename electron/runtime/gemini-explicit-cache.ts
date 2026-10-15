/*
 * Gemini explicit context cache (cachedContents) for the BYOK generateContent path (docs/2026-10-13-native-harness/13 §7).
 *
 * Doc 13 allows explicit caching only with an implementation, a permission, a billing and an expiry contract:
 *   - permission: off by default; only the owner turns it on (harness cache.settings.set from an owner surface).
 *   - billing:    Google bills cached tokens per hour of storage; the owner sets the TTL, and every created cache writes a
 *                 receipt (model, prefix digest, estimated tokens, TTL) so the storage spend is traceable.
 *   - expiry:     a cache is reused only while more than EXPIRY_MARGIN_MS of its TTL is left; a request that meets a
 *                 missing/expired cache is sent once more without it and the entry is dropped. Nothing is deleted early:
 *                 an unused cache ends at its TTL.
 * The cached part is exactly the request's stable prefix (systemInstruction + tools) for one model; contents, generation
 * config and the owner's input are never cached. No electron import (the daemon runs BYOK too).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface GeminiCacheSetting { enabled: boolean; ttlSeconds: number }

export const GEMINI_CACHE_DEFAULT: GeminiCacheSetting = { enabled: false, ttlSeconds: 600 };
const TTL_MIN = 60;
const TTL_MAX = 24 * 60 * 60;
const EXPIRY_MARGIN_MS = 30_000;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

async function settingsFile(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath("provider-cache-settings.json");
}

export async function readGeminiCacheSetting(): Promise<GeminiCacheSetting> {
  try {
    const raw = JSON.parse(fs.readFileSync(await settingsFile(), "utf8")) as { gemini?: Partial<GeminiCacheSetting> };
    return normalizeGeminiCacheSetting(raw.gemini);
  } catch {
    return { ...GEMINI_CACHE_DEFAULT };
  }
}

export function normalizeGeminiCacheSetting(value: Partial<GeminiCacheSetting> | undefined): GeminiCacheSetting {
  const ttl = Number(value?.ttlSeconds);
  return {
    enabled: value?.enabled === true,
    ttlSeconds: Number.isFinite(ttl) ? Math.min(TTL_MAX, Math.max(TTL_MIN, Math.round(ttl))) : GEMINI_CACHE_DEFAULT.ttlSeconds,
  };
}

export async function writeGeminiCacheSetting(next: Partial<GeminiCacheSetting>): Promise<GeminiCacheSetting> {
  const file = await settingsFile();
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { current = {}; }
  const merged = normalizeGeminiCacheSetting({ ...(await readGeminiCacheSetting()), ...next });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ ...current, gemini: merged }, null, 2), { mode: 0o600 });
  return merged;
}

/** Google's minimum cacheable input (public docs: 1,024 tokens for Flash-class, 4,096 for Pro-class models). */
export function geminiExplicitMinTokens(model: string): number {
  return /pro/i.test(model) ? 4096 : 1024;
}

/** The one digest of what the cache holds: model + systemInstruction + tools. */
export function geminiPrefixDigest(model: string, systemInstruction: unknown, tools: unknown): string {
  return createHash("sha256").update(model).update("\0").update(JSON.stringify(systemInstruction ?? null))
    .update("\0").update(JSON.stringify(tools ?? null)).digest("hex");
}

interface Entry { name: string; expireAtMs: number }
const entries = new Map<string, Entry>();

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type EnsureOutcome =
  | { status: "reused"; name: string }
  | { status: "created"; name: string; expireAtMs: number }
  | { status: "skipped"; reason: string };

/**
 * A live cachedContents name for this prefix, creating one when none is fresh. Never throws: any failure is a skip with
 * a reason and the caller sends the plain request.
 */
export async function ensureGeminiCachedContent(input: {
  apiKey: string;
  model: string;
  systemInstruction: unknown;
  tools?: unknown;
  prefixTokensEst: number;
  setting: GeminiCacheSetting;
  nowMs?: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<EnsureOutcome> {
  if (!input.setting.enabled) return { status: "skipped", reason: "gemini_explicit_off" };
  if (input.prefixTokensEst < geminiExplicitMinTokens(input.model)) return { status: "skipped", reason: "gemini_explicit_below_min" };
  const now = input.nowMs ?? Date.now();
  const digest = geminiPrefixDigest(input.model, input.systemInstruction, input.tools);
  const live = entries.get(digest);
  if (live && live.expireAtMs - now > EXPIRY_MARGIN_MS) return { status: "reused", name: live.name };
  entries.delete(digest);
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const res = await fetchImpl(`${GEMINI_BASE}/cachedContents?key=${encodeURIComponent(input.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model.startsWith("models/") ? input.model : `models/${input.model}`,
        displayName: `agentlas-${digest.slice(0, 12)}`,
        systemInstruction: input.systemInstruction,
        ...(input.tools ? { tools: input.tools } : {}),
        ttl: `${input.setting.ttlSeconds}s`,
      }),
      signal: input.signal,
    });
    if (!res.ok) return { status: "skipped", reason: `gemini_cache_create_http_${res.status}` };
    const data = (await res.json()) as { name?: unknown; expireTime?: unknown };
    if (typeof data.name !== "string" || !data.name.startsWith("cachedContents/")) return { status: "skipped", reason: "gemini_cache_create_no_name" };
    const parsed = typeof data.expireTime === "string" ? Date.parse(data.expireTime) : Number.NaN;
    const expireAtMs = Number.isFinite(parsed) ? parsed : now + input.setting.ttlSeconds * 1000;
    entries.set(digest, { name: data.name, expireAtMs });
    try {
      const { appendReceipt } = await import("../harness/capability-ports");
      await appendReceipt({ operationId: "cache.gemini.create", model: input.model, prefixDigest: digest.slice(0, 16),
        prefixTokensEst: input.prefixTokensEst, ttlSeconds: input.setting.ttlSeconds, expireTime: new Date(expireAtMs).toISOString() });
    } catch { /* a receipt failure never blocks the request */ }
    return { status: "created", name: data.name, expireAtMs };
  } catch {
    return { status: "skipped", reason: "gemini_cache_create_failed" };
  }
}

/** A generateContent refusal that means the named cache is gone (expired, deleted, or not visible to this key). */
export function isGeminiCacheMissing(status: number, body: string): boolean {
  if (status === 404) return true;
  return (status === 400 || status === 403) && /cached ?content/i.test(body) && /(not found|expired|does not exist|permission)/i.test(body);
}

/** Drop the entry that holds this name (after a missing-cache refusal). */
export function forgetGeminiCachedContent(name: string): void {
  for (const [digest, entry] of entries) if (entry.name === name) entries.delete(digest);
}

/** The generateContent body that reads the cache: the cached prefix leaves the request, everything else stays. */
export function geminiBodyWithCache<T extends { systemInstruction?: unknown; tools?: unknown }>(body: T, name: string): Omit<T, "systemInstruction" | "tools"> & { cachedContent: string } {
  const { systemInstruction: _system, tools: _tools, ...rest } = body;
  void _system; void _tools;
  return { ...rest, cachedContent: name };
}

/** Test seam. */
export function resetGeminiCachedContents(): void { entries.clear(); }
