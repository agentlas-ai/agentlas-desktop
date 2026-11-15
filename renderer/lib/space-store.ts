"use client";

import { useSyncExternalStore } from "react";
import { clearPaneDrafts } from "@/lib/pane-drafts";
import { appUiPreferenceDefinitions, appUiPreferenceStorageKey, claimLegacyAppUiPreference, readAppUiPreference, setAppUiPreferenceScope, subscribeAppUiPreference, writeAppUiPreference } from "@/lib/app-ui-preferences";
import {
  emptyHomeLayout, openBlock, openInSpace, placeBlock, placeTab, sameLayout, SPACE_MAX_PANES,
  type HomeLayout, type MoveTarget, type OpenHow, type OpenRef, type RoomBlock, type SpaceLimits,
} from "@shared/space-layout";
import { navigate } from "@/lib/navigation";

/*
 * Space's layout in memory, with one debounced write to the `homeLayout` UI preference.
 *
 * Why a store and not component state: the left tree, the panes, a notification and the approval sheet all open or read
 * the same layout, and none of them is the parent of the others. Reads come from memory; the preference is read once, and
 * again only when someone ELSE wrote it (another window, app-control). Writes wait 300 ms so a burst (a resize drag, five
 * quick clicks) is one write, and are flushed when the window hides or closes so a quit never loses the last change.
 */
const WRITE_DELAY_MS = 300;
const SERVER_LAYOUT = emptyHomeLayout();

let current: HomeLayout | null = null;
let pending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let wired = false;
const listeners = new Set<() => void>();

function layout(): HomeLayout {
  if (current === null) { rememberedScope(); current = readAppUiPreference("homeLayout"); }
  return current;
}
const emit = () => { for (const listener of listeners) listener(); };

/** How many panes the window holds right now (Space measures its row and tells the store). */
let paneCapacityNow = SPACE_MAX_PANES;
export function setSpacePaneCapacity(count: number): void { paneCapacityNow = Math.max(1, Math.min(SPACE_MAX_PANES, Math.floor(count) || SPACE_MAX_PANES)); }
export const spacePaneCapacity = (): number => paneCapacityNow;
const limits = (): SpaceLimits => ({ maxPanes: paneCapacityNow });

/*
 * Which account's layout is on screen. The session arrives a moment after the window opens, so the scope of the LAST window is
 * remembered (a small plain key holding only the account's hash): the right layout is there from the first paint, and a link or
 * a click that comes before the session is known lands in it. When no scope is remembered (the first run after an update, a new
 * profile) the changes made before the session arrives are kept as functions and applied again to the account's layout on bind.
 */
const SCOPE_MEMORY_KEY = "agentlas.home.layout.scope.v1";
const SAFE_SCOPE_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
let accountScope: string | null = null;
let scopeRemembered = false;
let earlyChanges: Array<(layout: HomeLayout) => HomeLayout> = [];
function rememberedScope(): void {
  if (scopeRemembered || accountScope !== null || typeof window === "undefined") return;
  scopeRemembered = true;
  try {
    const value = window.localStorage.getItem(SCOPE_MEMORY_KEY);
    if (value && SAFE_SCOPE_VALUE.test(value)) { accountScope = value; setAppUiPreferenceScope("homeLayout", value); }
  } catch { /* an unreadable store: the plain key is used until the session arrives */ }
}

/** Layouts of accounts that signed in on this computer: at most 8 are kept (a stored layout is small, but a key per account must not grow for ever). */
const MAX_ACCOUNT_LAYOUTS = 8;
function pruneAccountLayouts(): void {
  try {
    const keep = appUiPreferenceStorageKey("homeLayout");
    const prefix = `${appUiPreferenceDefinitions.homeLayout.storageKey}.`;
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) { const key = window.localStorage.key(i); if (key && key.startsWith(prefix)) keys.push(key); }
    for (const key of keys.filter((item) => item !== keep).slice(0, Math.max(0, keys.length - MAX_ACCOUNT_LAYOUTS))) window.localStorage.removeItem(key);
  } catch { /* a store that cannot list keeps them all */ }
}

/** Binds the layout to the signed-in account (or "local" when signed out). Called once the session is known, and again when it changes. */
export function bindSpaceAccount(scope: string): void {
  rememberedScope();
  if (accountScope === scope) { try { window.localStorage.setItem(SCOPE_MEMORY_KEY, scope); } catch { /* memory only */ } earlyChanges = []; return; }
  wire();
  flushSpaceLayout(); // an unwritten change belongs to the account it was made under
  const replay = accountScope === null ? earlyChanges : [];
  earlyChanges = [];
  if (accountScope !== null) clearPaneDrafts(); // unsent words of the account that left are not shown to the next one
  accountScope = scope;
  try { window.localStorage.setItem(SCOPE_MEMORY_KEY, scope); } catch { /* memory only */ }
  setAppUiPreferenceScope("homeLayout", scope);
  claimLegacyAppUiPreference("homeLayout"); // the first account on this computer inherits the old shared value, once
  pruneAccountLayouts();
  current = readAppUiPreference("homeLayout");
  for (const change of replay) { try { current = change(current); } catch { /* a change that no longer fits is dropped */ } }
  pending = replay.length > 0;
  if (timer) { clearTimeout(timer); timer = null; }
  if (pending) timer = setTimeout(() => { timer = null; flushSpaceLayout(); }, WRITE_DELAY_MS);
  pendingNotice = null;
  emit(); emitNotice();
}

export function flushSpaceLayout(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending || current === null) return;
  pending = false;
  try { writeAppUiPreference("homeLayout", current); } catch { /* a full or blocked store keeps the layout for this session only */ }
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("pagehide", flushSpaceLayout);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSpaceLayout(); });
  subscribeAppUiPreference("homeLayout", (value) => {
    // Our own write comes back identical; only another writer's value replaces ours (and only when we hold nothing unwritten).
    if (pending || (current !== null && sameLayout(current, value))) return;
    current = value; emit();
  });
}

export function getSpaceLayout(): HomeLayout { wire(); return layout(); }

/** Applies a change to the layout; `persist:false` keeps it on screen only (a drag in progress) until the next persisted change. */
export function updateSpaceLayout(change: (layout: HomeLayout) => HomeLayout, options: { persist?: boolean } = {}): HomeLayout {
  wire();
  const before = layout();
  const after = change(before);
  if (after === before) return before;
  if (accountScope === null && earlyChanges.length < 32) earlyChanges.push(change);
  current = after;
  emit();
  if (options.persist !== false) {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flushSpaceLayout(); }, WRITE_DELAY_MS);
  }
  return after;
}

export function subscribeSpaceLayout(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSpaceLayout(): HomeLayout {
  return useSyncExternalStore(subscribeSpaceLayout, getSpaceLayout, () => SERVER_LAYOUT);
}

/** The chat the focused pane shows - the one an approval or question that does not name its place belongs to. */
export function focusedSpaceChatId(source: HomeLayout = layout()): string | null {
  const pane = source.space.panes.find((item) => item.id === source.space.focus);
  return pane?.active ?? null;
}

/** Re-renders only when the focused chat changes - not for a resize drag or a tab elsewhere. */
export function useFocusedSpaceChatId(): string | null {
  return useSyncExternalStore(subscribeSpaceLayout, () => focusedSpaceChatId(getSpaceLayout()), () => null);
}

/*
 * The notice Space shows when an open was refused: four panes are already open (`full`), or the window holds fewer panes than are open now (`narrow`).
 * Nothing is opened and nothing is closed; the person may put the chat in the pane they are on instead (`replace`).
 */
export type SpaceNotice = { block: RoomBlock; replace: () => void };
let pendingNotice: SpaceNotice | null = null;
const noticeListeners = new Set<() => void>();
const emitNotice = () => { for (const listener of noticeListeners) listener(); };
export function getSpaceNotice(): SpaceNotice | null { return pendingNotice; }
export function setSpaceNotice(notice: SpaceNotice | null): void { pendingNotice = notice; emitNotice(); }
export function useSpaceNotice(): SpaceNotice | null {
  return useSyncExternalStore((listener) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; }, getSpaceNotice, () => null);
}
/** The person chose "put it in this pane instead": do that (nothing else changes). */
export function confirmSpaceLimit(): void {
  const notice = pendingNotice;
  if (!notice) return;
  pendingNotice = null; emitNotice();
  notice.replace();
}

function reportOpen(before: HomeLayout, ref: OpenRef, how: OpenHow, paneId: string | undefined, replace: () => void): boolean {
  const block = openBlock(before, ref, how, paneId, limits());
  if (!block) return true;
  setSpaceNotice({ block, replace });
  return false;
}

const toSpace = (): void => { if (typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") !== "/workspace") navigate("/workspace"); };

/** Opens a chat in Space from anywhere (the left tree, a notification) and goes to Space when it is not on screen. `replace-pane` fills the focused pane (or `paneId`); `new-pane` opens the next one when there is room. */
export function openChatInSpace(ref: OpenRef, how: OpenHow = "replace-pane", paneId?: string): void {
  const replace = () => { updateSpaceLayout((source) => openInSpace(source, ref, "replace-pane", paneId, limits())); toSpace(); };
  if (reportOpen(layout(), ref, how, paneId, replace)) { updateSpaceLayout((source) => openInSpace(source, ref, how, paneId, limits())); toSpace(); }
  else toSpace(); // the notice is shown where Space is
}

/** Places a chat (a drop on a pane or on its right edge) and tells the person when there was no room. */
export function placeInSpace(ref: OpenRef, target: MoveTarget): void {
  const block = placeBlock(layout(), ref, target, limits());
  if (block) { setSpaceNotice({ block, replace: () => updateSpaceLayout((source) => placeTab(source, ref, { type: "replace", paneId: block.paneId }, limits())) }); return; }
  updateSpaceLayout((source) => placeTab(source, ref, target, limits()));
}

/** For tests: forget everything held in memory. */
export function resetSpaceStoreForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null; pending = false; current = null;
  pendingNotice = null; accountScope = null; scopeRemembered = false; earlyChanges = [];
  setAppUiPreferenceScope("homeLayout", null);
}

/** Marks the current layout as changed so it is written (a drag that moved things with `persist:false` calls this when it ends). */
export function persistSpaceLayout(): void {
  wire();
  pending = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; flushSpaceLayout(); }, WRITE_DELAY_MS);
}

/** The ids of the chats open in any pane, as one stable string (a cheap thing for a long list to depend on). */
export function useOpenChatKey(): string {
  return useSyncExternalStore(subscribeSpaceLayout, () => getSpaceLayout().space.panes.flatMap((pane) => pane.tabs.map((tab) => tab.chatId)).join(","), () => "");
}
/** The pins - the same array until a pin changes. */
export function useHomePinned(): readonly string[] {
  return useSyncExternalStore(subscribeSpaceLayout, () => getSpaceLayout().pinned, () => SERVER_LAYOUT.pinned);
}
/** The moved-to-front order per group - the same object until an order changes. */
export function useHomeOrder(): Readonly<Record<string, readonly string[]>> {
  return useSyncExternalStore(subscribeSpaceLayout, () => getSpaceLayout().order, () => SERVER_LAYOUT.order);
}
