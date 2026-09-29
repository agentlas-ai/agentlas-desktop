// One paywall for the whole app (owner 2026-09-29): every "see plans" entry
// point — agent mail, low AI credits, Cloud agent seats, first-run, prompts —
// opens the same in-app "Choose a plan" modal. The modal is never gated on
// whether checkout is open; that question is asked only after "Upgrade".
//
// The host (<PlanPickerHost/>, mounted once in the root layout) listens for
// this event. Before the host mounts (or outside the app shell) the caller
// falls back to the web pricing page so a click never does nothing.

export const PLAN_PICKER_OPEN_EVENT = "agentlas:plan-picker:open";
const HOST_FLAG = "__agentlasPlanPickerHost";

/** Where the paywall was opened from (machine marker; used for tests and the waitlist source). */
export type PlanPickerSource =
  | "agent-mail"
  | "ai-credits"
  | "cloud-agent-limit"
  | "first-run"
  | "prompts"
  | "settings"
  | "one"
  | "work-first-run"
  | "other";

export interface PlanPickerRequest {
  source: PlanPickerSource;
}

export function markPlanPickerHost(mounted: boolean): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>)[HOST_FLAG] = mounted;
}

export function planPickerHostMounted(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as Record<string, unknown>)[HOST_FLAG] === true;
}

/** Opens the in-app plan picker. Returns false when no host is mounted (caller falls back). */
export function openPlanPicker(source: PlanPickerSource = "other"): boolean {
  if (!planPickerHostMounted()) return false;
  window.dispatchEvent(new CustomEvent<PlanPickerRequest>(PLAN_PICKER_OPEN_EVENT, { detail: { source } }));
  return true;
}
