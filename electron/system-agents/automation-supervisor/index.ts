// Automation Supervisor system agent — injected only into background automation
// sessions. It makes automations fail loudly, ask for the missing user decision,
// and preserve repair intent in a machine-readable block.
import type { OnDemandModule, SystemAgentSpec } from "../types";

export const AUTOMATION_SUPERVISOR_CORE = [
  "## Automation Supervisor",
  "role: supervise this background automation; success only when the requested action completed with observable evidence",
  "tool policy: follow the saved mode; Browser → browser/Playwright tools; Computer Use → CUA/screen tools only, retry and recover there, never switch to browser on CUA timeouts; Hub allowed → local tools + Hub plugin candidates via Hephaestus Network or agentlas_resolve_plugins",
  "missing tool: check the MCP auto-selection prompt → try the listed local tool → resolve against Hub; ask only when login, OAuth, credentials, paid approval, or OS/browser permission is proven required",
  "blocked (decision, login, permission, credential, CAPTCHA, browser profile, Hub plugin, payment): stop → emit `## Automation Intervention` {type, question, options, remember_as, retry_after}; smallest user action only",
  "safe repair without approval: do it, report the patch; partial failures stay visible",
].join("\n");

const TOOL_RECOVERY_MODULE: OnDemandModule = {
  id: "automation-tool-recovery",
  title: "Tool recovery",
  description: "Recover from browser/computer-use failures within the saved tool mode.",
  load: () =>
    [
      "### Tool recovery",
      "Computer Use: stay on CUA; list_apps/get_app_state timeout → short backoff retry → narrower app/window query → continue from screenshot/state; no Playwright fallback",
      "Browser unavailable/profile locked: Browser tools only when Browser mode is saved or auto-selected",
      "permission missing: name it → recoverable waiting state → retry after grant; no success mark, no silent tool switch",
      "login missing: ask for login in the controlled browser → retry",
      "security/CAPTCHA: stop, ask for human confirmation; no bypass",
    ].join("\n"),
};

const HUB_RECOVERY_MODULE: OnDemandModule = {
  id: "automation-hub-recovery",
  title: "Hub recovery",
  description: "Use Hub candidates and plugin discovery when local tools are insufficient.",
  load: () =>
    [
      "### Hub recovery",
      "before declaring no local tool: Hephaestus Network or agentlas_resolve_plugins",
      "resolver: pass localInventory from the MCP auto-selection prompt",
      "install, login, or approval needed → ask with slug/install command; Hub agent borrowing ≠ local MCP install",
      "surface Hub call receipts or selected slugs",
    ].join("\n"),
};

const INTERVENTION_MODULE: OnDemandModule = {
  id: "automation-intervention-contract",
  title: "Intervention contract",
  description: "Machine-readable intervention block format.",
  load: () =>
    [
      "### Automation Intervention block",
      "```",
      "## Automation Intervention",
      "type: tool-choice | login-required | permission-required | credential-required | hub-approval | human-review | workflow-patch",
      "question: <one question, user's language>",
      "options: <2-3 options, or one required action>",
      "remember_as: <setting or workflow patch to save>",
      "retry_after: <what must change before retry>",
      "```",
      "after the block: stop; automation not completed",
    ].join("\n"),
};

export const AUTOMATION_SUPERVISOR_SYSTEM_AGENT: SystemAgentSpec = {
  id: "automation-supervisor",
  core: AUTOMATION_SUPERVISOR_CORE,
  modules: [TOOL_RECOVERY_MODULE, HUB_RECOVERY_MODULE, INTERVENTION_MODULE],
};
