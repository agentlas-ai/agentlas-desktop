import type { RuntimeKind } from "../../shared/types";
import type { ToolInvocationOrigin } from "../../shared/tool-invocation-origin";
import { pluginSlugForToolId } from "../plugins/builtin";
import { isDedicatedPluginToolLaunch } from "../plugins/tool-provider";
import { preparedMcpBindings } from "../mcp-tools/prepared-transport";

const NATIVE_CLI_RUNTIME_KINDS = new Set<RuntimeKind>([
  "claude-code", "codex", "antigravity", "kimi", "grok", "cursor",
]);

function nativeProviderName(kind: RuntimeKind, backendLabel?: string): string {
  const label = backendLabel?.trim();
  return label && label.length <= 160 ? label : kind;
}

/**
 * Resolve provenance only from the exact active runtime and Main-sealed MCP
 * bindings. Provider prose and renderer-visible names are never authorities.
 */
export function resolveToolInvocationOrigin(input: {
  toolName: string;
  runtimeKind: RuntimeKind;
  backendLabel?: string;
  mcpConfigPath?: string;
  /** Set only by a Main dispatcher after it resolved the executable. */
  dispatchedOrigin?: ToolInvocationOrigin;
}): ToolInvocationOrigin {
  const toolName = input.toolName.trim();
  if (
    input.dispatchedOrigin?.kind === "agentlas"
    && input.dispatchedOrigin.providerName === "Agentlas"
    && input.dispatchedOrigin.toolName === toolName
  ) {
    return { ...input.dispatchedOrigin, runtimeKind: input.runtimeKind };
  }
  if (input.mcpConfigPath) {
    try {
      for (const binding of preparedMcpBindings(input.mcpConfigPath)) {
        // Claude/ACP runners expose `mcp__server__tool`; Codex exec and
        // app-server expose `server.tool`. Both server keys come from this
        // exact sealed binding, so neither form relies on a display-name
        // guess. A bare envelope such as `mcp_tool_call` stays unknown.
        const prefixes = [`mcp__${binding.configKey}__`, `${binding.configKey}.`];
        const prefix = prefixes.find((candidate) => (
          toolName.startsWith(candidate) && toolName.length > candidate.length
        ));
        if (!prefix) continue;
        const serverToolName = toolName.slice(prefix.length);
        const agentlasPlugin = Boolean(
          binding.server.catalogId && pluginSlugForToolId(binding.server.catalogId),
        ) || isDedicatedPluginToolLaunch(binding.server);
        return {
          kind: agentlasPlugin ? "agentlas-plugin" : "mcp",
          providerName: binding.server.nameEn || binding.server.name,
          toolName: serverToolName,
          runtimeKind: input.runtimeKind,
        };
      }
    } catch {
      // An absent/obsolete seal cannot prove an MCP or plugin origin.
    }
  }

  const mcpShaped = /^mcp(?:__|[\s_.-]*tool[\s_.-]*call$)/iu.test(toolName)
    || /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(toolName);
  if (NATIVE_CLI_RUNTIME_KINDS.has(input.runtimeKind) && !mcpShaped) {
    return {
      kind: "cli",
      providerName: nativeProviderName(input.runtimeKind, input.backendLabel),
      toolName,
      runtimeKind: input.runtimeKind,
    };
  }

  return {
    kind: "unknown",
    providerName: nativeProviderName(input.runtimeKind, input.backendLabel),
    toolName,
    runtimeKind: input.runtimeKind,
  };
}
