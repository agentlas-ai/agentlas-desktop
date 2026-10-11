/** Chat host handover (1.3.0 A2): one chat's turns run in one process at a time, and when the host changes the old host
 * lets go of its idle resident runtime sessions first, so the new host resumes the SAME provider thread.
 *
 * Production 1.2.93 (2026-10-11 03:50-03:54Z): a turn ran in Main, Main's resident `codex app-server` kept the thread's
 * writer lock (~/.codex/thread-writer-locks/<thread>.lock), the next turn ran in the background service and its
 * thread/resume was refused with "thread ... already has an active writer". A Goal starting or ending in a One chat
 * moves the chat between the two processes (Goal custody is Desktop-only), so this is not a corner case.
 *
 * The durable fact is the run-owner table (invocation_run_owners, A1): its most recent row for the chat names the
 * process that ran the chat's previous turn, and an active row already refuses a racing start in the other process
 * (invocation_chat_busy_other_host). Nothing new is stored. This module is the cooperative half: before the first
 * provider dispatch of a turn the new host asks the previous host, over the authenticated native channel, to release.
 *
 *  - previous host is the same process kind (or a terminal): nothing to do;
 *  - reply ok: log `[runtime-session] handover from=<kind> released=<n>` as a run event and go on (resume, context kept);
 *  - reply busy (that process has a turn running in this chat): refuse with invocation_chat_busy_other_host;
 *  - unreachable / refused / timeout: go on with today's behaviour (a fresh session on writer_busy). Never hang.
 *
 * No electron import: the background service loads this without Electron (test-daemon-loads-without-electron). */
import { releaseIdleAgentResidencyForChat } from "./agent-residency";

export const CHAT_HANDOVER_VERSION = "agentlas.chat-handover.v1";
/** Bound the old host waits for its sessions' processes to exit. Under the native channel's 10 s request timeout. */
export const CHAT_HANDOVER_DEFAULT_DEADLINE_MS = 5000;
export const CHAT_BUSY_OTHER_HOST_CODE = "invocation_chat_busy_other_host";

export type HandoverHostKind = "desktop" | "daemon" | "terminal";
export interface ChatReleaseReply { busy: boolean; released: number; pending: number }
/** Ask the OTHER process to release its idle resident sessions of a chat. Rejects when it cannot be reached. */
export type ChatReleasePeer = (chatId: string, deadlineMs: number) => Promise<ChatReleaseReply>;

const idLike = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

/** The old host's half: release this process's idle resident sessions of the chat and wait (bounded) for the exit. */
export async function releaseLocalChatSessions(chatId: string, deadlineMs: number = CHAT_HANDOVER_DEFAULT_DEADLINE_MS): Promise<ChatReleaseReply> {
  if (!idLike(chatId)) throw Object.assign(new Error("chat_handover_invalid"), { code: "chat_handover_invalid" });
  const bound = Number.isFinite(deadlineMs) ? Math.max(0, Math.min(deadlineMs, CHAT_HANDOVER_DEFAULT_DEADLINE_MS)) : CHAT_HANDOVER_DEFAULT_DEADLINE_MS;
  const release = releaseIdleAgentResidencyForChat(chatId);
  if (release.busy) return { busy: true, released: 0, pending: 0 };
  let settled = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = Promise.all(release.completions.map(done => done.then(() => { settled += 1; }))).then(() => true);
  const timedOut = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), bound); timer.unref?.(); });
  try { await Promise.race([exited, timedOut]); } finally { if (timer) clearTimeout(timer); }
  return { busy: false, released: release.released, pending: Math.max(0, release.completions.length - settled) };
}

/** Validate a handover wire request (`{version, op:"release", chatId, deadlineMs}`) and answer it with a value. */
export async function answerChatHandoverRequest(raw: unknown): Promise<Record<string, unknown>> {
  const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).sort().join(",") : "";
  const wire = raw as Record<string, unknown>;
  if (keys !== "chatId,deadlineMs,op,version" || wire.version !== CHAT_HANDOVER_VERSION || wire.op !== "release"
    || !idLike(wire.chatId) || typeof wire.deadlineMs !== "number") return { version: CHAT_HANDOVER_VERSION, ok: false, error: "chat_handover_invalid" };
  try {
    const reply = await releaseLocalChatSessions(wire.chatId, wire.deadlineMs);
    return { version: CHAT_HANDOVER_VERSION, ok: true, ...reply };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { version: CHAT_HANDOVER_VERSION, ok: false, error: typeof code === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(code) ? code : "chat_handover_failed" };
  }
}

/** Parse a peer's wire reply into a ChatReleaseReply; anything else is a refusal (the caller falls back). */
export function chatReleaseReplyFromWire(value: unknown): ChatReleaseReply {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || v.version !== CHAT_HANDOVER_VERSION || v.ok !== true || typeof v.busy !== "boolean"
    || !Number.isSafeInteger(v.released) || !Number.isSafeInteger(v.pending)) {
    const code = v && typeof v === "object" && typeof v.error === "string" ? v.error : "chat_handover_reply_invalid";
    throw Object.assign(new Error(code), { code });
  }
  return { busy: v.busy, released: v.released as number, pending: v.pending as number };
}

/* The transport to the other process is registered by whoever holds the authenticated native channel:
 * Main registers the background service as its peer (native-gui-startup), the service registers Main (device bridge). */
const peers = new Map<HandoverHostKind, ChatReleasePeer>();
export function registerChatHandoverPeer(kind: HandoverHostKind, peer: ChatReleasePeer): () => void {
  peers.set(kind, peer);
  return () => { if (peers.get(kind) === peer) peers.delete(kind); };
}
export function __resetChatHandoverPeersForTests(): void { peers.clear(); }

export interface ChatHandoverInput {
  chatId: string;
  runId: string;
  /** This process's kind. */
  localKind: HandoverHostKind;
  /** The chat's previous run owner row (not this run), or null for a first run. */
  previous: { ownerKind: HandoverHostKind } | null;
  /** Machine-readable measurement line, recorded as a run event by the caller. */
  record(line: string, fields: { from: HandoverHostKind; released: number; pending: number; outcome: "released" | "unreachable" }): void;
  deadlineMs?: number;
}

/** The new host's half. Resolves when the turn may start; rejects only with invocation_chat_busy_other_host. */
export async function ensureChatHostHandover(input: ChatHandoverInput): Promise<void> {
  const from = input.previous?.ownerKind;
  if (!from || from === input.localKind || (from !== "desktop" && from !== "daemon") || (input.localKind !== "desktop" && input.localKind !== "daemon")) return;
  const deadlineMs = input.deadlineMs ?? CHAT_HANDOVER_DEFAULT_DEADLINE_MS;
  const peer = peers.get(from);
  let reply: ChatReleaseReply;
  try {
    if (!peer) throw Object.assign(new Error("chat_handover_peer_unavailable"), { code: "chat_handover_peer_unavailable" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The peer enforces the same bound; this one only catches a peer that never answers.
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("chat_handover_timeout"), { code: "chat_handover_timeout" })), deadlineMs + 2000);
      timer.unref?.();
    });
    try { reply = await Promise.race([peer(input.chatId, deadlineMs), guard]); } finally { if (timer) clearTimeout(timer); }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    input.record(`[runtime-session] handover from=${from} unreachable code=${typeof code === "string" ? code : "unknown"}`,
      { from, released: 0, pending: 0, outcome: "unreachable" });
    return;
  }
  if (reply.busy) throw Object.assign(new Error(CHAT_BUSY_OTHER_HOST_CODE), { code: CHAT_BUSY_OTHER_HOST_CODE });
  input.record(`[runtime-session] handover from=${from} released=${reply.released}${reply.pending ? ` pending=${reply.pending}` : ""}`,
    { from, released: reply.released, pending: reply.pending, outcome: "released" });
}
