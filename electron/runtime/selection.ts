import type { AgentRuntimeOverride, RuntimeStatus } from "../../shared/types";
import { findAgentRuntimeOverride, type RuntimeOverrideTarget } from "../store/agent-runtime-overrides";
import { runAnthropicByok, runCustomByok, runGoogleByok, runOpenAIByok, runUpstageByok } from "./byok";
import { runClaudeCode } from "./claude-code";
import { runCodex } from "./codex";
import { runGemini } from "./gemini";
import { runGrok } from "./grok";
import { runOllama } from "./ollama";
import type { Runner } from "./runner";

const RUNNER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  grok: "Grok CLI",
  "byok:anthropic": "Anthropic API",
  "byok:openai": "OpenAI API",
  "byok:google": "Google API",
  "byok:upstage": "Upstage Solar API",
  "byok:custom": "Custom OpenAI API",
};

export interface RuntimeChoice {
  active: RuntimeStatus;
  picked: { runner: Runner; label: string } | null;
  override: AgentRuntimeOverride | null;
  unavailableOverride: AgentRuntimeOverride | null;
}

export function pickRunner(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (active.kind === "claude-code") return { runner: runClaudeCode, label: RUNNER_LABEL["claude-code"] };
  if (active.kind === "codex") return { runner: runCodex, label: RUNNER_LABEL.codex };
  if (active.kind === "gemini") return { runner: runGemini, label: RUNNER_LABEL.gemini };
  if (active.kind === "grok")
    return { runner: runGrok, label: `Grok CLI${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "ollama")
    return { runner: runOllama, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "byok") {
    if (active.backend === "anthropic")
      return { runner: runAnthropicByok, label: RUNNER_LABEL["byok:anthropic"] };
    if (active.backend === "openai")
      return { runner: runOpenAIByok, label: RUNNER_LABEL["byok:openai"] };
    if (active.backend === "google")
      return { runner: runGoogleByok, label: RUNNER_LABEL["byok:google"] };
    if (active.backend === "upstage")
      return { runner: runUpstageByok, label: RUNNER_LABEL["byok:upstage"] };
    if (active.backend === "custom")
      return { runner: runCustomByok, label: RUNNER_LABEL["byok:custom"] };
  }
  return null;
}

export function pickActive(list: RuntimeStatus[]): RuntimeStatus | null {
  return list.find((r) => r.active) ?? list[0] ?? null;
}

function runtimeMatchesOverride(runtime: RuntimeStatus, override: AgentRuntimeOverride): boolean {
  const selection = override.selection;
  if (runtime.kind !== selection.kind) return false;
  if (selection.backend && runtime.backend !== selection.backend) return false;
  return true;
}

export function applyRuntimeOverride(
  runtime: RuntimeStatus,
  override: AgentRuntimeOverride,
): RuntimeStatus {
  return {
    ...runtime,
    active: true,
    source: override.selection.source ?? runtime.source,
    model:
      override.selection.model !== undefined
        ? override.selection.model
        : runtime.model,
    longContextEnabled:
      override.selection.longContext !== undefined
        ? override.selection.longContext
        : runtime.longContextEnabled,
    effort:
      override.selection.effort !== undefined
        ? override.selection.effort
        : runtime.effort,
  };
}

export function selectRuntimeForTargets(
  runtimes: RuntimeStatus[],
  targets: RuntimeOverrideTarget[],
): RuntimeChoice | null {
  const override = findAgentRuntimeOverride(targets);
  if (override) {
    const matched = runtimes.find((runtime) => runtimeMatchesOverride(runtime, override));
    if (matched) {
      const active = applyRuntimeOverride(matched, override);
      return { active, picked: pickRunner(active), override, unavailableOverride: null };
    }
  }

  const active = pickActive(runtimes);
  if (!active) return null;
  return {
    active,
    picked: pickRunner(active),
    override: null,
    unavailableOverride: override ?? null,
  };
}
