/**
 * Chrome switches shared by every launch of the dedicated automation profile
 * (~/.agentlas/chrome-cdp-profile): the CDP launcher, the login window, the
 * OAuth window and the headless sign-in import.
 *
 * Chrome keeps only the last --disable-features switch, so every disabled
 * feature travels in this one value.
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
