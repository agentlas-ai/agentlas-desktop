// Hand the embedded Agentlas OS runtime (Python) a way to judge by meaning using
// THIS desktop's connected model. The OS engine is BYOC — it never calls a model
// on its own — so its resident judge (content-guard, pipeline, research, privacy)
// only decides when the host supplies a reachable endpoint via AGENTLAS_JUDGE_RUNTIME.
//
// Local HTTP runtimes (Ollama / LM Studio / MLX) expose an endpoint the OS process
// can call directly, so those are wired here with no credentials and no hardcoded
// model — the user's own active model is used. CLI subscriptions and networked
// BYOK providers are handled by the desktop's own in-process judge for the app's
// own decisions; for OS sub-operations under those runtimes the OS side reports
// the honest "connect a model" outcome rather than keyword-deciding.

import type { RuntimeStatus } from "../../shared/types";

/** OpenAI-compatible local servers speak /v1/chat/completions. */
const OPENAI_COMPAT_LOCAL = new Set(["lmstudio", "mlx"]);

const LOCAL_ENDPOINTS: Record<string, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234/v1",
  mlx: "http://127.0.0.1:8080/v1",
};

export interface OsJudgeRuntimeConfig {
  kind: "ollama" | "openai-compatible";
  endpoint: string;
  model: string;
}

/**
 * Build the AGENTLAS_JUDGE_RUNTIME value for a spawned OS runtime, or null when
 * the active runtime is one the OS process cannot reach on its own (CLI /
 * networked BYOK). Never returns a hardcoded model — it carries the user's own
 * active model id.
 */
export function osJudgeRuntimeConfig(active: RuntimeStatus | null): OsJudgeRuntimeConfig | null {
  if (!active || !active.model) return null;
  if (active.kind === "ollama") {
    return { kind: "ollama", endpoint: LOCAL_ENDPOINTS.ollama, model: active.model };
  }
  if (OPENAI_COMPAT_LOCAL.has(active.kind)) {
    return { kind: "openai-compatible", endpoint: LOCAL_ENDPOINTS[active.kind], model: active.model };
  }
  return null;
}

/** Serialize for the child env, or undefined to leave AGENTLAS_JUDGE_RUNTIME unset. */
export function osJudgeRuntimeEnvValue(active: RuntimeStatus | null): string | undefined {
  const config = osJudgeRuntimeConfig(active);
  return config ? JSON.stringify(config) : undefined;
}
