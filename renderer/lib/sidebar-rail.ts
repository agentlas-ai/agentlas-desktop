"use client";

import { useCallback, useEffect, useState } from "react";
import { setAppSidebarCollapsed, SIDENAV_COLLAPSE_KEY } from "@/lib/app-control-bridge";

/**
 * The left panel's open/rail state for the Work shell's ProjectSidebar — the same rules SideNav keeps for the dashboard
 * side, so View ▸ Toggle Sidebar (CmdOrCtrl+[) and app.setSidebar move whichever panel is on screen.
 *
 * Windows retest 2 (2026-10-24, 1024x768 at 125 % = an 819 px viewport): the Work room had no way back. At ≤820 px the
 * ProjectSidebar was display:none with nothing in its place, and it ignored the sidebar toggle, so Ctrl+[ did nothing.
 *   - Narrow window (≤820 px): a rail stays on screen (Dashboard, New project, expand); expanding is an overlay that
 *     never takes the canvas width, and closes on navigation or Escape.
 *   - Wide window: the shared collapse preference (agentlas.sidenav.collapsed) folds the panel to the same rail.
 */
export const SIDEBAR_COMPACT_QUERY = "(max-width: 820px)";

export interface SidebarRail {
  /** Show the rail (icons only) instead of the full panel. */
  collapsed: boolean;
  /** The window is narrow: an expanded panel is an overlay. */
  compactViewport: boolean;
  /** Narrow window with the overlay open. */
  overlayOpen: boolean;
  toggle(): void;
  closeOverlay(): void;
}

export function useSidebarRail(routeKey: string): SidebarRail {
  const [collapsedPref, setCollapsedPref] = useState(false);
  const [compactViewport, setCompactViewport] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);

  useEffect(() => {
    const sync = (event?: StorageEvent) => {
      if (event && event.key !== null && event.key !== SIDENAV_COLLAPSE_KEY) return;
      try {
        const next = window.localStorage.getItem(SIDENAV_COLLAPSE_KEY) === "1";
        setCollapsedPref(next);
        // A toggle from the menu or app control (an event, not the first read) opens or closes the narrow overlay too.
        if (event) setCompactOpen(!next);
      } catch { /* Storage is optional. */ }
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(SIDEBAR_COMPACT_QUERY);
    const sync = () => {
      setCompactViewport(query.matches);
      if (!query.matches) setCompactOpen(false);
    };
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => { setCompactOpen(false); }, [routeKey]);

  const overlayOpen = compactViewport && compactOpen;
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setCompactOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen]);

  const toggle = useCallback(() => {
    if (compactViewport) {
      setCompactOpen((open) => !open);
      return;
    }
    const next = !collapsedPref;
    setCollapsedPref(next);
    try { setAppSidebarCollapsed(next); } catch { /* Storage is optional. */ }
  }, [compactViewport, collapsedPref]);

  return {
    collapsed: compactViewport ? !compactOpen : collapsedPref,
    compactViewport,
    overlayOpen,
    toggle,
    closeOverlay: useCallback(() => setCompactOpen(false), []),
  };
}
