// 브리핑 인터뷰 모드 설정 — 모호한 실행형 요청 앞에 시스템이 배치 질문을 강제할지.
//   smart      : 챗에서도 모호하면 인터뷰(1배치 3-5문항). 명확/사소한 요청은 질문 0개.
//   build-only : Build 메뉴에서만 인터뷰(기본값 — 챗 UX 보호, 텔레메트리 확인 후 smart 승격 예정).
//   off        : 어디서도 시스템이 강제하지 않음(에이전트 재량 ask만 남음).
import { getMeta, setMeta } from "./meta";

const META_KEY = "interview_mode";

export type InterviewMode = "smart" | "build-only" | "off";

const VALID: InterviewMode[] = ["smart", "build-only", "off"];

export function getInterviewMode(): InterviewMode {
  const raw = String(getMeta(META_KEY) ?? "");
  return (VALID as string[]).includes(raw) ? (raw as InterviewMode) : "build-only";
}

export function setInterviewMode(mode: InterviewMode): InterviewMode {
  const next = (VALID as string[]).includes(mode) ? mode : "build-only";
  setMeta(META_KEY, next);
  return next as InterviewMode;
}

/** 이번 사용자 입력이 '사소함'이라 인터뷰 게이트 주입 자체를 건너뛰는가.
 *  하드 어서션: trivial 턴엔 질문 0개 — 판단 비용조차 쓰지 않는다. */
export function isTrivialPrompt(userPrompt: string): boolean {
  const text = (userPrompt ?? "").trim();
  if (!text) return true;
  // 짧은 인사/단답/리액션
  if (text.length < 15) return true;
  // 슬래시 커맨드/멘션 지시는 이미 의도가 구조화돼 있음
  if (text.startsWith("/") || text.startsWith("@")) return true;
  // 순수 질문(정보 요청)은 실행형이 아님 — 에이전트가 그냥 답하면 된다
  if (/[?？]\s*$/.test(text) && text.length < 120) return true;
  // 구체 참조(파일경로/URL/코드블록)가 있으면 이미 스코프가 잡힌 요청
  if (/https?:\/\/|\.[a-z]{2,4}(\s|$)|\//.test(text) && text.length > 40) return false;
  return false;
}
