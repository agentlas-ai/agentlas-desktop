import { redactSecrets } from "../../shared/secret-patterns";
import {
  canonicalAskFenceText,
  extractAskFences,
  flattenAskFences,
  type AgentlasAskQuestion,
} from "../../shared/ask-fence-flatten";
import { stripStrayProtocolTokens } from "../../shared/protocol-token-strip";

export const WORK_SUMMARY_MAX_SENTENCES = 2;
export const WORK_SUMMARY_MAX_CHARS_CJK = 120;
export const WORK_SUMMARY_MAX_CHARS_LATIN = 180;

const ABSOLUTE_PATH_RE =
  /(?:file:\/\/)?(?:\/(?:Users|home|Volumes|private|var|tmp|opt|usr|etc)\/[^\s"'`)\]}>,;]+)/gi;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

function cleanSource(raw: string): string[] {
  // Mask credentials on the whole text before anything cuts it up: a value such as `p.ssw0rd` or a JWT contains the "."
  // the sentence splitter breaks on, and the halves no longer match any secret pattern.
  const text = redactSecrets(String(raw ?? ""))
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`([^`\n]{1,160})`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(ABSOLUTE_PATH_RE, "[local path]")
    .replace(WINDOWS_PATH_RE, "[local path]")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\r/g, "\n");

  return text
    .split(/\n+/)
    .map((line) => line
      .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s*/, "")
      .replace(/[*_~]+/g, "")
      .replace(/\s+/g, " ")
      .trim())
    // Markup removal can join a credential key to its value (`**password**: x`), so mask the cleaned line as well.
    .map((line) => redactSecrets(line))
    .filter(Boolean);
}

function splitSentences(lines: string[]): string[] {
  const sentences: string[] = [];
  for (const line of lines) {
    const parts = line.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/g) ?? [line];
    for (const part of parts) {
      // cleanSource already masked the whole text; this only backstops a line that reaches here another way.
      const value = redactSecrets(part).replace(/\s+/g, " ").trim();
      if (value) sentences.push(value);
    }
  }
  return sentences;
}

/**
 * Structure only: the first distinct sentences, in order, up to the cap. The host
 * does not score sentences by wording (no action/meta/request vocabulary); which
 * outcome to report is the producing model's turn_summary, which is accepted as
 * written. Deterministic checks are secret/path redaction and length caps.
 */
function pickSentences(sentences: string[]): string[] {
  const selected: string[] = [];
  for (const text of sentences) {
    if (selected.some((item) => item === text)) continue;
    selected.push(text);
    if (selected.length >= WORK_SUMMARY_MAX_SENTENCES) break;
  }
  return selected;
}

function truncateSummary(value: string): string {
  const maxChars = CJK_RE.test(value)
    ? WORK_SUMMARY_MAX_CHARS_CJK
    : WORK_SUMMARY_MAX_CHARS_LATIN;
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, maxChars - 1);
  const wordBoundary = CJK_RE.test(value) ? slice.length : slice.lastIndexOf(" ");
  const end = wordBoundary >= Math.floor(maxChars * 0.7)
    ? slice.slice(0, wordBoundary)
    : slice;
  return `${end.trimEnd()}…`;
}

function summarizeQuestions(
  questions: AgentlasAskQuestion[],
  locale: "ko" | "en",
): string {
  const plainText = flattenAskFences(canonicalAskFenceText(questions), locale);
  const value = splitSentences(cleanSource(plainText)).join(" ");
  return value ? truncateSummary(value) : "";
}

/**
 * Produces the customer-facing project timeline label. Raw PM Soul, code maps,
 * chat transcripts, and logs are never returned: at most two outcome sentences
 * cross this boundary, with a strict script-aware character cap.
 */
export function summarizeCompletedWork(
  raw: string | null | undefined,
  fallback = "작업 기록",
  locale: "ko" | "en" = "ko",
): string {
  const source = stripStrayProtocolTokens(String(raw ?? ""));
  const extracted = extractAskFences(source);
  if (extracted.questions.length > 0) {
    return summarizeQuestions(extracted.questions, locale);
  }
  const candidates = splitSentences(cleanSource(extracted.text));
  const selected = pickSentences(candidates);
  const fallbackCandidates = splitSentences(cleanSource(fallback));
  const value = selected.join(" ")
    || fallbackCandidates[0]
    || "";
  return value ? truncateSummary(value) : "";
}
