import { beginAccountedInference, type AccountedInferenceAttempt } from "../long-run/accounting-context";

/** The typed sentinel recordLongRunInferenceStarted (store/long-runs.ts) throws when its own usage-start row cannot be matched. */
export const USAGE_START_SOURCE_MISMATCH = "long_run_usage_start_source_mismatch";

/**
 * beginAccountedInference for the callers whose inference must not depend on the Goal ledger's bookkeeping.
 *
 * Accounting is a ledger beside the model call, not a condition of it. The ledger refusing to open its own start row
 * (the host's usage-start source could not be matched back to what it just wrote) failed the whole turn before any model
 * call: observed in use, one Goal-wake tool selection ended "Could not prepare this run's tool connections
 * (long_run_usage_start_source_mismatch)". The transaction that threw rolled its start row back, so the inference simply
 * runs without a usage row (the same as a call outside any accounting scope) and the cause is logged by its machine code.
 *
 * Only that one bookkeeping sentinel degrades. The accounting fences that mean "this Goal must not spend more"
 * (accounting_goal_terminal, accounting_goal_owner_invalid) and every other failure still stop the call, as before.
 */
export function beginAccountedInferenceBestEffort(
  input: Parameters<typeof beginAccountedInference>[0],
  begin: typeof beginAccountedInference = beginAccountedInference,
): AccountedInferenceAttempt | null {
  try {
    return begin(input);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== USAGE_START_SOURCE_MISMATCH) throw error;
    console.warn(`[accounting] inference runs without a usage row (${USAGE_START_SOURCE_MISMATCH}, kind=${input.kind})`);
    return null;
  }
}
