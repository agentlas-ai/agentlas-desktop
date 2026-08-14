// Oberon — 게이트 단계 모델. 상단 스테퍼(00─06). 이전 단계를 완료하기 전엔 다음으로 못 넘어간다.
//
// 흐름: 사람이 소스 + 모델을 박는다 → BYOK CLI가 기획·대본·스토리보드(텍스트)를 생성·승인 →
//       카테고리별 고정 에셋 그룹 → 컷 이미지 병렬 생성 → 영상 병렬 생성 → 편집·납품.

import type { Locale } from "@/lib/i18n";

// ── i18n 접근자 ──────────────────────────────────────────
// 소비자가 step.about / s.tagline 등을 직접 읽는 기존 패턴이라 원본 필드는
// 그대로 두고(source of truth), 표시용 문자열만 이 헬퍼로 고른다.

/** ko/en 문자열 쌍에서 로케일에 맞는 값을 고른다. en이 없으면 ko로 폴백. */
export function stepText(ko: string, en: string | undefined, locale: Locale): string {
  return locale === "en" && en ? en : ko;
}

export type OberonStepId =
  | "setup"
  | "plan"
  | "storyboard"
  | "assets"
  | "keyframe"
  | "video"
  | "delivery";

export type StepState = "locked" | "active" | "done";

// 오베론 본체는 제작 콘솔 하나에서 애니메이션과 모션그래픽 포맷을 함께 담당한다.
export type OberonStudio = "animation";

export interface OberonStudioDef {
  id: OberonStudio;
  title: string;
  titleEn: string;
  tagline: string;
  taglineEn: string;
  /** 글리프 키 (icons.tsx Glyph). */
  glyph: string;
  blurb: string;
  blurbEn: string;
  /** 이 스튜디오가 노출하는 단계(순서). 나머지 7단계 중 검토 게이트는 건너뛴다. */
  steps: OberonStepId[];
}

export const OBERON_STUDIOS: OberonStudioDef[] = [
  {
    id: "animation",
    title: "제작",
    titleEn: "Production",
    tagline: "이미지 · 영상 · 모션",
    taglineEn: "Image · Video · Motion",
    glyph: "sparkle",
    blurb: "기획부터 납품까지 한 프로젝트로 이어지는 오베론 제작 흐름.",
    blurbEn: "The Oberon production flow from planning through delivery in one project.",
    steps: ["setup", "plan", "storyboard", "assets", "keyframe", "video", "delivery"],
  },
];

export interface OberonStepDef {
  id: OberonStepId;
  code: string; // "00".."06"
  title: string;
  titleEn: string;
  /** 글리프 키 (icons.tsx Glyph). */
  glyph: string;
  /** 색 키 (icons.tsx STEP_COLOR). */
  color: string;
  short: string; // 헤더 한 줄 설명
  shortEn: string;
  /** 이 단계를 완료(다음 잠금 해제)하는 액션 라벨. */
  gateLabel: string;
  gateLabelEn: string;
  /** 이 단계가 하는 일 (서브타이틀). */
  about: string;
  aboutEn: string;
  /** 사람이 직접 승인해야 하는 게이트인가. */
  humanGate: boolean;
}

export const OBERON_STEPS: OberonStepDef[] = [
  {
    id: "setup",
    code: "00",
    title: "소스 · 모델",
    titleEn: "Source · Model",
    glyph: "setup",
    color: "#5b5bd6",
    short: "프롬프트·레퍼런스·모델 스택 입력",
    shortEn: "Enter prompt, references, and model stack",
    gateLabel: "기획 생성 시작",
    gateLabelEn: "Start plan generation",
    about: "만들 영상의 컨셉과 소스(레퍼런스·에셋)를 넣고, 대본은 BYOK CLI·이미지/영상은 어떤 모델로 만들지 고릅니다.",
    aboutEn: "Enter the concept and sources (references, assets) for the video, and choose which BYOK CLI writes the script and which models generate the images and video.",
    humanGate: false,
  },
  {
    id: "plan",
    code: "01",
    title: "기획안",
    titleEn: "Plan",
    glyph: "plan",
    color: "#0b7285",
    short: "BYOK CLI가 쓴 트리트먼트·대본",
    shortEn: "Treatment and script written by your BYOK CLI",
    gateLabel: "기획 승인",
    gateLabelEn: "Approve plan",
    about: "선택한 CLI(Claude Code/Codex/Antigravity)가 로그라인·트리트먼트·비트를 작성합니다. 읽고 수정·승인하면 다음 단계가 열립니다.",
    aboutEn: "Your chosen CLI (Claude Code/Codex/Antigravity) writes the logline, treatment, and beats. Read, edit, and approve it to unlock the next step.",
    humanGate: true,
  },
  {
    id: "storyboard",
    code: "02",
    title: "스토리보드",
    titleEn: "Storyboard",
    glyph: "storyboard",
    color: "#1098ad",
    short: "씬·비트·샷 분해 (커버리지)",
    shortEn: "Scene / beat / shot breakdown (coverage)",
    gateLabel: "스토리보드 승인",
    gateLabelEn: "Approve storyboard",
    about: "기획을 씬→비트→샷으로 분해하고 카메라·전환을 붙입니다. 샷 보드를 확인·승인합니다.",
    aboutEn: "Breaks the plan down into scenes → beats → shots and attaches camera and transitions. Review and approve the shot board.",
    humanGate: true,
  },
  {
    id: "assets",
    code: "03",
    title: "고정 에셋",
    titleEn: "Locked Assets",
    glyph: "assets",
    color: "#2f9e44",
    short: "카테고리별 레퍼런스 묶음",
    shortEn: "Reference sets grouped by category",
    gateLabel: "에셋 확정",
    gateLabelEn: "Confirm assets",
    about: "인물·배경·소품을 카테고리로 나눠 사진 프롬프트 묶음(레퍼런스 시트)으로 만듭니다. 모든 샷이 이걸 참조해 일관성을 유지합니다.",
    aboutEn: "Groups characters, backgrounds, and props by category into photo-prompt reference sheets. Every shot references these to stay consistent.",
    humanGate: true,
  },
  {
    id: "keyframe",
    code: "04",
    title: "컷 이미지",
    titleEn: "Cut Images",
    glyph: "keyframe",
    color: "#e8590c",
    short: "샷별 첫/끝 프레임 병렬 생성",
    shortEn: "Parallel generation of first/last frames per shot",
    gateLabel: "컷 이미지 확정",
    gateLabelEn: "Confirm cut images",
    about: "샷마다 첫/끝 프레임을 이미지 엔진(Codex CLI·이미지 API)으로 병렬 생성합니다. 비싼 영상 호출 전에 구도·정체성을 먼저 락합니다.",
    aboutEn: "Generates each shot's first/last frames in parallel with an image engine (Codex CLI, image APIs). Locks composition and identity before the expensive video call.",
    humanGate: false,
  },
  {
    id: "video",
    code: "05",
    title: "영상 생성",
    titleEn: "Video Generation",
    glyph: "video",
    color: "#d6336c",
    short: "샷별 영상 병렬 생성 + QA",
    shortEn: "Parallel per-shot video generation + QA",
    gateLabel: "테이크 확정",
    gateLabelEn: "Confirm takes",
    about: "선택한 영상 엔진(Higgsfield·Seedance·Veo 등)으로 샷별 테이크를 병렬 생성하고, 자동 QA로 채점·선택합니다.",
    aboutEn: "Generates per-shot takes in parallel with your chosen video engine (Higgsfield, Seedance, Veo, etc.) and scores/selects them with automatic QA.",
    humanGate: false,
  },
  {
    id: "delivery",
    code: "06",
    title: "편집 · 납품",
    titleEn: "Edit · Delivery",
    glyph: "deliver",
    color: "#6741d9",
    short: "타임라인·멀티비율·산출물",
    shortEn: "Timeline, multi-aspect-ratio, and deliverables",
    gateLabel: "납품",
    gateLabelEn: "Deliver",
    about: "선택된 테이크로 타임라인(EDL)을 구성하고, 멀티 비율 마스터와 프롬프트 팩·바이블 등 산출물을 내보냅니다.",
    aboutEn: "Builds a timeline (EDL) from the selected takes and exports multi-aspect-ratio masters plus deliverables like the prompt pack and bible.",
    humanGate: false,
  },
];

export function stepIndex(id: OberonStepId): number {
  return OBERON_STEPS.findIndex((s) => s.id === id);
}

export function stepById(id: OberonStepId): OberonStepDef {
  return OBERON_STEPS.find((s) => s.id === id) ?? OBERON_STEPS[0];
}

export const INITIAL_STEP_STATE: Record<OberonStepId, StepState> = {
  setup: "active",
  plan: "locked",
  storyboard: "locked",
  assets: "locked",
  keyframe: "locked",
  video: "locked",
  delivery: "locked",
};
