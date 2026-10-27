"use client";

/*
 * 개인 에이전트가 감독하는 방의 승인 — 개인 대화 작성창 위에 그 방의 승인 카드를 그대로 편다.
 *
 * ★오너 2026-10-27: "승인카드가 다른 대화에 들어가서 못 봤다. 개인 에이전트가 총괄해야 한다 — 개인 에이전트 UI/UX 에
 *   뜨게." 2026-08-15(승인 카드는 그 대화 안에서만)·2026-09-29(화면에 없는 대화는 전환기 점만) 결정의 예외는 이 화면
 *   하나다. 다른 화면의 동작은 그대로다.
 *  - 어느 방이 감독 대상인지는 Main 이 정한다(oneSupervisor.supervisedRooms → electron/one/supervised-approvals.ts):
 *    개인 에이전트가 맡긴 Work 방, 메시지를 보낸 방, 팀원 디스패치 방. 화면은 고르지 않는다.
 *  - 카드는 원래 방의 chatId·요청 id 로 기존 컴포넌트(ToolApprovalCard·BrowserActionApprovalSheet)가 그리고, 답도 원래
 *    방의 요청으로 간다(새 답 경로 없음). 먼저 답한 쪽이 이기고, 다른 곳(원래 방·폰)의 답은 기존 terminal 처리
 *    (lib/tool-approvals)와 브라우저 정산 이벤트(expiresAt 0)로 정리된다. 원래 방에서도 같은 카드가 보이는 것은 정상이다.
 *  - 결제 같은 바닥 카드도 같은 카드다. 오너가 직접 누르는 자리이므로 화면은 구분하지 않는다.
 *  - 오너 2026-10-27(승인카드 디자인): 방마다 묶음으로 쌓지 않고 하나의 큐에서 한 장씩 보인다 — 카드 위에 작은 방 칩
 *    "{방} · 방 열기", 카드 머리 줄에 "1/3 · 다음". 답하면 즉시 다음 건이 같은 자리에 온다(lib/tool-approvals useApprovalDeck).
 * 선례: OneDispatchNotice(팀원 방 카드를 그 방 chatId 로 그리고 markChatVisible 로 보이는 대화로 등록).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { markChatVisible, useApprovalDeck, useToolApprovals } from "@/lib/tool-approvals";
import { pendingConfirmationHref } from "@/lib/open-pending-confirmation";
import type { BrowserApprovalRequestEvent } from "@/lib/types";
import type { SupervisedRoom } from "../../../shared/one-supervisor";
import { ToolApprovalCard } from "@/components/ToolApprovalInline";
import { BrowserActionApprovalSheet } from "@/components/BrowserActionApprovalSheet";
import { IconShield } from "@/components/Icon";

const ROOM_REFRESH_MS = 15_000;

/** Browser approvals Main is still waiting on (same list + events the room's own sheet reads), each with its room. */
function usePendingBrowserRequests(exclude: string | null): Array<{ id: string; chatId: string }> {
  const [pending, setPending] = useState<ReadonlyMap<string, BrowserApprovalRequestEvent>>(new Map());
  // A request Main already closed (answered anywhere, or expired) never comes back from a slower list read.
  const closed = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    const merge = (incoming: BrowserApprovalRequestEvent[], replace: boolean) => setPending((prior) => {
      const now = Date.now();
      const next = replace ? new Map<string, BrowserApprovalRequestEvent>() : new Map(prior);
      for (const item of incoming) {
        if (item.expiresAt <= now) { closed.current.add(item.requestId); next.delete(item.requestId); }
        else if (!closed.current.has(item.requestId)) next.set(item.requestId, item);
      }
      for (const [id, item] of next) if (item.expiresAt <= now) next.delete(id);
      return next;
    });
    const off = ipcEvents()?.onBrowserApproval?.((request) => merge([request], false));
    const read = () => {
      void ipc()?.browser?.listPendingApprovals?.()
        .then((list) => { if (active && Array.isArray(list)) merge(list, true); })
        .catch(() => { /* push events remain */ });
    };
    read();
    const timer = window.setInterval(read, ROOM_REFRESH_MS);
    return () => { active = false; off?.(); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const soonest = Math.min(...[...pending.values()].map((item) => item.expiresAt));
    if (!Number.isFinite(soonest)) return;
    const timer = window.setTimeout(() => setPending((prior) => new Map([...prior].filter(([, item]) => item.expiresAt > Date.now()))),
      Math.max(0, soonest - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return useMemo(() => {
    const requests: Array<{ id: string; chatId: string }> = [];
    for (const item of pending.values()) {
      const owner = item.owner;
      if (owner && owner.context !== "build" && owner.chatId && owner.chatId !== exclude) requests.push({ id: item.requestId, chatId: owner.chatId });
    }
    return requests;
  }, [pending, exclude]);
}

export function PersonalOneSupervisedApprovals({ conversationChatId, locale, composerWidth, onOpenRoom }: {
  /** The personal conversation; its own cards are drawn by its own ToolApprovalInline. */
  conversationChatId: string | null | undefined;
  locale: "ko" | "en";
  composerWidth?: number;
  onOpenRoom: (href: string) => void;
}) {
  const ko = locale === "ko";
  const copy = (a: string, b: string) => (ko ? a : b);
  const personal = conversationChatId ?? null;
  const { queue } = useToolApprovals();
  const browserRequests = usePendingBrowserRequests(personal);
  const toolRequests = useMemo(
    () => queue.filter((request) => request.chatId && request.chatId !== personal),
    [queue, personal],
  );
  const candidates = useMemo(
    () => [...new Set([...toolRequests.map((request) => request.chatId as string), ...browserRequests.map((request) => request.chatId)])],
    [toolRequests, browserRequests],
  );
  const candidateKey = [...candidates].sort().join("\n");

  // Main answers which of these rooms the personal agent oversees; an unanswered or failed read keeps the last answer.
  const [rooms, setRooms] = useState<ReadonlyMap<string, SupervisedRoom>>(new Map());
  useEffect(() => {
    if (!personal || !candidateKey) return;
    const chatIds = candidateKey.split("\n");
    let active = true;
    const read = () => {
      const api = ipc()?.oneSupervisor;
      if (!api?.supervisedRooms) return;
      void api.supervisedRooms({ conversationChatId: personal, chatIds })
        .then((list) => { if (active && Array.isArray(list)) setRooms(new Map(list.map((room) => [room.chatId, room]))); })
        .catch(() => { /* the cards stay in their own rooms */ });
    };
    read();
    // A room can become supervised after its card appeared (the hand-off row lands a moment later).
    const timer = window.setInterval(read, ROOM_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [personal, candidateKey]);

  const shown = personal ? candidates.filter((chatId) => rooms.has(chatId)) : [];
  const shownKey = shown.join("\n");
  // Same as OneDispatchNotice: a room whose cards are on screen here is not also a switcher dot.
  useEffect(() => {
    if (!shownKey) return;
    const release = shownKey.split("\n").map((chatId) => markChatVisible(chatId));
    return () => { for (const off of release) off(); };
  }, [shownKey]);

  // One queue, one card at a time: tool approvals first (arrival order), then browser ones.
  const items = useMemo(() => {
    const live = new Set(shown);
    return [
      ...toolRequests.filter((request) => live.has(request.chatId as string))
        .map((request) => ({ id: request.id, kind: "tool" as const, chatId: request.chatId as string, request })),
      ...browserRequests.filter((request) => live.has(request.chatId))
        .map((request) => ({ id: request.id, kind: "browser" as const, chatId: request.chatId, request: null })),
    ];
  }, [shownKey, toolRequests, browserRequests]);
  const deck = useApprovalDeck(items);
  const item = deck.current;
  if (!shown.length || !item) return null;
  const openRoom = (chatId: string) => {
    void pendingConfirmationHref({ chatId }).then(onOpenRoom).catch(() => { /* the room stays reachable from its list */ });
  };
  const title = rooms.get(item.chatId)?.title?.trim() || copy("이름 없는 방", "an untitled room");
  const cardDeck = { index: deck.index, total: deck.total, onPrev: deck.prev, onNext: deck.next };
  return (
    <section
      className="tool-approval-inline"
      data-personal-supervised-approvals="true"
      aria-label={copy("개인 에이전트가 감독 중인 방의 승인", "Approvals in rooms your personal agent oversees")}
      style={composerWidth ? ({ "--agentlas-composer-width": `${composerWidth}px` } as CSSProperties) : undefined}
    >
      <div key={item.id} data-supervised-room={item.chatId} style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <div data-supervised-room-line="true" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "0 4px",
          fontSize: 12, lineHeight: 1.4, color: "var(--muted-deep)" }}>
          <IconShield size={13} />
          <span title={title} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <span aria-hidden>·</span>
          <button type="button" data-supervised-room-open="true" onClick={() => openRoom(item.chatId)}
            aria-label={copy(`${title} 방 열기`, `Open ${title}`)}
            style={{ flex: "none", padding: 0, border: 0, background: "none", color: "var(--ink-soft)", font: "inherit",
              fontWeight: 650, textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>
            {copy("방 열기", "Open room")}
          </button>
        </div>
        {item.kind === "tool"
          ? <ToolApprovalCard key={item.id} request={item.request} compact chip deck={cardDeck} />
          : <BrowserActionApprovalSheet key={item.id} chatId={item.chatId} supervisedRoom pinRequestId={item.id} deck={cardDeck} />}
      </div>
      {/* The room's browser card sits in this stack, not at the bottom of the window (its default standalone place). */}
      <style jsx global>{`
        [data-personal-supervised-approvals] [data-browser-action-approval-wrap="true"] {
          position: relative;
          inset: auto;
          transform: none;
          width: 100%;
          max-width: none;
          z-index: auto;
          pointer-events: auto;
        }
      `}</style>
    </section>
  );
}
