/*
 * Which Codex MCP approvals are for a call that cannot change anything. Codex asks its client to approve every MCP call it did not
 * judge read-only (its judgment is the tool's readOnlyHint), and our `agentlas-turn` tools carry none: harness_call is one gateway
 * for reads and effects alike. The arbiter (host-tool-permission-policy.ts) refuses or asks for a call it is told is mutating, so
 * in a read-permission turn (a woken One reviewing finished work) every internal read waited five minutes for a card nobody could
 * see and then came back "user rejected MCP tool call" (Hope, -23:44: app.operations x3, one 300 s hang).
 *
 * This decides only the `mutating` flag, from the call's own arguments, and only for the server the run's own config names
 * `agentlas-turn`. It never allows anything by itself: a read still passes the arbiter's stored deny rules and plan mode. A call it
 * cannot read as a read keeps the old answer (mutating), so an unexpected shape, an oversized one or another server asks as before.
 */
export async function codexMcpCallIsMutating(call: { serverName: string; toolName: string; toolParams?: Record<string, unknown> }): Promise<boolean> {
  // A connected app on the server (agentlas-server-apps): a tool the stored list marked as a read is one (harness/host-call-ticket.ts); every other is a change.
  if (call.serverName === "agentlas-server-apps") return !(await import("../harness/host-call-ticket")).hostToolIsRead(call.serverName, call.toolName);
  if (call.serverName !== "agentlas-turn") return true;
  try {
    if (call.toolName === "harness_call") {
      const { harnessCallIsEffectFreeRead } = await import("../harness/capability-ports");
      return !harnessCallIsEffectFreeRead(call.toolParams);
    }
    // harness_search / harness_describe (inert discovery), memory_ticket (memory_note) and ask_form: the same list the proxy path applies.
    const { mcpToolIsMutating } = await import("../mcp-tools/proxy-server");
    return mcpToolIsMutating({ catalogId: "agentlas-turn", toolName: call.toolName });
  } catch {
    return true;
  }
}

/**
 * The gateway tool of a `tool.call`: `agentlas-turn` / `harness_call` with the operation named in its own arguments. The port asks the connector tool's own rule right after, so the
 * generic card Codex's MCP approval would raise for the gateway is left to it. The operation is read from the structured argument, never from text.
 */
export function codexMcpCallIsToolCall(call: { serverName: string; toolName: string; toolParams?: Record<string, unknown> }): boolean {
  return call.serverName === "agentlas-turn" && call.toolName === "harness_call" && call.toolParams?.operation === "tool.call";
}

/**
 * The identity the approval rule reads for a Codex MCP call (defect 8). Codex reports only the server's name, and a name
 * is anybody's: the person's own Codex config can declare a server called `one-team`. The run's own `-c mcp_servers.<name>.*`
 * arguments are the names Main itself bound for this run, so only those are Main's servers (identity = the name); any other name is
 * not Main's and carries a marker that no registered identity can equal.
 */
export function codexMcpServerIdentity(serverName: string, mcpCodexConfigArgs: readonly string[] | undefined): string {
  const bound = new Set((mcpCodexConfigArgs ?? []).flatMap((arg) => {
    const match = /^mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\./.exec(arg);
    return match ? [match[1]!.replace(/^"|"$/g, "")] : [];
  }));
  return bound.has(serverName) ? serverName : `external:${serverName}`;
}
