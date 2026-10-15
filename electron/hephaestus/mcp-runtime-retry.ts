import {
  MAX_BUILD_SYSTEM_PROMPT_CHARS,
  type Runner,
  type RunnerEvents,
  type RunnerRequest,
  type RunnerResult,
} from "../runtime/runner";
import type { DeclaredPromptPart } from "../runtime/prompt-order";
import { composeTracedPrompt, restoreTracedPrompt } from "../runtime/prompt-composition-trace";
import type { ResolvedMcpBuildAttachment } from "../mcp-tools/attachment-resolver";
import { containsMcpStartupTransportFatal } from "../runtime/mcp-startup-fatal";

export interface BuildMcpRuntimeRetryReceipt {
  failedCandidateId: string;
  replacementCandidateId: string | null;
  unavailableCapability: string | null;
  emptyMcpMode: boolean;
  retryCount: 1;
}

export interface BuildRunnerWithMcpRecoveryResult {
  result: RunnerResult;
  attachment: ResolvedMcpBuildAttachment | undefined;
  retryReceipt: BuildMcpRuntimeRetryReceipt | null;
  prompt: Pick<RunnerRequest, "systemPrompt" | "systemPromptComposition">;
}

function fatalMcpSegments(message: string): string[] {
  if (!/^(?:codex|claude) CLI exit\s+\d+/i.test(message.trim())) return [];
  const segments: string[] = [];
  const lower = message.toLowerCase();
  let cursor = 0;
  while (cursor < lower.length) {
    const index = lower.indexOf("mcp", cursor);
    if (index < 0) break;
    const segment = message.slice(Math.max(0, index - 80), Math.min(message.length, index + 360));
    if (containsMcpStartupTransportFatal(segment)) {
      segments.push(segment);
    }
    cursor = index + 3;
  }
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns a candidate only for a CLI-fatal MCP startup/transport error that
 * names exactly one serialized config key. Ambiguity is a hard no-retry.
 */
export function classifySingleMcpRuntimeFatal(
  error: unknown,
  attachment: ResolvedMcpBuildAttachment | undefined,
): string | null {
  if (!attachment?.config || attachment.runtimeBindings.length === 0) return null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const segments = fatalMcpSegments(message);
  if (segments.length === 0) return null;
  const matched = new Set<string>();
  for (const binding of attachment.runtimeBindings) {
    const key = escapeRegExp(binding.configKey);
    const keyPattern = new RegExp(`(?:mcp_servers[.:]|mcp__)?${key}(?![a-z0-9_-])`, "i");
    if (segments.some((segment) => keyPattern.test(segment))) matched.add(binding.candidateId);
  }
  return matched.size === 1 ? [...matched][0] : null;
}

/**
 * Runs at most twice. The retry is allowed only before any assistant output,
 * token usage, thinking, or tool event proves that task work started.
 */
export async function runBuildRunnerWithMcpRecovery(input: {
  runner: Runner;
  attachment?: ResolvedMcpBuildAttachment;
  makeRequest: (attachment?: ResolvedMcpBuildAttachment) => RunnerRequest;
  events: RunnerEvents;
  signal: AbortSignal;
  onRetry?: (receipt: BuildMcpRuntimeRetryReceipt) => void;
}): Promise<BuildRunnerWithMcpRecoveryResult> {
  let executionObserved = false;
  const trackedEvents: RunnerEvents = {
    ...input.events,
    onPartial: (chunk) => {
      if (chunk.trim()) executionObserved = true;
      input.events.onPartial(chunk);
    },
    onTool: (name, args, result, id, isError) => {
      executionObserved = true;
      input.events.onTool?.(name, args, result, id, isError);
    },
    onUsage: (tokens) => {
      if (tokens > 0) executionObserved = true;
      input.events.onUsage?.(tokens);
    },
    onThinking: (phase, durationMs) => {
      executionObserved = true;
      input.events.onThinking?.(phase, durationMs);
    },
  };

  try {
    const initialRequest = input.makeRequest(input.attachment);
    const result = await input.runner(initialRequest, trackedEvents);
    return { result, attachment: input.attachment, retryReceipt: null, prompt: { systemPrompt: initialRequest.systemPrompt, systemPromptComposition: initialRequest.systemPromptComposition } };
  } catch (error) {
    if (input.signal.aborted || executionObserved) throw error;
    const failedCandidateId = classifySingleMcpRuntimeFatal(error, input.attachment);
    if (!failedCandidateId || !input.attachment?.recoverRuntimeFailure) throw error;
    let recovered: ResolvedMcpBuildAttachment | null = null;
    try {
      recovered = await input.attachment.recoverRuntimeFailure(failedCandidateId);
    } catch {
      // Recovery is a fail-closed eligibility check. Preserve the original
      // runner failure instead of replacing it with resolver diagnostics.
      throw error;
    }
    if (!recovered) throw error;
    const failed = input.attachment.receipt.attached.find((item) => item.candidateId === failedCandidateId);
    const replacement = failed && recovered.receipt.attached.find((item) =>
      item.fallbackGroup === failed.fallbackGroup && item.candidateId !== failedCandidateId);
    if (!failed || recovered.receipt.attached.some((item) => item.candidateId === failedCandidateId)) {
      throw error;
    }
    const retryReceipt: BuildMcpRuntimeRetryReceipt = {
      failedCandidateId,
      replacementCandidateId: replacement?.candidateId ?? null,
      unavailableCapability: replacement ? null : failed.capability,
      emptyMcpMode: recovered.receipt.emptyMode,
      retryCount: 1,
    };
    input.onRetry?.(retryReceipt);
    const retryRequest = input.makeRequest(recovered);
    const capability = failed.capability.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "unknown";
    // The original provider has not started work. Only the verified host parts
    // are recomposed; no permission, attachment or retry eligibility is minted here.
    if (!retryRequest.systemPromptComposition) throw error;
    let sourceParts: readonly DeclaredPromptPart[];
    try { sourceParts = restoreTracedPrompt(retryRequest.systemPrompt, retryRequest.systemPromptComposition); }
    catch { throw error; }
    const degradedParts: DeclaredPromptPart[] = replacement ? [{
      id: "build.mcp-degraded.replacement-policy", revision: 1, stability: "fixed-policy",
      changeTriggers: ["release", "tool-grant", "validation-result"],
      text: "## Main-authoritative MCP degraded server guard\nremoved: one failed MCP server; use only the attached same-capability fallback and other attached MCPs; never claim the removed server completed an action",
    }] : [{
      id: "build.mcp-degraded.unavailable-policy", revision: 1, stability: "fixed-policy",
      changeTriggers: ["release", "tool-grant", "validation-result"],
      text: "## Main-authoritative MCP degraded capability guard\ncontinue: unaffected work only; mark dependent output unavailable",
    }, {
      id: "build.mcp-degraded.inventory", revision: 1, stability: "configuration",
      changeTriggers: ["connector-inventory", "tool-grant", "validation-result"],
      text: recovered.receipt.emptyMode
        ? "mcp: none attached; all MCP-dependent side effects unavailable"
        : "mcp: other attached capabilities remain available",
    }, {
      id: "build.mcp-degraded.capability", revision: 1, stability: "turn-context",
      changeTriggers: ["tool-grant", "validation-result"],
      text: `unavailable capability: ${capability} (removed before retry; do not call it, simulate its side effect, or claim it completed)`,
    }];
    const retryComposition = composeTracedPrompt([...sourceParts, ...degradedParts]);
    const retryPrompt = retryComposition.text;
    if (retryPrompt.length > MAX_BUILD_SYSTEM_PROMPT_CHARS) throw error;
    retryRequest.systemPromptComposition = retryComposition.composition;
    retryRequest.systemPrompt = retryPrompt;
    const result = await input.runner(retryRequest, input.events);
    return { result, attachment: recovered, retryReceipt, prompt: { systemPrompt: retryRequest.systemPrompt, systemPromptComposition: retryRequest.systemPromptComposition } };
  }
}
