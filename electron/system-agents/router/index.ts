// Router Agent system agent — resolves the low-confidence routing decisions the
// deterministic router escalates (clarify/propose_new). The Hephaestus engine
// attaches an escalation directive (BYOC — no model call there); the host runtime
// loads this spec and runs the reasoning pass with the user's own model.
//
// Core = decision contract + safety (always on, capability-critical). On-demand =
// rerank heuristics and clarification authoring, pulled only on an actual
// escalation turn. Mirrors the memory/desktop-chat ITR split.
import type { SystemAgentSpec, OnDemandModule } from "../types";

export const ROUTER_AGENT_ID = "agentlas-router-agent";

/** Always-on minimal core: the decision contract the model must follow when an
 *  escalation directive is present. */
export const ROUTER_CORE = [
  "## Router Agent",
  "role: resolve a routing request the deterministic router could not route",
  "decide: exactly one of route to best-fit agent | ask ONE clarification | propose new agent via hep-build",
  "rank: inferred intent fit, not keyword overlap; specialist > generalist; clarify only when 2+ candidates fit and the choice changes the outcome",
  "run: chosen agent attached to the current project; ids/slugs only from the candidate list; never do the task yourself",
  "output: decision + one-line rationale; policy violation → refusal reason",
].join("\n");

/** On-demand: how to re-rank candidates by intent fit. Loaded on escalation turns. */
export const ROUTER_RERANK_MODULE: OnDemandModule = {
  id: "router-rerank",
  title: "Candidate rerank heuristics",
  description: "Re-rank routing candidates by inferred intent fit.",
  load: () =>
    [
      "### Rerank",
      "score: capability/trigger coverage of inferred intent, not query words",
      "demote: other domain, catch-all capability lists",
      "anti-trigger match → drop",
      "near-tie (top two within ~15%): more specific agent; still tied → ask one clarification naming both",
      "hub candidates: prefer comparable local match, else borrow best-fit hub agent grounded in the project",
    ].join("\n"),
};

/** On-demand: how to write the single clarification question when truly ambiguous. */
export const ROUTER_CLARIFY_MODULE: OnDemandModule = {
  id: "router-clarify",
  title: "Clarification authoring",
  description: "Write the single clarification question for ambiguous routing.",
  load: () =>
    [
      "### Clarify",
      "ask: exactly one question naming the fork (outcome | domain | run-existing vs build-new)",
      "options: 2-3 strongest candidates by name",
      "language: user's",
    ].join("\n"),
};

export const ROUTER_SYSTEM_AGENT: SystemAgentSpec = {
  id: "router",
  core: ROUTER_CORE,
  modules: [ROUTER_RERANK_MODULE, ROUTER_CLARIFY_MODULE],
};
