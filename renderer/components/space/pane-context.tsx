"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/*
 * "This conversation is drawn in a pane of the Workspace" (Agentlas 2.0 F-D5). Space provides it around each pane's body; the shared composer
 * (ChatInput) reads it to take the pane's one shape, and the conversation surface hands the pane's head the actions it owns (the head is the pane's
 * only head: the old conversation head is not drawn). Anything outside the Workspace (Finance, Science, the personal agent's own screen, Build) is
 * not inside this provider and keeps its own composer and head exactly as they were. The value is only where the conversation is drawn: it never
 * reaches a model call, a send or a stored value.
 */

/** What a conversation surface lets the pane's head do. Each member is optional: a menu row is drawn only for what the surface gave. */
export interface PaneActions {
  /** "New session" / "Clear history" of the surface (the same handler the composer's History menu called). */
  session?: (action: "new" | "clear") => void;
  /** A run is going: Clear history waits for it (the surface refuses it with its own words). */
  busy?: boolean;
  /** The result panel (the one panel button of the head). `enabled` false = nothing to show yet. */
  viewer?: { toggle: () => void; enabled: boolean; open: boolean };
}

export interface WorkspacePane {
  paneId: string;
  chatId: string;
  /** Sets (replaces) the actions of the surface in this pane; null on unmount. */
  setActions: (actions: PaneActions | null) => void;
}

const WorkspacePaneContext = createContext<WorkspacePane | null>(null);
export const WorkspacePaneProvider = WorkspacePaneContext.Provider;
export const useWorkspacePane = (): WorkspacePane | null => useContext(WorkspacePaneContext);

/**
 * A surface registers its pane actions for as long as it is mounted in a pane. The functions are called through a ref (their identity may change every
 * render); the head is told again only when a flag it draws changes. Nothing happens outside a pane.
 */
export function usePaneActions(actions: PaneActions): void {
  const pane = useWorkspacePane();
  const setActions = pane?.setActions;
  const latest = useRef(actions);
  latest.current = actions;
  const has = { session: Boolean(actions.session), viewer: Boolean(actions.viewer) };
  const flags = `${has.session ? 1 : 0}${actions.busy ? 1 : 0}|${has.viewer ? 1 : 0}${actions.viewer?.enabled ? 1 : 0}${actions.viewer?.open ? 1 : 0}`;
  useEffect(() => {
    if (!setActions) return undefined;
    const now = latest.current;
    setActions({
      session: now.session ? (action) => latest.current.session?.(action) : undefined,
      busy: now.busy,
      viewer: now.viewer ? { toggle: () => latest.current.viewer?.toggle(), enabled: now.viewer.enabled, open: now.viewer.open } : undefined,
    });
  }, [setActions, flags]);
  useEffect(() => () => setActions?.(null), [setActions]);
}
