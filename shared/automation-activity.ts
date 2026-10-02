/**
 * What an automation run did, read from the host's tool ledger — never from the model's prose.
 *
 * Owner 2026-09-28 ("자동화로 뭐 했다고 챗에 나와야 하는 거 아니냐"): the Threads automation was posting
 * replies while its chat showed only a failed turn, and the report that landed later was the model's own
 * sentence. The outward counts here come only from `mcp_tool-use` ledger rows the host wrote while the run
 * was executing (tool name, the element label the runtime clicked, the URL it navigated to, the error flag).
 *
 * Rules:
 *  - The runtime reports one call twice (requested, then completed). Rows with the same node, tool call id
 *    and arguments are one call; the last row's error flag wins.
 *  - Host preflight lookups and supervisor notices (shared/tool-activity.ts) are not work and are dropped.
 *  - An outward action is a successful call whose ledger shape says it changed the outside world: a browser
 *    click whose element label is a submit/like/repost/follow control, an upload, a mail send, or an MCP
 *    tool whose name is a create/post/send verb. Typed text is a draft, not an effect; only its length is kept.
 *  - Unknown shapes are never promoted to outward counts. They stay visible as plain action rows.
 *
 * Pure: Main (IPC digest), the renderer and the phone bridge can all call it.
 */
import { couldHaveChangedTheOutsideWorld, isHostPreflightTool, isHostSupervisorNotice } from "./tool-activity";
import { classifyTool, isCommandTool } from "./tool-taxonomy";

export const AUTOMATION_RUN_DIGEST_SCHEMA = "agentlas.automation-run-digest.v1" as const;

export type AutomationToolFamily = "browser" | "computer" | "shell" | "mail" | "image" | "web" | "time" | "file" | "agent" | "other";
export type AutomationOutwardKind = "reply" | "post" | "repost" | "like" | "follow" | "message" | "upload" | "mail";
export type AutomationActionKind = AutomationOutwardKind | "navigate" | "read" | "search" | "click" | "type" | "command" | "time" | "image" | "file" | "call";

/** One `mcp_tool-use` ledger row, reduced to the fields the digest reads. */
export interface AutomationLedgerToolEvent {
  seq: number;
  ts: string;
  nodeId?: string | null;
  toolName: string;
  toolId?: string | null;
  toolArgs?: string | null;
  isError?: boolean | null;
  failureCode?: string | null;
  /** Host completion receipt, including an empty successful result. Requests
   * alone cannot establish that a click or text entry actually happened. */
  completed?: boolean;
}

export interface AutomationActionRow {
  id: string;
  firstAt: string;
  lastAt: string;
  kind: AutomationActionKind;
  outward: boolean;
  family: AutomationToolFamily;
  domain: string | null;
  url: string | null;
  /** The element label the runtime acted on, or the tool's short name. Ledger data, not prose. */
  label: string | null;
  toolLeaf: string;
  count: number;
  failed: number;
  failureCode: string | null;
  nodeId: string | null;
  /** Characters typed (the text itself is not carried). */
  typedChars?: number;
}

export interface AutomationRunDigest {
  schemaVersion: typeof AUTOMATION_RUN_DIGEST_SCHEMA;
  runId: string;
  automationId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  outward: Partial<Record<AutomationOutwardKind, number>>;
  outwardTotal: number;
  failures: number;
  toolCalls: number;
  /** Missing legacy/request-only receipts cannot establish that nothing happened. */
  outwardActivityCoverage?: "complete" | "incomplete" | "unknown";
  sites: Array<{ domain: string; count: number }>;
  families: Array<{ family: AutomationToolFamily; count: number }>;
  /** Grouped, oldest first. Long runs keep the newest rows; `actionsTruncated` says so. */
  actions: AutomationActionRow[];
  actionsTruncated: boolean;
  nodeStates?: Record<string, string>;
  /** Runtimes the host recorded for this run (runtime_selection ledger rows): drives the app logo. */
  runtimes?: AutomationRunRuntime[];
}

export interface AutomationRunRuntime { kind: string | null; backend: string | null; model: string | null }

const MAX_ACTION_ROWS = 200;

function leafOf(name: string): string {
  return (name.split(/__|·|\/|\./).pop() ?? name).trim().toLowerCase();
}

function parseArgs(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Public web hosts only — no IPs, localhost or file URLs (also the favicon boundary). */
export function publicHostOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!isPublicHostname(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function isPublicHostname(host: string): boolean {
  if (!/^[a-z0-9.-]{3,253}$/.test(host) || !host.includes(".")) return false;
  if (/^\d+(\.\d+){3}$/.test(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  return true;
}

export function automationToolFamily(toolName: string): AutomationToolFamily {
  const name = toolName.toLowerCase();
  const leaf = leafOf(toolName);
  if (/computer[-_ ]?use|^computer\b|mcp__computer/.test(name) || /^(screenshot|left_click|right_click|mouse_move|key|type_text|scroll)$/.test(leaf)) return "computer";
  if (/browser|playwright|chrome/.test(name)) return "browser";
  if (/gmail|mail|smtp/.test(name)) return "mail";
  if (/image[_-]?gen|generate[_-]?image|imagegen|dall-?e|text[_-]?to[_-]?image/.test(name)) return "image";
  if (/get_current_time|current[_-]?time|\btime\b/.test(leaf) || /agentlas-time/.test(name)) return "time";
  if (isCommandTool(leaf) || /^(bash|shell|exec_command|terminal)$/.test(leaf)) return "shell";
  if (/web[_-]?search|websearch|webfetch|web[_-]?fetch|^fetch$|^search/.test(leaf)) return "web";
  if (/workforce|hephaestus|hub_invoke|agentlas_call|delegate/.test(name)) return "agent";
  const action = classifyTool(leaf);
  if (action === "file" || action === "read") return "file";
  return "other";
}

// Browser click labels. A reply/post needs a submit verb so "답글 필터" (a filter tab) is not a reply.
const NOT_OUTWARD_LABEL = /필터|filter|탭\b|\btab\b|메뉴|menu|더\s*보기|see more|more options|닫기|close|검색|search|알림|notification|정렬|sort/i;
const SUBMIT_VERB = /게시|올리기|보내기|전송|등록|\bpost\b|\bsend\b|\bsubmit\b|\bpublish\b/i;
const OUTWARD_LABEL_RULES: Array<[AutomationOutwardKind, (label: string) => boolean]> = [
  ["repost", (label) => /리포스트|재게시|\brepost\b|\bretweet\b/i.test(label)],
  ["like", (label) => /좋아요|\blike\b|\bheart\b/i.test(label) && !/좋아요\s*\d|likes?\s*\(\d/i.test(label)],
  ["follow", (label) => /팔로우|\bfollow\b/i.test(label) && !/팔로잉|following|팔로워|followers/i.test(label)],
  ["message", (label) => /메시지|\bmessage\b|\bdm\b/i.test(label) && /보내기|전송|\bsend\b/i.test(label)],
  ["reply", (label) => /답글|댓글|\breply\b|\bcomment\b/i.test(label) && SUBMIT_VERB.test(label)],
  ["post", (label) => /^(?:(?:작성한|새)\s*)?(?:게시|올리기)(?:\s*버튼)?$|^(?:post|publish)\s+(?:button|now|this post)$/i.test(label)],
];

export function outwardKindForClickLabel(label: string | null | undefined): AutomationOutwardKind | null {
  const text = String(label ?? "").trim();
  if (!text || text.length > 120) return null;
  // A post URL, quoted post text, or a reply composer control is navigation,
  // even when the label contains the English noun "post" or "reply".
  if (/https?:\/\/|답글\s*(?:남기기|작성)|댓글\s*(?:남기기|작성)|\b(?:reply|comment)\s+(?:to|on)\b/i.test(text)) return null;
  if (NOT_OUTWARD_LABEL.test(text) && !/리포스트|repost|좋아요|\blike\b/i.test(text)) return null;
  for (const [kind, matches] of OUTWARD_LABEL_RULES) if (matches(text)) return kind;
  return null;
}

/** Non-browser tool names that are an outward verb by themselves (mcp create_post, send_email, upload). */
function outwardKindForToolName(toolName: string, family: AutomationToolFamily): AutomationOutwardKind | null {
  const leaf = leafOf(toolName);
  if (/upload/.test(leaf)) return "upload";
  if (family === "mail" && /send|reply|forward|draft_send/.test(leaf)) return "mail";
  if (family === "browser" || family === "computer" || family === "shell" || family === "file") return null;
  if (!couldHaveChangedTheOutsideWorld(toolName)) return null;
  if (/(^|_)(reply|comment)(_|$)/.test(leaf)) return "reply";
  if (/(^|_)(repost|retweet|reshare)(_|$)/.test(leaf)) return "repost";
  if (/(^|_)(like|favorite|react)(_|$)/.test(leaf)) return "like";
  if (/(^|_)follow(_|$)/.test(leaf)) return "follow";
  if (/(^|_)(send_message|dm|message_send)(_|$)|send_dm/.test(leaf)) return "message";
  if (/(create|publish|submit)_?(post|thread|tweet|status)|^post_|_post$|^publish/.test(leaf)) return "post";
  return null;
}

function actionKindFor(toolName: string, family: AutomationToolFamily): AutomationActionKind {
  const leaf = leafOf(toolName);
  if (family === "browser" || family === "computer") {
    if (/navigate|open_url|goto|new_tab|tab_new/.test(leaf)) return "navigate";
    if (/click|press|select|drag|drop|hover|left_click/.test(leaf)) return "click";
    if (/type|fill|input|key/.test(leaf)) return "type";
    if (/upload/.test(leaf)) return "upload";
    return "read";
  }
  if (family === "shell") return "command";
  if (family === "time") return "time";
  if (family === "image") return "image";
  if (family === "web") return /search/.test(leaf) ? "search" : "read";
  if (family === "file") return classifyTool(leaf) === "file" ? "file" : "read";
  const action = classifyTool(leaf);
  if (action === "search") return "search";
  if (action === "read" || action === "fetch") return "read";
  return "call";
}

function argString(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

interface CallRecord {
  firstAt: string;
  lastAt: string;
  event: AutomationLedgerToolEvent;
  isError: boolean;
  failureCode: string | null;
}

/** Merge the requested/completed pair of each call. Order is the first sighting. */
function uniqueCalls(events: readonly AutomationLedgerToolEvent[]): CallRecord[] {
  const calls = new Map<string, CallRecord>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    const name = String(event.toolName ?? "").trim();
    if (!name || isHostPreflightTool(name) || isHostSupervisorNotice(name)) continue;
    const key = event.toolId ? `${event.nodeId ?? ""}|${event.toolId}|${name}|${event.toolArgs ?? ""}` : `seq:${event.seq}`;
    const existing = calls.get(key);
    if (existing) {
      existing.lastAt = event.ts;
      existing.event = { ...existing.event, toolArgs: event.toolArgs ?? existing.event.toolArgs,
        completed: event.completed === true || existing.event.completed === true };
      // A repeated request is not a recovery receipt. Only a completed result
      // may clear an earlier terminal error; an explicit error always survives.
      if (event.completed === true || event.isError === true) {
        existing.isError = event.isError === true;
        existing.failureCode = event.isError === true ? (event.failureCode ?? existing.failureCode) : null;
      }
    } else {
      calls.set(key, { firstAt: event.ts, lastAt: event.ts, event, isError: event.isError === true, failureCode: event.isError === true ? (event.failureCode ?? null) : null });
    }
  }
  return [...calls.values()];
}

export interface DigestAutomationRunInput {
  runId: string;
  automationId: string;
  status: string;
  startedAt: string | null;
  endedAt?: string | null;
  nodeStates?: Record<string, string>;
  runtimes?: AutomationRunRuntime[];
  events: readonly AutomationLedgerToolEvent[];
}

export function digestAutomationRun(input: DigestAutomationRunInput): AutomationRunDigest {
  const calls = uniqueCalls(input.events);
  const currentUrlByNode = new Map<string, string>();
  const pendingDraftByNode = new Set<string>();
  // One run drives one browser profile: a step that did not navigate itself is still on the last page.
  let lastUrl: string | null = null;
  const rows: AutomationActionRow[] = [];
  const outward: Partial<Record<AutomationOutwardKind, number>> = {};
  const siteCounts = new Map<string, number>();
  const familyCounts = new Map<AutomationToolFamily, number>();
  let failures = 0;
  for (const call of calls) {
    const { event } = call;
    const nodeKey = event.nodeId ?? "";
    const family = automationToolFamily(event.toolName);
    const args = parseArgs(event.toolArgs);
    let kind = actionKindFor(event.toolName, family);
    const explicitUrl = argString(args, "url", "href", "link");
    if (!call.isError && event.completed === true && kind === "navigate" && explicitUrl && publicHostOf(explicitUrl)) {
      currentUrlByNode.set(nodeKey, explicitUrl); lastUrl = explicitUrl;
      pendingDraftByNode.delete(nodeKey);
    }
    const url = explicitUrl && publicHostOf(explicitUrl)
      ? explicitUrl
      : (family === "browser" || family === "computer") ? currentUrlByNode.get(nodeKey) ?? lastUrl : null;
    const domain = publicHostOf(url);
    const elementLabel = argString(args, "element", "label", "name", "description");
    const typed = kind === "type" ? argString(args, "text", "value") : null;
    if (!call.isError && event.completed === true && typed && family === "browser") pendingDraftByNode.add(nodeKey);
    let outwardKind: AutomationOutwardKind | null = null;
    if (!call.isError && event.completed === true) {
      if (kind === "click") {
        outwardKind = outwardKindForClickLabel(elementLabel);
        // Bare English labels are also nouns/navigation. A preceding draft in
        // this same node supplies the missing submit context; a link does not.
        if (!outwardKind && pendingDraftByNode.has(nodeKey)) {
          if (/^(?:post|publish)$/i.test(elementLabel ?? "")) outwardKind = "post";
          else if (/^(?:reply|comment)$/i.test(elementLabel ?? "")) outwardKind = "reply";
        }
        if (outwardKind === "post" || outwardKind === "reply" || outwardKind === "message") pendingDraftByNode.delete(nodeKey);
      }
      else if (kind === "upload") outwardKind = "upload";
      else outwardKind = outwardKindForToolName(event.toolName, family);
    } else if (kind === "upload") {
      kind = "click";
    }
    if (outwardKind) kind = outwardKind;
    if (call.isError) failures += 1;
    if (outwardKind) outward[outwardKind] = (outward[outwardKind] ?? 0) + 1;
    if (domain) siteCounts.set(domain, (siteCounts.get(domain) ?? 0) + 1);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    const row: AutomationActionRow = {
      id: `${input.runId}:${event.seq}`,
      firstAt: call.firstAt,
      lastAt: call.lastAt,
      kind,
      outward: outwardKind !== null,
      family,
      domain,
      url: kind === "navigate" || outwardKind ? url : null,
      label: kind === "click" || outwardKind || kind === "type" ? (elementLabel?.slice(0, 80) ?? null) : null,
      toolLeaf: leafOf(event.toolName),
      count: 1,
      failed: call.isError ? 1 : 0,
      failureCode: call.failureCode,
      nodeId: event.nodeId ?? null,
      ...(typed ? { typedChars: [...typed].length } : {}),
    };
    // Repeated plain reads/clicks on the same site in the same step collapse into one row.
    const previous = rows.at(-1);
    const groupable = !row.outward && !row.failed && (row.kind === "read" || row.kind === "search" || row.kind === "time" || row.kind === "command" || row.kind === "navigate");
    if (previous && groupable && !previous.outward && !previous.failed && previous.kind === row.kind && previous.family === row.family
      && previous.domain === row.domain && previous.nodeId === row.nodeId && (row.kind !== "navigate" || previous.url === row.url)) {
      previous.count += 1;
      previous.lastAt = row.lastAt;
      continue;
    }
    rows.push(row);
  }
  const outwardTotal = Object.values(outward).reduce((sum, value) => sum + (value ?? 0), 0);
  return {
    schemaVersion: AUTOMATION_RUN_DIGEST_SCHEMA,
    runId: input.runId,
    automationId: input.automationId,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    outward,
    outwardTotal,
    failures,
    toolCalls: calls.length,
    outwardActivityCoverage: calls.length === 0 ? "unknown"
      : !calls.every((call) => call.event.completed === true) ? "incomplete"
        // Display grouping defaults unknown browser tools to "read". That
        // label cannot prove an evaluator/script/tab mutation was read-only.
        : calls.every((call) => rows.some((row) => row.outward && row.id === `${input.runId}:${call.event.seq}`)
          || /^(?:browser_)?(?:navigate|snapshot|screenshot|read_file|read|search|web_search|web_fetch|get_current_time|current_time|get_url)$/.test(leafOf(call.event.toolName))) ? "complete" : "unknown",
    sites: [...siteCounts].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count),
    families: [...familyCounts].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count),
    actions: rows.length > MAX_ACTION_ROWS ? rows.slice(-MAX_ACTION_ROWS) : rows,
    actionsTruncated: rows.length > MAX_ACTION_ROWS,
    ...(input.nodeStates ? { nodeStates: input.nodeStates } : {}),
    ...(input.runtimes && input.runtimes.length > 0 ? { runtimes: input.runtimes } : {}),
  };
}

// ── Display vocabulary (shared so One, Work and the phone say the same words) ──

const SITE_NAMES: Array<[RegExp, string]> = [
  [/(^|\.)threads\.(net|com)$/, "Threads"],
  [/(^|\.)(x|twitter)\.com$/, "X"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)facebook\.com$/, "Facebook"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "YouTube"],
  [/(^|\.)reddit\.com$/, "Reddit"],
  [/(^|\.)github\.com$/, "GitHub"],
  [/(^|\.)naver\.com$/, "Naver"],
  [/(^|\.)google\.com$/, "Google"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)medium\.com$/, "Medium"],
];

export function siteDisplayName(domain: string | null | undefined): string {
  const host = String(domain ?? "").toLowerCase();
  for (const [pattern, name] of SITE_NAMES) if (pattern.test(host)) return name;
  return host;
}

const OUTWARD_WORDS: Record<AutomationOutwardKind, { ko: string; en: string }> = {
  reply: { ko: "답글", en: "replies" },
  post: { ko: "게시", en: "posts" },
  repost: { ko: "리포스트", en: "reposts" },
  like: { ko: "좋아요", en: "likes" },
  follow: { ko: "팔로우", en: "follows" },
  message: { ko: "메시지", en: "messages" },
  upload: { ko: "업로드", en: "uploads" },
  mail: { ko: "메일 발송", en: "emails sent" },
};
const OUTWARD_VERBS: Record<AutomationOutwardKind, { ko: string; en: string }> = {
  reply: { ko: "답글 작성", en: "Replied" },
  post: { ko: "게시", en: "Posted" },
  repost: { ko: "리포스트", en: "Reposted" },
  like: { ko: "좋아요", en: "Liked" },
  follow: { ko: "팔로우", en: "Followed" },
  message: { ko: "메시지 보냄", en: "Sent a message" },
  upload: { ko: "업로드", en: "Uploaded" },
  mail: { ko: "메일 보냄", en: "Sent an email" },
};
const OUTWARD_ORDER: AutomationOutwardKind[] = ["reply", "post", "repost", "like", "follow", "message", "upload", "mail"];

/** "답글 3회, 리포스트 2회" — counts of ledger-observed actions (회 = times acted, not verified reach). */
export function automationOutwardSummary(outward: AutomationRunDigest["outward"], locale: "ko" | "en"): string {
  const parts = OUTWARD_ORDER.filter((kind) => (outward[kind] ?? 0) > 0)
    .map((kind) => locale === "ko" ? `${OUTWARD_WORDS[kind].ko} ${outward[kind]}회` : `${outward[kind]} ${OUTWARD_WORDS[kind].en}`);
  return parts.join(", ");
}

export function automationOutwardWord(kind: AutomationOutwardKind, locale: "ko" | "en"): string {
  return locale === "ko" ? OUTWARD_WORDS[kind].ko : OUTWARD_WORDS[kind].en;
}

/** One line per action row — the work block's verbs ("페이지 읽음", "실행함", "웹 검색함"). */
export function automationActionLine(row: AutomationActionRow, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  const times = row.count > 1 ? (ko ? ` ${row.count}회` : ` ×${row.count}`) : "";
  const site = row.domain ? `${row.domain} · ` : "";
  const label = row.label ? ` “${row.label}”` : "";
  if (row.outward) return `${site}${OUTWARD_VERBS[row.kind as AutomationOutwardKind][locale]}`;
  switch (row.kind) {
    case "navigate": return `${site}${ko ? "페이지 열어봄" : "Opened page"}${times}`;
    case "read": return row.family === "browser" || row.family === "computer"
      ? `${site}${ko ? "화면 확인함" : "Checked the page"}${times}`
      : `${ko ? "읽음" : "Read"} · ${row.toolLeaf}${times}`;
    case "search": return `${ko ? "웹 검색함" : "Searched the web"}${times}`;
    case "click": return `${site}${ko ? "누름" : "Clicked"}${label}`;
    case "type": return `${site}${ko ? `입력함 · ${row.typedChars ?? 0}자` : `Typed ${row.typedChars ?? 0} chars`}`;
    case "command": return `${ko ? "명령 실행함" : "Ran a command"}${times}`;
    case "time": return `${ko ? "현재 시각 확인" : "Checked the time"}${times}`;
    case "image": return ko ? "이미지 생성함" : "Generated an image";
    case "file": return `${ko ? "파일 작성함" : "Wrote a file"} · ${row.toolLeaf}${times}`;
    default: return `${ko ? "호출함" : "Called"} · ${row.toolLeaf}${times}`;
  }
}

/** Headline for a finished run: "Threads 답글 3회, 리포스트 2회" or "Threads 확인만 함". */
export function automationRunHeadline(digest: Pick<AutomationRunDigest, "outward" | "outwardTotal" | "sites" | "toolCalls" | "outwardActivityCoverage"> & { status?: string }, locale: "ko" | "en"): string {
  const site = digest.sites[0] ? siteDisplayName(digest.sites[0].domain) : "";
  if (digest.outwardTotal > 0) return `${site ? `${site} ` : ""}${automationOutwardSummary(digest.outward, locale)}`;
  if (digest.status === "running") return locale === "ko" ? `${site ? `${site} ` : ""}진행 중 · 도구 ${digest.toolCalls}회` : `${site ? `${site} ` : ""}in progress · ${digest.toolCalls} tool calls`;
  if (digest.status === "ok") {
    if (digest.outwardActivityCoverage !== "complete") return locale === "ko" ? "외부 동작 측정 불가" : "Outward activity unknown";
    return locale === "ko"
      ? `기록된 외부 동작 없음 · 도구 ${digest.toolCalls}회`
      : `No outward activity recorded · ${digest.toolCalls} tool calls`;
  }
  if (digest.toolCalls === 0) return locale === "ko" ? "도구 사용 없음" : "No tool activity";
  return locale === "ko" ? `${site ? `${site} ` : ""}확인만 함 · 도구 ${digest.toolCalls}회` : `${site ? `${site} ` : ""}checked only · ${digest.toolCalls} tool calls`;
}
