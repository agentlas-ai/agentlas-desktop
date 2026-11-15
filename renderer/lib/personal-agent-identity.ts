"use client";

/*
 * The personal agent's name and face for the app frame's top-left row (F-D1).
 * Read once when the row first mounts and again when Main announces a profile change (store:changed one-profile) - no timer.
 * The last value is kept at module level so the row does not blink when the frame swaps between the big menu and the
 * Workspace list. A read that fails or returns nothing leaves `null`: the row then shows the plain role label, never an invented name.
 */
import { useEffect, useSyncExternalStore } from "react";
import { ipc, ipcEvents } from "./ipc";

export interface PersonalAgentIdentity {
  name: string;
  avatarIcon: string | null;
  revision: number | null;
}

let current: PersonalAgentIdentity | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export function usePersonalAgentIdentity(): PersonalAgentIdentity | null {
  useEffect(() => {
    const api = ipc();
    if (!api?.oneProfile?.get) return;
    let alive = true;
    const read = () => {
      void Promise.resolve()
        .then(() => api.oneProfile.get())
        .then((profile) => {
          if (!alive || !profile) return;
          const name = (profile.displayName ?? "").trim();
          const next: PersonalAgentIdentity = {
            name,
            avatarIcon: profile.avatarIcon?.trim() || null,
            revision: Number.isSafeInteger(profile.version) ? profile.version : null,
          };
          if (current && current.name === next.name && current.avatarIcon === next.avatarIcon && current.revision === next.revision) return;
          current = next;
          emit();
        })
        .catch(() => undefined);
    };
    read();
    let off: (() => void) | undefined;
    try { off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "one-profile") read(); }); } catch { /* older preload: refreshed on next open */ }
    return () => { alive = false; off?.(); };
  }, []);
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => null,
  );
}
