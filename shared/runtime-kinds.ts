// The one list of RuntimeKind values (PRD 2026-08-15 B-1).
//
// Seven hand-maintained allowlists (model roles, agent overrides, chats,
// automations, run-graph, mobile authority, …) each named the kinds by hand;
// adding "acp" made the picker show an engine that `runtime:setActive` then
// rejected as "Unknown runtime kind" (found by the live E2E, not by any unit
// gate). Every allowlist now derives from this array; the `satisfies` clause
// makes a missing member a compile error the moment the union grows.
import type { RuntimeKind } from "./types";

export const RUNTIME_KINDS = [
  "claude-code",
  "codex",
  "antigravity",
  "kimi",
  "grok",
  "cursor",
  "byok",
  "ollama",
  "lmstudio",
  "mlx",
  "acp",
  // Agentlas 서빙 — CLI 도 API 키도 없는 사람의 실행 경로. 모델은 우리 서버가 고른다.
  "agentlas",
] as const satisfies readonly RuntimeKind[];

// Exhaustiveness in both directions: every RuntimeKind must be listed above.
type _Missing = Exclude<RuntimeKind, (typeof RUNTIME_KINDS)[number]>;
const _exhaustive: _Missing extends never ? true : never = true;
void _exhaustive;

export const RUNTIME_KIND_SET: ReadonlySet<string> = new Set<string>(RUNTIME_KINDS);

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === "string" && RUNTIME_KIND_SET.has(value);
}
