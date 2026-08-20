// 웜 프로세스 풀 — Phase 5. 데몬이 CLI 프로세스를 붙들었다가 다음 턴에 재사용한다.
//
// ★왜 있나. 지금은 매 턴 claude/codex 를 새로 띄운다. 뜨는 데만 턴당 1~3초가 날아가고,
// 새로 뜨면 프롬프트 캐시도 버려진다. 데몬이 있으니(Phase 1) 프로세스를 붙들 주체가
// 생겼다 — 같은 서명의 다음 요청은 이미 떠 있는 프로세스를 쓴다.
//
// ★내가 걱정했던 세 위험을 **설계로** 없앤다(런타임 방어가 아니라 구조):
//   1. 세션 교차 오염 — 체크아웃은 **배타적**이다. 빌린 프로세스는 반납 전까지 아무에게도
//      다시 안 준다. 그리고 서명(runtime+model+cwd…)이 일치할 때만 재사용하므로, 남의
//      대화 프로세스를 물려받는 일이 원천적으로 없다.
//   2. 좀비 — 모든 프로세스를 host-lifecycle 종료 훅에 건다. 데몬이 죽으면 함께 죽는다.
//      그리고 **죽은 프로세스는 절대 안 넘긴다**(exited 플래그 확인 후 축출).
//   3. 유휴 메모리 — 반납된 프로세스는 idle TTL 뒤 스스로 죽는다. 붙들기만 하고 안 죽으면
//      풀이 아니라 누수다.
import type { ChildProcess } from "node:child_process";
import { onHostShutdown } from "../host-lifecycle";

export interface PooledProcessHandle {
  child: ChildProcess;
  /** 이 프로세스를 만든 서명. 같은 서명의 요청만 재사용한다. */
  signature: string;
  /** 지금 누군가 빌려 쓰는 중인가. 배타성의 핵심. */
  inUse: boolean;
  /** 프로세스가 종료됐는가. 죽은 것은 절대 다시 넘기지 않는다. */
  exited: boolean;
  /** 마지막으로 반납된 시각(유휴 축출 계산용). */
  idleSince: number | null;
  idleTimer: NodeJS.Timeout | null;
  /**
   * 상주 프로세스 표식 — 짧은 idle TTL(기본 5분)로 죽이지 않고 붙들어 둔다.
   * 대신 데몬의 장기 스위퍼(sweepIdle, 기본 12시간)가 수명을 관리한다.
   * 앞으로 붙을 상주 세션(양방향 stream-json 대화)이 이 표식으로 들어온다.
   */
  resident: boolean;
  /**
   * 장기 스위퍼 면제 표식 — One 처럼 "항상 살아 있어야 하는" 프로세스가 단다.
   * 면제여도 데몬 종료(dispose)에는 함께 죽는다 — 좀비 방지가 항상 이긴다.
   */
  reaperExempt: boolean;
  /** 마지막 활동(획득/반납) 시각 — 12h 유휴 리퍼의 기준 시계. */
  lastActivityAt: number;
}

export interface AcquireOptions {
  /** true 면 idle TTL 로 죽이지 않는 상주 프로세스로 붙든다(스위퍼가 수명 관리). */
  resident?: boolean;
  /** true 면 장기 유휴 스위퍼(sweepIdle)에서 면제한다 — One 관련 프로세스용 계약 칸. */
  reaperExempt?: boolean;
}

export interface ProcessPoolOptions {
  /** 붙들 최대 프로세스 수. 넘으면 가장 오래 유휴인 것을 죽인다. */
  maxSize?: number;
  /** 반납 후 이 시간(ms) 동안 안 쓰이면 죽인다. */
  idleTtlMs?: number;
  /** 현재 시각 — 테스트가 갈아끼운다. */
  now?: () => number;
}

/**
 * 프로세스 하나를 새로 띄우는 방법. 풀은 "언제 띄우고 언제 재사용하고 언제 죽이는가"만
 * 알고, "어떻게 띄우는가"는 호출자가 준다(러너마다 다르므로).
 */
export type SpawnFn = (signature: string) => ChildProcess;

export class WarmProcessPool {
  private readonly handles: PooledProcessHandle[] = [];
  private readonly maxSize: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private disposed = false;
  private readonly detachShutdown: () => void;

  constructor(opts: ProcessPoolOptions = {}) {
    this.maxSize = Math.max(1, opts.maxSize ?? 4);
    this.idleTtlMs = Math.max(1_000, opts.idleTtlMs ?? 5 * 60_000);
    this.now = opts.now ?? Date.now;
    // 데몬이 죽으면 붙든 프로세스도 함께 죽는다 — 좀비 방지의 뿌리.
    this.detachShutdown = onHostShutdown(() => this.dispose());
  }

  /**
   * 서명이 일치하는 **유휴** 프로세스를 빌리거나, 없으면 새로 띄운다.
   * 빌린 동안 그 프로세스는 다른 누구에게도 안 나간다(배타적).
   * 반드시 `release()` 로 돌려줘야 한다 — try/finally 로 감쌀 것.
   */
  acquire(signature: string, spawn: SpawnFn, opts: AcquireOptions = {}): PooledProcessHandle {
    if (this.disposed) throw new Error("WarmProcessPool: acquire after dispose");
    // 죽은 프로세스를 먼저 걷어낸다 — 죽은 것을 재사용 후보로 세면 안 된다.
    this.reap();

    const reusable = this.handles.find(
      (h) => h.signature === signature && !h.inUse && !h.exited,
    );
    if (reusable) {
      reusable.inUse = true;
      reusable.idleSince = null;
      reusable.lastActivityAt = this.now();
      // 표식은 최신 요청이 이긴다 — 같은 서명이라도 이번 사용자가 상주를 원치 않으면 강등.
      reusable.resident = opts.resident === true;
      reusable.reaperExempt = opts.reaperExempt === true;
      if (reusable.idleTimer) {
        clearTimeout(reusable.idleTimer);
        reusable.idleTimer = null;
      }
      return reusable;
    }

    // 빈자리가 없으면 가장 오래 유휴인 것을 죽여 자리를 만든다.
    if (this.handles.length >= this.maxSize) this.evictOldestIdle();

    const child = spawn(signature);
    const handle: PooledProcessHandle = {
      child,
      signature,
      inUse: true,
      exited: false,
      idleSince: null,
      idleTimer: null,
      resident: opts.resident === true,
      reaperExempt: opts.reaperExempt === true,
      lastActivityAt: this.now(),
    };
    // 프로세스가 스스로 죽으면 즉시 표시한다 — 다음 acquire 가 죽은 걸 안 넘기도록.
    child.once("exit", () => {
      handle.exited = true;
      if (handle.idleTimer) {
        clearTimeout(handle.idleTimer);
        handle.idleTimer = null;
      }
      const index = this.handles.indexOf(handle);
      if (index >= 0) this.handles.splice(index, 1);
    });
    this.handles.push(handle);
    return handle;
  }

  /**
   * 빌린 프로세스를 돌려준다. 아직 살아 있으면 유휴 상태로 두고, idle TTL 뒤 죽인다.
   * 이미 죽어 있으면 그냥 축출한다.
   */
  release(handle: PooledProcessHandle): void {
    handle.inUse = false;
    if (handle.exited || this.disposed) {
      this.remove(handle);
      return;
    }
    handle.idleSince = this.now();
    handle.lastActivityAt = handle.idleSince;
    // 상주 프로세스는 짧은 idle TTL 로 죽이지 않는다 — 수명은 sweepIdle(기본 12h)이 맡는다.
    if (handle.resident) return;
    handle.idleTimer = setTimeout(() => this.remove(handle), this.idleTtlMs);
    // 데몬 프로세스가 이 타이머 때문에 종료를 못 하는 일이 없도록.
    handle.idleTimer.unref?.();
  }

  /**
   * ★12h 유휴 리퍼 (데몬 keepAlive 스위퍼가 주기 호출).
   *
   * 마지막 활동(반납) 후 maxIdleMs 가 지난 **유휴** 프로세스를 죽인다 — 상주(resident)로
   * 붙든 것도 여기서는 예외가 아니다. 예외는 단 하나, reaperExempt(One 관련 상주)뿐이고,
   * 그마저 dispose(데몬 종료)에는 함께 죽는다. 사용 중(inUse)인 것은 절대 건드리지 않는다.
   *
   * 반환: 이번 패스에 죽인 수.
   */
  sweepIdle(maxIdleMs: number): number {
    const cutoff = this.now() - Math.max(1_000, maxIdleMs);
    let reaped = 0;
    for (const handle of [...this.handles]) {
      if (handle.inUse || handle.reaperExempt) continue;
      const idleSince = handle.idleSince ?? handle.lastActivityAt;
      if (idleSince <= cutoff) {
        this.remove(handle);
        reaped += 1;
      }
    }
    return reaped;
  }

  /** 죽은(exited) 프로세스를 목록에서 걷어낸다. */
  private reap(): void {
    for (const handle of [...this.handles]) {
      if (handle.exited) this.remove(handle);
    }
  }

  /** 유휴 중 가장 오래된 것을 죽인다. 사용 중인 것은 절대 건드리지 않는다. */
  private evictOldestIdle(): void {
    let victim: PooledProcessHandle | null = null;
    for (const handle of this.handles) {
      if (handle.inUse || handle.idleSince == null) continue;
      if (!victim || handle.idleSince < (victim.idleSince ?? Infinity)) victim = handle;
    }
    if (victim) this.remove(victim);
  }

  private remove(handle: PooledProcessHandle): void {
    const index = this.handles.indexOf(handle);
    if (index >= 0) this.handles.splice(index, 1);
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    }
    if (!handle.exited) {
      try { handle.child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }

  /** 붙든 프로세스 전부를 죽인다. 데몬 종료 시 host-lifecycle 이 부른다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachShutdown();
    for (const handle of [...this.handles]) this.remove(handle);
  }

  /** 진단용 — 붙들고 있는 프로세스 수(사용 중 + 유휴). */
  size(): number {
    return this.handles.length;
  }

  /** 진단용 — 지금 유휴로 붙들고 있는 수. */
  idleCount(): number {
    return this.handles.filter((h) => !h.inUse && !h.exited).length;
  }
}
