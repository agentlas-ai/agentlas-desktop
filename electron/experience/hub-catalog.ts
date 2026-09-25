import type { ExperienceHubCatalogResult } from "../../shared/types";

/**
 * The standalone paid Experience Chip catalog was retired with marketplace
 * settlement. Keep this legacy IPC response for older Desktop renderers, but
 * never query purchase/lease offers or present a paid catalog. Public chips
 * are browsed inside each agent's free Agent Space Experience tab.
 */
export async function getExperienceHubCatalog(): Promise<ExperienceHubCatalogResult> {
  return { status: "empty", chips: [], checkedAt: new Date().toISOString() };
}
