/**
 * CLI-native built-in tools that send work outside the Agentlas approval boundary — one declaration for every runtime
 * and every host (Desktop Main, daemon, standalone Terminal; Terminal gets a generated copy, see
 * scripts/sync-runtime-builtin-egress-policy.cjs).
 *
 * Rule (owner, 2026-10-28): publishing or sending outside the machine passes the common arbiter
 * (host-tool-permission-policy.ts); a vendor tool whose call never reaches it is switched off by launch argument or
 * config, never by prompt words. Incident: an isolated-app Science run on claude-code (Haiku) called Claude Code's
 * built-in `Artifact` tool and published an HTML page to claude.ai. That tool family asks nobody in a headless run (no
 * permission prompt, no Agentlas hook), so every claude-code run — Work, One, Finance, Science, judgments — could do it.
 *
 * Inventory source: the installed CLI itself. claude 2.1.312: `system/init` `tools` of `claude -p` in an isolated
 * CLAUDE_CONFIG_DIR, plus the binary's tool registry (`name` + `searchHint` pairs). codex-cli 0.165.0:
 * `codex features list`. GitHub Copilot CLI 1.0.95: `copilot --help`. Names a CLI does not ship are harmless in every
 * switch used here (a deny rule for an absent tool, `-c features.<absent>=false`).
 *
 * Kept on purpose: WebSearch/WebFetch (research lookups; read-run pre-allow is an owner decision, 2026-08-15), Bash
 * (under the permission chip, the tool-broker hook and the write sandbox), local subagents and local task tools.
 */

export type BuiltinEgressCategory =
  | "publish"            // makes content reachable by others on a vendor surface
  | "remote-trigger"     // starts or schedules agents in the vendor's cloud
  | "schedule"           // the CLI re-prompts itself later; Agentlas owns scheduling and continuation
  | "remote-session"     // talks to other local, cloud or Remote Control sessions
  | "push"               // notifies or delivers to the person's devices outside Agentlas
  | "cloud-write"        // writes the person's vendor-account store
  | "remote-environment" // drives the vendor's self-hosted runner fleet
  | "vendor-connector";  // the vendor's own account connectors (outside Agentlas's MCP binding)

export interface BuiltinEgressTool {
  name: string;
  category: BuiltinEgressCategory;
}

/** Bumped whenever a table below changes; written into each run's receipt. */
export const BUILTIN_EGRESS_POLICY_REVISION = 2;

/** Claude Code built-in tools denied in every product run (`--disallowedTools`; deny wins over bypassPermissions). */
export const CLAUDE_BUILTIN_EGRESS_TOOLS: readonly BuiltinEgressTool[] = [
  { name: "Artifact", category: "publish" },
  { name: "ArtifactComments", category: "publish" },
  { name: "ArtifactData", category: "publish" },
  { name: "ArtifactCheck", category: "publish" },
  { name: "AppifactRepl", category: "publish" },
  { name: "ClaudeDesign", category: "publish" },
  { name: "DesignSync", category: "publish" },
  { name: "Projects", category: "cloud-write" },
  { name: "PublishPlugin", category: "publish" },
  { name: "ShareOnboardingGuide", category: "publish" },
  { name: "RemoteTrigger", category: "remote-trigger" },
  { name: "CronCreate", category: "schedule" },
  { name: "CronDelete", category: "schedule" },
  { name: "CronList", category: "schedule" },
  { name: "ScheduleWakeup", category: "schedule" },
  { name: "SendMessage", category: "remote-session" },
  { name: "SendFile", category: "remote-session" },
  { name: "ListAgents", category: "remote-session" },
  { name: "PushNotification", category: "push" },
  { name: "SendUserFile", category: "push" },
  { name: "SendUserMessage", category: "push" },
  { name: "memory_write", category: "cloud-write" },
  { name: "self_hosted_runner_requeue_session", category: "remote-environment" },
  { name: "self_hosted_runner_spawn_local", category: "remote-environment" },
];
// Not in the table on purpose (owner rule 2026-10-28: full access allows, otherwise ask): the person's claude.ai
// connectors (`mcp__claude_ai_*`, loaded when a run cannot pass --strict-mcp-config). They are never pre-allowed, so a
// read/write run's call stops at the CLI and becomes the post-denial approval card (claude-code.ts announceToolDenied);
// full access (bypassPermissions) runs them. A live per-call arbiter (e.g. "payments always ask" under full access) is
// not reachable from inside the CLI for these vendor-hosted servers.

/** The deny entries every claude-code spawn merges into its single `--disallowedTools` value. */
export function claudeBuiltinEgressDenial(): string[] {
  return CLAUDE_BUILTIN_EGRESS_TOOLS.map((tool) => tool.name);
}

export interface CodexBuiltinEgressFeature extends BuiltinEgressTool {
  /**
   * `always`: off in every run. `unless-arbiter-or-full`: on where the run's approvals reach the Agentlas arbiter, or
   * where the owner chose full access; off on a read/write run that has no approval loop.
   */
  off: "always" | "unless-arbiter-or-full";
}

/**
 * Codex features (`-c features.<name>=false`; an unknown name is ignored, so older and newer CLIs both start).
 * `apps` is the ChatGPT connector surface (codex_apps: Gmail, Calendar, Drive ...). Its calls are approved through the
 * arbiter on an app-server thread with `approvalPolicy: on-request` and the user reviewer (codex.ts codexThreadPolicy).
 * `codex exec` (Desktop exec path, every Terminal codex run) has no approval loop: there apps stay on only under full
 * access (the owner's choice), and are off for read/write.
 */
export const CODEX_BUILTIN_EGRESS_FEATURES: readonly CodexBuiltinEgressFeature[] = [
  { name: "plugin_sharing", category: "publish", off: "always" },
  { name: "apps", category: "vendor-connector", off: "unless-arbiter-or-full" },
];

export function codexBuiltinEgressConfigArgs(input: { approvalsReachArbiter: boolean; fullAccess: boolean }): string[] {
  return CODEX_BUILTIN_EGRESS_FEATURES
    .filter((feature) => feature.off === "always" || (!input.approvalsReachArbiter && !input.fullAccess))
    .flatMap((feature) => ["-c", `features.${feature.name}=false`]);
}

/**
 * Grok built-in tools (grok 1.0.67 tool registry), denied by name in the product GROK_HOME config.toml (`[permission]
 * deny`). Measured 2026-10-28 with a real grok turn: a native-name deny wins over `--always-approve` (ACP yolo, full
 * access): "Tool `scheduler_create` was not executed: Denied by permission policy". deploy_app/init_or_update_app ship in
 * the binary but were not offered to this account; the same rule covers them when they are.
 */
export const GROK_BUILTIN_EGRESS_TOOLS: readonly BuiltinEgressTool[] = [
  { name: "deploy_app", category: "publish" },
  { name: "init_or_update_app", category: "publish" },
  { name: "scheduler_create", category: "schedule" },
  { name: "scheduler_delete", category: "schedule" },
  { name: "scheduler_list", category: "schedule" },
  { name: "send_feedback", category: "push" },
];

/** The `[permission]` table every product GROK_HOME config.toml ends with. */
export function grokBuiltinEgressConfigToml(): string {
  return `[permission]\ndeny = [${GROK_BUILTIN_EGRESS_TOOLS.map((tool) => JSON.stringify(tool.name)).join(", ")}]\n`;
}

/*
 * GitHub Copilot CLI: nothing is switched off. Its built-in GitHub MCP tools ask through ACP session/request_permission,
 * which the Agentlas arbiter answers (acp.ts answerPermission); full access runs them (the owner's choice).
 * `--share`, `--share-gist` and `--remote` are opt-in flags and are never passed.
 */

/**
 * Values a host agent session gives its own children (Claude Code desktop/CLI/SDK: CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT,
 * the session's messaging socket and token, its ANTHROPIC_BASE_URL proxy, CLAUDE_CODE_SIMPLE ...). When Agentlas itself
 * is started from such a session (a dev or QA app launched by an agent), every runtime it spawns inherited them: claude
 * children turned on the claude.ai Artifact tools (measured: CLAUDE_CODE_ENTRYPOINT alone adds Artifact,
 * ArtifactComments, ArtifactData, SendUserFile) and could reach the parent's session socket and proxy.
 * Allowlist: inside the CLAUDE / ANTHROPIC_ namespace only the person's own sign-in, provider choice and config dir
 * survive; every other name in it is dropped. Names outside the namespace (PATH, proxies, vault key aliases added later
 * by buildRunnerEnv) are untouched. Without a host-session marker nothing is changed (a normal launch keeps what the
 * person configured, ANTHROPIC_BASE_URL included).
 */
const HOST_SESSION_MARKERS: readonly string[] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SESSION_ID"];
const HOST_SESSION_NAMESPACE = /^(?:CLAUDECODE$|CLAUDE_|ANTHROPIC_)/;
export const HOST_SESSION_ENV_KEEP: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CONFIG_DIR",
]);

/** Removes a host agent session's own variables from `env` in place; returns the removed names (never values). */
export function scrubHostSessionEnv(env: Record<string, string | undefined>): string[] {
  if (!HOST_SESSION_MARKERS.some((name) => env[name] !== undefined && env[name] !== "")) return [];
  const dropped: string[] = [];
  for (const name of Object.keys(env)) {
    if (HOST_SESSION_NAMESPACE.test(name) && !HOST_SESSION_ENV_KEEP.has(name)) { delete env[name]; dropped.push(name); }
  }
  return dropped.sort();
}

/** Machine-readable receipt for one spawn. */
export function builtinEgressReceipt(kind: string, denied: number): string {
  return `[runtime-egress] kind=${kind} rev=${BUILTIN_EGRESS_POLICY_REVISION} denied=${denied}`;
}
