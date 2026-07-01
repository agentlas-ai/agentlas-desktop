// 트리거 매니저(설계 §3.3) — 단일 공유 인프로세스 매니저. 이벤트 계열 트리거(fs/chain)를
// 리스너에 등록해 유휴 비용 0으로 감시하고, 발사 시 조건 게이트를 1회 평가한 뒤 통과하면
// 기존 실행 경로(automation-scheduler.runAutomationNow)로 합류한다. 실행 엔진은 손대지 않는다.
//
// 자동화당 watcher-프로세스를 절대 만들지 않는다(설계 §3.1 금지). fs는 경로당 watcher 1개
// (fs-watcher.ts가 공유), chain은 EventEmitter 1개(chain-bus.ts). poll 계열은 P2.
//
// launchd 헤드리스 러너에서는 이벤트 트리거를 등록하지 않는다(창 없이 1회 실행 후 종료).
// 이벤트 계열은 "앱 켜졌을 때만" 도는 Tier 0 소스라는 설계 전제를 그대로 따른다.
import type { Automation } from "../../shared/types";
import { listEnabledByTrigger } from "../store/automations";
import { watchPath, unwatchAutomation, closeAllWatchers, type FsChangeKind } from "./fs-watcher";
import { onAutomationDone, type AutomationCompletion } from "./chain-bus";
import { evaluateCondition } from "./condition";
import { setPollRunFn, runPollDue, forgetPollState, clearPollStates } from "./poll-sources";
import { startWebhookServer, stopWebhookServer } from "./webhook-server";

// 자동화 id → fs 구독 해제 함수들.
const fsUnsubs = new Map<string, Array<() => void>>();
let chainUnsub: (() => void) | null = null;
let started = false;

/** 매니저가 발사할 때 호출할 실행 함수(스케줄러가 주입 — 정적 순환 회피). */
type RunFn = (automationId: string, ctx?: { output?: string }) => Promise<void>;
let runFn: RunFn | null = null;

function fire(a: Automation, vars: Record<string, unknown>): void {
  // 트리거 게이트 조건(onlyIf) 1회 평가. false면 스킵(설계 §3.4 Tier 0 #3 하이브리드).
  const cond = a.trigger && "onlyIf" in a.trigger ? a.trigger.onlyIf : undefined;
  if (!evaluateCondition(cond, vars)) return;
  if (!runFn) return;
  const output = typeof vars.output === "string" ? vars.output : undefined;
  void runFn(a.id, output ? { output } : undefined).catch(() => {
    /* 실행 오류는 스케줄러가 run_history에 기록 */
  });
}

function registerFs(a: Automation): void {
  if (!a.trigger || a.trigger.kind !== "fs") return;
  const path = a.trigger.path;
  const on: FsChangeKind = a.trigger.on;
  const debounceMs = typeof a.trigger.debounceMs === "number" && a.trigger.debounceMs > 0 ? a.trigger.debounceMs : 400;
  const unsub = watchPath(path, {
    automationId: a.id,
    on,
    debounceMs,
    fire: (info) => fire(a, { path: info.path, changedPath: info.changedPath ?? "", kind: info.kind }),
  });
  const list = fsUnsubs.get(a.id) ?? [];
  list.push(unsub);
  fsUnsubs.set(a.id, list);
}

function handleChain(completion: AutomationCompletion): void {
  // chain 트리거를 가진 enabled 자동화 중, afterAutomationId가 방금 끝난 것과 일치하는 것 발사.
  const chained = listEnabledByTrigger("chain");
  for (const a of chained) {
    if (a.trigger && a.trigger.kind === "chain" && a.trigger.afterAutomationId === completion.automationId) {
      // 선행 실행이 성공했을 때만 체인(실패 전파 방지).
      if (!completion.ok) continue;
      fire(a, { output: completion.output ?? "", ok: String(completion.ok) });
    }
  }
}

/**
 * 트리거 매니저 기동 — 이벤트 계열 트리거를 리스너에 등록한다. 스케줄러의 실행 함수를
 * 주입받아 정적 순환을 피한다. 이미 시작됐으면 재동기화만 한다.
 */
export function startTriggerManager(run: RunFn): void {
  runFn = run;
  if (!started) {
    started = true;
    chainUnsub = onAutomationDone(handleChain);
    // 폴 매니저(설계 §3.4 Tier 1)에 실행 함수 주입. 폴 자체는 새 타이머 없이 스케줄러
    // 60초 틱이 pollTick()으로 구동한다(per-automation 타이머 금지).
    setPollRunFn((id) => run(id));
    // webhook 리스너(설계 §3.4 Tier 2) 기동 — 소켓 1개 공유. 로컬 전용(공인 URL은 터널 필요).
    void startWebhookServer((id, ctx) => run(id, ctx)).catch((err) => {
      console.error("[triggers] startWebhookServer failed:", err);
    });
  }
  syncTriggers();
}

/**
 * 폴 트리거 구동 — 스케줄러 60초 틱이 매 틱 호출한다(설계 §3.3 "폴링은 새 타이머 안 만듦").
 * nextPollAt<=now인 poll 자동화만 검사한다. 매니저 미기동이면 no-op.
 */
export async function pollTick(now: Date = new Date()): Promise<void> {
  if (!started) return;
  try {
    await runPollDue(now);
  } catch (err) {
    console.error("[triggers] pollTick failed:", err);
  }
}

/** DB의 enabled 이벤트 트리거들과 현재 리스너를 동기화(생성/토글/삭제 후 호출). */
export function syncTriggers(): void {
  if (!started) return;
  // fs 구독을 전부 걷어내고 현재 enabled fs 트리거로 다시 건다(간단·정확, 개수 작음).
  for (const id of Array.from(fsUnsubs.keys())) {
    unwatchAutomation(id);
    fsUnsubs.delete(id);
  }
  const fsAutos = listEnabledByTrigger("fs");
  for (const a of fsAutos) registerFs(a);

  // 폴 상태 정리 — 더 이상 enabled poll이 아닌 자동화의 인메모리 상태를 버린다(다음 폴에서
  // ensureState가 재하이드레이트). 리스너 등록은 없음(폴은 틱 구동, 리스너 아님).
  const pollIds = new Set(listEnabledByTrigger("poll").map((a) => a.id));
  for (const id of Array.from(prevPollIds)) {
    if (!pollIds.has(id)) forgetPollState(id);
  }
  prevPollIds = pollIds;
}

// 직전 동기화 시점의 enabled poll 자동화 id — 사라진 것만 forgetPollState.
let prevPollIds = new Set<string>();

/** 매니저 정지(앱 종료/테스트) — 모든 리스너 해제. */
export function stopTriggerManager(): void {
  if (chainUnsub) {
    chainUnsub();
    chainUnsub = null;
  }
  closeAllWatchers();
  fsUnsubs.clear();
  stopWebhookServer();
  clearPollStates();
  prevPollIds = new Set();
  started = false;
  runFn = null;
}
