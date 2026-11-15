"use client";

// One read of this agent's memory for the Timeline and the Memory tab (Agentlas 2.0 F-D8 / F-D9). It reads when an agent is opened and when the owner
// comes back to a tab that shows it (never on a timer), keeps the newest 300 lines and says "could not read" instead of an empty list.
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { DesktopMemoryListEntry, DesktopMemoryQueryResult, DesktopMemoryTarget } from "@shared/desktop-memory-inspector";

export const AGENT_MEMORY_FIRST_READ = 300;
export type StoreSkipCode = { kind: string; code: string };

export function useAgentMemory(agentId: string, wanted: boolean) {
  const [result, setResult] = useState<DesktopMemoryQueryResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [skipped, setSkipped] = useState<StoreSkipCode[]>([]);
  const generation = useRef(0);
  const read = useCallback(async (): Promise<DesktopMemoryQueryResult | null> => {
    const current = ++generation.current;
    const api = ipc()?.oneMemory?.inspector;
    if (!api) { setFailed(true); return null; }
    try {
      const value = await api.query({ actorId: agentId, limit: AGENT_MEMORY_FIRST_READ, status: "active" });
      if (current !== generation.current) return null;
      if (value.schemaVersion !== "agentlas.desktop-memory-inspector.v1") throw new Error("unavailable");
      setResult(value); setFailed(false);
      void ipc()?.agentMemory?.skippedStores?.({ agentId }).then((codes) => { if (current === generation.current) setSkipped(Array.isArray(codes) ? codes : []); }).catch(() => { if (current === generation.current) setSkipped([]); });
      return value;
    } catch { if (current === generation.current) setFailed(true); return null; }
  }, [agentId]);
  useEffect(() => { setResult(null); setFailed(false); setSkipped([]); return () => { generation.current++; }; }, [agentId]);
  useEffect(() => { if (wanted) void read(); }, [wanted, read]);

  /** Forget lines one by one. A line another forget moved on is read again once and retried; the first failure that stays stops and is returned. */
  const forget = useCallback(async (entries: DesktopMemoryListEntry[]): Promise<{ forgotten: number; failed: boolean; remaining: number }> => {
    const api = ipc()?.oneMemory?.inspector;
    if (!api) return { forgotten: 0, failed: true, remaining: 0 };
    let forgotten = 0;
    let targets: DesktopMemoryTarget[] = entries;
    for (const entry of entries) {
      const target = targets.find((item) => item.memoryId === entry.memoryId) ?? entry;
      try { await api.forget({ memoryId: target.memoryId, ownerRef: target.ownerRef, actorId: target.actorId, expectedRevision: target.expectedRevision, expectedEpoch: target.expectedEpoch }); forgotten++; }
      catch {
        const fresh = await api.query({ actorId: agentId, limit: AGENT_MEMORY_FIRST_READ, status: "active" }).catch(() => null);
        const again = fresh?.entries.find((item) => item.memoryId === entry.memoryId);
        if (!fresh || !again) { await read(); return { forgotten, failed: !fresh, remaining: 0 }; }
        targets = fresh.entries;
        try { await api.forget({ memoryId: again.memoryId, ownerRef: again.ownerRef, actorId: again.actorId, expectedRevision: again.expectedRevision, expectedEpoch: again.expectedEpoch }); forgotten++; }
        catch { await read(); return { forgotten, failed: true, remaining: 0 }; }
      }
    }
    const after = await read();
    return { forgotten, failed: false, remaining: after ? after.total : 0 };
  }, [agentId, read]);

  return { result, entries: result?.entries ?? null, failed, skipped, reload: read, forget };
}
