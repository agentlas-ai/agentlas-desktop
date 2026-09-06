"use client";

/*
 * 도구 승인 대기열 — 화면 어디서든 같은 큐를 본다.
 *
 * ★오너 결정(2026-08-15): 승인 카드는 **묻는 순간, 그 실행이 붙어 있는 대화 안에서만**
 * 뜬다. 예전에는 시트가 AppShell 전역 모달이라 대시보드든 설정이든 지금 보고 있는 화면
 * 위로 튀어나왔고, 그 실행이 어느 대화의 것인지 화면이 알 길이 없었다.
 *
 * 그래서 이 모듈은
 *  - live 요청만 담는다. post-denial(런타임이 이미 거부하고 지나간 것)은 카드가 아니라
 *    실행 본문의 알림 한 줄로만 남는다 — 이미 각 러너가 onNotice 로 남기고 있다.
 *  - 요청의 `chatId` 로 "어느 대화 것인가"를 들고 다닌다. 대화 화면은 자기 chatId 로
 *    카드를 인라인 렌더하고, 다른 화면은 배지만 본다.
 *  - 답을 한 번만 보낸다(같은 id 는 한 번 결정되면 큐에서 사라진다).
 */
import { useSyncExternalStore } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type {
  ToolApprovalRequestEvent,
  ToolApprovalDecision,
  ToolApprovalDurableConsentReceipt,
} from "@/lib/types";
import {
  commitToolApprovalDecision,
  isToolApprovalResolutionReceipt,
  reconcileToolApprovalDecision,
  toolApprovalActionId,
  type ToolApprovalDecisionResult,
} from "@shared/tool-approval-action";
import { isChatAlwaysApproved, waitForAlwaysApprovedChats } from "./always-approved-chats";

let queue: ToolApprovalRequestEvent[] = [];
const visibleChats = new Map<string, number>();
const listeners = new Set<() => void>();
let subscribed = false;
const decided = new Set<string>();
export type ToolApprovalActionState = {
  phase: "submitting" | "retryable" | "unknown" | "terminal";
  decision: ToolApprovalDecision;
  terminalStatus?: "expired" | "conflict";
  resolvedDecision?: ToolApprovalDecision | null;
  durableConsent?: ToolApprovalDurableConsentReceipt;
};
const actions = new Map<string, ToolApprovalActionState>();

type Snapshot = {
  queue: ToolApprovalRequestEvent[];
  visible: ReadonlySet<string>;
  actions: ReadonlyMap<string, ToolApprovalActionState>;
};
let current: Snapshot = { queue, visible: new Set(), actions: new Map() };

function emit(): void {
  // useSyncExternalStore 는 스냅샷 참조가 바뀌어야 다시 그린다 — 큐든 가시성이든 변할 때
  // 새 객체를 만든다.
  current = { queue, visible: new Set(visibleChats.keys()), actions: new Map(actions) };
  for (const fn of listeners) fn();
}

async function upsert(next: ToolApprovalRequestEvent): Promise<void> {
  if (next.mode !== "live") return; // 사후 고지는 카드가 아니다.
  if (decided.has(next.id) || queue.some((item) => item.id === next.id)) return;
  await waitForAlwaysApprovedChats();
  if (decided.has(next.id) || queue.some((item) => item.id === next.id)) return;
  /*
   * 이 대화에 이미 "항상 승인"을 준 사용자에게는 카드를 만들지 않는다.
   *
   * 큐에 넣고 화면에서 지우는 방식이면 카드가 한 프레임 깜빡이고, 무엇보다 사용자가
   * 이미 답한 질문을 제품이 또 꺼낸 셈이 된다. 여기서 바로 세션 허용으로 답하면
   * 실행이 멈추지 않는다 — 답 자체는 평소 경로(resolveToolApproval)로 나가므로
   * 영수증과 기록은 그대로 남는다.
   */
  if (isChatAlwaysApproved(next.chatId)) {
    // Auto-approval still needs an exact Main receipt. Keep the card in the
    // shared queue while it is being committed so a failed bridge cannot make
    // a live runtime question disappear without feedback.
    queue = [...queue, next];
    emit();
    void decideToolApproval(next.id, "allow_session");
    return;
  }
  queue = [...queue, next];
  emit();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  const events = ipcEvents();
  const api = ipc();
  if (!events?.onToolApproval || !api) return;
  subscribed = true;
  events.onToolApproval((item) => { void upsert(item); });
  events.onToolApprovalResolution?.((receipt) => {
    if (!isToolApprovalResolutionReceipt(receipt)) return;
    if (receipt.pending) return;
    const currentAction = actions.get(receipt.requestId);
    // This renderer already settled and dismissed the same receipt. A late
    // broadcast must not resurrect an orphan terminal action after the user
    // explicitly closed it.
    if (decided.has(receipt.requestId) && !currentAction && !queue.some((item) => item.id === receipt.requestId)) return;
    const exactOwnAction = currentAction?.phase === "submitting"
      && receipt.ok
      && receipt.resolvedDecision === currentAction.decision
      && receipt.actionId === toolApprovalActionId(receipt.requestId, currentAction.decision)
      && (receipt.status === "resolved" || receipt.status === "replayed");
    const exactSettledAction = currentAction?.phase === "terminal"
      && receipt.ok
      && receipt.resolvedDecision === (currentAction.resolvedDecision ?? currentAction.decision)
      && receipt.actionId === toolApprovalActionId(receipt.requestId, currentAction.resolvedDecision ?? currentAction.decision)
      && (receipt.status === "resolved" || receipt.status === "replayed");
    if (exactOwnAction || exactSettledAction || !queue.some((item) => item.id === receipt.requestId)) {
      // Main emitted this only after recording the exact runtime result. Our
      // own click may therefore finish from the event before the invoke reply.
      decided.add(receipt.requestId);
      const durableConsent = receipt.durableConsent ?? currentAction?.durableConsent;
      if (durableConsent && durableConsent.status !== "persisted") {
        actions.set(receipt.requestId, {
          phase: "terminal",
          decision: currentAction?.decision ?? receipt.resolvedDecision ?? "deny",
          resolvedDecision: receipt.resolvedDecision,
          durableConsent,
        });
        // Keep the request mounted so the user can see and dismiss a durable
        // save failure. A successful receipt can disappear immediately.
      } else {
        actions.delete(receipt.requestId);
        queue = queue.filter((item) => item.id !== receipt.requestId);
      }
      emit();
      return;
    }
    // A timeout or a decision from Mobile/another window is terminal, but it
    // is not the choice this card just sent. Keep one explicit result until the
    // user acknowledges it instead of silently dropping a stale-looking card.
    actions.set(receipt.requestId, {
      phase: "terminal",
      decision: currentAction?.decision ?? receipt.resolvedDecision ?? "deny",
      terminalStatus: receipt.status === "expired" ? "expired" : "conflict",
      resolvedDecision: receipt.resolvedDecision,
      durableConsent: receipt.durableConsent,
    });
    emit();
  });
  // 화면이 뜨기 전에 온 요청 — 메인이 아직 답을 기다리고 있으면 여기서 따라잡는다.
  void api.listToolApprovals?.().then((pending) => {
    for (const item of pending ?? []) void upsert(item);
  }).catch(() => {});
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  ensureSubscribed();
  return () => { listeners.delete(fn); };
}

const SERVER: Snapshot = { queue: [], visible: new Set(), actions: new Map() };
function snapshot(): Snapshot {
  return current;
}

/** 대기 중인 live 승인 요청 전부(렌더 순서 = 도착 순서) + 지금 보이는 대화 집합. */
export function useToolApprovals(): Snapshot {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER);
}

function applyDecisionResult(
  id: string,
  decision: ToolApprovalDecision,
  result: ToolApprovalDecisionResult,
): void {
  // The exact Main event can arrive before the invoke promise. Do not replace
  // that already-confirmed outcome with a later transport/readback error.
  if (decided.has(id)) {
    const previous = actions.get(id);
    const durableConsent = result.receipt?.durableConsent ?? previous?.durableConsent;
    if (durableConsent && durableConsent.status !== "persisted") {
      actions.set(id, {
        phase: "terminal",
        decision: previous?.decision ?? decision,
        resolvedDecision: result.receipt?.resolvedDecision ?? previous?.resolvedDecision,
        durableConsent,
      });
    } else {
      actions.delete(id);
    }
    queue = queue.filter((item) => item.id !== id);
    emit();
    return;
  }
  if (result.state === "resolved") {
    decided.add(id);
    const durableConsent = result.receipt.durableConsent;
    if (durableConsent && durableConsent.status !== "persisted") {
      actions.set(id, {
        phase: "terminal",
        decision,
        resolvedDecision: result.receipt.resolvedDecision,
        durableConsent,
      });
      // Retain the card until the user acknowledges that the current choice
      // ran but the durable rule was not committed.
    } else {
      queue = queue.filter((item) => item.id !== id);
      actions.delete(id);
    }
    emit();
    return;
  }
  if (result.state === "pending") {
    actions.set(id, { phase: "retryable", decision });
    emit();
    return;
  }
  if (result.state === "terminal") {
    actions.set(id, {
      phase: "terminal",
      decision,
      terminalStatus: result.receipt.status === "expired" ? "expired" : "conflict",
      resolvedDecision: result.receipt.resolvedDecision,
      durableConsent: result.receipt.durableConsent,
    });
    emit();
    return;
  }
  actions.set(id, { phase: "unknown", decision });
  emit();
}

/**
 * 사용자의 답. exact Main receipt 전에는 큐에서 지우지 않는다. false/reject/응답 유실은
 * resolution ledger + pending queue를 재조회하고, 실제 미적용이면 같은 카드를 복구한다.
 */
export async function decideToolApproval(id: string, decision: ToolApprovalDecision): Promise<void> {
  if (decided.has(id) || actions.get(id)?.phase === "submitting") return;
  const api = ipc();
  if (!api) {
    actions.set(id, { phase: "unknown", decision });
    emit();
    return;
  }
  actions.set(id, { phase: "submitting", decision });
  emit();
  const result = await commitToolApprovalDecision(api, id, decision);
  applyDecisionResult(id, decision, result);
}

/** Outcome-unknown 상태에서 결정을 다시 보내지 않고 Main 원장만 재조회한다. */
export async function refreshToolApprovalDecision(id: string): Promise<void> {
  const previous = actions.get(id);
  if (!previous || previous.phase === "submitting") return;
  const api = ipc();
  if (!api) return;
  actions.set(id, { ...previous, phase: "submitting" });
  emit();
  const result = await reconcileToolApprovalDecision(api, id, previous.decision);
  applyDecisionResult(id, previous.decision, result);
}

/** 만료·다른 표면의 결정처럼 이미 terminal인 카드만 사용자가 닫는다. */
export function dismissToolApproval(id: string): void {
  if (actions.get(id)?.phase !== "terminal") return;
  decided.add(id);
  actions.delete(id);
  queue = queue.filter((item) => item.id !== id);
  emit();
}

/*
 * "지금 화면에 보이는 대화" 등록 — 대화 화면이 마운트되면 자기 chatId 를 올려 둔다.
 * 전역 배지는 여기 없는 대화의 요청만 세고, 여기 있는 대화의 요청은 그 대화가 인라인으로
 * 그린다. 같은 대화를 두 화면이 동시에 보여도 각자 그리는 것은 무해하다(답은 한 번).
 */
export function markChatVisible(chatId: string | null | undefined): () => void {
  if (!chatId) return () => {};
  visibleChats.set(chatId, (visibleChats.get(chatId) ?? 0) + 1);
  emit();
  return () => {
    const n = (visibleChats.get(chatId) ?? 1) - 1;
    if (n <= 0) visibleChats.delete(chatId); else visibleChats.set(chatId, n);
    emit();
  };
}
/** 요청을 인라인으로 그릴 대화가 지금 화면에 없는가(→ 배지 대상). */
export function needsBadge(request: ToolApprovalRequestEvent, visible: ReadonlySet<string>): boolean {
  return !(request.chatId && visible.has(request.chatId));
}
