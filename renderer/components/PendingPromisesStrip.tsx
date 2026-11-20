"use client";

// Pending promises of one conversation, from its durable objects only (schedules, owed answers, the Goal's wait); read on a store signal, never a timer.
import { useEffect, useState } from "react";
import { IconChat, IconClock, IconRefresh, IconSlash, IconTarget } from "@/components/Icon";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import { receiptTimeWord } from "@shared/receipt-card";
import type { PendingPromiseItem } from "@shared/pending-promises";
import s from "./ReceiptCard.module.css";

export function usePendingPromises(chatId: string | null | undefined): PendingPromiseItem[] {
  const [state, setState] = useState<{ chatId: string | null; items: PendingPromiseItem[] }>({ chatId: null, items: [] });
  useEffect(() => {
    if (!chatId) return;
    const api = ipc();
    if (!api?.chat?.pendingPromises) return;
    let cancelled = false, loading = false, burst: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      if (cancelled || loading) return;
      loading = true;
      void api.chat.pendingPromises(chatId).then((value) => {
        if (cancelled) return;
        setState((current) => (current.chatId === chatId && JSON.stringify(current.items) === JSON.stringify(value.items) ? current : { chatId, items: value.items }));
      }).catch(() => undefined).finally(() => { loading = false; });
    };
    read();
    const off = subscribeStoreChanges((change) => {
      if ((change.entity !== "chat" && change.entity !== "automation" && change.entity !== "automations") || (change.entity === "chat" && change.id && change.id !== chatId) || burst) return;
      burst = setTimeout(() => { burst = null; read(); }, 300);
    });
    return () => { cancelled = true; off(); if (burst) clearTimeout(burst); };
  }, [chatId]);
  return state.chatId === chatId ? state.items : [];
}

function ScheduleSwitch({ id, enabled, label }: { id: string; enabled: boolean; label: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const word = enabled ? t("pending.strip.pause") : t("pending.strip.resume");
  return (
    <button type="button" className={s.stripAction} disabled={busy} data-pending-schedule-switch={id} title={word} aria-label={label ? `${word}: ${label}` : word}
      onClick={() => { const api = ipc(); if (!api?.automations?.toggle || busy) return; setBusy(true); void api.automations.toggle(id, !enabled).catch(() => undefined).finally(() => setBusy(false)); }}>
      {enabled ? <IconSlash size={12} aria-hidden="true" /> : <IconRefresh size={12} aria-hidden="true" />}
    </button>
  );
}

export function PendingPromisesStrip({ chatId }: { chatId: string | null | undefined }) {
  const { t, locale } = useT();
  const items = usePendingPromises(chatId);
  if (items.length === 0) return null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className={s.strip} role="status" data-feature="pending-promises" data-impl="pending-promises-strip" data-pending-count={items.length}>
      {items.map((item) => {
        const when = item.at ? receiptTimeWord(item.at, locale === "ko" ? "ko" : "en", zone) : "";
        const paused = item.kind === "schedule" && item.enabled === false;
        const Mark = paused ? IconSlash : item.kind === "schedule" ? IconClock : item.kind === "wait" ? IconChat : IconTarget;
        const name = item.kind === "goal-wait" ? "" : item.label || (item.kind === "wait" ? t("pending.strip.unnamed") : "");
        const lead = item.kind === "wait" ? t("pending.strip.wait") : item.kind === "goal-wait" ? t("pending.strip.goal_wait") : "";
        return (
          <span key={`${item.kind}:${item.id}`} className={s.stripItem} data-paused={paused ? "true" : undefined} data-pending-kind={item.kind}>
            <Mark size={12} aria-hidden="true" />
            <span>{[lead, name, when].filter(Boolean).join(" · ")}</span>
            {item.kind === "schedule" ? <ScheduleSwitch id={item.id} enabled={item.enabled !== false} label={name} /> : null}
          </span>
        );
      })}
    </div>
  );
}
