"use client";

// Storage → Archive (owner 2026-10-13). Locally stored agents unused for 30 days are moved here automatically; the
// switch turns that off (on by default). Moving is never deleting: the only way back is the restore button, or being
// picked by routing. Text is kept to a minimum on purpose; sizes and dates carry the meaning.
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconArchive, IconReply } from "@/components/Icon";
import type { ArchiveState } from "@shared/archive";
import styles from "./ArchivePanel.module.css";

function bytesLabel(bytes: number | null, locale: string): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", { maximumFractionDigits: value >= 100 || unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

function dayLabel(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "numeric", day: "numeric" }).format(time);
}

export function ArchivePanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const api = ipc()?.archive;
  const [state, setState] = useState<ArchiveState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setState(await api.state()); } catch { /* the panel keeps its last view */ }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (!api) return null;
  const run = async (action: () => Promise<ArchiveState>) => {
    if (busy) return;
    setBusy(true);
    try { setState(await action()); } catch { await refresh(); } finally { setBusy(false); }
  };

  return (
    <section className={styles.panel} aria-labelledby="archive-title">
      <h2 id="archive-title" className={styles.title}>{ko ? "저장공간" : "Storage"}</h2>
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.switchLabel}>
            <IconArchive size={16} />
            <span>{ko ? `아카이브 · ${state?.unusedDays ?? 30}일 미사용` : `Archive · ${state?.unusedDays ?? 30} days unused`}</span>
            <button
              type="button"
              role="switch"
              aria-checked={state?.autoEnabled ?? true}
              aria-label={ko ? "자동 아카이브" : "Automatic archive"}
              className={styles.switch}
              data-on={(state?.autoEnabled ?? true) ? "true" : "false"}
              disabled={!state || busy}
              onClick={() => state && void run(() => api.setAuto(!state.autoEnabled))}
            ><span /></button>
          </span>
          <span className={styles.total}>{bytesLabel(state?.totalBytes ?? 0, locale)}</span>
        </div>
        <div className={styles.list}>
          {state?.items.length ? state.items.map((item) => (
            <div key={item.agentId} className={styles.row}>
              <span className={styles.name} title={item.name}>{item.name}</span>
              <span className={styles.when}>{dayLabel(item.lastUsedAt ?? item.archivedAt, locale)}</span>
              <span className={styles.size}>{bytesLabel(item.sizeBytes, locale)}</span>
              <button
                type="button"
                className={styles.restore}
                aria-label={ko ? `${item.name} 복구` : `Restore ${item.name}`}
                title={ko ? "복구" : "Restore"}
                disabled={busy}
                onClick={() => void run(() => api.restore(item.agentId))}
              ><IconReply size={15} /></button>
            </div>
          )) : <div className={styles.empty}>{state ? "—" : ""}</div>}
        </div>
      </div>
    </section>
  );
}
