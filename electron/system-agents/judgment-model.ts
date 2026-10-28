import path from "node:path";
import os from "node:os";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { cliConfiguredDefaultModel } from "../runtime/cli-default-model";

/*
 * Which model a judgment call carries — one rule for every judgment route (the invocation's pin, the configured
 * orchestrator pool, a pin's pool fallback, the tool judge's borrowed runtime: all go through callJudgmentModelDetailed).
 *
 * Finance validation 2026-10-28 (codex gpt-6.1-terra, isolated app): 7 judgment calls left with no model and failed
 * `codex_no_tools_model_required` before anything was sent, 5 others on the same runtime carried gpt-6.1-terra and
 * answered. The failing ones came through the configured orchestrator pool (the owner-answer classifier,
 * goal-owner-amendment.ts, and the other selectionPolicy judges): the pool member was codex with "default model", the app had
 * no remembered codex model, and the codex no-tools gateway refuses a call that does not name the model it must pin. The
 * owner's answers then read judge_unavailable:unsupported.
 *
 * Order, first that names a model:
 *   1. the candidate's own model (its selection, or the runtime's detected/remembered one);
 *   2. the executor's current choice on the same runtime — the turn that started this work (judgment-context.ts
 *      executorSelection, kept when a review is detached from the turn): the model the owner is running right now;
 *   3. the model the CLI itself will use by its own configuration file (codex: CODEX_HOME/config.toml; claude-code:
 *      ~/.claude/settings.json) — read, never guessed.
 * A runtime whose judgment transport cannot run without a model and still has none is skipped before dispatch with the
 * typed code below, so the next pool member can judge and nothing is spent on a call that would be refused.
 */
export const JUDGMENT_MODEL_UNRESOLVED = "judgment_model_unresolved";

/** Runtimes whose no-tools judgment transport refuses a call that names no model (runtime/codex-no-tools.ts runCodexNoTools). */
export const NO_TOOLS_JUDGMENT_MODEL_REQUIRED: ReadonlySet<string> = new Set(["codex"]);

export type JudgmentModelSource = "selection" | "executor" | "cli_config" | "none";

function sameRuntime(runtime: Pick<RuntimeStatus, "kind" | "backend" | "acpAgentId">, selection: RuntimeSelection): boolean {
  if (selection.kind !== runtime.kind) return false;
  if (selection.backend && runtime.backend && selection.backend !== runtime.backend) return false;
  if (runtime.kind === "acp" && (selection.acpAgentId ?? null) !== (runtime.acpAgentId ?? null)) return false;
  return true;
}

export function cliConfiguredJudgmentModel(kind: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
  if (kind === "codex") {
    const codexHome = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    return cliConfiguredDefaultModel("codex", home, codexHome);
  }
  if (kind === "claude-code") return cliConfiguredDefaultModel("claude-code", home);
  return undefined;
}

export function resolveJudgmentModel(
  runtime: Pick<RuntimeStatus, "kind" | "backend" | "acpAgentId" | "model">,
  executor: RuntimeSelection | undefined,
  configured: (kind: string) => string | undefined = (kind) => cliConfiguredJudgmentModel(kind),
): { model?: string; source: JudgmentModelSource } {
  const own = runtime.model?.trim();
  if (own) return { model: own, source: "selection" };
  const inherited = executor && sameRuntime(runtime, executor) ? executor.model?.trim() : undefined;
  if (inherited) return { model: inherited, source: "executor" };
  const fromCli = configured(runtime.kind)?.trim();
  if (fromCli) return { model: fromCli, source: "cli_config" };
  return { source: "none" };
}

/** The runtime this judgment attempt dispatches: the same runtime, carrying the resolved model. */
export function withJudgmentModel<T extends Pick<RuntimeStatus, "kind" | "backend" | "acpAgentId" | "model">>(runtime: T,
  executor: RuntimeSelection | undefined, configured?: (kind: string) => string | undefined): T {
  const resolved = resolveJudgmentModel(runtime, executor, configured);
  return resolved.model && resolved.model !== runtime.model ? { ...runtime, model: resolved.model } : runtime;
}

/** A no-tools judgment on this runtime would be refused for want of a model: skip it before dispatch. */
export function judgmentModelMissing(runtime: Pick<RuntimeStatus, "kind" | "model">, requiresNoTools: boolean): boolean {
  return requiresNoTools && NO_TOOLS_JUDGMENT_MODEL_REQUIRED.has(runtime.kind) && !runtime.model?.trim();
}
