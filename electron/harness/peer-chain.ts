import { createHash } from "node:crypto";

/*
 * The chain a message between conversations belongs to (Agentlas 2.0 N6, decision; docs/Agentlas2.0/audit/39 section 11).
 *
 * A chain is what one owner turn (or one Goal wake) set going: the first message it sent to another conversation, the turn that message
 * opened, the message that turn sent on. It has an id (`chain:<run id of the turn that sent the first message>`, a plain string), and
 * that id rides in the request of every turn the chain opens (`request.peerChain`, a field of request_json and of the run's start event:
 * no column). There is NO count of hops or pairs; what keeps a chain from piling up or running for ever without a person:
 *   - the owner's Stop in ANY conversation of the chain stops all of it (stopPeerChain, one unconditional pass, then it reads what is left);
 *   - the same words sent again, in the same chain, to the same conversation are not delivered (the sender is told, `repeated`);
 *   - a conversation holds at most one waiting bundle of messages (invocation-steers: later ones join it), so turns running at once never
 *     exceed the conversations of the project and the speed is the run slots'.
 * The state of a chain is ONE row of `meta` (key `peer-chain:<id>`, no new table or column), written by whichever process delivers or
 * starts a turn (Main or the background service, one immediate transaction each) and read by the other. It is deleted by sweepPeerChains
 * (a chain silent for a week, at app start) and with a conversation that is deleted (forgetChatInPeerChains). Bounds: 256 conversations
 * and 256 remembered bodies per chain, a live-run list that is the turns running right now.
 */

export const PEER_CHAIN_KEY_PREFIX = "peer-chain:";
export const PEER_CHAIN_MAX_CHATS = 256;
export const PEER_CHAIN_MAX_SENT = 256;
export const PEER_CHAIN_SILENT_MS = 7 * 24 * 60 * 60_000;

/** The marker a request carries when a message from another conversation opened it. Main-only: a window never sends it (ipc.ts strips it). */
export interface PeerChainMark { id: string; /** The sending conversation. */ from: string; /** Intent ids of the messages that joined a waiting bundle (a retried delivery is not added twice). */ intents?: string[];
  /** Waiting bundle only: other chains of the same sender whose message joined it (a Stop of any of them reaches the bundle). */ joined?: string[];
  /** Waiting bundle only: hashes of the messages it already holds (the same words again are `repeated`, whatever chain they come in). */ bodies?: string[] }
export type PeerChainRequestFields = { peerChain?: PeerChainMark };
export function peerChainOfRequest(request: object | null | undefined): PeerChainMark | null {
  const mark = (request as PeerChainRequestFields | null | undefined)?.peerChain;
  return mark && typeof mark === "object" && typeof mark.id === "string" && mark.id.startsWith("chain:") && typeof mark.from === "string" ? mark : null;
}

export const peerChainIdForRun = (runId: string): string => `chain:${runId}`;

export interface PeerChainDb {
  prepare(sql: string): { run(...args: any[]): unknown; get(...args: any[]): unknown; all(...args: any[]): unknown[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  transaction?: (fn: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
type Db = PeerChainDb;

export interface PeerChainRow {
  at: number;
  /** The turn that sent the first message (its own Stop ends the chain; it carries no request marker). */
  origin: { runId: string; chatId: string };
  stop?: true;
  /** Conversations that sent or received in this chain, in order of first appearance. */
  chats: string[];
  /** Hashes of (receiver, normalized body) already delivered: the repeat rule. A ring. */
  sent: string[];
  /** Turns of this chain running now: run id -> conversation. Added when such a turn starts, removed when it ends. */
  live: Record<string, string>;
}

const key = (id: string): string => PEER_CHAIN_KEY_PREFIX + id;

function read(db: Db, id: string): PeerChainRow | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key(id)) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<PeerChainRow> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      at: Number(parsed.at) || 0,
      origin: parsed.origin && typeof parsed.origin.runId === "string" ? parsed.origin : { runId: "", chatId: "" },
      ...(parsed.stop === true ? { stop: true as const } : {}),
      chats: Array.isArray(parsed.chats) ? parsed.chats.filter((x): x is string => typeof x === "string") : [],
      sent: Array.isArray(parsed.sent) ? parsed.sent.filter((x): x is string => typeof x === "string") : [],
      live: parsed.live && typeof parsed.live === "object" && !Array.isArray(parsed.live) ? Object.fromEntries(Object.entries(parsed.live).filter((e): e is [string, string] => typeof e[1] === "string")) : {},
    };
  } catch { return null; }
}
const write = (db: Db, id: string, row: PeerChainRow): void => { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(key(id), JSON.stringify(row)); };

/** Read-modify-write as one immediate transaction (two processes may deliver in the same moment). */
function update<T>(db: Db, work: () => T): T {
  if (typeof db.transaction === "function") {
    const wrapped = db.transaction(work) as { immediate?: () => T } & (() => T);
    return typeof wrapped.immediate === "function" ? wrapped.immediate() : wrapped();
  }
  return work();
}

/** Same words, whatever the spacing or case: the repeat rule's measure of "the same". */
export const normalizePeerBody = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const bodyHash = (toChatId: string, text: string): string => createHash("sha256").update(`${toChatId}\u0000${normalizePeerBody(text)}`).digest("hex").slice(0, 16);

export type PeerDeliveryVerdict = "delivered" | "repeated" | "stopped" | "too_wide";

/**
 * The one admission of a message into a chain: creates the chain (its origin is the sending turn) when the sender's turn did not come from
 * one, refuses a stopped chain, refuses the same words to the same conversation again, and otherwise remembers the delivery. Never throws
 * for a store that cannot answer: the caller decides (deliver.ts treats it as `unavailable` and says so, nothing is sent blind).
 */
export function admitPeerDelivery(db: Db, input: { chainId: string; origin: { runId: string; chatId: string }; fromChatId: string; toChatId: string; text: string; now?: number;
  /** false: only look (the verdict a delivery would get), write nothing - asked before the approval card so a repeat never raises one. */
  commit?: boolean }): PeerDeliveryVerdict {
  const now = input.now ?? Date.now();
  return update(db, () => {
    const row = read(db, input.chainId) ?? { at: now, origin: input.origin, chats: [], sent: [], live: {} };
    if (row.stop) return "stopped";
    const hash = bodyHash(input.toChatId, input.text);
    if (row.sent.includes(hash)) return "repeated";
    for (const chat of [input.fromChatId, input.toChatId]) {
      if (row.chats.includes(chat)) continue;
      if (row.chats.length >= PEER_CHAIN_MAX_CHATS) return "too_wide";
      if (input.commit !== false) row.chats.push(chat);
    }
    if (input.commit === false) return "delivered";
    row.sent.push(hash);
    if (row.sent.length > PEER_CHAIN_MAX_SENT) row.sent.splice(0, row.sent.length - PEER_CHAIN_MAX_SENT);
    row.at = now;
    write(db, input.chainId, row);
    return "delivered";
  });
}

export const peerChainStopped = (db: Db, id: string): boolean => { try { return read(db, id)?.stop === true; } catch { return false; } };

/** A turn of the chain started / ended: the list a Stop reaches turns of other processes through. No row = nothing to record. */
export function notePeerChainRun(db: Db, id: string, runId: string, chatId: string, running: boolean): void {
  try {
    update(db, () => {
      const row = read(db, id);
      if (!row) return;
      if (running) { row.live[runId] = chatId; if (!row.chats.includes(chatId) && row.chats.length < PEER_CHAIN_MAX_CHATS) row.chats.push(chatId); }
      else if (row.live[runId] === undefined) return;
      else delete row.live[runId];
      write(db, id, row);
    });
  } catch { /* the run goes on; at worst a Stop finds one turn less to reach and the chain's marker still refuses what comes next */ }
}

export interface PeerChainStopTargets { origin: { runId: string; chatId: string }; live: Array<{ runId: string; chatId: string }>; chats: string[] }

/**
 * The Stop, first step and unconditional: the chain is marked stopped (every later delivery and every queued turn of it is refused) and
 * the turns to cancel are returned. It depends on nothing else: no holder, no lease, no run being alive. A chain that has no row (the
 * owner stopped a turn that never sent a message) returns null and costs nothing.
 */
export function markPeerChainStopped(db: Db, id: string, now: number = Date.now()): PeerChainStopTargets | null {
  const apply = (): PeerChainStopTargets | null => {
    const row = read(db, id);
    if (!row) return null;
    row.stop = true; row.at = now;
    write(db, id, row);
    return { origin: row.origin, live: Object.entries(row.live).map(([runId, chatId]) => ({ runId, chatId })), chats: [...row.chats] };
  };
  // A Stop does not wait for a lock: if the immediate transaction is refused (a busy store, a transaction already open on this connection) the same
  // read and single-statement write are made once more without it.
  try { return update(db, apply); } catch { /* once more, below */ }
  try { return apply(); } catch { return null; }
}

/** The chains that name this run as their origin turn: the chain id is derived from the run id, so it is one keyed read. */
export const peerChainRowExists = (db: Db, id: string): boolean => { try { return read(db, id) !== null; } catch { return false; } };

/** A conversation is gone: it leaves every chain's list (a chain with nothing left is deleted). Bounded by the number of chains, which sweepPeerChains keeps small. */
export function forgetChatInPeerChains(db: Db, chatId: string): number {
  let changed = 0;
  try {
    const rows = db.prepare("SELECT key AS k, value FROM meta WHERE key LIKE ?").all(`${PEER_CHAIN_KEY_PREFIX}%`) as Array<{ k: string; value: string }>;
    for (const row of rows) {
      if (!row.value.includes(chatId)) continue;
      const id = row.k.slice(PEER_CHAIN_KEY_PREFIX.length);
      update(db, () => {
        const current = read(db, id);
        if (!current) return;
        current.chats = current.chats.filter((c) => c !== chatId);
        for (const [runId, chat] of Object.entries(current.live)) if (chat === chatId) delete current.live[runId];
        if (current.chats.length === 0) db.prepare("DELETE FROM meta WHERE key = ?").run(key(id)); else write(db, id, current);
        changed += 1;
      });
    }
  } catch { /* the sweep deletes what a failed pass leaves */ }
  return changed;
}

/** App start: chains silent for a week go (their turns are long over). Returns how many rows went. */
export function sweepPeerChains(db: Db, now: number = Date.now(), silentMs: number = PEER_CHAIN_SILENT_MS): number {
  let removed = 0;
  try {
    const rows = db.prepare("SELECT key AS k, value FROM meta WHERE key LIKE ?").all(`${PEER_CHAIN_KEY_PREFIX}%`) as Array<{ k: string; value: string }>;
    for (const row of rows) {
      let at = 0;
      try { at = Number((JSON.parse(row.value) as { at?: unknown })?.at) || 0; } catch { at = 0; }
      if (now - at > silentMs) { db.prepare("DELETE FROM meta WHERE key = ? AND value = ?").run(row.k, row.value); removed += 1; }
    }
  } catch { /* nothing to sweep without the table */ }
  return removed;
}

/** The chain a RUNNING turn belongs to because a message of it opened the turn (its run is in the chain's live list); null for any other turn. */
export function peerChainOfLiveRun(db: Db, runId: string): PeerChainMark | null {
  try {
    const rows = db.prepare("SELECT key AS k FROM meta WHERE key LIKE ? AND instr(value, ?) > 0").all(`${PEER_CHAIN_KEY_PREFIX}%`, `"${runId}"`) as Array<{ k: string }>;
    for (const row of rows) {
      const id = row.k.slice(PEER_CHAIN_KEY_PREFIX.length);
      const chain = read(db, id);
      if (chain && chain.live[runId] !== undefined) return { id, from: chain.origin.chatId };
    }
  } catch { /* an unreadable store knows no chain: the message starts its own */ }
  return null;
}
