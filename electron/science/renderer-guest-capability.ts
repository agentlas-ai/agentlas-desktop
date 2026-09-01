export type ScienceRendererGuestCommitCapability = "chemistry" | "molstar" | "read-only";

export function scienceRendererGuestCommitCapability(rendererId: unknown): ScienceRendererGuestCommitCapability {
  if (rendererId === "agentlas.ketcher") return "chemistry";
  if (rendererId === "agentlas.molstar") return "molstar";
  return "read-only";
}
