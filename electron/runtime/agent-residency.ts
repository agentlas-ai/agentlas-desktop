// 에이전트 상주 등록소 — "지금 이 호스트 안에서 살아 있는 에이전트가 누구인가"의 단일 사실.
//
// ★왜 있나. 오너의 그림은 "One 과 Work 에이전트들이 앱이 켜져 있는 동안 유지된다"이다.
// 그 문장이 성립하려면 세 가지가 **같은 사실**을 봐야 한다:
//   (a) 상주 세션을 붙드는 쪽(ACP 세션 풀 — acp-session-pool.ts)
//   (b) 12시간 무입력 리퍼(데몬 keepAlive 스위퍼 / 앱)
//   (c) 스웜 예산(store/concurrency.getAgentConcurrency)
// 각자 자기 목록을 들고 있으면 언젠가 하나만 고쳐지고, 화면에는 "상주 중"인데 실제로는
// 죽어 있는(혹은 그 반대의) 상태가 조용히 성립한다. 그래서 등록소는 하나다.
//
// ★무엇을 들지 않는가. 이 파일은 프로세스를 죽이거나 세션을 여는 방법을 모른다 —
// 자원을 실제로 들고 있는 쪽이 `close` 를 함께 등록하고, 리퍼는 그것을 부를 뿐이다.
// 그래서 이 모듈은 Electron 도 store 도 import 하지 않는다(예산만 지연 조회한다).
//
// ★두 종류의 항목이 있다. 구분은 정직성 문제다:
//   · holdsSession=true  — 살아 있는 자원(ACP 세션/CLI 프로세스)을 실제로 붙들고 있다.
//   · holdsSession=false — 이번 턴에 그 에이전트가 돌았다는 **활동 기록**일 뿐이다.
//     network/cloud 로 소환된 에이전트(borrowed task force)의 로컬 서브런이 여기 들어온다.
//     상주 형태를 아직 못 가지는 런타임(일회성 `-p` CLI)을 "상주 중"이라고 말하지 않기
//     위해서다 — 예산은 붙든 것(holdsSession)만 센다.
import { onHostShutdown } from "../host-lifecycle";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentProcessLifecycleReason,
  AgentProcessState,
} from "../../shared/types";

/** Stable One identity; logical ownership is independent of warm-session lifetime. */
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
export const ONE_AGENT_ID = BUILTIN_ONE_AGENT_ID;

/** 마지막 활동 후 이 시간이 지나면 유휴 상주 자원을 거둔다. Goal 원장은 유지한다. */
export const AGENT_RESIDENCY_IDLE_REAP_MS = 12 * 60 * 60_000;

/** 어디서 온 에이전트인가 — 로컬 설치 / 오너 Agent Cloud / 공개 Hub. */
export type AgentResidencySource = "local" | "cloud" | "hub";

export interface AgentResidencyChange {
  /** Only real resident CLI resources emit changes; activity-only rows do not. */
  state: Extract<AgentProcessState, "running" | "idle" | "closed">;
  reason: AgentProcessLifecycleReason;
  agentId: string | null;
  /** Resolved firm/org node id; falls back to agentId for solo runs. */
  nodeId: string | null;
  chatId: string | null;
  /** Main-owned Work project partition. Null means this entry is not Work-project scoped. */
  projectId: string | null;
  runtimeKind: string;
  source: AgentResidencySource;
  holdsSession: true;
}

export interface AgentResidencyEntry {
  /** 등록 키. 상주 세션은 풀 키(chatId × runtime × fingerprint), 활동 기록은 실행 키. */
  key: string;
  agentId: string | null;
  nodeId: string | null;
  chatId: string | null;
  /** Main-owned Work project partition. Never used as the conversation/pool key. */
  projectId: string | null;
  runtimeKind: string;
  source: AgentResidencySource;
  /** 마지막 활동(획득/반납/턴) 시각 — 12h 리퍼의 기준 시계. */
  lastActivityAt: number;
  /** Explicit host exemption only; One identity alone never exempts idle resources. */
  reaperExempt: boolean;
  /** 지금 턴이 쓰는 중인가. 사용 중인 것은 리퍼도 LRU 도 건드리지 않는다. */
  inUse: boolean;
  /** 살아 있는 자원을 실제로 붙들고 있는가(false 면 활동 기록일 뿐). */
  holdsSession: boolean;
  /** 붙든 자원을 놓는 방법. holdsSession 인 항목만 가진다. */
  close?: () => void | Promise<void>;
  /** Closing resources still occupy capacity until measured termination. */
  closing?: boolean;
  closeFailed?: boolean;
  closeCompletion?: Promise<void>;
  /** Host-minted, generation-bound reservation; never inferred from agentId. */
  awakeAdmission?: AwakeAgentResidencyAdmission;
}

declare const awakeAdmissionBrand: unique symbol;
export interface AwakeAgentResidencyAdmission { readonly [awakeAdmissionBrand]: true }
declare const residencyAdmissionBrand: unique symbol;
export interface AgentResidencyAdmission { readonly [residencyAdmissionBrand]: true }
interface AwakeRecord {
  contextKey: string; agentId: string; ownerEpoch: string; generation: number; awake: boolean;
  assertCurrent(): void;
}
const awakeAdmissions = new Map<AwakeAgentResidencyAdmission, AwakeRecord>();
const awakeScope = new AsyncLocalStorage<{ token: AwakeAgentResidencyAdmission; assertCurrent(): void }>();
const openingAdmissions = new Map<AgentResidencyAdmission, { awake?: AwakeAgentResidencyAdmission; closing?: boolean; closeFailed?: boolean; revoked?: boolean }>();
const activeContextTurns = new Map<AwakeAgentResidencyAdmission, number>();

function residencyFailure(code: string): never { throw Object.assign(new Error(code), { code }); }
export function isAgentContextResidencyAdmissionCurrent(value: AwakeAgentResidencyAdmission | undefined): boolean {
  const record = value && awakeAdmissions.get(value);
  if (!record) return false;
  try { record.assertCurrent(); return true; } catch { return false; }
}
export function isAwakeAgentResidencyAdmission(value: AwakeAgentResidencyAdmission | undefined): boolean {
  return !!value && awakeAdmissions.get(value)?.awake === true && isAgentContextResidencyAdmissionCurrent(value);
}
export function isAgentResidencyAwake(key: string): boolean {
  return isAwakeAgentResidencyAdmission(entries.get(key)?.awakeAdmission);
}
function reservedResidencyCount(): number {
  return [...awakeAdmissions.keys()].filter(isAwakeAgentResidencyAdmission).length
    + [...entries.values()].filter(entry => entry.holdsSession && !isAwakeAgentResidencyAdmission(entry.awakeAdmission)).length
    + [...openingAdmissions.values()].filter(entry => !isAwakeAgentResidencyAdmission(entry.awake)).length;
}
/** Only the daemon actor host calls this after validating its owner and scope.
 * One actor reserves one seat before any async process open. */
type ResidencyOwner = Omit<AwakeRecord, "awake">;
export function admitAwakeAgentResidency(input: ResidencyOwner): AwakeAgentResidencyAdmission {
  return admitContextResidency(input, true);
}
/** Ordinary conversations retain ownership and warm transports under normal
 * LRU. They reserve no seat until a physical adapter actually opens. */
export function admitWarmAgentResidency(input: ResidencyOwner): AwakeAgentResidencyAdmission {
  return admitContextResidency(input, false);
}
function admitContextResidency(input: ResidencyOwner, awake: boolean): AwakeAgentResidencyAdmission {
  if (![input.contextKey, input.agentId, input.ownerEpoch].every(value => typeof value === "string" && value.trim())
    || !Number.isSafeInteger(input.generation) || input.generation < 1 || typeof input.assertCurrent !== "function") {
    residencyFailure("agent_awake_identity_invalid");
  }
  input.assertCurrent();
  for (const [token, record] of awakeAdmissions) {
    if (!isAgentContextResidencyAdmissionCurrent(token)) { awakeAdmissions.delete(token); continue; }
    if (record.contextKey === input.contextKey) residencyFailure("agent_awake_context_owned");
  }
  if (awake) {
    enforceAgentResidencyBudget(1);
    if (reservedResidencyCount() >= agentResidencyBudget()) residencyFailure("agent_residency_capacity");
  }
  const token = Object.freeze({}) as AwakeAgentResidencyAdmission;
  awakeAdmissions.set(token, { ...input, awake });
  ensureShutdownHook();
  return token;
}
export function withAwakeAgentResidency<T>(token: AwakeAgentResidencyAdmission, action: () => T, assertCurrent: () => void): T {
  if (!isAgentContextResidencyAdmissionCurrent(token)) residencyFailure("agent_awake_generation_changed");
  assertCurrent();
  activeContextTurns.set(token, (activeContextTurns.get(token) ?? 0) + 1);
  const release = () => {
    const remaining = (activeContextTurns.get(token) ?? 1) - 1;
    if (remaining > 0) activeContextTurns.set(token, remaining); else activeContextTurns.delete(token);
  };
  try {
    const result = awakeScope.run({ token, assertCurrent }, action);
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
      return Promise.resolve(result).finally(release) as unknown as T;
    }
    release(); return result;
  } catch (error) { release(); throw error; }
}
export function currentAwakeAgentResidency(agentId: string | null | undefined): AwakeAgentResidencyAdmission | undefined {
  const scope = awakeScope.getStore();
  if (!scope) return undefined;
  scope.assertCurrent();
  const token = scope.token;
  if (!isAgentContextResidencyAdmissionCurrent(token)) residencyFailure("agent_awake_generation_changed");
  return awakeAdmissions.get(token)?.agentId === agentId ? token : undefined;
}
export function releaseAwakeAgentResidency(token: AwakeAgentResidencyAdmission): void {
  awakeAdmissions.delete(token);
  // Active turns own their resources until release. They observe revocation
  // through the actor's abort signal, and the pool retires them on release.
  for (const entry of [...entries.values()]) {
    if (entry.awakeAdmission === token && !entry.inUse) dropAgentResidency(entry.key, { close: true, reason: "shutdown" });
  }
}
/** A daemon adapter switch releases the old idle transport while retaining the
 * actor's seat and context. An unresolved checkout cannot be replaced. */
export function retireAwakeAgentResidencyAdapter(token: AwakeAgentResidencyAdmission): void | Promise<void> {
  if (!isAgentContextResidencyAdmissionCurrent(token)) residencyFailure("agent_awake_generation_changed");
  const held = [...entries.values()].filter(entry => entry.holdsSession && entry.awakeAdmission === token);
  if (held.some(entry => entry.inUse) || [...openingAdmissions.values()].some(entry => entry.awake === token)) {
    residencyFailure("agent_awake_adapter_busy");
  }
  for (const entry of held) dropAgentResidency(entry.key, { close: true, reason: "shutdown" });
  if (held.some(entry => entry.closeFailed)) residencyFailure("agent_residency_close_failed");
  const pending = held.flatMap(entry => entry.closeCompletion ? [entry.closeCompletion] : []);
  if (pending.length) return Promise.all(pending).then(() => {});
}
/** Atomic pre-open reservation across all pools, including concurrent opens. */
export function beginAgentResidencyAdmission(agentId: string | null | undefined): AgentResidencyAdmission {
  const awake = currentAwakeAgentResidency(agentId);
  if (awake && ([...entries.values()].some(entry => entry.holdsSession && entry.awakeAdmission === awake)
    || [...openingAdmissions.values()].some(entry => entry.awake === awake))) residencyFailure("agent_awake_adapter_busy");
  const reserved = isAwakeAgentResidencyAdmission(awake);
  enforceAgentResidencyBudget(reserved ? 0 : 1);
  if (reservedResidencyCount() + (reserved ? 0 : 1) > agentResidencyBudget()) residencyFailure("agent_residency_capacity");
  const token = Object.freeze({}) as AgentResidencyAdmission;
  openingAdmissions.set(token, { awake });
  return token;
}
export function finishAgentResidencyAdmission(token: AgentResidencyAdmission | undefined): void {
  if (token) openingAdmissions.delete(token);
}
/** Spawn succeeded but registry publication failed. Keep the opening seat and
 * diagnostics until measured termination; failure is quarantined. */
export function retainAgentResidencyAdmissionUntilClosed(
  token: AgentResidencyAdmission | undefined,
  completion: Promise<void>,
): void {
  const record = token && openingAdmissions.get(token);
  if (record) record.closing = true;
  void completion.then(() => {
    if (token && openingAdmissions.get(token) === record) openingAdmissions.delete(token);
  }, () => { if (record) record.closeFailed = true; });
}

const entries = new Map<string, AgentResidencyEntry>();
const changeListeners = new Set<(change: AgentResidencyChange) => void>();
let shutdownDetach: (() => void) | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

/** 스위퍼 주기. 12시간 상한을 이 간격으로 확인한다(데몬 keepAlive 와 같은 주기). */
const RESIDENCY_SWEEP_INTERVAL_MS = 10 * 60_000;

function ensureShutdownHook(): void {
  if (!shutdownDetach) {
    // 호스트가 죽으면 붙든 상주도 함께 죽는다 — 좀비 방지는 상주보다 항상 우선한다.
    shutdownDetach = onHostShutdown(() => disposeAgentResidency());
  }
  if (!sweepTimer) {
    /*
     * ★12h 규칙은 데몬에만 있으면 안 된다. 데스크탑 앱도 자기 프로세스에서 상주 세션을
     * 들고 있고, 앱에 스위퍼가 없으면 그 세션들은 앱이 켜져 있는 한 영원히 산다 —
     * "12시간 무입력이면 종료"가 절반만 참인 상태가 된다. 그래서 상한은 등록소 자신이
     * 들고 있고, 첫 등록과 함께 돈다(데몬은 자기 주기에서 같은 함수를 한 번 더 부른다).
     */
    sweepTimer = setInterval(() => {
      try { sweepIdleAgentResidency(); enforceAgentResidencyBudget(); } catch { /* 다음 주기가 다시 시도한다 */ }
    }, RESIDENCY_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
}

function stopSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/* ────────────────────────────── 예산 ────────────────────────────── */

let budgetProvider: (() => number) | null = null;

/** 테스트·데몬이 예산 출처를 갈아끼운다(기본은 스웜 슬라이더). */
export function setAgentResidencyBudgetProvider(provider: (() => number) | null): void {
  budgetProvider = provider;
  enforceAgentResidencyBudget();
}

/**
 * 상주 세션 총량의 상한 = 스웜 예산(getAgentConcurrency). 별도 숫자를 새로 만들지 않는다 —
 * 사용자가 슬라이더로 정한 "이 컴퓨터가 감당할 에이전트 수"가 곧 상주 상한이다.
 * store 를 못 여는 문맥(순수 로직 게이트)에서는 보수적 기본값으로 떨어진다.
 */
export function agentResidencyBudget(): number {
  if (budgetProvider) {
    try {
      const value = budgetProvider();
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    } catch {
      /* 아래 기본 경로로 */
    }
  }
  try {
    // 지연 로드: 이 모듈이 store(better-sqlite3)에 정적으로 묶이면 데몬 밖 도구가 못 쓴다.
    const { getAgentConcurrency } = require("../store/concurrency") as { getAgentConcurrency: () => number };
    const value = getAgentConcurrency();
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  } catch {
    /* store 없이 도는 문맥 */
  }
  return 4;
}

/** All provider pools share one resident-seat budget. Evict only the oldest
 * idle resource; a checked-out turn is owned by the run-slot semaphore and
 * must finish before this registry may reclaim it. `headroom` is a best-effort
 * pre-open reservation, never authority to interrupt a busy session. */
export function enforceAgentResidencyBudget(headroom = 0): number {
  const needed = Math.max(0, Math.floor(headroom));
  const limit = agentResidencyBudget();
  let holding = reservedResidencyCount();
  let evicted = 0;
  while (holding + needed > limit) {
    const oldest = [...entries.values()]
      .filter(entry => entry.holdsSession && !entry.inUse && !entry.closing && !isAwakeAgentResidencyAdmission(entry.awakeAdmission))
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.key.localeCompare(b.key))[0];
    if (!oldest) break;
    dropAgentResidency(oldest.key, { close: true, reason: "evicted" });
    const previous = holding;
    holding = reservedResidencyCount();
    evicted += 1;
    // An asynchronous retirement cannot make space yet. Do not close every
    // other warm session while waiting for the first physical exit.
    if (holding >= previous) break;
  }
  return evicted;
}

/* ──────────────────────────── 출처 판정 ──────────────────────────── */

let sourceResolver: ((agentId: string) => AgentResidencySource | null) | null = null;
const sourceCache = new Map<string, AgentResidencySource>();

/** Subscribe to actual resident CLI lifecycle changes. Activity-only rows never emit. */
export function onAgentResidencyChange(listener: (change: AgentResidencyChange) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitAgentResidencyChange(
  entry: AgentResidencyEntry,
  state: Extract<AgentProcessState, "running" | "idle" | "closed">,
  reason: AgentProcessLifecycleReason,
): void {
  if (!entry.holdsSession) return;
  const change: AgentResidencyChange = {
    state,
    reason,
    agentId: entry.agentId,
    nodeId: entry.nodeId,
    chatId: entry.chatId,
    projectId: entry.projectId,
    runtimeKind: entry.runtimeKind,
    source: entry.source,
    holdsSession: true,
  };
  for (const listener of changeListeners) {
    try { listener(change); } catch { /* observability must never break a CLI */ }
  }
}

/** 테스트·대체 구현이 출처 판정을 갈아끼운다. */
export function setAgentResidencySourceResolver(
  resolver: ((agentId: string) => AgentResidencySource | null) | null,
): void {
  sourceResolver = resolver;
  sourceCache.clear();
}

/**
 * 이 에이전트는 어디서 왔는가. 설치 원장의 `assetSource` 가 권위다 — 이름/접두사로 추측하지
 * 않는다(추측하면 Hub 에서 빌린 것을 로컬로 보고하게 되고, 그 보고는 아무도 못 고친다).
 * 못 읽으면 "local" — 모르는 것을 cloud/hub 라고 말하지는 않는다.
 */
export function resolveAgentResidencySource(agentId: string | null | undefined): AgentResidencySource {
  const id = (agentId ?? "").trim();
  if (!id) return "local";
  const cached = sourceCache.get(id);
  if (cached) return cached;
  let resolved: AgentResidencySource | null = null;
  if (sourceResolver) {
    try { resolved = sourceResolver(id); } catch { resolved = null; }
  } else {
    try {
      const { getAgentById } = require("../mcp/registry") as {
        getAgentById: (id: string) => { assetSource?: string } | null;
      };
      const asset = getAgentById(id)?.assetSource;
      resolved = asset === "hub" ? "hub" : asset === "agent-cloud" ? "cloud" : "local";
    } catch {
      resolved = null;
    }
  }
  const source = resolved ?? "local";
  sourceCache.set(id, source);
  return source;
}

/** Agent identity alone does not exempt an idle provider session from the 12h reaper. */
export function isResidencyExemptAgent(_agentId: string | null | undefined): boolean {
  return false;
}

/* ──────────────────────────── 등록/갱신 ──────────────────────────── */

export interface RegisterAgentResidencyInput {
  key: string;
  agentId?: string | null;
  nodeId?: string | null;
  chatId?: string | null;
  /** Main-owned Work project partition; omitted for One/legacy non-Work activity. */
  projectId?: string | null;
  runtimeKind: string;
  source?: AgentResidencySource;
  holdsSession?: boolean;
  /** Explicit exemption only; omitted means the normal 12h idle policy. */
  reaperExempt?: boolean;
  inUse?: boolean;
  close?: () => void | Promise<void>;
  now?: number;
  admission?: AgentResidencyAdmission;
}

/** 새 상주/활동을 등록하거나 기존 항목을 갱신한다(키가 같으면 upsert). */
export function registerAgentResidency(input: RegisterAgentResidencyInput): AgentResidencyEntry {
  const reservation = input.admission ? openingAdmissions.get(input.admission) : undefined;
  if (input.admission && (!reservation || reservation.revoked)) residencyFailure("agent_residency_admission_changed");
  if (reservation?.awake && (!isAgentContextResidencyAdmissionCurrent(reservation.awake)
    || awakeAdmissions.get(reservation.awake)?.agentId !== input.agentId)) residencyFailure("agent_awake_generation_changed");
  ensureShutdownHook();
  const now = input.now ?? Date.now();
  const agentId = input.agentId ?? null;
  const existing = entries.get(input.key);
  if (existing?.closing) residencyFailure("agent_residency_closing");
  const entry: AgentResidencyEntry = {
    key: input.key,
    agentId,
    nodeId: input.nodeId ?? agentId,
    chatId: input.chatId ?? null,
    projectId: input.projectId ?? existing?.projectId ?? null,
    runtimeKind: input.runtimeKind,
    source: input.source ?? resolveAgentResidencySource(agentId),
    lastActivityAt: now,
    reaperExempt: input.reaperExempt ?? isResidencyExemptAgent(agentId),
    inUse: input.inUse ?? true,
    holdsSession: input.holdsSession ?? false,
    ...(reservation?.awake ? { awakeAdmission: reservation.awake } : {}),
    ...(input.close ? { close: input.close } : existing?.close ? { close: existing.close } : {}),
  };
  entries.set(input.key, entry);
  finishAgentResidencyAdmission(input.admission);
  if (entry.holdsSession && !existing?.holdsSession) {
    emitAgentResidencyChange(entry, "running", "spawned");
  }
  if (entry.holdsSession) enforceAgentResidencyBudget();
  return entry;
}

/**
 * 활동 기록의 키. (에이전트 × 대화 × 런타임)이 하나의 행이다 — 턴마다 새 행을 만들면
 * 등록소가 실행 로그가 되어 버리고, "지금 누가 살아 있나"를 아무도 못 읽는다.
 */
export function agentActivityKey(input: {
  agentId?: string | null;
  chatId?: string | null;
  runtimeKind: string;
}): string {
  // 구분자는 U+0000 이다(사용자 문자열에 나올 수 없는 바이트). ★리터럴 NUL 로 쓰면 안 된다 —
  // 파일에 NUL 한 바이트가 있으면 grep·보안스캔이 그 파일을 통째로 건너뛴다. 이스케이프로 쓴다.
  return `agent-activity:${input.agentId ?? "-"}\u0000${input.chatId ?? "-"}\u0000${input.runtimeKind}`;
}

/** 활동 시각 갱신(+사용 중 표식). 없는 키면 아무것도 하지 않는다. */
export function touchAgentResidency(key: string, patch?: { inUse?: boolean; now?: number; chatId?: string | null }): void {
  const entry = entries.get(key);
  if (!entry || entry.closing) return;
  entry.lastActivityAt = patch?.now ?? Date.now();
  if (patch?.inUse !== undefined) entry.inUse = patch.inUse;
  if (patch?.chatId !== undefined) entry.chatId = patch.chatId;
  if (entry.holdsSession && patch?.inUse !== undefined) {
    emitAgentResidencyChange(
      entry,
      entry.inUse ? "running" : "idle",
      entry.inUse ? "turn-started" : "turn-complete",
    );
  }
  if (entry.holdsSession) enforceAgentResidencyBudget();
}

/** 등록을 지운다. `close: true` 면 붙든 자원도 놓는다. */
export function dropAgentResidency(
  key: string,
  opts?: { close?: boolean; reason?: AgentProcessLifecycleReason },
): void {
  const entry = entries.get(key);
  if (!entry) return;
  // Project idle cleanup also uses this primitive. It cannot evict a seat
  // explicitly held by the daemon actor, nor an active turn.
  if ((opts?.reason === "evicted" || opts?.reason === "reaped")
    && (entry.inUse || isAwakeAgentResidencyAdmission(entry.awakeAdmission))) return;
  // Reentrant/repeated removal must not free a still-closing physical seat.
  if (entry.closing) return;
  const finish = (): void => {
    // A late completion cannot delete a replacement row or emit its lifecycle.
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    if (entry.holdsSession) emitAgentResidencyChange(entry, "closed", opts?.reason ?? "process-exit");
  };
  if (opts?.close && entry.close) {
    entry.closing = true;
    entry.inUse = false;
    try {
      const completion = entry.close();
      if (completion && typeof completion.then === "function") {
        entry.closeCompletion = completion.then(finish, () => {
          entry.closeFailed = true;
          residencyFailure("agent_residency_close_failed");
        });
        void entry.closeCompletion.catch(() => {});
        return;
      }
    } catch {
      // A failed close is not evidence of termination. Keep its seat quarantined.
      entry.closeFailed = true;
      return;
    }
  }
  finish();
}

/* ──────────────────────────── 리퍼/관측 ──────────────────────────── */

/**
 * 12h 무입력 스위퍼. 사용 중(inUse)과 명시적 면제만 건드리지 않는다.
 * 붙든 항목은 close 를 부르고, 활동 기록은 그냥 지운다(들고 있는 자원이 없으므로).
 * 반환: 이번 패스에 거둔 수.
 */
export function sweepIdleAgentResidency(maxIdleMs = AGENT_RESIDENCY_IDLE_REAP_MS, now = Date.now()): number {
  const cutoff = now - Math.max(1_000, maxIdleMs);
  let reaped = 0;
  for (const entry of [...entries.values()]) {
    if (entry.closing || entry.inUse || entry.reaperExempt || isAwakeAgentResidencyAdmission(entry.awakeAdmission)) continue;
    if (entry.lastActivityAt > cutoff) continue;
    dropAgentResidency(entry.key, { close: true, reason: "reaped" });
    reaped += 1;
  }
  return reaped;
}

export interface AgentResidencySnapshot {
  /** 등록된 전체 항목 수(상주 + 활동 기록). */
  total: number;
  /** 실제 자원을 붙들고 있는 수 — 예산과 비교할 값. */
  holding: number;
  /** 지금 턴이 쓰는 중인 수. */
  inUse: number;
  /** 리퍼 면제(One) 수. */
  exempt: number;
  budget: number;
  /** Explicit actor reservations, including those not yet holding a CLI. */
  awakeAdmissions: number;
  closing: number;
  closeFailed: number;
  opening: number;
  openingClosing: number;
  openingCloseFailed: number;
  agents: Array<{
    agentId: string | null;
    nodeId: string | null;
    chatId: string | null;
    projectId: string | null;
    runtimeKind: string;
    source: AgentResidencySource;
    holdsSession: boolean;
    inUse: boolean;
    reaperExempt: boolean;
    idleMs: number;
    closing: boolean;
    closeFailed: boolean;
  }>;
}

/** 관측 표면 — 데몬 제어 소켓(agents.residency / daemon.ping)이 그대로 실어 보낸다. */
export function agentResidencySnapshot(now = Date.now()): AgentResidencySnapshot {
  const all = [...entries.values()];
  return {
    total: all.length,
    holding: all.filter((e) => e.holdsSession).length,
    inUse: all.filter((e) => e.inUse).length,
    exempt: all.filter((e) => e.reaperExempt || isAwakeAgentResidencyAdmission(e.awakeAdmission)).length,
    budget: agentResidencyBudget(),
    awakeAdmissions: [...awakeAdmissions.keys()].filter(isAwakeAgentResidencyAdmission).length,
    opening: openingAdmissions.size,
    openingClosing: [...openingAdmissions.values()].filter(e => e.closing).length,
    openingCloseFailed: [...openingAdmissions.values()].filter(e => e.closeFailed).length,
    closing: all.filter(e => e.closing).length,
    closeFailed: all.filter(e => e.closeFailed).length,
    agents: all
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((e) => ({
        agentId: e.agentId,
        nodeId: e.nodeId,
        chatId: e.chatId,
        projectId: e.projectId,
        runtimeKind: e.runtimeKind,
        source: e.source,
        holdsSession: e.holdsSession,
        inUse: e.inUse,
        reaperExempt: e.reaperExempt || isAwakeAgentResidencyAdmission(e.awakeAdmission),
        closing: !!e.closing,
        closeFailed: !!e.closeFailed,
        idleMs: e.inUse ? 0 : Math.max(0, now - e.lastActivityAt),
      })),
  };
}

/** 붙들고 있는(자원 보유) 항목만 — 풀의 LRU 계산이 쓴다. */
export function holdingAgentResidency(): AgentResidencyEntry[] {
  return [...entries.values()].filter((e) => e.holdsSession);
}

/** 호스트 종료 — 붙든 상주를 전부 놓는다(면제도 예외 없음). */
/** Maintenance releases idle physical resources, never active work or an
 * opening transport. The actor host separately releases its idle lifetimes. */
export function releaseIdleAgentResidency(): { released: number; active: number; opening: number } {
  let released = 0;
  for (const entry of [...entries.values()]) {
    if (!entry.holdsSession || entry.closing || entry.inUse || (entry.awakeAdmission && activeContextTurns.has(entry.awakeAdmission))) continue;
    dropAgentResidency(entry.key, { close: true, reason: "shutdown" });
    released += 1;
  }
  return { released, active: holdingAgentResidency().filter(entry => entry.inUse
    || !!entry.awakeAdmission && activeContextTurns.has(entry.awakeAdmission)).length, opening: openingAdmissions.size };
}
export function disposeAgentResidency(): void {
  awakeAdmissions.clear();
  activeContextTurns.clear();
  // Revoke publication immediately, but keep physical/opening capacity charged.
  for (const record of openingAdmissions.values()) record.revoked = true;
  for (const entry of [...entries.values()]) {
    dropAgentResidency(entry.key, { close: true, reason: "shutdown" });
  }
  stopSweeper();
  if (shutdownDetach) {
    shutdownDetach();
    shutdownDetach = null;
  }
}

/** 테스트 전용 — 같은 프로세스에서 여러 시나리오를 재려면 상태를 되돌려야 한다. */
export function __resetAgentResidencyForTests(): void {
  entries.clear();
  awakeAdmissions.clear();
  activeContextTurns.clear();
  openingAdmissions.clear();
  sourceCache.clear();
  stopSweeper();
  if (shutdownDetach) {
    shutdownDetach();
    shutdownDetach = null;
  }
}
