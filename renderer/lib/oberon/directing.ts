// Oberon — 연출 엔진 (목표 2: 카메라 무빙 · 초단위 장면 · 멀티샷 제작기법).
//
// taxonomy.ts가 "어떤 샷을 찍는가"라면, 이 파일은 "그 샷이 시간 위에서 어떻게
// 움직이는가"를 만든다. 8초 클립을 정적인 한 줄 프롬프트로 던지지 않고,
// 초 단위 타임라인(0–2s push-in 시작 → 2–6s 액션 → 6–8s 정착)으로 안무한다.
//
// 영상 생성 모델(Veo/Seedance/Luma)은 "시간에 따른 변화"를 줄 때 훨씬 영화처럼
// 움직인다. 카메라 무빙의 시작/속도램프/정착, 피사체 액션, 컷 핸들을 명시한다.

import { MOVEMENTS, SHOT_SIZES } from "./taxonomy";
import type { CameraMovement, CameraSpec, ShotSize, Transition } from "./types";

// ── 카메라 무브먼트 다이내믹스 ───────────────────────────
// 각 무브먼트의 "물리"를 시간 위에 푼다. ease + 시작 타이밍 + 정착.

export interface MovementDynamics {
  id: CameraMovement;
  /** 무빙이 시작되는 시점 비율(0=클립 시작). 보통 살짝 늦게 시작해 안정적 진입. */
  startAt: number;
  /** 무빙이 끝나고 정착하는 시점 비율(1=클립 끝). 끝에서 멈춰야 컷이 깔끔. */
  settleAt: number;
  /** 가속 곡선. */
  ease: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  /** 프롬프트에 들어갈 시간적 모션 묘사. */
  temporal: string;
  /** 속도 램프(슬로모/타임랩스) 친화도 — 액션/뮤비에서 활용. */
  rampFriendly: boolean;
}

export const MOVEMENT_DYNAMICS: Record<CameraMovement, MovementDynamics> = {
  static: { id: "static", startAt: 0, settleAt: 1, ease: "linear", temporal: "locked-off frame with only subtle subject motion, no camera move", rampFriendly: false },
  pan: { id: "pan", startAt: 0.1, settleAt: 0.85, ease: "ease-in-out", temporal: "begin static, then a smooth horizontal pan that eases to a stop before the cut", rampFriendly: false },
  tilt: { id: "tilt", startAt: 0.1, settleAt: 0.85, ease: "ease-in-out", temporal: "a controlled vertical tilt that reveals top-to-bottom, settling at the end", rampFriendly: false },
  push_in: { id: "push_in", startAt: 0.05, settleAt: 0.9, ease: "ease-in", temporal: "a slow continuous dolly push-in that tightens on the subject, gaining intimacy toward the end", rampFriendly: false },
  pull_out: { id: "pull_out", startAt: 0.05, settleAt: 0.9, ease: "ease-out", temporal: "a dolly pull-out that gradually reveals the surrounding context", rampFriendly: false },
  dolly: { id: "dolly", startAt: 0.1, settleAt: 0.9, ease: "ease-in-out", temporal: "a lateral dolly gliding parallel to the subject at steady speed", rampFriendly: true },
  tracking: { id: "tracking", startAt: 0, settleAt: 1, ease: "linear", temporal: "a continuous tracking move that follows the subject's motion, holding consistent framing", rampFriendly: true },
  crane: { id: "crane", startAt: 0.05, settleAt: 0.92, ease: "ease-in-out", temporal: "a sweeping crane move rising/descending through space, ending on a composed frame", rampFriendly: false },
  handheld: { id: "handheld", startAt: 0, settleAt: 1, ease: "linear", temporal: "organic handheld micro-movement throughout, breathing with the action, never mechanical", rampFriendly: true },
  whip: { id: "whip", startAt: 0.55, settleAt: 0.75, ease: "ease-in", temporal: "hold, then a fast whip pan with heavy motion blur as a transition out", rampFriendly: true },
  orbit: { id: "orbit", startAt: 0.05, settleAt: 0.95, ease: "linear", temporal: "a steady arc orbiting around the subject, parallax revealing form and depth", rampFriendly: true },
};

// ── 초 단위 안무 (timed action beats) ────────────────────

export interface MotionBeat {
  /** 시작 초. */
  fromSec: number;
  /** 끝 초. */
  toSec: number;
  /** 이 구간에 일어나는 일 (카메라 + 피사체). */
  note: string;
}

export interface ShotChoreography {
  durationSec: number;
  beats: MotionBeat[];
  /** 프롬프트에 바로 붙일 한 줄 모션 안무 구문. */
  motionPhrase: string;
  /** 클립 끝에 컷 핸들(정지/여백)을 두었는가 — 편집 연결용. */
  cutHandle: boolean;
  /** 속도 연출(슬로모/타임랩스/리얼타임). */
  speed: "real" | "slow_mo" | "ramp" | "time_lapse";
}

export interface ChoreographyInput {
  durationSec: number;
  camera: CameraSpec;
  action: string;
  /** 이 샷의 감정/에너지 (action·montage면 높음). */
  energy: number; // 0-1
  hasDialogue?: boolean;
  /** 이 샷이 트레일러/뮤비처럼 속도 연출을 환영하는가. */
  allowSpeedFx?: boolean;
}

/**
 * 한 샷을 초 단위로 안무한다. 진입(설정) → 전개(액션) → 정착(컷 핸들).
 * 카메라 무빙의 시작/정착 타이밍을 실제 초로 변환해 모델이 시간 위에서 움직이게 한다.
 */
export function composeChoreography(input: ChoreographyInput): ShotChoreography {
  const { durationSec, camera, action, energy } = input;
  const dyn = MOVEMENT_DYNAMICS[camera.movement];
  const dur = Math.max(1, durationSec);
  const t = (ratio: number) => Number((ratio * dur).toFixed(1));

  const speed = decideSpeed(input, dyn);
  const beats: MotionBeat[] = [];

  // 1) 진입 — 첫 0.3초는 안정적 첫 프레임(편집 핸들 + 키프레임 정합).
  const entryEnd = Math.min(t(dyn.startAt) + 0.3, dur * 0.35);
  beats.push({
    fromSec: 0,
    toSec: Number(entryEnd.toFixed(1)),
    note: `establish framing: ${SHOT_SIZES[camera.size].framing}; ${camera.movement === "static" ? "hold" : "camera begins to move"}`,
  });

  // 2) 전개 — 카메라 무빙 본체 + 피사체 액션. 에너지 높으면 더 강한 동세.
  const devEnd = Math.max(entryEnd + 0.4, t(dyn.settleAt));
  beats.push({
    fromSec: Number(entryEnd.toFixed(1)),
    toSec: Number(Math.min(devEnd, dur - 0.3).toFixed(1)),
    note: `${dyn.temporal}; subject action: ${shortAction(action)}${energy >= 0.7 ? ", strong kinetic energy" : energy <= 0.3 ? ", restrained and deliberate" : ""}`,
  });

  // 3) 정착 — 마지막 0.3–0.5초 컷 핸들(움직임 멈춤 or 다음 컷으로 넘길 모션).
  const handleStart = Number(Math.min(devEnd, dur - 0.3).toFixed(1));
  const cutHandle = camera.movement !== "whip"; // 휩팬은 일부러 모션 중에 컷.
  beats.push({
    fromSec: handleStart,
    toSec: dur,
    note: cutHandle
      ? "camera settles and holds a clean, stable final frame for the editorial cut"
      : "continue the motion blur through the frame edge to bridge into the next shot",
  });

  const motionPhrase = beatsToPhrase(beats, speed);
  return { durationSec: dur, beats, motionPhrase, cutHandle, speed };
}

function decideSpeed(input: ChoreographyInput, dyn: MovementDynamics): ShotChoreography["speed"] {
  if (!input.allowSpeedFx) return "real";
  if (input.hasDialogue) return "real"; // 대사 샷은 리얼타임(립싱크).
  if (input.energy >= 0.8 && dyn.rampFriendly) return "ramp"; // 액션 피크 — 속도 램프.
  if (input.energy >= 0.65 && dyn.rampFriendly) return "slow_mo";
  return "real";
}

function beatsToPhrase(beats: MotionBeat[], speed: ShotChoreography["speed"]): string {
  const timeline = beats
    .map((b) => `[${b.fromSec.toFixed(1)}–${b.toSec.toFixed(1)}s] ${b.note}`)
    .join("; ");
  const speedNote =
    speed === "slow_mo"
      ? " Rendered in elegant slow motion."
      : speed === "ramp"
        ? " Use a speed ramp: real-time into the action, then ramp to slow motion on the peak moment."
        : speed === "time_lapse"
          ? " Rendered as a smooth time-lapse."
          : "";
  return `Timed choreography — ${timeline}.${speedNote}`;
}

function shortAction(action: string): string {
  return action.length > 90 ? `${action.slice(0, 88)}…` : action;
}

// ── 멀티샷 시퀀스 문법 (연출 패턴) ───────────────────────
// 같은 사건을 어떤 컷 흐름으로 잇는가 — 편집 리듬의 청사진.

export interface SequencePattern {
  id: string;
  ko: string;
  /** 영문 표시 라벨. */
  labelEn: string;
  /** 컷 흐름 설명. */
  flow: string;
  /** 컷 흐름 설명 (영문). */
  flowEn: string;
  /** 추천 평균 컷 길이(초). */
  avgCut: number;
}

export const SEQUENCE_PATTERNS: Record<string, SequencePattern> = {
  shot_reverse: {
    id: "shot_reverse",
    ko: "샷/리버스",
    labelEn: "Shot / Reverse",
    flow: "master → A OTS → B OTS(reverse) → 리액션 인서트",
    flowEn: "master → A OTS → B OTS (reverse) → reaction insert",
    avgCut: 2.4,
  },
  intensify: {
    id: "intensify",
    ko: "점층 인텐시파이",
    labelEn: "Escalating Intensify",
    flow: "WS → MS → CU → ECU 로 점점 좁혀 긴장 고조",
    flowEn: "WS → MS → CU → ECU, tightening progressively to build tension",
    avgCut: 1.8,
  },
  reveal: {
    id: "reveal",
    ko: "리빌",
    labelEn: "Reveal",
    flow: "디테일 인서트 → pull-out/크레인으로 전체 공간 공개",
    flowEn: "detail insert → pull-out/crane reveals the full space",
    avgCut: 2.6,
  },
  match_action: {
    id: "match_action",
    ko: "매치 온 액션",
    labelEn: "Match on Action",
    flow: "동작 시작(WS) → 컷 → 같은 동작 이어받기(CU)",
    flowEn: "action begins (WS) → cut → the same action continues (CU)",
    avgCut: 1.5,
  },
  montage_beat: {
    id: "montage_beat",
    ko: "비트 몽타주",
    labelEn: "Montage Beat",
    flow: "짧은 컷들을 음악 비트에 맞춰 리듬감 있게 연결",
    flowEn: "short cuts linked rhythmically to the music's beat",
    avgCut: 1.0,
  },
  oner: {
    id: "oner",
    ko: "원테이크 지향",
    labelEn: "Oner",
    flow: "한 컷 안에서 카메라 무빙으로 여러 비트를 담는다(긴 호흡)",
    flowEn: "a single unbroken take carries several beats through camera movement (a long, unhurried breath)",
    avgCut: 6.0,
  },
};

/** 씬 타입 → 추천 시퀀스 패턴. */
export function sequencePatternFor(sceneType: string): SequencePattern {
  switch (sceneType) {
    case "dialogue":
      return SEQUENCE_PATTERNS.shot_reverse;
    case "action":
      return SEQUENCE_PATTERNS.match_action;
    case "emotional":
      return SEQUENCE_PATTERNS.intensify;
    case "establishing":
      return SEQUENCE_PATTERNS.reveal;
    case "montage":
      return SEQUENCE_PATTERNS.montage_beat;
    default:
      return SEQUENCE_PATTERNS.shot_reverse;
  }
}

// ── 무빙 추천 (사이즈/에너지 → 자연스러운 무빙) ──────────
// 같은 패턴이라도 사이즈가 바뀌면 어울리는 무빙이 다르다. 무빙 난사 방지.

export function suggestMovement(size: ShotSize, energy: number, defaultMove: CameraMovement): CameraMovement {
  // 클로즈업은 큰 무빙이 어색 — 푸시인/정적 위주.
  if ((size === "CU" || size === "ECU") && MOVEMENTS[defaultMove].energy > 0.6) {
    return energy >= 0.6 ? "push_in" : "static";
  }
  // 와이드 + 높은 에너지 → 트래킹/크레인 환영.
  if ((size === "ELS" || size === "LS") && energy >= 0.7) {
    return defaultMove === "static" ? "crane" : defaultMove;
  }
  return defaultMove;
}

/** 전환 추천에 시간적 정보를 더한다 — j/l컷은 오디오 선행/잔류를 명시. */
export function transitionDirective(transitionOut: Transition): string {
  switch (transitionOut) {
    case "match_cut":
      return "End on a shape/motion that the next shot can match-cut into.";
    case "j_cut":
      return "Let the next scene's audio start before this picture ends (J-cut).";
    case "l_cut":
      return "Carry this shot's audio a beat into the next picture (L-cut).";
    case "smash_cut":
      return "End abruptly at peak energy for a hard smash cut.";
    case "whip_pan":
      return "Exit on a whip-pan blur to jump location.";
    case "dissolve":
      return "Leave the final frame calm enough to dissolve through.";
    default:
      return "Leave a clean handle on the out-point for a hard cut.";
  }
}
