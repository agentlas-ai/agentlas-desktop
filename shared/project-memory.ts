// Shared shapes for the Dashboard "project memory status" panel. Kept in a
// dedicated shared module so preload types (shared/types.ts), the Main handler
// (electron/memory/context.ts), and the renderer all agree on one contract.

export interface ProjectMemorySourceStatus {
  /** File/index present and readable for this project. */
  present: boolean;
  /** Injected into at least one recent run (per content-free markers). */
  recentlyInjected: boolean;
  /** Human-readable reason when missing/unused. Null when present. */
  reason: string | null;
  /** Whether a generate action exists for this source. */
  canGenerate: boolean;
}

export interface ProjectMemoryStatus {
  projectPath: string;
  identityVerified: boolean;
  pmSoul: ProjectMemorySourceStatus;
  codeMap: ProjectMemorySourceStatus;
  sitemap: ProjectMemorySourceStatus;
}

export interface ProjectMemoryGenerateResult {
  started: boolean;
  reason: string | null;
}
