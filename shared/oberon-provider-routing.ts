import type { OberonRenderProvider } from "./types";

export type OberonAnimateProviderId = "runway" | "luma" | "veo" | "seedance" | "kling" | "grok";

export interface OberonVideoReadiness {
  runway?: boolean;
  luma?: boolean;
  veo?: boolean;
  seedance?: boolean;
  kling?: boolean;
  grok?: boolean;
}

function animateProviderId(selected: string | null | undefined): OberonAnimateProviderId | null {
  const value = (selected || "").toLowerCase();
  if (value.includes("grok") || value.includes("xai")) return "grok";
  if (value.includes("veo") || value.includes("google")) return "veo";
  if (value.includes("kling")) return "kling";
  if (value.includes("seedance")) return "seedance";
  if (value.includes("runway")) return "runway";
  if (value.includes("luma")) return "luma";
  return null;
}

export function resolveOberonAnimateProvider(
  selected: string | null | undefined,
  ready: OberonVideoReadiness,
): { provider: OberonAnimateProviderId; via: "explicit" | "auto" } {
  const explicit = animateProviderId(selected);
  if (explicit) return { provider: explicit, via: "explicit" };
  for (const provider of ["veo", "kling", "seedance", "runway", "luma"] as const) {
    if (ready[provider]) return { provider, via: "auto" };
  }
  return { provider: "veo", via: "auto" };
}

export type OberonRenderProviderResolution =
  | { ok: true; provider: OberonRenderProvider; model: string }
  | { ok: false; selected: string };

export function resolveOberonRenderProvider(selected: string | null | undefined): OberonRenderProviderResolution {
  const value = (selected || "google-veo").toLowerCase();
  if (value.includes("grok") || value.includes("xai")) {
    return { ok: true, provider: "grok-cli-video", model: "grok-imagine-video" };
  }
  if (value.includes("veo") || value.includes("google") || value === "auto") {
    return { ok: true, provider: "google-enterprise-veo", model: "veo-3.1-lite-generate-001" };
  }
  return { ok: false, selected: selected || value };
}
