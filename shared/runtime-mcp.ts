// The one list of "which runtime can actually receive MCP" — same discipline as
// runtime-kinds.ts / runtime-backends.ts.
//
// ★Why this file exists. Two hand-maintained copies answered the same question
// and disagreed:
//   · electron/mcp/client.ts decided whether to build an MCP config at all,
//   · electron/mcp-tools/attachment-resolver.ts decided whether a candidate
//     server could be attached during a build.
// Both listed {claude-code, codex, grok, ollama, lmstudio, mlx} by hand. When
// the ACP runner learned to translate our config into `session/new.mcpServers`,
// neither list learned about it: `cursor`, `kimi` and the open `acp` seat were
// left without an mcpConfigPath, readMcpConfig() returned null, and those runs
// still started with `mcpServers: []` — the exact failure the ACP work was
// meant to end. Only `grok` benefited, because it happened to already be in the
// hand-written set.
//
// Every MCP-capability question now derives from the table below, and the
// Record<RuntimeKind, …> shape makes a new runtime kind a compile error until
// someone answers this question for it.
import type { McpTransport, RuntimeKind } from "./types";

/** How the runtime is handed its MCP servers. Each path is real, verified code. */
export type RuntimeMcpDelivery =
  /** `--mcp-config` / config overrides on the vendor CLI (claude-code, codex). */
  | "cli-mcp-config"
  /** ACP `session/new.mcpServers` (electron/runtime/acp.ts). */
  | "acp-session-new"
  /** Our own in-process OpenAI tool loop (electron/runtime/local-tool-loop.ts). */
  | "in-process-loop"
  /**
   * Per-run add/remove against the CLI's own persistent config (grok's
   * `grok mcp add/remove --scope project`, antigravity's
   * `~/.gemini/config/mcp_config.json`). We add approved servers before the
   * run and remove only the keys we added afterwards.
   */
  | "config-reconcile";

export interface RuntimeMcpSupport {
  delivery: RuntimeMcpDelivery;
  /**
   * Transports beyond stdio. `"negotiated"` = the wire format represents them,
   * but the peer decides per session — the ACP runner reads
   * `agentCapabilities.mcpCapabilities` and says out loud (status line) which
   * servers it had to drop, so we never silently pretend a server was attached.
   */
  extraTransports: readonly McpTransport[] | "negotiated";
  /** Why we believe it. A row without evidence has no business being here. */
  evidence: string;
}

/**
 * `null` means "cannot receive MCP" — and the row must say why, so the next
 * person does not have to re-derive it from an empty grep.
 */
export const RUNTIME_MCP_SUPPORT: Record<RuntimeKind, RuntimeMcpSupport | null> = {
  "claude-code": {
    delivery: "cli-mcp-config",
    extraTransports: ["sse", "http"],
    evidence: "electron/runtime/claude-code.ts passes --mcp-config; the CLI reads every transport in that file",
  },
  codex: {
    delivery: "cli-mcp-config",
    // Remote URL/header variants stay out until the CLI can represent them
    // without leaking a credential through argv.
    extraTransports: [],
    evidence: "electron/runtime/codex.ts serializes stdio servers as -c overrides; url/header variants would put credentials in argv",
  },
  grok: {
    delivery: "acp-session-new",
    extraTransports: "negotiated",
    evidence: "ACP_PREFERRED_KINDS routes grok to the ACP runner; the legacy electron/runtime/grok.ts driver represents every transport via `grok mcp add`",
  },
  cursor: {
    delivery: "acp-session-new",
    extraTransports: "negotiated",
    evidence: "ACP_PREFERRED_KINDS routes cursor to createAcpRunner; acpMcpServersFromConfig translates our config into session/new.mcpServers",
  },
  kimi: {
    delivery: "acp-session-new",
    extraTransports: "negotiated",
    evidence: "ACP_PREFERRED_KINDS routes kimi to createAcpRunner; same session/new translation as cursor",
  },
  acp: {
    delivery: "acp-session-new",
    extraTransports: "negotiated",
    evidence: "the open ACP seat (built-in specs + user profiles) runs createAcpRunner, which is where the session/new translation lives",
  },
  ollama: {
    delivery: "in-process-loop",
    extraTransports: ["sse", "http"],
    evidence: "electron/runtime/local-tool-loop.ts resolves each configured server with the MCP SDK client, so transport choice is ours",
  },
  lmstudio: {
    delivery: "in-process-loop",
    extraTransports: ["sse", "http"],
    evidence: "same in-process loop as ollama",
  },
  mlx: {
    delivery: "in-process-loop",
    extraTransports: ["sse", "http"],
    evidence: "same in-process loop as ollama",
  },
  // ★2026-08-18 반증 — "antigravity has no MCP surface" 는 틀린 근거였다.
  // 프로브 실측(agy 1.1.14): ~/.gemini/config/mcp_config.json 에 등록한 서버가
  // 실행 시작 시 initialize → tools/list 를 받았고(서버 수신 로그), agy 내장
  // 도구에 call_mcp_tool · list_resources · read_resource 가 실재하며, 이 머신의
  // 실물 설정에 이미 사용자 서버 4개가 등록돼 있었다. 러너의
  // reconcileAgyMcpServers 가 승인된 서버를 실행 단위로 더하고 걷는다.
  antigravity: {
    delivery: "config-reconcile",
    extraTransports: ["http", "sse"],
    evidence:
      "probed 2026-08-18 (agy 1.1.14): a server added to ~/.gemini/config/mcp_config.json received initialize/tools/list at run start; electron/runtime/antigravity.ts reconcileAgyMcpServers stages approved servers per run (command and serverUrl forms, matching the live config's own entries)",
  },
  // byok runners talk to a provider HTTP API directly (electron/runtime/byok.ts
  // never reads mcpConfigPath) and have no tool loop of their own. When they
  // grow one, this row — not a new hand-written list — is what changes.
  byok: null,
};

/** Can this runtime kind receive MCP servers at all? */
export function runtimeKindCanUseMcp(kind: string | null | undefined): boolean {
  return Boolean(kind && RUNTIME_MCP_SUPPORT[kind as RuntimeKind]);
}

/**
 * Can this runtime kind carry a server on this transport? stdio is the baseline
 * every delivery path speaks; anything else is either declared or negotiated at
 * session time (and announced when it has to be dropped).
 */
export function runtimeKindSupportsMcpTransport(
  kind: string | null | undefined,
  transport: McpTransport,
): boolean {
  const row = kind ? RUNTIME_MCP_SUPPORT[kind as RuntimeKind] : null;
  if (!row) return false;
  if (transport === "stdio") return true;
  if (row.extraTransports === "negotiated") return true;
  return row.extraTransports.includes(transport);
}

/** Runtime kinds that can receive MCP, for receipts and diagnostics. */
export const MCP_CAPABLE_RUNTIME_KINDS: readonly RuntimeKind[] = (
  Object.keys(RUNTIME_MCP_SUPPORT) as RuntimeKind[]
).filter((kind) => RUNTIME_MCP_SUPPORT[kind] !== null);
