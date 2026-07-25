// Judged Telegram message intents. The connected model decides by meaning inside the
// async message handler; the English/Korean wordlists below are demoted to hints and
// remain only the labeled fallback (today's regex verdict) when no model answers.
//
// Two decisions live here:
//  1. automation-report control ("turn completion reports on/off / what's the status")
//     — previously three AND-of-wordlists predicates that missed every other language
//     and could swallow ordinary work requests that merely mentioned automation.
//  2. invocation goal mode ("make/build/modify something" → write + goal mode vs a
//     read-only question) — previously a single make-verb wordlist.

import { judge, judgeBoolean, type JudgeSpec, type Verdict } from "../system-agents/judgment";

export type TelegramAutomationReportIntent = "enable" | "disable" | "status" | "none";

const REPORT_INTENT_LABELS = ["enable", "disable", "status", "none"] as const;

/** Today's deterministic verdict — reference/fallback only, never the final decider. */
export function lexicalAutomationReportIntent(text: string): TelegramAutomationReportIntent {
  const mentionsReport = /자동화|automation/i.test(text) && /보고|알림|notify|notification|report/i.test(text);
  if (mentionsReport && /상태|켜져|켜짐|꺼져|확인|status|on|off/i.test(text)) return "status";
  if (mentionsReport && /꺼|끄|중지|그만|stop|off|disable/i.test(text)) return "disable";
  const mentionsAutomation = /자동화|automation|scheduled job|background job/i.test(text);
  const wantsNotification =
    /보고|알림|알려|말해|보내|띄워|전달|브리핑|notify|notification|report|tell|send|post|brief/i.test(text);
  const completion =
    /끝나|끝났|끝날|끝나고|끝나면|완료|마치|complete|completed|done|finish|finished|after/i.test(text);
  const future =
    /앞으로|이제부터|계속|마다|될 때|할 때|whenever|from now|future|every time/i.test(text);
  const thisChat =
    /여기|이 방|이방|이 채팅|텔레|telegram|dm|나한테|this chat|here|to me/i.test(text.toLowerCase());
  if (mentionsAutomation && wantsNotification && (completion || future || thisChat)) return "enable";
  return "none";
}

export type TelegramJudge = (
  spec: JudgeSpec<TelegramAutomationReportIntent>,
) => Promise<Verdict<TelegramAutomationReportIntent>>;

/**
 * The model decides whether the message is an automation-report control command.
 * Fallback (no model / timeout) = today's regex verdict, labeled by source.
 */
export async function resolveTelegramAutomationReportIntent(
  text: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; judgeFn?: TelegramJudge } = {},
): Promise<{ intent: TelegramAutomationReportIntent; source: "llm" | "fallback" }> {
  const lexical = lexicalAutomationReportIntent(text);
  if (!text.trim()) return { intent: lexical, source: "fallback" };
  const run = opts.judgeFn ?? judge;
  const verdict = await run({
    kind: "telegram-automation-report-intent",
    question:
      "In this Telegram message, is the user asking to TURN ON automatic automation-completion reports in this chat (enable), TURN them OFF (disable), CHECK whether they are on (status), or none of these (an ordinary request or question)?",
    labels: REPORT_INTENT_LABELS,
    input: text.slice(0, 2_000),
    guidance:
      `A deterministic pre-pass classified this as "${lexical}". Treat that as a prior, not a fact. ` +
      "An ordinary work request that merely mentions automation is \"none\". The command may be phrased in any language.",
    hints: [
      { label: "enable", words: ["자동화 끝나면 알려줘", "앞으로 보고해", "notify me when the automation finishes", "report here from now on"] },
      { label: "disable", words: ["자동화 보고 꺼", "알림 그만", "stop automation reports", "turn off notifications"] },
      { label: "status", words: ["자동화 보고 상태", "알림 켜져 있어?", "are automation reports on", "report status"] },
    ],
    fallback: lexical,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 6_000,
  });
  return { intent: verdict.verdict, source: verdict.source };
}

/**
 * The model decides whether the message asks to make/build/modify something
 * (write + goal mode) or is read-only. Fallback = today's verb-wordlist verdict.
 */
export async function resolveTelegramGoalIntent(
  text: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    judgeBooleanFn?: typeof judgeBoolean;
  } = {},
): Promise<{ write: boolean; source: "llm" | "fallback" }> {
  const lexical = lexicalTelegramWriteIntent(text);
  if (!text.trim()) return { write: lexical, source: "fallback" };
  const run = opts.judgeBooleanFn ?? judgeBoolean;
  const { value, verdict } = await run({
    kind: "telegram-invocation-goal-mode",
    question:
      "Does this Telegram message ask the agent to CREATE, BUILD, or MODIFY something concrete (files, a website/app, code, a deployment, an automation), rather than asking a question or requesting read-only research/summaries?",
    input: text.slice(0, 2_000),
    guidance:
      `A deterministic pre-pass classified this as ${lexical ? "a make/modify request" : "a read-only request"}. ` +
      "Treat that as a prior, not a fact. Verbs like 'make'/'만들' can appear inside read-only questions " +
      "('what makes a good landing page?'), and a genuine build request may use no reference verb at all — judge the meaning in any language.",
    hints:
      "words that may hint write intent: 만들, 제작, 구현, 수정, 고쳐, 배포, 웹사이트, 랜딩, 앱, create, make, build, implement, fix, deploy, website, app, dashboard, prototype, automation",
    fallback: lexical,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 6_000,
  });
  return { write: value, source: verdict.source };
}

/** Today's make-something verb wordlist — reference/fallback only. */
export function lexicalTelegramWriteIntent(text: string): boolean {
  return /만들|제작|구현|개발|코딩|빌드|생성|작성|수정|고쳐|고치|배포|웹|웹사이트|사이트|랜딩|페이지|앱|대시보드|프로토타입|자동화|create|make|build|implement|code|write|edit|fix|deploy|website|web\s*app|site|landing|page|dashboard|prototype|automation/i.test(
    text,
  );
}
