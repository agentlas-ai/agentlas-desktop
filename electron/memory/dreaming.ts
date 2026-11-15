// 유휴 드리밍 큐레이션 — Claude Code/Codex의 "드리밍"처럼, 사용자가 자리를 비운 유휴 시간에
// 큐레이터가 쌓아둔 durable 메모리를 정리한다. 1단계는 결정론 dedup(무LLM), 2단계는 메모리가
// 많이 쌓인 에이전트에 한해 LLM 1회 호출로 규칙 통합.
//
// 과부하 금지 가드(전부 만족해야 발화):
//   · 기본 ON — 저장된 ON/OFF 선택은 유지 (meta "memory_dreaming_enabled")
//   · 시스템 유휴 ≥ 10분(powerMonitor) · 실행 슬롯 완전 유휴(inUse=0, queued=0)
//   · 동시 1패스 · 사용자가 돌아오면(유휴 리셋) 즉시 abort
//   · No periodic wake: a pass is opened by a memory change (store revision or forget epoch differs from the last finished
//     pass) and starts on a signal once the machine is idle. Unchanged memory schedules nothing (see dreamingDueAt).
//   · LLM 호출은 다른 백그라운드 판정과 같은 판정 경로(callConnectedModelDetailed, 무도구) 경유 →
//     설정된 오케스트레이터 판정 풀(없으면 활성 오케스트레이터 고정), 모델·노력 지정, 전역 동시성 예산 상속
import { homeCauseEnded } from "../one/home-signal";
import { dreamingIdleRequiredSec } from "./curator-rules";
import { memoryStoreCeiling } from "./classification";
import { memoryActorKind } from "../../shared/memory-ownership";
import { powerMonitor } from "electron";
import { getMeta, setMeta } from "../store/meta";
import { runSlotStats } from "../runtime/run-slots";
import { detectRuntimes } from "../runtime/detect";
import { pickActive } from "../runtime/selection";
import { withModelCallScope } from "../runtime/model-call-ledger";
import { withRunnerSettlementObserver } from "../runtime/observed-runner";
import { selectionForRuntime } from "../../shared/runtime-selection";
import type { RuntimeSelection } from "../../shared/types";
import {
  dedupExactDuplicateMemories,
  supersedeLegacyRequestEchoMemories,
  listAgentIdsWithLiveMemory,
  listGlobalMemoryForAgent,
  subStoresFingerprint,
  type MemoryEntry,
} from "./store";
import { MemoryRevokedError } from "./revocations";
import { originEvidenceRefs, runEvidenceRefs } from "./run-evidence";
import {
  agentNestExperienceOwnership,
  reconcileAgentNestExperienceConsolidation,
} from "./project-files";
import { getAgentById } from "../mcp/registry";
import { createHash, randomUUID } from "node:crypto";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { assertMemorySourceCustody, currentMemorySourceCustody, withIndependentMemoryWorker } from "./source-custody";
import { onMemoryWritten } from "./memory-written-signal";
import { createIdleJob, idleSecondsOrAppQuiet, type IdleJob } from "./idle-job";
import { memoryMoveActive, onMemoryMoveIdle } from "../migration/gate";
import { applyConsolidationRules, gatherDueAt, gatherDueState, gatheringEnabled, runGatheringPass, type GatherModelResult } from "./gathering";
import {
  callConnectedModelDetailed,
  configuredOrchestratorJudgmentPolicy,
  connectedModelTimeoutMs,
  type JudgmentRuntimeAttempt,
  type JudgmentRuntimeReceipt,
  type JudgmentSelectionPolicy,
} from "../system-agents/judgment";
import type { RunnerFailure } from "../runtime/runner";

const DREAM_POLICY = "agentlas.dreaming-source.v1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function dreamingDb(): ReturnType<typeof getMemoryDb> {
  const db = getMemoryDb();
  db.exec(`CREATE TABLE IF NOT EXISTS memory_dreaming_sources (
    scope_key TEXT NOT NULL,input_digest TEXT NOT NULL,intake_epoch INTEGER NOT NULL,
    state TEXT NOT NULL,lease_token TEXT,lease_expires_at TEXT,result_json TEXT,
    completed_at TEXT,PRIMARY KEY(scope_key,input_digest,intake_epoch));
    CREATE TABLE IF NOT EXISTS memory_dreaming_clock (
      id INTEGER PRIMARY KEY CHECK(id=1),intake_epoch INTEGER NOT NULL,
      authority_revision INTEGER NOT NULL,completed_at TEXT NOT NULL);`);
  return db;
}
function sourceDigest(entries: MemoryEntry[], ownership: Record<string, string[]>): string {
  const db = getMemoryDb();
  const sources = entries.map(entry => ({ entry, projectionOwners: ownership[entry.id] ?? [],
    binding: db.prepare("SELECT * FROM memory_identity_bindings WHERE memory_id=?").get(entry.id) ?? null,
    projects: db.prepare("SELECT project_id,relation,source_ref FROM memory_project_links WHERE memory_id=? ORDER BY project_id,relation,source_ref").all(entry.id),
    native: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entry_native'").get()
      ? db.prepare("SELECT content_native FROM memory_entry_native WHERE entry_id=?").get(entry.id) ?? null : null,
  })).sort((a,b) => a.entry.id.localeCompare(b.entry.id));
  return digest([DREAM_POLICY, sources]);
}
const WINDOW_LINES = 60;
/**
 * K3'-2a (change 2): the window's rules are written through the ticket door (gathering.ts applyConsolidationRules), and that door does not let a model's consolidation replace a line the OWNER said (origin `user`: only the
 * owner's own words change those,) nor write a rule less sensitive than the lines it replaces (a ticket line is `internal`). Such lines are not offered to the window's judgment; they are not merged by it.
 */
function consolidatable(entry: MemoryEntry): boolean { return entry.originClass !== "user" && entry.sensitivity !== "private" && entry.sensitivity !== "confidential"; }
/** The window `offset` lines back from the newest. Offset 0 is the window a pass always looked at; older ones are looked at only for a store at its ceiling (memory B4). */
function selectedDreamingSources(agentId: string, offset = 0): { entries: MemoryEntry[]; ownership: Record<string, string[]>; group: string } | null {
  const all = listGlobalMemoryForAgent(agentId, offset + WINDOW_LINES).slice(offset).filter(entry => entry.scope === "agent_repo" && entry.agentId === agentId && consolidatable(entry));
  const ownership = agentNestExperienceOwnership(all.map(entry => entry.id));
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of all) { const key = JSON.stringify([...(ownership[entry.id] ?? [])].sort());
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group); }
  const selected = [...groups].sort((a,b) => b[1].length-a[1].length || a[0].localeCompare(b[0])).find(([,rows])=>rows.length>=8);
  return selected ? { entries: selected[1], ownership, group: selected[0] } : null;
}

const ENABLED_KEY = "memory_dreaming_enabled";
const LAST_AT_KEY = "memory_dreaming_last_at";
// Timing lives in the shared ruleset so both surfaces age memory alike.
const IDLE_REQUIRED_SEC = dreamingIdleRequiredSec();
// Spacing between passes that left work behind (two agents a pass), the delay of the start-up look, and the base of the failure back-off.
const TICK_MS = 5 * 60 * 1000;
// A pass whose model call failed backs off (5 min, doubling, six-hour cap) so a
// down judgment path is probed once per interval. The streak and the failure's
// machine code persist in meta: an app restart (several a day during releases)
// must not restart the probing at five minutes. After DREAMING_FAILURE_LIMIT
// failures in a row (the waits before them add up to about eleven hours) nothing is tried again until memory changes.
const FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60_000;
const FAILURE_KEY = "memory_dreaming_failure";
export const DREAMING_FAILURE_LIMIT = 8;
/** Curation retry repair 4. A window (an agent's lines, newest 60) whose judgment failed this many times because of the window itself is skipped, so the pass goes on to the agents behind it; the
 * window is looked at again when its lines change (its source digest is part of the row key, so a changed store is a new row with no count). */
const WINDOW_FAIL_LIMIT = 3;
const WINDOW_TIMEOUT_CODE = "dreaming_judgment_timeout";
/** `fails`: failures that say something about this window (an answer that came back unusable, or a failure while the model was answering other calls); `tries`: every failure, only to look at a window that has not failed first. */
function windowCounts(resultJson: string | null | undefined): { fails: number; tries: number } {
  try { const value = JSON.parse(resultJson ?? "null") as { fails?: unknown; tries?: unknown } | null; return { fails: Number(value?.fails) || 0, tries: Number(value?.tries) || 0 }; } catch { return { fails: 0, tries: 0 }; }
}
export const dreamingFailureBackoffMs = (streak: number): number =>
  Math.min(FAILURE_BACKOFF_CAP_MS, TICK_MS * 2 ** Math.max(0, Math.min(streak, 20) - 1));

/** Content-free cause of a failed pass: machine codes and route identity only, never prose or memory text. */
export interface DreamingFailureCause {
  code: string;
  /** The runner's own returned typed code when the observed-runner boundary reported it as runtime_turn_unsettled. */
  causeCode?: string;
  failureKind?: string;
  /** Constructor name of an untyped thrown error (TypeError, SqliteError ...), never its message. */
  errorName?: string;
  route?: JudgmentRuntimeReceipt["route"];
  runtimeKind?: string;
  execution?: JudgmentRuntimeReceipt["execution"];
}
interface DreamingFailureRecord extends DreamingFailureCause { schemaVersion: "agentlas.dreaming-failure.v1"; failures: number; until: number;
  /** The store the pass failed on (absent in records written by earlier builds): the give-up lasts until one of them changes. */
  revision?: number; epoch?: number;
  /** The sub-store fingerprint the pass failed on (layout switch on only; "" or absent otherwise): a give-up also ends when an agent's or project's own store changes (memory D2). */
  stores?: string }
const machineCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value) ? value : undefined;
class DreamingJudgmentFailure extends Error {
  constructor(readonly failureCause: DreamingFailureCause) { super(failureCause.code); this.name = "DreamingJudgmentFailure"; }
}
function readDreamingFailure(): DreamingFailureRecord | null {
  try {
    const raw = getMeta(FAILURE_KEY);
    const value = raw ? JSON.parse(raw) as Partial<DreamingFailureRecord> : null;
    return value && Number.isSafeInteger(value.failures) && Number.isFinite(value.until) && typeof value.code === "string"
      ? value as DreamingFailureRecord : null;
  } catch { return null; }
}
function errorFailureCause(error: unknown): DreamingFailureCause {
  if (error instanceof DreamingJudgmentFailure) return error.failureCause;
  const code = machineCode((error as { code?: unknown } | null)?.code) ?? machineCode(error instanceof Error ? error.message : undefined);
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : undefined;
  return { code: code ?? "dreaming_pass_failed", ...(errorName ? { errorName } : {}) };
}
/**
 * The judgment path's typed outcome, reduced to machine identifiers. `returned` is the last runner's own returned
 * failure: observed-runner.ts reports a returned failure without a completed terminal as runtime_turn_unsettled, which
 * is all the judgment receipt then says (production: codex_no_tools_model_required was visible nowhere).
 */
function judgmentFailureCause(detailed: { text: string | null; failure?: RunnerFailure;
  runtimeReceipt?: JudgmentRuntimeReceipt; attempts?: JudgmentRuntimeAttempt[] }, returned?: RunnerFailure): DreamingFailureCause {
  const last = detailed.attempts?.at(-1);
  const failure = detailed.failure;
  const code = detailed.text !== null || last?.outcome === "invalid_output" ? "dreaming_result_invalid"
    : machineCode(failure?.providerCode) ?? machineCode(failure?.message) ?? (failure ? `judgment_${failure.kind}` : "dreaming_judgment_unavailable");
  const causeCode = machineCode(returned?.providerCode);
  const receipt = detailed.runtimeReceipt;
  return { code, ...(causeCode && causeCode !== code ? { causeCode } : {}), ...(failure ? { failureKind: failure.kind } : {}),
    ...(receipt ? { route: receipt.route, runtimeKind: receipt.selection.kind, execution: receipt.execution } : {}) };
}
/** The custody fence refused the pass because the store's revocation epoch moved (typed code, never the message). */
function isCustodyMovedByOwner(error: unknown): boolean {
  return machineCode((error as { code?: unknown } | null)?.code) === "memory_source_custody_changed"
    || (error instanceof Error && error.message === "memory_source_custody_changed");
}
/** Returns whether the back-off record was stored. When it was not (a store that cannot be written), nothing bounds the retries from disk. */
function recordDreamingFailure(cause: DreamingFailureCause, stage: "consolidation" | "pass"): boolean {
  const failures = (readDreamingFailure()?.failures ?? 0) + 1;
  const backoffMs = dreamingFailureBackoffMs(failures);
  let store: { revision?: number; epoch?: number; stores?: string } = {};
  try { const info = getMemoryStoreInfo(); store = { revision: info.revision, epoch: info.revocationEpoch, ...(subStoresFingerprint() ? { stores: subStoresFingerprint() } : {}) }; } catch { /* The record still bounds the retries by time. */ }
  const record: DreamingFailureRecord = { schemaVersion: "agentlas.dreaming-failure.v1", ...cause, failures, until: Date.now() + backoffMs, ...store };
  let stored = true;
  try { setMeta(FAILURE_KEY, JSON.stringify(record)); } catch { stored = false; /* The log line below still names the cause. */ }
  console.error(`[dreaming] ${stage} failed`, JSON.stringify({ ...cause, failures, backoffMs }));
  return stored;
}
/**
 * Same route as the other background judgments (criterion-proof classificationRoute, strategy reflection): the
 * configured orchestrator judgment pool, else the active orchestrator runtime as an exact pin. Either way the call
 * carries the selection's model and effort. Production 1.3.43-1.3.48 (2026-10-15 23:05Z on): the raw active runner got
 * no model, so the Codex no-tools judgment lane refused it (codex_no_tools_model_required) before any process started.
 */
async function dreamingJudgmentRoute(): Promise<{ selectionPolicy: JudgmentSelectionPolicy } | { runtimeSelection: RuntimeSelection } | null> {
  const selectionPolicy = configuredOrchestratorJudgmentPolicy();
  if (selectionPolicy) return { selectionPolicy };
  const active = pickActive(await detectRuntimes());
  return active ? { runtimeSelection: selectionForRuntime(active) } : null;
}
const MAX_AGENTS_PER_PASS = 2; // 한 번의 드리밍에서 LLM 통합할 에이전트 수 상한
// A group that was already judged is asked again only after this many lines were added to it since that answer. The group
// itself needs 8 lines to be asked at all; fewer than half of that new rarely finds anything to merge, and a group the model
// called clean (rules: []) would otherwise cost a call for every single new line. A group never judged, or judged in an
// earlier forget epoch, is asked at once.
const MIN_NEW_LINES = 4;
function newLinesSinceAnswer(db: ReturnType<typeof dreamingDb>, scope: string, epoch: number, entries: MemoryEntry[]): number {
  const row = db.prepare("SELECT MAX(completed_at) AS at FROM memory_dreaming_sources WHERE scope_key=? AND intake_epoch=? AND state='completed'")
    .get(scope, epoch) as { at: string | null } | undefined;
  if (!row?.at) return Number.POSITIVE_INFINITY;
  return entries.filter(entry => String(entry.createdAt) > row.at!).length;
}
const LLM_TIMEOUT_MS = 300_000;

export function getDreamingEnabled(): boolean {
  const stored = getMeta(ENABLED_KEY);
  return stored === null || stored === "1";
}

const ENABLED_SET_BY_KEY = "memory_dreaming_enabled_set_by";

/**
 * New installations default to ON. Preserve every stored choice: older UI
 * toggles did not update provenance, so even an automatic marker cannot prove
 * that a legacy OFF was not the user's decision.
 */
export function ensureDreamingDefault(): void {
  if (getMeta(ENABLED_KEY) !== null) return;
  setMeta(ENABLED_KEY, "1");
  setMeta(ENABLED_SET_BY_KEY, "default-on");
}

export function setDreamingEnabled(enabled: boolean): void {
  setMeta(ENABLED_KEY, enabled ? "1" : "0");
  // Provenance for later migrations: without it a stored "0" could not be told
  // apart from an automatic write, and an explicit user OFF must never be revived.
  setMeta(ENABLED_SET_BY_KEY, "user");
  // Switched on: look now instead of at the next memory change.
  if (enabled) dreamingJob?.wake();
}

export interface DreamingStatus {
  enabled: boolean;
  lastRunAt: string | null;
  running: boolean;
}

let running = false;
let dreamingJob: IdleJob | null = null;
/** In memory: the earliest start of the next pass after one that left work behind. A restart simply looks again. */
let notBefore = 0;
/** In memory: the sub-store fingerprint taken when the last finished pass began (see dreamingDueAt). */
let storesSeenByLastPass: string | null = null;

export function strictestMemorySensitivity(
  entries: Array<Pick<MemoryEntry, "sensitivity">>,
): MemoryEntry["sensitivity"] {
  const rank: Record<MemoryEntry["sensitivity"], number> = {
    public: 0,
    internal: 1,
    private: 2,
    confidential: 3,
    secret: 4,
  };
  return entries.reduce<MemoryEntry["sensitivity"]>(
    (strictest, entry) => rank[entry.sensitivity] > rank[strictest]
      ? entry.sensitivity
      : strictest,
    "public",
  );
}

export function getDreamingStatus(): DreamingStatus {
  return { enabled: getDreamingEnabled(), lastRunAt: getMeta(LAST_AT_KEY) || null, running };
}

export function startDreamingScheduler(): void {
  if (dreamingJob) return;
  // Not gated on dreaming being on: these rows are wrong data, not a consolidation choice.
  setTimeout(() => {
    try {
      const retired = supersedeLegacyRequestEchoMemories();
      if (retired > 0) console.log(`[memory] superseded ${retired} legacy request-echo entries`);
    } catch (err) { console.warn("[memory] legacy request-echo cleanup deferred:", err instanceof Error ? err.message : err); }
  }, 60_000).unref?.();
  // Signals: the start-up look, a run slot freed, a chat or runtime change from any process, the curator writing memory
  // in this process, waking from sleep, and the switch being turned on.
  lastPassAt = Date.now(); // the six hours of "no pass" are counted from the scheduler's start or its last pass
  dreamingJob = createIdleJob({
    due: () => dreamingDueAt(),
    waitMs: () => { const idle = idleSeconds(); return idle < IDLE_REQUIRED_SEC ? Math.max(1_000, (IDLE_REQUIRED_SEC - idle) * 1_000) : 0; },
    pass: runDreamingPass,
    signals: [onMemoryWritten, (wake) => onMemoryMoveIdle(wake)],
  });
  dreamingJob.start(TICK_MS);
}

/** Tests only: forget the in-memory spacing and the sub-store fingerprint of the last pass (a restart does the same). */
export function resetDreamingStateForTests(): void { notBefore = 0; storesSeenByLastPass = null; lastPassAt = Date.now(); }

export function stopDreamingScheduler(): void {
  dreamingJob?.stop();
  dreamingJob = null;
}

/** When a pass of this process last finished (or the process started): after six hours without one, the app's own quiet counts as idle (idle-job.ts idleSecondsOrAppQuiet; desktop 3, B3). */
let lastPassAt = Date.now();
function idleSeconds(): number {
  let system = 0;
  try {
    system = powerMonitor.getSystemIdleTime();
  } catch {
    system = 0; // powerMonitor 불가 환경 — 유휴 아님으로 취급(발화 안 함)
  }
  return idleSecondsOrAppQuiet(system, lastPassAt);
}

/**
 * When the next pass may start: 0 (as soon as the machine is idle), a later time (failure back-off, spacing after a pass
 * that left work behind), or null when there is nothing new: memory has not changed since the last finished pass, or the
 * pass failed DREAMING_FAILURE_LIMIT times in a row on this same memory. A few single-row reads; no writes.
 */
function consolidationDueAt(now: number): number | null {
  // Agentlas 2.0 while the first-run migration deletes or moves rows, a pass that rewrites rows stands aside; the end of the move wakes the job.
  if (memoryMoveActive()) return null;
  return withIndependentMemoryWorker(() => {
    const store = getMemoryStoreInfo();
    const backoff = readDreamingFailure();
    if (backoff) {
      // The give-up holds while the root's ledger AND the sub-stores' fingerprint are the ones the last failure saw: with the layout switch on an agent's lines do not move the root revision.
      if (backoff.failures >= DREAMING_FAILURE_LIMIT && backoff.revision === store.revision && backoff.epoch === store.revocationEpoch && (backoff.stores ?? "") === subStoresFingerprint()) return null;
      // A wall-clock step backwards cannot stretch the wait past the six-hour cap.
      if (now < backoff.until && backoff.until - now <= FAILURE_BACKOFF_CAP_MS) return Math.max(backoff.until, notBefore);
    }
    const clock = dreamingDb().prepare("SELECT intake_epoch,authority_revision FROM memory_dreaming_clock WHERE id=1").get() as {
      intake_epoch: number; authority_revision: number } | undefined;
    // A source mutation, correction, forget or owner switch opens the pass; the clock holds the store the last finished pass saw.
    // Layout switch on: the agents' and projects' lines live in other files whose writes do not move the root revision, so those files' stat fingerprint must match the one the last
    // finished pass saw too (kept in memory — a restart looks once more). Switch off: "" and this is the line it always was.
    if (clock && clock.intake_epoch === store.revocationEpoch && clock.authority_revision === store.revision) {
      const stores = subStoresFingerprint();
      if (stores === "" || stores === storesSeenByLastPass) return null;
    }
    return notBefore > now ? notBefore : 0;
  });
}

export function dreamingDueAt(now = Date.now()): number | null {
  if (!getDreamingEnabled()) return null;
  // Agentlas 2.0 while the first-run migration deletes or moves rows, a pass that rewrites rows stands aside; the end of the move wakes the job.
  if (memoryMoveActive()) return null;
  const consolidation = consolidationDueAt(now);
  // K3': the pile of turn records the resting-time gathering reads (gathering.ts). A pile does not move the store revision, so it is read on its own: a few single-row reads, no writes after the first look.
  let gathering: number | null = null;
  if (gatheringEnabled()) { try { gathering = withIndependentMemoryWorker(() => gatherDueAt(gatherDueState(), now)); } catch { gathering = null; } }
  if (gathering === null) return consolidation;
  const gatherAt = Math.max(gathering, notBefore);
  return consolidation === null ? gatherAt : Math.min(consolidation, gatherAt);
}

/**
 * One pass, if the guards allow it now. True when stored state moved (a consolidation, the clock, a failure record), so the
 * due time is read again; false when nothing could be done (not idle, a run active, no model route, memory changed under it).
 */
export async function runDreamingPass(): Promise<boolean> {
  if (running) return false;
  // The same rule the scheduler reads: nothing new, or still backing off, is not a pass (whoever calls).
  const due = dreamingDueAt();
  if (due === null || due > Date.now()) return false;
  running = true;
  let moved = false;
  try {
    await withIndependentMemoryWorker(async () => {
      if (!getDreamingEnabled() || idleSeconds() < IDLE_REQUIRED_SEC) return;
      const slots = runSlotStats();
      if (slots.inUse > 0 || slots.queued > 0) return;
      const custody = currentMemorySourceCustody();
      assertMemorySourceCustody(custody);
      const db = dreamingDb();
      const backoff = readDreamingFailure();
      const storesAtStart = subStoresFingerprint();
      // K3' - the resting-time gathering comes first: the pile of turn records is read once, whoever wrote them, and written as the same tickets a model writes at the call (gathering.ts).
      // No model, an unreadable answer or a failed call is "skip, the next signal asks again" - no failure record, no count.
      if (gatheringEnabled()) {
        const gathered = await gatherTurnRecords(custody);
        if (gathered.moved) { moved = true; lastPassAt = Date.now(); setMeta(LAST_AT_KEY, new Date().toISOString()); }
        if (gathered.more) notBefore = Date.now() + TICK_MS;
      }
      const pass = await dreamOnce();
      // A stored failure moves the due time to its back-off. One that could not be stored counts as "nothing changed",
      // so the scheduler's own short ladder bounds the retries instead.
      if (pass.failure) { if (recordDreamingFailure(pass.failure, "consolidation")) moved = true; }
      else if (pass.completed && backoff) { try { setMeta(FAILURE_KEY, ""); } catch { /* Cleared on the next success. */ } }
      if (pass.completed) {
        moved = true;
        assertMemorySourceCustody(custody);
        lastPassAt = Date.now();
        setMeta(LAST_AT_KEY, new Date().toISOString());
      }
      if (pass.finished) {
        // Every agent was looked at and nothing is left: record the store this pass saw, so nothing runs until it changes.
        assertMemorySourceCustody(custody);
        const current = getMemoryStoreInfo();
        db.prepare("INSERT OR REPLACE INTO memory_dreaming_clock VALUES(1,?,?,?)").run(current.revocationEpoch, current.revision, new Date().toISOString());
        storesSeenByLastPass = storesAtStart;
        moved = true;
      } else if (pass.completed) {
        // More agents wait (two a pass) or the call was interrupted: the next pass keeps the five-minute spacing.
        notBefore = Date.now() + TICK_MS;
      }
    });
  } catch (err) {
    // The owner edited or forgot a memory entry while the pass ran: that is the owner's own action, not a failure. The pass
    // ends here and starts again against the new store on the next look (production memory_source_custody_changed).
    if (isCustodyMovedByOwner(err)) { console.info("[dreaming] pass yielded: memory changed while it ran; it starts again on its own"); return moved; }
    // A pass that throws outside one agent's consolidation backs off too, with its machine code only.
    if (recordDreamingFailure(errorFailureCause(err), "pass")) moved = true;
  } finally {
    running = false;
    homeCauseEnded("dreaming");   // (home D2): a move that waited for dreaming goes on (one signal, no timer)
  }
  return moved;
}

/** One gathering pass with the connected model (no tools), stopping the moment the owner comes back. Never throws for the model: the caller's custody fence is the only thing that propagates. */
async function gatherTurnRecords(custody: ReturnType<typeof currentMemorySourceCustody>): Promise<{ moved: boolean; more: boolean }> {
  const route = await dreamingJudgmentRoute();
  const timeoutMs = connectedModelTimeoutMs(LLM_TIMEOUT_MS);
  const controller = new AbortController();
  const watchdog = setInterval(() => { if (idleSeconds() < 30) controller.abort(); }, 30_000);
  watchdog.unref?.();
  try {
    const outcome = await runGatheringPass({
      call: route ? async (request): Promise<GatherModelResult> => {
        const detailed = await withModelCallScope({ role: "curator", phase: "gathering" }, () => callConnectedModelDetailed({
          systemPrompt: request.systemPrompt, input: request.input, timeoutMs, signal: controller.signal, locale: "en",
          // The turn records are untrusted material: the runner's enforced no-tools judgment lane only.
          requireNoTools: true, ...route, accept: request.accept,
        }));
        return { text: detailed.text, failure: detailed.failure };
      } : null,
      stopped: () => controller.signal.aborted || idleSeconds() < 30,
      assertCustody: () => assertMemorySourceCustody(custody),
    });
    if (outcome.calls > 0 || outcome.batches > 0 || outcome.blocked.length > 0) console.log("[gathering]", JSON.stringify({ calls: outcome.calls, batches: outcome.batches, ...outcome.counts, ...(outcome.failure ? { failure: outcome.failure.code } : {}), ...(outcome.blocked.length ? { blocked: outcome.blocked } : {}) }));
    return { moved: outcome.batches > 0, more: outcome.more };
  } catch (error) {
    // The owner changed memory while the pass ran: the pass yields (runDreamingPass says so). Anything else - a busy or unreadable store, a write that failed - is "skip, the next signal asks again":
    // no failure record and no count; a batch whose answer is already stored is finished from that answer, so nothing is asked twice.
    if (isCustodyMovedByOwner(error)) throw error;
    console.warn("[gathering] pass skipped:", errorFailureCause(error).code);
    return { moved: false, more: true };
  } finally { clearInterval(watchdog); }
}

/** `finished`: every agent was looked at and none is left for a later pass (false after an early return or a held lease). */
async function dreamOnce(): Promise<{ completed: boolean; failure?: DreamingFailureCause; finished?: boolean }> {
  const custody = currentMemorySourceCustody();
  assertMemorySourceCustody(custody);
  const origin = getMemoryStoreInfo();
  let completed = false, dispatched = 0, leftover = false;
  // 1단계 — 결정론 dedup(무LLM, 수 ms).
  const deduped = dedupExactDuplicateMemories();
  if (deduped > 0) console.log(`[dreaming] dedup: superseded ${deduped} duplicate entries`);

  // 2단계 — 메모리가 많이 쌓인 에이전트만 LLM 통합(패스당 상한).
  const targets = listAgentIdsWithLiveMemory(8);
  if (targets.length === 0) return { completed: false, finished: true };

  const route = await dreamingJudgmentRoute();
  if (!route) return { completed: false }; // 사용 가능한 런타임 없음 — 다음 기회에

  // Repair 4: an agent whose newest window failed before is looked at after the agents that did not, so one window that never answers cannot be the only one a pass ever reaches.
  // No failed row anywhere (the ordinary case): this reads one row and changes nothing.
  try {
    const failedRows = dreamingDb().prepare("SELECT 1 AS n FROM memory_dreaming_sources WHERE state='retry' AND intake_epoch=? LIMIT 1").get(origin.revocationEpoch);
    if (failedRows) {
      const tries = new Map<string, number>();
      for (const target of targets) {
        const first = selectedDreamingSources(target.agentId, 0);
        if (!first) continue;
        const row = dreamingDb().prepare("SELECT result_json FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=? AND state='retry'")
          .get(digest([origin.ownerNamespace, target.agentId, "agent_repo", first.group]), sourceDigest(first.entries, first.ownership), origin.revocationEpoch) as { result_json: string | null } | undefined;
        if (row) tries.set(target.agentId, windowCounts(row.result_json).tries);
      }
      targets.sort((a, b) => (tries.get(a.agentId) ?? 0) - (tries.get(b.agentId) ?? 0));
    }
  } catch { /* the order only decides who goes first */ }

  // Audit 62 (memory B4): a store at its ceiling takes no new line, so "four new lines since the answer" never comes and the same newest window would be the only one ever
  // looked at. Such a store is looked at window by window, newest first (the digest of an answered window keeps it from being asked twice); every other store keeps the one window.
  const jobs = targets.flatMap((target) => {
    const ceiling = memoryStoreCeiling("agent_repo", memoryActorKind(target.agentId));
    const atCeiling = Boolean(ceiling && target.count >= ceiling.rows);
    return Array.from({ length: atCeiling ? Math.ceil(target.count / WINDOW_LINES) : 1 }, (_, index) => ({ target, offset: index * WINDOW_LINES, atCeiling }));
  });
  for (const { target, offset, atCeiling } of jobs) {
    // 사용자가 돌아왔으면 즉시 중단 — 드리밍은 항상 양보한다.
    if (idleSeconds() < 30) return { completed };
    const agent = getAgentById(target.agentId);
    if (!agent) continue;
    if (dispatched >= MAX_AGENTS_PER_PASS) return { completed };
    assertMemorySourceCustody(custody);
    const selected = selectedDreamingSources(target.agentId, offset);
    if (!selected) continue;
    const { entries } = selected;
    const db = dreamingDb(), inputDigest = sourceDigest(entries, selected.ownership);
    const scope = digest([origin.ownerNamespace, target.agentId, "agent_repo", selected.group]);
    if (!atCeiling && newLinesSinceAnswer(db, scope, origin.revocationEpoch, entries) < MIN_NEW_LINES) continue;
    const timeoutMs = connectedModelTimeoutMs(LLM_TIMEOUT_MS);
    const lease = randomUUID(), leaseExpires = new Date(Date.now() + timeoutMs + 30_000).toISOString();
    const assertSource = () => {
      assertMemorySourceCustody(custody);
      const now = getMemoryStoreInfo();
      if (now.ownerNamespace !== origin.ownerNamespace || now.revocationEpoch !== origin.revocationEpoch) throw new Error("memory_source_custody_changed");
      const fresh = selectedDreamingSources(target.agentId, offset);
      if (!fresh || fresh.group !== selected.group || sourceDigest(fresh.entries, fresh.ownership) !== inputDigest) throw new Error("dreaming_source_changed");
    };
    let prior = { fails: 0, tries: 0 };
    const claimed = db.transaction(() => {
      assertSource();
      const previous = db.prepare("SELECT state,lease_expires_at,result_json FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
        .get(scope, inputDigest, origin.revocationEpoch) as { state: string; lease_expires_at: string | null; result_json: string | null } | undefined;
      if (previous?.state === "completed") return false;
      prior = windowCounts(previous?.result_json);
      // This window failed for itself WINDOW_FAIL_LIMIT times: not asked again until its lines change; the agents behind it are.
      if (previous?.state === "retry" && prior.fails >= WINDOW_FAIL_LIMIT) return false;
      // Another worker holds it (or crashed holding it): a later pass takes it when the lease ends.
      if (previous?.lease_expires_at && previous.lease_expires_at > new Date().toISOString()) { leftover = true; return false; }
      db.prepare(`INSERT INTO memory_dreaming_sources VALUES(?,?,?,'processing',?,?,NULL,NULL)
        ON CONFLICT(scope_key,input_digest,intake_epoch) DO UPDATE SET state='processing',lease_token=excluded.lease_token,
        lease_expires_at=excluded.lease_expires_at`).run(scope, inputDigest, origin.revocationEpoch, lease, leaseExpires);
      return true;
    }).immediate();
    if (!claimed) continue;
    dispatched++;
    const assertLease = () => {
      assertSource();
      const row = db.prepare("SELECT state,lease_token,lease_expires_at FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
        .get(scope, inputDigest, origin.revocationEpoch) as { state: string; lease_token: string; lease_expires_at: string } | undefined;
      if (!row || row.state !== "processing" || row.lease_token !== lease || row.lease_expires_at <= new Date().toISOString()) throw new Error("dreaming_lease_changed");
    };

    const controller = new AbortController();
    // The call's own time limit has its reason (a returning owner aborts without one): a limit that ran out is a failed judgment with a back-off, never "come back later" with nothing recorded.
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error(WINDOW_TIMEOUT_CODE)); }, timeoutMs);
    let onStopped: (() => void) | undefined;
    let failureCause: DreamingFailureCause | undefined;
    let windowFailure: { tries: number; fails: number } | undefined;
    // 유휴 이탈 감시 — 30초마다 확인, 사용자가 활동하면 즉시 abort.
    const watchdog = setInterval(() => {
      if (idleSeconds() < 30) controller.abort();
    }, 30_000);
    watchdog.unref?.();

    try {
      const numbered = entries
        .map((e, i) => `${i + 1}. [${e.kind}/${e.confidence}] ${e.content.replace(/\s+/g, " ").slice(0, 400)}`)
        .join("\n");
      const intakeEpoch = origin.revocationEpoch;
      assertLease();
      if (controller.signal.aborted) return { completed };
      const stopped = new Promise<never>((_resolve, reject) => {
        onStopped = () => reject(controller.signal.reason ?? new Error("memory_dreaming_cancelled"));
        controller.signal.addEventListener("abort", onStopped, { once: true });
      });
      let returnedFailure: RunnerFailure | undefined;
      // Diagnostic only: the last settled attempt's own returned failure; it never changes settlement or replay.
      const observeReturned = (provider: PromiseLike<unknown>) => { provider.then((value) => {
        returnedFailure = (value as { failure?: RunnerFailure } | null)?.failure; }, () => { returnedFailure = undefined; }); };
      const call = withModelCallScope({ role: "curator", phase: "dreaming" }, () => withRunnerSettlementObserver(observeReturned, () => callConnectedModelDetailed({
          systemPrompt: [
            "judgment: merge redundant or fragmentary memory entries into a few durable rules",
            'output: ONLY valid JSON {"rules": [{"text": "...", "kind": "procedure|fact|risk|preference|decision", "absorbed": [1,2]}], "absorbed": [1,2,...]}, no fences, no prose',
            "rules: max 5, one idea each, entries' language; procedure and risk rules state what holds for this agent's other work; one task's facts (counts, versions, file names, dates, run state) go in their own kind fact rule, never inside a procedure",
            "rule absorbed: the entry numbers that rule replaces; top-level absorbed: all of them",
            // The owner reads these rules in the agent's Learned panel. Internal run identifiers mean nothing to them.
            "rule text: owner-readable plain sentences (what the agent does, what to do next time); no internal ids (attempt/run/task ids, UUIDs, hashes, step tags such as t4); say \"an earlier attempt\" instead",
            "absorbed: entry numbers fully covered by the rules; never absorb an entry whose specifics are not preserved",
            "already clean and distinct: {\"rules\": [], \"absorbed\": []}",
          ].join("\n"),
          input: `Agent: ${agent.name}\nMemory entries:\n${numbered}`,
          timeoutMs,
          signal: controller.signal,
          locale: "en",
          // Memory text is untrusted source material: the runner's enforced no-tools judgment lane only.
          requireNoTools: true,
          ...route,
          // An unparseable reply is that candidate's failure; the next pool member may answer.
          accept: (text) => parseDreamingResult(text, entries.length) !== null,
        })));
      void call.catch(() => {});
      const detailed = await Promise.race([call, stopped]);
      if (controller.signal.aborted && !timedOut) return { completed };
      assertLease();
      const parsed = detailed.text === null ? null : parseDreamingResult(detailed.text, entries.length);
      if (!parsed) throw new DreamingJudgmentFailure(judgmentFailureCause(detailed, returnedFailure));
      const { rules, absorbed } = parsed;
      if (rules.length === 0) {
        db.transaction(() => { assertLease(); db.prepare("UPDATE memory_dreaming_sources SET state='completed',result_json=?,completed_at=?,lease_token=NULL,lease_expires_at=NULL WHERE scope_key=? AND input_digest=? AND intake_epoch=? AND lease_token=?")
          .run(JSON.stringify({ rules: [], absorbed: [] }), new Date().toISOString(), scope, inputDigest, origin.revocationEpoch, lease); }).immediate();
        completed = true; continue;
      }
      const absorbedEntries = [...new Set(absorbed)].map((n) => entries[n - 1]);
      // K3'-2a (change 2): the rules are written by the one write door - received as tickets (a `condense` of the lines a rule replaces, a `rewrite` of one, an `add` of none), so the secret, length, owner and kind rules, the two
      // host columns and the store routing are the door's, not this function's. A rule the door refuses is not written and its lines stay; the window is then answered (its digest is kept) and is not asked again until its lines change.
      // Not one transaction any more (the door has its own): a kill between two rules leaves the window unanswered, the next pass asks again, and a rule written twice is an exact duplicate the door merges.
      assertLease();
      // Between two rules the window's own lines have changed (the first rule wrote one and hid some), so the digest check of `assertLease` cannot hold any more; what must hold is the owner's custody (a forget or an edit
      // moves the epoch: the pass yields) and the lease.
      const assertOwnerCustody = () => {
        assertMemorySourceCustody(custody);
        const now = getMemoryStoreInfo();
        if (now.ownerNamespace !== origin.ownerNamespace || now.revocationEpoch !== origin.revocationEpoch) throw new Error("memory_source_custody_changed");
      };
      const assertLeaseHeld = () => {
        assertOwnerCustody();
        const row = db.prepare("SELECT state,lease_token,lease_expires_at FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
          .get(scope, inputDigest, origin.revocationEpoch) as { state: string; lease_token: string; lease_expires_at: string } | undefined;
        if (!row || row.state !== "processing" || row.lease_token !== lease || row.lease_expires_at <= new Date().toISOString()) throw new Error("dreaming_lease_changed");
      };
      const applied = applyConsolidationRules({
        agentId: target.agentId, entries, rules: rules.slice(0, 5), passAbsorbed: absorbed,
        assertCustody: assertOwnerCustody,
        evidenceFor: (own) => [
          `dreaming: consolidated ${own.length}/${entries.length} entries`,
          // The replaced entries' host references move to the rule, so consolidating does not erase what backed them.
          ...[...new Set(own.flatMap((entry) => runEvidenceRefs(entry.evidence ?? [])))],
          // Agentlas 2.0 P2: a rule made from a line that came from an instruction keeps that mark (none exists with the workspace-rules switch off).
          ...[...new Set(own.flatMap((entry) => originEvidenceRefs(entry.evidence ?? [])))],
        ],
      });
      db.transaction(() => {
        assertLeaseHeld();
        db.prepare("UPDATE memory_dreaming_sources SET state='completed',result_json=?,completed_at=?,lease_token=NULL,lease_expires_at=NULL WHERE scope_key=? AND input_digest=? AND intake_epoch=? AND lease_token=?")
          .run(JSON.stringify({ memoryIds: applied.writtenIds, absorbedIds: applied.absorbedIds, merged: applied.merged, refused: applied.refused, ...(applied.refusals.length ? { refusals: [...new Set(applied.refusals)].slice(0, 8) } : {}) }), new Date().toISOString(), scope, inputDigest, origin.revocationEpoch, lease);
      }).immediate();
      completed = true;
      const absorbedIds = applied.absorbedIds;
      // Keep the cross-project projection aligned with Desktop ownership. The
      // single-rule case has an unambiguous structural successor; multi-rule
      // consolidation retires stale sources without manufacturing pairwise
      // supersedes edges the LLM did not provide.
      const consolidated = applied.writtenLines.map((line) => ({ id: line.id, kind: line.kind, content: line.text, confidence: "medium" as const, sensitivity: "internal" as const, tags: undefined, updatedAt: new Date().toISOString() }));
      if (absorbedIds.length) reconcileAgentNestExperienceConsolidation(absorbedIds, consolidated);
      console.log(`[dreaming] agent ${agent.slug}: ${rules.length} rules from ${absorbed.length} entries -> ${applied.written} written, ${applied.merged} merged, ${applied.refused} refused`);
    } catch (err) {
      if (err instanceof MemoryRevokedError) {
        console.info("[dreaming] stale consolidation discarded after memory forget");
        leftover = true;
        continue;
      }
      // abort(사용자 복귀) — 조용히 다음 기회로. A time limit that ran out is not that: it is recorded below.
      if (controller.signal.aborted && !timedOut) return { completed };
      // Memory changed under the pass (the owner's edit or forget moved the custody epoch): not a failure, so no failure record
      // and no back-off. The source row is released for retry below and the next look consolidates the new store.
      if (isCustodyMovedByOwner(err)) { console.info("[dreaming] consolidation yielded: memory changed while it ran"); return { completed }; }
      failureCause = timedOut ? { code: WINDOW_TIMEOUT_CODE } : errorFailureCause(err);
      // Whose failure this is: the window's when the model answered and the answer cannot be used, or when the model was answering (the last pass cleared its failure streak, or an earlier
      // window of this pass completed). Otherwise the model's, which says nothing about this window.
      const forWindow = failureCause.code === "dreaming_result_invalid" || completed || (readDreamingFailure()?.failures ?? 0) === 0;
      windowFailure = { tries: prior.tries + 1, fails: prior.fails + (forWindow ? 1 : 0) };
      return { completed, failure: failureCause };
    } finally {
      // A failed/unavailable model or changed source is retryable, never a
      // successful processed digest. A peer reclaimed lease is untouched.
      // The retry row keeps the failure's machine code (no prose) next to the source digest.
      try { db.prepare("UPDATE memory_dreaming_sources SET state='retry',lease_token=NULL,lease_expires_at=NULL,result_json=COALESCE(?,result_json) WHERE scope_key=? AND input_digest=? AND intake_epoch=? AND state='processing' AND lease_token=?").run(failureCause ? JSON.stringify({ schemaVersion: "agentlas.dreaming-failure.v1", failure: failureCause, ...(windowFailure ?? {}) }) : null, scope, inputDigest, origin.revocationEpoch, lease); } catch { /* Old owner facade is fenced. */ }
      clearTimeout(timeout);
      clearInterval(watchdog);
      if (onStopped) controller.signal.removeEventListener("abort", onStopped);
    }
  }
  return { completed, finished: !leftover };
}

type DreamingRuleKind = "procedure" | "fact" | "risk" | "preference" | "decision";
const DREAMING_RULE_KINDS = new Set<DreamingRuleKind>(["procedure", "fact", "risk", "preference", "decision"]);
interface DreamingRule { text: string; kind?: DreamingRuleKind; absorbed?: number[] }
/** One validity rule for both the judgment's accept() and the write below. A rule is a string (older answers) or
 * {text, kind, absorbed}; a rule's own absorbed numbers must also be in the top-level list. */
function parseDreamingResult(text: string, entryCount: number): { rules: DreamingRule[]; absorbed: number[] } | null {
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.rules) || parsed.rules.length > 5) return null;
  const inRange = (n: unknown) => Number.isInteger(n) && Number(n) >= 1 && Number(n) <= entryCount;
  // The top-level list is the union of the rules' own lists; when a model gives only the per-rule lists the host
  // derives it (measured 2026-10-20: one of two Sonnet answers omitted it).
  const ruleLists = parsed.rules.map((rule) => rule && typeof rule === "object" && !Array.isArray(rule) ? (rule as Record<string, unknown>).absorbed : undefined);
  const topLevel = Array.isArray(parsed.absorbed) ? parsed.absorbed
    : parsed.absorbed === undefined && ruleLists.every(Array.isArray) ? [...new Set(ruleLists.flatMap((list) => list as unknown[]))] : null;
  if (!topLevel || !topLevel.every(inRange)) return null;
  const absorbed = topLevel.map((n) => Number(n));
  const rules: DreamingRule[] = [];
  for (const raw of parsed.rules) {
    const rule = typeof raw === "string" ? { text: raw } : raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!rule || typeof rule.text !== "string" || rule.text.length > 4_000) return null;
    if (!rule.text.trim()) continue;
    if (rule.kind !== undefined && !DREAMING_RULE_KINDS.has(rule.kind as DreamingRuleKind)) return null;
    if (rule.absorbed !== undefined && (!Array.isArray(rule.absorbed) || !rule.absorbed.every((n) => inRange(n) && absorbed.includes(Number(n))))) return null;
    rules.push({ text: rule.text, ...(rule.kind ? { kind: rule.kind as DreamingRuleKind } : {}),
      ...(Array.isArray(rule.absorbed) && rule.absorbed.length ? { absorbed: rule.absorbed.map((n) => Number(n)) } : {}) });
  }
  // Every retired source needs a successor. Rules without their own source
  // list retain the legacy pass-wide provenance used by the writer.
  const covered = new Set(rules.flatMap((rule) => rule.absorbed?.length ? rule.absorbed : absorbed));
  if (absorbed.some((n) => !covered.has(n))) return null;
  if ((rules.length === 0) !== (absorbed.length === 0)) return null;
  return { rules, absorbed };
}

function extractJson(text: string): { rules?: unknown; absorbed?: unknown } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { rules?: unknown; absorbed?: unknown };
  } catch {
    return null;
  }
}
