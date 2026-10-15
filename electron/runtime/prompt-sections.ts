// Codex image line (codex.ts). Every other always-on line is a PromptModule (prompt-modules.ts).
//
// Owner 2026-10-13: prompts are `key: value` one-liners and no keyword list over the user's text decides what a turn
// carries. The image line is one sentence and rides every ordinary Codex thread instead of a media-intent regex.

/** Image output line for Codex. `hostToolName` names the Agentlas image tool when one is attached to the thread. */
export function imageOutputContract(hostToolName?: string): string {
  const route = hostToolName ? `call \`${hostToolName}\` (the owner's engine) or your built-in generation` : "your built-in generation";
  return `image: ${route}; the host copies results into assets/ and reports the path (use it later); claim an image only after one is returned`;
}
