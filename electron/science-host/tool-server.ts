import type { HostToolServer } from "../mcp-tools/host-tool-servers";

/*
 * Science on the shared tool chain (PLAN S2, docs/2026-10-28-science-harness-unify). A Science author turn no longer
 * replaces the turn's MCP config with the Science grant: Science mints its tool server here and mcp/client.ts builds the
 * ordinary per-turn config (auto-select, the Main approval arbiter, the codex-desktop-surface home, the lazy menu, code
 * mode, harness_search) with that server beside the others.
 *
 * Compatibility: the pinned Science build decides. A build without mintScienceToolServer returns null here and the turn
 * keeps the Science grant (the old path). A build with it never falls back: its prompts name the shared surface (this host
 * advertises execution.commonToolServer in install.ts), so a turn that cannot mint fails with the typed error instead of
 * running against a catalogue its prompt does not describe.
 */

type ScienceTurnContext = { projectId: string; conversationId: string; turnId: string; invocationRunId: string; [key: string]: unknown };

interface ScienceToolServerWire {
  schema: "agentlas.science-tool-server/v1";
  configKey: string;
  command: string;
  args: string[];
  publicEnv: Record<string, string>;
  secretEnv: Record<string, string>;
  declarations: Array<{ name: string; description: string; group: { id: string; label: string }; fields: string[]; artifactKinds: string[]; effect: "read" | "effect" }>;
  firstList: { names: string[]; reasons: unknown[] };
  sessionScoped: boolean;
  supersedesPlugins?: string[];
  isCurrent(): boolean;
}

export interface ScienceHostToolServer extends HostToolServer {
  readonly sessionScoped: boolean;
  /** Why each non-core tool is in the first list (project field / Lab binding), for the run record. */
  readonly firstListReasons: readonly unknown[];
}

/** The pinned Science build's mint, or null for a build that predates the shared tool chain. */
export async function scienceToolServerMint(): Promise<((context: ScienceTurnContext, request: { runtimeKind: string; cwd: string }) => Promise<ScienceToolServerWire>) | null> {
  const science = await import("agentlas-science") as unknown as { mintScienceToolServer?: unknown };
  return typeof science.mintScienceToolServer === "function"
    ? science.mintScienceToolServer as (context: ScienceTurnContext, request: { runtimeKind: string; cwd: string }) => Promise<ScienceToolServerWire>
    : null;
}

export async function mintScienceHostToolServer(context: ScienceTurnContext, request: { runtimeKind: string; cwd: string }): Promise<ScienceHostToolServer | null> {
  const mint = await scienceToolServerMint();
  if (!mint) return null;
  const wire = await mint(context, request);
  if (!wire || wire.schema !== "agentlas.science-tool-server/v1" || typeof wire.isCurrent !== "function") throw new Error("science_tool_server_invalid");
  return Object.freeze({
    configKey: wire.configKey, name: "Agentlas Science", command: wire.command, args: Object.freeze([...wire.args]),
    publicEnv: Object.freeze({ ...wire.publicEnv }), secretEnv: Object.freeze({ ...wire.secretEnv }),
    declarations: Object.freeze(wire.declarations.map((tool) => Object.freeze({ ...tool, group: { ...tool.group },
      fields: Object.freeze([...tool.fields]), artifactKinds: Object.freeze([...tool.artifactKinds]) }))),
    firstList: Object.freeze([...wire.firstList.names]),
    supersedesPlugins: Object.freeze([...(wire.supersedesPlugins ?? [])]),
    isCurrent: () => wire.isCurrent(),
    sessionScoped: wire.sessionScoped === true,
    firstListReasons: Object.freeze([...wire.firstList.reasons]),
  });
}
