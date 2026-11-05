import type { MultimodalModality, MultimodalSettings } from "@shared/multimodal";
import type { Project, ProjectAgentPoolMember } from "@shared/types";

/**
 * Patch semantics for settings forms (harness rework E8/S4): an edit sends only what the owner changed, and a form that has not
 * read the stored value refuses to write one. The stores merge (multimodal) or keep a field the patch omits (projects), so an
 * omitted field is how "untouched" is said; a field copied from a stale or default-initialised screen state is not.
 */

/** One provider choice. The store merges it into the stored settings; the screen's snapshot is not sent back. */
export function multimodalProviderPatch(modality: MultimodalModality, providerId: string): Partial<MultimodalSettings> {
  if (modality === "image") return { imageProvider: providerId };
  if (modality === "video") return { videoProvider: providerId };
  return { audioProvider: providerId };
}

export type StoredListLoad = "loading" | "ready" | "failed";

/**
 * A list saved whole (terminal profiles) may only be written from a list that was actually read. While it is loading or the read
 * failed the screen shows an empty list, and adding one entry then replaced every stored entry with that one.
 */
export function wholeListWritable(load: StoredListLoad): boolean {
  return load === "ready";
}

export interface ProjectSettingsForm {
  name: string;
  /** The project goal as typed (stored as description). */
  goal: string;
  instructions: string;
  agentPool: ProjectAgentPoolMember[];
}

/** Project settings: only the fields that differ from the project as it was read when the dialog opened. */
export function projectSettingsPatch(
  stored: Pick<Project, "name" | "description" | "systemPrompt" | "agentPool">,
  form: ProjectSettingsForm,
): Partial<Pick<Project, "name" | "description" | "systemPrompt" | "agentPool">> {
  const patch: Partial<Pick<Project, "name" | "description" | "systemPrompt" | "agentPool">> = {};
  if (form.name.trim() !== stored.name) patch.name = form.name.trim();
  const goal = form.goal.trim() || null;
  if (goal !== ((stored.description ?? "").trim() || null)) patch.description = goal;
  const instructions = form.instructions.trim() || null;
  if (instructions !== ((stored.systemPrompt ?? "").trim() || null)) patch.systemPrompt = instructions;
  if (JSON.stringify(form.agentPool) !== JSON.stringify(stored.agentPool ?? [])) patch.agentPool = form.agentPool;
  return patch;
}
