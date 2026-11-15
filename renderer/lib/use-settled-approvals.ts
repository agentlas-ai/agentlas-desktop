"use client";

/**
 * The answered and closed cards of a conversation (and of the member sessions behind a group room), read from the stored ledger rows
 * (`listSettledToolApprovals`, Agentlas 2.0 AL). It reads when the conversation opens or its ids change, and once more each time a card
 * settles (the resolution event Main already broadcasts). No timer; a bridge without the call, or a refused call, draws nothing.
 * Memory: the latest list of one conversation (at most 200 rows, newer than that are read again on the next open).
 */
import { useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { SettledToolApproval } from "@shared/types";

const sameList = (a: readonly SettledToolApproval[], b: readonly SettledToolApproval[]): boolean =>
  a.length === b.length && a.every((row, index) => row.id === b[index]!.id && row.outcome === b[index]!.outcome && row.decidedAt === b[index]!.decidedAt);

export function useSettledApprovals(chatIds: readonly string[]): readonly SettledToolApproval[] {
  const key = chatIds.filter(Boolean).join("\u0000");
  const [records, setRecords] = useState<readonly SettledToolApproval[]>([]);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    const ids = key ? key.split("\u0000") : [];
    let cancelled = false;
    const read = async (): Promise<void> => {
      const api = ipc();
      if (!ids.length || !api?.listSettledToolApprovals) { if (!cancelled) setRecords((current) => (current.length ? [] : current)); return; }
      try {
        const rows = await api.listSettledToolApprovals(ids);
        if (cancelled || keyRef.current !== key) return;
        const next = Array.isArray(rows) ? rows : [];
        setRecords((current) => (sameList(current, next) ? current : next));
      } catch { /* the line is a record: a failed read draws nothing */ }
    };
    setRecords([]);
    void read();
    const off = ipcEvents()?.onToolApprovalResolution?.((receipt) => { if (!receipt?.pending) void read(); });
    return () => { cancelled = true; if (typeof off === "function") off(); };
  }, [key]);
  return records;
}
