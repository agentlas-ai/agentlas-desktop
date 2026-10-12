/*
 * Provider prompt-cache helpers shared by the API-key (BYOK) runners and Agentlas serving.
 *
 * - Anthropic Messages caches only behind explicit cache_control markers. Content blocks of every
 *   kind accept one (text, image, tool_use, tool_result); render order is tools -> system -> messages.
 * - OpenAI, DeepSeek, Kimi, xAI, OpenRouter (OpenAI-style) cache a stable prefix automatically; the only
 *   client duty is to keep the prefix byte-stable and to read the cached count back from usage.
 * - Gemini 2.5+ caches implicitly; the cached count is usageMetadata.cachedContentTokenCount.
 */
import { createHash } from "node:crypto";

export type CacheableBlock = { type: string; cache_control?: { type: "ephemeral" } } & Record<string, unknown>;
export type CacheableMessage<B extends CacheableBlock = CacheableBlock> = { role: string; content: string | B[] };

function withMarkerOnLastBlock<M extends CacheableMessage>(message: M): M {
  const blocks: CacheableBlock[] = typeof message.content === "string"
    ? (message.content ? [{ type: "text", text: message.content }] : [])
    : message.content.map((block) => ({ ...block }));
  const last = blocks[blocks.length - 1];
  if (!last) return message;
  blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  return { ...message, content: blocks } as M;
}

/**
 * Rolling breakpoints for an Anthropic request body's messages (system keeps its own marker):
 *  - the last block of the final message when it carries tool_results — the newest tool_result, so each step
 *    reads the whole previous transcript at 0.1x and writes only the new tail;
 *  - the last block of the message before it — the turn boundary that stays byte-identical next turn.
 * Total with the system marker is 3 of the 4 allowed. Input is not mutated.
 */
export function withRollingCacheBreakpoints<M extends CacheableMessage>(messages: M[]): M[] {
  if (messages.length === 0) return messages;
  const next = messages.slice();
  const lastIndex = next.length - 1;
  // The first request of a turn ends in this turn's user input — that tail changes next turn, so only the
  // turn boundary before it is marked. Mid tool loop the final message is the newest tool_result: mark it.
  const last = next[lastIndex];
  if (Array.isArray(last.content) && last.content.some((block) => block.type === "tool_result")) {
    next[lastIndex] = withMarkerOnLastBlock(last);
  }
  if (lastIndex >= 1) next[lastIndex - 1] = withMarkerOnLastBlock(next[lastIndex - 1]);
  return next;
}

const count = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

/** OpenAI-style usage -> cached input tokens (OpenAI/xAI/OpenRouter prompt_tokens_details.cached_tokens, Kimi cached_tokens, DeepSeek prompt_cache_hit_tokens). */
export function cachedTokensFromOpenAiUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
    ? u.prompt_tokens_details as Record<string, unknown> : undefined;
  const input = count(u.prompt_tokens);
  const cached = count(details?.cached_tokens) ?? count(u.cached_tokens) ?? count(u.prompt_cache_hit_tokens);
  return cached !== undefined && input !== undefined && cached <= input ? cached : undefined;
}

/** Gemini usageMetadata -> cached input tokens (a subset of promptTokenCount). */
export function cachedTokensFromGeminiUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = count(u.promptTokenCount);
  const cached = count(u.cachedContentTokenCount);
  return cached !== undefined && input !== undefined && cached <= input ? cached : undefined;
}

/**
 * Cache affinity for stateless OpenAI-style APIs, the API side of resuming a conversation (2026-10-12). A conversation
 * keeps one opaque key: OpenAI routes requests carrying the same `prompt_cache_key` to the same prompt cache, and
 * OpenRouter pins a `session_id` to one provider so repeats hit that provider's cache. Other OpenAI-compatible servers
 * get nothing, since some reject unknown fields. The key is a hash, never the chat id itself.
 */
export function cacheAffinityFields(input: { baseUrl: string; chatId?: string | null; ownerId?: string | null }): Record<string, string> {
  if (!input.chatId) return {};
  let hostname = "";
  try { hostname = new URL(input.baseUrl).hostname.toLowerCase(); } catch { return {}; }
  const key = createHash("sha256").update("agentlas-cache-affinity-v1\0").update(input.chatId)
    .update("\0").update(input.ownerId ?? "").digest("hex").slice(0, 32);
  if (hostname === "api.openai.com") return { prompt_cache_key: key };
  if (hostname === "openrouter.ai") return { session_id: key };
  return {};
}
