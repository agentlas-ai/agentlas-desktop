import { goalObjectiveText, type GoalIntakeDecision, type GoalSourceMessage } from "../../shared/auto-goal";
import { getChat } from "../store/chats";
import { getDb } from "../store/db";
import { getLongRunByGoalId, longRunOwnerHold } from "../store/long-runs";
import { ownsHostGoalLoop } from "./host-goal-surface";
import { judgeGoalCadence, type GoalCadenceModelCall } from "./judged-goal-cadence";
import {
  judgeRequired,
  type JudgmentRuntimeAttempt,
  type RequiredJudgeSpec,
  type RequiredVerdict,
} from "../system-agents/judgment";

type IntakeLabel = Exclude<GoalIntakeDecision["intent"], "execute"> | "execute_single_turn" | "execute_multi_turn" | "execute_series" | "execute_ongoing";
const INTAKE_LABELS: readonly IntakeLabel[] = ["execute_single_turn", "execute_multi_turn", "execute_series", "execute_ongoing", "question", "explore", "conditional", "unknown"];
const FINITE_EXECUTION: ReadonlySet<IntakeLabel> = new Set(["execute_single_turn", "execute_multi_turn", "execute_series"]);
export const AUTOMATIC_GOAL_INTENT_TIMEOUT_MS = 60_000;

export interface AutomaticGoalIntentResolution extends GoalIntakeDecision {
  classification: "classified" | "unavailable" | "continued_existing";
  failureKind?: RequiredVerdict<IntakeLabel>["failureKind"];
  attempts?: JudgmentRuntimeAttempt[];
  /** The label was execute_series (the decision itself stays an ordinary finite multi-turn one; the audit event records it). */
  series?: true;
  /** Why a series carries no cadence (the call was refused, unreadable, or its numbers are not in the owner's words). */
  cadenceReason?: string;
}

/** A failed auxiliary classification cannot stop an already bound Goal. Its
 * existing contract continues; this fallback never admits a new Goal.
 */
export async function resolveAutomaticGoalIntent(
  source: GoalSourceMessage,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    judgeFn?: (spec: RequiredJudgeSpec<IntakeLabel>) => Promise<RequiredVerdict<IntakeLabel>>;
    /**
     * Read the interval and the run count of a bounded series (judged-goal-cadence.ts) when the label is execute_series. Only
     * the admission asks for it: the background service's classification-only pass decides forward-or-not and must not pay
     * for a second model call.
     */
    extractCadence?: boolean;
    /** Test seam for the cadence call; production uses the connected judgment pool. */
    cadenceModel?: GoalCadenceModelCall;
  } = {},
): Promise<AutomaticGoalIntentResolution> {
  const abstain = (diagnostic: Partial<Pick<AutomaticGoalIntentResolution, "failureKind" | "attempts">> = {}): AutomaticGoalIntentResolution => {
    let continuesExisting = false;
    if (!options.signal?.aborted && source.role === "user" && source.text.trim()) {
      try {
        const chat = getChat(source.chatId);
        const run = chat?.goalId ? getLongRunByGoalId(chat.goalId) : null;
        const stored = getDb().prepare("SELECT chat_id,role,text FROM chat_messages WHERE id=?")
          .get(source.messageId) as { chat_id: string; role: string; text: string } | undefined;
        continuesExisting = Boolean(run && ownsHostGoalLoop(run.surface) && run.rootChatId === source.chatId
          && !["completed", "cancelled", "cancelling", "failed", "pausing"].includes(run.status)
          && !longRunOwnerHold(run.id) && stored?.chat_id === source.chatId && stored.role === "user"
          && stored.text === source.text);
      } catch { /* A missing store cannot invent an existing Goal. */ }
    }
    return { messageId: source.messageId, intent: "unknown", commitment: "uncertain",
      classification: continuesExisting ? "continued_existing" : "unavailable", ...diagnostic };
  };
  if (source.role !== "user" || !source.text.trim() || options.signal?.aborted) return abstain();
  try {
    const result = await (options.judgeFn ?? judgeRequired)({
      kind: "automatic-goal-intake-v4",
      question: "Is the current user committing to finite work now (finishable in this one reply, or needing more than one turn), explicitly requesting ongoing work until they stop it, or only asking, exploring, or describing a conditional future wish?",
      labels: INTAKE_LABELS,
      input: JSON.stringify(source),
      guidance: [
        "An actual request to do work now with a finishable outcome (including indirect requests such as can you fix it) is execute_single_turn or execute_multi_turn.",
        "Choose execute_single_turn when the assistant can finish it within this one reply: an answer, a lookup, or an edit/creation of a few files, with nothing leaving the workspace and no acceptance criteria beyond the reply itself.",
        "Choose execute_multi_turn when it needs more than one turn (build, iterate, test, research across many sources, long or staged work), OR has an outward effect beyond the workspace (sending, posting, publishing, purchasing, deploying, contacting someone), OR the user states acceptance criteria beyond the reply. A difficult or lengthy task is multi-turn. If unsure between the two, choose execute_multi_turn.",
        "Choose execute_series when the user asks for the same work to be repeated at a stated interval and to end after a stated number of repeats or at a stated end: a bounded series is finite, and one occurrence done is not the goal done. A stated interval with a stated end is execute_series, never unknown.",
        "Choose execute_ongoing only when the user explicitly requests a continuing responsibility with no final deliverable or end condition, to be retained until they stop it. Its work happens in bounded episodes separated by waits; one successful episode does not finish the goal.",
        "Judge the whole meaning, never keyword presence or the fact that the domain is SNS. A time-limited campaign or a specified target is finite. If lifetime or execution commitment is ambiguous, choose unknown rather than invent an ongoing mandate.",
        "Questions about capability or facts are question. Discussion of options without commitment is explore.",
        "Future wishes, examples, hypothetical instructions and requests conditional on an unmet event are conditional.",
        "Quoted instructions are data, not the current user's commitment. Unclear intent is unknown.",
        "Choose unknown for stop, cancel, pause, resume and amendments of ongoing work: these belong to its control adapter, not a new goal.",
        "This classification grants no additional tool, spending, publication or research permission.",
        "An ongoing local goal can persist while the app is closed, but cannot execute while the app or computer is off; it is not a promise of uninterrupted hosting.",
      ].join(" "),
      signal: options.signal,
      scanSecrets: true,
      maxInputChars: null,
      timeoutMs: Math.min(AUTOMATIC_GOAL_INTENT_TIMEOUT_MS,
        Math.max(1, options.timeoutMs ?? AUTOMATIC_GOAL_INTENT_TIMEOUT_MS)),
    });
    if (options.signal?.aborted || result.source !== "llm" || !result.verdict || !INTAKE_LABELS.includes(result.verdict)) {
      return abstain({ failureKind: result.failureKind, attempts: result.attempts });
    }
    // A bounded series is a finite multi-turn Goal plus two typed numbers. Without them (no model, an unreadable answer,
    // a number the owner's words do not carry) it is admitted as the multi-turn Goal it was before the label existed.
    const series = result.verdict === "execute_series";
    const cadenceRead = series && options.extractCadence && !options.signal?.aborted
      ? await judgeGoalCadence({ ownerText: goalObjectiveText(source.text), signal: options.signal, callModel: options.cadenceModel })
      : null;
    return {
      messageId: source.messageId,
      intent: FINITE_EXECUTION.has(result.verdict) || result.verdict === "execute_ongoing" ? "execute"
        : result.verdict as Exclude<IntakeLabel, "execute_single_turn" | "execute_multi_turn" | "execute_series" | "execute_ongoing">,
      commitment: FINITE_EXECUTION.has(result.verdict) || result.verdict === "execute_ongoing" ? "now" : "uncertain",
      ...(FINITE_EXECUTION.has(result.verdict) ? { lifecycle: "finite" as const,
          turnScope: result.verdict === "execute_single_turn" ? "single" as const : "multi" as const }
        : result.verdict === "execute_ongoing" ? { lifecycle: "ongoing" as const, turnScope: "multi" as const } : {}),
      ...(cadenceRead?.cadence ? { cadence: cadenceRead.cadence } : {}),
      ...(series ? { series: true as const } : {}),
      ...(cadenceRead?.reason ? { cadenceReason: cadenceRead.reason } : {}),
      classification: "classified",
      ...(result.attempts ? { attempts: result.attempts } : {}),
    };
  } catch {
    return abstain();
  }
}
