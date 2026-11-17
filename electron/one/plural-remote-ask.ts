/**
 * The seam between the host gate (runtime/host-tool-permission-policy.ts, runtime/tool-approval.ts) and the hand-off row.
 *
 *   `remoteAskOfChat(chatId)`  a Work started from a hand-off row says so in its own request payload (`remoteAsk`, written by startWork). The gate asks by the Work's chat, so every runner of every host
 *                              (subscription CLIs, ACP, own key, serving, local models; Desktop Main and the background service) sees the same value without a field on each runner's request.
 *   `PluralRowAsker`           what the process that talks to the server offers the gate: put one question up to the row, take the row's first answer for a local click, close a question the row must not keep.
 *                              The asker is registered by plural-work-real.ts in the process that hosts the Work queue; a process with no asker refuses a remote question (nobody can be asked) instead of holding it.
 * Nothing here keeps a table: the payload of the Work request is the only record, and the cache below is a bounded copy of it.
 */
import type { AskAnswer, CloseWhy, PluralQuestion, RemoteAsk } from "./plural-handoff-wire";

const ROW_ID = /^h_[a-f0-9]{64}$/;
const COMMAND_PREFIX = "plural_";

export const REMOTE_ASK_LIMITS = Object.freeze({ nameChars: 80, fromChars: 128, cache: 64 });

/** The `remoteAsk` value of a startWork input, or null when it is absent / not exactly this shape. A bad value is refused by the caller (never half-applied). */
export function parseRemoteAsk(value: unknown): RemoteAsk | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.some((k) => !["rowId", "askVia", "from", "fromName"].includes(k))) return null;
  if (typeof v.rowId !== "string" || !ROW_ID.test(v.rowId)) return null;
  if (v.askVia !== "row" && v.askVia !== "local") return null;
  if (typeof v.from !== "string" || !v.from || v.from.length > REMOTE_ASK_LIMITS.fromChars) return null;
  if (typeof v.fromName !== "string" || v.fromName.length > REMOTE_ASK_LIMITS.nameChars) return null;
  return { rowId: v.rowId, askVia: v.askVia, from: v.from, fromName: v.fromName };
}

export interface PluralRowAsker {
  /** Put one question up to the row. `asked` = a card may be shown and the answer comes later; `allowed` = the row's taskAllow already covers this kind (no card, run); `refused` = the row is over (ended / gone / not reachable as the owner's): deny, show nothing. */
  ask(remote: RemoteAsk, q: PluralQuestion): Promise<"asked" | "allowed" | "refused">;
  /** A local click: the row is told FIRST. The answer that comes back is the row's first answer (this one, or an earlier one from another screen). null = the row could not be reached after the retries. */
  answer(remote: RemoteAsk, qid: string, answer: AskAnswer): Promise<AskAnswer | null>;
  /** The question ended without a person's answer (or was answered here after the row could not be reached): the card on the other screens reads "확인 요청 취소". Fire and forget; a lost call is repeated by the receiver. */
  close(remote: RemoteAsk, qid: string, why: CloseWhy, answer?: AskAnswer): void;
}

let asker: PluralRowAsker | null = null;
export function setPluralRowAsker(next: PluralRowAsker | null): void { asker = next; }
export function pluralRowAsker(): PluralRowAsker | null { return asker; }

const cache = new Map<string, RemoteAsk>();
/** Test hook. */
export function __resetRemoteAskCacheForTest(): void { cache.clear(); }

interface DbLike { prepare(sql: string): { get(...args: unknown[]): unknown } }
type DbSource = () => DbLike;
let dbSource: DbSource | null = null;
/** The store's database, read lazily so this module loads in any process (a gate's fake store may be set). */
export function setRemoteAskDbSource(source: DbSource | null): void { dbSource = source; cache.clear(); }
function db(): DbLike {
  if (dbSource) return dbSource();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("../store/db") as { getDb(): DbLike }).getDb();
}

/** The `remoteAsk` of the Work that runs in this chat (null for any other chat). Positive answers are cached (64); a chat is never cached as "no", because the Work's request is written before its chat runs but a lookup before that must not stick. */
export function remoteAskOfChat(chatId: string | undefined): RemoteAsk | null {
  if (typeof chatId !== "string" || !chatId) return null;
  const hit = cache.get(chatId);
  if (hit) { cache.delete(chatId); cache.set(chatId, hit); return hit; }
  try {
    const d = db();
    const job = d.prepare("SELECT command_id FROM one_supervisor_work_jobs WHERE chat_id=?").get(chatId) as { command_id?: string } | undefined;
    if (!job?.command_id || !job.command_id.startsWith(COMMAND_PREFIX)) return null;
    const row = d.prepare("SELECT payload_json FROM one_supervisor_requests WHERE command_id=?").get(job.command_id) as { payload_json?: string } | undefined;
    if (!row?.payload_json) return null;
    const remote = parseRemoteAsk((JSON.parse(row.payload_json) as { remoteAsk?: unknown }).remoteAsk);
    if (!remote || job.command_id !== `${COMMAND_PREFIX}${remote.rowId}`) return null;   // the command id and the row it came from are one fact
    cache.set(chatId, remote);
    while (cache.size > REMOTE_ASK_LIMITS.cache) cache.delete(cache.keys().next().value as string);
    return remote;
  } catch { return null; }
}

/**
 * Does a run of this request need its shell's delete gate although it is not a write run? A full-access run of a Work handed over by a row (askVia "row") has nobody at this desktop who gave that access:
 * its shell deletes are asked on the row like every other delete. Write runs already have the gate.
 */
export function remoteRowShellGateWanted(req: { permission?: string; chatId?: string; approvalChatId?: string; browserOnly?: boolean; untrustedNoTools?: boolean }): boolean {
  return req.permission === "full" && !req.browserOnly && !req.untrustedNoTools && remoteAskOfChat(req.approvalChatId ?? req.chatId)?.askVia === "row";
}

/** The `remoteAsk` of a startWork input: absent = undefined, malformed = the caller's refusal (never half applied). */
export function remoteAskInput(value: unknown, refuse: () => Error): RemoteAsk | undefined {
  if (value === undefined) return undefined;
  const parsed = parseRemoteAsk(value);
  if (!parsed) throw refuse();
  return parsed;
}
