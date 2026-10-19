import { newestLocalAgentDefinitionMtimeMs } from "./definition-hash";
import { importLocalFolder } from "./import-local";
import { getRoute } from "./routes";

/**







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
