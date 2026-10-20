/**
 * 메모리 후보를 사용자의 말로 풀어 쓴다.
 *
 * 저장된 학습 문장에는 내부 식별자(시도 ID·UUID·단계 태그)가 섞여 있어 사용자에게는 의미가 없다.
 * 화면은 "원래 무엇을 하던 에이전트인지 → 무엇을 배웠는지"를 보여 주고, 반영 효과는 변경안의 전후 카드(실제 기록 기반)로만 보여 준다.
 * 해시·supersedes 같은 기록은 접어 둔 '기술 정보'로 내린다. 원문은 바꾸지 않는다(표시 전용).
 */

const KIND_KO: Record<string, string> = {
  procedure: "작업 방식", fact: "알게 된 사실", preference: "선호", decision: "정해진 결정", risk: "주의할 점", hypothesis: "추정(확인 전)",
};
const KIND_EN: Record<string, string> = {
  procedure: "How to work", fact: "Learned fact", preference: "Preference", decision: "Decision", risk: "Watch out", hypothesis: "Unconfirmed guess",
};

export function memoryKindLabel(kind: string, ko: boolean): string {
  return (ko ? KIND_KO : KIND_EN)[kind] ?? kind;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ATTEMPT_ID = /\battempt[_-][0-9a-z-]{6,}\b/gi;
const LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
const STEP_TAG_MANY = /\bt\d{1,2}(?:\s*[-·~,/]\s*t?\d{1,2})+([는은이가을를의와과도로에])?/g;
const STEP_TAG_ONE = /\bt\d{1,2}(?=[는은이가을를의와과도로에]|\b)/g;

/** 내부 식별자를 걷어 낸 읽을 수 있는 문장. 걷어 낸 자리는 자연어로 메운다. */
export function plainMemoryText(text: string, ko: boolean): string {
  const attempt = ko ? "이전 시도" : "an earlier attempt";
  const id = ko ? "내부 기록" : "an internal record";
  const step = ko ? "이전 작업" : "an earlier task";
  const steps = ko ? "여러 이전 작업" : "several earlier tasks";
  const cleaned = text
    .replace(ATTEMPT_ID, attempt)
    .replace(UUID, id)
    .replace(LONG_HEX, id)
    .replace(STEP_TAG_MANY, (_all, particle?: string) => `${steps}${({ 는: "은", 은: "은", 이: "이", 가: "이", 을: "을", 를: "을" } as Record<string, string>)[particle ?? ""] ?? particle ?? ""}`)
    .replace(STEP_TAG_ONE, step)
    .replace(/\s{2,}/g, " ")
    .trim();
  // 연속 치환으로 같은 말이 겹친 곳("이전 시도, 이전 시도")을 한 번으로 줄인다.
  return [attempt, id, step, steps].reduce((acc, phrase) => acc.replace(new RegExp(`${phrase}(?:\\s*(?:,|및|와|과|·|\\/|-)\\s*${phrase})+`, "g"), phrase), cleaned);
}

/** 목록용 한 줄 제목: 첫 문장을 읽기 좋게 자른다. */
export function plainMemoryTitle(text: string, ko: boolean, limit = 64): string {
  const plain = plainMemoryText(text, ko);
  const first = plain.split(/(?<=[.。!?])\s|\n/)[0] ?? plain;
  return first.length > limit ? `${first.slice(0, limit - 1).trimEnd()}…` : first;
}

/** 근거 줄 중 사용자에게 의미 있는 것만(해시·supersedes·dreaming 기록 제외). */
export function isTechnicalEvidence(line: string): boolean {
  const text = line.trim();
  return /^(supersedes|dreaming|source|hash|digest|ticket)\s*:/i.test(text) || !/\s/.test(text) && /[0-9a-f]{12,}/i.test(text);
}
