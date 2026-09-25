/** Immutable identity selected on a public Hub card; never resolve it as latest. */
export interface HubReleasePin {
  agentDefinitionId: string;
  agentReleaseId: string;
  packageHash: string;
}

export function parseHubReleasePin(value: unknown): HubReleasePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hub_release_required");
  const pin = value as Record<string, unknown>;
  if (Object.keys(pin).some((key) => !["agentDefinitionId", "agentReleaseId", "packageHash"].includes(key))) {
    throw new Error("hub_release_invalid");
  }
  for (const key of ["agentDefinitionId", "agentReleaseId"] as const) {
    if (typeof pin[key] !== "string" || !pin[key].trim() || pin[key].length > 160 || /[\s\u0000-\u001f]/u.test(pin[key])) {
      throw new Error("hub_release_invalid");
    }
  }
  if (typeof pin.packageHash !== "string" || !/^[a-f0-9]{64}$/u.test(pin.packageHash)) throw new Error("hub_release_invalid");
  return { agentDefinitionId: pin.agentDefinitionId as string, agentReleaseId: pin.agentReleaseId as string, packageHash: pin.packageHash };
}

export function assertHubReleasePin(expected: HubReleasePin, actual: Partial<HubReleasePin> | null | undefined): void {
  if (!actual || expected.agentDefinitionId !== actual.agentDefinitionId
    || expected.agentReleaseId !== actual.agentReleaseId || expected.packageHash !== actual.packageHash) {
    throw new Error("hub_release_changed");
  }
}
