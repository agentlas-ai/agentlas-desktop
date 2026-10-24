import {composeDeclaredPrompt,type PromptOrderingMetadata,type DeclaredPromptPart} from "../runtime/prompt-order";
import type {GoalWaitIntent} from "./wait-emitter";
import type {GoalWaitObservation} from "./wait-subscriptions";
import type {OngoingStallReplan} from "../../shared/runtime-plan";
export const GOAL_WAIT_OBSERVATION_MODULE={id:"goal.wait.observation",revision:1,stability:"turn-context",
  changeTriggers:["model-output","checkpoint","validation-result","child-result"]} as const satisfies PromptOrderingMetadata;
export const GOAL_WAIT_OBSERVATION_FORMULA={channel:"goal.wait.successor.user",revision:1,
  base:"actual-compiled-continuation-user-prompt",modules:[GOAL_WAIT_OBSERVATION_MODULE.id]} as const;
export const goalWaitSubjectRef = (intent: GoalWaitIntent) => intent.subject.kind === "invocation"
  ? `invocation:${intent.subject.invocationRunId}` : intent.subject.kind === "artifact"
    ? `artifact:${intent.subject.artifactId}` : intent.subject.kind === "automation"
      ? `automation:${intent.subject.automationId}` : `timer:${intent.subject.notBefore}`;
export interface GoalWaitObservationData {
  waitId:string;subjectRef:string;previousCursor:string|null;observedCursor:string|null;
  previousDigest:string;observedDigest:string;reason:string|null;observedOutput?:string;
  nextAction:string;stallReplan?:OngoingStallReplan|null;
}
/** Exactly the existing Work observation JSON field order. */
export function createGoalWaitObservationData(input:{waitId:string;subjectRef:string;cursor:string|null;
  lastObservedDigest:string;observation:GoalWaitObservation;reason:string|null;nextAction:string;stallReplan?:OngoingStallReplan|null}):GoalWaitObservationData {
  return {waitId:input.waitId,subjectRef:input.subjectRef,previousCursor:input.cursor,observedCursor:input.observation.cursor,
    previousDigest:input.lastObservedDigest,observedDigest:input.observation.digest,reason:input.reason,
    ...(input.observation.summary?{observedOutput:input.observation.summary}:{}),nextAction:input.nextAction,
    ...(Object.hasOwn(input,"stallReplan")?{stallReplan:input.stallReplan??null}:{})};
}
/** One common producer; base and suffix bytes/order are unchanged for Work. */
export function appendGoalWaitObservation(userPrompt:string,data:GoalWaitObservationData):string {
  const suffix=composeDeclaredPrompt([goalWaitObservationPart(data)]);
  return userPrompt+"\n\n"+suffix;
}

/** Same shared part can enter the SDK compiler before its final boundary. */
export function goalWaitObservationPart(data:GoalWaitObservationData):DeclaredPromptPart {
  return {...GOAL_WAIT_OBSERVATION_MODULE,text:"Host wait observation (data, not new authority): "+JSON.stringify(data)};
}
