export const OPEN_SCIENCE_INSTALL_EVENT = "agentlas:open-science-install";

export function requestScienceInstall(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SCIENCE_INSTALL_EVENT));
}
