import type { HephaestusUpdateJournal } from "./types";

const APPLIED_STATUSES = new Set([
  "updated",
  "repaired_current",
  "recovered_missing_release_marker",
]);
const CURRENT_STATUSES = new Set(["current"]);
const PENDING_RELOAD_SUFFIX = "_pending_reload";

export type HephaestusUpdateJournalState = "applied" | "current" | "unknown" | "unobserved";

export interface HephaestusUpdateJournalDisposition {
  state: HephaestusUpdateJournalState;
  reloadRequired: boolean;
  pendingHosts: string[];
}

/** Parse the JSON marker while retaining Core's host-activation evidence. */
export function parseHephaestusUpdateJournal(value: unknown): HephaestusUpdateJournal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const str = (key: string) => typeof parsed[key] === "string" ? parsed[key] as string : null;
  const num = (key: string) => typeof parsed[key] === "number" ? parsed[key] as number : null;
  const activation = parsed.activation && typeof parsed.activation === "object" && !Array.isArray(parsed.activation)
    ? parsed.activation as Record<string, unknown>
    : null;
  return {
    status: str("status"),
    ...(typeof parsed.errorCode === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(parsed.errorCode)
      ? { errorCode: parsed.errorCode } : {}),
    targetVersion: str("targetVersion"),
    reason: str("reason"),
    current: str("current"),
    latest: str("latest"),
    lastCheckedEpoch: num("last_checked_epoch"),
    lastAppliedTag: str("last_applied_tag"),
    lastAppliedEpoch: num("last_applied_epoch"),
    reloadRequired: parsed.reloadRequired === true,
    pendingHosts: stringList(parsed.pendingHosts),
    activation,
  };
}

function releaseCore(value: string | null | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec((value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * A failed update record names the release it failed to reach. When the runtime the updater tracks already is that release (or a
 * newer one), the failure is history, not a state: nothing is left to retry, yet the record stays on disk until the next successful
 * check and every screen kept saying "the engine update failed". Such a record reads as `current`. A failure whose target is
 * ahead of the runtime, or whose target or current is not readable, stays a failure.
 */
export function settleStaleHephaestusUpdateFailure(
  journal: HephaestusUpdateJournal | null,
): HephaestusUpdateJournal | null {
  if (!journal || journal.status !== "failed") return journal;
  const target = releaseCore(journal.targetVersion);
  const have = releaseCore(journal.current);
  if (!target || !have) return journal;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] > target[index]) break;
    if (have[index] < target[index]) return journal;
  }
  const { errorCode: _failure, ...rest } = journal;
  return { ...rest, status: "current", reason: "failed_target_already_installed" };
}

function activationRecord(journal: HephaestusUpdateJournal | null): Record<string, unknown> | null {
  const activation = journal?.activation;
  return activation && typeof activation === "object" && !Array.isArray(activation) ? activation : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

/**
 * Interpret Core's updater marker without collapsing runtime state and host
 * activation state into one status string. `current + reloadRequired` is a
 * valid state: the new runtime is selected, while a running Codex/Claude host
 * still has the previous plugin loaded.
 */
export function classifyHephaestusUpdateJournal(
  journal: HephaestusUpdateJournal | null,
): HephaestusUpdateJournalDisposition {
  if (!journal) return { state: "unobserved", reloadRequired: false, pendingHosts: [] };

  const activation = activationRecord(journal);
  const status = journal.status?.trim() || null;
  const hasPendingSuffix = Boolean(status?.endsWith(PENDING_RELOAD_SUFFIX));
  const baseStatus = hasPendingSuffix ? status!.slice(0, -PENDING_RELOAD_SUFFIX.length) : status;
  const pendingHosts = [...new Set([
    ...stringList(journal.pendingHosts),
    ...stringList(activation?.pendingHosts),
  ])].sort();
  const reloadRequired = Boolean(
    journal.reloadRequired
    || activation?.reloadRequired === true
    || activation?.status === "pending_reload"
    || hasPendingSuffix
    || pendingHosts.length > 0,
  );
  // Core can skip a repeated install while the just-applied release is still
  // inside its cooldown window. Its canonical marker re-reads the active
  // runtime, so an exact current/latest match is positive current-state proof;
  // the skip reason describes the action, not an unknown runtime. Keep every
  // other `skipped` result unknown (for example `uncomparable_release`).
  const recentlyAppliedCurrent = baseStatus === "skipped"
    && journal.reason === "already_applied_recently"
    && Boolean(journal.current)
    && journal.current === journal.latest;

  const state = baseStatus && APPLIED_STATUSES.has(baseStatus)
    ? "applied"
    : (baseStatus && CURRENT_STATUSES.has(baseStatus)) || recentlyAppliedCurrent
      ? "current"
      : status
        ? "unknown"
        : "unobserved";
  return { state, reloadRequired, pendingHosts };
}

const HOST_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
};

export function hephaestusPendingHostLabels(journal: HephaestusUpdateJournal | null): string[] {
  return classifyHephaestusUpdateJournal(journal).pendingHosts.map(
    (host) => HOST_LABELS[host.toLowerCase()] ?? host,
  );
}
