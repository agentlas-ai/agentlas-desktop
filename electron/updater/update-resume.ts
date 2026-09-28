/**
 * Update while work is running: ask once, pause the work for the update, continue it once after.
 *
 * Owner request 2026-09-28: "GPT 앱이나 Claude 는 업데이트 누르면 '현재 작업을 중단하겠냐'고
 * 묻고, 확인하면 업데이트하고 껐다 켜지면서 자동으로 이어서 시작하던데".
 *
 * Measured before this (isolated app, fake CLI, 2026-09-28):
 * - the update button refused while a turn ran ("현재 작업이 끝나면 업데이트할 수 있어요"); it
 *   counted chat turns only, so automations/Alive/Science never blocked it;
 * - the owner's way out was to stop the turn, which cancelled a running Goal outright;
 * - a turn cut by the quit landed as `invoke_failed` / `invoke-threw` with no cause (reads as a
 *   crash), and nothing continued a plain chat turn after the restart.
 *
 * This module owns the parts that are not Electron wiring: the one-line description of the running
 * work, the resume ledger (armed before the handoff, consumed exactly once at the next launch), the
 * per-entry resume decision, and the continuation prompt. Main supplies census, checkpoint, install
 * and dispatch. The ledger is one-shot by construction: startup renames it away BEFORE any turn is
 * dispatched, so a crash during or after resume can never replay it.
 */
import fs from "node:fs";
import path from "node:path";
import type { McpInvocationRequest, UpdaterActionResult, UpdaterState } from "../../shared/types";

export const UPDATE_RESUME_LEDGER_SCHEMA = "agentlas.update-resume.v1" as const;
/** Continue only work interrupted recently; a ledger found days later is history, not intent. */
export const UPDATE_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Owner brief: cap the checkpoint wait at a few seconds, then proceed with leftovers marked. */
export const UPDATE_CHECKPOINT_CAP_MS = 5_000;

export type UpdateWorkKind = "chat" | "goal" | "team" | "automation" | "alive" | "science" | "remote";
/** Which recovery path continues this item after the restart. Only "update-resume" is dispatched here. */
export type UpdateWorkOwner = "update-resume" | "goal-checkpoint" | "automation" | "alive" | "science" | "mobile-recovery" | "none";

export type UpdateResumeRequest = Pick<McpInvocationRequest,
  "taskIntent" | "permissions" | "onePermissionMode" | "runtimeSelection" | "locale" | "oneMode">;

export interface UpdateWorkItem {
  kind: UpdateWorkKind;
  owner: UpdateWorkOwner;
  runId: string | null;
  chatId: string | null;
  title: string | null;
  request?: UpdateResumeRequest;
}

export interface UpdateResumeLedger {
  schemaVersion: typeof UPDATE_RESUME_LEDGER_SCHEMA;
  reason: "update_restart";
  armedAt: string;
  sourceVersion: string;
  targetVersion: string | null;
  items: UpdateWorkItem[];
}

export interface InvocationWorkFact {
  runId: string;
  chatId: string;
  oneMode: boolean;
  automaticGoalId: string | null;
  executionSource: string | null;
  workspaceSource: string | null;
  request: UpdateResumeRequest;
}

/** Classify one live invocation by who can continue it after the restart. */
export function classifyInvocationWork(fact: InvocationWorkFact, opts: { title: string | null; teamChild: boolean }): UpdateWorkItem {
  const base = { runId: fact.runId, chatId: fact.chatId, title: opts.title };
  if (fact.automaticGoalId) return { ...base, kind: "goal", owner: "goal-checkpoint" };
  if (fact.executionSource === "automation") return { ...base, kind: "automation", owner: "automation" };
  if (fact.executionSource === "alive") return { ...base, kind: "alive", owner: "alive" };
  if (fact.executionSource === "science" || fact.workspaceSource === "science") return { ...base, kind: "science", owner: "science" };
  if (fact.workspaceSource === "mobile-one") return { ...base, kind: "remote", owner: "mobile-recovery" };
  if (fact.executionSource || fact.workspaceSource) return { ...base, kind: "remote", owner: "none" };
  return { ...base, kind: opts.teamChild ? "team" : "chat", owner: "update-resume", request: fact.request };
}

const KIND_LABEL: Record<UpdateWorkKind, { ko: string; en: string }> = {
  chat: { ko: "대화", en: "Chat" },
  goal: { ko: "목표 작업", en: "Goal" },
  team: { ko: "팀원 작업", en: "Teammate task" },
  automation: { ko: "자동화", en: "Automation" },
  alive: { ko: "Alive", en: "Alive" },
  science: { ko: "Science 연구", en: "Science research" },
  remote: { ko: "원격 대화", en: "Remote chat" },
};

function clip(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? `${flat.slice(0, 23)}…` : flat;
}

/** One plain line naming what is running, e.g. "대화 ‘주간 보고서’ · 자동화 2개". No prompts, no ids. */
export function describeUpdateWork(items: readonly UpdateWorkItem[], locale: "ko" | "en"): string {
  const order: UpdateWorkKind[] = ["chat", "goal", "team", "automation", "alive", "science", "remote"];
  const parts: string[] = [];
  for (const kind of order) {
    const ofKind = items.filter((item) => item.kind === kind);
    if (!ofKind.length) continue;
    const label = KIND_LABEL[kind][locale];
    const titles = [...new Set(ofKind.map((item) => item.title?.trim()).filter((t): t is string => Boolean(t)))];
    if (ofKind.length === 1 && titles.length === 1) {
      parts.push(locale === "ko" ? `${label} ‘${clip(titles[0])}’` : `${label} “${clip(titles[0])}”`);
    } else {
      parts.push(locale === "ko" ? `${label} ${ofKind.length}개` : `${ofKind.length} ${label}${ofKind.length > 1 ? "s" : ""}`);
    }
  }
  return parts.join(" · ");
}

// ── ledger (userData/updater/update-resume.v1.json) ─────────────────────────

export function updateResumeLedgerPath(userDataPath: string): string {
  return path.join(userDataPath, "updater", "update-resume.v1.json");
}

function consumedLedgerPath(userDataPath: string): string {
  return path.join(userDataPath, "updater", "update-resume.v1.consumed.json");
}

/** Durable before the native handoff: write-temp + rename, owner-only. */
export function writeUpdateResumeLedger(userDataPath: string, ledger: UpdateResumeLedger): void {
  const file = updateResumeLedgerPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function isLedger(value: unknown): value is UpdateResumeLedger {
  const v = value as UpdateResumeLedger | null;
  return Boolean(v && typeof v === "object" && v.schemaVersion === UPDATE_RESUME_LEDGER_SCHEMA
    && v.reason === "update_restart" && typeof v.armedAt === "string" && Array.isArray(v.items));
}

/**
 * Take the armed ledger exactly once. The rename happens before anything is dispatched, so a
 * crash at any later point leaves nothing to replay ("resume is one-shot"). A damaged file is
 * moved aside the same way and yields nothing.
 */
export function consumeUpdateResumeLedger(userDataPath: string): UpdateResumeLedger | null {
  const file = updateResumeLedgerPath(userDataPath);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  try { fs.renameSync(file, consumedLedgerPath(userDataPath)); }
  catch { return null; } // Cannot guarantee one-shot → do not resume at all.
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLedger(parsed) ? parsed : null;
  } catch { return null; }
}

/** Append what startup did with each entry to the consumed copy (diagnostics only). */
export function recordUpdateResumeOutcome(userDataPath: string, outcome: unknown): void {
  const file = consumedLedgerPath(userDataPath);
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...current, outcome }, null, 2), { mode: 0o600 });
  } catch { /* diagnostics only */ }
}

// ── resume decision + prompt ───────────────────────────────────────────────

export interface ResumeEntryFacts {
  chatExists: boolean;
  chatActive: boolean;
  latestRunId: string | null;
  latestStatus: string | null;
  /** A person wrote in this chat after the update was armed: their new direction wins. */
  newerUserMessage: boolean;
}

export type ResumeDecision = { resume: true } | { resume: false; reason: string };

export function decideUpdateResume(ledger: UpdateResumeLedger, item: UpdateWorkItem, facts: ResumeEntryFacts, nowMs: number): ResumeDecision {
  if (item.owner !== "update-resume" || !item.runId || !item.chatId) return { resume: false, reason: `owned-by-${item.owner}` };
  const armed = Date.parse(ledger.armedAt);
  if (!Number.isFinite(armed) || nowMs - armed > UPDATE_RESUME_MAX_AGE_MS) return { resume: false, reason: "ledger-expired" };
  if (!facts.chatExists) return { resume: false, reason: "chat-missing" };
  if (facts.chatActive) return { resume: false, reason: "chat-already-running" };
  if (facts.latestRunId !== item.runId) return { resume: false, reason: "newer-run-exists" };
  if (facts.latestStatus === "completed") return { resume: false, reason: "finished-before-quit" };
  if (facts.latestStatus === "running" || facts.latestStatus === "cancelling") return { resume: false, reason: "receipt-not-settled" };
  if (facts.newerUserMessage) return { resume: false, reason: "newer-user-direction" };
  return { resume: true };
}

/**
 * The continuation turn's own instructions (system-authored, never shown as the person's words).
 * Effect rule (d99a8fd8 / 56a241b6): the interrupted turn's own receipt answers first. A closed
 * ledger whose every call is provably read-only settled nothing outside, so the turn simply
 * continues; anything unproven is named so it is checked, never blindly repeated, and never
 * handed to the owner as "could not confirm".
 */
export function updateResumePrompt(input: { readOnlyByReceipt: boolean; uncertainCalls: readonly string[] }): string {
  const lines = [
    "Agentlas restarted to install an update while you were working on the latest request in this conversation.",
    "Continue that same request from where it stopped and finish it. Do not start over and do not ask the person to repeat it.",
  ];
  if (input.readOnlyByReceipt) {
    lines.push("Your interrupted turn only observed (every recorded call was read-only by the host's own receipt), so nothing outside changed. Continue normally.");
  } else if (input.uncertainCalls.length > 0) {
    lines.push(`Before repeating any of these calls from the interrupted turn, check whether they already took effect: ${input.uncertainCalls.slice(0, 8).join(", ")}.`,
      "Never repeat an outward action only because its result was not seen.");
  } else {
    lines.push("Check the current state before repeating any outward action from the interrupted turn.");
  }
  lines.push("Do not mention the update or the restart unless the person asks.");
  return lines.join("\n");
}

// ── IPC host (install / later) ─────────────────────────────────────────────

export interface UpdateResumeHost {
  state(): UpdaterState;
  census(): UpdateWorkItem[];
  locale(): "ko" | "en";
  /** Install with nothing running (the shipped path). */
  install(): Promise<UpdaterActionResult>;
  /** Pause the running work for the update (ledger + typed stop), bounded by UPDATE_CHECKPOINT_CAP_MS. */
  checkpoint(items: UpdateWorkItem[]): Promise<void>;
  /** The checkpoint closed this process's admission; a refused handoff must not strand it. */
  restartAfterRefusedHandoff(): void;
}

let host: UpdateResumeHost | null = null;
let deferredVersion: string | null = null;

export function configureUpdateResumeHost(value: UpdateResumeHost | null): void {
  host = value;
}

/** [나중에] was chosen for this downloaded version: the next quit installs and work resumes after. */
export function updateInstallDeferredForVersion(version: string | undefined): boolean {
  return Boolean(version && deferredVersion === version);
}

export async function requestUpdaterInstall(options: { resumeWork?: boolean } | undefined, fallback: () => Promise<UpdaterActionResult>): Promise<UpdaterActionResult> {
  if (!host) return fallback();
  const items = host.census();
  if (items.length === 0) return host.install();
  if (options?.resumeWork !== true) {
    return {
      accepted: false,
      state: host.state(),
      blockedBy: "active-runs",
      activeRunCount: items.length,
      activeWorkLine: describeUpdateWork(items, host.locale()),
    };
  }
  // Stop nothing unless a downloaded update is actually waiting to be installed.
  const state = host.state();
  if (state.status !== "downloaded" || !state.version) {
    return { accepted: false, state, blockedBy: "active-runs", activeRunCount: items.length };
  }
  await host.checkpoint(items);
  const result = await host.install();
  if (!result.accepted) host.restartAfterRefusedHandoff();
  return result;
}

export function deferUpdaterInstall(): UpdaterActionResult {
  const state = host?.state() ?? { status: "idle" as const };
  if (state.status !== "downloaded" || !state.version) return { accepted: false, state };
  deferredVersion = state.version;
  return { accepted: true, state, deferred: true };
}
