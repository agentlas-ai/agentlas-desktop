export const OPEN_SCIENCE_INSTALL_EVENT = "agentlas:open-science-install";

// Keep the signed package path wired while Science remains owner-gated.
// Flip this only when the product is ready to be discoverable again.
export const SCIENCE_INSTALL_DISCOVERY_ENABLED = false;

export function requestScienceInstall(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SCIENCE_INSTALL_EVENT));
}
