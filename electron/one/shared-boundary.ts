/*
 * a `boundary` line of the person's shared memory - "do not talk first" (`no_proactive`) or "quiet hours" (`quiet_hours`, from..to as HH:MM) - is read by the
 * gate that decides whether this desktop may ring the phone for something the personal agent started by itself (a check-in: mobile-bridge/push.ts `quietEligible` notices). The same lines apply on every place
 * (the server's own gate reads them there), so a boundary said to the phone holds here and one said here holds on the phone.
 * Read: the live Personal lines whose `context_json` carries a boundary structure (written by the curator, or taken from the shared set by shared-memory-sync). Asked only when such a notice is about to be sent
 * (a handful a day); no cache, no timer, nothing stored. Both words are closed (`no_proactive`, `quiet_hours`); a line whose structure does not parse is not a boundary.
 */
export interface SharedBoundary {
  /** a `no_proactive` line is live: nothing the agent starts by itself rings */
  noProactive: boolean;
  /** the `quiet_hours` windows, minutes of the local day [from, to) (a window past midnight has to < from) */
  windows: Array<{ from: number; to: number }>;
}
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (text: unknown): number | null => { const m = typeof text === "string" ? CLOCK.exec(text.trim()) : null; return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** The boundary structures of these `context_json` texts (pure; also the gate's vector). */
export function sharedBoundaryOf(contexts: Iterable<string | null | undefined>): SharedBoundary {
  const out: SharedBoundary = { noProactive: false, windows: [] };
  for (const text of contexts) {
    if (!text) continue;
    let b: { type?: unknown; from?: unknown; to?: unknown } | undefined;
    try { b = (JSON.parse(text) as { boundary?: typeof b }).boundary; } catch { continue; }
    if (!b || typeof b !== "object") continue;
    if (b.type === "no_proactive") out.noProactive = true;
    else if (b.type === "quiet_hours") { const from = minutesOf(b.from), to = minutesOf(b.to); if (from !== null && to !== null && from !== to) out.windows.push({ from, to }); }
  }
  return out;
}

/** When the quiet window that covers `now` ends (ms), or null when none does. */
export function quietWindowEnd(boundary: SharedBoundary, now: Date): number | null {
  const minute = now.getHours() * 60 + now.getMinutes();
  let best: number | null = null;
  for (const w of boundary.windows) {
    const inside = w.from < w.to ? minute >= w.from && minute < w.to : minute >= w.from || minute < w.to;
    if (!inside) continue;
    const end = new Date(now); end.setHours(Math.floor(w.to / 60), w.to % 60, 0, 0);
    if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
    if (best === null || end.getTime() > best) best = end.getTime();
  }
  return best;
}

/** The live boundary lines of this desktop's Personal memory; null when the store cannot be read (the gate then holds nothing back). */
export function readSharedBoundary(): SharedBoundary | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = (require("../memory/database") as typeof import("../memory/database")).getMemoryDb();
    const rows = db.prepare("SELECT context_json FROM memory_entries WHERE scope='user_identity' AND superseded_at IS NULL AND content<>'' AND context_json LIKE '%\"boundary\"%'").all() as Array<{ context_json: string | null }>;
    return sharedBoundaryOf(rows.map((r) => r.context_json));
  } catch { return null; }
}
