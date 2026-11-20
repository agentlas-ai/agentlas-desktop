// One honest line per resumed run per start. At start the app takes interrupted runs up by itself (startup-checkpoints.ts);
// before this the person only saw the answer appear. Pure over injected stores so a plain-Node gate covers it.

export interface StartupResumeResult { runId: string; status: "started" | "scheduled" | "skipped"; reason: string }

export function startupResumeText(locale: "ko" | "en"): string {
  return locale === "ko" ? "앱이 다시 켜져서 멈췄던 작업을 이어서 해요" : "The app restarted, so I am picking the interrupted work back up";
}

export function startupResumeSummaryText(locale: "ko" | "en", count: number): { title: string; body: string } {
  return locale === "ko"
    ? { title: "Agentlas", body: `앱이 다시 켜져서 멈췄던 작업 ${count}개를 이어서 하고 있어요. 각 대화에서 멈출 수 있어요.` }
    : { title: "Agentlas", body: `The app restarted and is picking ${count} interrupted tasks back up. Each conversation has a Stop.` };
}

/**
 * Appends the line to the conversation of every run that was STARTED (not scheduled or skipped: those say nothing new) and returns the
 * chats told. One line per run per call; the caller is the single startup path, so a start announces once. Never throws.
 */
export function announceStartupResumes(results: readonly StartupResumeResult[], deps: {
  rootChatId(runId: string): string | null;
  append(chatId: string, text: string, runId: string): void;
  locale: "ko" | "en";
}): string[] {
  const told: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.status !== "started" || seen.has(result.runId)) continue;
    seen.add(result.runId);
    try {
      const chatId = deps.rootChatId(result.runId);
      if (!chatId) continue;
      deps.append(chatId, startupResumeText(deps.locale), result.runId);
      told.push(chatId);
    } catch { /* a missing line never blocks the resume */ }
  }
  return told;
}
