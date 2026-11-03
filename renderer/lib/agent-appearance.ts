"use client";
import { useEffect, useState } from "react";
import type { AgentAppearance } from "@shared/agent-appearance";
import { ipc, ipcEvents } from "@/lib/ipc";

/** An answer from an old agent or account never becomes the current portrait. */
export function useAgentAppearance(id?: string): AgentAppearance | null {
  const [state, setState] = useState<{ id: string; value: AgentAppearance | null } | null>(null);
  useEffect(() => {
    if (!id) { setState(null); return; }
    let live = true, sequence = 0;
    const read = () => {
      const current = ++sequence;
      setState(null);
      const api = ipc()?.agentWorkspace?.readAppearance;
      if (!id || !api) return;
      void api(id).then((view) => { if (live && current === sequence && view.agentId === id) setState({ id, value: view.appearance }); })
        .catch(() => { if (live && current === sequence) setState(null); });
    };
    const offStore = ipcEvents()?.onStoreChanged?.((event) => { if (event.entity === "agent" && (!event.id || event.id === id)) read(); });
    const offAuth = ipc()?.auth.onSessionChanged?.(read);
    read();
    return () => { live = false; sequence++; offStore?.(); offAuth?.(); };
  }, [id]);
  return state && state.id === id ? state.value : null;
}
