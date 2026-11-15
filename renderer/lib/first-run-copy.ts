/*
 * First-run onboarding: the registered phrase table for the preference pills, the name suggestions and the
 * Korean particle / list helpers (Agentlas 2.0 F-D13, picture desktop-onboarding-instinct).
 *
 * The pill phrases end up in the personal agent's profile (profileContext for a "tone" pill, an operating
 * principle for a "rule" pill) and from there in model-bound text. They live HERE and nowhere else, so a wording
 * change is one edit. This file adds no prompt module and changes no composition order: the profile fields and the
 * way they are carried to the model are unchanged (docs/PROMPT-COMPOSITION-POLICY.md; composition ledger untouched).
 */

export interface FirstRunPill {
  id: string;
  /** tone -> the "personality and tone" field (profileContext); rule -> the "must-keep principles" field. */
  field: "tone" | "rule";
  ko: string;
  en: string;
  /** Pre-selected when the person has nothing saved yet (the picture's two dark pills). */
  preselected: boolean;
}

export const FIRST_RUN_PILLS: readonly FirstRunPill[] = [
  { id: "short", field: "tone", ko: "짧게 답하기", en: "Short answers", preselected: true },
  { id: "ask-first", field: "rule", ko: "큰 변경은 먼저 묻기", en: "Ask before big changes", preselected: true },
  { id: "sources", field: "rule", ko: "출처 보여 주기", en: "Show sources", preselected: false },
  { id: "formal", field: "tone", ko: "격식 있는 말투", en: "Formal tone", preselected: false },
];

/** Suggested agent names (picture: Luna / Milo / Sol / Nova). Examples to pick from, never a stored default. */
export const FIRST_RUN_NAME_SUGGESTIONS: readonly string[] = ["Luna", "Milo", "Sol", "Nova"];

export const pillText = (pill: FirstRunPill, ko: boolean): string => (ko ? pill.ko : pill.en);

/** One line per entry. A pill is "on" when a line of the field equals its text. */
export function fieldLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function togglePillInField(text: string, phrase: string): string {
  const lines = fieldLines(text);
  return (lines.includes(phrase) ? lines.filter((line) => line !== phrase) : [...lines, phrase]).join("\n");
}

/** Korean: does the last syllable carry a final consonant (batchim)? Latin / digits -> false. */
export function hasBatchim(word: string): boolean {
  const last = word.trim().slice(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

/** "Luna" -> "Luna예요", "민준" -> "민준이에요". */
export const withIyo = (name: string): string => `${name}${hasBatchim(name) ? "이에요" : "예요"}`;

/** "Codex" + "Claude Code" -> en "Codex and Claude Code" / ko "Codex와 Claude Code". */
export function joinNames(names: readonly string[], ko: boolean): string {
  if (names.length <= 1) return names[0] ?? "";
  const head = names.slice(0, -1);
  const last = names[names.length - 1];
  if (ko) return `${head.join(", ")}${hasBatchim(head[head.length - 1]) ? "과" : "와"} ${last}`;
  return head.length === 1 ? `${head[0]} and ${last}` : `${head.join(", ")} and ${last}`;
}

/** ko object particle: "Claude Code" -> "를". */
export const objectParticle = (word: string): string => (hasBatchim(word) ? "을" : "를");
