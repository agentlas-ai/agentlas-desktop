"use client";


























import { ipc, ipcEvents } from "@/lib/ipc";

const LEGACY_STORAGE_KEY = "agentlas.one.alwaysApprovedChats.v1";

type Listener = (chatIds: readonly string[]) => void;

let chatIds: string[] = [];
let hydrated = false;
let hydration: Promise<void> | null = null;
const listeners = new Set<Listener>();
let policyChangeEpoch = 0;
let displayReadOrder = 0;
let eventSource: ReturnType<typeof ipcEvents> = null;
let disconnectEvents: (() => void) | null = null;
let focusSubscribed = false;

function ensureLiveRefresh(): void {
  if (typeof window === "undefined") return;
  const source = ipcEvents();
  if (source !== eventSource) {
    disconnectEvents?.();
    eventSource = source;
    disconnectEvents = source?.onStoreChanged?.((change) => {
      if (change.entity !== "capability-grant") return;
      ++policyChangeEpoch;
      void refreshAlwaysApprovedChats();
    }) ?? null;
  }
  if (!focusSubscribed) {
    focusSubscribed = true;
    window.addEventListener("focus", () => { void refreshAlwaysApprovedChats(); });
  }
}

/** Re-read Main before automatic approval; cached membership is display-only. */
async function readFreshAlwaysApprovedChats(): Promise<string[] | null> {
  await hydrate();
  const epoch = policyChangeEpoch;
  const readOrder = ++displayReadOrder;
  try {
    const ids = await ipc()?.listAlwaysApprovedChats();
    if (epoch !== policyChangeEpoch || !Array.isArray(ids)) return null;
    const currentIds = ids.filter((id): id is string => typeof id === "string");
    // Parallel reads do not revoke one another's authorization snapshot. Only
    // the newest requested read may replace the display mirror.
    if (readOrder === displayReadOrder) applyServerList(currentIds);
    return currentIds;
  } catch {
    return null;
  }
}

export async function refreshAlwaysApprovedChats(): Promise<boolean> {
  return await readFreshAlwaysApprovedChats() !== null;
}

export async function readChatAlwaysApproval(chatId: string | null | undefined): Promise<boolean> {
  if (!chatId) return false;
  const ids = await readFreshAlwaysApprovedChats();
  return ids?.includes(chatId) === true;
}

function emit(): void {
  for (const listener of listeners) listener(chatIds);
}

function applyServerList(ids: unknown): void {
  if (!Array.isArray(ids)) return;
  const next = ids.filter((id): id is string => typeof id === "string");
  if (next.length === chatIds.length && next.every((id) => chatIds.includes(id))) return;
  chatIds = next;
  emit();
}

/** 첫 소비 시 1회: 레거시 localStorage → DB 이관 후 서버 목록으로 대체. */
async function hydrate(): Promise<void> {
  ensureLiveRefresh();
  if (hydration) return hydration;
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const api = ipc();
  if (!api?.listAlwaysApprovedChats) return;
  let legacy: string[] = [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) legacy = parsed.filter((id): id is string => typeof id === "string");
  } catch { /* 없거나 깨진 레거시 값 — 이관할 것이 없다 */ }
  hydration = (async () => {
    try {
      for (const id of legacy) await api.grantChatAlwaysApproval?.(id);
      if (legacy.length > 0) window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      applyServerList(await api.listAlwaysApprovedChats());
    } catch {
      // A failed first read is not a valid empty baseline. Let the next caller
      // retry before it decides whether a pending approval may auto-resolve.
      hydrated = false;
      hydration = null;
    }
  })();
  return hydration;
}

export function waitForAlwaysApprovedChats(): Promise<void> {
  return hydrate();
}

export function alwaysApprovedChatIds(): readonly string[] {
  void hydrate();
  return chatIds;
}

export function isChatAlwaysApproved(chatId: string | null | undefined): boolean {
  void hydrate();
  return Boolean(chatId) && chatIds.includes(String(chatId));
}

export async function grantAlwaysApproval(chatId: string): Promise<void> {
  if (!chatId) return;
  await hydrate();
  // The other window may have revoked since this mirror was read.
  ++policyChangeEpoch;
  const api = ipc();
  if (!api?.grantChatAlwaysApproval) throw new Error("Always-approval bridge unavailable");
  const next = await api.grantChatAlwaysApproval(chatId);
  if (!Array.isArray(next) || !next.includes(chatId)) {
    throw new Error("Always-approval grant was not durably confirmed");
  }
  ++policyChangeEpoch;
  applyServerList(next);
}

export async function revokeAlwaysApproval(chatId: string): Promise<void> {
  await hydrate();
  // Always send revocation, including after a grant from another window.
  ++policyChangeEpoch;
  const api = ipc();
  if (!api?.revokeChatAlwaysApproval) throw new Error("Always-approval bridge unavailable");
  const next = await api.revokeChatAlwaysApproval(chatId);
  if (!Array.isArray(next) || next.includes(chatId)) {
    throw new Error("Always-approval revoke was not durably confirmed");
  }
  ++policyChangeEpoch;
  applyServerList(next);
}

export function subscribeAlwaysApproved(listener: Listener): () => void {
  void hydrate();
  listeners.add(listener);
  listener(chatIds);
  return () => { listeners.delete(listener); };
}
