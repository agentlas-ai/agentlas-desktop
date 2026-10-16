/*
 * Subscription visual routes and media connectors (docs/2026-10-13-native-harness/17 §1, §4).
 *
 * Three axes stay separate: product class (subscription-visual = Agentlas "multimodal"; everything bought through an
 * API key is a connector, including speech), the actual transport (native-tool / oauth-cli / api-adapter), and who
 * pays (the provider catalog's billing field; never inferred from the auth method). Readiness comes from the same
 * isProviderReady the settings screen uses, with a distinct reason code per cause, and `evidence` says how far a
 * route has been proven. Built on shared/multimodal.ts MULTIMODAL_PROVIDERS; no electron import at top level.
 */

export type RouteClass = "subscription-visual" | "connector-media" | "connector-speech";
export type RouteTransport = "native-tool" | "oauth-cli" | "api-adapter";
export type MediaOperationId =
  | "media.image.generate" | "media.image.edit" | "media.video.generate" | "media.video.animate-image"
  | "media.video.edit" | "media.video.extend" | "speech.synthesize" | "speech.transcribe";
export type RouteReadiness = "ready" | "auth-required" | "runtime-missing" | "adapter-required" | "unverified";

export interface MediaRoute {
  routeId: string;
  label: string;
  class: RouteClass;
  transport: RouteTransport;
  operations: MediaOperationId[];
  billing: "subscription" | "paid-api" | "provider-billing";
  envKeys: string[];
  /** How far the route is proven in this product: source (code path exists) or live. */
  evidence: "source" | "live";
  /** A route whose product caller is not wired yet. */
  adapterRequired?: string;
}

/** Transport and operations per provider id: the facts doc 17 §2 recorded, as data. */
const ROUTE_FACTS: Record<string, { transport: RouteTransport; operations: MediaOperationId[]; adapterRequired?: string }> = {
  // Edit: the subscription CLIs take the source image (codex exec -i; agy reads it from its directory) — NH34.
  "codex-cli-image": { transport: "native-tool", operations: ["media.image.generate", "media.image.edit"] },
  "nanobanana-image": { transport: "native-tool", operations: ["media.image.generate", "media.image.edit"] },
  "grok-cli-image": { transport: "oauth-cli", operations: ["media.image.generate"] },
  "grok-cli-video": { transport: "oauth-cli", operations: ["media.video.animate-image"] },
  // Text-only callers exist where the provider's public API documents it (video.ts TEXT_MODELS). Grok text-to-video is the
  // xAI API (key, metered) — a separate route so the subscription CLI never turns into API billing.
  "grok-api-video": { transport: "api-adapter", operations: ["media.video.generate"] },
  "runway-video": { transport: "api-adapter", operations: ["media.video.generate", "media.video.animate-image"] },
  // Extension continues a finished Luma generation (keyframes frame0 = generation) — NH34. No route runs video-to-video edit yet.
  "luma-video": { transport: "api-adapter", operations: ["media.video.generate", "media.video.animate-image", "media.video.extend"] },
  "google-veo": { transport: "api-adapter", operations: ["media.video.generate", "media.video.animate-image"] },
  "seedance-video": { transport: "api-adapter", operations: ["media.video.generate", "media.video.animate-image"] },
  "kling-video": { transport: "api-adapter", operations: ["media.video.generate", "media.video.animate-image"] },
  // Keyed speech through the host (keyed-provider.ts speech.synthesize); the key is used by Main, never by the model.
  "elevenlabs-audio": { transport: "api-adapter", operations: ["speech.synthesize", "speech.transcribe"] },
  "openai-audio": { transport: "api-adapter", operations: ["speech.synthesize", "speech.transcribe"] },
  "deepgram-audio": { transport: "api-adapter", operations: ["speech.transcribe"] },
};

/** Video job provider id per catalog id (electron/multimodal/video.ts). */
export const VIDEO_JOB_PROVIDER: Record<string, string> = {
  "grok-cli-video": "grok", "grok-api-video": "grok", "runway-video": "runway", "luma-video": "luma", "google-veo": "veo", "seedance-video": "seedance", "kling-video": "kling",
};

export async function mediaRoutes(): Promise<MediaRoute[]> {
  const { MULTIMODAL_PROVIDERS } = await import("../../shared/multimodal");
  return MULTIMODAL_PROVIDERS.map((provider) => {
    const facts = ROUTE_FACTS[provider.id];
    const cls: RouteClass = provider.mode === "cli-subscription" ? "subscription-visual" : provider.modality === "audio" ? "connector-speech" : "connector-media";
    const operations: MediaOperationId[] = facts?.operations
      ?? (provider.modality === "image" ? ["media.image.generate"] : provider.modality === "video" ? [] : ["speech.synthesize"]);
    return {
      routeId: provider.id,
      label: provider.label,
      class: cls,
      transport: facts?.transport ?? (provider.mode === "cli-subscription" ? "oauth-cli" : "api-adapter"),
      operations,
      billing: provider.billing,
      envKeys: provider.envKeys,
      evidence: "source" as const,
      ...(facts?.adapterRequired ? { adapterRequired: facts.adapterRequired }
        : facts ? {} : { adapterRequired: "no harness media job wired for this provider yet" }),
    };
  });
}

/** Readiness with a reason code; never "ready" for a route whose product caller is missing. */
export async function routeReadiness(route: MediaRoute): Promise<RouteReadiness> {
  if (route.adapterRequired) return "adapter-required";
  const { MULTIMODAL_PROVIDERS } = await import("../../shared/multimodal");
  const provider = MULTIMODAL_PROVIDERS.find((row) => row.id === route.routeId);
  if (!provider) return "unverified";
  try {
    const { isProviderReady } = await import("../multimodal/availability");
    if (await isProviderReady(provider)) return "ready";
  } catch {
    return "unverified";
  }
  return route.transport === "api-adapter" ? "auth-required" : route.routeId.startsWith("grok-") ? "auth-required" : "runtime-missing";
}

export interface RouteReadinessDetail {
  /** The gate value (unchanged): local configuration that lets a job start. */
  state: RouteReadiness;
  /** Installed adapter / CLI and credential present — configuration, not proof. */
  configured: boolean;
  /** The last outcome this route actually produced in this product, if any (C08). */
  observed: { outcome: string; observedAt: string } | null;
  entitlement: "ok" | "denied" | "unobserved";
  quota: "ok" | "exhausted" | "unobserved";
  /** live = an outcome was observed; source = only the code path and configuration exist. */
  evidence: "live" | "source";
}

/** Image routes record their outcomes in readiness-observations; video routes in the durable media operation store. */
export async function routeReadinessDetail(route: MediaRoute): Promise<RouteReadinessDetail> {
  const state = await routeReadiness(route);
  let observed: RouteReadinessDetail["observed"] = null;
  const videoProvider = VIDEO_JOB_PROVIDER[route.routeId];
  try {
    if (videoProvider) {
      const { latestFinishedMediaOperation } = await import("../store/media-operations");
      const op = latestFinishedMediaOperation(videoProvider);
      if (op) observed = { outcome: op.lifecycle === "succeeded" ? "ok" : (op.failureCode ?? "failed"), observedAt: op.updatedAt };
    } else {
      const { readReadinessObservation } = await import("./readiness-observations");
      const obs = await readReadinessObservation("media-route", route.routeId);
      if (obs) observed = { outcome: obs.outcome, observedAt: obs.observedAt };
    }
  } catch {
    observed = null;
  }
  return {
    state,
    configured: state === "ready",
    observed,
    entitlement: observed?.outcome === "entitlement_denied" ? "denied" : observed?.outcome === "ok" ? "ok" : "unobserved",
    quota: observed?.outcome === "quota_exhausted" ? "exhausted" : observed?.outcome === "ok" ? "ok" : "unobserved",
    evidence: observed ? "live" : "source",
  };
}

/** Engine name a subscription image generation reports → its route id. */
export const IMAGE_ENGINE_ROUTE: Record<string, string> = { codex: "codex-cli-image", gemini: "nanobanana-image", grok: "grok-cli-image" };
