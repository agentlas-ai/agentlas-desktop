import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeSelection } from "../../shared/types";

type InvocationJudgmentContext = { selection?: RuntimeSelection; signal?: AbortSignal };
const contexts = new AsyncLocalStorage<InvocationJudgmentContext>();

/** Nested selection/layout judgments belong to the invocation that requested them. */
export function withInvocationJudgmentContext<T>(selection: RuntimeSelection | undefined, signal: AbortSignal | undefined, run: () => T): T {
  return contexts.run({ selection: selection ? Object.freeze({ ...selection }) : undefined, signal }, run);
}

/** Called only after Main resolves or explicitly changes the current invocation's binding. */
export function bindInvocationJudgmentRuntime(selection: RuntimeSelection): void {
  const context = contexts.getStore();
  if (context) context.selection = Object.freeze({ ...selection });
}

export function invocationJudgmentContext(): Readonly<InvocationJudgmentContext> | undefined {
  return contexts.getStore();
}
