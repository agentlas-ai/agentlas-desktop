// The one list of RuntimeBackend values — same discipline as runtime-kinds.ts.
//
// Three hand-maintained copies (chats, automations, mobile authority) each
// named the 15 backends by hand; the RuntimeKind incident showed exactly how
// that ends when the union grows (a picker offers what the validator then
// rejects). Every backend allowlist now derives from this array; the
// `satisfies` clause makes a missing member a compile error the moment the
// union grows.
import type { RuntimeBackend } from "./types";

export const RUNTIME_BACKENDS = [
  "anthropic",
  "openai",
  "google",
  "ollama",
  "lmstudio",
  "mlx",
  "agentlas-local",
  "upstage",
  "custom",
  "glm",
  "kimi",
  "deepseek",
  "minimax",
  "xai",
  "openrouter",
  "cursor",
  "agentlas",
] as const satisfies readonly RuntimeBackend[];

// Exhaustiveness in both directions: every RuntimeBackend must be listed above.
type _Missing = Exclude<RuntimeBackend, (typeof RUNTIME_BACKENDS)[number]>;
const _exhaustive: _Missing extends never ? true : never = true;
void _exhaustive;

export const RUNTIME_BACKEND_SET: ReadonlySet<string> = new Set<string>(RUNTIME_BACKENDS);

export function isRuntimeBackend(value: unknown): value is RuntimeBackend {
  return typeof value === "string" && RUNTIME_BACKEND_SET.has(value);
}

/**
 * Kinds whose backend is fixed by the kind itself. A selection that arrives without the backend
 * (older mirrors, mobile, IPC callers) must still land on the same stored keys the picker reads —
 * measured 2026-09-25: active_runtime held {kind:"agentlas", backend:"", model:"agentlas-light"},
 * the runner executed Light, but detect filtered on backend "agentlas", missed, and the composer
 * chip showed the default "Agentlas Normal".
 */
const FIXED_BACKEND: Partial<Record<string, RuntimeBackend>> = { agentlas: "agentlas" };

export function canonicalRuntimeBackend<B extends string | null | undefined>(kind: string | null | undefined, backend: B): RuntimeBackend | B {
  return (kind && FIXED_BACKEND[kind]) || backend;
}
