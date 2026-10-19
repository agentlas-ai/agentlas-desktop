/**













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
