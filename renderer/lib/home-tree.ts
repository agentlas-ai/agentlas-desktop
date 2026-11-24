import type { HomeLine, HomeOpenMemberResult, HomeRowsByIdsResult, HomeTreeParticipant, HomeTreeRow, HomeTreeSnapshot } from "@shared/home-tree";

/**
 * Home's tree on the renderer side: the typed bridge, the pure functions that group and patch rows, and the
 * route each row opens. No React in this file, so the rules can be checked without a DOM.
 */
export type { HomeTreeRow, HomeTreeSnapshot, HomeTreeParticipant } from "@shared/home-tree";
import { homeRowAgentNames } from "@shared/home-tree";

export interface HomeBridge {
  tree: () => Promise<HomeTreeSnapshot>;
  rowsByIds: (ids: string[]) => Promise<HomeRowsByIdsResult>;
  participants: (chatId: string) => Promise<HomeTreeParticipant[]>;
  search: (text: string) => Promise<HomeTreeRow[]>;
  /** Optional: a window older than this build has neither (the pane then shows no waiting list and no Stop). */
  roomWaiting?: (chatId: string) => Promise<{ busy: boolean; held: Array<{ agentId: string; kind: "turn" | "retry"; retryAt?: number }> }>;
  stopRoom?: (chatId: string) => Promise<{ stopped: boolean }>;
  /** Optional: a window older than this build has neither (rows then draw from their titles; a member click opens nothing). */
  lines?: (ids: string[]) => Promise<HomeLine[]>;
  openMember?: (input: { roomChatId: string; agentId: string }) => Promise<HomeOpenMemberResult>;
}

/** The preload's `home` group, or null when this window has none (the tree then says it cannot load; it never reads older lists). */
export function homeBridge(): HomeBridge | null {
  if (typeof window === "undefined") return null;
  const home = (window.agentlas as unknown as { home?: Partial<HomeBridge> } | undefined)?.home;
  return home && typeof home.tree === "function" && typeof home.rowsByIds === "function" && typeof home.participants === "function" && typeof home.search === "function"
    ? (home as HomeBridge)
    : null;
}

/** The address that opens a row's tab in Space (the tree itself opens tabs directly; this is for links and notifications). */
export function homeRowHref(row: HomeTreeRow): string {
  return `/workspace?open=${encodeURIComponent(row.id)}`;
}

export interface HomeTreeGroup {
  /** `null` = No Project. */
  projectId: string | null;
  agentChats: HomeTreeRow[];
  workSessions: HomeTreeRow[];
}

const byNewest = (a: HomeTreeRow, b: HomeTreeRow): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1);

/**
 * Rows → one group per project (in the given project order) plus No Project last. A row whose project is not in the list
 * (deleted, not loaded yet) falls into No Project rather than disappearing. Newest first.
 */
export function groupHomeRows(rows: readonly HomeTreeRow[], projectIds: readonly string[]): HomeTreeGroup[] {
  const known = new Set(projectIds);
  const groups = new Map<string | null, HomeTreeGroup>();
  const ensure = (id: string | null) => {
    let group = groups.get(id);
    if (!group) groups.set(id, group = { projectId: id, agentChats: [], workSessions: [] });
    return group;
  };
  for (const id of projectIds) ensure(id);
  ensure(null);
  for (const row of rows) {
    const group = ensure(row.projectId && known.has(row.projectId) ? row.projectId : null);
    (row.kind === "work" ? group.workSessions : group.agentChats).push(row);
  }
  for (const group of groups.values()) { group.agentChats.sort(byNewest); group.workSessions.sort(byNewest); }
  return [...projectIds.map((id) => groups.get(id)!), groups.get(null)!];
}

/**
 * Applies a `home:rowsByIds` answer to the rows already on screen: rows it returned replace or join, and every chat it
 * resolved but did not return leaves the tree. Rows it did not ask about are the same objects, so unrelated React rows do
 * not re-render. Returns the SAME array when nothing changed.
 */
export function patchHomeRows(current: readonly HomeTreeRow[], result: HomeRowsByIdsResult): readonly HomeTreeRow[] {
  const returned = new Map(result.rows.map((row) => [row.id, row]));
  const resolved = new Set(result.chatIds);
  let changed = false;
  const next: HomeTreeRow[] = [];
  const seen = new Set<string>();
  for (const row of current) {
    if (!resolved.has(row.id)) { next.push(row); continue; }
    const fresh = returned.get(row.id);
    seen.add(row.id);
    if (!fresh) { changed = true; continue; }
    if (sameRow(row, fresh)) next.push(row);
    else { next.push(fresh); changed = true; }
  }
  for (const row of result.rows) if (!seen.has(row.id)) { next.push(row); changed = true; }
  return changed ? next : current;
}

export function sameRow(a: HomeTreeRow, b: HomeTreeRow): boolean {
  return a.id === b.id && a.kind === b.kind && a.projectId === b.projectId && a.title === b.title && a.taskId === b.taskId
    && a.memberCount === b.memberCount && a.updatedAt === b.updatedAt
    && a.agentNames.length === b.agentNames.length && a.agentNames.every((name, i) => name === b.agentNames[i])
    && (a.agentNamesEn?.join("\u0000") ?? "") === (b.agentNamesEn?.join("\u0000") ?? "");
}

/** A fresh full read keeps every row object that did not change, so memoised rows below do not repaint. */
export function reuseRows(previous: readonly HomeTreeRow[], next: readonly HomeTreeRow[]): readonly HomeTreeRow[] {
  const old = new Map(previous.map((row) => [row.id, row]));
  let identical = previous.length === next.length;
  const merged = next.map((row, index) => {
    const before = old.get(row.id);
    const kept = before && sameRow(before, row) ? before : row;
    if (kept !== previous[index]) identical = false;
    return kept;
  });
  return identical ? previous : merged;
}

/** Which store changes the tree can patch by id, and which need a full read. */
export function classifyStoreChange(change: { entity: string; id?: string }): "patch" | "full" | "ignore" {
  switch (change.entity) {
    case "chat": case "task": case "one-taskforce":
      return change.id ? "patch" : "full";
    case "project": case "one-org": case "agent": case "surface":
      return "full";
    default:
      return "ignore";
  }
}

/** The chat a screen address currently shows, so the tree can mark its row (`/one?chat=<id>` or `/workspace/task?id=<id>`; Space marks its own open tabs). */
export function activeChatIdOf(pathname: string, search: URLSearchParams): string | null {
  if (pathname.startsWith("/one")) return search.get("chat");
  if (pathname.startsWith("/workspace/task")) return search.get("id");
  return null;
}

/** A group room with no title is named by who is in it (up to three), so a three-person room does not read like a one-to-one. */
export function rowDisplayName(row: Pick<HomeTreeRow, "kind" | "agentNames" | "agentNamesEn">, fallback: string, locale: "ko" | "en" = "ko"): string {
  const names = homeRowAgentNames(row, locale).filter(Boolean);
  if (row.kind === "group" && names.length) return names.slice(0, 3).join(", ");
  return names[0] || fallback;
}

/** The last tree read, kept for the life of the window: going Home → Dashboard → Home paints the old rows at once instead of an empty tree. */
let lastSnapshot: { rows: readonly HomeTreeRow[]; truncated: boolean } | null = null;
export function rememberHomeSnapshot(snapshot: { rows: readonly HomeTreeRow[]; truncated: boolean }): void { lastSnapshot = snapshot; }
export function recallHomeSnapshot(): { rows: readonly HomeTreeRow[]; truncated: boolean } | null { return lastSnapshot; }

/** Seconds to wait before the next try after a failed first read: 2, 4, 8, then stop (the next store change or visit reads again). */
export function retryDelayMs(failures: number): number | null {
  return failures >= 1 && failures <= 3 ? 2_000 * 2 ** (failures - 1) : null;
}

/** Projects past this many start collapsed (§3.3), except the one on screen. */
export const COLLAPSE_BY_DEFAULT_ABOVE = 5;
