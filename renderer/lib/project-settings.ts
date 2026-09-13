export type NewProjectSource = "local" | "github" | "empty";
export type ProjectSettingsSection = "source" | "agents";
export type ProjectSettingsRequest =
  | { mode: "create"; sourceType?: NewProjectSource }
  | { mode: "edit"; projectId: string; section?: ProjectSettingsSection };

export const PROJECT_SETTINGS_EVENT = "agentlas:project-settings";

/** Open settings over the current page without interrupting its conversation. */
export function openProjectSettings(request: ProjectSettingsRequest = { mode: "create" }) {
  window.dispatchEvent(new CustomEvent<ProjectSettingsRequest>(PROJECT_SETTINGS_EVENT, { detail: request }));
}
