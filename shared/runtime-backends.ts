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
  "upstage",
  "custom",
  "glm",
  "kimi",
  "deepseek",
  "minimax",
  "xai",
  "openrouter",
  "cursor",
] as const satisfies readonly RuntimeBackend[];

// Exhaustiveness in both directions: every RuntimeBackend must be listed above.
type _Missing = Exclude<RuntimeBackend, (typeof RUNTIME_BACKENDS)[number]>;
const _exhaustive: _Missing extends never ? true : never = true;
void _exhaustive;

export const RUNTIME_BACKEND_SET: ReadonlySet<string> = new Set<string>(RUNTIME_BACKENDS);

export function isRuntimeBackend(value: unknown): value is RuntimeBackend {
  return typeof value === "string" && RUNTIME_BACKEND_SET.has(value);
}
