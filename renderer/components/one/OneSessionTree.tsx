"use client";

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconChevronDown, IconChevronRight } from "@/components/Icon";
import {
  buildOneSessionTree,
  type OneSessionChildStatus,
  type OneSessionTreeChild,
  type OneSessionTreeMember,
  type OneSessionTreeRow,
} from "@/lib/one-session-tree";
import type { OneTaskforce } from "@shared/one-taskforces";
import styles from "./OneSessionTree.module.css";

const STATUS_LABEL: Record<"ko" | "en", Partial<Record<OneSessionChildStatus, string>>> = {
  ko: { attention: "확인할 것 있음", running: "실행 중", failed: "실패", unavailable: "사용 불가" },
  en: { attention: "Needs attention", running: "Running", failed: "Failed", unavailable: "Unavailable" },
};
const NO_MEMBERS: readonly OneSessionTreeMember[] = [];
const NO_CHILDREN: readonly OneSessionTreeChild[] = [];

/** Rendered only while a room is open: tells the owner of the member list when to read it and when it can forget it. Draws nothing. */
function RoomOpenSignal({ roomChatId, onChange }: { roomChatId: string; onChange: (roomChatId: string, open: boolean) => void }) {
  useEffect(() => {
    onChange(roomChatId, true);
    return () => onChange(roomChatId, false);
  }, [roomChatId, onChange]);
  return null;
}

/**
 * Session list with group rooms as parent rows and their members as small child rows (owner 2026-10-16).
 * Rows keep their own renderer (renderRow); the tree only adds the nesting, the room toggle and the member rows.
 */
export function OneSessionTree<Row extends OneSessionTreeRow>({
  rows,
  taskforces,
  members,
  runningChatIds,
  activeChatId,
  activeMemberAgentId,
  locale,
  renderRow,
  onOpenMember,
  childrenFor,
  onRoomOpenChange,
}: {
  rows: readonly Row[];
  taskforces: readonly Pick<OneTaskforce, "chatId" | "memberAgentIds">[];
  /** The One organisation's members; absent while the organisation has not loaded. */
  members?: readonly OneSessionTreeMember[];
  runningChatIds: ReadonlySet<string>;
  activeChatId: string | null;
  /** The member whose seat thread is open now (null in a room or a One session). */
  activeMemberAgentId: string | null;
  locale: "ko" | "en";
  renderRow: (row: Row) => ReactNode;
  onOpenMember: (agentId: string, roomChatId: string) => void;
  /**
   * A list whose room rows do not carry their members (the Workspace menu) asks for them here, only for a room that is open.
   * Absent (the One Session list): the members come from `taskforces` / the chat's seat snapshot, exactly as before.
   */
  childrenFor?: (roomChatId: string) => readonly OneSessionTreeChild[] | "loading" | "failed";
  /** With `childrenFor`: called with true when a room opens and false when it closes or leaves the list. */
  onRoomOpenChange?: (roomChatId: string, open: boolean) => void;
}) {
  const nodes = useMemo(
    () => buildOneSessionTree(rows, { taskforces, members: members ?? NO_MEMBERS, runningChatIds, locale }),
    [rows, taskforces, members, runningChatIds, locale],
  );
  // Per-room choice for this window; a room nobody toggled starts open only while it is the open conversation.
  const [expandedByRoom, setExpandedByRoom] = useState<Record<string, boolean>>({});
  const isExpanded = (roomChatId: string) => expandedByRoom[roomChatId] ?? roomChatId === activeChatId;
  const setExpanded = (roomChatId: string, expanded: boolean) =>
    setExpandedByRoom((current) => (current[roomChatId] === expanded ? current : { ...current, [roomChatId]: expanded }));

  const onRoomKeyDown = (event: KeyboardEvent<HTMLDivElement>, roomChatId: string) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const expanded = isExpanded(roomChatId);
    if (event.key === "ArrowLeft") { setExpanded(roomChatId, false); return; }
    if (!expanded) { setExpanded(roomChatId, true); return; }
    const group = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("[data-one-tree-child]");
    group?.focus();
  };
  const onChildKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const item = event.currentTarget.closest("li");
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.currentTarget.closest("[data-one-tree-room]")?.querySelector<HTMLButtonElement>("[data-one-tree-row-body] button")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const sibling = event.key === "ArrowDown" ? item?.nextElementSibling : item?.previousElementSibling;
      const target = sibling?.querySelector<HTMLButtonElement>("[data-one-tree-child]");
      if (target) { event.preventDefault(); target.focus(); }
    }
  };

  return (
    <ul className={styles.tree} data-one-session-tree="rooms">
      {nodes.map((node) => {
        if (!node.roomChatId || (node.children.length === 0 && !childrenFor)) {
          return <li key={node.key} className={styles.item}>{renderRow(node.row)}</li>;
        }
        const roomChatId = node.roomChatId;
        const expanded = isExpanded(roomChatId);
        const groupId = `one-session-members-${roomChatId}`;
        const loaded = childrenFor ? (expanded ? childrenFor(roomChatId) : NO_CHILDREN) : node.children;
        const note = loaded === "loading" ? (locale === "ko" ? "불러오는 중…" : "Loading…")
          : loaded === "failed" ? (locale === "ko" ? "참여자를 불러오지 못했어요" : "Could not load members") : null;
        const memberRows = typeof loaded === "string" ? NO_CHILDREN : loaded;
        return (
          <li key={node.key} className={styles.item} data-one-tree-room="true" data-expanded={expanded ? "true" : "false"}>
            <div className={styles.roomRow} onKeyDown={(event) => onRoomKeyDown(event, roomChatId)}>
              <button
                type="button"
                className={styles.toggle}
                data-hover="own"
                aria-expanded={expanded}
                aria-controls={groupId}
                aria-label={locale === "ko" ? (expanded ? "참여 에이전트 접기" : "참여 에이전트 펼치기") : (expanded ? "Hide members" : "Show members")}
                onClick={() => setExpanded(roomChatId, !expanded)}
              >
                {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              </button>
              <div className={styles.roomRowBody} data-one-tree-row-body="true">{renderRow(node.row)}</div>
            </div>
            {childrenFor && onRoomOpenChange && expanded ? <RoomOpenSignal roomChatId={roomChatId} onChange={onRoomOpenChange} /> : null}
            <ul id={groupId} className={styles.children} hidden={!expanded}>
              {note ? <li className={styles.note} role="status">{note}</li> : null}
              {memberRows.map((child) => {
                const active = child.agentId === activeMemberAgentId;
                const statusLabel = STATUS_LABEL[locale][child.status];
                return (
                  <li key={child.key}>
                    <button
                      type="button"
                      className={styles.child}
                      data-one-tree-child="true"
                      data-status={child.status}
                      data-active={active ? "true" : "false"}
                      aria-current={active ? "page" : undefined}
                      title={child.name}
                      onClick={() => onOpenMember(child.agentId, roomChatId)}
                      onKeyDown={onChildKeyDown}
                    >
                      <span className={styles.childName}>{child.name}</span>
                      {statusLabel
                        ? <span className={styles.dot} data-status={child.status} role="img" aria-label={statusLabel} />
                        : <span className={styles.dot} data-status={child.status} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
