"use client";

/* One receipt value -> one card: icon + a few words; the whole sentence is the hover. Every surface mounts this and draws nothing of its own for a receipt row. */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { IconAlertTriangle, IconCheck, IconClock, IconClose } from "@/components/Icon";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import { RECEIPT_ACTION_KEY, RECEIPT_CARD_ATTRS, receiptOfRow, receiptTone } from "@/lib/receipt-card-model";
import { useComposerControls } from "@/lib/composer-control-bus";
import { closedQuestionCards, reopenQuestionCard, useClosedQuestionCards } from "@/lib/question-cards";
import { receiptPlainLine, receiptShortLine, type ReceiptCardValue, type ReceiptLive } from "@shared/receipt-card";
import type { RemedyAction } from "@shared/owner-remedy";
import s from "./ReceiptCard.module.css";

export type ReceiptActionHandlers = Partial<Record<RemedyAction, (value: ReceiptCardValue) => void | Promise<void>>>;

export function ReceiptCard({ value, live, handlers }: { value: ReceiptCardValue; live?: ReceiptLive | null; handlers?: ReceiptActionHandlers }) {
  const { t, locale } = useT();
  const [busy, setBusy] = useState<RemedyAction | null>(null);
  const lang = locale === "ko" ? "ko" : "en", zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const line = receiptShortLine(value, live, lang, zone);
  const full = receiptPlainLine(value, live, lang, zone);
  const tone = receiptTone(value);
  const fileRef = value.kind === "file" && value.outcome === "done" ? value.ref as { path?: unknown; root?: unknown } : null;
  const filePath = fileRef && typeof fileRef.path === "string" && fileRef.path ? { path: fileRef.path, root: typeof fileRef.root === "string" ? fileRef.root : "" } : null;
  const actions = (value.actions ?? []).filter((action) => typeof handlers?.[action] === "function");
  const Mark = tone === "ok" ? IconCheck : tone === "problem" ? IconAlertTriangle : value.outcome === "expired" ? IconClock : IconClose;
  return (
    <section role="status" {...RECEIPT_CARD_ATTRS} data-receipt-kind={value.kind} data-receipt-outcome={value.outcome} data-receipt-id={value.id} className={s.card}>
      <div className={s.head}>
        <span className={s.mark} data-tone={tone} aria-hidden="true"><Mark size={14} /></span>
        <span className={s.line} title={full} aria-label={full} data-receipt-line="true">{line}</span>
      </div>
      {filePath && <div className={s.path} data-receipt-path="true" data-receipt-root={filePath.root} title={filePath.path}>{filePath.root === "outside" ? `${locale === "ko" ? "폴더 밖" : "Outside"} · ` : ""}{filePath.path}</div>}
      {actions.length > 0 && (
        <div className={s.actions}>
          {actions.map((action) => (
            <button key={action} type="button" className={s.action} data-receipt-action={action} disabled={busy !== null}
              onClick={() => { setBusy(action); void Promise.resolve(handlers![action]!(value)).catch(() => undefined).finally(() => setBusy(null)); }}>
              {t(RECEIPT_ACTION_KEY[action])}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** A stored row as its card; null when it is not a receipt. */
export function ReceiptCardRow({ row, live, handlers }: { row: { id?: string; role?: string; text?: string | null }; live?: Record<string, ReceiptLive> | null; handlers?: ReceiptActionHandlers }) {
  const value = receiptOfRow(row);
  return value ? <ReceiptCard value={value} live={live?.[value.id] ?? null} handlers={handlers} /> : null;
}

// One live read per conversation, shared by its cards; re-read on a store signal, never a timer.
interface LiveFeed { value: Record<string, ReceiptLive>; listeners: Set<() => void>; stop: () => void }
const feeds = new Map<string, LiveFeed>();
const EMPTY_LIVE: Record<string, ReceiptLive> = {};

function startFeed(chatId: string): LiveFeed {
  const feed: LiveFeed = { value: EMPTY_LIVE, listeners: new Set(), stop: () => undefined };
  const api = ipc();
  if (!api?.chat?.receiptLive) return feed;
  let cancelled = false, loading = false, burst: ReturnType<typeof setTimeout> | null = null;
  const read = () => {
    if (cancelled || loading) return;
    loading = true;
    void api.chat.receiptLive(chatId).then((value) => {
      if (cancelled || JSON.stringify(feed.value) === JSON.stringify(value)) return;
      feed.value = value;
      for (const listener of [...feed.listeners]) listener();
    }).catch(() => undefined).finally(() => { loading = false; });
  };
  read();
  const off = subscribeStoreChanges((change) => {
    if ((change.entity !== "chat" && change.entity !== "automation" && change.entity !== "automations") || (change.entity === "chat" && change.id && change.id !== chatId) || burst) return;
    burst = setTimeout(() => { burst = null; read(); }, 300);
  });
  feed.stop = () => { cancelled = true; off(); if (burst) clearTimeout(burst); };
  return feed;
}

export function useReceiptLive(chatId: string | null | undefined): Record<string, ReceiptLive> {
  const subscribe = useCallback((listener: () => void) => {
    if (!chatId) return () => undefined;
    let feed = feeds.get(chatId);
    if (!feed) { feed = startFeed(chatId); feeds.set(chatId, feed); }
    feed.listeners.add(listener);
    const mine = feed;
    return () => {
      mine.listeners.delete(listener);
      if (mine.listeners.size === 0) { mine.stop(); if (feeds.get(chatId) === mine) feeds.delete(chatId); }
    };
  }, [chatId]);
  return useSyncExternalStore(subscribe, () => (chatId ? feeds.get(chatId)?.value ?? EMPTY_LIVE : EMPTY_LIVE), () => EMPTY_LIVE);
}

/** A stored receipt row with its live feed and this surface's actions (null when the row is not a receipt). */
export function ReceiptRowCard({ row, chatId, handlers }: { row: { id?: string; role?: string; text?: string | null }; chatId: string | null | undefined; handlers?: ReceiptActionHandlers }) {
  const value = receiptOfRow(row);
  if (!value) return null;
  return value.actions?.includes("reopen_question")
    ? <ReceiptRowWithReopen row={row} chatId={chatId} handlers={handlers} />
    : <ReceiptRowPlain row={row} chatId={chatId} handlers={handlers} />;
}

function ReceiptRowPlain({ row, chatId, handlers }: { row: { id?: string; role?: string; text?: string | null }; chatId: string | null | undefined; handlers?: ReceiptActionHandlers }) {
  const live = useReceiptLive(chatId);
  const actions = useReceiptActions(chatId, handlers);
  return <ReceiptCardRow row={row} live={live} handlers={actions} />;
}

function ReceiptRowWithReopen({ row, chatId, handlers }: { row: { id?: string; role?: string; text?: string | null }; chatId: string | null | undefined; handlers?: ReceiptActionHandlers }) {
  const live = useReceiptLive(chatId);
  const closed = useClosedQuestionCards(chatId);
  const actions = useReceiptActions(chatId, handlers, closed.length > 0);
  return <ReceiptCardRow row={row} live={live} handlers={actions} />;
}

/** The buttons every surface can do; resend_other_ai, grant_permission and reopen_question appear only where this surface has the composer or card they need. A surface's own handlers override these. */
export function useReceiptActions(chatId: string | null | undefined, own?: ReceiptActionHandlers, hasClosedQuestion = false): ReceiptActionHandlers {
  const controls = useComposerControls(chatId);
  return useMemo<ReceiptActionHandlers>(() => ({
    login: async () => { await ipc()?.oneWindow?.showMain?.({ route: "/settings" }); },
    hand_to_personal_one: async () => { await ipc()?.oneWindow?.open?.(); },
    ...(chatId ? {
      pick_project_folder: async () => {
        const api = ipc();
        const grant = await api?.workspace?.selectFolder?.();
        if (grant) await api?.workspace?.set?.(chatId, grant);
      },
    } : {}),
    ...(controls.openRuntimePicker ? { resend_other_ai: async () => { controls.openRuntimePicker?.(); } } : {}),
    ...(controls.openPermission ? { grant_permission: async () => { controls.openPermission?.(); } } : {}),
    ...(chatId && hasClosedQuestion ? {
      reopen_question: async () => {
        const latest = [...closedQuestionCards(chatId)].sort((a, b) => a.at - b.at).pop();
        if (latest) reopenQuestionCard(chatId, latest.key);
      },
    } : {}),
    ...(own ?? {}),
  }), [chatId, own, controls, hasClosedQuestion]);
}
