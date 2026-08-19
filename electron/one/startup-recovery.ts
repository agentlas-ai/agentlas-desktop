import fs from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { judgeRequiredAction, secretValueFloor, type RequiredActionOption } from "../system-agents/judgment";
import type { RuntimeLocale } from "../runtime/status-i18n";
import { userDataDir } from "../runtime-paths";

const DISPOSABLE_DIRS = ["Cache", "Code Cache", "GPUCache"] as const;

function containedDisposableDirs(): string[] {
  const root = path.resolve(userDataDir());
  const prefix = `${root}${path.sep}`;
  const out: string[] = [];
  for (const name of DISPOSABLE_DIRS) {
    const target = path.resolve(root, name);
    if (!target.startsWith(prefix)) continue;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      out.push(target);
    } catch {
      // Missing cache is not a capability.
    }
  }
  return out;
}

function filesystemEvidence(): Record<string, number | null> {
  try {
    const stat = fs.statfsSync(userDataDir());
    return {
      availableBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
    };
  } catch {
    return { availableBytes: null, totalBytes: null };
  }
}

function observation(error: unknown, attempt: number, cacheTargets: string[]): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  const safe = secretValueFloor(raw).redacted;
  return JSON.stringify({
    stage: "desktop-startup",
    operation: "open-operational-store",
    attempt,
    observedFailure: safe.slice(0, 2_000),
    filesystem: filesystemEvidence(),
    disposableCacheLocationsAvailable: cacheTargets.length,
  });
}

function clearDisposableCaches(targets: string[]): void {
  for (const target of targets) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}

export interface StartupRecoveryPresentation {
  summary: string;
  question: string | null;
  options: Array<{ actionId: string; label: string }>;
}

/**
 * DB-independent One recovery loop. Subsystems expose facts and executable
 * capabilities; One chooses. Code contains no error-case router, dictionary,
 * default action, or customer-facing diagnosis.
 */
export async function recoverDesktopStartup(input: {
  error: unknown;
  retry: () => Promise<void> | void;
  present: (presentation: StartupRecoveryPresentation) => Promise<string | null> | string | null;
  locale?: RuntimeLocale;
}): Promise<boolean> {
  let currentError = input.error;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const cacheTargets = containedDisposableDirs();
    const actions: RequiredActionOption[] = [
      {
        id: "retry_startup",
        evidence: "Retry the same startup operation without changing user data.",
        authority: "local-reversible",
      },
      ...(cacheTargets.length > 0
        ? [{
            id: "clear_disposable_app_caches",
            evidence: `Remove ${cacheTargets.length} app-owned disposable cache directories, then retry. Project files, account state, conversations, agents, and the operational store are excluded.`,
            authority: "local-reversible" as const,
          }]
        : []),
      {
        id: "open_app_data_folder",
        evidence: "Open the app-owned data folder in Finder so the person can inspect or resolve a local file conflict. This does not change any file.",
        authority: "observe",
      },
    ];
    const decision = await judgeRequiredAction({
      kind: "desktop-startup-recovery",
      observation: observation(currentError, attempt, cacheTargets),
      actions,
      ...(input.locale ? { locale: input.locale } : {}),
    });
    if (decision.source !== "llm") return false;
    const selectedByPerson = await input.present({
      summary: decision.summary,
      question: decision.question,
      options: decision.options,
    });
    const actionId = decision.actionId ?? selectedByPerson;
    if (!actionId || !actions.some((action) => action.id === actionId)) return false;
    if (actionId === "open_app_data_folder") {
      await shell.openPath(userDataDir()).catch(() => undefined);
      continue;
    }
    if (actionId === "clear_disposable_app_caches") clearDisposableCaches(cacheTargets);
    try {
      await input.retry();
      return true;
    } catch (error) {
      currentError = error;
    }
  }
  return false;
}
