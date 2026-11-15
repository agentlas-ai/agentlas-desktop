"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useRunningChats } from "@/lib/running-chats";
import { navigate } from "@/lib/navigation";
import { openProjectSettings } from "@/lib/project-settings";
import { useAppUiPreference } from "@/lib/app-ui-preferences";
import { useChatAttention } from "@/lib/attention";
import { taskTitleForDisplay } from "@/lib/task-title";
import { invalidateViewDataForStoreChange, loadViewData, readViewData } from "@/lib/view-data-cache";
import {
  activeChatIdOf, classifyStoreChange, COLLAPSE_BY_DEFAULT_ABOVE, groupHomeRows, homeBridge, homeRowHref, patchHomeRows, recallHomeSnapshot,
  rememberHomeSnapshot, retryDelayMs, reuseRows, rowDisplayName, type HomeTreeParticipant, type HomeTreeRow,
} from "@/lib/home-tree";
import type { Project } from "@/lib/types";
import { requestHomeLines, lineFingerprint, useHomeLine } from "@/lib/home-lines";
import { agentChatFaces, agentChatItem, memberChildren, menuTreeRows, type MenuTreeRow } from "@/lib/home-tree-adapter";
import { confirmPopup, alertPopup } from "@/lib/popup";
import { listCopy, listFailureText } from "@/lib/workspace-list-copy";
import { requestNewChat } from "@/lib/new-chat-request";
import type { OneOrgMember } from "@shared/one-org";
import { AttentionDot } from "./AttentionDot";
import { RenameChatDialog } from "./RenameChatDialog";
import { ConversationListButton, briefingSourceName } from "./one/ConversationListButton";
import { OneSessionTree } from "./one/OneSessionTree";
import { IconArrowUp, IconChevronDown, IconChevronRight, IconEdit, IconFolder, IconInbox, IconPanelRight, IconPlus, IconSettings, IconTrash } from "./Icon";
import { PinIcon } from "./space/PinIcon";
import { SpaceMenu, type SpaceMenuItem } from "./space/SpaceMenu";
import { CHAT_DRAG_MIME, spaceCopy, type ChatDragPayload } from "./space/copy";
import { openChatInSpace, updateSpaceLayout, useFocusedSpaceChatId, useHomeOrder, useHomePinned, useOpenChatKey } from "@/lib/space-store";
import { groupKeyOf, moveBefore, moveToTop, pruneListState, sortRowsForGroup, togglePin } from "@shared/space-layout";
import styles from "./HomeTree.module.css";

/*
 * Home's left tree (Agentlas 2.0 F-D3): projects → Agent Chats / Work Sessions, then No Project (workspace-v3-two). A project row
 * is folder + name, "+" (a new chat in that project), settings, fold. AGENT CHATS rows are the One Session list's own rows
 * (ConversationListButton + OneSessionTree - overlapped faces, members behind the arrow) but name only: no date, no preview; a Work
 * session is a dot and its title, no runner name. The right-click menu is Open / Open in a new pane / Move to top / Pin / Rename / Delete.
 * It READS rows that already exist (Main's home:* channels); the only thing it can make is the one-to-one a clicked member opens
 * (home:openMember), in the room's own project. A row opens as a tab in Space.
 *
 * Cost: one full read on mount; after that a store change that names an id re-reads only that id's row (home:rowsByIds),
 * coalesced for 120 ms and one request at a time. Changes without an id, and project / org changes, fold into one full read
 * at most every 2 s.
 */
const GROUP_PAGE = 12;
/** A read that has not answered by now is a failed read: one that never answers must not hold every later read behind it (F-D3). */
const READ_TIMEOUT_MS = 20_000;
const PATCH_DELAY_MS = 120;
const FULL_MIN_GAP_MS = 2_000;
const NONE_KEY = "__none__";

type Locale = "ko" | "en";

function withTimeout<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("home_read_timeout")), READ_TIMEOUT_MS); });
  return Promise.race([read, limit]).finally(() => clearTimeout(timer));
}

interface HomeRowsState {
  rows: readonly HomeTreeRow[]; truncated: boolean; failed: boolean; ready: boolean; projects: Project[];
  /** A failed read has another try coming by itself (2, 4, 8 s); false = it gave up and waits for the person or the next change. */
  retrying: boolean;
  /** This window has no `home` bridge at all (an old preload): asking again cannot help. */
  bridgeMissing: boolean;
  /** Read the tree again now (the Try again button, and after a click that found the list out of date). */
  reload: () => void;
}

function useHomeRows(): HomeRowsState {
  // The last read of this window paints at once when the tree comes back (Home → Dashboard → Home); a fresh read replaces it.
  const remembered = recallHomeSnapshot();
  const [rows, setRows] = useState<readonly HomeTreeRow[]>(remembered?.rows ?? []);
  const [truncated, setTruncated] = useState(remembered?.truncated ?? false);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const reloadRef = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(Boolean(remembered));
  const [projects, setProjects] = useState<Project[]>(() => readViewData<Project[]>("dashboard.projects")?.value ?? []);

  useEffect(() => {
    const api = ipc();
    const bridge = homeBridge();
    if (!api || !bridge) { setFailed(true); setReady(true); setBridgeMissing(true); return; }
    let cancelled = false;
    let fullInFlight = false;
    let fullAgain = false;
    let lastFullAt = 0;
    let fullTimer: ReturnType<typeof setTimeout> | null = null;
    let patchTimer: ReturnType<typeof setTimeout> | null = null;
    let patchInFlight = false;
    const pendingIds = new Set<string>();
    let generation = 0;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const readProjects = async (force: boolean) => {
      try {
        const list = await loadViewData("dashboard.projects", () => api.projects.list(), { maxAgeMs: 10_000, force });
        if (!cancelled) setProjects(list);
      } catch { if (!cancelled) setFailed(true); }
    };

    const runFull = async (force: boolean) => {
      if (fullInFlight) { fullAgain = true; return; }
      fullInFlight = true; fullAgain = false; lastFullAt = Date.now();
      const ticket = ++generation;
      try {
        await readProjects(force);
        const snapshot = await withTimeout(bridge.tree());
        if (cancelled || ticket !== generation) return;
        failures = 0;
        setRows((previous) => {
          const merged = reuseRows(previous, snapshot.rows);
          rememberHomeSnapshot({ rows: merged, truncated: snapshot.truncated });
          return merged;
        });
        setTruncated(snapshot.truncated);
        if (!cancelled) { setFailed(false); setRetrying(false); setReady(true); }
      } catch {
        if (!cancelled && ticket === generation) {
          // The rows already on screen stay; a failed read asks again after 2, 4, 8 s, then waits for the next change or visit.
          setFailed(true); setReady(true);
          failures += 1;
          const wait = retryDelayMs(failures);
          setRetrying(wait !== null);
          if (wait !== null && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; void runFull(true); }, wait);
        }
      } finally {
        fullInFlight = false;
        if (!cancelled && fullAgain) scheduleFull();
        else if (!cancelled && pendingIds.size) schedulePatch();
      }
    };

    const scheduleFull = () => {
      if (fullTimer || cancelled) return;
      const wait = Math.max(0, lastFullAt + FULL_MIN_GAP_MS - Date.now());
      fullTimer = setTimeout(() => { fullTimer = null; void runFull(true); }, wait);
    };

    const runPatch = async () => {
      // A patch must not overlap a full read: the full snapshot is the newer truth for every row it covers.
      if (!bridge || patchInFlight || fullInFlight || !pendingIds.size) return;
      const ids = [...pendingIds].slice(0, 200);
      for (const id of ids) pendingIds.delete(id);
      patchInFlight = true;
      const ticket = generation;
      try {
        const result = await withTimeout(bridge.rowsByIds(ids));
        if (!cancelled && ticket === generation) setRows((previous) => {
          const next = patchHomeRows(previous, result) as readonly HomeTreeRow[];
          if (next !== previous) rememberHomeSnapshot({ rows: next, truncated: recallHomeSnapshot()?.truncated ?? false });
          return next;
        });
      } catch { if (!cancelled) scheduleFull(); }
      finally {
        patchInFlight = false;
        if (!cancelled && pendingIds.size) schedulePatch();
      }
    };

    const schedulePatch = () => {
      if (patchTimer || cancelled) return;
      patchTimer = setTimeout(() => { patchTimer = null; void runPatch(); }, PATCH_DELAY_MS);
    };

    const onStoreChanged = (change: { entity: string; id?: string }) => {
      const how = classifyStoreChange(change);
      if (how === "ignore") return;
      if (change.entity === "project" || change.entity === "chat" || change.entity === "task") invalidateViewDataForStoreChange(change);
      if (how === "patch" && bridge && change.id) { pendingIds.add(change.id); schedulePatch(); return; }
      scheduleFull();
    };
    const off = ipcEvents()?.onStoreChanged?.(onStoreChanged);
    const onProjectsChanged = () => onStoreChanged({ entity: "project" });
    window.addEventListener("agentlas:projects-changed", onProjectsChanged);
    window.addEventListener("agentlas:tasks-changed", onProjectsChanged);
    reloadRef.current = () => { failures = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } void runFull(true); };
    void runFull(false);
    return () => {
      cancelled = true;
      if (fullTimer) clearTimeout(fullTimer);
      if (patchTimer) clearTimeout(patchTimer);
      if (retryTimer) clearTimeout(retryTimer);
      off?.();
      window.removeEventListener("agentlas:projects-changed", onProjectsChanged);
      window.removeEventListener("agentlas:tasks-changed", onProjectsChanged);
    };
  }, []);

  const reload = useCallback(() => reloadRef.current(), []);
  return { rows, truncated, failed, ready, projects, retrying, bridgeMissing, reload };
}

interface RowHandlers {
  onOpen: (row: HomeTreeRow) => void;
  onMenu: (row: HomeTreeRow, x: number, y: number, anchor: HTMLElement) => void;
  onDragStart: (row: HomeTreeRow, event: React.DragEvent) => void;
  onDragOver: (row: HomeTreeRow, event: React.DragEvent) => void;
  onDrop: (row: HomeTreeRow, event: React.DragEvent) => void;
}

const Row = memo(function Row({ row, running, locale, active, pinned, open, dropMark, handlers }: {
  row: HomeTreeRow; running: boolean; active?: boolean; locale: Locale; pinned?: boolean; open?: boolean;
  dropMark?: "before" | "after" | null; handlers: RowHandlers;
}) {
  const counts = useChatAttention(row.id);
  const ko = locale === "ko";
  const copy = spaceCopy(locale);
  const fallback = rowDisplayName(row, listCopy(locale).newChat);
  const raw = row.kind === "work" ? taskTitleForDisplay(row.title, ko) : row.title;
  // A Work session is its title and nothing in front of it: no runner name (workspace-v3-two).
  const title = !raw || raw === "New chat" ? fallback : raw;
  return (
    <button type="button" className={`project-sidebar-task ${styles.row}`} data-chat-id={row.id} data-row-kind={row.kind} data-active={active ? "true" : undefined} data-open={open ? "true" : undefined}
      data-pinned={pinned ? "true" : undefined} data-running={running ? "true" : undefined} data-drop={dropMark ?? undefined} draggable
      aria-current={active ? "page" : undefined}
      onClick={() => handlers.onOpen(row)} title={title}
      onContextMenu={(event) => { event.preventDefault(); handlers.onMenu(row, event.clientX, event.clientY, event.currentTarget); }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          handlers.onMenu(row, box.left + 24, box.bottom, event.currentTarget);
        }
      }}
      onDragStart={(event) => handlers.onDragStart(row, event)} onDragOver={(event) => handlers.onDragOver(row, event)} onDrop={(event) => handlers.onDrop(row, event)}>
      <span>{title}</span>
      {running ? <span role="img" aria-label={listCopy(locale).running} className={styles.running} /> : null}
      {pinned ? <span role="img" aria-label={copy.pinned} className={styles.pin}><PinIcon size={11} /></span> : null}
      <AttentionDot counts={counts} locale={locale} className="project-sidebar-task-dot" />
    </button>
  );
});

interface ListContext {
  locale: Locale; activeId: string | null; running: ReadonlySet<string>; pinned: ReadonlySet<string>; openInSpace: ReadonlySet<string>;
  dropMark: { id: string; side: "before" | "after" } | null; handlers: RowHandlers;
  org: ReadonlyMap<string, OneOrgMember> | null;
  members: ReadonlyMap<string, HomeTreeParticipant[] | "loading" | "failed">;
  onRoomOpenChange: (roomChatId: string, open: boolean) => void;
  onOpenMember: (agentId: string, roomChatId: string) => void;
  onRemove: (chatId: string) => Promise<void>;
}

/** One AGENT CHATS row: the One Session list's row, name only, plus what the menu adds (drag, right-click menu, pin mark). */
const MenuChatRow = memo(function MenuChatRow({ treeRow, active, pinned, open, running, dropMark, ctx }: {
  treeRow: MenuTreeRow; active: boolean; pinned: boolean; open: boolean; running: boolean; dropMark: "before" | "after" | null; ctx: ListContext;
}) {
  const { row } = treeRow;
  const { locale, handlers, org } = ctx;
  const ko = locale === "ko";
  const line = useHomeLine(row.id);
  const item = agentChatItem(row, line, listCopy(locale).newChat);
  const faces = agentChatFaces(row, line, org);
  return (
    <ConversationListButton item={item} active={active} locale={locale} onOpen={() => handlers.onOpen(row)} onRemove={ctx.onRemove}
      running={running} member={faces.member} groupMembers={faces.groupMembers} showOne={false} plain hideDelete
      trailing={pinned ? <span role="img" aria-label={spaceCopy(locale).pinned} className={styles.pin}><PinIcon size={11} /></span> : undefined}
      buttonProps={{
        draggable: true,
        "data-chat-id": row.id, "data-row-kind": row.kind,
        "data-open": open ? "true" : undefined, "data-pinned": pinned ? "true" : undefined, "data-running": running ? "true" : undefined, "data-drop": dropMark ?? undefined,
        onDragStart: (event) => handlers.onDragStart(row, event), onDragOver: (event) => handlers.onDragOver(row, event), onDrop: (event) => handlers.onDrop(row, event),
        onContextMenu: (event) => { event.preventDefault(); handlers.onMenu(row, event.clientX, event.clientY, event.currentTarget); },
        onKeyDown: (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            handlers.onMenu(row, box.left + 24, box.bottom, event.currentTarget);
          }
        },
      }} />
  );
});

function GroupList({ label, rows, kind, ctx }: { label: string; rows: HomeTreeRow[]; kind: "agent" | "work"; ctx: ListContext }) {
  const { locale } = ctx;
  const copy = listCopy(locale);
  const [shown, setShown] = useState(GROUP_PAGE);
  const visible = rows.slice(0, shown);
  // The preview-less faces of the agent rows in view are read once per row state (lib/home-lines). A Work row draws nothing from a line any more
  // (no runner name), so a Work group asks for none.
  const visibleKey = kind === "agent" ? visible.map((row) => `${row.id}|${lineFingerprint(row)}`).join(";") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (kind === "agent") requestHomeLines(visible); }, [visibleKey]);
  const treeRows = menuTreeRows(visible);
  if (!rows.length) return null;
  const childrenFor = (roomChatId: string) => {
    const list = ctx.members.get(roomChatId);
    return list === undefined || list === "loading" ? "loading" as const : list === "failed" ? list : memberChildren(roomChatId, list, ctx.org, ctx.running.has(roomChatId), locale);
  };
  return (
    <div role="group" aria-label={label}>
      <div className={`project-sidebar-label ${styles.subLabel}`}><span>{label}</span></div>
      {kind === "agent" ? (
        <div className={styles.agentRows} data-sidebar-rows="one">
          <OneSessionTree rows={treeRows} taskforces={NO_TASKFORCES} runningChatIds={ctx.running} activeChatId={ctx.activeId} activeMemberAgentId={null} locale={locale}
            onOpenMember={ctx.onOpenMember} childrenFor={childrenFor} onRoomOpenChange={ctx.onRoomOpenChange}
            renderRow={(treeRow) => <MenuChatRow key={treeRow.key} treeRow={treeRow as MenuTreeRow} ctx={ctx} active={treeRow.row.id === ctx.activeId} pinned={ctx.pinned.has(treeRow.row.id)}
              open={ctx.openInSpace.has(treeRow.row.id)} running={ctx.running.has(treeRow.row.id)} dropMark={ctx.dropMark?.id === treeRow.row.id ? ctx.dropMark.side : null} />} />
        </div>
      ) : visible.map((row) => (
        <Row key={row.id} row={row} running={ctx.running.has(row.id)} locale={locale} active={row.id === ctx.activeId} pinned={ctx.pinned.has(row.id)} open={ctx.openInSpace.has(row.id)}
          dropMark={ctx.dropMark?.id === row.id ? ctx.dropMark.side : null} handlers={ctx.handlers} />
      ))}
      {rows.length > shown ? (
        <button type="button" className={styles.more} onClick={() => setShown((count) => count + 50)}>{copy.more(rows.length - shown)}</button>
      ) : null}
    </div>
  );
}

const NO_TASKFORCES: readonly { chatId: string; memberAgentIds: string[] }[] = [];

export function HomeTree({ locale }: { locale: Locale }) {
  const ko = locale === "ko";
  const copy = listCopy(locale);
  const params = useSearchParams();
  const pathname = usePathname() ?? "";
  const currentProject = params.get("projectId") ?? params.get("id");
  const { rows, truncated, failed, ready, projects, retrying, bridgeMissing, reload } = useHomeRows();
  const running = useRunningChats();
  const [collapsed, setCollapsed] = useAppUiPreference("projectCollapsed");
  // Rooms that are open right now (OneSessionTree tells us), the members read for them, and the organisation that gives the member dots.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const [participants, setParticipants] = useState<ReadonlyMap<string, HomeTreeParticipant[] | "loading" | "failed">>(() => new Map());
  const [org, setOrg] = useState<ReadonlyMap<string, OneOrgMember> | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const loadedFor = useRef(new Map<string, string>());
  const spaceFocus = useFocusedSpaceChatId();
  // On Home the row that shows is the focused pane's chat; elsewhere the address says it.
  const activeId = pathname.replace(/\/+$/, "") === "/workspace" ? spaceFocus : activeChatIdOf(pathname, params);
  const pinned = useHomePinned();
  const order = useHomeOrder();
  const openKey = useOpenChatKey();
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const openSet = useMemo(() => new Set(openKey ? openKey.split(",") : []), [openKey]);
  const [menu, setMenu] = useState<{ x: number; y: number; row: HomeTreeRow; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<{ chatId: string; current: string } | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const dragRef = useRef<ChatDragPayload | null>(null);
  const groupIdsRef = useRef(new Map<string, string[]>());

  const groups = useMemo(() => groupHomeRows(rows, projects.map((project) => project.id)), [rows, projects]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const spaceRef = (row: HomeTreeRow) => ({ chatId: row.id, kind: (row.kind === "work" ? "work" : "room") as "work" | "room" });
  // A row opens in Space (a tab in the focused pane; one already open is only brought forward) - never a second copy.
  const onOpen = useCallback((row: HomeTreeRow) => { openChatInSpace(spaceRef(row), "replace-pane"); }, []);
  const rowGroupKey = (row: HomeTreeRow) => groupKeyOf(projects.some((project) => project.id === row.projectId) ? row.projectId : null, row.kind);
  const handlers = useMemo<RowHandlers>(() => ({
    onOpen,
    onMenu: (row, x, y, anchor) => setMenu({ x, y, row, anchor }),
    onDragStart: (row, event) => {
      const payload: ChatDragPayload = { ...spaceRef(row), groupKey: rowGroupKey(row) };
      dragRef.current = payload;
      event.dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify(payload));
      event.dataTransfer.effectAllowed = "copyMove";
    },
    onDragOver: (row, event) => {
      const drag = dragRef.current;
      // Only a row of the SAME list can be reordered by dropping on a row; everything else lands in Space.
      if (!drag || drag.fromTab || drag.chatId === row.id || drag.groupKey !== rowGroupKey(row)) { setDropMark((mark) => (mark ? null : mark)); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const side = event.clientY < box.top + box.height / 2 ? "before" : "after";
      setDropMark((mark) => (mark?.id === row.id && mark.side === side ? mark : { id: row.id, side }));
    },
    onDrop: (row, event) => {
      const drag = dragRef.current;
      const mark = dropMark;
      dragRef.current = null; setDropMark(null);
      if (!drag || drag.fromTab || drag.chatId === row.id || drag.groupKey !== rowGroupKey(row)) return;
      event.preventDefault();
      const key = rowGroupKey(row);
      const ids = groupIdsRef.current.get(key) ?? [];
      const at = ids.indexOf(row.id);
      const before = mark?.side === "after" ? (ids[at + 1] ?? null) : row.id;
      updateSpaceLayout((layout) => moveBefore(layout, key, drag.chatId, before, ids));
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [onOpen, projects, dropMark]);
  useEffect(() => {
    const end = () => { dragRef.current = null; setDropMark(null); };
    document.addEventListener("dragend", end);
    return () => document.removeEventListener("dragend", end);
  }, []);

  // Pins and moved-to-front ids of chats that are certainly gone leave the stored layout: when the whole list is loaded, an id
  // absent from it is gone; when it is cut short, only a chat the store itself says does not exist is removed.
  useEffect(() => {
    if (!ready || failed || (pinned.length === 0 && Object.keys(order).length === 0)) return;
    const known = new Set(rows.map((row) => row.id));
    const stale = new Set<string>([...pinned, ...Object.values(order).flat()].filter((id) => !known.has(id)));
    if (stale.size === 0) return;
    if (!truncated) { updateSpaceLayout((layout) => pruneListState(layout, stale)); return; }
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void Promise.all([...stale].slice(0, 40).map((id) => api.chats.get(id).then((chat) => (chat ? null : id)).catch(() => null))).then((gone) => {
      const dead = new Set(gone.filter((id): id is string => id !== null));
      if (!cancelled && dead.size) updateSpaceLayout((layout) => pruneListState(layout, dead));
    });
    return () => { cancelled = true; };
  }, [rows, ready, failed, truncated, pinned, order]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const loadParticipants = useCallback((row: HomeTreeRow) => {
    const bridge = homeBridge();
    const stamp = `${row.updatedAt}:${row.memberCount}`;
    if (!bridge || loadedFor.current.get(row.id) === stamp) return;
    loadedFor.current.set(row.id, stamp);
    setParticipants((previous) => new Map(previous).set(row.id, "loading"));
    bridge.participants(row.id)
      .then((list) => setParticipants((previous) => new Map(previous).set(row.id, list)))
      .catch(() => { loadedFor.current.delete(row.id); setParticipants((previous) => new Map(previous).set(row.id, "failed")); });
  }, []);
  // A room that opens reads its members; one that closes forgets them (and its stamp), so a closed room costs nothing.
  const rowByIdRef = useRef(rowById);
  rowByIdRef.current = rowById;
  const onRoomOpenChange = useCallback((roomChatId: string, open: boolean) => {
    setOpenRows((previous) => {
      if (previous.has(roomChatId) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(roomChatId); else next.delete(roomChatId);
      return next;
    });
    if (open) { const row = rowByIdRef.current.get(roomChatId); if (row) loadParticipants(row); return; }
    loadedFor.current.delete(roomChatId);
    setParticipants((previous) => { if (!previous.has(roomChatId)) return previous; const next = new Map(previous); next.delete(roomChatId); return next; });
  }, [loadParticipants]);
  // An open room whose member list changed reads again.
  useEffect(() => {
    for (const roomChatId of openRows) { const row = rowById.get(roomChatId); if (row?.kind === "group") loadParticipants(row); }
  }, [rowById, openRows, loadParticipants]);
  // The organisation (member dots) is read when the first room opens, and again on its own store signal - never on a timer.
  const orgWanted = openRows.size > 0;
  useEffect(() => {
    if (!orgWanted) return;
    const api = ipc();
    if (!api?.oneOrg?.get) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => { api.oneOrg.get().then((state) => { if (!cancelled) setOrg(new Map(state.members.map((member) => [member.installedAgentId, member]))); }).catch(() => undefined); };
    read();
    const off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "one-org" && !timer) timer = setTimeout(() => { timer = null; read(); }, 500); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); off?.(); };
  }, [orgWanted]);
  // A member under an open room opens that member's one-to-one in the room's own project (Main finds it, or makes it).
  // A refusal says so and reads the list again: the member list on screen was out of date.
  const onOpenMember = useCallback((agentId: string, roomChatId: string) => {
    setMemberError(null);
    const bridge = homeBridge();
    if (!bridge?.openMember) { setMemberError(copy.cannotOpenHere); return; }
    bridge.openMember({ roomChatId, agentId })
      .then((made) => openChatInSpace({ chatId: made.chatId, kind: "room" }, "replace-pane"))
      .catch((cause) => {
        const said = listFailureText(cause, locale);
        setMemberError(`${said}${/[.!?。]$/.test(said) ? "" : "."} ${copy.memberOpenFailed}`);
        loadedFor.current.delete(roomChatId);
        reload();
      });
  }, [copy, locale, reload]);
  const onRemove = useCallback(async (chatId: string) => {
    const api = ipc();
    if (!api?.chats?.remove) return;
    if (running.has(chatId)) {
      await alertPopup(copy.stopFirst, { locale, tone: "warning" });
      return;
    }
    const row = rowByIdRef.current.get(chatId);
    const name = briefingSourceName(row?.title.trim() || copy.thisChat, locale);
    const body = row?.kind === "work" ? copy.deleteBodySession : copy.deleteBodyChat;
    if (!await confirmPopup(body, { locale, title: ko ? `"${name}" 대화를 삭제할까요?` : `Delete "${name}"?`, confirmLabel: copy.deleteConfirm, tone: "danger" })) return;
    try { await api.chats.remove(chatId); }
    catch (cause) { await alertPopup(listFailureText(cause, locale), { locale, tone: "warning" }); }
  }, [running, ko, locale, copy]);
  const listContext: ListContext = {
    locale, activeId, running, pinned: pinnedSet, openInSpace: openSet, dropMark, handlers, org, members: participants,
    onRoomOpenChange, onOpenMember, onRemove,
  };

  // Many projects start closed (§3.3); the project on screen and any the person opened or closed keep their state.
  const collapsedByDefault = (key: string) => projects.length > COLLAPSE_BY_DEFAULT_ABOVE && key !== currentProject && key !== NONE_KEY;
  const isCollapsedKey = (key: string) => (typeof collapsed?.[key] === "boolean" ? collapsed[key] : collapsedByDefault(key));
  const toggleCollapsed = (key: string) => setCollapsed((current) => ({ ...(current && typeof current === "object" ? current : {}), [key]: !isCollapsedKey(key) }));
  const section = (projectId: string | null, group: (typeof groups)[number]) => {
    const key = projectId ?? NONE_KEY;
    const project = projectId ? projectById.get(projectId) : null;
    const count = group.agentChats.length + group.workSessions.length;
    if (projectId === null && count === 0) return null;
    // Projects and "No project" fold; a folded one shows only its row.
    const isCollapsed = isCollapsedKey(key);
    const chatKey = groupKeyOf(projectId, "solo"), workKey = groupKeyOf(projectId, "work");
    const agentChats = sortRowsForGroup(group.agentChats, pinned, order[chatKey]);
    const workSessions = sortRowsForGroup(group.workSessions, pinned, order[workKey]);
    groupIdsRef.current.set(chatKey, agentChats.map((row) => row.id));
    groupIdsRef.current.set(workKey, workSessions.map((row) => row.id));
    const name = project?.name ?? copy.noProject;
    const fold = count > 0 ? (
      <button type="button" className="project-sidebar-collapse" onClick={() => toggleCollapsed(key)} aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? copy.expandFor(name) : copy.collapseFor(name)}>
        {isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}</button>
    ) : null;
    const lists = (
      <>
        <GroupList label={copy.agentChats} kind="agent" rows={agentChats} ctx={listContext} />
        <GroupList label={copy.workSessions} kind="work" rows={workSessions} ctx={listContext} />
      </>
    );
    if (projectId === null) {
      return (
        <div className="project-sidebar-project" key={key} data-home-project="none" data-unassigned-work="true">
          <div className="project-sidebar-project-row">
            <button type="button" className="project-sidebar-project-link" onClick={() => toggleCollapsed(key)} aria-expanded={!isCollapsed}>
              <IconInbox size={15} /><span>{name}</span>
            </button>
            {fold}
          </div>
          {!isCollapsed ? lists : null}
        </div>
      );
    }
    return (
      <div className="project-sidebar-project" key={key} data-home-project={projectId}>
        <div className="project-sidebar-project-row" data-folded={isCollapsed ? "true" : undefined}>
          <button type="button" className="project-sidebar-project-link" data-active={currentProject === projectId && pathname.startsWith("/project")}
            onClick={() => navigate(`/project/detail?id=${encodeURIComponent(projectId)}`)}>
            <IconFolder size={15} /><span>{name}</span>
          </button>
          <button type="button" className={`project-sidebar-collapse ${styles.rowPlus}`} data-home-new={name} onClick={() => requestNewChat({ projectId, projectName: name })}
            aria-label={copy.newChatIn(name)} title={copy.newChatTitle}><IconPlus size={14} /></button>
          <button type="button" className="project-sidebar-collapse" onClick={() => openProjectSettings({ mode: "edit", projectId })}
            aria-label={copy.projectSettingsFor(name)} title={copy.projectSettings}><IconSettings size={14} /></button>
          {fold}
        </div>
        {!isCollapsed ? lists : null}
      </div>
    );
  };

  const projectGroups = groups.filter((group) => group.projectId !== null);
  const noProject = groups.find((group) => group.projectId === null)!;
  // What the list says when it cannot show rows: loading (until the first answer), failed (with its way out), or nothing yet.
  const note = (() => {
    if (!ready && rows.length === 0) return <div className={styles.note} role="status" data-list-state="loading">{copy.loading}</div>;
    if (!failed) return null;
    if (bridgeMissing) return <div className={styles.note} role="alert" data-list-state="no-bridge">{copy.cannotOpenHere}</div>;
    return (
      <div className={styles.note} role="alert" data-list-state={retrying ? "retrying" : "failed"}>
        <span>{retrying ? copy.loadRetrying : copy.loadFailed}</span>
        {retrying ? null : <button type="button" className={styles.retry} data-list-retry="true" onClick={reload}>{copy.retry}</button>}
      </div>
    );
  })();
  return (
    <>
      {menu ? <SpaceMenu x={menu.x} y={menu.y} label={copy.rowMenu} returnFocus={menu.anchor} onClose={() => setMenu(null)}
        items={rowMenuItems(menu.row, locale, pinnedSet.has(menu.row.id), rowGroupKey(menu.row), spaceRef(menu.row), onOpen, {
          rename: () => setRenaming({ chatId: menu.row.id, current: menu.row.title.trim() === "New chat" ? "" : menu.row.title.trim() }),
          remove: () => { void onRemove(menu.row.id); },
        })} /> : null}
      {renaming ? <RenameChatDialog chatId={renaming.chatId} current={renaming.current} locale={locale} onClose={() => setRenaming(null)} /> : null}
      <div className={`project-sidebar-label ${styles.projectsLabel}`}>
        <span>{copy.projects}</span>
        <button type="button" className={styles.labelPlus} data-new-project="true" onClick={() => openProjectSettings()} aria-label={copy.newProjectAria} title={copy.newProject}><IconPlus size={13} /></button>
      </div>
      <nav className={`project-sidebar-list ${styles.list}`} aria-label={copy.projects} data-home-tree="true">
        {projectGroups.map((group) => section(group.projectId, group))}
        {section(null, noProject)}
        {truncated ? <div className={styles.note}>{copy.truncated}</div> : null}
        {memberError ? <div className={styles.note} role="alert">{memberError}</div> : null}
        {note}
        {ready && !failed && projects.length === 0 && rows.length === 0
          ? <button type="button" className="project-sidebar-empty" onClick={() => openProjectSettings()}>{copy.emptyFirst}</button> : null}
      </nav>
    </>
  );
}

/** The menu form of the drags (Open / Open in a new pane / Move to top / Pin / Rename / Delete); the layout ones call the same functions a drop calls. */
function rowMenuItems(
  row: HomeTreeRow, locale: Locale, isPinned: boolean, groupKey: string, ref: { chatId: string; kind: "room" | "work" }, onOpen: (row: HomeTreeRow) => void,
  actions: { rename: () => void; remove: () => void },
): SpaceMenuItem[] {
  const copy = listCopy(locale);
  return [
    { id: "open", label: copy.open, icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M8 7h9v9" /></svg>, onSelect: () => onOpen(row) },
    { id: "open-pane", label: copy.openPane, icon: <IconPanelRight size={15} />, onSelect: () => openChatInSpace(ref, "new-pane") },
    { id: "move-top", label: copy.moveTop, icon: <IconArrowUp size={15} />, dividerBefore: true, onSelect: () => updateSpaceLayout((layout) => moveToTop(layout, groupKey, row.id)) },
    { id: "pin", label: isPinned ? copy.unpin : copy.pin, icon: <PinIcon size={15} />, onSelect: () => updateSpaceLayout((layout) => togglePin(layout, row.id)) },
    { id: "rename", label: copy.rename, icon: <IconEdit size={15} />, onSelect: actions.rename },
    { id: "delete", label: copy.delete, icon: <IconTrash size={15} />, dividerBefore: true, danger: true, onSelect: actions.remove },
  ];
}
