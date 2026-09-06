export const OPEN_SCIENCE_INSTALL_EVENT = "agentlas:open-science-install";

// Public Science installation uses the signed release catalog.
export const SCIENCE_INSTALL_DISCOVERY_ENABLED = true;

export function requestScienceInstall(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SCIENCE_INSTALL_EVENT));
}
