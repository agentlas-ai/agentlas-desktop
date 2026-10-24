/**
 * The owner's exact words versus the execution prompt.
 *
 * Main appends a bounded standing-staff block (collaboration preferences and
 * historical handover notes) to the model's execution prompt and keeps the exact
 * person-authored text in `oneUserAuthoredPrompt` (the typed signal). Only the
 * model's prompt may carry the block. The stored user row, the title, Goal
 * intake and the Goal objective are the owner's text, and a planner or worker
 * must read the block as background, never as the request: production 1.3.4
 * (2026-10-12, room chat 8f3e09ee, run 8722779b) stored the block in the owner's
 * message and Goal objective, and the task-force planner briefed a teammate on
 * the handover note's old work instead of the new instruction.
 */
export const ONE_STAFF_GUIDANCE_OPEN = "<agentlas-one-staff-preferences>";
export const ONE_STAFF_GUIDANCE_CLOSE = "</agentlas-one-staff-preferences>";

interface OwnerPromptRequest {
  userPrompt: string;
  oneUserAuthoredPrompt?: string;
}

/** Split the execution prompt into the owner's request and the appended background block. */
export function splitOneExecutionPrompt(req: OwnerPromptRequest): { request: string; background: string } {
  const text = req.userPrompt;
  // Only Main sets the authored text; without it nothing was appended.
  if (typeof req.oneUserAuthoredPrompt !== "string") return { request: text, background: "" };
  const open = text.indexOf(ONE_STAFF_GUIDANCE_OPEN);
  if (open < 0) return { request: text, background: "" };
  const closeAt = text.indexOf(ONE_STAFF_GUIDANCE_CLOSE, open);
  if (closeAt < 0) return { request: text, background: "" };
  const end = closeAt + ONE_STAFF_GUIDANCE_CLOSE.length;
  const background = text.slice(open, end);
  // The block may lead the prompt (standing-staff first, owner words last): drop the separator it leaves behind.
  const before = text.slice(0, open).replace(/\s+$/, "");
  const after = text.slice(end);
  const request = (before ? before + after : after.replace(/^\s+/, "")).replace(/\s+$/, "");
  return { request, background };
}

/**
 * Remove every standing-staff block from text that has no typed authored-prompt signal: a Goal objective or criterion
 * stored before the objective was taken from ownerVisiblePrompt. Read-time only, never rewrites stored Goals. The
 * tags are the host's own reserved delimiters.
 */
export function stripStaffGuidance(text: string): string {
  let out = text;
  for (let i = 0; i < 8; i += 1) {
    const open = out.indexOf(ONE_STAFF_GUIDANCE_OPEN);
    if (open < 0) break;
    const close = out.indexOf(ONE_STAFF_GUIDANCE_CLOSE, open);
    if (close < 0) break;
    out = out.slice(0, open).replace(/\s+$/, "") + out.slice(close + ONE_STAFF_GUIDANCE_CLOSE.length);
  }
  return out.trim();
}

/** What the owner typed: persisted row, title, Goal intake and objective. */
export function ownerVisiblePrompt(req: OwnerPromptRequest): string {
  return splitOneExecutionPrompt(req).request;
}

/** Label for the block when a planner or worker prompt includes it. */
export function oneBackgroundSection(background: string): string {
  return background
    ? `BACKGROUND ONLY (standing-staff preferences and historical handover notes; this is not the request and not a task to resume or continue):\n${background}`
    : "";
}
