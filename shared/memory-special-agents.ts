// The two agents that keep their own memory store although every other `builtin-agentlas-*` actor is a resident system actor without one
// (the engine contract `schemas/memory-scopes.json` `specialAgentIds`; engine reader `memory_scopes.py`). Plain constants, nothing imported: the desktop's store
// routing (electron/memory/special-store-agents.ts) answers the same in every process — Main, the daemon, a test — no matter which feature module was loaded (#9).
export const CONTRACT_SPECIAL_STORE_AGENT_IDS: readonly string[] = ["builtin-agentlas-science-research-director", "builtin-agentlas-finance"];
