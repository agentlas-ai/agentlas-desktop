/*
 * Which Codex MCP approvals are for a call that cannot change anything. Codex asks its client to approve every MCP call it did not
 * judge read-only (its judgment is the tool's readOnlyHint), and our `agentlas-turn` tools carry none: harness_call is one gateway
 * for reads and effects alike. The arbiter (host-tool-permission-policy.ts) refuses or asks for a call it is told is mutating, so
 * in a read-permission turn (a woken One reviewing finished work) every internal read waited five minutes for a card nobody could
 * see and then came back "user rejected MCP tool call" (app.operations x3, one 300 s hang).
 *
 * This decides only the `mutating` flag, from the call's own arguments, and only for the server the run's own config names
 * `agentlas-turn`. It never allows anything by itself: a read still passes the arbiter's stored deny rules and plan mode. A call it
 * cannot read as a read keeps the old answer (mutating), so an unexpected shape, an oversized one or another server asks as before.
 */
export async function codexMcpCallIsMutating(call: { serverName: string; toolName: string; toolParams?: Record<string, unknown> }): Promise<boolean> {
  if (call.serverName !== "agentlas-turn") return true;
  try {
    if (call.toolName === "harness_call") {
      const { harnessCallIsEffectFreeRead } = await import("../harness/capability-ports");
      return !harnessCallIsEffectFreeRead(call.toolParams);
    }
    // harness_search / harness_describe (inert discovery), memory_note and ask_form: the same list the proxy path applies.
    const { mcpToolIsMutating } = await import("../mcp-tools/proxy-server");
    return mcpToolIsMutating({ catalogId: "agentlas-turn", toolName: call.toolName });
  } catch {
    return true;
  }
}
