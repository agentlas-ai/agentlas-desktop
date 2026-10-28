import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeSelection } from "../../shared/types";
import { trackTurnActivity } from "./turn-activity";

type InvocationJudgmentContext = {
  selection?: RuntimeSelection;
  signal?: AbortSignal;
  /**
   * The runtime selection of the turn that started this work, kept when the work is detached from that turn
   * (outsideInvocationJudgmentContext). Never a judge pin and never an abort source: it only tells a judgment on the same
   * runtime which model the executor runs (system-agents/judgment-model.ts), so a pool member configured as "default model"
   * does not leave without one.
   */
  executorSelection?: RuntimeSelection;
};
const contexts = new AsyncLocalStorage<InvocationJudgmentContext>();

/** Nested selection/layout judgments belong to the invocation that requested them. */
export function withInvocationJudgmentContext<T>(selection: RuntimeSelection | undefined, signal: AbortSignal | undefined, run: () => T): T {
  const executor = selection ?? contexts.getStore()?.executorSelection;
  // Every invocation enters here: background measurement waits while any is running (turn-activity.ts).
  return trackTurnActivity(() => contexts.run({ selection: selection ? Object.freeze({ ...selection }) : undefined, signal,
    ...(executor ? { executorSelection: Object.freeze({ ...executor }) } : {}) }, run));
}

/** Called only after Main resolves or explicitly changes the current invocation's binding. */
export function bindInvocationJudgmentRuntime(selection: RuntimeSelection): void {
  const context = contexts.getStore();
  if (context) context.selection = context.executorSelection = Object.freeze({ ...selection });
}

export function invocationJudgmentContext(): Readonly<InvocationJudgmentContext> | undefined {
  return contexts.getStore();
}

/**
 * Run work that belongs to no invocation — a fire-and-forget review started from
 * inside a turn must not inherit that turn's worker pin or abort signal.
 */
export function outsideInvocationJudgmentContext<T>(run: () => T): T {
  const outer = contexts.getStore();
  const executor = outer?.selection ?? outer?.executorSelection;
  // No pin and no signal cross; only the executor's model choice does (see executorSelection).
  return executor ? contexts.run({ executorSelection: Object.freeze({ ...executor }) }, run) : contexts.exit(run);
}
