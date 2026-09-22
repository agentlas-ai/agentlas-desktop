import type { RuntimeSelection } from "../../shared/types";

/**
 * A capability receipt for a judgment call.  This is deliberately narrower
 * than a runner's permission label: `read` does not prove that the provider
 * exposed no native tools.
 */
export interface JudgmentCapabilityReceipt {
  schemaVersion: "agentlas.judgment-capability.v1";
  requirement: "no_tools";
  status: "verified" | "unsupported" | "unknown";
  enforcement: "claude_safe_mode" | "main_tool_payload_omitted" | "unsupported" | "unknown";
  reason: string;
}

/**
 * Return the capability that the current Agentlas adapter can honestly claim.
 *
 * This is an adapter contract, not a provider/model reputation list.  BYOK and
 * local OpenAI-compatible runners share `runLocalOpenAiChat`, which omits the
 * `tools` field and does not inspect or dispatch tools when `untrustedNoTools`
 * is set. Claude has an explicit `--safe-mode --tools ""` path. Other runners
 * stay fail-closed until their native tool inventory is independently proved.
 */
export function inspectJudgmentCapability(
  selection: Pick<RuntimeSelection, "kind" | "backend">,
  requirement: "no_tools" = "no_tools",
): JudgmentCapabilityReceipt {
  if (requirement !== "no_tools") {
    return {
      schemaVersion: "agentlas.judgment-capability.v1",
      requirement: "no_tools",
      status: "unknown",
      enforcement: "unknown",
      reason: "judgment_capability_requirement_unknown",
    };
  }

  if (selection.kind === "claude-code") {
    return {
      schemaVersion: "agentlas.judgment-capability.v1",
      requirement: "no_tools",
      status: "verified",
      enforcement: "claude_safe_mode",
      reason: "claude_safe_mode_disables_native_tools_and_mcp",
    };
  }

  if (selection.kind === "byok"
    || selection.kind === "lmstudio"
    || selection.kind === "mlx"
    || selection.kind === "agentlas-local") {
    return {
      schemaVersion: "agentlas.judgment-capability.v1",
      requirement: "no_tools",
      status: "verified",
      enforcement: "main_tool_payload_omitted",
      reason: "main_tool_loop_omits_tools_and_dispatch_when_untrusted",
    };
  }

  if (["codex", "antigravity", "acp", "kimi", "grok", "cursor", "ollama"].includes(selection.kind)) {
    return {
      schemaVersion: "agentlas.judgment-capability.v1",
      requirement: "no_tools",
      status: "unsupported",
      enforcement: "unsupported",
      reason: `${selection.kind}_native_no_tools_not_release_verified`,
    };
  }

  return {
    schemaVersion: "agentlas.judgment-capability.v1",
    requirement: "no_tools",
    status: "unknown",
    enforcement: "unknown",
    reason: `${selection.kind}_native_no_tools_capability_unknown`,
  };
}

export function isVerifiedJudgmentCapability(
  selection: Pick<RuntimeSelection, "kind" | "backend">,
  requirement: "no_tools" = "no_tools",
): boolean {
  return inspectJudgmentCapability(selection, requirement).status === "verified";
}
