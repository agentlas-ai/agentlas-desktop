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

import type { WorkloadAllocation } from "../runtime/workload-routing";

export type SwarmTaskStatus = "pending" | "running" | "done" | "failed";

export interface SwarmTask {
  id: string;
  title: string;
  brief: string;
  /** 이 작업이 시작되려면 done 이어야 하는 task id들. 존재하지 않는 id는 충족된 것으로 본다(팬텀 무시). */
  deps: string[];
  /** 선호 전문가 역할(핸드오프 대상). 없으면 아무 워커나. */
  role?: string;
  /** 이 작업이 쓰려는 프로젝트 상대 파일 경로들(워커가 선언).
   *  모든 워커가 같은 cwd를 공유하고 write/full이면 동시에 쓴다 — 파일 락도 worktree 격리도 없다.
   *  선언된 파일이 실행 중인 작업과 겹치면 스케줄러가 이번 라운드에 띄우지 않고 기다린다
   *  (deps와 같은 기존 대기 메커니즘, 새 상태 없음). 선언이 없으면 예전처럼 그냥 동시 실행. */
  files?: string[];
  status: SwarmTaskStatus;
  /** 산출물(에이전트 응답 본문). */
  result?: string;
  /** 이 작업을 스폰한 부모 task id (시드는 undefined). */
  spawnedBy?: string;
  /** Parent worker's provider-neutral assignment for this child task. */
  allocation?: WorkloadAllocation;
  /** Host-validated runtime/model/effort actually used; synthesis receives this as evidence. */
  resolvedAllocation?: {
    runtimeId: string | null;
    runtimeKind: string | null;
    model: string | null;
    effort: string | null;
    source: string;
    resolutionCodes: string[];
  };
}

export interface SwarmBoard {
  goal: string;
  tasks: SwarmTask[];
  /** 스케줄 라운드 수(무한루프 백스톱용). */
  round: number;
  /** Parent-AI-authored assignment for the final synthesis turn. */
  synthesisAllocation?: WorkloadAllocation;
}

/** 워커가 한 작업을 실행하고 돌려주는 결과 — 산출물 + 새로 스폰할 작업들 + 완료/실패 신호. */
export interface SwarmTurnResult {
  result: string;
  spawn?: Array<{ title: string; brief: string; deps?: string[]; role?: string; files?: string[]; allocation?: WorkloadAllocation }>;
  synthesisAllocation?: WorkloadAllocation;
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

/**
 * Host-visible completion verdict. A synthesis is useful even when some
 * packets failed, but it is never evidence that the shared goal completed.
 */
export interface SwarmFinalGate {
  canReportSuccess: boolean;
  status: "success" | "blocked" | "aborted";
  required: number;
  passing: string[];
  blocked: string[];
  incomplete: string[];
}

export interface SwarmRunResult {
  board: SwarmBoard;
  final: string;
  aborted: boolean;
  doneCount: number;
  finalGate: SwarmFinalGate;
}

export type SwarmEvent =
  | { kind: "task-start"; task: SwarmTask }
  | { kind: "task-done"; task: SwarmTask }
  | { kind: "task-failed"; task: SwarmTask; reason?: string }
  | { kind: "spawn"; parent: string; tasks: SwarmTask[] }
  | { kind: "round"; round: number; ready: number; running: number; pending: number }
  | { kind: "file-deferred"; task: SwarmTask; files: string[] }
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
  /** 이 작업이 쓸 프로젝트 상대 경로들 — 스케줄러의 파일 충돌 직렬화 근거. */
  files?: string[];
  allocation?: WorkloadAllocation;
}

/** 선언된 쓰기 대상 경로를 비교 가능한 형태로. 표기 차이로 충돌을 놓치지 않게 한다. */
function normalizedFiles(task: SwarmTask): string[] {
  if (!task.files?.length) return [];
  return [
    ...new Set(
      task.files
        .map((file) => String(file ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Evaluate the only completion claim a swarm is allowed to make. */
export function evaluateSwarmFinalGate(board: SwarmBoard, aborted = false): SwarmFinalGate {
  const passing = board.tasks.filter((task) => task.status === "done").map((task) => task.id);
  const blocked = board.tasks.filter((task) => task.status === "failed").map((task) => task.id);
  const incomplete = board.tasks
    .filter((task) => task.status === "pending" || task.status === "running")
    .map((task) => task.id);
  return {
    canReportSuccess: !aborted && blocked.length === 0 && incomplete.length === 0 && passing.length === board.tasks.length,
    status: aborted ? "aborted" : blocked.length > 0 || incomplete.length > 0 ? "blocked" : "success",
    required: board.tasks.length,
    passing,
    blocked,
    incomplete,
  };
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
): Promise<SwarmRunResult> {
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
      ...(s.files?.length ? { files: s.files } : {}),
      allocation: s.allocation,
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
          if (r.synthesisAllocation && !board.synthesisAllocation) {
            board.synthesisAllocation = r.synthesisAllocation;
          }
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
                ...(s.files?.length ? { files: s.files } : {}),
                allocation: s.allocation,
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
    // 파일이 겹치는 작업은 슬롯이 남아도 띄우지 않는다: 워커들은 cwd를 공유하므로 동시에 같은
    // 파일을 쓰면 서로의 편집(또는 사용자 변경)을 덮어쓴다. 취소가 아니라 직렬화 — 앞 작업이
    // 끝나면 다음 라운드에 자연히 잡힌다. 선언이 없으면 겹침을 알 수 없으므로 기존과 동일하게 동시 실행.
    const slots = Math.max(0, concurrency - running.size);
    const claimedFiles = new Set<string>();
    for (const task of board.tasks) {
      if (task.status === "running") for (const file of normalizedFiles(task)) claimedFiles.add(file);
    }
    let launched = 0;
    for (const task of ready) {
      if (launched >= slots) break;
      const wanted = normalizedFiles(task);
      const conflicts = wanted.filter((file) => claimedFiles.has(file));
      if (conflicts.length > 0) {
        hooks.onEvent?.({ kind: "file-deferred", task, files: conflicts });
        continue;
      }
      for (const file of wanted) claimedFiles.add(file);
      launch(task);
      launched += 1;
    }

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
    return { board, final: "", aborted: true, doneCount, finalGate: evaluateSwarmFinalGate(board, true) };
  }

  hooks.onEvent?.({ kind: "synthesize" });
  const final = await hooks.synthesize(board, signal);
  return {
    board,
    final,
    aborted: false,
    doneCount: board.tasks.filter((t) => t.status === "done").length,
    finalGate: evaluateSwarmFinalGate(board),
  };
}
