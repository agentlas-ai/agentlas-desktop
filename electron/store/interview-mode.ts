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

/*
 * `isTrivialPrompt` 는 제거됐다 (2026-08-18).
 *
 * 판정 전부가 "15자 미만 · / 또는 @ 로 시작 · 물음표로 끝나고 120자 미만"이었다.
 * 실사용 558턴 측정에서 이런 단어·길이 신호의 재현율은 21.7%였고, "전체 검증해줘"
 * (11자)처럼 짧고 무거운 요청이 사소함으로 잘렸다. 브리핑 게이트의 판정자는 이제
 * 모델 하나뿐이고, 그 지시문이 "분명하면 아무것도 묻지 마라"를 이미 담고 있다.
 */
