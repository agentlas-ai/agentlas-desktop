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

/** One 은 리퍼 면제다(오너 비전: "One 제외 마지막 메시지 후 12시간 무입력이면 자동 종료"). */
export const ONE_AGENT_ID = "builtin-agentlas-one";

/** 마지막 활동 후 이 시간이 지나면 상주를 거둔다(One 제외). 데몬 스위퍼와 같은 값. */
export const AGENT_RESIDENCY_IDLE_REAP_MS = 12 * 60 * 60_000;

/** 어디서 온 에이전트인가 — 로컬 설치 / 오너 Agent Cloud / 공개 Hub. */
export type AgentResidencySource = "local" | "cloud" | "hub";

export interface AgentResidencyEntry {
  /** 등록 키. 상주 세션은 풀 키(chatId × runtime × fingerprint), 활동 기록은 실행 키. */
  key: string;
  agentId: string | null;
  chatId: string | null;
  runtimeKind: string;
  source: AgentResidencySource;
  /** 마지막 활동(획득/반납/턴) 시각 — 12h 리퍼의 기준 시계. */
  lastActivityAt: number;
  /** One 관련 상주는 리퍼 면제(process-pool.ts 의 reaperExempt 와 같은 이름·같은 의미). */
  reaperExempt: boolean;
  /** 지금 턴이 쓰는 중인가. 사용 중인 것은 리퍼도 LRU 도 건드리지 않는다. */
  inUse: boolean;
  /** 살아 있는 자원을 실제로 붙들고 있는가(false 면 활동 기록일 뿐). */
  holdsSession: boolean;
  /** 붙든 자원을 놓는 방법. holdsSession 인 항목만 가진다. */
  close?: () => void;
}

const entries = new Map<string, AgentResidencyEntry>();
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
      try { sweepIdleAgentResidency(); } catch { /* 다음 주기가 다시 시도한다 */ }
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

/* ──────────────────────────── 출처 판정 ──────────────────────────── */

let sourceResolver: ((agentId: string) => AgentResidencySource | null) | null = null;
const sourceCache = new Map<string, AgentResidencySource>();

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

/** One 소유 세션인가 — 면제 표식의 유일한 판정식. */
export function isResidencyExemptAgent(agentId: string | null | undefined): boolean {
  return (agentId ?? "") === ONE_AGENT_ID;
}

/* ──────────────────────────── 등록/갱신 ──────────────────────────── */

export interface RegisterAgentResidencyInput {
  key: string;
  agentId?: string | null;
  chatId?: string | null;
  runtimeKind: string;
  source?: AgentResidencySource;
  holdsSession?: boolean;
  /** 미지정이면 agentId 로 판정한다(One 이면 면제). */
  reaperExempt?: boolean;
  inUse?: boolean;
  close?: () => void;
  now?: number;
}

/** 새 상주/활동을 등록하거나 기존 항목을 갱신한다(키가 같으면 upsert). */
export function registerAgentResidency(input: RegisterAgentResidencyInput): AgentResidencyEntry {
  ensureShutdownHook();
  const now = input.now ?? Date.now();
  const agentId = input.agentId ?? null;
  const existing = entries.get(input.key);
  const entry: AgentResidencyEntry = {
    key: input.key,
    agentId,
    chatId: input.chatId ?? null,
    runtimeKind: input.runtimeKind,
    source: input.source ?? resolveAgentResidencySource(agentId),
    lastActivityAt: now,
    reaperExempt: input.reaperExempt ?? isResidencyExemptAgent(agentId),
    inUse: input.inUse ?? true,
    holdsSession: input.holdsSession ?? false,
    ...(input.close ? { close: input.close } : existing?.close ? { close: existing.close } : {}),
  };
  entries.set(input.key, entry);
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
export function touchAgentResidency(key: string, patch?: { inUse?: boolean; now?: number }): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.lastActivityAt = patch?.now ?? Date.now();
  if (patch?.inUse !== undefined) entry.inUse = patch.inUse;
}

/** 등록을 지운다. `close: true` 면 붙든 자원도 놓는다. */
export function dropAgentResidency(key: string, opts?: { close?: boolean }): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  if (opts?.close && entry.close) {
    try { entry.close(); } catch { /* 이미 죽었을 수 있다 */ }
  }
}

/* ──────────────────────────── 리퍼/관측 ──────────────────────────── */

/**
 * 12h 무입력 스위퍼. 사용 중(inUse)과 면제(reaperExempt=One)는 건드리지 않는다.
 * 붙든 항목은 close 를 부르고, 활동 기록은 그냥 지운다(들고 있는 자원이 없으므로).
 * 반환: 이번 패스에 거둔 수.
 */
export function sweepIdleAgentResidency(maxIdleMs = AGENT_RESIDENCY_IDLE_REAP_MS, now = Date.now()): number {
  const cutoff = now - Math.max(1_000, maxIdleMs);
  let reaped = 0;
  for (const entry of [...entries.values()]) {
    if (entry.inUse || entry.reaperExempt) continue;
    if (entry.lastActivityAt > cutoff) continue;
    dropAgentResidency(entry.key, { close: true });
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
  agents: Array<{
    agentId: string | null;
    chatId: string | null;
    runtimeKind: string;
    source: AgentResidencySource;
    holdsSession: boolean;
    inUse: boolean;
    reaperExempt: boolean;
    idleMs: number;
  }>;
}

/** 관측 표면 — 데몬 제어 소켓(agents.residency / daemon.ping)이 그대로 실어 보낸다. */
export function agentResidencySnapshot(now = Date.now()): AgentResidencySnapshot {
  const all = [...entries.values()];
  return {
    total: all.length,
    holding: all.filter((e) => e.holdsSession).length,
    inUse: all.filter((e) => e.inUse).length,
    exempt: all.filter((e) => e.reaperExempt).length,
    budget: agentResidencyBudget(),
    agents: all
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((e) => ({
        agentId: e.agentId,
        chatId: e.chatId,
        runtimeKind: e.runtimeKind,
        source: e.source,
        holdsSession: e.holdsSession,
        inUse: e.inUse,
        reaperExempt: e.reaperExempt,
        idleMs: e.inUse ? 0 : Math.max(0, now - e.lastActivityAt),
      })),
  };
}

/** 붙들고 있는(자원 보유) 항목만 — 풀의 LRU 계산이 쓴다. */
export function holdingAgentResidency(): AgentResidencyEntry[] {
  return [...entries.values()].filter((e) => e.holdsSession);
}

/** 호스트 종료 — 붙든 상주를 전부 놓는다(면제도 예외 없음). */
export function disposeAgentResidency(): void {
  for (const entry of [...entries.values()]) dropAgentResidency(entry.key, { close: true });
  stopSweeper();
  if (shutdownDetach) {
    shutdownDetach();
    shutdownDetach = null;
  }
}

/** 테스트 전용 — 같은 프로세스에서 여러 시나리오를 재려면 상태를 되돌려야 한다. */
export function __resetAgentResidencyForTests(): void {
  entries.clear();
  sourceCache.clear();
  stopSweeper();
  if (shutdownDetach) {
    shutdownDetach();
    shutdownDetach = null;
  }
}
