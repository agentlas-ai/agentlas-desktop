// 트리거 매니저(설계 §3.3) — 단일 공유 인프로세스 매니저. 이벤트 계열 트리거(fs/chain)를
// 리스너에 등록해 유휴 비용 0으로 감시하고, 발사 시 조건 게이트를 1회 평가한 뒤 통과하면
// 기존 실행 경로(automation-scheduler.runAutomationNow)로 합류한다. 실행 엔진은 손대지 않는다.
//
// 자동화당 watcher-프로세스를 절대 만들지 않는다(설계 §3.1 금지). fs는 경로당 watcher 1개
// (fs-watcher.ts가 공유), chain은 durable terminal receipt/outbox가 진실이고 EventEmitter는
// 이미 커밋된 fan-out을 즉시 깨우는 가속 신호뿐이다. poll 계열은 P2.
//
// launchd 헤드리스 러너에서는 이벤트 트리거를 등록하지 않는다(창 없이 1회 실행 후 종료).
// launchd가 만든 durable chain occurrence는 같은 DB outbox에 남아 GUI 없이도 drain된다.
import type { Automation } from "../../shared/types";
import { randomUUID } from "node:crypto";
import { listEnabledByTrigger, reconcileDurableChainDeliveries } from "../store/automations";
import { enqueueTriggerEvent, parkRejectedSourceTriggerEvent } from "../store/trigger-events";
import { watchPath, unwatchAutomation, closeAllWatchers, type FsChangeKind } from "./fs-watcher";
import { onAutomationDone, type AutomationCompletion } from "./chain-bus";
import { evaluateCondition } from "./condition";
import { runPollDue, forgetPollState, clearPollStates } from "./poll-sources";
import { startWebhookServer, stopWebhookServer } from "./webhook-server";
import {
  startTriggerOutbox,
  stopTriggerOutbox,
  wakeTriggerOutbox,
  type TriggerEventRunFn,
} from "./outbox";

// 자동화 id → fs 구독 해제 함수들.
const fsUnsubs = new Map<string, Array<() => void>>();
let chainUnsub: (() => void) | null = null;
let started = false;
const sourceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function fire(a: Automation, vars: Record<string, unknown>, dedupeKey: string): void {
  // 트리거 게이트 조건(onlyIf) 1회 평가. false면 스킵(설계 §3.4 Tier 0 #3 하이브리드).
  const cond = a.trigger && "onlyIf" in a.trigger ? a.trigger.onlyIf : undefined;
  if (!evaluateCondition(cond, vars)) return;
  if (!a.trigger || a.trigger.kind === "schedule" || a.trigger.kind === "poll") return;
  const payload = Object.fromEntries(
    Object.entries(vars).filter(([, value]) =>
      value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ),
  );
  const persist = (attempt: number): void => {
    try {
      enqueueTriggerEvent({
        automationId: a.id,
        triggerKind: a.trigger!.kind,
        dedupeKey,
        payload,
      });
      const pending = sourceRetryTimers.get(dedupeKey);
      if (pending) clearTimeout(pending);
      sourceRetryTimers.delete(dedupeKey);
      wakeTriggerOutbox();
    } catch (error) {
      // fs.watch and the in-process chain accelerator have no sender retry
      // contract. Keep the same stable occurrence in memory and never let an
      // enqueue failure escape the callback and terminate the main process.
      console.error(`[triggers] source event persistence failed (${dedupeKey}):`, error);
      if (/trigger_event_enqueue_rejected/.test(error instanceof Error ? error.message : String(error))) {
        try {
          const parked = parkRejectedSourceTriggerEvent({
            automationId: a.id,
            triggerKind: a.trigger!.kind,
            dedupeKey,
            payload,
            error: "trigger_event_source_contract_changed_before_enqueue",
          });
          if (parked) wakeTriggerOutbox();
          return;
        } catch (parkError) {
          console.error(`[triggers] source event attention persistence failed (${dedupeKey}):`, parkError);
        }
      }
      if (sourceRetryTimers.has(dedupeKey)) return;
      const timer = setTimeout(() => {
        sourceRetryTimers.delete(dedupeKey);
        persist(Math.min(attempt + 1, 8));
      }, Math.min(1_000 * 2 ** attempt, 30_000));
      timer.unref?.();
      sourceRetryTimers.set(dedupeKey, timer);
    }
  };
  persist(0);
}

function reconcileChainReceipts(): void {
  try {
    const repaired = reconcileDurableChainDeliveries();
    if (repaired.inserted > 0) wakeTriggerOutbox();
  } catch (error) {
    console.error("[triggers] durable chain receipt reconciliation failed:", error);
  }
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
    fire: (info) => fire(
      a,
      { path: info.path, changedPath: info.changedPath ?? "", kind: info.kind },
      `fs:${randomUUID()}`,
    ),
  });
  const list = fsUnsubs.get(a.id) ?? [];
  list.push(unsub);
  fsUnsubs.set(a.id, list);
}

function handleChain(_completion: AutomationCompletion): void {
  // The scheduler already committed the exact fan-out beside its terminal
  // receipt. This in-process bus is only a low-latency wake signal; it is never
  // the source of truth and cannot create a second interpretation of output or
  // cycle policy.
  reconcileChainReceipts();
  wakeTriggerOutbox();
}

/**
 * 트리거 매니저 기동 — 이벤트 계열 트리거를 리스너에 등록한다. 스케줄러의 실행 함수를
 * 주입받아 정적 순환을 피한다. 이미 시작됐으면 재동기화만 한다.
 */
export function startTriggerManager(run: TriggerEventRunFn): void {
  startTriggerOutbox(run);
  if (!started) {
    started = true;
    chainUnsub = onAutomationDone(handleChain);
    // webhook 리스너(설계 §3.4 Tier 2) 기동 — 소켓 1개 공유. 로컬 전용(공인 URL은 터널 필요).
    void startWebhookServer().catch((err) => {
      console.error("[triggers] startWebhookServer failed:", err);
    });
  }
  reconcileChainReceipts();
  syncTriggers();
}

/**
 * 폴 트리거 구동 — 스케줄러 60초 틱이 매 틱 호출한다(설계 §3.3 "폴링은 새 타이머 안 만듦").
 * nextPollAt<=now인 poll 자동화만 검사한다. 매니저 미기동이면 no-op.
 */
export async function pollTick(now: Date = new Date()): Promise<void> {
  if (!started) return;
  reconcileChainReceipts();
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
  stopTriggerOutbox();
  for (const timer of sourceRetryTimers.values()) clearTimeout(timer);
  sourceRetryTimers.clear();
  prevPollIds = new Set();
  started = false;
}
