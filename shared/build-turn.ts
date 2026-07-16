/** A build is complete only when its final non-empty line is the package receipt. */
export function isCompletedBuildTurn(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const lastLine = text.replace(/\r/g, "").trimEnd().split("\n").at(-1) ?? "";
  return /^[ \t]*BUILD_COMPLETE[ \t]*:[ \t]*\S.*$/i.test(lastLine);
}

export interface BuildInterviewQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

/**
 * Parse only complete, structurally valid interview fences. This deliberately
 * returns plain model text; every remote surface must still sanitize and bound
 * each field before projection across its own trust boundary.
 */
export function extractBuildInterviewQuestions(text: unknown): BuildInterviewQuestion[] {
  if (typeof text !== "string") return [];
  const questions: BuildInterviewQuestion[] = [];
  const matches = text.matchAll(/<<agentlas-ask>>([\s\S]*?)<<\/agentlas-ask>>/g);
  for (const match of matches) {
    if (questions.length >= 7) break;
    const body = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      const raw = JSON.parse(body) as Record<string, unknown>;
      const question = typeof raw.question === "string" ? raw.question.trim() : "";
      const options = Array.isArray(raw.options)
        ? raw.options.flatMap((option) => {
            if (!option || typeof option !== "object" || Array.isArray(option)) return [];
            const value = option as Record<string, unknown>;
            const label = typeof value.label === "string" ? value.label.trim() : "";
            if (!label) return [];
            const description = typeof value.description === "string" ? value.description.trim() : "";
            return [{ label, ...(description ? { description } : {}) }];
          }).slice(0, 8)
        : [];
      if (!question || options.length < 2) continue;
      const header = typeof raw.header === "string" ? raw.header.trim() : "";
      questions.push({
        question,
        ...(header ? { header } : {}),
        options,
        multiSelect: raw.multiSelect === true,
      });
    } catch {
      // Malformed model fences never become trusted confirmation UI.
    }
  }
  return questions;
}
