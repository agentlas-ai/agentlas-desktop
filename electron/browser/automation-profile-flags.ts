/**
 * What the dedicated automation profile (~/.agentlas/chrome-cdp-profile) is
 * allowed to keep. Automation needs sign-ins and site data (cookies, Local
 * Storage, IndexedDB, Service Worker registrations), never Chrome's own models
 * or an unbounded cache. Shared by every launch of that profile: the CDP
 * launcher, the login window, the OAuth window and the sign-in import.
 *
 * Chrome keeps only the last --disable-features switch, so every disabled
 * feature travels in one value.
 *
 * The OptimizationGuide features and --disable-component-update stop Chrome
 * from downloading its on-device AI model into the profile. On 2026-10-16 the
 * profile held 4 GB of OptGuideOnDeviceModel. The OAuth window was the one
 * launch without --disable-component-update.
 */
export const AUTOMATION_PROFILE_DISABLED_FEATURES = [
  "Translate",
  "OptimizationGuideModelDownloading",
  "OptimizationGuideOnDeviceModel",
  "OptimizationHints",
  "OptimizationHintsFetching",
  "OptimizationTargetPrediction",
] as const;

export const AUTOMATION_PROFILE_FEATURE_FLAG = `--disable-features=${AUTOMATION_PROFILE_DISABLED_FEATURES.join(",")}`;

/** HTTP cache ceiling; Chrome evicts above it. The profile's cache reached 1.4 GB without one. */
export const AUTOMATION_PROFILE_CACHE_BYTES = 256 * 1024 * 1024;

export const AUTOMATION_PROFILE_FLAGS = [
  AUTOMATION_PROFILE_FEATURE_FLAG,
  `--disk-cache-size=${AUTOMATION_PROFILE_CACHE_BYTES}`,
] as const;

/**
 * Regenerable profile entries the CDP launcher removes while no Chrome holds
 * the profile. `always`: Chrome's models, which automation never uses.
 * `overBudget`: compiled-code and GPU caches, removed together once they pass
 * AUTOMATION_PROFILE_CACHE_BYTES (--disk-cache-size does not bound them).
 */
export const AUTOMATION_PROFILE_DISPOSABLE = {
  always: ["OptGuideOnDeviceModel", "OptGuideOnDeviceClassifierModel"],
  overBudget: [
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
  ],
} as const;
