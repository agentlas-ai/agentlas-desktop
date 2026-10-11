/**
 * Room discussion engine — pure core (A4 of the 1.3.0 single-execution-host architecture).
 *
 * No electron import, no SQLite import, no model import: every effect is a port, so the same code runs in Main
 * today and in the daemon when A1/A2 move ownership there, and the gates drive it with fakes.
 *
 * Model (ARCHITECTURE.md principles 2-7, OSS-RESEARCH.md patterns 5-7):
 *  - The owner posts in a group room. A moderator picks K speakers (default 2, max 3) by rules first
 *    (@mentions, names in the text, members not yet heard on this topic, never the last speaker again) and asks a
 *    chooser only when the rules leave a real tie and a chooser was configured (default: none, no model call).
 *  - The K speakers run in parallel, each in its own (member, room) child session, and all see the same snapshot:
 *    room posts up to the round's starting seq. A speaker's prompt carries only the posts since that member's
 *    cursor (the long-lived model thread already holds the rest).
 *  - When every speaker has settled, the finished messages are appended to the room log in order. Only completed
 *    messages are stored; streamed deltas never are.
 *  - A next round starts by itself only when a speaker addressed another member or asked a question. It stops at
 *    max rounds, a round without new content, the budget, a cap refusal with nobody running, or the owner's stop.
 *  - An owner post during a discussion is written to the log and a durable inbox at once. It is never dropped: the
 *    running round finishes (or is cancelled when the owner asked to interrupt) and the post then opens a fresh
 *    discussion. Nothing in this module answers the owner by starting a second concurrent discussion.
 *  - Caps return machine-readable codes. Nothing waits silently.
 */

// ── Defaults ────────────────────────────────────────────────────────────────

export const ROOM_DISCUSSION_DEFAULTS = {
  speakersPerRound: 2,
  maxSpeakersPerRound: 3,
  /**
   * Hidden safety cap on internal exchange batches, against runaway cost. It is never shown to the owner and hitting
   * it ends the conversation silently. A conversation normally ends sooner: nobody has anything new to add.
   */
  maxRounds: 40,
  /** Hidden cost cap per owner post, in units. A full message costs 2, a comment 1. Reaching it ends the talk silently. */
  budgetUnits: 80,
  messageCost: 2,
  commentCost: 1,
  /** Rooms where one member may speak at the same time across all rooms. */
  perMemberConcurrency: 2,
  commentMaxChars: 400,
  commentMaxSentences: 2,
  /** Posts shown to a member that has no cursor yet. */
  firstTurnWindow: 12,
  maxPromptPosts: 40,
  maxPostChars: 1_200,
  maxPromptChars: 8_000,
} as const;

export type StopReason =
  | "max_rounds"
  | "no_new_content"
  | "budget"
  | "owner_stop"
  | "settled"
  | "no_candidates"
  | "cap_refused"
  | "owner_replaced"
  | "interrupted_by_restart"
  | "failed";

export type DiscussionStatus = "running" | "completed" | "stopped" | "interrupted" | "failed";
export type TurnStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "refused";
export type TurnMode = "message" | "comment";
export type SelectionReason = "mentioned" | "named" | "addressed" | "unheard" | "rotation";

// ── Value types ─────────────────────────────────────────────────────────────

export interface RoomMember {
  agentId: string;
  name: string;
  aliases?: readonly string[];
}

export interface RoomPost {
  seq: number;
  messageId: string;
  author: "owner" | "member" | "system";
  speakerAgentId?: string | null;
  speakerName?: string | null;
  text: string;
  replyTo?: string | null;
  kind: "post" | "comment";
}

export interface SpeakerPlan {
  agentId: string;
  name: string;
  reason: SelectionReason;
  mode: TurnMode;
  /** Message id this turn answers (or comments on). */
  replyTo: string | null;
}

export interface DiscussionLimits {
  speakersPerRound: number;
  maxSpeakersPerRound: number;
  maxRounds: number;
  budgetUnits: number;
}

// ── Text rules ──────────────────────────────────────────────────────────────

function norm(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const LETTER = /[\p{L}\p{N}_]/u;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;

function isBoundaryBefore(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = Array.from(text.slice(Math.max(0, index - 2), index)).pop() ?? "";
  return !LETTER.test(previous);
}

function isBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const next = Array.from(text.slice(index, index + 2))[0] ?? "";
  return !LETTER.test(next);
}

function namesOf(member: RoomMember): string[] {
  const set = new Set<string>();
  for (const raw of [member.name, ...(member.aliases ?? [])]) {
    const name = norm(raw ?? "");
    if (name.length >= 2) set.add(name);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

export interface FoundMember { member: RoomMember; via: "mention" | "name"; index: number }

/** Members addressed in `text`, in order of first appearance. `@name` is a mention; a bare name is "named". */
export function findAddressedMembers(text: string, members: readonly RoomMember[]): FoundMember[] {
  const haystack = norm(text);
  const found = new Map<string, FoundMember>();
  for (const member of members) {
    for (const name of namesOf(member)) {
      let from = 0;
      for (;;) {
        const index = haystack.indexOf(name, from);
        if (index < 0) break;
        from = index + name.length;
        const mention = haystack[index - 1] === "@" && isBoundaryBefore(haystack, index - 1);
        const hangul = HANGUL.test(name);
        // ASCII names need a word edge on both sides; Hangul names take particles ("카이는"), so only the left edge counts.
        const edgeOk = mention
          ? (hangul || isBoundaryAfter(haystack, index + name.length))
          : isBoundaryBefore(haystack, index) && (hangul || isBoundaryAfter(haystack, index + name.length));
        if (!edgeOk) continue;
        const entry: FoundMember = { member, via: mention ? "mention" : "name", index: mention ? index - 1 : index };
        const existing = found.get(member.agentId);
        if (!existing || (entry.via === "mention" && existing.via !== "mention") || (entry.via === existing.via && entry.index < existing.index)) {
          found.set(member.agentId, entry);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.via === b.via ? a.index - b.index : a.via === "mention" ? -1 : 1));
}

const QUESTION_END = /(?:나요|까요|가요|니까|인가|할까|을까|ㄹ까|어때|어떨까|어떻게 생각)\s*[.!~]*\s*$/mu;

/** A real question: a question mark, or a Korean sentence that ends as a question. */
export function asksQuestion(text: string): boolean {
  const body = stripMarkers(text);
  return /[?？]/.test(body) || QUESTION_END.test(body);
}

/**
 * Owner work, not talk: a task, brief, plan or recurring instruction. Such a post always goes to One (orchestrator,
 * Goal intake, strategy, tactics, targets, team dispatch) and is never swallowed by the room conversation.
 * Errs toward One: a wrongly routed chat question still gets an answer, a wrongly routed brief loses its Goal.
 */
const WORK_VERB_KO = /((?<!(?:말|생각|얘기|이야기|토론|논의|비교|설명))해\s?(?:줘|주세요|줄래)|하세요|해라|해야|하자|할 것|하도록|진행|업로드|운영|매일|매주|매월|매번|주기|자동|알아서|작성|생성|구축|구성|만들|만드|제작|개발|수정|고쳐|분석해|조사해|찾아서|키워|세워|짜\s?줘|정리해|보고해|예약|배포|발행|올려|실행|돌려|설정|등록|적용)/u;
const WORK_VERB_EN = /\b(create|build|make\s+(a|an|the|me|us)|write|upload|publish|schedule|every\s+(day|week|month)|daily|weekly|monthly|set\s?up|generate|deploy|implement|develop|automate|produce|draft|start\s+(a|an|the|making|doing))\b/i;
export const WORK_POST_MAX_CHARS = 280;
export const WORK_POST_MAX_LINES = 3;

export function isOwnerWork(text: string): boolean {
  const body = text.trim();
  if (!body) return false;
  if (body.length > WORK_POST_MAX_CHARS) return true;
  if (body.split(/\r?\n/).filter((line) => line.trim()).length > WORK_POST_MAX_LINES) return true;
  return WORK_VERB_KO.test(body) || WORK_VERB_EN.test(body);
}

/** Does the post read like an invitation to talk rather than a command for work? Used only to route; work always wins. */
export function invitesDiscussion(text: string, members: readonly RoomMember[] = []): boolean {
  const body = text.trim();
  if (!body || body.startsWith("/")) return false;
  if (isOwnerWork(body)) return false;
  if (findAddressedMembers(body, members).length > 0) return true;
  if (asksQuestion(body)) return true;
  return /(토론|의견|생각|논의|각자|다같이|다 같이|함께 이야기|어때|찬성|반대|비교|장단점|브레인스토|discuss|debate|thoughts|opinion|what do you think|brainstorm|pros and cons)/iu.test(body);
}

// ── Markers the speaker may leave in its answer ─────────────────────────────

const MARKER = /^\s*\[\[(reply|comment):#(\d{1,9})\]\]\s*/iu;
const PASS = /^\s*\[\[pass\]\]\s*$/iu;

export function stripMarkers(text: string): string {
  return text.replace(/\[\[(?:reply|comment):#\d{1,9}\]\]\s*/giu, "").replace(/\[\[pass\]\]/giu, "").trim();
}

export type ParsedSpeakerOutput =
  | { kind: "pass" }
  | { kind: "empty" }
  | { kind: TurnMode; text: string; replyTo: string | null };

function clipToSentences(text: string, maxSentences: number, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?。！？]+[.!?。！？]+["')\]]*|[^.!?。！？]+$/gu) ?? [flat];
  let out = sentences.slice(0, maxSentences).map((sentence) => sentence.trim()).join(" ").trim();
  if (out.length > maxChars) out = `${out.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return out;
}

/**
 * Reads a finished speaker answer. `[[pass]]` means nothing to add. A leading `[[reply:#n]]` / `[[comment:#n]]`
 * names the earlier post being answered; it counts only when #n is a post the speaker could see (<= snapshot).
 * A comment is clipped to the cheap shape (two sentences).
 */
export function parseSpeakerOutput(
  raw: string | null | undefined,
  mode: TurnMode,
  plannedReplyTo: string | null,
  visible: ReadonlyMap<number, string>,
): ParsedSpeakerOutput {
  let text = (raw ?? "").trim();
  if (!text) return { kind: "empty" };
  if (PASS.test(text)) return { kind: "pass" };
  let kind: TurnMode = mode;
  let replyTo = plannedReplyTo;
  const marker = MARKER.exec(text);
  if (marker) {
    text = text.slice(marker[0].length).trim();
    const target = visible.get(Number(marker[2]));
    if (target) {
      replyTo = target;
      if (marker[1]!.toLowerCase() === "comment") kind = "comment";
    }
  }
  text = text.replace(/\[\[(?:reply|comment):#\d{1,9}\]\]\s*/giu, "").replace(/\[\[pass\]\]/giu, "").trim();
  if (!text) return { kind: "empty" };
  if (kind === "comment") text = clipToSentences(text, ROOM_DISCUSSION_DEFAULTS.commentMaxSentences, ROOM_DISCUSSION_DEFAULTS.commentMaxChars);
  return { kind, text, replyTo };
}

// ── Moderator: who speaks ───────────────────────────────────────────────────

export interface SelectSpeakersInput {
  /** Members who can speak now, in roster order. */
  members: readonly RoomMember[];
  /** The post(s) this round answers: the owner's post, or the member posts that addressed someone / asked. */
  triggers: readonly RoomPost[];
  /** Posts of this discussion so far (the trigger included), used to know who has been heard. */
  discussionPosts: readonly RoomPost[];
  lastSpeakerAgentId?: string | null;
  /** Higher = spoke more recently. Missing = never. Drives rotation. */
  lastSpokeSeq?: ReadonlyMap<string, number>;
  k?: number;
  maxK?: number;
}

export interface Selection {
  speakers: SpeakerPlan[];
  /** True when the rules left an arbitrary pick among equals; a chooser may decide. */
  ambiguous: boolean;
  /** Candidates a chooser may pick from (only set when ambiguous). */
  candidates: SpeakerPlan[];
}

export function selectSpeakers(input: SelectSpeakersInput): Selection {
  const k = Math.max(1, Math.min(input.k ?? ROOM_DISCUSSION_DEFAULTS.speakersPerRound, input.maxK ?? ROOM_DISCUSSION_DEFAULTS.maxSpeakersPerRound));
  const maxK = Math.max(k, input.maxK ?? ROOM_DISCUSSION_DEFAULTS.maxSpeakersPerRound);
  const authors = new Set(input.triggers.filter((post) => post.author === "member" && post.speakerAgentId).map((post) => post.speakerAgentId!));
  const eligible = input.members.filter((member) => !authors.has(member.agentId));
  const plans = new Map<string, SpeakerPlan>();

  // 1-2. Explicit: @mentions and names in each trigger. A member's post that addresses someone becomes a comment for
  // them. Only the trigger's own author is excluded, so two members who addressed each other can both be answered.
  for (const trigger of input.triggers) {
    const byMember = trigger.author === "member";
    const reachable = input.members.filter((member) => member.agentId !== trigger.speakerAgentId);
    for (const found of findAddressedMembers(trigger.text, reachable)) {
      if (plans.has(found.member.agentId)) continue;
      plans.set(found.member.agentId, {
        agentId: found.member.agentId,
        name: found.member.name,
        reason: byMember ? "addressed" : found.via === "mention" ? "mentioned" : "named",
        mode: byMember ? "comment" : "message",
        replyTo: trigger.messageId,
      });
    }
  }
  if (plans.size > 0) {
    return { speakers: [...plans.values()].slice(0, maxK), ambiguous: false, candidates: [] };
  }

  // 3-5. No explicit target: members not yet heard on this topic, never the last speaker again, least recent first.
  const heard = new Set(input.discussionPosts.filter((post) => post.author === "member" && post.speakerAgentId).map((post) => post.speakerAgentId!));
  let pool = eligible;
  if (input.lastSpeakerAgentId && pool.length > k) {
    const without = pool.filter((member) => member.agentId !== input.lastSpeakerAgentId);
    if (without.length >= 1) pool = without;
  }
  const rank = (member: RoomMember): [number, number] => [heard.has(member.agentId) ? 1 : 0, input.lastSpokeSeq?.get(member.agentId) ?? -1];
  const order = new Map(input.members.map((member, index) => [member.agentId, index]));
  const sorted = [...pool].sort((a, b) => {
    const [ha, sa] = rank(a);
    const [hb, sb] = rank(b);
    return ha - hb || sa - sb || order.get(a.agentId)! - order.get(b.agentId)!;
  });
  const questionTrigger = input.triggers.find((post) => post.author === "member");
  const toPlan = (member: RoomMember): SpeakerPlan => ({
    agentId: member.agentId,
    name: member.name,
    reason: heard.has(member.agentId) ? "rotation" : "unheard",
    mode: questionTrigger ? "comment" : "message",
    replyTo: questionTrigger ? questionTrigger.messageId : null,
  });
  const picked = sorted.slice(0, k).map(toPlan);
  let ambiguous = false;
  if (sorted.length > k) {
    const edge = rank(sorted[k - 1]!);
    const next = rank(sorted[k]!);
    ambiguous = edge[0] === next[0] && edge[1] === next[1];
  }
  return { speakers: picked, ambiguous, candidates: ambiguous ? sorted.map(toPlan) : [] };
}

// ── Follow-up detection ─────────────────────────────────────────────────────

export interface FollowUps { triggers: RoomPost[]; needsNextRound: boolean }

/**
 * A next round is warranted only when a post of the finished round addressed another member or asked a question.
 * A comment may do so too (a cheap back-and-forth); the round, budget and Stop limits are what end a thread.
 */
export function detectFollowUps(roundPosts: readonly RoomPost[], members: readonly RoomMember[]): FollowUps {
  const triggers: RoomPost[] = [];
  for (const post of roundPosts) {
    if (post.author !== "member") continue;
    const others = members.filter((member) => member.agentId !== post.speakerAgentId);
    const addressed = findAddressedMembers(post.text, others).length > 0;
    if (addressed || asksQuestion(post.text)) triggers.push(post);
  }
  return { triggers, needsNextRound: triggers.length > 0 };
}

// ── Prompt: incremental, same snapshot ──────────────────────────────────────

/** Posts a member has not seen yet, up to the round snapshot. A member without a cursor gets a short recent window. */
export function selectNewPosts(
  posts: readonly RoomPost[],
  input: { cursor: number | null; snapshotSeq: number; selfAgentId: string },
): { posts: RoomPost[]; omitted: number } {
  const upTo = posts.filter((post) => post.seq <= input.snapshotSeq).sort((a, b) => a.seq - b.seq);
  let fresh = input.cursor === null
    ? upTo.slice(-ROOM_DISCUSSION_DEFAULTS.firstTurnWindow)
    : upTo.filter((post) => post.seq > input.cursor!);
  // A cursor member already holds its own earlier words in its thread.
  if (input.cursor !== null) fresh = fresh.filter((post) => post.speakerAgentId !== input.selfAgentId);
  let omitted = input.cursor === null ? Math.max(0, upTo.length - fresh.length) : 0;
  if (fresh.length > ROOM_DISCUSSION_DEFAULTS.maxPromptPosts) {
    omitted += fresh.length - ROOM_DISCUSSION_DEFAULTS.maxPromptPosts;
    fresh = fresh.slice(-ROOM_DISCUSSION_DEFAULTS.maxPromptPosts);
  }
  return { posts: fresh, omitted };
}

function clipPost(text: string): string {
  const flat = stripMarkers(text).replace(/\n{3,}/g, "\n\n").trim();
  return flat.length > ROOM_DISCUSSION_DEFAULTS.maxPostChars ? `${flat.slice(0, ROOM_DISCUSSION_DEFAULTS.maxPostChars - 1).trimEnd()}…` : flat;
}

export interface SpeakerPromptInput {
  locale: "ko" | "en";
  roomTitle: string;
  roomDescription?: string;
  member: RoomMember;
  members: readonly RoomMember[];
  coSpeakers: readonly string[];
  roundNo: number;
  maxRounds: number;
  mode: TurnMode;
  replyTarget: RoomPost | null;
  newPosts: readonly RoomPost[];
  omitted: number;
  ownerLabel?: string;
}

export function buildSpeakerPrompt(input: SpeakerPromptInput): string {
  const ko = input.locale === "ko";
  const owner = input.ownerLabel ?? (ko ? "오너" : "Owner");
  const label = (post: RoomPost) => post.author === "owner" ? owner : (post.speakerName || (ko ? "팀원" : "Member"));
  let lines = input.newPosts.map((post) => `#${post.seq} [${label(post)}${post.kind === "comment" ? (ko ? ", 댓글" : ", comment") : ""}] ${clipPost(post.text)}`);
  let total = 0;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    total += lines[index]!.length;
    if (total > ROOM_DISCUSSION_DEFAULTS.maxPromptChars && kept.length > 0) break;
    kept.unshift(lines[index]!);
  }
  const dropped = lines.length - kept.length;
  lines = kept;
  const omitted = input.omitted + dropped;
  const others = input.members.filter((member) => member.agentId !== input.member.agentId).map((member) => member.name);
  const together = input.coSpeakers.filter((name) => name !== input.member.name);
  const head = ko
    ? [
      `[단체방 토론] 방 "${input.roomTitle}"에서 ${owner}와 팀원들이 이야기하고 있습니다. 당신은 ${input.member.name}입니다.`,
      input.roomDescription ? `방 설명: ${input.roomDescription.slice(0, 300)}` : "",
      `이 방의 다른 팀원: ${others.join(", ") || "(없음)"}`,
      `이 방은 순서나 차례가 없는 자유로운 대화입니다.${together.length ? ` ${together.join(", ")}도 같은 글을 보고 지금 답하는 중이라 서로의 새 발언은 아직 볼 수 없습니다.` : ""}`,
    ]
    : [
      `[Group room discussion] In the room "${input.roomTitle}" the ${owner.toLowerCase()} and teammates are talking. You are ${input.member.name}.`,
      input.roomDescription ? `Room description: ${input.roomDescription.slice(0, 300)}` : "",
      `Other teammates in this room: ${others.join(", ") || "(none)"}`,
      `This room is a free conversation with no turns or order.${together.length ? ` ${together.join(", ")} are reading the same post and answering right now, so you cannot see each other's new words yet.` : ""}`,
    ];
  const section = ko
    ? [`마지막으로 본 이후 새 글${omitted > 0 ? ` (더 앞선 ${omitted}개는 생략)` : ""}:`, ...(lines.length ? lines : ["(새 글 없음)"])]
    : [`New posts since you last looked${omitted > 0 ? ` (${omitted} earlier omitted)` : ""}:`, ...(lines.length ? lines : ["(no new posts)"])];
  const task = input.mode === "comment" && input.replyTarget
    ? (ko
      ? [`할 일: #${input.replyTarget.seq} 글에 짧은 댓글을 남기세요. 한두 문장, 길어도 두 문장을 넘기지 마세요. 새 주제를 열지 마세요.`]
      : [`Task: leave a short comment on post #${input.replyTarget.seq}. One or two sentences, never more than two. Do not open a new topic.`])
    : (ko
      ? [`할 일: 위 글을 읽고 ${input.member.name}으로서 이 주제와 직접 관련 있고 보탤 말이 있을 때만 의견을 말하세요. 핵심 위주로 간결하게.${input.replyTarget ? ` 특히 #${input.replyTarget.seq} 글에 답하세요.` : ""}`]
      : [`Task: read the posts above and, as ${input.member.name}, speak only if this is relevant to you and you have something to add. Concise and to the point.${input.replyTarget ? ` Answer post #${input.replyTarget.seq} in particular.` : ""}`]);
  const rules = ko
    ? [
      "규칙:",
      "- 오너가 쓴 언어로 답하세요. 도구나 파일 작업 없이 말로만 답합니다.",
      "- 다른 팀원에게 묻거나 반박하려면 @이름 으로 부르세요. 상대가 이어서 답합니다.",
      "- 특정 글에 답하면 답의 첫 줄에 [[reply:#번호]] 를 쓰세요.",
      "- 더할 말이 없거나 내 분야가 아니면 [[pass]] 한 단어만 쓰세요. 모두가 말할 필요는 없습니다.",
      "- 앞 발언을 되풀이하지 마세요.",
    ]
    : [
      "Rules:",
      "- Answer in the language the owner used. Speak only; no tools or file work.",
      "- To ask or challenge a teammate, call them with @name. They answer next.",
      "- When answering a specific post, start your answer with [[reply:#number]].",
      "- If you have nothing to add or it is not your area, write only [[pass]]. Not everyone needs to speak.",
      "- Do not repeat what was already said.",
    ];
  return [...head.filter(Boolean), "", ...section, "", ...task, "", ...rules].join("\n");
}

// ── Caps ────────────────────────────────────────────────────────────────────

export type CapRefusalCode = "global_speaker_cap" | "member_speaker_cap";

export type CapResult =
  | { ok: true; release: () => void }
  | { ok: false; code: CapRefusalCode; limit: number; active: number };

export interface SpeakerCapsOptions {
  /** The host's run-slot budget (getAgentConcurrency). */
  globalLimit: () => number;
  /** Run slots held or awaited by anything other than this ledger (runSlotStats inUse+queued minus ours). */
  externalBusy?: () => number;
  perMember?: number;
}

/** Concurrent-speaker ledger: global (against the shared run-slot budget) and per member across all rooms. */
export class SpeakerCaps {
  private readonly active = new Map<string, { chatId: string; agentId: string }>();
  private serial = 0;

  constructor(private readonly options: SpeakerCapsOptions) {}

  tryAcquire(chatId: string, agentId: string): CapResult {
    const perMember = this.options.perMember ?? ROOM_DISCUSSION_DEFAULTS.perMemberConcurrency;
    const memberActive = [...this.active.values()].filter((entry) => entry.agentId === agentId).length;
    if (memberActive >= perMember) return { ok: false, code: "member_speaker_cap", limit: perMember, active: memberActive };
    const limit = Math.max(1, Math.floor(this.options.globalLimit()));
    const external = Math.max(0, Math.floor(this.options.externalBusy?.() ?? 0));
    if (this.active.size + external >= limit) return { ok: false, code: "global_speaker_cap", limit, active: this.active.size + external };
    const key = `speaker-${++this.serial}`;
    this.active.set(key, { chatId, agentId });
    let released = false;
    return { ok: true, release: () => { if (!released) { released = true; this.active.delete(key); } } };
  }

  count(): number { return this.active.size; }
  countFor(agentId: string): number { return [...this.active.values()].filter((entry) => entry.agentId === agentId).length; }
}

// ── Records and ports ───────────────────────────────────────────────────────

export interface DiscussionRecord {
  id: string;
  chatId: string;
  status: DiscussionStatus;
  stopReason: StopReason | null;
  ownerMessageId: string;
  rootSeq: number;
  roundNo: number;
  maxRounds: number;
  budgetUnits: number;
  spentUnits: number;
  stopRequested: boolean;
}

export interface RoundRecord { id: string; discussionId: string; roundNo: number; snapshotSeq: number }

export interface TurnRecord {
  id: string;
  roundId: string;
  discussionId: string;
  chatId: string;
  agentId: string;
  name: string;
  ordinal: number;
  mode: TurnMode;
  reason: SelectionReason;
  replyTo: string | null;
  status: TurnStatus;
  reasonCode: string | null;
  runId: string | null;
  childChatId: string | null;
  resultText: string | null;
  messageId: string | null;
}

export interface InboxItem { id: string; chatId: string; messageId: string; interrupt: boolean }

export interface RoomRoster {
  title: string;
  description: string;
  members: RoomMember[];
  locale: "ko" | "en";
}

export interface RoomLogPort {
  maxSeq(chatId: string): number;
  /** Posts with afterSeq < seq <= uptoSeq in seq order. */
  listPosts(chatId: string, range: { afterSeq: number; uptoSeq: number }): RoomPost[];
  postByMessageId(chatId: string, messageId: string): RoomPost | null;
  appendOwnerPost(chatId: string, text: string): RoomPost;
  appendMemberPost(chatId: string, input: {
    speaker: RoomMember;
    text: string;
    kind: "post" | "comment";
    replyTo: string | null;
    /** Null for a working-room message that belongs to no discussion. */
    discussionId: string | null;
    roundNo: number | null;
  }): RoomPost;
}

export interface RoomStatePort {
  setting(chatId: string): boolean | null;
  setSetting(chatId: string, enabled: boolean | null): void;
  createDiscussion(input: { chatId: string; ownerMessageId: string; rootSeq: number; maxRounds: number; budgetUnits: number }): DiscussionRecord;
  discussion(id: string): DiscussionRecord | null;
  runningDiscussion(chatId: string): DiscussionRecord | null;
  lastDiscussion(chatId: string): DiscussionRecord | null;
  updateDiscussion(id: string, patch: Partial<Pick<DiscussionRecord, "status" | "stopReason" | "roundNo" | "spentUnits" | "stopRequested">>): void;
  openRound(input: { discussionId: string; chatId: string; roundNo: number; snapshotSeq: number }): RoundRecord;
  closeRound(roundId: string, status: "completed" | "interrupted", reason: string | null): void;
  insertTurn(input: Omit<TurnRecord, "id" | "status" | "reasonCode" | "runId" | "childChatId" | "resultText" | "messageId">): TurnRecord;
  updateTurn(id: string, patch: Partial<Pick<TurnRecord, "status" | "reasonCode" | "runId" | "childChatId" | "resultText" | "messageId">>): void;
  turns(roundId: string): TurnRecord[];
  roundsOf(discussionId: string): Array<RoundRecord & { status: string }>;
  cursor(chatId: string, agentId: string): number | null;
  setCursor(chatId: string, agentId: string, seq: number): void;
  addInbox(input: { chatId: string; messageId: string; interrupt: boolean }): InboxItem;
  pendingInbox(chatId: string): InboxItem[];
  consumeInbox(ids: readonly string[]): void;
  /** Recovery: discussions left 'running' by a host that is gone. */
  orphanedDiscussions(): DiscussionRecord[];
  chatsWithPendingInbox(): string[];
}

export interface SpeakerSettled {
  status: "completed" | "failed" | "cancelled" | "interrupted";
  text: string | null;
  errorCode?: string;
}

export interface SpeakerHandle {
  runId: string;
  childChatId: string | null;
  done: Promise<SpeakerSettled>;
  cancel(): void;
}

export interface SpeakerRunnerPort {
  /** Throws an Error whose message starts with a machine code (e.g. `member_busy`) when the turn cannot start. */
  start(input: { turnId: string; chatId: string; member: RoomMember; prompt: string; locale: "ko" | "en"; mode: TurnMode }): SpeakerHandle | Promise<SpeakerHandle>;
}

export interface RoomDiscussionPorts {
  log: RoomLogPort;
  state: RoomStatePort;
  runner: SpeakerRunnerPort;
  caps: SpeakerCaps;
  roster(chatId: string): RoomRoster | null;
  /** An ordinary (non-discussion) run is active in the room itself. */
  roomBusy?(chatId: string): boolean;
  emit?(chatId: string): void;
  /** Optional cheap tie-breaker. Absent by default: the rules decide and no model is called. */
  chooser?(input: { chatId: string; candidates: readonly SpeakerPlan[]; k: number; trigger: RoomPost }): Promise<readonly string[] | null> | readonly string[] | null;
  limits?: Partial<DiscussionLimits>;
  now?(): number;
}

// ── Results and views ───────────────────────────────────────────────────────

export type PostResult =
  | { handled: false; reason: "empty_post" | "not_group_room" | "discussion_off" | "too_few_members" | "not_a_discussion_post" | "room_busy" }
  | { handled: true; status: "started"; discussionId: string; messageId: string; seq: number }
  | { handled: true; status: "queued"; discussionId: string; messageId: string; seq: number; interrupt: boolean };

export interface SpeakerView {
  turnId: string;
  agentId: string;
  name: string;
  mode: TurnMode;
  status: TurnStatus;
  runId: string | null;
  /** The (member, room) session the run lives in; run events are delivered under this chat id. */
  childChatId: string | null;
  reasonCode: string | null;
}

export interface RoomDiscussionView {
  chatId: string;
  /** Effective setting: the owner's choice, else on when the room has at least two members. */
  enabled: boolean;
  explicit: boolean | null;
  memberCount: number;
  active: null | {
    discussionId: string;
    roundNo: number;
    maxRounds: number;
    stopRequested: boolean;
    queuedOwnerPosts: number;
    budget: { spent: number; total: number };
    speakers: SpeakerView[];
  };
  last: null | { discussionId: string; status: DiscussionStatus; stopReason: StopReason | null; roundNo: number };
}

interface LoopControl {
  discussionId: string;
  stopRequested: boolean;
  interruptRequested: boolean;
  handles: Map<string, SpeakerHandle>;
  promise: Promise<void>;
}

function machineCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([a-z][a-z0-9_]{2,80})(?::|\b)/.exec(raw);
  return match ? match[1]! : fallback;
}

// ── Engine ──────────────────────────────────────────────────────────────────

export class RoomDiscussionEngine {
  private readonly loops = new Map<string, LoopControl>();
  private readonly limits: DiscussionLimits;

  constructor(private readonly ports: RoomDiscussionPorts) {
    this.limits = {
      speakersPerRound: ports.limits?.speakersPerRound ?? ROOM_DISCUSSION_DEFAULTS.speakersPerRound,
      maxSpeakersPerRound: ports.limits?.maxSpeakersPerRound ?? ROOM_DISCUSSION_DEFAULTS.maxSpeakersPerRound,
      maxRounds: ports.limits?.maxRounds ?? ROOM_DISCUSSION_DEFAULTS.maxRounds,
      budgetUnits: ports.limits?.budgetUnits ?? ROOM_DISCUSSION_DEFAULTS.budgetUnits,
    };
  }

  private emit(chatId: string): void {
    try { this.ports.emit?.(chatId); } catch { /* a notification failure never changes the discussion */ }
  }

  isActive(chatId: string): boolean { return this.loops.has(chatId); }

  async whenIdle(chatId?: string): Promise<void> {
    for (;;) {
      const pending = [...this.loops.entries()].filter(([id]) => !chatId || id === chatId).map(([, loop]) => loop.promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  // — owner entry ——————————————————————————————————————————————

  post(input: { chatId: string; text: string; interrupt?: boolean; force?: boolean }): PostResult {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return { handled: false, reason: "empty_post" };
    const roster = this.ports.roster(input.chatId);
    if (!roster) return { handled: false, reason: "not_group_room" };
    const running = this.loops.get(input.chatId);

    // An owner post during a discussion is always taken: logged now, queued durably, never dropped.
    if (running) {
      const post = this.ports.log.appendOwnerPost(input.chatId, text);
      const interrupt = input.interrupt === true;
      this.ports.state.addInbox({ chatId: input.chatId, messageId: post.messageId, interrupt });
      if (interrupt) {
        running.interruptRequested = true;
        for (const handle of running.handles.values()) { try { handle.cancel(); } catch { /* unconditional */ } }
      }
      this.emit(input.chatId);
      return { handled: true, status: "queued", discussionId: running.discussionId, messageId: post.messageId, seq: post.seq, interrupt };
    }

    const explicit = this.ports.state.setting(input.chatId);
    if (explicit === false) return { handled: false, reason: "discussion_off" };
    if (roster.members.length < 2) return { handled: false, reason: "too_few_members" };
    if (!input.force && !invitesDiscussion(text, roster.members)) return { handled: false, reason: "not_a_discussion_post" };
    if (this.ports.roomBusy?.(input.chatId)) return { handled: false, reason: "room_busy" };

    const post = this.ports.log.appendOwnerPost(input.chatId, text);
    const discussion = this.startDiscussion(input.chatId, post);
    return { handled: true, status: "started", discussionId: discussion.id, messageId: post.messageId, seq: post.seq };
  }

  /** Owner stop: unconditional. Cancels running speakers; the loop closes the discussion as stopped. */
  stop(chatId: string): { stopped: boolean; discussionId: string | null } {
    const loop = this.loops.get(chatId);
    const record = this.ports.state.runningDiscussion(chatId);
    if (!loop) {
      const queued = this.ports.state.pendingInbox(chatId);
      if (queued.length > 0) this.ports.state.consumeInbox(queued.map((item) => item.id));
      if (record) {
        // No live loop in this process (a stale row): close it here so Stop never depends on another state.
        this.ports.state.updateDiscussion(record.id, { status: "stopped", stopReason: "owner_stop", stopRequested: true });
        this.emit(chatId);
        return { stopped: true, discussionId: record.id };
      }
      return { stopped: false, discussionId: null };
    }
    loop.stopRequested = true;
    // Stop also withdraws posts queued behind this discussion; they stay in the room log as the owner's words.
    const queued = this.ports.state.pendingInbox(chatId);
    if (queued.length > 0) this.ports.state.consumeInbox(queued.map((item) => item.id));
    this.ports.state.updateDiscussion(loop.discussionId, { stopRequested: true });
    for (const handle of loop.handles.values()) { try { handle.cancel(); } catch { /* unconditional */ } }
    this.emit(chatId);
    return { stopped: true, discussionId: loop.discussionId };
  }

  setEnabled(chatId: string, enabled: boolean | null): void {
    this.ports.state.setSetting(chatId, enabled);
    this.emit(chatId);
  }

  // — state for the screen ——————————————————————————————————————

  view(chatId: string): RoomDiscussionView {
    const roster = this.ports.roster(chatId);
    const explicit = this.ports.state.setting(chatId);
    const memberCount = roster?.members.length ?? 0;
    const running = this.ports.state.runningDiscussion(chatId);
    const last = running ?? this.ports.state.lastDiscussion(chatId);
    let active: RoomDiscussionView["active"] = null;
    if (running && this.loops.has(chatId)) {
      const rounds = this.ports.state.roundsOf(running.id);
      const round = rounds[rounds.length - 1];
      active = {
        discussionId: running.id,
        roundNo: running.roundNo,
        maxRounds: running.maxRounds,
        stopRequested: running.stopRequested || Boolean(this.loops.get(chatId)?.stopRequested),
        queuedOwnerPosts: this.ports.state.pendingInbox(chatId).length,
        budget: { spent: running.spentUnits, total: running.budgetUnits },
        speakers: round && round.status === "running"
          ? this.ports.state.turns(round.id).map((turn) => ({
            turnId: turn.id, agentId: turn.agentId, name: turn.name, mode: turn.mode, status: turn.status, runId: turn.runId, childChatId: turn.childChatId, reasonCode: turn.reasonCode,
          }))
          : [],
      };
    }
    return {
      chatId,
      enabled: explicit ?? memberCount >= 2,
      explicit,
      memberCount,
      active,
      last: last && !active ? { discussionId: last.id, status: last.status, stopReason: last.stopReason, roundNo: last.roundNo } : null,
    };
  }

  // — recovery ————————————————————————————————————————————————

  /**
   * After a restart: every round a gone host left running is closed as interrupted. A finished speaker answer that
   * was not yet in the log is published from the stored text; nothing is sent to a model again. Owner posts that
   * were queued and never answered start a fresh discussion (they are new work, not a replay).
   */
  recover(options: { resume?: boolean } = {}): { closed: number; published: number; resumed: number } {
    let closed = 0;
    let published = 0;
    let resumed = 0;
    for (const discussion of this.ports.state.orphanedDiscussions()) {
      if (this.loops.has(discussion.chatId)) continue;
      const roster = this.ports.roster(discussion.chatId);
      for (const round of this.ports.state.roundsOf(discussion.id)) {
        if (round.status !== "running") continue;
        const turns = this.ports.state.turns(round.id);
        for (const turn of turns) {
          if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "refused" || turn.status === "interrupted") continue;
          const member = roster?.members.find((item) => item.agentId === turn.agentId);
          if (turn.resultText && !turn.messageId && member) {
            const post = this.ports.log.appendMemberPost(discussion.chatId, {
              speaker: member, text: turn.resultText, kind: turn.mode === "comment" ? "comment" : "post",
              replyTo: turn.replyTo, discussionId: discussion.id, roundNo: round.roundNo,
            });
            this.ports.state.updateTurn(turn.id, { status: "completed", messageId: post.messageId });
            published += 1;
          } else {
            this.ports.state.updateTurn(turn.id, { status: "interrupted", reasonCode: "host_restarted" });
          }
        }
        this.ports.state.closeRound(round.id, "interrupted", "host_restarted");
      }
      this.ports.state.updateDiscussion(discussion.id, { status: "interrupted", stopReason: "interrupted_by_restart" });
      closed += 1;
      this.emit(discussion.chatId);
    }
    if (options.resume !== false) {
      for (const chatId of this.ports.state.chatsWithPendingInbox()) {
        if (this.loops.has(chatId) || !this.ports.roster(chatId)) continue;
        if (this.resumeFromInbox(chatId)) resumed += 1;
      }
    }
    return { closed, published, resumed };
  }

  private resumeFromInbox(chatId: string): boolean {
    const pending = this.ports.state.pendingInbox(chatId);
    const latest = pending[pending.length - 1];
    if (!latest) return false;
    const post = this.ports.log.postByMessageId(chatId, latest.messageId);
    if (!post) { this.ports.state.consumeInbox(pending.map((item) => item.id)); return false; }
    this.ports.state.consumeInbox(pending.map((item) => item.id));
    this.startDiscussion(chatId, post);
    return true;
  }

  // — loop ————————————————————————————————————————————————————

  private startDiscussion(chatId: string, rootPost: RoomPost): DiscussionRecord {
    const discussion = this.ports.state.createDiscussion({
      chatId, ownerMessageId: rootPost.messageId, rootSeq: rootPost.seq,
      maxRounds: this.limits.maxRounds, budgetUnits: this.limits.budgetUnits,
    });
    const control: LoopControl = {
      discussionId: discussion.id, stopRequested: false, interruptRequested: false, handles: new Map(),
      promise: Promise.resolve(),
    };
    this.loops.set(chatId, control);
    control.promise = this.runLoop(chatId, discussion, rootPost, control)
      .catch((error) => {
        console.warn("[room-discussion] loop failed:", error instanceof Error ? error.message : error);
        try { this.ports.state.updateDiscussion(control.discussionId, { status: "failed", stopReason: "failed" }); } catch { /* keep closing */ }
      })
      .finally(() => {
        if (this.loops.get(chatId) === control) this.loops.delete(chatId);
        // An owner post that arrived while this loop was winding down (after a stop, or while a cap closed it)
        // still deserves its answer: it opens a fresh discussion instead of sitting in the inbox.
        try { this.resumeFromInbox(chatId); } catch (error) { console.warn("[room-discussion] inbox resume failed:", error instanceof Error ? error.message : error); }
        this.emit(chatId);
      });
    this.emit(chatId);
    return discussion;
  }

  private finish(discussion: DiscussionRecord, status: DiscussionStatus, reason: StopReason): void {
    this.ports.state.updateDiscussion(discussion.id, { status, stopReason: reason });
    discussion.status = status;
    discussion.stopReason = reason;
  }

  private async runLoop(chatId: string, initial: DiscussionRecord, rootPost: RoomPost, control: LoopControl): Promise<void> {
    let discussion = initial;
    let triggers: RoomPost[] = [rootPost];
    const ports = this.ports;

    for (;;) {
      if (control.stopRequested) { this.finish(discussion, "stopped", "owner_stop"); return; }

      // An owner post that arrived during the last round opens a fresh discussion. Its text is already in the log.
      if (discussion.roundNo > 0) {
        const pending = ports.state.pendingInbox(chatId);
        if (pending.length > 0) {
          this.finish(discussion, "completed", "owner_replaced");
          ports.state.consumeInbox(pending.map((item) => item.id));
          const latest = ports.log.postByMessageId(chatId, pending[pending.length - 1]!.messageId);
          if (!latest) return;
          control.interruptRequested = false;
          discussion = ports.state.createDiscussion({
            chatId, ownerMessageId: latest.messageId, rootSeq: latest.seq,
            maxRounds: this.limits.maxRounds, budgetUnits: this.limits.budgetUnits,
          });
          control.discussionId = discussion.id;
          triggers = [latest];
          this.emit(chatId);
        }
      }

      const roundNo = discussion.roundNo + 1;
      if (roundNo > discussion.maxRounds) { this.finish(discussion, "completed", "max_rounds"); return; }

      const roster = ports.roster(chatId);
      if (!roster || roster.members.length < 2) { this.finish(discussion, "completed", "no_candidates"); return; }

      const snapshotSeq = ports.log.maxSeq(chatId);
      const discussionPosts = ports.log.listPosts(chatId, { afterSeq: Math.max(0, discussion.rootSeq - 1), uptoSeq: snapshotSeq });
      const lastSpeaker = [...discussionPosts].reverse().find((post) => post.author === "member")?.speakerAgentId ?? null;
      const lastSpokeSeq = new Map<string, number>();
      for (const post of discussionPosts) if (post.author === "member" && post.speakerAgentId) lastSpokeSeq.set(post.speakerAgentId, post.seq);

      let selection = selectSpeakers({
        members: roster.members, triggers, discussionPosts, lastSpeakerAgentId: lastSpeaker, lastSpokeSeq,
        k: this.limits.speakersPerRound, maxK: this.limits.maxSpeakersPerRound,
      });
      if (selection.ambiguous && ports.chooser) {
        try {
          const chosen = await ports.chooser({ chatId, candidates: selection.candidates, k: this.limits.speakersPerRound, trigger: triggers[0]! });
          if (chosen && chosen.length > 0) {
            const byId = new Map(selection.candidates.map((plan) => [plan.agentId, plan]));
            const picked = chosen.map((id) => byId.get(id)).filter((plan): plan is SpeakerPlan => Boolean(plan)).slice(0, this.limits.maxSpeakersPerRound);
            if (picked.length > 0) selection = { ...selection, speakers: picked };
          }
        } catch { /* the rule order stands */ }
      }

      // Budget: comments count, but cost less. Keep the speakers the remaining budget can pay for.
      let remaining = discussion.budgetUnits - discussion.spentUnits;
      const plans: SpeakerPlan[] = [];
      for (const plan of selection.speakers) {
        const cost = plan.mode === "comment" ? ROOM_DISCUSSION_DEFAULTS.commentCost : ROOM_DISCUSSION_DEFAULTS.messageCost;
        if (cost > remaining) continue;
        remaining -= cost;
        plans.push(plan);
      }
      if (plans.length === 0) {
        this.finish(discussion, "completed", selection.speakers.length === 0 ? "no_candidates" : "budget");
        return;
      }

      const round = ports.state.openRound({ discussionId: discussion.id, chatId, roundNo, snapshotSeq });
      ports.state.updateDiscussion(discussion.id, { roundNo });
      discussion.roundNo = roundNo;
      const turns = plans.map((plan, ordinal) => ports.state.insertTurn({
        roundId: round.id, discussionId: discussion.id, chatId, agentId: plan.agentId, name: plan.name,
        ordinal, mode: plan.mode, reason: plan.reason, replyTo: plan.replyTo,
      }));
      this.emit(chatId);

      const allPosts = ports.log.listPosts(chatId, { afterSeq: 0, uptoSeq: snapshotSeq });
      const coSpeakers = plans.map((plan) => plan.name);

      // Start every speaker. They all read the same snapshot and run at the same time.
      const settled = await Promise.all(turns.map((turn, index) => this.runTurn({
        chatId, roster, turn, plan: plans[index]!, round: { id: round.id, roundNo, snapshotSeq }, discussion,
        allPosts, coSpeakers, control,
      })));

      // Each message entered the log the moment its speaker finished (runTurn); cancelled, failed, refused and
      // passed turns added nothing.
      const committed: RoomPost[] = settled.flatMap((outcome) => (outcome.post ? [outcome.post] : []));
      ports.state.updateDiscussion(discussion.id, { spentUnits: discussion.spentUnits });
      const refused = settled.filter((outcome) => outcome.refusedCode);
      ports.state.closeRound(round.id, "completed", control.stopRequested ? "owner_stop" : null);
      this.emit(chatId);

      if (control.stopRequested) { this.finish(discussion, "stopped", "owner_stop"); return; }
      if (control.interruptRequested || ports.state.pendingInbox(chatId).length > 0) continue;
      if (committed.length === 0) {
        const everyoneRefused = refused.length === settled.length;
        this.finish(discussion, everyoneRefused ? "failed" : "completed", everyoneRefused ? "cap_refused" : "no_new_content");
        return;
      }
      const follow = detectFollowUps(committed, roster.members);
      if (!follow.needsNextRound) { this.finish(discussion, "completed", "settled"); return; }
      triggers = follow.triggers;
    }
  }

  private async runTurn(input: {
    chatId: string;
    roster: RoomRoster;
    turn: TurnRecord;
    plan: SpeakerPlan;
    round: { id: string; roundNo: number; snapshotSeq: number };
    discussion: DiscussionRecord;
    allPosts: readonly RoomPost[];
    coSpeakers: readonly string[];
    control: LoopControl;
  }): Promise<{ turn: TurnRecord; parsed: ParsedSpeakerOutput | null; refusedCode: string | null; post: RoomPost | null }> {
    const { ports } = this;
    const { chatId, roster, turn, plan, round, discussion, control } = input;
    const member = roster.members.find((item) => item.agentId === plan.agentId)!;

    const cap = ports.caps.tryAcquire(chatId, plan.agentId);
    if (!cap.ok) {
      ports.state.updateTurn(turn.id, { status: "refused", reasonCode: cap.code });
      this.emit(chatId);
      return { turn, parsed: null, refusedCode: cap.code, post: null };
    }

    const cursor = ports.state.cursor(chatId, plan.agentId);
    const { posts, omitted } = selectNewPosts(input.allPosts, { cursor, snapshotSeq: round.snapshotSeq, selfAgentId: plan.agentId });
    const replyTarget = plan.replyTo ? input.allPosts.find((post) => post.messageId === plan.replyTo) ?? null : null;
    const prompt = buildSpeakerPrompt({
      locale: roster.locale, roomTitle: roster.title, roomDescription: roster.description, member, members: roster.members,
      coSpeakers: input.coSpeakers, roundNo: round.roundNo, maxRounds: discussion.maxRounds, mode: plan.mode,
      replyTarget, newPosts: posts, omitted,
    });

    let handle: SpeakerHandle;
    try {
      handle = await ports.runner.start({ turnId: turn.id, chatId, member, prompt, locale: roster.locale, mode: plan.mode });
    } catch (error) {
      cap.release();
      const code = machineCode(error, "start_failed");
      ports.state.updateTurn(turn.id, { status: "refused", reasonCode: code });
      this.emit(chatId);
      return { turn, parsed: null, refusedCode: code, post: null };
    }
    control.handles.set(turn.id, handle);
    // The member now holds everything up to the snapshot in its thread.
    ports.state.setCursor(chatId, plan.agentId, round.snapshotSeq);
    ports.state.updateTurn(turn.id, { status: "running", runId: handle.runId, childChatId: handle.childChatId });
    this.emit(chatId);
    if (control.stopRequested || control.interruptRequested) { try { handle.cancel(); } catch { /* unconditional */ } }

    let result: SpeakerSettled;
    try { result = await handle.done; }
    catch (error) { result = { status: "failed", text: null, errorCode: machineCode(error, "run_failed") }; }
    finally { cap.release(); control.handles.delete(turn.id); }

    if (result.status !== "completed") {
      ports.state.updateTurn(turn.id, { status: result.status, reasonCode: result.errorCode ?? null });
      this.emit(chatId);
      return { turn, parsed: null, refusedCode: null, post: null };
    }
    const visible = new Map<number, string>(input.allPosts.map((post) => [post.seq, post.messageId]));
    const parsed = parseSpeakerOutput(result.text, plan.mode, plan.replyTo, visible);
    // Keep the finished answer until it is in the log: a restart in between publishes it, never asks again.
    if (parsed.kind !== "message" && parsed.kind !== "comment") {
      ports.state.updateTurn(turn.id, { status: "completed", reasonCode: parsed.kind });
      this.emit(chatId);
      return { turn, parsed, refusedCode: null, post: null };
    }
    ports.state.updateTurn(turn.id, { resultText: parsed.text });
    // The message enters the room the moment its speaker is done, not when the slowest speaker of the batch is.
    const post = ports.log.appendMemberPost(chatId, {
      speaker: member, text: parsed.text, kind: parsed.kind === "comment" ? "comment" : "post",
      replyTo: parsed.replyTo, discussionId: discussion.id, roundNo: round.roundNo,
    });
    ports.state.updateTurn(turn.id, { status: "completed", messageId: post.messageId });
    discussion.spentUnits += parsed.kind === "comment" ? ROOM_DISCUSSION_DEFAULTS.commentCost : ROOM_DISCUSSION_DEFAULTS.messageCost;
    ports.state.updateDiscussion(discussion.id, { spentUnits: discussion.spentUnits });
    this.emit(chatId);
    return { turn, parsed, refusedCode: null, post };
  }
}
