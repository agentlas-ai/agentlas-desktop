import { redactSecrets } from "../../shared/secret-patterns";

export const WORK_SUMMARY_MAX_SENTENCES = 2;
export const WORK_SUMMARY_MAX_CHARS_CJK = 120;
export const WORK_SUMMARY_MAX_CHARS_LATIN = 180;

const ABSOLUTE_PATH_RE =
  /(?:file:\/\/)?(?:\/(?:Users|home|Volumes|private|var|tmp|opt|usr|etc)\/[^\s"'`)\]}>,;]+)/gi;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g;
const ACTION_RE =
  /(?:구현|수정|추가|삭제|제거|연결|검증|정리|개선|변경|완료|복구|배포|작성|적용|교체|구축|분리|차단|해결|통과|고정|전환|축소|보존|저장|생성|반영|implement|fix(?:ed)?|add(?:ed)?|remov(?:e|ed)|connect(?:ed)?|verif(?:y|ied)|updat(?:e|ed)|chang(?:e|ed)|complet(?:e|ed)|build|built|restore(?:d)?|deploy(?:ed)?|creat(?:e|ed)|replac(?:e|ed)|resolv(?:e|ed)|pass(?:ed)?)/i;
const META_RE =
  /^(?:맞습니다|죄송(?:합니다|해요)?|확인(?:했습니다|했어요)[.!]?|네(?:[,.!]|\s|$)|사용\s*(?:스킬|에이전트)\s*:|skills used\s*:|agents used\s*:|you(?:'re| are) right|correct[,.!]|i checked[,.!])/i;
const REQUEST_RE =
  /(?:해\s*줘|해주세요|바꿔|고쳐|해라|하라|원해|해야\s*해|please\s+(?:fix|add|remove|change|build|update))\s*[.!?。！？]?$/i;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

type RankedSentence = {
  index: number;
  score: number;
  text: string;
};

function cleanSource(raw: string): string[] {
  const text = String(raw ?? "")
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
    .filter(Boolean);
}

function splitSentences(lines: string[]): string[] {
  const sentences: string[] = [];
  for (const line of lines) {
    const parts = line.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/g) ?? [line];
    for (const part of parts) {
      const value = redactSecrets(part).replace(/\s+/g, " ").trim();
      if (value) sentences.push(value);
    }
  }
  return sentences;
}

function sentenceScore(text: string): number {
  let score = 0;
  if (ACTION_RE.test(text)) score += 6;
  if (text.length >= 18) score += 2;
  if (text.length >= 36) score += 1;
  if (META_RE.test(text)) score -= 8;
  if (REQUEST_RE.test(text)) score -= 6;
  if (text.length < 9) score -= 3;
  return score;
}

function pickSentences(sentences: string[]): string[] {
  const ranked: RankedSentence[] = sentences.map((text, index) => ({
    index,
    score: sentenceScore(text),
    text,
  }));
  const actionable = ranked
    .filter((item) => item.score > 1)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const fallback = ranked
    .filter((item) => !META_RE.test(item.text))
    .sort((left, right) => left.index - right.index);
  const pool = actionable.length > 0 ? actionable : fallback;
  const selected: RankedSentence[] = [];
  for (const candidate of pool) {
    if (selected.some((item) =>
      item.text === candidate.text
      || item.text.includes(candidate.text)
      || candidate.text.includes(item.text))) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= WORK_SUMMARY_MAX_SENTENCES) break;
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text);
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

/**
 * Produces the customer-facing project timeline label. Raw PM Soul, code maps,
 * chat transcripts, and logs are never returned: at most two outcome sentences
 * cross this boundary, with a strict script-aware character cap.
 */
export function summarizeCompletedWork(raw: string | null | undefined, fallback = "작업 기록"): string {
  const candidates = splitSentences(cleanSource(String(raw ?? "")));
  const selected = pickSentences(candidates);
  const fallbackCandidates = splitSentences(cleanSource(fallback));
  const value = selected.join(" ")
    || fallbackCandidates[0]
    || "";
  return value ? truncateSummary(value) : "";
}
