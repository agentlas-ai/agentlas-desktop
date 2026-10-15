import { RUNTIME_MCP_SUPPORT } from "../../shared/runtime-mcp";
import type { RuntimeKind } from "../../shared/types";
import { AGENTLAS_TURN_CATALOG_ID } from "./mcp-server";
import { featureConnection } from "../harness/feature-registry";

/*
 * May the prompt drop the text teaching of a control block because the typed agentlas-turn tool replaces it?
 * Only when (1) the tool was really attached to this run (mcp-config built it with a run capability) and (2) the
 * runtime hands every MCP tool to the model directly. In-process-loop runtimes keep the text:
 *   - ollama / lmstudio / mlx / agentlas-local: no tool-capability probe exists, a model without tool support could
 *     never call the tool and would lose the note;
 *   - byok / agentlas serving: MCP tools sit behind the lazy tool menu / code mode (local-tool-loop.ts
 *     indirectToolSurface), so a rarely used tool is not reliably discovered.
 * The text parsers stay as the fallback for all of them; the tool still works there if a model does call it.
 * The decision is the feature registry's (electron/harness/feature-registry.ts): a feature whose connection for this
 * runtime's executor family is host-alternative keeps its text protocol.
 */
export function turnToolReplacesText(
  runtimeKind: string,
  includedServers: ReadonlyArray<{ catalogId: string | null }>,
  featureId: "goal-lifecycle" | "memory-receipt" | "ask" = "goal-lifecycle",
): boolean {
  if (!includedServers.some((row) => row.catalogId === AGENTLAS_TURN_CATALOG_ID)) return false;
  if (!RUNTIME_MCP_SUPPORT[runtimeKind as RuntimeKind]) return false;
  const connection = featureConnection(featureId, runtimeKind);
  return connection !== null && connection.mode !== "host-alternative" && connection.mode !== "unavailable";
}
