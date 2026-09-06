// ACP 상주 세션 풀 — 매 턴 열고 닫던 ACP 세션을 붙들었다가 다음 턴이 이어 쓴다.
//
// ★왜 ACP 인가. ACP 는 **양방향 상주 프로토콜**이다(에이전트가 자식으로 계속 살아 있고,
// 우리가 session/prompt 를 여러 번 보낸다). 그런데 지금까지 러너는 매 실행의 finally 에서
// conn.close() + killCliTree() 를 해 왔다 — 상주 가능한 유일한 경로를 매번 스스로 끊고
// 있었다는 뜻이다. 일회성 `-p` CLI(claude-code)와 달리 여기서는 "붙들면 이어진다".
//
// ★안전은 구조로 얻는다(process-pool.ts 와 같은 계약·같은 이름):
//   1. 세션 교차 오염 — 체크아웃은 배타적이다. 그리고 키가 (chatId × 런타임 × 지문 ×
//      cwd × MCP 설정 × 실행 파일)이라, 남의 대화 세션을 물려받는 일이 원천적으로 없다.
//      지문(모델·시스템프롬프트·권한) 계산식은 기존 계약 그대로다 — 바뀌면 재사용 금지.
//   2. 좀비 — 모든 세션이 상주 등록소를 통해 host-lifecycle 종료 훅에 걸린다.
//   3. 유휴 누수 — 12시간 무입력이면 리퍼가 닫는다(One 소유 세션만 reaperExempt 로 면제).
//   4. 예산 — 붙든 총량은 스웜 예산(getAgentConcurrency)을 넘지 않는다. 넘으면 가장 오래
//      유휴인 세션부터 LRU 로 닫는다.
//   5. 죽은 세션 — alive() 가 거짓이면 재사용 후보로 세지 않고 조용히 버리고 새로 연다.
//      사용자에게는 아무 차이가 없어야 한다(문구도 새로 만들지 않는다).
import {
  agentResidencyBudget,
  dropAgentResidency,
  isResidencyExemptAgent,
  registerAgentResidency,
  touchAgentResidency,
  type AgentResidencySource,
} from "./agent-residency";
import type { AgentProcessLifecycleReason } from "../../shared/types";

export interface AcpPoolMeta {
  agentId?: string | null;
  nodeId?: string | null;
  chatId?: string | null;
  runtimeKind: string;
  source?: AgentResidencySource;
  /** 미지정이면 agentId 로 판정(One 이면 면제). */
  reaperExempt?: boolean;
}

interface PoolEntry<S> {
  /** 재사용 키 — 이 키가 같아야만 다음 턴이 이어 쓴다. */
  key: string;
  /** 등록소 키 — 같은 키의 동시 세션을 구분한다(체크아웃 배타성). */
  residencyKey: string;
  session: S;
  inUse: boolean;
  lastActivityAt: number;
  reaperExempt: boolean;
  retireOnRelease?: boolean;
  retain?: () => boolean;
}

export interface AcpSessionLease<S> {
  key: string;
  session: S;
  /** 이번 acquire 가 **새로 연** 세션인가. false 면 이어 쓰는 중(= 기존 resume 경로). */
  fresh: boolean;
}

export interface AcpSessionPoolOptions<S> {
  /** 이 세션이 아직 살아 있는가(프로세스 생존 + 프로토콜 미종료). */
  alive: (session: S) => boolean;
  /** 세션을 놓는 방법(프로토콜 close + 프로세스 트리 종료). */
  close: (session: S) => void;
  /**
   * 유휴로 붙들 때 호출 — 이 세션이 **호스트를 살려 두지 않게** 한다(자식 파이프 unref).
   *
   * ★없으면 무슨 일이 나는가. 붙든 자식의 stdio 파이프는 부모의 이벤트 루프를 붙잡는다.
   * 창을 가진 앱/데몬은 어차피 계속 사는 프로세스라 차이가 없지만, 일을 끝내면 나가야 하는
   * 호스트(터미널 CLI·게이트 스크립트)는 **영영 종료하지 못한다**. 상주가 종료를 막는 것은
   * 기능이 아니라 결함이다. 반대로 빌려 쓰는 동안에는 다시 ref 해서 턴이 끝나기 전에
   * 프로세스가 나가 버리는 일이 없게 한다.
   */
  unref?: (session: S) => void;
  /** 다시 빌릴 때 호출 — 유휴 동안 풀었던 참조를 되돌린다. */
  ref?: (session: S) => void;
  /** 붙들 수 있는 상한. 기본은 스웜 예산. */
  budget?: () => number;
  now?: () => number;
}

let leaseSeq = 0;

export class AcpSessionPool<S> {
  private readonly entries: PoolEntry<S>[] = [];
  private readonly leases = new WeakMap<AcpSessionLease<S>, PoolEntry<S>>();
  private readonly opts: AcpSessionPoolOptions<S>;
  private readonly now: () => number;

  constructor(opts: AcpSessionPoolOptions<S>) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  private budget(): number {
    try {
      const value = this.opts.budget ? this.opts.budget() : agentResidencyBudget();
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    } catch {
      /* 아래 기본값 */
    }
    return agentResidencyBudget();
  }

  /** 죽은 세션을 목록에서 걷어낸다 — 죽은 것을 재사용 후보로 세면 안 된다. */
  private reapDead(): void {
    for (const entry of [...this.entries]) {
      if (entry.inUse) continue;
      let alive = false;
      try { alive = this.opts.alive(entry.session); } catch { alive = false; }
      if (!alive) this.remove(entry, { close: true, reason: "process-exit" });
    }
  }

  /** 예산을 넘겼으면 가장 오래 유휴인 것부터 닫는다. 사용 중인 것은 절대 건드리지 않는다. */
  private enforceBudget(headroom = 1): void {
    const limit = this.budget();
    while (this.entries.length + headroom > limit) {
      let victim: PoolEntry<S> | null = null;
      for (const entry of this.entries) {
        if (entry.inUse) continue;
        if (!victim || entry.lastActivityAt < victim.lastActivityAt) victim = entry;
      }
      // 전부 사용 중이면 더 닫을 것이 없다 — 실행 슬롯(run-slots)이 이미 동시 실행을
      // 같은 예산으로 막고 있으므로, 여기서 실행을 거절하지는 않는다.
      if (!victim) return;
      this.remove(victim, { close: true, reason: "evicted" });
    }
  }

  /**
   * 키가 같은 **유휴·생존** 세션을 빌리거나, 없으면 `open()` 으로 새로 연다.
   * 반드시 `release()` 또는 `discard()` 로 돌려줘야 한다(try/finally).
   */
  async acquire(key: string, meta: AcpPoolMeta, open: () => Promise<S>, retain?: () => boolean): Promise<AcpSessionLease<S>> {
    this.reapDead();
    const reusable = this.entries.find((e) => e.key === key && !e.inUse && !e.retireOnRelease);
    if (reusable) {
      reusable.inUse = true;
      reusable.lastActivityAt = this.now();
      // 유휴 동안 풀어 둔 참조를 되돌린다 — 턴이 도는 동안 호스트가 나가면 안 된다.
      try { this.opts.ref?.(reusable.session); } catch { /* 이미 죽었을 수 있다 */ }
      touchAgentResidency(reusable.residencyKey, { inUse: true, now: reusable.lastActivityAt });
      const lease: AcpSessionLease<S> = { key, session: reusable.session, fresh: false };
      this.leases.set(lease, reusable);
      return lease;
    }

    // 자리를 먼저 만든다 — 열고 나서 넘치면 방금 연 것을 닫게 된다.
    this.enforceBudget();
    const session = await open();
    const entry: PoolEntry<S> = {
      key,
      residencyKey: `acp-session:${key}#${++leaseSeq}`,
      session,
      inUse: true,
      lastActivityAt: this.now(),
      reaperExempt: meta.reaperExempt ?? isResidencyExemptAgent(meta.agentId),
      retain,
      retireOnRelease: retain ? !retain() : false,
    };
    this.entries.push(entry);
    registerAgentResidency({
      key: entry.residencyKey,
      agentId: meta.agentId ?? null,
      nodeId: meta.nodeId ?? meta.agentId ?? null,
      chatId: meta.chatId ?? null,
      runtimeKind: meta.runtimeKind,
      ...(meta.source ? { source: meta.source } : {}),
      holdsSession: true,
      reaperExempt: entry.reaperExempt,
      inUse: true,
      // 리퍼(12h)와 호스트 종료가 이 세션을 놓는 방법 — 등록소는 이것만 안다.
      // 풀 목록에서도 함께 빠진다(등록소만 지우면 죽은 항목이 재사용 후보로 남는다).
      close: () => this.remove(entry, { close: true, reason: "shutdown" }),
      now: entry.lastActivityAt,
    });
    const lease: AcpSessionLease<S> = { key, session, fresh: true };
    this.leases.set(lease, entry);
    return lease;
  }

  /** 세션을 유휴 상태로 돌려준다 — 다음 턴이 같은 키로 이어 쓴다. */
  release(lease: AcpSessionLease<S>): void {
    const entry = this.leases.get(lease);
    if (!entry) return;
    this.leases.delete(lease);
    if (entry.retireOnRelease || (entry.retain && !entry.retain())) {
      this.remove(entry, { close: true, reason: "shutdown" });
      return;
    }
    let alive = false;
    try { alive = this.opts.alive(entry.session); } catch { alive = false; }
    if (!alive) {
      this.remove(entry, { close: true, reason: "process-exit" });
      return;
    }
    entry.inUse = false;
    entry.lastActivityAt = this.now();
    // 유휴 세션은 호스트를 살려 두지 않는다(터미널·게이트가 종료 못 하던 자리).
    try { this.opts.unref?.(entry.session); } catch { /* 이미 죽었을 수 있다 */ }
    touchAgentResidency(entry.residencyKey, { inUse: false, now: entry.lastActivityAt });
    // 반납한 김에 예산을 다시 본다(사용자가 슬라이더를 내렸을 수 있다).
    this.enforceBudget(0);
  }

  /** 세션을 버린다(취소·프로토콜 파손·재사용 실패). 조용히 닫고 목록에서 지운다. */
  discard(lease: AcpSessionLease<S>): void {
    const entry = this.leases.get(lease);
    if (!entry) return;
    this.leases.delete(lease);
    this.remove(entry, { close: true, reason: "error" });
  }

  /** Retire matching idle owners atomically; never interrupt a checked-out owner. */
  retireIdleMatching(matches: (session: S) => boolean): { busy: boolean; retired: S[] } {
    this.reapDead();
    const matched = this.entries.filter((entry) => matches(entry.session));
    if (matched.some((entry) => entry.inUse)) return { busy: true, retired: [] };
    for (const entry of matched) this.remove(entry, { close: true, reason: "shutdown" });
    return { busy: false, retired: matched.map((entry) => entry.session) };
  }

  /** Retire obsolete sessions without interrupting their checked-out calls. */
  retireMatching(matches: (session: S) => boolean): { retired: number; pending: number } {
    let retired = 0;
    let pending = 0;
    for (const entry of [...this.entries]) {
      if (!matches(entry.session)) continue;
      if (entry.inUse) {
        entry.retireOnRelease = true;
        pending += 1;
      } else {
        this.remove(entry, { close: true, reason: "shutdown" });
        retired += 1;
      }
    }
    return { retired, pending };
  }

  /** 12h 무입력 리퍼. 사용 중·면제(One)는 건드리지 않는다. 반환: 닫은 수. */
  sweepIdle(maxIdleMs: number): number {
    const cutoff = this.now() - Math.max(1_000, maxIdleMs);
    let closed = 0;
    for (const entry of [...this.entries]) {
      if (entry.inUse || entry.reaperExempt) continue;
      if (entry.lastActivityAt > cutoff) continue;
      this.remove(entry, { close: true, reason: "reaped" });
      closed += 1;
    }
    return closed;
  }

  /** 붙든 세션 전부를 닫는다(호스트 종료·런타임 교체). */
  disposeAll(): void {
    for (const entry of [...this.entries]) this.remove(entry, { close: true, reason: "shutdown" });
  }

  /** 진단용 — 붙든 수 / 유휴 수. */
  stats(): { size: number; idle: number } {
    return { size: this.entries.length, idle: this.entries.filter((e) => !e.inUse).length };
  }

  private closeEntry(entry: PoolEntry<S>): void {
    try { this.opts.close(entry.session); } catch { /* 이미 죽었을 수 있다 */ }
  }

  private remove(
    entry: PoolEntry<S>,
    opts: { close: boolean; reason?: AgentProcessLifecycleReason },
  ): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
    // 등록소 항목을 먼저 지운다 — close 를 두 번 부르지 않기 위해서(등록소의 close 가
    // 곧 이 세션을 닫는 함수다).
    dropAgentResidency(entry.residencyKey, { reason: opts.reason });
    if (opts.close) this.closeEntry(entry);
  }
}
