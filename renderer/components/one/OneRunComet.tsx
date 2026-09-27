"use client";

/*
 * 사이드바 "지금 도는 것" 표시 — 세션 줄과 태스크포스 타일 테두리를 도는 작은 혜성.
 *
 * 무엇이 "도는 중"인가(오너 2026-09-27):
 *  - Main 이 실행 중이라고 방송한 대화(invoke:activeChats — 실행·정리·목표 검증 포함).
 *    5초 새로고침만 기다리지 않고 방송을 직접 구독해 실행이 끝나는 즉시 멈춘다.
 *  - 목표가 살아 있어 턴 사이에서 다음 이어가기 실행을 기다리는 대화(Main invoke:goalActiveChats).
 *    long_runs 상태가 바뀔 때마다 Main 이 내는 store:changed {entity:"long-run"} 에 맞춰 다시 묻는다
 *    — 폴링 없음. 목표가 끝나거나 멈추거나 취소되면 그 방송 직후 빠진다.
 *  - 단, 오너를 기다리는 대화는 돌지 않는다: 실행 중 동기 질문(ask-user), 브라우저 승인,
 *    도구 승인(live), 그리고 답을 기다리는 확인 카드(confirm.listPending).
 *    "기다림"은 대화 안 카드가 알려 주고, 혜성은 "지금 일하는 중"만 말한다.
 */
import { useEffect, useMemo, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useToolApprovals } from "@/lib/tool-approvals";
import styles from "./OneRunComet.module.css";

export const oneRunCometHostClass = styles.host;

const COMET_DOTS = [0, 1, 2, 3, 4, 5, 6, 7];

export function OneRunComet({ running, locale, variant = "row" }: { running: boolean; locale: "ko" | "en"; variant?: "row" | "tile" }) {
  if (!running) return null;
  return <>
    <span className={styles.comet} aria-hidden="true" data-one-run-comet="true" data-variant={variant}>
      {COMET_DOTS.map((index) => <span key={index} className={styles.dot} />)}
    </span>
    <span className={styles.srOnly} data-one-run-comet-label="true">{locale === "ko" ? "실행 중" : "Running"}</span>
  </>;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * 혜성을 돌릴 대화 id 집합.
 * @param polledActiveChatIds 셸이 5초마다 받아 둔 실행 중 목록(첫 값·방송 유실 시 복구용)
 * @param pendingConfirmations 오너 답을 기다리는 확인 카드(대화 id 만 본다)
 */
export function useOneSpinningChatIds(
  polledActiveChatIds: readonly string[],
  pendingConfirmations: readonly { chatId: string }[],
): ReadonlySet<string> {
  const [activeIds, setActiveIds] = useState<readonly string[]>(polledActiveChatIds);
  const [goalActiveIds, setGoalActiveIds] = useState<readonly string[]>([]);
  const [askWaits, setAskWaits] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [browserWaits, setBrowserWaits] = useState<ReadonlyMap<string, string>>(() => new Map());
  const toolApprovals = useToolApprovals();

  // 새로고침 값과 방송 값 중 나중에 온 것이 이긴다.
  useEffect(() => {
    setActiveIds((current) => (sameIds(current, polledActiveChatIds) ? current : polledActiveChatIds));
  }, [polledActiveChatIds]);

  useEffect(() => {
    const events = ipcEvents();
    if (!events) return;
    const unsubscribers: Array<() => void> = [];
    try {
      unsubscribers.push(events.onActiveChats((chatIds) => {
        const next = Array.isArray(chatIds) ? chatIds : [];
        setActiveIds((current) => (sameIds(current, next) ? current : next));
      }));
    } catch {
      // 방송이 없으면 새로고침 값으로만 그린다.
    }
    const track = (
      setter: typeof setAskWaits,
      requestId: string,
      chatId: string | null | undefined,
      expiresAt: number,
    ) => setter((current) => {
      const live = expiresAt > Date.now() && Boolean(chatId);
      if (live ? current.get(requestId) === chatId : !current.has(requestId)) return current;
      const next = new Map(current);
      if (live) next.set(requestId, chatId as string);
      else next.delete(requestId);
      return next;
    });
    try {
      if (events.onAskUser) unsubscribers.push(events.onAskUser((request) => track(setAskWaits, request.requestId, request.chatId, request.expiresAt)));
    } catch {
      // Older preload.
    }
    try {
      if (events.onBrowserApproval) unsubscribers.push(events.onBrowserApproval((request) => track(setBrowserWaits, request.requestId, request.owner?.chatId, request.expiresAt)));
    } catch {
      // Older preload.
    }
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, []);

  // 살아 있는 목표: 처음 한 번, 그 뒤로는 장기 실행·대화가 바뀌었다는 Main 방송이 올 때만 다시 묻는다.
  useEffect(() => {
    const api = ipc();
    const read = api?.invoke.goalActiveChats;
    if (!read) return;
    let disposed = false;
    let inFlight = false;
    let again = false;
    const refresh = () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      void read().then((ids) => {
        if (disposed) return;
        const next = Array.isArray(ids) ? ids : [];
        setGoalActiveIds((current) => (sameIds(current, next) ? current : next));
      }, () => undefined).finally(() => {
        inFlight = false;
        if (again && !disposed) { again = false; refresh(); }
      });
    };
    refresh();
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = ipcEvents()?.onStoreChanged?.((change) => {
        if (change?.entity === "long-run" || change?.entity === "chat") refresh();
      });
    } catch {
      unsubscribe = undefined;
    }
    return () => { disposed = true; unsubscribe?.(); };
  }, []);

  return useMemo(() => {
    const waiting = new Set<string>(pendingConfirmations.map((item) => item.chatId));
    for (const chatId of askWaits.values()) waiting.add(chatId);
    for (const chatId of browserWaits.values()) waiting.add(chatId);
    for (const request of toolApprovals.queue) {
      if (request.chatId && toolApprovals.actions.get(request.id)?.phase !== "terminal") waiting.add(request.chatId);
    }
    return new Set([...activeIds, ...goalActiveIds].filter((chatId) => !waiting.has(chatId)));
  }, [activeIds, goalActiveIds, askWaits, browserWaits, pendingConfirmations, toolApprovals]);
}
