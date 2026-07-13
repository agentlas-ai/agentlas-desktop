import {
  MAX_BUILD_SYSTEM_PROMPT_CHARS,
  type Runner,
  type RunnerEvents,
  type RunnerRequest,
  type RunnerResult,
} from "../runtime/runner";
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
    const result = await input.runner(input.makeRequest(input.attachment), trackedEvents);
    return { result, attachment: input.attachment, retryReceipt: null };
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
    const degradedGuard = replacement
      ? [
          "",
          "## Main-authoritative MCP degraded server guard",
          "One failed MCP server was removed. Use only the attached approved same-capability fallback and other attached MCPs.",
          "Do not claim that the removed server itself completed any action.",
        ].join("\n")
      : [
          "",
          "## Main-authoritative MCP degraded capability guard",
          `Unavailable capability: ${capability}.`,
          "The failed MCP was removed before this retry. Do not call it, simulate its external side effect, or claim that side effect completed.",
          "Continue only unaffected work. Mark any output that depends on this capability as unavailable.",
          recovered.receipt.emptyMode
            ? "No MCP is attached in this retry; all MCP-dependent side effects are unavailable."
            : "Other attached MCP capabilities remain available.",
        ].join("\n");
    if (retryRequest.systemPrompt.length + degradedGuard.length > MAX_BUILD_SYSTEM_PROMPT_CHARS) throw error;
    retryRequest.systemPrompt += degradedGuard;
    const result = await input.runner(retryRequest, input.events);
    return { result, attachment: recovered, retryReceipt };
  }
}
