export type OneRequestIntent = "conversation" | "task";

const PLAIN_SOCIAL_RE = /^(?:안녕(?:하세요)?|하이|헬로|반가워요?|고마워요?|감사(?:합니다|해요?)?|응|넵?|네|예|좋아요?|오케이|ㅇㅋ|ㄱㅅ|ㅋ+|ㅎ+|hi|hello|hey|thanks?|thank you|okay|ok|bye|test|테스트)[!.~^\s]*$/i;

const KOREAN_WORK_RE = /(?:계획|일정|동선|여행\s*가이드|가이드라인|예산|체크\s*리스트|준비물|문제(?:집)?\s*해설|풀이|영어\s*(?:공부|회화|학습)|학습\s*계획|제품\s*(?:찾기|검색|비교|추천)|최저\s*(?:가격|가)|가격\s*(?:검색|비교)|보고서|문서|워드|word|엑셀|excel|스프레드시트|표|프레젠테이션|발표자료|사진|이미지|영상|비디오|자막|콘텐츠|작성|만들|제작|찾아|검색|조사|리서치|추천|비교|정리|분석|요약|번역|검토|수정|고쳐|계산|설계|기획|예약\s*후보)/i;

const ENGLISH_WORK_RE = /(?:\b(?:plan|itinerary|route|budget|checklist|guide|worksheet|study\s+plan|lesson|explain\s+the\s+(?:problem|answer)|product\s+(?:search|comparison|recommendation)|price\s+(?:search|comparison)|lowest\s+price|report|document|word\s+file|spreadsheet|excel|table|presentation|slides?|image|photo|video|captions?|content)\b|^\s*(?:write|create|make|build|find|search|research|recommend|compare|organize|analyse|analyze|summarize|translate|review|revise|fix|calculate|design|draft|prepare|explain)\b)/i;

const KOREAN_REQUEST_ENDING_RE = /(?:해\s*줘|해주세요|해\s*주세요|해봐|해\s*봐|만들어\s*줘|짜\s*줘|찾아\s*줘|알아봐\s*줘|부탁해)(?:요)?[.!?\s]*$/i;

/**
 * Product intent only: decide whether One should preserve the turn as durable
 * work or answer it as an ordinary conversation. This does not choose agents,
 * authorize tools, or infer that a result is complete.
 */
export function classifyOneRequestIntent(prompt: string): OneRequestIntent {
  if (typeof prompt !== "string") return "conversation";
  const normalized = prompt.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || PLAIN_SOCIAL_RE.test(normalized)) return "conversation";

  const hasWorkSignal = KOREAN_WORK_RE.test(normalized) || ENGLISH_WORK_RE.test(normalized);
  if (hasWorkSignal || KOREAN_REQUEST_ENDING_RE.test(normalized)) return "task";

  // Long, constrained requests are work even when the user uses unfamiliar
  // nouns. Short factual or conversational questions remain conversations.
  const hasConstraint = /(?:\d[\d,.]*\s*(?:원|만원|달러|usd|krw|%|일|주|개월|년|명|개)|예산|기한|마감|조건|기준|between|under|over|budget|deadline|criteria)/i.test(normalized);
  return normalized.length >= 100 && hasConstraint ? "task" : "conversation";
}
