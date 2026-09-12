/** Shared contract for model-required project-to-Hub semantic selection. */
export const PROJECT_HUB_RECOMMENDATION_JUDGMENT = {
  kind: "project-hub-recommendations",
  question: "Which listed public Hub candidate ids are the strongest direct capability matches for this project's stated work? Choose zero to six.",
  guidance:
    "Use only the project context and each candidate's published capability description. " +
    "Prefer specialists that can directly perform the stated work. Do not select generic project managers, coordinators, smoke tests, or adjacent domains unless the project explicitly asks for them. " +
    "An empty selection is correct when the menu has no direct fit, and never choose more than six ids.",
  maxInputChars: 24_000,
  timeoutMs: 45_000,
  minConfidence: 0.6,
} as const;
