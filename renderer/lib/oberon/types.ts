// Oberon — AI Film Operating System: 핵심 데이터 모델.
//
// 설계 원칙: "20분 영상을 한 번에 생성"이 아니라 "상업 제작 파이프라인을
// 작은 샷 단위로 자동 운영"한다. 따라서 모델은 영화 제작 계층을 그대로 따른다.
//
//   Project → Sequence → Scene → Beat → Shot → Take
//
// 그리고 이 계층을 가로지르며 묶어주는 두 축이 품질을 만든다:
//   1) Continuity Bible (인물/공간/의상/소품/색·조명 유지)
//   2) Edit Decision List (컷 선택·길이·전환으로 리듬을 만든다)
//
// 모든 타입은 직렬화 가능(JSON)해야 한다 — 로컬 저장 / 내보내기 / IPC 전송 대상.

import type { OberonKeyframeAsset, OberonPlanResult, OberonRenderFile } from "@shared/types";

// ── 포맷 / 장르 ───────────────────────────────────────────

/** 최종 산출물의 형태. 런타임 분할·페이싱·샷 수를 결정한다. */
export type FilmFormat =
  | "commercial_30"
  | "commercial_60"
  | "trailer"
  | "short_drama"
  | "music_video"
  | "cinematic_short"
  | "social_short"; // 9:16 숏폼 (15-45s)

export type AspectRatio = "16:9" | "9:16" | "1:1" | "2.39:1" | "4:5";

export type Genre =
  | "commercial"
  | "drama"
  | "action"
  | "thriller"
  | "romance"
  | "scifi"
  | "documentary"
  | "fantasy"
  | "horror"
  | "comedy";

/** 한 씬을 어떻게 "커버"할지를 결정하는 분류. 커버리지 패턴의 키. */
export type SceneType =
  | "dialogue"
  | "action"
  | "establishing"
  | "montage"
  | "product"
  | "emotional"
  | "transition";

// ── 입력: Creative Brief ─────────────────────────────────

export interface CharacterBriefInput {
  name: string;
  role: string; // 주연 / 조연 / 제품 모델 등
  description: string; // 외형·나이·분위기
}

/** 사용자가 채우는 최소 입력. 나머지는 에이전트가 채운다. */
export interface FilmBrief {
  title: string;
  format: FilmFormat;
  genre: Genre;
  aspect: AspectRatio;
  durationSec: number;
  logline: string; // 한 문장 컨셉
  synopsis: string; // 2-4문장 줄거리 (옵션)
  audience: string; // 타깃
  tone: string[]; // ["cinematic", "warm", "tense"] 등
  visualReferences: string[]; // 레퍼런스 작품/룩 ("Blade Runner 2049 lighting")
  characters: CharacterBriefInput[];
  setting: string; // 주 배경 ("심야의 도시 오피스")
  brandOrProduct?: string; // 광고일 때
  mustInclude: string[]; // 반드시 들어갈 요소
  mustAvoid: string[]; // 금지 요소
  language: "ko" | "en";
}

// ── Continuity Bible ─────────────────────────────────────

export type ReferenceKind = "character" | "location" | "wardrobe" | "prop" | "vehicle" | "style";

/** 수백~수천 샷에 걸쳐 동일하게 유지해야 하는 자산의 명세. */
export interface ReferenceEntry {
  id: string;
  kind: ReferenceKind;
  name: string;
  /** 이 자산을 생성/유지하기 위한 이미지 프롬프트 (캐릭터 시트, 룩 보드 등). */
  prompt: string;
  /** 절대 바꾸면 안 되는 식별 특징. QA가 이걸로 검사한다. */
  lockedTraits: string[];
  notes: string;
  /** 생성된 레퍼런스 이미지 asset id들 (승인된 것). */
  approvedAssetIds: string[];
}

export interface PaletteSwatch {
  name: string;
  hex: string;
}

export interface ContinuityBible {
  /** 전체 룩을 한 문장으로 — 모든 프롬프트에 주입되는 "DNA". */
  visualDirection: string;
  filmStock: string; // "Kodak Vision3 500T", "digital Arri Alexa" 등
  colorPalette: PaletteSwatch[];
  lightingStyle: string; // "low-key, warm practical lamps"
  references: ReferenceEntry[];
  /** 작품 전체에 적용되는 do-not-change 목록. */
  globalMustKeep: string[];
  globalMustAvoid: string[];
}

// ── 샷 / 시네마틱 명세 ────────────────────────────────────

export type ShotSize = "ELS" | "LS" | "FS" | "MLS" | "MS" | "MCU" | "CU" | "ECU";
export type CameraAngle =
  | "eye_level"
  | "high"
  | "low"
  | "dutch"
  | "overhead"
  | "ots" // over-the-shoulder
  | "pov"
  | "aerial";
export type CameraMovement =
  | "static"
  | "pan"
  | "tilt"
  | "push_in"
  | "pull_out"
  | "dolly"
  | "tracking"
  | "crane"
  | "handheld"
  | "whip"
  | "orbit";
export type Lens = "18mm" | "24mm" | "35mm" | "50mm" | "85mm" | "100mm_macro";
export type Transition =
  | "cut"
  | "match_cut"
  | "j_cut"
  | "l_cut"
  | "dissolve"
  | "whip_pan"
  | "cutaway"
  | "smash_cut"
  | "fade";

export interface CameraSpec {
  size: ShotSize;
  angle: CameraAngle;
  movement: CameraMovement;
  lens: Lens;
}

/** 샷별 프로바이더 생성 contract (research §10 ShotSpec). */
export interface ShotSpec {
  shotId: string;
  sceneId: string;
  beatId: string;
  index: number; // 작품 전체에서의 순서
  durationSec: number;
  shotType: SceneType; // 이 샷이 속한 커버리지 의도
  camera: CameraSpec;
  /** 화면에서 일어나는 일 (action line). */
  action: string;
  dialogue?: string;
  /** 이 샷이 참조하는 continuity 자산 id들. */
  continuityRefs: string[];
  /** 비싼 영상 호출 전에 이미지 키프레임 확인이 필요한 샷인지. */
  requiresKeyframe?: boolean;
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  mustKeep: string[];
  mustAvoid: string[];
  /** 컷 연결을 위한 진입/이탈 전환. */
  transitionIn: Transition;
  transitionOut: Transition;
  /** prompt-craft가 만든 최종 생성 프롬프트 (프로바이더별). */
  generationPrompt: string;
  negativePrompt: string;
  /** 라우팅된 프로바이더 + 모드. */
  providerId: string;
  providerMode: ProviderMode;
  estCostUsd: number;
}

// ── 계층 ─────────────────────────────────────────────────

export interface Beat {
  id: string;
  name: string; // "Hook", "Reveal", "CTA" 등
  description: string;
  emotion: string; // 이 비트의 감정 ("longing", "tension")
  shotIds: string[];
}

export interface Scene {
  id: string;
  index: number;
  heading: string; // "INT. 오피스 - 밤" 슬러그라인
  type: SceneType;
  location: string;
  timeOfDay: string;
  summary: string;
  characterRefs: string[]; // 등장 인물 reference id
  beatIds: string[];
  /** 씬 락 상태 — true면 변경 동결, sequence 합치기 가능. */
  locked: boolean;
}

export interface Sequence {
  id: string;
  index: number;
  title: string;
  purpose: string; // 이 시퀀스가 작품에서 하는 역할
  sceneIds: string[];
}

// ── 생성 / QA / 편집 ─────────────────────────────────────

export type ProviderMode =
  | "text_to_video"
  | "image_to_video"
  | "first_last_frame"
  | "video_extend"
  | "video_to_video"
  | "image"; // 이미지 생성 (키프레임/레퍼런스)

export type TakeStatus = "queued" | "generating" | "ready" | "failed" | "selected" | "rejected";

/** shot당 2-5개 후보 영상. */
export interface Take {
  id: string;
  shotId: string;
  attempt: number;
  status: TakeStatus;
  providerId: string;
  providerMode: ProviderMode;
  /** 데모에서는 합성 미리보기, 실제 키 연결 시 생성 영상 URL. */
  previewUrl?: string;
  thumbnailGradient: string; // 합성 썸네일 (CSS gradient)
  costUsd: number;
  qa?: QAResult;
  createdAtMs: number;
}

export type QAFindingType =
  | "identity"
  | "continuity"
  | "screen_direction"
  | "editability"
  | "motion"
  | "product"
  | "dialogue"
  | "finish";
export type QASeverity = "low" | "medium" | "high";

export interface QAFinding {
  type: QAFindingType;
  severity: QASeverity;
  note: string;
}

export interface QAResult {
  takeId: string;
  shotId: string;
  score: number; // 0-1
  pass: boolean;
  findings: QAFinding[];
  recommendedAction:
    | "accept"
    | "retry_same_provider"
    | "retry_stronger_reference"
    | "switch_provider"
    | "resplit_shot";
}

export interface EditDecision {
  shotId: string;
  takeId: string; // 선택된 테이크
  order: number;
  inSec: number; // 컷 인 핸들
  outSec: number; // 컷 아웃 핸들
  transitionIn: Transition;
  durationSec: number;
}

// ── 프로바이더 라우팅 ────────────────────────────────────

export interface ProviderModel {
  model: string;
  modes: ProviderMode[];
  maxDurationSec: number;
  resolutions: string[];
  notes: string;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: "video" | "image";
  models: ProviderModel[];
  supportsFirstLastFrame: boolean;
  supportsRefImage: boolean;
  refImageCount: number;
  nativeAudio: boolean;
  strengths: string[];
  weaknesses: string[];
  /** ~8s 클립(영상) 또는 이미지 1장당 대략적 비용 USD. */
  approxCostUsd: number;
  bestFor: string;
  /** vault에서 필요한 키 이름. */
  vaultKey: string;
  status: "active" | "sunset"; // Sora 류는 sunset
}

// ── 에이전트 / 파이프라인 ────────────────────────────────

/** research §4 의 13개 에이전트 정의. 파이프라인의 각 단계가 곧 에이전트. */
export interface FilmAgentDef {
  id: string; // "00-showrunner"
  code: string; // "00"
  name: string;
  nameEn: string;
  role: string;
  inputs: string[];
  outputs: string[];
  failGate: string;
  /** 이 에이전트의 시스템 프롬프트 — 실제 LLM 라우팅 시 사용. */
  systemPrompt: string;
  /** UI 표시 색. */
  accent: string;
  /** 파이프라인 스테이지 키. */
  stage: PipelineStageKey;
}

export type PipelineStageKey =
  | "brief"
  | "script"
  | "shotlist"
  | "continuity"
  | "keyframe"
  | "approval"
  | "generation"
  | "qa"
  | "edit"
  | "audio"
  | "delivery";

export type StageStatus = "locked" | "ready" | "active" | "blocked" | "done";

// ── 품질 게이트 ──────────────────────────────────────────

export interface QualityGate {
  key: string;
  name: string;
  nameEn: string;
  passCondition: string;
}

// ── 비용 ─────────────────────────────────────────────────

export interface CostLine {
  shotId: string;
  providerId: string;
  attempts: number;
  costUsd: number;
}

export interface CostLedger {
  lines: CostLine[];
  imageCostUsd: number;
  /** 샷당 1테이크 기준 영상비 합. */
  videoCostUsd: number;
  /** 샷당 생성할 후보 테이크 수 (총비용 = videoCostUsd × takesPerShot + imageCostUsd). */
  takesPerShot: number;
  totalUsd: number;
  budgetUsd: number;
  withinBudget: boolean;
}

// ── 모델 설정 (시작 창에서 선택) ─────────────────────────

/** 사용자가 시작 시 고르는 생성 스택. 앱의 runtime.detect + multimodal 레지스트리와 연동. */
export interface ModelSettings {
  /** 대본·기획·스토리보드 텍스트 생성 — BYOK CLI 런타임 kind. */
  textRuntime: string;
  textRuntimeLabel: string;
  /** 컷·레퍼런스 이미지 엔진 — multimodal provider id. */
  imageProvider: string;
  /** 영상 생성 엔진(복수 선택·병렬) — multimodal video provider id 배열. */
  videoProviders: string[];
  /** 오디오 엔진 — multimodal provider id. */
  audioProvider: string;
}

export function defaultModelSettings(): ModelSettings {
  return {
    textRuntime: "claude-code",
    textRuntimeLabel: "Claude Code",
    imageProvider: "codex-cli-image",
    videoProviders: ["google-veo"],
    audioProvider: "openai-audio",
  };
}

// ── 최상위: Production ────────────────────────────────────

export interface FilmProduction {
  id: string;
  brief: FilmBrief;
  /** 시작 창에서 고른 생성 스택. */
  modelSettings?: ModelSettings;
  /** Step 01에서 실제 CLI가 보강한 기획 결과. 실패 시 로컬 deterministic planner fallback 기록. */
  planningRun?: OberonPlanResult;
  bible: ContinuityBible;
  sequences: Sequence[];
  scenes: Scene[];
  beats: Beat[];
  shots: ShotSpec[];
  /** Step 04에서 실제 이미지 엔진으로 저장한 첫 프레임들. */
  keyframeAssets?: OberonKeyframeAsset[];
  /** 생성된 테이크들 (생성 큐 진행에 따라 채워짐). */
  takes: Take[];
  edl: EditDecision[];
  /** Electron real-render job id, when the video step used a live provider. */
  renderJobId?: string;
  /** Locally saved MP4/MOV/WAV outputs from a live render job. */
  renderOutputs?: OberonRenderFile[];
  cost: CostLedger;
  /** 각 파이프라인 스테이지의 상태. */
  stageStatus: Record<PipelineStageKey, StageStatus>;
  createdAtMs: number;
  /** 통계 (UI 헤더용). */
  stats: ProductionStats;
}

export interface ProductionStats {
  sequenceCount: number;
  sceneCount: number;
  beatCount: number;
  shotCount: number;
  totalDurationSec: number;
  avgShotLenSec: number;
  estTotalCostUsd: number;
  referenceCount: number;
}
