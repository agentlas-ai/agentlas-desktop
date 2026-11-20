/*
 * The model behind THE question card (components/decision/QuestionCardHost.tsx): what a card is, how each source's question becomes one, and the
 * closed state - the person closed a card with its X and the conversation keeps a "Reopen" line (sheet open -> closed -> open).
 *
 * Sources (all read through Main; this file reads none of them itself):
 *   chat-fence    a model's <<agentlas-ask>> fence in the last assistant row (Work, personal, a room)
 *   decision      a One decision question Main holds as a pending confirmation (lib/attention.ts)
 *   personal-ask  the personal agent's own question (a fence in its window's last answer)
 *   ask-user      a tool's blocking ask_user (lib/ask-user-queue.ts)
 *   room-member   a teammate's question asked inside a room
 *
 * Closed state: a card key per conversation, kept in the DATABASE by Main (electron/chat/closed-question-cards.ts: every window and every start read the same answer);
 * this file is the window's cache. Retention (nothing is kept without an owner and an end): an entry lives until the card's question is gone from its source (answered,
 * superseded, expired - useQuestionCards prunes it then) or 14 days, at most 20 per conversation and 200 in all (oldest out), enforced by Main.
 */
import { useEffect, useSyncExternalStore } from "react";
import { ipc } from "@/lib/ipc";
import { fenceCardKeyOfIds } from "@shared/question-card-key";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import type { PendingConfirmation, AskUserRequestEvent } from "@/lib/types";
import type { HostQuestion } from "@/components/decision/QuestionCardHost";

export type QuestionCardSource = "chat-fence" | "decision" | "personal-ask" | "ask-user" | "room-member";

export const QUESTION_CARD_FEATURE = "question-card" as const;
export const QUESTION_CARD_IMPL = "question-card-host" as const;
/** The pair every drawing of a question carries, so a screen test proves that only the registered card draws a question. */
export const QUESTION_CARD_ATTRS = { "data-feature": QUESTION_CARD_FEATURE, "data-impl": QUESTION_CARD_IMPL } as const;

/** A question waiting for the person, from any source, in the one shape the card draws. */
export interface QuestionCardModel {
  /** Stable for the same asked batch: the closed state and the Reopen line hang on it. */
  key: string;
  source: QuestionCardSource;
  chatId: string | null;
  questions: HostQuestion[];
  /** The source's own object, handed back to the surface's answer handler. */
  origin: unknown;
}

export const fenceCardKey = (questions: ReadonlyArray<{ id: string }>): string => fenceCardKeyOfIds(questions.map((question) => question.id));

export function confirmationToCard(confirmation: PendingConfirmation, chatId: string | null): QuestionCardModel {
  return {
    key: `decision:${confirmation.sourceMessageId}`,
    source: "decision",
    chatId,
    origin: confirmation,
    questions: [{
      id: confirmation.sourceMessageId,
      question: confirmation.question,
      ...(confirmation.header ? { header: confirmation.header } : {}),
      multiSelect: Boolean(confirmation.multiSelect),
      options: confirmation.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
    }],
  };
}

export function askUserToCard(request: AskUserRequestEvent): QuestionCardModel {
  return {
    key: `ask-user:${request.requestId}`,
    source: "ask-user",
    chatId: request.chatId ?? null,
    origin: request,
    questions: [{
      id: request.requestId,
      question: request.askedBy ? `${request.askedBy} · ${request.question}` : request.question,
      options: request.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
    }],
  };
}

// ── closed state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The cards a person closed with X are the CONVERSATION's state in the database (electron/chat/closed-question-cards.ts), not this window's: every window and the next start read the
// same answer. This module is the window's cache of it - read on a store signal, written through Main (optimistically, then taken from Main's answer) - and the one-time import of the
// old localStorage copy (`agentlas.question-closed.v1`), which is removed once Main has it.

export interface ClosedQuestionCard { key: string; count: number; at: number }
const LEGACY_STORAGE_KEY = "agentlas.question-closed.v1";
export const CLOSED_QUESTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PER_CHAT = 20;

const cache = new Map<string, readonly ClosedQuestionCard[]>();
const hydrated = new Set<string>();
const listeners = new Set<() => void>();
const NONE: readonly ClosedQuestionCard[] = [];
let legacyImported = false;

function storage(): Storage | undefined { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } }
const sameList = (a: readonly ClosedQuestionCard[], b: readonly ClosedQuestionCard[]): boolean => a.length === b.length && a.every((item, index) => item.key === b[index].key && item.count === b[index].count && item.at === b[index].at);

function setCached(chatId: string, list: readonly ClosedQuestionCard[]): void {
  const current = cache.get(chatId) ?? NONE;
  if (sameList(current, list)) return;
  if (list.length) cache.set(chatId, list); else cache.delete(chatId);
  for (const listener of [...listeners]) listener();
}

/** The old per-window copy goes to Main once (entry by entry, never over a newer close) and is removed; a window with no bridge keeps it for the next start. */
function importLegacyOnce(): void {
  if (legacyImported) return;
  const api = ipc();
  if (!api?.chat?.importClosedQuestions) return;
  legacyImported = true;
  try {
    const raw = storage()?.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") { storage()?.removeItem(LEGACY_STORAGE_KEY); return; }
    void api.chat.importClosedQuestions(parsed as Record<string, unknown>).then(() => {
      try { storage()?.removeItem(LEGACY_STORAGE_KEY); } catch { /* quota or security: the next start imports again, entry by entry, to the same result */ }
      for (const chatId of Object.keys(parsed as Record<string, unknown>)) { hydrated.delete(chatId); }
    }).catch(() => { legacyImported = false; });
  } catch { try { storage()?.removeItem(LEGACY_STORAGE_KEY); } catch { /* nothing to import */ } }
}

function readFromMain(chatId: string): void {
  const api = ipc();
  if (!api?.chat?.closedQuestions) return;
  void api.chat.closedQuestions(chatId).then((list) => setCached(chatId, list)).catch(() => undefined);
}

/** The cards this conversation's person closed (a new array only when it changed, so a subscriber does not redraw for nothing). */
export function closedQuestionCards(chatId: string | null | undefined): readonly ClosedQuestionCard[] {
  return chatId ? cache.get(chatId) ?? NONE : NONE;
}

export function closeQuestionCard(chatId: string | null | undefined, key: string, count = 1, now: number = Date.now()): void {
  if (!chatId) return;
  const list = [...(cache.get(chatId) ?? NONE).filter((item) => item.key !== key), { key, count: Math.max(1, Math.floor(count)), at: now }].slice(-MAX_PER_CHAT);
  setCached(chatId, list);
  const api = ipc();
  if (api?.chat?.closeQuestion) void api.chat.closeQuestion({ chatId, key, count }).then((saved) => setCached(chatId, saved)).catch(() => readFromMain(chatId));
}

export function reopenQuestionCard(chatId: string | null | undefined, key: string): void {
  if (!chatId) return;
  const current = cache.get(chatId);
  if (!current?.some((item) => item.key === key)) return;
  setCached(chatId, current.filter((item) => item.key !== key));
  const api = ipc();
  if (api?.chat?.reopenQuestion) void api.chat.reopenQuestion({ chatId, key }).then((saved) => setCached(chatId, saved)).catch(() => readFromMain(chatId));
}

/** Forget the closed entries of a conversation whose question is gone from its source (answered, superseded, expired). */
export function pruneClosedQuestionCards(chatId: string | null | undefined, liveKeys: ReadonlySet<string>): void {
  if (!chatId) return;
  const current = cache.get(chatId);
  if (!current?.length) return;
  const list = current.filter((item) => liveKeys.has(item.key));
  if (list.length === current.length) return;
  setCached(chatId, list);
  const api = ipc();
  if (api?.chat?.pruneQuestions) void api.chat.pruneQuestions({ chatId, liveKeys: [...liveKeys] }).then((saved) => setCached(chatId, saved)).catch(() => readFromMain(chatId));
}

export function useClosedQuestionCards(chatId: string | null | undefined): readonly ClosedQuestionCard[] {
  useEffect(() => {
    if (!chatId) return;
    importLegacyOnce();
    if (!hydrated.has(chatId)) { hydrated.add(chatId); readFromMain(chatId); }
    let burst: ReturnType<typeof setTimeout> | null = null;
    // Another window closed or reopened a card of this conversation (or the legacy import landed): Main announces the conversation, the cache re-reads.
    const off = subscribeStoreChanges((change) => {
      if (change.entity !== "chat" || (change.id && change.id !== chatId) || burst) return;
      burst = setTimeout(() => { burst = null; readFromMain(chatId); }, 250);
    });
    return () => { off(); if (burst) clearTimeout(burst); };
  }, [chatId]);
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => closedQuestionCards(chatId),
    () => closedQuestionCards(chatId),
  );
}

/** Test seam: forget the in-memory copy so the next read loads from Main again. */
export function resetClosedQuestionCardsForTest(): void { cache.clear(); hydrated.clear(); legacyImported = false; }
