// 유휴 드리밍 큐레이션 — Claude Code/Codex의 "드리밍"처럼, 사용자가 자리를 비운 유휴 시간에
// 큐레이터가 쌓아둔 durable 메모리를 정리한다. 1단계는 결정론 dedup(무LLM), 2단계는 메모리가
// 많이 쌓인 에이전트에 한해 LLM 1회 호출로 규칙 통합.
//
// 과부하 금지 가드(전부 만족해야 발화):
//   · 기본 ON — 저장된 ON/OFF 선택은 유지 (meta "memory_dreaming_enabled")
//   · 시스템 유휴 ≥ 10분(powerMonitor) · 실행 슬롯 완전 유휴(inUse=0, queued=0)
//   · 쿨다운 6시간 · 동시 1패스 · 사용자가 돌아오면(유휴 리셋) 즉시 abort
//   · LLM 호출은 다른 백그라운드 판정과 같은 판정 경로(callConnectedModelDetailed, 무도구) 경유 →
//     설정된 오케스트레이터 판정 풀(없으면 활성 오케스트레이터 고정), 모델·노력 지정, 전역 동시성 예산 상속
import { dreamingCooldownMs, dreamingIdleRequiredSec } from "./curator-rules";
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
  insertMemoryEntry,
  listAgentIdsWithLiveMemory,
  listGlobalMemoryForAgent,
  supersedeMemoryEntries,
  type MemoryEntry,
} from "./store";
import { MemoryRevokedError } from "./revocations";
import { hostObservationRefs } from "./machine-observations";
import {
  agentNestExperienceOwnership,
  reconcileAgentNestExperienceConsolidation,
} from "./project-files";
import { getAgentById } from "../mcp/registry";
import { createHash, randomUUID } from "node:crypto";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { assertMemorySourceCustody, currentMemorySourceCustody, withIndependentMemoryWorker } from "./source-custody";
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
function selectedDreamingSources(agentId: string): { entries: MemoryEntry[]; ownership: Record<string, string[]>; group: string } | null {
  const all = listGlobalMemoryForAgent(agentId, 60).filter(entry => entry.scope === "agent_repo" && entry.agentId === agentId);
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
const COOLDOWN_MS = dreamingCooldownMs();
const TICK_MS = 5 * 60 * 1000; // 5분마다 조건 확인(조건 체크 자체는 ~0 비용)
// A pass whose model call failed backs off (5 min, doubling, six-hour cap) so a
// down judgment path is probed once per interval, not on every tick forever.
// The streak and the failure's machine code persist in meta: an app restart
// (several a day during releases) must not restart the probing at five minutes.
const FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60_000;
const FAILURE_KEY = "memory_dreaming_failure";
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
interface DreamingFailureRecord extends DreamingFailureCause { schemaVersion: "agentlas.dreaming-failure.v1"; failures: number; until: number }
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
function recordDreamingFailure(cause: DreamingFailureCause, stage: "consolidation" | "pass"): DreamingFailureRecord {
  const failures = (readDreamingFailure()?.failures ?? 0) + 1;
  const backoffMs = dreamingFailureBackoffMs(failures);
  const record: DreamingFailureRecord = { schemaVersion: "agentlas.dreaming-failure.v1", ...cause, failures, until: Date.now() + backoffMs };
  try { setMeta(FAILURE_KEY, JSON.stringify(record)); } catch { /* The log line below still names the cause. */ }
  console.error(`[dreaming] ${stage} failed`, JSON.stringify({ ...cause, failures, backoffMs }));
  return record;
}
/**




 */
async function dreamingJudgmentRoute(): Promise<{ selectionPolicy: JudgmentSelectionPolicy } | { runtimeSelection: RuntimeSelection } | null> {
  const selectionPolicy = configuredOrchestratorJudgmentPolicy();
  if (selectionPolicy) return { selectionPolicy };
  const active = pickActive(await detectRuntimes());
  return active ? { runtimeSelection: selectionForRuntime(active) } : null;
}
const MAX_AGENTS_PER_PASS = 2; // 한 번의 드리밍에서 LLM 통합할 에이전트 수 상한
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
}

export interface DreamingStatus {
  enabled: boolean;
  lastRunAt: string | null;
  running: boolean;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

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
  if (timer) return;
  // Not gated on dreaming being on: these rows are wrong data, not a consolidation choice.
  setTimeout(() => {
    try {
      const retired = supersedeLegacyRequestEchoMemories();
      if (retired > 0) console.log(`[memory] superseded ${retired} legacy request-echo entries`);
    } catch (err) { console.warn("[memory] legacy request-echo cleanup deferred:", err instanceof Error ? err.message : err); }
  }, 60_000).unref?.();
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
}

export function stopDreamingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function idleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0; // powerMonitor 불가 환경 — 유휴 아님으로 취급(발화 안 함)
  }
}

async function tick(): Promise<void> {
  if (running) return;
  const backoff = readDreamingFailure();
  // A wall-clock step backwards cannot stretch the wait past the six-hour cap.
  if (backoff && Date.now() < backoff.until && backoff.until - Date.now() <= FAILURE_BACKOFF_CAP_MS) return;
  running = true;
  try {
    await withIndependentMemoryWorker(async () => {
      if (!getDreamingEnabled() || idleSeconds() < IDLE_REQUIRED_SEC) return;
      const slots = runSlotStats();
      if (slots.inUse > 0 || slots.queued > 0) return;
      const custody = currentMemorySourceCustody();
      assertMemorySourceCustody(custody);
      const db = dreamingDb(), source = getMemoryStoreInfo();
      const clock = db.prepare("SELECT * FROM memory_dreaming_clock WHERE id=1").get() as {
        intake_epoch: number; authority_revision: number; completed_at: string } | undefined;
      // A source mutation, correction, forget or owner switch opens the pass;
      // unchanged per-scope digests still suppress model work independently.
      if (clock && clock.intake_epoch === source.revocationEpoch && clock.authority_revision === source.revision
        && Date.now() - Date.parse(clock.completed_at) < COOLDOWN_MS) {
        // Native wording/projection-owner metadata can change without the main
        // entry revision. A cooldown cannot hide a changed exact source set.
        const pending = listAgentIdsWithLiveMemory(8).some(target => {
          const selected = selectedDreamingSources(target.agentId);
          if (!selected) return false;
          const row = db.prepare("SELECT state,lease_expires_at FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
            .get(digest([source.ownerNamespace,target.agentId,"agent_repo",selected.group]), sourceDigest(selected.entries,selected.ownership), source.revocationEpoch) as { state: string; lease_expires_at: string | null } | undefined;
          return row?.state !== "completed" && (!row?.lease_expires_at || row.lease_expires_at <= new Date().toISOString());
        });
        if (!pending) return;
      }
      const pass = await dreamOnce();
      if (pass.failure) recordDreamingFailure(pass.failure, "consolidation");
      else if (pass.completed && backoff) { try { setMeta(FAILURE_KEY, ""); } catch { /* Cleared on the next success. */ } }
      const passDone = pass.completed;
      if (passDone) {
        assertMemorySourceCustody(custody);
        const current = getMemoryStoreInfo(), completedAt = new Date().toISOString();
        db.prepare("INSERT OR REPLACE INTO memory_dreaming_clock VALUES(1,?,?,?)").run(current.revocationEpoch, current.revision, completedAt);
        setMeta(LAST_AT_KEY, completedAt);
      }
    });
  } catch (err) {
    // A pass that throws outside one agent's consolidation backs off too, with its machine code only.
    recordDreamingFailure(errorFailureCause(err), "pass");
  } finally {
    running = false;
  }
}

async function dreamOnce(): Promise<{ completed: boolean; failure?: DreamingFailureCause }> {
  const custody = currentMemorySourceCustody();
  assertMemorySourceCustody(custody);
  const origin = getMemoryStoreInfo();
  let completed = false, dispatched = 0;
  // 1단계 — 결정론 dedup(무LLM, 수 ms).
  const deduped = dedupExactDuplicateMemories();
  if (deduped > 0) console.log(`[dreaming] dedup: superseded ${deduped} duplicate entries`);

  // 2단계 — 메모리가 많이 쌓인 에이전트만 LLM 통합(패스당 상한).
  const targets = listAgentIdsWithLiveMemory(8);
  if (targets.length === 0) return { completed: false };

  const route = await dreamingJudgmentRoute();
  if (!route) return { completed: false }; // 사용 가능한 런타임 없음 — 다음 기회에

  for (const target of targets) {
    // 사용자가 돌아왔으면 즉시 중단 — 드리밍은 항상 양보한다.
    if (idleSeconds() < 30) return { completed };
    const agent = getAgentById(target.agentId);
    if (!agent) continue;
    if (dispatched >= MAX_AGENTS_PER_PASS) return { completed };
    assertMemorySourceCustody(custody);
    const selected = selectedDreamingSources(target.agentId);
    if (!selected) continue;
    const { entries } = selected;
    const db = dreamingDb(), inputDigest = sourceDigest(entries, selected.ownership);
    const scope = digest([origin.ownerNamespace, target.agentId, "agent_repo", selected.group]);
    const timeoutMs = connectedModelTimeoutMs(LLM_TIMEOUT_MS);
    const lease = randomUUID(), leaseExpires = new Date(Date.now() + timeoutMs + 30_000).toISOString();
    const assertSource = () => {
      assertMemorySourceCustody(custody);
      const now = getMemoryStoreInfo();
      if (now.ownerNamespace !== origin.ownerNamespace || now.revocationEpoch !== origin.revocationEpoch) throw new Error("memory_source_custody_changed");
      const fresh = selectedDreamingSources(target.agentId);
      if (!fresh || fresh.group !== selected.group || sourceDigest(fresh.entries, fresh.ownership) !== inputDigest) throw new Error("dreaming_source_changed");
    };
    const claimed = db.transaction(() => {
      assertSource();
      const previous = db.prepare("SELECT state,lease_expires_at FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
        .get(scope, inputDigest, origin.revocationEpoch) as { state: string; lease_expires_at: string | null } | undefined;
      if (previous?.state === "completed" || (previous?.lease_expires_at && previous.lease_expires_at > new Date().toISOString())) return false;
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
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let onStopped: (() => void) | undefined;
    let failureCause: DreamingFailureCause | undefined;
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
      if (controller.signal.aborted) return { completed };
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
      // Supersede keeps the pointer, not just the count. The AMGB governed
      // reference (governance 1.000) deprecates with a retained value id —
      // "deprecate, never silent overwrite" — and a bare "consolidated 5/8"
      // sentence loses exactly that: nothing could ever answer which entries
      // this rule replaced. The ids are the provenance edge.
      const consolidated = db.transaction(() => {
        assertLease();
        // Each rule keeps its own kind and the entries it replaces when the judgment names them (a fact stays a fact; a
        // rule's provenance is its own sources, not the whole pass). Older string-only answers keep the pass-wide pointers.
        const consolidated = rules.slice(0, 5).map((rule) => {
          const own = rule.absorbed?.length ? [...new Set(rule.absorbed)].map((n) => entries[n - 1]) : absorbedEntries;
          return insertMemoryEntry({
            scope: "agent_repo",
            kind: rule.kind ?? "procedure",
            content: rule.text.trim(),
            agentId: target.agentId,
            confidence: "medium",
            sensitivity: strictestMemorySensitivity(own),
            intakeEpoch,
            curationActor: "model_curated", policyVersion: DREAM_POLICY,
            originRefs: own.map(entry => ({ kind: "source" as const, id: entry.id, revision: digest(entry) })),
            evidence: [
              `dreaming: consolidated ${own.length}/${entries.length} entries`,
              ...own.map((entry) => `supersedes:${entry.id}`),
              // The replaced entries' host references move to the rule, so consolidating does not erase what backed them.
              ...[...new Set(own.flatMap((entry) => hostObservationRefs(entry.evidence ?? [])))],
            ],
          });
        });
        supersedeMemoryEntries(absorbedEntries.map(entry => entry.id));
        db.prepare("UPDATE memory_dreaming_sources SET state='completed',result_json=?,completed_at=?,lease_token=NULL,lease_expires_at=NULL WHERE scope_key=? AND input_digest=? AND intake_epoch=? AND lease_token=?")
          .run(JSON.stringify({ memoryIds: consolidated.map(entry => entry.id), absorbedIds: absorbedEntries.map(entry => entry.id) }), new Date().toISOString(), scope, inputDigest, origin.revocationEpoch, lease);
        return consolidated;
      }).immediate();
      completed = true;
      const absorbedIds = absorbedEntries.map(entry => entry.id);
      // Keep the cross-project projection aligned with Desktop ownership. The
      // single-rule case has an unambiguous structural successor; multi-rule
      // consolidation retires stale sources without manufacturing pairwise
      // supersedes edges the LLM did not provide.
      reconcileAgentNestExperienceConsolidation(absorbedIds, consolidated.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        content: entry.content,
        confidence: entry.confidence,
        sensitivity: entry.sensitivity,
        tags: entry.requestContext?.triggerTerms,
        updatedAt: entry.createdAt,
      })));
      console.log(`[dreaming] agent ${agent.slug}: ${rules.length} rules from ${absorbed.length} entries`);
    } catch (err) {
      if (err instanceof MemoryRevokedError) {
        console.info("[dreaming] stale consolidation discarded after memory forget");
        continue;
      }
      // abort(사용자 복귀/타임아웃) 포함 — 조용히 다음 기회로.
      if (controller.signal.aborted) return { completed };
      failureCause = errorFailureCause(err);
      return { completed, failure: failureCause };
    } finally {
      // A failed/unavailable model or changed source is retryable, never a
      // successful processed digest. A peer reclaimed lease is untouched.
      // The retry row keeps the failure's machine code (no prose) next to the source digest.
      try { db.prepare("UPDATE memory_dreaming_sources SET state='retry',lease_token=NULL,lease_expires_at=NULL,result_json=COALESCE(?,result_json) WHERE scope_key=? AND input_digest=? AND intake_epoch=? AND state='processing' AND lease_token=?").run(failureCause ? JSON.stringify({ schemaVersion: "agentlas.dreaming-failure.v1", failure: failureCause }) : null, scope, inputDigest, origin.revocationEpoch, lease); } catch { /* Old owner facade is fenced. */ }
      clearTimeout(timeout);
      clearInterval(watchdog);
      if (onStopped) controller.signal.removeEventListener("abort", onStopped);
    }
  }
  return { completed };
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
  // derives it.
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
