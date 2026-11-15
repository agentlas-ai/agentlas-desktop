"use client";

import { useEffect, useState } from "react";
import { ipcEvents } from "@/lib/ipc";
import { readViewData } from "@/lib/view-data-cache";

/**
 * The chats the app is running right now (Main's `active-chats` broadcast). One subscription per caller, no polling: the
 * left tree's running dot and Space's tab dots read the same broadcast.
 */
export function useRunningChats(): ReadonlySet<string> {
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set(readViewData<string[]>("dashboard.active-chats")?.value ?? []));
  useEffect(() => {
    const off = ipcEvents()?.onActiveChats?.((ids) => setRunning((previous) => (previous.size === ids.length && ids.every((id) => previous.has(id)) ? previous : new Set(ids))));
    return () => { off?.(); };
  }, []);
  return running;
}
