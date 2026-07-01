// Emergent 멀티에이전트 스웜 엔진 (순수 · DI · 결정적 테스트 가능).
//
// 위계형(CEO 중심) 오케스트레이션과 달리, 여기선 중앙 계획이 고정돼 있지 않다:
//   - 공유 블랙보드(board.tasks)에 작업이 쌓이고,
//   - 워커(에이전트)들이 준비된(의존성 충족) 작업을 동시성 한도 안에서 병렬로 집어 실행하고,
//   - 실행 중 새 작업을 *스폰*하거나 특정 역할(peer)에게 *핸드오프* → 그래프가 런타임에 자란다(emergent),
//   - 준비/실행 작업이 소진되면 종합(synthesize) → 최종 산출.
//
// 이 파일은 electron/DB/LLM에 의존하지 않는다. 실제 에이전트 실행(runTask)·종합(synthesize)·
// id 생성(nextId)은 훅으로 주입한다 → 가짜 훅으로 루프 로직을 결정적으로 유닛테스트할 수 있다.

export type SwarmTaskStatus = "pending" | "running" | "done" | "failed";

export interface SwarmTask {
  id: string;
  title: string;
  brief: string;
  /** 이 작업이 시작되려면 done 이어야 하는 task id들. 존재하지 않는 id는 충족된 것으로 본다(팬텀 무시). */
  deps: string[];
  /** 선호 전문가 역할(핸드오프 대상). 없으면 아무 워커나. */
  role?: string;
  status: SwarmTaskStatus;
  /** 산출물(에이전트 응답 본문). */
  result?: string;
  /** 이 작업을 스폰한 부모 task id (시드는 undefined). */
  spawnedBy?: string;
}

export interface SwarmBoard {
  goal: string;
  tasks: SwarmTask[];
  /** 스케줄 라운드 수(무한루프 백스톱용). */
  round: number;
}

/** 워커가 한 작업을 실행하고 돌려주는 결과 — 산출물 + 새로 스폰할 작업들 + 완료/실패 신호. */
export interface SwarmTurnResult {
  result: string;
  spawn?: Array<{ title: string; brief: string; deps?: string[]; role?: string }>;
  failed?: boolean;
}

export interface SwarmLimits {
  /** 동시 실행 워커 수 = 사용자 슬라이더(getAgentConcurrency). */
  concurrency: number;
  /** 총 작업 수 상한 — 무한 스폰(livelock)으로부터 컴을 지키는 최후 방어선. */
  maxTasks: number;
  /** 스케줄 라운드 상한 — 논리 버그로 인한 무한루프 백스톱. */
  maxRounds: number;
}

export type SwarmEvent =
  | { kind: "task-start"; task: SwarmTask }
  | { kind: "task-done"; task: SwarmTask }
  | { kind: "task-failed"; task: SwarmTask; reason?: string }
  | { kind: "spawn"; parent: string; tasks: SwarmTask[] }
  | { kind: "round"; round: number; ready: number; running: number; pending: number }
  | { kind: "synthesize" }
  | { kind: "capped"; reason: "maxTasks" | "maxRounds" | "aborted" };

export interface SwarmHooks {
  /** 한 작업을 에이전트로 실행 → 파싱된 결과. 주입(테스트=가짜, 실제=borrowed 워커). */
  runTask: (task: SwarmTask, board: SwarmBoard, signal?: AbortSignal) => Promise<SwarmTurnResult>;
  /** 완료된 블랙보드를 하나의 최종 산출로 종합. */
  synthesize: (board: SwarmBoard, signal?: AbortSignal) => Promise<string>;
  /** 안정적 id 생성(주입 → 테스트 결정성). */
  nextId: () => string;
  /** 진행 이벤트(라이브 UI). */
  onEvent?: (ev: SwarmEvent) => void;
}

export interface SwarmSeed {
  title: string;
  brief: string;
  role?: string;
  deps?: string[];
}

function depsSatisfied(task: SwarmTask, byId: Map<string, SwarmTask>): boolean {
  return task.deps.every((d) => {
    const dep = byId.get(d);
    return !dep || dep.status === "done"; // 팬텀 dep(존재X)은 충족으로 간주 → 데드락 방지
  });
}

function hasFailedDep(task: SwarmTask, byId: Map<string, SwarmTask>): boolean {
  return task.deps.some((d) => byId.get(d)?.status === "failed");
}

/** 실패한 의존성 때문에 영원히 못 도는 pending 작업을 연쇄 실패 처리(고정점까지 반복). */
function cascadeFail(board: SwarmBoard, byId: Map<string, SwarmTask>, onEvent?: (e: SwarmEvent) => void): void {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < board.tasks.length + 1) {
    changed = false;
    for (const t of board.tasks) {
      if (t.status === "pending" && hasFailedDep(t, byId)) {
        t.status = "failed";
        onEvent?.({ kind: "task-failed", task: t, reason: "upstream-failed" });
        changed = true;
      }
    }
  }
}

/**
 * 스웜 실행. 시드 작업으로 블랙보드를 만들고, 동시성 한도 안에서 준비된 작업을 병렬 실행하며,
 * 런타임 스폰/핸드오프로 그래프를 키우다가 소진되면 종합한다.
 */
export async function runSwarm(
  goal: string,
  seeds: SwarmSeed[],
  limits: SwarmLimits,
  hooks: SwarmHooks,
  signal?: AbortSignal,
): Promise<{ board: SwarmBoard; final: string; aborted: boolean; doneCount: number }> {
  const concurrency = Math.max(1, Math.floor(limits.concurrency));
  const board: SwarmBoard = {
    goal,
    round: 0,
    tasks: seeds.slice(0, Math.max(1, limits.maxTasks)).map((s) => ({
      id: hooks.nextId(),
      title: s.title,
      brief: s.brief,
      deps: s.deps ?? [],
      role: s.role,
      status: "pending" as const,
    })),
  };
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const running = new Map<string, Promise<void>>();

  const launch = (task: SwarmTask): void => {
    task.status = "running";
    hooks.onEvent?.({ kind: "task-start", task });
    const p = (async () => {
      try {
        const r = await hooks.runTask(task, board, signal);
        task.result = r.result;
        if (r.failed) {
          task.status = "failed";
          hooks.onEvent?.({ kind: "task-failed", task });
        } else {
          task.status = "done";
          hooks.onEvent?.({ kind: "task-done", task });
          // 스폰/핸드오프 = 런타임 그래프 성장. **성공한 작업만** 스폰(실패 작업의 스폰은 무시).
          // maxTasks 상한을 넘으면 무시(capped).
          if (r.spawn && r.spawn.length > 0) {
            const added: SwarmTask[] = [];
            for (const s of r.spawn) {
              if (board.tasks.length >= limits.maxTasks) {
                hooks.onEvent?.({ kind: "capped", reason: "maxTasks" });
                break;
              }
              const nt: SwarmTask = {
                id: hooks.nextId(),
                title: s.title,
                brief: s.brief,
                deps: s.deps ?? [],
                role: s.role,
                status: "pending",
                spawnedBy: task.id,
              };
              board.tasks.push(nt);
              byId.set(nt.id, nt);
              added.push(nt);
            }
            if (added.length > 0) hooks.onEvent?.({ kind: "spawn", parent: task.id, tasks: added });
          }
        }
      } catch {
        task.status = "failed";
        hooks.onEvent?.({ kind: "task-failed", task, reason: "threw" });
      } finally {
        running.delete(task.id);
      }
    })();
    running.set(task.id, p);
  };

  for (;;) {
    if (signal?.aborted) {
      hooks.onEvent?.({ kind: "capped", reason: "aborted" });
      break;
    }
    if (board.round >= limits.maxRounds) {
      hooks.onEvent?.({ kind: "capped", reason: "maxRounds" });
      break;
    }
    board.round += 1;

    // 실패 의존성으로 영원히 못 도는 작업 정리(데드락 방지).
    cascadeFail(board, byId, hooks.onEvent);

    const ready = board.tasks.filter((t) => t.status === "pending" && depsSatisfied(t, byId));
    const pendingCount = board.tasks.filter((t) => t.status === "pending").length;
    hooks.onEvent?.({ kind: "round", round: board.round, ready: ready.length, running: running.size, pending: pendingCount });

    // 빈 슬롯만큼만 준비된 작업 실행(슬롯 = 동시성 − 실행중). ready 스냅샷을 슬롯 수로 잘라 명확히.
    const slots = Math.max(0, concurrency - running.size);
    for (const task of ready.slice(0, slots)) launch(task);

    if (running.size === 0) {
      // 실행 중도 없고 새로 띄운 것도 없다 → 수렴했거나 남은 게 전부 막힘.
      const stillPending = board.tasks.some((t) => t.status === "pending");
      if (!stillPending) break; // 정상 수렴
      // pending 인데 준비도 실행도 안 됨 = 막힌 상태 → 실패 처리하고 종료(무한루프 방지).
      for (const t of board.tasks) {
        if (t.status === "pending") {
          t.status = "failed";
          hooks.onEvent?.({ kind: "task-failed", task: t, reason: "blocked" });
        }
      }
      break;
    }

    // 최소 하나가 끝날 때까지 대기 → 재평가(그 사이 스폰된 새 작업이 반영된다).
    await Promise.race(running.values());
    await Promise.resolve(); // 마이크로태스크 flush — 완료 워커의 finally(running.delete)가 확실히 반영되게.
  }

  // 남은 실행 정리(취소/조기종료 시 아직 도는 워커가 있을 수 있다).
  if (running.size > 0) await Promise.allSettled(running.values());

  // 사용자가 중단(abort)했으면 추가 LLM 호출(종합) 없이 지금까지 결과만 반환한다.
  if (signal?.aborted) {
    const doneCount = board.tasks.filter((t) => t.status === "done").length;
    return { board, final: "", aborted: true, doneCount };
  }

  hooks.onEvent?.({ kind: "synthesize" });
  const final = await hooks.synthesize(board, signal);
  return { board, final, aborted: false, doneCount: board.tasks.filter((t) => t.status === "done").length };
}
