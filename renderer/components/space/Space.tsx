"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { homeBridge, rowDisplayName, type HomeTreeParticipant } from "@/lib/home-tree";
import { taskTitleForDisplay } from "@/lib/task-title";
import { useRunningChats } from "@/lib/running-chats";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import {
  confirmSpaceLimit, focusedSpaceChatId, openChatInSpace, persistSpaceLayout, placeInSpace, setSpaceNotice, setSpacePaneCapacity, updateSpaceLayout,
  useSpaceLayout, useSpaceNotice,
} from "@/lib/space-store";
import { forgetPaneDrafts } from "@/lib/pane-drafts";
import { closeNewChatStart, takeFirstMessage, useNewChatStart } from "@/lib/new-chat-start";
import { chatBelongsToOne } from "@shared/chat-surface";
import {
  closeOtherPanes, closeTab, columnSplit, dropChats, paneCapacity, relabelTabs, resizeColumns, setColumnSplit, setFocus, togglePin,
  SPACE_MIN_PANE_HEIGHT_PX, SPACE_MIN_PANE_PX, SPACE_MIN_WEIGHT, SPACE_WEIGHT_TOTAL, type SpacePane, type SpaceTab,
} from "@shared/space-layout";
import { ErrorBoundary } from "../ErrorBoundary";
import { AgentAvatar } from "../AgentAvatar";
import { WorkChatSurface } from "../TaskCockpit";
import { OneConversationPane, forgetOneComposerDrafts } from "../one/OneConversationPane";
import { IconChat, IconChevronDown, IconClose, IconCode, IconMoreHorizontal, IconPanelRight, IconUsers } from "../Icon";
import { WorkspacePaneProvider, type PaneActions, type WorkspacePane } from "./pane-context";
import { PinIcon } from "./PinIcon";
import { NewChatStart } from "./NewChatStart";
import { SpaceMenu, type SpaceMenuItem } from "./SpaceMenu";
import { hasChatDrag, readChatDrag, spaceCopy, startCopy, type SpaceLocale } from "./copy";
import styles from "./Space.module.css";

/*
 * Home's Space (Agentlas 2.0 decision; F-D4): up to four panes, one conversation each, no tabs. One pane fills the Space, two sit side by
 * side, three are two on top and one across the bottom, four are 2x2; the line between the columns is dragged (or moved with the arrow keys). A pane's
 * head is the title with a menu, a "..." menu and a close. The left list opens things here (a click fills the focused pane, "Open in a new pane" and a
 * drop on the right edge open the next one); a chat that is not in a pane is still in the list.
 *
 * Cost rules: every open pane is mounted (at most four) and a run goes on in Main whether its pane is open or not. Nothing here polls: titles and
 * existence are re-read when the store says that chat changed (coalesced), never on a clock.
 */

type ChatInfo = { state: "ok"; title: string; kind: "room" | "work"; group: boolean; members: number; names: string[] } | { state: "failed" };

/** Existence, kind and display name of the chats in Space - read when a tab appears and when the store says one changed. */
function useSpaceChatInfo(openKey: string, locale: SpaceLocale) {
  const ko = locale === "ko";
  const [info, setInfo] = useState<ReadonlyMap<string, ChatInfo>>(() => new Map());
  const infoRef = useRef(info);
  infoRef.current = info;
  const localeRef = useRef(ko);
  localeRef.current = ko;

  const check = useCallback(async (ids: string[]) => {
    const api = ipc();
    if (!api || ids.length === 0) return;
    const bridge = homeBridge();
    const [chats, rows] = await Promise.all([
      Promise.all(ids.map((id) => api.chats.get(id).then((chat) => ({ id, chat, ok: true as const })).catch(() => ({ id, chat: null, ok: false as const })))),
      bridge ? bridge.rowsByIds(ids).catch(() => null) : Promise.resolve(null),
    ]);
    const rowById = new Map((rows?.rows ?? []).map((row) => [row.id, row]));
    const gone = new Set<string>();
    const kinds = new Map<string, "room" | "work">();
    const next = new Map(infoRef.current);
    for (const result of chats) {
      // A read that FAILED is not "gone": the tab stays and says so (never a blank pane, never a lost tab on a hiccup).
      if (!result.ok) { next.set(result.id, { state: "failed" }); continue; }
      const chat = result.chat;
      if (!chat || chat.archivedAt || chat.kind !== "user") { gone.add(result.id); next.delete(result.id); continue; }
      const kind = chatBelongsToOne(chat) ? "room" : "work";
      const row = rowById.get(result.id);
      const fallback = localeRef.current ? "새 대화" : "New chat";
      const raw = row ? (row.kind === "work" ? taskTitleForDisplay(row.title, localeRef.current) : row.title) : (kind === "work" ? taskTitleForDisplay(chat.title, localeRef.current) : chat.title);
      const title = !raw || raw === "New chat" ? (row ? rowDisplayName(row, fallback) : fallback) : raw;
      kinds.set(result.id, kind);
      next.set(result.id, { state: "ok", title, kind, group: row?.kind === "group", members: row?.kind === "group" ? Math.max(row.memberCount, row.agentNames.length) : 0, names: kind === "room" && row ? row.agentNames.slice(0, 3) : [] });
    }
    setInfo((previous) => {
      if (previous.size === next.size && [...next].every(([id, value]) => { const before = previous.get(id); return before && JSON.stringify(before) === JSON.stringify(value); })) return previous;
      return next;
    });
    if (gone.size) { forgetPaneDrafts(gone); forgetOneComposerDrafts(gone); }
    if (gone.size || kinds.size) updateSpaceLayout((layout) => relabelTabs(dropChats(layout, gone), kinds));
  }, []);

  // New tabs are read; closed ones are forgotten (the map never outgrows the 16 tabs).
  useEffect(() => {
    const open = openKey ? openKey.split(",") : [];
    const missing = open.filter((id) => !infoRef.current.has(id));
    if ([...infoRef.current.keys()].some((id) => !open.includes(id))) setInfo((previous) => new Map([...previous].filter(([id]) => open.includes(id))));
    if (missing.length) void check(missing);
  }, [openKey, check]);

  // A store change for an open chat (rename, delete, archive) re-reads that chat, at most once per 3 s; no clock involved.
  useEffect(() => {
    const pending = new Set<string>();
    let all = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      timer = null;
      const open = new Set(openKeyRef.current ? openKeyRef.current.split(",") : []);
      const ids = all ? [...open] : [...pending].filter((id) => open.has(id));
      pending.clear(); all = false;
      if (ids.length) void check(ids);
    };
    const off = subscribeStoreChanges((change) => {
      const open = openKeyRef.current;
      if (!open) return;
      if (change.entity === "chat" && change.id) { if (!open.split(",").includes(change.id)) return; pending.add(change.id); }
      else if (change.entity === "project" || change.entity === "chat") all = true;
      else return;
      if (!timer) timer = setTimeout(fire, 3000);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [check]);
  const openKeyRef = useRef(openKey);
  openKeyRef.current = openKey;

  const retry = useCallback((id: string) => { void check([id]); }, [check]);
  return { info, retry };
}


/** The head's first mark (workspace-v3-two): a group or 1:1 room shows its member faces (24px, one overlapped line); a Work session shows the terminal mark.
 *  A room whose members are not known yet keeps the icon, so the head never jumps in width for long. */
const TerminalMark = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.3" /><path d="M4.6 6.2l2.2 1.8-2.2 1.8M8.6 10h2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const KindIcon = ({ kind, group, names }: { kind: "room" | "work"; group: boolean; names: string[] }) => {
  if (kind === "work") return <TerminalMark />;
  if (names.length === 0) return group ? <IconUsers size={14} /> : <IconChat size={14} />;
  return <span className={styles.paneFaces} data-faces={group ? "group" : "solo"}>{names.map((name, index) => <AgentAvatar key={`${name}:${index}`} name={name} size={24} />)}</span>;
};

const PaneBody = memo(function PaneBody({ tab, paneId, entry, focused, locale, onRetry, onClose }: {
  tab: SpaceTab; paneId: string; entry: ChatInfo | undefined; focused: boolean; locale: SpaceLocale; onRetry: (id: string) => void; onClose: (chatId: string) => void;
}) {
  const copy = spaceCopy(locale);
  // "New session" of a work conversation in a pane: a new chat that continues this one (the same call the Work page makes), opened in this same pane;
  // the old one stays in the left list. A refusal throws and the conversation says so in its own words.
  // The first message the New chat start screen made (a Work session sends it itself; an Agent Chat room by its own send): taken once when this pane draws that chat (nothing is sent for any other chat).
  // Kept with the chat it was made for: a pane that later shows another chat (a replaced tab) never hands it this chat's first message.
  const [held, setHeld] = useState<{ chatId: string; text: string } | null>(null);
  useEffect(() => { const text = takeFirstMessage(tab.chatId); if (text) setHeld({ chatId: tab.chatId, text }); }, [tab.chatId]);
  const firstMessage = held && held.chatId === tab.chatId ? held.text : null;
  const onNewSession = useCallback(async () => {
    const api = ipc();
    const chat = api ? await api.chats.get(tab.chatId) : null;
    if (!api || !chat) throw new Error("chat_unavailable");
    const created = await api.chats.create({ agentId: chat.agentId, projectId: chat.projectId, firmId: chat.firmId, continueFromChatId: chat.id });
    if (!created?.id || created.id === chat.id || created.agentId !== chat.agentId || (created.projectId ?? null) !== (chat.projectId ?? null) || (created.firmId ?? null) !== (chat.firmId ?? null)) throw new Error("chat_create_receipt_mismatch");
    openChatInSpace({ chatId: created.id, kind: "work" }, "replace-pane", paneId);
  }, [tab.chatId, paneId]);
  if (!entry) return <p className={styles.note} role="status">{copy.loading}</p>;
  if (entry.state === "failed") return <div className={styles.note} role="alert">{copy.failed}<br /><button type="button" onClick={() => onRetry(tab.chatId)}>{copy.retry}</button></div>;
  if (entry.kind === "work") return <div style={{ flex: 1, minHeight: 0, display: "flex" }}><WorkChatSurface chatId={tab.chatId} embedded scopeActive={focused} onNewSession={onNewSession} startPrompt={firstMessage} /></div>;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr)" }}>
      <OneConversationPane chatId={tab.chatId} paneId={paneId} focused={focused} onClose={onClose} startPrompt={firstMessage} />
    </div>
  );
});


/** The grid of a Space `count` panes big and `cols` columns wide: panes in reading order, three = the third one across the bottom. */
function gridFor(count: number, cols: 1 | 2, share: number): React.CSSProperties {
  if (cols === 1) return { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: count > 1 ? `repeat(${count}, minmax(${SPACE_MIN_PANE_HEIGHT_PX + 60}px, 1fr))` : "minmax(0, 1fr)" };
  return {
    gridTemplateColumns: count > 1 ? `minmax(0, ${share}fr) minmax(0, ${1 - share}fr)` : "minmax(0, 1fr)",
    gridTemplateRows: count > 2 ? `repeat(2, minmax(${SPACE_MIN_PANE_HEIGHT_PX}px, 1fr))` : "minmax(0, 1fr)",
  };
}

export function Space() {
  const { locale: appLocale } = useT();
  const locale: SpaceLocale = appLocale === "ko" ? "ko" : "en";
  const copy = spaceCopy(locale);
  const layout = useSpaceLayout();
  const { panes, focus } = layout.space;
  const openKey = useMemo(() => panes.flatMap((pane) => pane.tabs.map((tab) => tab.chatId)).join(","), [panes]);
  const { info, retry } = useSpaceChatInfo(openKey, locale);
  const running = useRunningChats();
  const pinned = useMemo(() => new Set(layout.pinned), [layout.pinned]);
  const [menu, setMenu] = useState<{ x: number; y: number; paneId: string; kind: "title" | "more" | "lead"; anchor: HTMLElement | null } | null>(null);
  // The members of the group room whose title menu is open (workspace-v2-pop-pane 9): read when that menu opens, never on a clock.
  const [roomMembers, setRoomMembers] = useState<{ chatId: string; list: HomeTreeParticipant[] } | null>(null);
  const menuChatId = menu ? (layout.space.panes.find((item) => item.id === menu.paneId)?.active ?? layout.space.panes.find((item) => item.id === menu.paneId)?.tabs[0]?.chatId ?? "") : "";
  const menuIsGroup = (() => { const entry = info.get(menuChatId); return entry?.state === "ok" && entry.kind === "room" && entry.group; })();
  const menuKind = menu?.kind;
  useEffect(() => {
    if (!menuKind || menuKind === "more" || !menuIsGroup || !menuChatId) return;
    let alive = true;
    void homeBridge()?.participants(menuChatId).then((list) => { if (alive) setRoomMembers({ chatId: menuChatId, list }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [menuKind, menuIsGroup, menuChatId]);
  const [dragging, setDragging] = useState(false);
  // What each pane's conversation surface lets the pane's head do (F-D5). A surface sets it on mount and clears it on unmount; the head is
  // re-drawn only when a flag it shows changes.
  const start = useNewChatStart();
  const [paneActions, setPaneActions] = useState<Readonly<Record<string, PaneActions>>>({});
  const setActionsOf = useCallback((paneId: string, actions: PaneActions | null) => {
    setPaneActions((previous) => {
      if (!actions) { if (!(paneId in previous)) return previous; const { [paneId]: _gone, ...rest } = previous; return rest; }
      return { ...previous, [paneId]: actions };
    });
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const notice = useSpaceNotice();
  // The Space's size decides how many panes a new open may add (two columns need 2 x 300 px, two rows 2 x 260 px) and whether it is drawn as one column; the store
  // learns the capacity so an open that wants one pane more than fit is refused with a notice. Panes already open are always drawn (stacked and scrolling when narrow).
  const [box, setBox] = useState({ width: 0, height: 0 });
  const capacity = paneCapacity(box.width, box.height);
  const cols: 1 | 2 = box.width > 0 && box.width < 2 * SPACE_MIN_PANE_PX ? 1 : 2;
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const measure = () => { setBox((previous) => (previous.width === row.clientWidth && previous.height === row.clientHeight ? previous : { width: row.clientWidth, height: row.clientHeight })); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [panes.length === 0]);
  useEffect(() => { setSpacePaneCapacity(capacity); }, [capacity]);

  // A drag from the left list is on screen: show where it can land. Cleared on any end of the drag.
  useEffect(() => {
    const start = (event: DragEvent) => { if (hasChatDrag(event)) setDragging(true); };
    const end = () => setDragging(false);
    document.addEventListener("dragenter", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => { document.removeEventListener("dragenter", start); document.removeEventListener("dragend", end); document.removeEventListener("drop", end); };
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Cmd/Ctrl+1..4 moves the focus to that pane and into its composer (the keyboard way between panes).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || !/^[1-4]$/.test(event.key)) return;
      const target = updateSpacePaneFocus(Number(event.key) - 1);
      if (!target) return;
      event.preventDefault();
      window.setTimeout(() => document.querySelector<HTMLElement>(`[data-space-pane="${target}"] textarea, [data-space-pane="${target}"] [contenteditable="true"]`)?.focus(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const say = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  const closeChat = useCallback((chatId: string) => {
    if (running.has(chatId)) say(copy.runsOn);
    updateSpaceLayout((source) => closeTab(source, chatId));
  }, [copy.runsOn, running, say]);

  const menuItems = useMemo((): SpaceMenuItem[] => {
    if (!menu) return [];
    const pane = layout.space.panes.find((item) => item.id === menu.paneId);
    if (!pane) return [];
    const chatId = pane.active ?? pane.tabs[0]?.chatId ?? "";
    const ko = locale === "ko";
    const members = roomMembers && roomMembers.chatId === chatId ? roomMembers.list : [];
    // Who leads: the first member of the room (the room's order is the one the lead router reads).
    if (menu.kind === "lead") {
      return members.slice(1).map((member) => ({
        id: `lead-${member.agentId}`, label: member.name ?? (ko ? "삭제된 에이전트" : "Removed agent"), icon: <AgentAvatar name={member.name ?? "?"} size={20} />,
        onSelect: () => {
          void ipc()?.chats?.setAgentChatLead?.({ chatId, agentId: member.agentId })
            .then(() => setRoomMembers(null))
            .catch((failure: unknown) => say(String((failure as { message?: unknown } | null)?.message ?? "").replace(/^Error invoking remote method '[^']*': (Error: )?/, "") || (ko ? "팀장을 바꾸지 못했어요." : "Could not change the lead.")));
        },
      }));
    }
    if (menu.kind === "title" && menuIsGroup && members.length > 0) {
      // The room's own member dialog (the one the "N명" mark opens) adds members; when the room has not drawn it, the person is told instead of nothing happening.
      const addMembers = () => { const button = document.querySelector<HTMLElement>(`[data-space-body="${pane.id}"] [data-one-taskforce-badge]`)?.closest("button"); if (button) button.click(); else say(ko ? "멤버 관리를 열지 못했어요." : "Could not open the member list."); };
      return [
        ...members.map((member, index): SpaceMenuItem => ({
          id: `member-${member.agentId}`, label: member.name ?? (ko ? "삭제된 에이전트" : "Removed agent"), icon: <AgentAvatar name={member.name ?? "?"} size={20} />,
          badge: index === 0 ? (ko ? "팀장" : "lead") : undefined, onSelect: () => undefined,
        })),
        { id: "add-member", label: ko ? "멤버 추가" : "Add member", dividerBefore: true, onSelect: addMembers },
        { id: "change-lead", label: ko ? "팀장 바꾸기" : "Change lead", disabled: members.length < 2, onSelect: () => { const anchor = menu.anchor; const box = anchor?.getBoundingClientRect(); setMenu({ x: box?.left ?? menu.x, y: box?.bottom ?? menu.y, paneId: menu.paneId, kind: "lead", anchor }); } },
      ];
    }
    if (menu.kind === "title") {
      const isPinned = pinned.has(chatId);
      return [{ id: "pin", label: isPinned ? copy.unpin : copy.pin, onSelect: () => updateSpaceLayout((source) => togglePin(source, chatId)) }];
    }
    // The conversation's own rows first (New session, Clear history, the two panels the old head held), then the pane's.
    const actions = resolvePaneActions(pane.id, info.get(chatId), paneActions[pane.id]);
    const own: SpaceMenuItem[] = [];
    // The one side panel (tabs inside it: Overview, results, files...): its row is first, as in the confirmed picture (workspace-v2-pop-pane 12).
    if (actions.viewer) own.push({ id: "side-panel", label: actions.viewer.open ? copy.sidePanelClose : copy.sidePanelOpen, onSelect: () => actions.viewer?.toggle() });
    if (actions.session) own.push({ id: "new-session", label: copy.newSession, dividerBefore: own.length > 0, onSelect: () => actions.session?.("new") });
    if (actions.session && actions.canClear) own.push({ id: "clear-history", label: copy.clearHistory, disabled: actions.busy, onSelect: () => actions.session?.("clear") });
    if (actions.sessions) own.push({ id: "agent-sessions", label: copy.agentSessions, onSelect: () => actions.sessions?.() });
    return [
      ...own,
      { id: "close", label: copy.closePane, dividerBefore: own.length > 0, onSelect: () => closeChat(chatId) },
      { id: "close-others", label: copy.closeOthers, disabled: layout.space.panes.length < 2, onSelect: () => updateSpaceLayout((source) => closeOtherPanes(source, pane.id)) },
    ];
  }, [menu, layout.space.panes, pinned, copy, closeChat, info, paneActions, roomMembers, menuIsGroup, locale, say]);

  if (panes.length === 0) return <EmptySpace dragging={dragging} locale={locale} projectId={start?.projectId ?? null} />;

  const share = columnSplit(panes);
  const canOpenNew = panes.length < Math.min(capacity, 4);
  // New chat (F-D6): the start screen is a pane of its own while there is room for one more; when the Space is full it covers the focused pane
  // (that pane stays mounted underneath and comes back when the start is closed or begun).
  const draft: "extra" | "cover" | null = start && start.projectId !== "current" ? (canOpenNew ? "extra" : "cover") : null;
  const drawn = panes.length + (draft === "extra" ? 1 : 0);
  return (
    <div ref={rowRef} className={styles.space} role="group" aria-label={copy.spaceLabel} data-space="true" data-pane-count={drawn} data-cols={cols}>
      <div className={styles.grid} data-space-grid="true" style={gridFor(drawn, cols, share)}>
      {panes.map((pane, index) => (
        <PaneView key={pane.id} pane={pane} index={index} across={drawn === 3 && index === 2 && cols === 2} canOpenNew={canOpenNew}
          cover={draft === "cover" && focus === pane.id ? start : null} onStarted={(chatId, kind) => { closeNewChatStart(); openChatInSpace({ chatId, kind }, "replace-pane", pane.id); }}
          focused={focus === pane.id} info={info} running={running} pinned={pinned} dragging={dragging} locale={locale}
          actions={paneActions[pane.id]} setActions={setActionsOf}
          onClose={closeChat} onMenu={(paneId, kind, x, y, anchor) => setMenu({ paneId, kind, x, y, anchor })} onRetry={retry} />
      ))}
      {draft === "extra" && start ? (
        <DraftPane key={start.nonce} across={drawn === 3 && cols === 2} projectId={start.projectId} locale={locale} onClose={closeNewChatStart}
          onStarted={(chatId, kind) => { closeNewChatStart(); openChatInSpace({ chatId, kind }, "new-pane"); }} />
      ) : null}
      </div>
      {cols === 2 && drawn > 1 ? <Border share={share} short={drawn === 3} rowRef={rowRef} locale={locale} /> : null}
      {menu ? <SpaceMenu x={menu.x} y={menu.y} label={copy.menuFor} items={menuItems} returnFocus={menu.anchor} onClose={() => setMenu(null)} /> : null}
      {toast ? <div className={styles.toast} role="status" data-space-toast="true">{toast}</div> : null}
      {notice ? <SpaceNoticeBar notice={notice} info={info} locale={locale} /> : null}
    </div>
  );
}

/** The one-line notice for a refused open (four panes are open, or the window holds fewer than are open). Nothing is ever closed behind the person's back: the person may put the chat in the pane they are on instead. */
function SpaceNoticeBar({ notice, info, locale }: { notice: NonNullable<ReturnType<typeof useSpaceNotice>>; info: ReadonlyMap<string, ChatInfo>; locale: SpaceLocale }) {
  const copy = spaceCopy(locale);
  const entry = notice.block.paneId ? focusedInfo(info) : undefined;
  const title = entry?.state === "ok" ? entry.title : "";
  return (
    <div className={styles.notice} role="alert" data-space-notice={notice.block.reason} data-space-limit-reason={notice.block.reason}>
      <span>{notice.block.reason === "full" ? copy.limitFull : copy.limitNarrow(notice.block.capacity)}</span>
      <button type="button" className={styles.noticeBtn} data-space-limit-replace="true" onClick={confirmSpaceLimit}>{copy.limitReplace(title)}</button>
      <button type="button" className={styles.noticeBtn} onClick={() => setSpaceNotice(null)}>{copy.limitKeep}</button>
    </div>
  );
}
function focusedInfo(info: ReadonlyMap<string, ChatInfo>): ChatInfo | undefined {
  const id = focusedSpaceChatId();
  return id ? info.get(id) : undefined;
}

/** Focuses the n-th pane (0-based); returns its id, or null when there is no such pane. */
function updateSpacePaneFocus(index: number): string | null {
  let id: string | null = null;
  updateSpaceLayout((source) => {
    id = source.space.panes[index]?.id ?? null;
    return id ? setFocus(source, id) : source;
  });
  return id;
}

function EmptySpace({ dragging, locale, projectId }: { dragging: boolean; locale: SpaceLocale; projectId: string | null }) {
  const copy = spaceCopy(locale);
  const [over, setOver] = useState(false);
  return (
    <div className={styles.empty} data-space-empty="true"
      onDragOver={(event) => { if (hasChatDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        const drag = readChatDrag(event);
        setOver(false);
        if (!drag) return;
        event.preventDefault();
        openChatInSpace(drag, "replace-pane");
      }}>
      {/* No pane is open: the start screen is the Space (F-D6) - the project of nothing on screen is "Empty project". */}
      <DraftPane across={false} projectId={projectId} locale={locale} fills
        onStarted={(chatId, kind) => { closeNewChatStart(); openChatInSpace({ chatId, kind }, "replace-pane"); }} />
      {dragging || over ? <div className={styles.emptyDrop} aria-hidden="true">{copy.dropEmpty}</div> : null}
    </div>
  );
}

/**
 * The head of the New chat start (workspace-v5-start-default): the title with its drop-down, the side-panel button and the pane menu, and the close button.
 * No chat exists yet, so the title menu and the pane menu hold the one thing that is true of a pane with nothing in it - close it - and the side panel
 * button is drawn off (it opens once the chat exists, like a conversation head that has nothing to show).
 */
function DraftHead({ locale, onClose, cover = false }: { locale: SpaceLocale; onClose?: () => void; cover?: boolean }) {
  const copy = spaceCopy(locale);
  const title = startCopy(locale).title;
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null);
  const open = (event: React.MouseEvent<HTMLButtonElement>) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom, anchor: event.currentTarget }); };
  return (
    <header className={cover ? styles.coverBar : styles.paneHead} data-space-draft-head="true">
      <span className={styles.paneKind} aria-hidden="true"><IconCode size={13} /></span>
      <button type="button" className={styles.paneTitle} aria-haspopup="menu" aria-expanded={menu !== null} title={title} data-space-draft-title="true" onClick={open}>
        <span className={styles.paneTitleText}>{title}</span><IconChevronDown size={14} />
      </button>
      <span className={styles.paneSpacer} />
      <button type="button" className={styles.paneIcon} aria-label={copy.panel} title={copy.panel} disabled data-space-draft-panel="true"><IconPanelRight size={15} /></button>
      <button type="button" className={styles.paneIcon} aria-label={copy.paneMenu} aria-haspopup="menu" aria-expanded={menu !== null} data-space-draft-menu="true" onClick={open}><IconMoreHorizontal size={15} /></button>
      <button type="button" className={styles.paneIcon} aria-label={`${copy.closePane}: ${title}`} disabled={!onClose} data-space-draft-close="true" onClick={onClose}><IconClose size={15} /></button>
      {menu ? <SpaceMenu x={menu.x} y={menu.y} label={copy.paneMenu} returnFocus={menu.anchor} onClose={() => setMenu(null)} items={[{ id: "close", label: copy.closePane, disabled: !onClose, onSelect: () => onClose?.() }]} /> : null}
    </header>
  );
}

/** The New chat start screen drawn as a pane: a head with its title (and a close when there is another pane to go back to) and the start screen as the body. */
function DraftPane({ across, projectId, locale, fills = false, onStarted, onClose }: {
  across: boolean; projectId: string | null; locale: SpaceLocale; fills?: boolean; onStarted: (chatId: string, kind: "room" | "work") => void; onClose?: () => void;
}) {
  const copy = spaceCopy(locale);
  const title = startCopy(locale).title;
  return (
    <section className={styles.pane} style={across ? { gridColumn: "1 / -1" } : fills ? { height: "100%" } : undefined} data-space-draft="true" data-focused="true" aria-label={title}>
      <DraftHead locale={locale} onClose={onClose} />
      <div className={styles.body}><NewChatStart projectId={projectId} onStarted={onStarted} /></div>
    </section>
  );
}


/**
 * The head's actions for a pane: what a work surface registered, or - for a room (the personal agent's conversation view, whose own head is not drawn
 * and whose file this change does not touch) - its own two buttons, pressed. The room's buttons are looked up when the person acts (a click, the menu
 * opening), never watched: nothing here observes the conversation or runs on a clock.
 */
interface ResolvedPaneActions { sessions?: () => void; session?: (action: "new" | "clear") => void; canClear: boolean; busy: boolean; viewer?: { toggle: () => void; enabled: boolean; open: boolean } }
const roomButton = (paneId: string, selector: string): HTMLButtonElement | null => (typeof document === "undefined" ? null : document.querySelector<HTMLButtonElement>(`[data-space-body="${paneId}"] ${selector}`));
/** Presses the old head's Task menu and then one of its rows (the row exists only after the menu opened, so this waits for two frames - an event, not a poll). */
function pressRoomTaskMenu(paneId: string, rowPattern: RegExp): void {
  const toggle = roomButton(paneId, "[data-one-task-menu] > button");
  if (!toggle) return;
  toggle.click();
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const row = [...document.querySelectorAll<HTMLButtonElement>(`[data-space-body="${paneId}"] [data-one-task-menu] [role="menuitem"]`)].find((item) => rowPattern.test(item.textContent ?? ""));
    if (row) row.click(); else toggle.click();
  }));
}
function resolvePaneActions(paneId: string, entry: ChatInfo | undefined, registered: PaneActions | undefined): ResolvedPaneActions {
  if (entry?.state === "ok" && entry.kind === "work") return { session: registered?.session, canClear: Boolean(registered?.session), busy: Boolean(registered?.busy), viewer: registered?.viewer };
  const fresh = roomButton(paneId, "[data-one-new-session-header]");
  return {
    session: fresh ? () => fresh.click() : undefined, canClear: false, busy: false,
    sessions: () => pressRoomTaskMenu(paneId, /agent sessions|에이전트 세션/i),
    viewer: { toggle: () => roomButton(paneId, "[data-one-output-toggle]")?.click(), enabled: true, open: false },
  };
}

const PaneView = memo(function PaneView({ pane, index, across, canOpenNew, focused, info, running, pinned, dragging, locale, actions: registered, setActions, cover, onStarted, onClose, onMenu, onRetry }: {
  cover: { projectId: string | null | "current"; nonce: number } | null; onStarted: (chatId: string, kind: "room" | "work") => void;
  pane: SpacePane; index: number; across: boolean; canOpenNew: boolean; focused: boolean; actions: PaneActions | undefined; setActions: (paneId: string, actions: PaneActions | null) => void;
  info: ReadonlyMap<string, ChatInfo>; running: ReadonlySet<string>; pinned: ReadonlySet<string>; dragging: boolean; locale: SpaceLocale;
  onClose: (chatId: string) => void; onMenu: (paneId: string, kind: "title" | "more", x: number, y: number, anchor: HTMLElement) => void; onRetry: (id: string) => void;
}) {
  const copy = spaceCopy(locale);
  const [zone, setZone] = useState<"replace" | "new" | null>(null);
  const active = pane.tabs.find((tab) => tab.chatId === pane.active) ?? pane.tabs[0];
  const entry = info.get(active.chatId);
  const ok = entry?.state === "ok" ? entry : null;
  const title = ok?.title ?? copy.newChat;
  const sub = ok && ok.kind === "room" ? (ok.group ? copy.members(ok.members) : copy.oneToOne) : null;
  const resolved = resolvePaneActions(pane.id, entry, registered);
  const chatIdNow = active.chatId;
  const paneContext = useMemo<WorkspacePane>(() => ({ paneId: pane.id, chatId: chatIdNow, setActions: (actions) => setActions(pane.id, actions) }), [pane.id, chatIdNow, setActions]);
  const open = (kind: "title" | "more") => (event: React.MouseEvent<HTMLButtonElement>) => { const box = event.currentTarget.getBoundingClientRect(); onMenu(pane.id, kind, box.left, box.bottom, event.currentTarget); };
  return (
    <section className={styles.pane} style={across ? { gridColumn: "1 / -1" } : undefined} data-space-pane={pane.id} data-focused={focused ? "true" : undefined}
      aria-label={copy.paneLabel(index + 1)}
      onPointerDownCapture={() => { if (!focused) updateSpaceLayout((source) => setFocus(source, pane.id)); }}
      onFocusCapture={() => { if (!focused) updateSpaceLayout((source) => setFocus(source, pane.id)); }}>
      <header className={styles.paneHead} data-space-pane-head={pane.id}>
        <span className={styles.paneKind} aria-hidden="true">{running.has(active.chatId) ? <span className={styles.running} role="img" aria-label={copy.running} /> : <KindIcon kind={active.kind} group={ok?.group ?? false} names={ok?.names ?? []} />}</span>
        <button type="button" className={styles.paneTitle} aria-haspopup="menu" title={title} data-space-pane-title={pane.id} onClick={open("title")}>
          <span className={styles.paneTitleText}>{title}</span>
          {pinned.has(active.chatId) ? <span className={styles.pinMark} aria-label={copy.pinned}><PinIcon size={11} /></span> : null}
          <IconChevronDown size={14} />
        </button>
        {sub && ok?.group ? (
          // The members of a group: the old head's "Manage Taskforce members" button is pressed (it is not drawn in a pane).
          <button type="button" className={`${styles.paneSub} ${styles.paneSubButton}`} data-space-pane-sub={pane.id} title={copy.manageMembers}
            onClick={() => document.querySelector<HTMLElement>(`[data-space-body="${pane.id}"] [data-one-taskforce-badge]`)?.closest("button")?.click()}>{sub}</button>
        ) : sub ? <span className={styles.paneSub} data-space-pane-sub={pane.id}>{sub}</span> : null}
        <span className={styles.paneSpacer} />
        {resolved.viewer ? (
          <button type="button" className={styles.paneIcon} aria-label={copy.panel} title={copy.panel} aria-pressed={resolved.viewer.open} disabled={!resolved.viewer.enabled} data-space-pane-panel={pane.id} data-active={resolved.viewer.open ? "true" : undefined}
            onClick={() => resolved.viewer?.toggle()}><IconPanelRight size={15} /></button>
        ) : null}
        <button type="button" className={styles.paneIcon} aria-label={copy.paneMenu} aria-haspopup="menu" data-space-pane-menu={pane.id} onClick={open("more")}><IconMoreHorizontal size={15} /></button>
        <button type="button" className={styles.paneIcon} aria-label={`${copy.closePane}: ${title}`} data-space-pane-close={pane.id} onClick={() => onClose(active.chatId)}><IconClose size={15} /></button>
      </header>
      <div className={styles.body} data-space-chat={active.chatId} data-space-body={pane.id}>
        {/* One conversation that fails to draw must not blank the other panes (or the app). */}
        <ErrorBoundary resetKey={active.chatId}>
          <WorkspacePaneProvider value={paneContext}>
            <PaneBody key={active.chatId} tab={active} paneId={pane.id} entry={entry} focused={focused} locale={locale} onRetry={onRetry} onClose={onClose} />
          </WorkspacePaneProvider>
        </ErrorBoundary>
        {cover ? (
          // The Space is full: the start screen covers this (focused) pane; the pane stays mounted underneath.
          <div className={styles.cover} data-space-cover="true">
            <DraftHead locale={locale} onClose={closeNewChatStart} cover />
            <NewChatStart key={cover.nonce} projectId={cover.projectId === "current" ? null : cover.projectId} onStarted={onStarted} />
          </div>
        ) : null}
        {dragging ? (
          <div className={styles.dropLayer} data-space-drop-layer={pane.id}
            onDragOver={(event) => {
              if (!hasChatDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const box = event.currentTarget.getBoundingClientRect();
              setZone(canOpenNew && event.clientX > box.left + box.width * 0.7 ? "new" : "replace");
            }}
            onDragLeave={() => setZone(null)}
            onDrop={(event) => {
              const drag = readChatDrag(event);
              const where = zone;
              setZone(null);
              if (!drag) return;
              event.preventDefault();
              event.stopPropagation();
              placeInSpace(drag, where === "new" ? { type: "new-pane" } : { type: "replace", paneId: pane.id });
            }}>
            <div className={`${styles.dropZone} ${styles.dropTabs}`} data-on={zone === "replace"} data-space-drop-zone="replace">{copy.dropHere}</div>
            {canOpenNew ? <div className={`${styles.dropZone} ${styles.dropSplit}`} data-on={zone === "new"} data-space-drop-zone="new">{copy.dropNew}</div> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
});

/** The line between the columns: drag it, or use ←/→ (Shift = bigger steps). The layout moves live and is written once at the end. */
function Border({ share, short, rowRef, locale }: { share: number; short: boolean; rowRef: React.RefObject<HTMLDivElement | null>; locale: SpaceLocale }) {
  const copy = spaceCopy(locale);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const width = rowRef.current?.clientWidth || 1;
    const startX = event.clientX, startShare = share;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (moveEvent: PointerEvent) => { updateSpaceLayout((source) => setColumnSplit(source, startShare + (moveEvent.clientX - startX) / width), { persist: false }); };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(false);
      persistSpaceLayout();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  return (
    <div className={styles.border} role="separator" aria-orientation="vertical" tabIndex={0} aria-label={copy.resize} style={{ left: `${share * 100}%`, height: short ? "50%" : "100%" }}
      aria-valuenow={Math.round(share * SPACE_WEIGHT_TOTAL)} aria-valuemin={SPACE_MIN_WEIGHT} aria-valuemax={SPACE_WEIGHT_TOTAL - SPACE_MIN_WEIGHT} data-space-border="0" data-dragging={dragging ? "true" : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = (event.shiftKey ? 100 : 20) * (event.key === "ArrowRight" ? 1 : -1);
        updateSpaceLayout((source) => resizeColumns(source, step));
      }}>
      <span className={styles.grip} aria-hidden="true"><svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="3" r="1" /><circle cx="6" cy="3" r="1" /><circle cx="2" cy="7" r="1" /><circle cx="6" cy="7" r="1" /><circle cx="2" cy="11" r="1" /><circle cx="6" cy="11" r="1" /></svg></span>
    </div>
  );
}
