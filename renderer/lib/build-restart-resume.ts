/**
 * Whether a build conversation restored after an app restart goes on by itself (build-session.ts restoreStoredConversation).
 *
 * Only a run the process died under: status "unknown" (a turn was started and never finalized), never a question waiting for the
 * owner. Only with the same folder's durable grant restored (the build writes there). And not a resumed run that was cut again: its
 * record starts with the host's own resume line, so two cuts in a row keep the "review the previous run" card instead of resuming in
 * a loop (a run that crashes the app at every start would otherwise restart itself at every launch).
 */
export const BUILD_RESTART_RESUME_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Also only a run whose runtime was settled (`runtimePinned`: the owner approved or chose it): an unsettled one, cut while it was
 * still being prepared or allocated, would ask the allocator model and the Hub before the owner touched anything. And only a cut of
 * the last day: an "unknown" record also covers a run that ended in an error weeks ago, which is not "the app restarted".
 */
export function buildRestartResumeAllowed(
  saved: { status: string; workspace: string | null; hostAuthoredContinuation?: boolean; request: string; runtimePinned?: boolean; updatedAt?: string },
  grantPath: string | null | undefined,
  resumeLine: string,
  now = Date.now(),
): boolean {
  if (saved.status !== "unknown" || !saved.workspace || grantPath !== saved.workspace) return false;
  if (saved.runtimePinned !== true) return false;
  const at = Date.parse(saved.updatedAt ?? "");
  if (!Number.isFinite(at) || now - at > BUILD_RESTART_RESUME_MAX_AGE_MS) return false;
  return !(saved.hostAuthoredContinuation === true && saved.request.trim() === resumeLine.trim());
}
