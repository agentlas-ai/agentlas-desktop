import type {GoalWaitIntent} from "./wait-emitter";
import type {TimerWaitAuthority} from "./goal-deadline";
/** Existing host timer rule, shared by legacy Goal and canonical owner adapters.
 * This normalizes a request; it cannot create domain deadline authority. */
export function normalizeGoalWaitTimer(intent:GoalWaitIntent,authority:TimerWaitAuthority,now:number):GoalWaitIntent {
  if(intent.subject.kind!=="timer") return intent;
  if(!authority.ok) throw new Error(authority.reason);
  let due=Date.parse(intent.subject.notBefore);
  if(authority.deadlineAt && due>Date.parse(authority.deadlineAt)) due=Date.parse(authority.deadlineAt);
  if(Number.isFinite(due) && due<now+60_000) due=Math.min(now+60_000,authority.deadlineAt?Date.parse(authority.deadlineAt):Infinity);
  if(!Number.isFinite(due) || (authority.deadlineAt && due>Date.parse(authority.deadlineAt))
    || (intent.deadline && due>=Date.parse(intent.deadline))) throw new Error("goal_wait_timer_invalid");
  return {...intent,subject:{kind:"timer",notBefore:new Date(due).toISOString()}};
}
