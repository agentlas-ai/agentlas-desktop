import type { RunnerResult } from "./runner";

export const WORK_PROJECT_RESIDENCY_BUSY_CODE = "work_project_residency_busy";

/** A typed refusal raised before a runner dispatched any provider work. */
export function runnerRefusedBeforeDispatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === WORK_PROJECT_RESIDENCY_BUSY_CODE) return true;
  return (error as { turnDelivery?: unknown }).turnDelivery === "not-dispatched";
}

/** A returned failure proved to precede provider dispatch. */
export function runnerResultRefusedBeforeDispatch(result: Pick<RunnerResult, "failure" | "turnDelivery"> | null | undefined): boolean {
  return !!result?.failure && result.turnDelivery === "not-dispatched";
}
