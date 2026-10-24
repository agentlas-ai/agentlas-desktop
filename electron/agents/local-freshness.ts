import { newestLocalAgentDefinitionMtimeMs } from "./definition-hash";
import { importLocalFolder } from "./import-local";
import { getRoute } from "./routes";

/**
 * Before a run, bring a local agent's registered instructions up to its folder. An agent's definition changes while
 * it works (the owner edits it, or the agent evolves it), and the run must use the current one at once. Measured
 * 2026-10-13: the Yotube room's Motiondirector ran on its 10-08 AGENTS.md for hours after a 21:44Z edit, because
 * only an engine re-queue ever re-imported a folder, and the Desktop skipped even that.
 *
 * A stat walk of the definition files decides; only a newer file than the last import pays for the re-import
 * (same folder route → same row, id, slug and seats). Never blocks the run: any failure keeps the stored version.
 */
export async function refreshLocalAgentIfChanged(agentId: string): Promise<boolean> {
  const route = getRoute(agentId);
  if (!route || (route.source ?? "local-import") !== "local-import" || route.missingSince || !route.path) return false;
  const importedAt = Date.parse(route.importedAt);
  if (!Number.isFinite(importedAt)) return false;
  // importedAt is whole milliseconds; a file stamp carries sub-millisecond digits, so compare whole milliseconds.
  const newest = Math.floor(newestLocalAgentDefinitionMtimeMs(route.path));
  if (newest <= importedAt) return false;
  try {
    await importLocalFolder(route.path);
    return true;
  } catch (error) {
    console.warn("[local-agent] refresh before run skipped:", error instanceof Error ? error.message : String(error));
    return false;
  }
}
