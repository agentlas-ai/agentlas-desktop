import { isInlineVisualFence } from '../../shared/inline-visual';

/** Display-only cuts of a cumulative reply. Never changes a run or its transcript. */
export interface ChatContinuationAdapter<T> {
  key: (message: T) => string;
  role: (message: T) => "user" | "assistant" | "system";
  text: (message: T) => string;
  active: (message: T) => boolean;
  createdAt?: (message: T) => string | undefined;
  /** Exact run ownership, used to guard a live-to-durable identity handoff. */
  run?: (message: T) => string | undefined;
}

export interface ChatContinuationRow<T> {
  message: T;
  id: string;
  sourceId: string;
  text: string;
  textStart: number;
  markdownText?: string;
  continuation: boolean;
  tail: boolean;
  frozen: boolean;
  createdAt?: string;
}

interface Cut {
  offset: number;
  userKey: string;
  createdAt?: string;
}
interface Reply {
  key: string;
  aliases: Set<string>;
  text: string;
  active: boolean;
  run?: string;
  createdAt?: string;
  initialUser?: string;
  cuts: Cut[];
}
interface Conversation {
  replies: Map<string, Reply>;
  users: Set<string>;
}

/**
 * Remember only boundaries actually observed by this client. A cold history
 * snapshot has no offsets, so it is never retroactively split by timestamps.
 * Retain observations across navigation/reconnect, bounded to 64 conversations
 * and 200 replies per conversation. No storage or bridge schema is involved.
 */
export class ChatContinuationProjector {
  private conversations = new Map<string, Conversation>();

  project<T extends { id: string }>(
    scope: string,
    messages: readonly T[],
    adapter: ChatContinuationAdapter<T>,
  ): ChatContinuationRow<T>[] {
    let conversation = this.conversations.get(scope);
    if (!conversation) conversation = { replies: new Map(), users: new Set() };
    this.conversations.delete(scope);
    this.conversations.set(scope, conversation);
    while (this.conversations.size > 64) this.conversations.delete(this.conversations.keys().next().value!);

    const sourceKeys = messages.map(adapter.key);
    const counts = new Map<string, number>();
    sourceKeys.forEach(key => counts.set(key, (counts.get(key) ?? 0) + 1));
    const keys = sourceKeys.map((key, index) => counts.get(key)! > 1 ? `${key}:source:${messages[index].id}` : key);
    const present = new Set(keys);
    // A room can contain thousands of historical rows. Index once rather than
    // searching the full transcript/reply history for every assistant on each
    // streamed update. Preserve indexOf's first-match behavior for older data.
    const keyIndices = new Map<string, number>();
    keys.forEach((key, index) => { if (!keyIndices.has(key)) keyIndices.set(key, index); });
    const repliesByAlias = new Map<string, Reply>();
    const absentActiveReplies: Reply[] = [];
    for (const reply of new Set(conversation.replies.values())) {
      for (const alias of reply.aliases) if (!repliesByAlias.has(alias)) repliesByAlias.set(alias, reply);
      if (reply.active && reply.cuts.length > 0 && reply.text.length > 0
        && ![...reply.aliases].some(alias => present.has(alias))
        && reply.cuts.some(cut => present.has(cut.userKey))) absentActiveReplies.push(reply);
    }
    const users = messages.flatMap((message, index) => adapter.role(message) === "user"
      ? [{ key: keys[index], index, createdAt: adapter.createdAt?.(message) }] : []);
    const newlyVisibleUsers = users.filter(user => !conversation!.users.has(user.key));
    const latestUser = users.at(-1);
    const latestNewUser = newlyVisibleUsers.at(-1);
    let precedingUser = -1;
    const at = new Map<string, ChatContinuationRow<T>[]>();
    const before = new Map<string, ChatContinuationRow<T>[]>();
    const after = new Map<string, ChatContinuationRow<T>[]>();
    const insert = (into: Map<string, ChatContinuationRow<T>[]>, key: string, row: ChatContinuationRow<T>) => {
      const rows = into.get(key) ?? [];
      rows.push(row);
      into.set(key, rows);
    };

    messages.forEach((message, index) => {
      while (precedingUser + 1 < users.length && users[precedingUser + 1].index < index) precedingUser++;
      const key = keys[index];
      const text = adapter.text(message);
      const createdAt = adapter.createdAt?.(message);
      const plain: ChatContinuationRow<T> = { message, id: message.id, sourceId: message.id, text,
        textStart: 0, continuation: false, tail: true, frozen: false, createdAt };
      if (adapter.role(message) !== "assistant") {
        insert(at, key, plain);
        return;
      }
      let reply = conversation!.replies.get(key);
      if (!reply) reply = repliesByAlias.get(key);
      if (!reply) {
        // A live row can be renamed by its durable receipt. Bind only a unique
        // absent source with exact observed text and a surviving cut.
        const candidates = absentActiveReplies.filter(candidate => text === candidate.text
          && ![...candidate.aliases].some(alias => present.has(alias))
          && (!adapter.run?.(message) || !candidate.run || adapter.run(message) === candidate.run));
        if (candidates.length === 1) reply = candidates[0];
      }
      const active = adapter.active(message);
      if (!reply) {
        reply = { key, aliases: new Set([key]), text, active, createdAt, run: adapter.run?.(message),
          initialUser: users[precedingUser]?.key, cuts: [] };
        // On attaching to an already-running room, freeze what is visible now;
        // only subsequent output goes after its latest follow-up.
        const later = active && latestUser && latestUser.index > index ? latestUser : undefined;
        if (later) reply.cuts.push({ offset: text.length, userKey: later.key, createdAt: later.createdAt });
      } else {
        if (!text.startsWith(reply.text)) {
          // Final rewrites/reset snapshots have no provable offset mapping.
          // Keep the complete replacement below the latest observed follow-up,
          // including clients whose durable answer stays beside its first user.
          const anchor = reply.cuts.at(-1) ?? ((reply.active || active)
            && latestUser && latestUser.index > index ? latestUser : undefined);
          reply.cuts = anchor ? [{ offset: 0, userKey: "userKey" in anchor ? anchor.userKey : anchor.key,
            createdAt: anchor.createdAt }] : [];
        } else if (reply.active || active) {
          const initialIndex = reply.initialUser ? keyIndices.get(reply.initialUser) ?? -1 : -1;
          const lastCutIndex = reply.cuts.length ? keyIndices.get(reply.cuts.at(-1)!.userKey) ?? -1 : -1;
          const boundary = latestNewUser && latestNewUser.index > Math.max(initialIndex, lastCutIndex)
            && (latestNewUser.index > index || initialIndex >= 0 || lastCutIndex >= 0) ? latestNewUser : undefined;
          if (boundary) {
            const cut = { offset: reply.text.length, userKey: boundary.key, createdAt: boundary.createdAt };
            if (reply.cuts.at(-1)?.offset === cut.offset) reply.cuts[reply.cuts.length - 1] = cut;
            else reply.cuts.push(cut);
          }
        }
        reply.text = text;
        reply.active = active;
        reply.aliases.add(key);
      }
      conversation!.replies.set(reply.key, reply);
      for (const alias of reply.aliases) if (!repliesByAlias.has(alias)) repliesByAlias.set(alias, reply);
      // Only apply boundaries whose user remains in the canonical snapshot.
      // Missing anchors (pagination/history replacement) must not hide text.
      const cuts = reply.cuts.filter(cut => present.has(cut.userKey) && cut.offset <= text.length);
      if (!cuts.length) {
        insert(at, key, plain);
        return;
      }
      const rows: ChatContinuationRow<T>[] = [];
      for (let part = 0; part <= cuts.length; part++) {
        const start = part === 0 ? 0 : cuts[part - 1].offset;
        const end = part < cuts.length ? cuts[part].offset : text.length;
        const segment = text.slice(start, end);
        if (!segment.trim()) continue;
        rows.push({ message, sourceId: message.id, id: part === 0 ? message.id
          : `chat-continuation:${reply.key}:${cuts[part - 1].userKey}`,
          text: segment, textStart: start, continuation: part > 0, tail: part === cuts.length,
          frozen: part < cuts.length, createdAt: part === 0 ? reply.createdAt : cuts[part - 1].createdAt });
      }
      if (!rows.length) {
        // One real working row is useful; never create one empty reply per user.
        insert(after, cuts.at(-1)!.userKey, { ...plain, continuation: true, createdAt: cuts.at(-1)!.createdAt });
        return;
      }
      if (!rows.at(-1)!.tail) {
        if (active) rows.push({ ...plain, id: `chat-continuation:${reply.key}:${cuts.at(-1)!.userKey}`,
          text: "", textStart: text.length, continuation: true, createdAt: cuts.at(-1)!.createdAt });
        else rows[rows.length - 1].tail = true;
      }
      const ranges = fenceRanges(text);
      for (const row of rows) {
        row.markdownText = renderMarkdownRange(text, row.textStart, row.textStart + row.text.length, ranges);
        if (!row.continuation) {
          const firstUser = cuts[0].userKey;
          if ((keyIndices.get(firstUser) ?? -1) < index) insert(before, firstUser, row);
          else insert(at, key, row);
        } else {
          const cut = cuts.find(candidate => `chat-continuation:${reply!.key}:${candidate.userKey}` === row.id)!;
          insert(after, cut.userKey, row);
        }
      }
    });
    conversation.users = new Set(users.map(user => user.key));
    while (conversation.replies.size > 200) conversation.replies.delete(conversation.replies.keys().next().value!);
    return keys.flatMap(key => [...(before.get(key) ?? []), ...(at.get(key) ?? []), ...(after.get(key) ?? [])]);
  }
}

interface FenceRange {
  start: number;
  bodyStart: number;
  closeStart: number;
  end: number;
  marker: string;
  info: string;
  complete: boolean;
}
function fenceRanges(text: string): FenceRange[] {
  const ranges: FenceRange[] = [];
  let opened: Omit<FenceRange, "closeStart" | "end" | "complete"> | undefined;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, newline < 0 ? text.length : newline).replace(/\r$/, "");
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && !opened) opened = { start, bodyStart: end, marker: fence[1], info: fence[2].trim() };
    else if (fence && opened && fence[1][0] === opened.marker[0]
      && fence[1].length >= opened.marker.length && !fence[2].trim()) {
      ranges.push({ ...opened, closeStart: start, end, complete: true });
      opened = undefined;
    }
    start = end;
  }
  if (opened) ranges.push({ ...opened, closeStart: text.length, end: text.length, complete: false });
  return ranges;
}
const isVisualFence = isInlineVisualFence;

/** Balance ordinary code for display only; never complete partial interactive UI. */
export function renderChatContinuationMarkdown(source: string, start: number, end: number): string {
  return renderMarkdownRange(source, start, end, fenceRanges(source));
}
function renderMarkdownRange(source: string, start: number, end: number, ranges: readonly FenceRange[]): string {
  let cursor = start;
  let result = "";
  for (const fence of ranges.filter(fence => isVisualFence(fence.info) && fence.end > start && fence.start < end)) {
    result += source.slice(cursor, Math.max(cursor, fence.start));
    // A visual belongs where its opening marker was first visible. Let that
    // one widget read the genuine canonical fence (including pending input),
    // while later prose segments omit its interior. Never synthesize a visual
    // closer or relocate a widget with unsent local input when a user speaks.
    if (fence.start >= start) result += source.slice(fence.start, fence.end);
    cursor = Math.min(end, fence.end);
  }
  result += source.slice(cursor, end);
  const code = ranges.filter(fence => !isVisualFence(fence.info));
  const head = code.find(fence => start > fence.start && start < fence.end);
  if (head) {
    if (head.complete && start >= head.closeStart) result = result.slice(head.end - start);
    else {
      // A cut through the opener is not code content. Restore its full grammar.
      if (start < head.bodyStart) result = result.slice(head.bodyStart - start);
      result = `${head.marker}${head.info}\n${result}`;
    }
  }
  const tail = code.find(fence => end > fence.start && end < fence.end);
  if (tail) {
    if (end < tail.bodyStart) result = source.slice(start, tail.start);
    else if (end > tail.closeStart) result = result.slice(0, -(end - tail.closeStart));
    if (end >= tail.bodyStart) result += `\n${tail.marker}`;
  }
  return result;
}
