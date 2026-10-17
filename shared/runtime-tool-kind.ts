/*
 * The typed kind of one observed tool call (review 2026-10-16 H1).
 *
 * ACP v1 defines `ToolCall.kind` (docs/protocol/v1/tool-calls: read, edit, delete, move, search, execute, think, fetch,
 * switch_mode, other) precisely so a client never has to parse a display title. Runners that know the kind pass it to
 * `onTool` beside the display name: ACP agents send it (runtime/acp.ts), and Antigravity's native tool names map to it
 * in its own runner (runtime/antigravity.ts). Consumers that classify tools (firm verification evidence) read the kind
 * and never the ACP title "execute: <title>". Runners with fixed native names (Claude Code `Bash`, Codex `bash`) pass
 * no kind, and their consumers keep their native-name rule.
 *
 * Type only: each runner owns the mapping from its own protocol, so this module adds no runtime import anywhere.
 */
export type RuntimeToolKind =
  | "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
