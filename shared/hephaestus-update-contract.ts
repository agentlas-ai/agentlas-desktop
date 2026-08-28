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

  const state = baseStatus && APPLIED_STATUSES.has(baseStatus)
    ? "applied"
    : baseStatus && CURRENT_STATUSES.has(baseStatus)
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
