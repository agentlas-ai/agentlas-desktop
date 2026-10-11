/**
 * 메모리 후보를 사용자의 말로 풀어 쓴다.
 *
 * 저장된 학습 문장에는 내부 식별자(시도 ID·UUID·단계 태그)가 섞여 있어 사용자에게는 의미가 없다.
 * 화면은 "원래 무엇을 하던 에이전트인지 → 무엇을 배웠는지 → 반영하면 무엇이 달라지는지"만 보여 주고,
 * 해시·supersedes 같은 기록은 접어 둔 '기술 정보'로 내린다. 원문은 바꾸지 않는다(표시 전용).
 */

const KIND_KO: Record<string, string> = {
  procedure: "작업 방식", fact: "알게 된 사실", preference: "선호", decision: "정해진 결정", risk: "주의할 점", hypothesis: "추정(확인 전)",
};
const KIND_EN: Record<string, string> = {
  procedure: "How to work", fact: "Learned fact", preference: "Preference", decision: "Decision", risk: "Watch out", hypothesis: "Unconfirmed guess",
};
const IMPACT_KO: Record<string, string> = {
  procedure: "비슷한 일을 만나면 이 순서와 기준대로 처리해, 같은 시행착오를 반복하지 않습니다.",
  fact: "이 사실을 이미 알고 시작하므로, 다시 확인하느라 시간을 쓰거나 틀린 가정으로 시작하지 않습니다.",
  preference: "묻지 않아도 사용자가 원하는 방식에 맞춰 결과를 냅니다.",
  decision: "이미 정해진 결정을 뒤집거나 다시 묻지 않고 그 위에서 이어 갑니다.",
  risk: "같은 위험을 만나면 미리 피하거나, 하기 전에 먼저 확인합니다.",
  hypothesis: "아직 확인되지 않은 추정이라, 반영하기 전에 사실인지 먼저 검토하는 편이 좋습니다.",
};
const IMPACT_EN: Record<string, string> = {
  procedure: "It follows this order and these criteria on similar work, so it stops repeating the same trial and error.",
  fact: "It starts out already knowing this, instead of re-checking or working from a wrong assumption.",
  preference: "It shapes results the way you like without being asked.",
  decision: "It builds on the decision instead of reopening or re-asking it.",
  risk: "It avoids this risk in advance, or checks first before acting.",
  hypothesis: "This is an unconfirmed guess; it is better to verify it before adding it.",
};

export function memoryKindLabel(kind: string, ko: boolean): string {
  return (ko ? KIND_KO : KIND_EN)[kind] ?? kind;
}
export function memoryImpact(kind: string, ko: boolean): string {
  return (ko ? IMPACT_KO : IMPACT_EN)[kind] ?? (ko ? "다음 실행부터 이 내용을 알고 시작합니다." : "From the next run it starts out knowing this.");
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
