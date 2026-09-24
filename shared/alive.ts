/**
 * Alive (AGI toggle) IPC contract for One and Work composers.
 *
 * One Alive life per Work project (key alive:work-project:v1:<projectId>), attached to the chat where AGI was
 * turned on and following that chat's ongoing Goal; one per One Goal (key alive:one-goal:v1:<goalId>). The life
 * is the orchestrator; seats and borrowed Hub/Cloud agents stay ordinary workers. It keeps living while the
 * desktop app is open, whatever screen is shown, and resumes on its own after a restart. It never follows the
 * composer model chip: each wake runs on the first usable member of the dashboard role pool
 * (orchestrator members, then worker members), falling down the order when usage runs out.
 */
export type AliveSurface = "one" | "work";

export type AliveStatus = "off" | "waiting" | "running" | "resting" | "tokens-spent" | "usage-unknown" | "blocked";

export interface AliveModelOrderItem {
  role: "orchestrator" | "worker";
  runtimeId: string;
  model: string;
  label: string;
  exhausted: boolean;
  /** The member the running wake uses, or the one the next wake will use. */
  current: boolean;
}

export interface AliveState {
  available: boolean;
  /** Machine code when unavailable (e.g. alive-work-project-required, alive-controller-not-installed). */
  reasonCode?: string;
  /** Server entitlement check; absence/unknown never permits a new wake. */
  accessReasonCode?: "alive-sign-in-required" | "alive-plan-required" | "alive-entitlement-unavailable";
  enabled: boolean;
  scope: { kind: "one-goal" | "work-project"; id: string; label: string } | null;
  /** No Goal in this chat yet: enabling returns alive-goal-required ("start a goal first"). */
  needsGoal: boolean;
  status: AliveStatus;
  /** Machine wait/failure code behind the status (e.g. grant.tokens-spent, goal.owner-stopped, model.order-exhausted). */
  statusReasonCode?: string;
  budget: { tokenLimit: number | null; tokensUsed: number };
  modelOrder: AliveModelOrderItem[];
  /** Work only: this project's Alive life is attached to another chat. setEnabled with moveFrom=true moves it here. */
  conflict?: { chatId: string; title: string };
}

export interface AliveGetStateInput { surface: AliveSurface; chatId: string }
export interface AliveSetEnabledInput {
  surface: AliveSurface; chatId: string; enabled: boolean; tokenLimit?: number | null; moveFrom?: boolean;
}
/**
 * Also the owner's way out of status "usage-unknown" (a wake killed mid-call can never report its usage):
 * setting the limit — even to the same value — acknowledges those wakes and the life continues.
 */
export interface AliveSetTokenLimitInput { surface: AliveSurface; chatId: string; tokenLimit: number | null }
export interface AliveChangedEvent { surface: AliveSurface; chatId?: string; scopeId: string }

/** Default token grant when the owner turns AGI on without choosing one. Raising it later continues a sleeping life. */
export const ALIVE_DEFAULT_TOKEN_LIMIT = 500_000;
export const ALIVE_MAX_TOKEN_LIMIT = 1_000_000_000;
