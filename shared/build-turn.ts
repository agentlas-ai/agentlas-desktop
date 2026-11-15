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
    if (questions.length >= 64) break;
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

// ---------------------------------------------------------------------------------------------------------------------------------
// A saved Build conversation as the next turn's input (Agentlas 2.0 PB-D, contracts/phone-build2.md section 4).
// The Build screen restores a saved conversation with these functions (renderer/lib/build-session.ts) and Main builds a phone's turn with the same ones,
// so "what history does the next turn carry" has one definition. Types are structural: nothing here imports Main or the renderer.

/** The fields of a saved Build conversation row (builder-conversation-store.ts `StoredBuilderConversation`) these functions read. */
export interface SavedBuildTurnLike {
  request: string;
  history: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  terminalText: string | null;
  hostAuthoredContinuation: boolean;
  conversationTurn: number | null;
  supplementalQuestion: unknown;
  status: "waiting-user" | "completed" | "unknown" | "stopped";
  mode: "single" | "team" | "package" | null;
}

const OPENCRAB_QUESTION_ID = "opencrab-ontology";

export interface OpenCrabSupplementalQuestion {
  id: typeof OPENCRAB_QUESTION_ID;
  question: string;
  header: "OpenCrab";
  multiSelect: false;
  options: Array<{ label: string; description?: string }>;
}

/** The one question Main itself adds to an interview (the OpenCrab ontology choice), validated; anything else is not a question. */
export function openCrabQuestionOf(value: unknown): OpenCrabSupplementalQuestion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { kind?: unknown; question?: unknown; options?: unknown };
  if (
    candidate.kind !== OPENCRAB_QUESTION_ID ||
    typeof candidate.question !== "string" ||
    !candidate.question.trim() ||
    !Array.isArray(candidate.options) ||
    candidate.options.length !== 2
  ) return null;
  const options = candidate.options.map((option: { label?: unknown; description?: unknown } | null) => ({
    label: typeof option?.label === "string" ? option.label.trim() : "",
    description: typeof option?.description === "string" ? option.description.trim() : undefined,
  }));
  if (options.some((option) => !option.label)) return null;
  return { id: OPENCRAB_QUESTION_ID, question: candidate.question.trim(), header: "OpenCrab", multiSelect: false, options };
}

/** The line a supplemental question leaves at the end of the assistant's history entry. */
export function questionHistorySuffix(question: { question: string; options: ReadonlyArray<{ label: string }> } | null): string {
  if (!question) return "";
  return `\n\n[Agentlas supplemental question]\n${question.question}\n${question.options
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join("\n")}`;
}

/** The conversation of a saved Build as the history the next turn carries (what the Build screen rebuilds on restore). */
export function restoredBuildHistory(saved: SavedBuildTurnLike): Array<{ role: "user" | "assistant"; text: string }> {
  const history = saved.history.map((message) => ({ ...message }));
  if (saved.terminalText !== null) {
    const supplemental = saved.conversationTurn === 0 ? openCrabQuestionOf(saved.supplementalQuestion) : null;
    if (!saved.hostAuthoredContinuation) history.push({ role: "user", text: saved.request });
    history.push({ role: "assistant", text: saved.terminalText + questionHistorySuffix(supplemental) });
  } else if (!saved.hostAuthoredContinuation) {
    history.push({ role: "user", text: saved.request });
  }
  return history;
}

/** The turn number the Build screen continues from after a restore. */
export function restoredBuildTurn(saved: Pick<SavedBuildTurnLike, "conversationTurn" | "status">): number {
  return saved.conversationTurn === null ? 1 : saved.conversationTurn + (saved.status === "completed" ? 0 : 1);
}

/**
 * The next turn of a saved Build from a phone, from the saved head row alone (the phone sends only its text; contracts/phone-build2.md section 4):
 *  - `waiting-user`: the saved history plus this text is the answer; the runtime session is carried only when the row says it can resume;
 *  - a Build linked to an installed agent: a new session with no history in mode "package", the text is the request (the Build window's "Edit");
 *  - anything else (stopped, unfinished, completed without an agent): the saved history plus this text, a new session in the same folder, the saved mode.
 */
export function planPhoneBuildTurn(input: { saved: SavedBuildTurnLike; agentLinked: boolean; sessionResumable: boolean }): {
  kind: "answer" | "edit" | "resume";
  history: Array<{ role: "user" | "assistant"; text: string }>;
  mode: "single" | "team" | "package" | undefined;
  carrySession: boolean;
} {
  const { saved } = input;
  if (saved.status === "waiting-user") {
    return { kind: "answer", history: restoredBuildHistory(saved), mode: saved.mode ?? undefined, carrySession: input.sessionResumable };
  }
  if (input.agentLinked) return { kind: "edit", history: [], mode: "package", carrySession: false };
  return { kind: "resume", history: restoredBuildHistory(saved), mode: saved.mode ?? undefined, carrySession: false };
}
