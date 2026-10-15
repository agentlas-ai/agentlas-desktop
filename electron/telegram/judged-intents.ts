// Judged Telegram message intents. The connected model decides by meaning inside the
// async message handler. There is NO lexical fallback: when no model answers, the
// result is neutral (report intent "none", write=false -> read-only). Only a
// structured `/reports on|off|status` command decides without a model.
//
// Two decisions live here:
//  1. automation-report control ("turn completion reports on/off / what's the status")
//     — formerly AND-of-wordlists predicates (removed, 2026-10-13 owner rule).
//  2. invocation goal mode ("make/build/modify something" → write vs a read-only
//     question) — formerly a single make-verb wordlist (removed).

import { judge, judgeBoolean, type JudgeSpec, type Verdict } from "../system-agents/judgment";

export type TelegramAutomationReportIntent = "enable" | "disable" | "status" | "none";

const REPORT_INTENT_LABELS = ["enable", "disable", "status", "none"] as const;

/**
 * Structured command, the only deterministic path: `/reports on|off|status`
 * (optionally `@botname`). The whole message must be exactly that command; free
 * text around it, quotes or negation make it not a command (-> model judges).
 */
export function parseTelegramReportCommand(text: string): TelegramAutomationReportIntent | null {
  const match = /^\/reports(?:@\w+)?\s+(on|off|status)\s*$/i.exec(text.trim());
  if (!match) return null;
  const arg = match[1].toLowerCase();
  return arg === "on" ? "enable" : arg === "off" ? "disable" : "status";
}

export type TelegramJudge = (
  spec: JudgeSpec<TelegramAutomationReportIntent>,
) => Promise<Verdict<TelegramAutomationReportIntent>>;

/**
 * The model decides whether the message is an automation-report control command.
 * No model / timeout = neutral "none" labeled source "fallback" (callers must not act
 * on it). A structured `/reports ...` command returns source "command".
 */
export async function resolveTelegramAutomationReportIntent(
  text: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; judgeFn?: TelegramJudge } = {},
): Promise<{ intent: TelegramAutomationReportIntent; source: "llm" | "fallback" | "command" }> {
  const command = parseTelegramReportCommand(text);
  if (command) return { intent: command, source: "command" };
  if (!text.trim()) return { intent: "none", source: "fallback" };
  const run = opts.judgeFn ?? judge;
  const verdict = await run({
    kind: "telegram-automation-report-intent",
    question:
      "In this Telegram message, is the user asking to TURN ON automatic automation-completion reports in this chat (enable), TURN them OFF (disable), CHECK whether they are on (status), or none of these (an ordinary request or question)?",
    labels: REPORT_INTENT_LABELS,
    input: text.slice(0, 2_000),
    guidance:
      "An ordinary work request that merely mentions automation is \"none\". Negated, quoted or hypothetical mentions are \"none\". The command may be phrased in any language.",
    hints: [
      { label: "enable", words: ["자동화 끝나면 알려줘", "앞으로 보고해", "notify me when the automation finishes", "report here from now on"] },
      { label: "disable", words: ["자동화 보고 꺼", "알림 그만", "stop automation reports", "turn off notifications"] },
      { label: "status", words: ["자동화 보고 상태", "알림 켜져 있어?", "are automation reports on", "report status"] },
    ],
    fallback: "none",
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 6_000,
  });
  return { intent: verdict.verdict, source: verdict.source };
}

/**
 * The model decides whether the message asks to make/build/modify something
 * (write) or is read-only. No model = write:false (read-only), labeled "fallback".
 */
export async function resolveTelegramGoalIntent(
  text: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    judgeBooleanFn?: typeof judgeBoolean;
  } = {},
): Promise<{ write: boolean; source: "llm" | "fallback" }> {
  if (!text.trim()) return { write: false, source: "fallback" };
  const run = opts.judgeBooleanFn ?? judgeBoolean;
  const { value, verdict } = await run({
    kind: "telegram-invocation-goal-mode",
    question:
      "Does this Telegram message ask the agent to CREATE, BUILD, or MODIFY something concrete (files, a website/app, code, a deployment, an automation), rather than asking a question or requesting read-only research/summaries?",
    input: text.slice(0, 2_000),
    guidance:
      "Verbs like 'make'/'만들' can appear inside read-only questions, negations or quotes " +
      "('what makes a good landing page?'), and a genuine build request may use no reference verb at all — judge the meaning in any language.",
    hints:
      "words that may hint write intent: 만들, 제작, 구현, 수정, 고쳐, 배포, 웹사이트, 랜딩, 앱, create, make, build, implement, fix, deploy, website, app, dashboard, prototype, automation",
    fallback: false,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 6_000,
  });
  return { write: value, source: verdict.source };
}
