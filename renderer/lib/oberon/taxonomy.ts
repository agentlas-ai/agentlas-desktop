// Oberon — 시네마틱 문법 (shot taxonomy + coverage grammar).
//
// 이 파일이 "영화처럼 보이게" 만드는 도메인 지식의 핵심이다.
// 관객의 관심이 옮겨지는 순간에 샷을 바꾸고, 같은 사건을 여러 각도/크기로
// 찍어 편집 여지를 확보하는 상업 제작 문법을 코드로 박제한다.

import type {
  CameraAngle,
  CameraMovement,
  FilmFormat,
  Lens,
  SceneType,
  ShotSize,
  Transition,
} from "./types";

// ── 샷 사이즈 ────────────────────────────────────────────

export interface ShotSizeSpec {
  id: ShotSize;
  label: string;
  ko: string;
  /** 생성 프롬프트에 삽입되는 영문 framing 구문. */
  framing: string;
  use: string; // 언제 쓰는가
}

export const SHOT_SIZES: Record<ShotSize, ShotSizeSpec> = {
  ELS: { id: "ELS", label: "Extreme Long", ko: "익스트림 롱샷", framing: "extreme long shot, vast wide establishing frame, subject tiny in environment", use: "공간/스케일 establishing" },
  LS: { id: "LS", label: "Long", ko: "롱샷", framing: "long shot, full environment with subject visible head to toe", use: "지리·관계 establishing" },
  FS: { id: "FS", label: "Full", ko: "풀샷", framing: "full shot, subject head to toe filling the frame", use: "전신 동작·의상" },
  MLS: { id: "MLS", label: "Medium Long", ko: "미디엄 롱샷", framing: "medium long shot, subject from knees up", use: "동작+표정 균형" },
  MS: { id: "MS", label: "Medium", ko: "미디엄샷", framing: "medium shot, subject from the waist up", use: "대화 기본·중립" },
  MCU: { id: "MCU", label: "Medium Close-Up", ko: "미디엄 클로즈업", framing: "medium close-up, subject from the chest up", use: "대화 강조·신뢰" },
  CU: { id: "CU", label: "Close-Up", ko: "클로즈업", framing: "close-up, the subject's face fills the frame", use: "감정·반응" },
  ECU: { id: "ECU", label: "Extreme Close-Up", ko: "익스트림 클로즈업", framing: "extreme close-up, eyes or single detail filling the frame", use: "긴장·인서트 디테일" },
};

// ── 앵글 ─────────────────────────────────────────────────

export interface AngleSpec {
  id: CameraAngle;
  ko: string;
  framing: string;
  use: string;
}

export const ANGLES: Record<CameraAngle, AngleSpec> = {
  eye_level: { id: "eye_level", ko: "아이레벨", framing: "shot at eye level, neutral perspective", use: "중립·기본" },
  high: { id: "high", ko: "하이앵글", framing: "high angle looking down on the subject", use: "취약·왜소함" },
  low: { id: "low", ko: "로우앵글", framing: "low angle looking up at the subject", use: "권위·위압" },
  dutch: { id: "dutch", ko: "더치앵글", framing: "dutch tilt, canted horizon", use: "불안·긴장" },
  overhead: { id: "overhead", ko: "탑샷", framing: "directly overhead bird's-eye view", use: "배치·고립" },
  ots: { id: "ots", ko: "오버더숄더", framing: "over-the-shoulder framing, foreground shoulder soft", use: "대화 관계·시선" },
  pov: { id: "pov", ko: "POV", framing: "first-person point-of-view shot", use: "몰입·주관" },
  aerial: { id: "aerial", ko: "에어리얼", framing: "aerial drone shot, sweeping altitude", use: "스케일·이동" },
};

// ── 무브먼트 ─────────────────────────────────────────────

export interface MovementSpec {
  id: CameraMovement;
  ko: string;
  framing: string;
  energy: number; // 0(정적)-1(역동) — 페이싱 계산에 사용
}

export const MOVEMENTS: Record<CameraMovement, MovementSpec> = {
  static: { id: "static", ko: "고정", framing: "static locked-off camera", energy: 0.1 },
  pan: { id: "pan", ko: "팬", framing: "smooth horizontal pan", energy: 0.4 },
  tilt: { id: "tilt", ko: "틸트", framing: "vertical tilt", energy: 0.4 },
  push_in: { id: "push_in", ko: "푸시인", framing: "slow dolly push-in toward subject", energy: 0.5 },
  pull_out: { id: "pull_out", ko: "풀아웃", framing: "dolly pull-out revealing context", energy: 0.5 },
  dolly: { id: "dolly", ko: "달리", framing: "lateral dolly move", energy: 0.6 },
  tracking: { id: "tracking", ko: "트래킹", framing: "tracking shot following the subject", energy: 0.7 },
  crane: { id: "crane", ko: "크레인", framing: "sweeping crane move", energy: 0.8 },
  handheld: { id: "handheld", ko: "핸드헬드", framing: "handheld camera, subtle organic shake", energy: 0.7 },
  whip: { id: "whip", ko: "휩팬", framing: "fast whip pan with motion blur", energy: 0.95 },
  orbit: { id: "orbit", ko: "오빗", framing: "camera orbiting around the subject", energy: 0.8 },
};

// ── 렌즈 ─────────────────────────────────────────────────

export interface LensSpec {
  id: Lens;
  ko: string;
  framing: string;
  feel: string;
}

export const LENSES: Record<Lens, LensSpec> = {
  "18mm": { id: "18mm", ko: "18mm 초광각", framing: "18mm ultra-wide lens, expansive distortion", feel: "공간·왜곡" },
  "24mm": { id: "24mm", ko: "24mm 광각", framing: "24mm wide lens, environmental context", feel: "환경·역동" },
  "35mm": { id: "35mm", ko: "35mm 준광각", framing: "35mm lens, natural reportage feel", feel: "자연·다큐" },
  "50mm": { id: "50mm", ko: "50mm 표준", framing: "50mm lens, human-eye neutral perspective", feel: "표준·중립" },
  "85mm": { id: "85mm", ko: "85mm 망원", framing: "85mm portrait lens, shallow depth of field, creamy bokeh", feel: "인물·분리" },
  "100mm_macro": { id: "100mm_macro", ko: "100mm 마크로", framing: "100mm macro lens, extreme detail, razor-thin focus", feel: "디테일·제품" },
};

// ── 전환 ─────────────────────────────────────────────────

export interface TransitionSpec {
  id: Transition;
  ko: string;
  use: string;
}

export const TRANSITIONS: Record<Transition, TransitionSpec> = {
  cut: { id: "cut", ko: "하드컷", use: "기본 — 관심 이동 순간" },
  match_cut: { id: "match_cut", ko: "매치컷", use: "형태·동작 연결" },
  j_cut: { id: "j_cut", ko: "J컷", use: "다음 씬 소리 선행" },
  l_cut: { id: "l_cut", ko: "L컷", use: "이전 씬 소리 잔류" },
  dissolve: { id: "dissolve", ko: "디졸브", use: "시간 경과·회상" },
  whip_pan: { id: "whip_pan", ko: "휩팬 전환", use: "에너지·장소 점프" },
  cutaway: { id: "cutaway", ko: "컷어웨이", use: "인서트로 흔들림 은폐" },
  smash_cut: { id: "smash_cut", ko: "스매시컷", use: "충격·반전" },
  fade: { id: "fade", ko: "페이드", use: "시작·종료·챕터" },
};

// ── 커버리지 패턴 ────────────────────────────────────────
// 씬 타입별로 "프로가 찍는 순서". 각 항목이 하나의 샷 카드가 된다.
// role: 이 샷이 편집에서 하는 일.

export interface CoverageShot {
  size: ShotSize;
  angle: CameraAngle;
  movement: CameraMovement;
  lens: Lens;
  role: string;
  /** 이 샷이 first/last frame 키프레임이 필요한가 (정밀 연결 샷). */
  needsKeyframes: boolean;
}

export const COVERAGE_PATTERNS: Record<SceneType, CoverageShot[]> = {
  establishing: [
    { size: "ELS", angle: "aerial", movement: "crane", lens: "24mm", role: "공간 establishing", needsKeyframes: true },
    { size: "LS", angle: "eye_level", movement: "push_in", lens: "35mm", role: "장소 진입", needsKeyframes: false },
    { size: "MS", angle: "eye_level", movement: "static", lens: "50mm", role: "인물 도입", needsKeyframes: false },
  ],
  dialogue: [
    { size: "MS", angle: "eye_level", movement: "static", lens: "50mm", role: "투샷 master", needsKeyframes: false },
    { size: "MCU", angle: "ots", movement: "static", lens: "85mm", role: "A OTS", needsKeyframes: true },
    { size: "MCU", angle: "ots", movement: "static", lens: "85mm", role: "B OTS (reverse)", needsKeyframes: true },
    { size: "CU", angle: "eye_level", movement: "push_in", lens: "85mm", role: "A 리액션", needsKeyframes: false },
    { size: "CU", angle: "eye_level", movement: "static", lens: "85mm", role: "B 리액션", needsKeyframes: false },
    { size: "ECU", angle: "eye_level", movement: "static", lens: "100mm_macro", role: "인서트 디테일", needsKeyframes: false },
  ],
  action: [
    { size: "LS", angle: "low", movement: "tracking", lens: "24mm", role: "지리 master", needsKeyframes: true },
    { size: "MS", angle: "eye_level", movement: "handheld", lens: "35mm", role: "주체 동작", needsKeyframes: false },
    { size: "CU", angle: "dutch", movement: "whip", lens: "50mm", role: "충돌·타격", needsKeyframes: false },
    { size: "ECU", angle: "eye_level", movement: "static", lens: "100mm_macro", role: "디테일 인서트 (match-on-action)", needsKeyframes: false },
    { size: "MLS", angle: "high", movement: "crane", lens: "35mm", role: "여파·해소", needsKeyframes: false },
  ],
  montage: [
    { size: "MS", angle: "eye_level", movement: "push_in", lens: "50mm", role: "비트 A", needsKeyframes: false },
    { size: "CU", angle: "eye_level", movement: "static", lens: "85mm", role: "비트 B", needsKeyframes: false },
    { size: "ECU", angle: "eye_level", movement: "static", lens: "100mm_macro", role: "디테일", needsKeyframes: false },
    { size: "LS", angle: "eye_level", movement: "tracking", lens: "35mm", role: "공간 전환", needsKeyframes: false },
  ],
  product: [
    { size: "ECU", angle: "eye_level", movement: "orbit", lens: "100mm_macro", role: "제품 hero (orbit)", needsKeyframes: true },
    { size: "CU", angle: "high", movement: "push_in", lens: "85mm", role: "손동작·사용", needsKeyframes: false },
    { size: "MS", angle: "eye_level", movement: "static", lens: "50mm", role: "맥락·라이프스타일", needsKeyframes: false },
    { size: "ECU", angle: "eye_level", movement: "static", lens: "100mm_macro", role: "로고·claim frame", needsKeyframes: true },
  ],
  emotional: [
    { size: "CU", angle: "eye_level", movement: "push_in", lens: "85mm", role: "감정 주체", needsKeyframes: true },
    { size: "ECU", angle: "eye_level", movement: "static", lens: "100mm_macro", role: "눈·미세표정", needsKeyframes: false },
    { size: "MS", angle: "high", movement: "static", lens: "50mm", role: "고립·여백", needsKeyframes: false },
  ],
  transition: [
    { size: "ECU", angle: "eye_level", movement: "whip", lens: "50mm", role: "휩 전환 브릿지", needsKeyframes: false },
    { size: "LS", angle: "eye_level", movement: "static", lens: "35mm", role: "다음 공간", needsKeyframes: true },
  ],
};

// ── 연속성 규칙 (QA 근거) ────────────────────────────────

export interface ContinuityRule {
  key: string;
  ko: string;
  rule: string;
}

export const CONTINUITY_RULES: ContinuityRule[] = [
  { key: "180", ko: "180도 법칙", rule: "두 인물 사이 가상선을 넘지 않아 화면 방향을 유지한다" },
  { key: "eyeline", ko: "아이라인 매치", rule: "한 인물의 시선 방향이 다음 컷의 대상 위치와 일치한다" },
  { key: "screen_dir", ko: "스크린 디렉션", rule: "이동 방향(좌→우)이 컷 간 일관되게 유지된다" },
  { key: "30deg", ko: "30도 법칙", rule: "같은 피사체를 이을 때 카메라를 최소 30도 이동해 점프컷을 피한다" },
  { key: "match_action", ko: "매치 온 액션", rule: "동작 도중 컷해 두 샷의 움직임을 매끄럽게 잇는다" },
];

// ── 장르/포맷 비트 템플릿 ────────────────────────────────
// 런타임을 sequences→scenes→beats로 분할하는 골격.

export interface BeatTemplate {
  name: string;
  nameEn: string;
  emotion: string;
  /** 전체 런타임에서 차지하는 비율 (합 ≈ 1). */
  weight: number;
  sceneType: SceneType;
}

export interface GenreTemplate {
  format: FilmFormat;
  label: string;
  labelEn: string;
  avgShotLenSec: number; // 페이싱
  pacing: string;
  arc: string;
  /** 시퀀스 분할 목표 수. */
  sequenceTarget: number;
  beats: BeatTemplate[];
}

export const GENRE_TEMPLATES: Record<FilmFormat, GenreTemplate> = {
  commercial_30: {
    format: "commercial_30",
    label: "30초 광고",
    labelEn: "30s Commercial",
    avgShotLenSec: 1.8,
    pacing: "빠르고 리드미컬, 마지막 claim에서 호흡",
    arc: "Hook → 문제 → 제품 → 증거 → CTA",
    sequenceTarget: 1,
    beats: [
      { name: "훅", nameEn: "Hook", emotion: "호기심", weight: 0.2, sceneType: "establishing" },
      { name: "문제", nameEn: "Problem", emotion: "공감·긴장", weight: 0.2, sceneType: "emotional" },
      { name: "제품 등장", nameEn: "Product", emotion: "해소", weight: 0.25, sceneType: "product" },
      { name: "증거·혜택", nameEn: "Proof", emotion: "신뢰", weight: 0.2, sceneType: "montage" },
      { name: "CTA·로고", nameEn: "CTA", emotion: "결단", weight: 0.15, sceneType: "product" },
    ],
  },
  commercial_60: {
    format: "commercial_60",
    label: "60초 광고",
    labelEn: "60s Commercial",
    avgShotLenSec: 2.0,
    pacing: "스토리텔링 + 제품, 중반 감정 고조",
    arc: "세계관 → 인물 → 갈등 → 제품 해법 → 변화 → CTA",
    sequenceTarget: 2,
    beats: [
      { name: "세계관", nameEn: "World", emotion: "몰입", weight: 0.15, sceneType: "establishing" },
      { name: "인물·욕구", nameEn: "Character", emotion: "공감", weight: 0.15, sceneType: "dialogue" },
      { name: "갈등", nameEn: "Conflict", emotion: "긴장", weight: 0.2, sceneType: "emotional" },
      { name: "제품 해법", nameEn: "Solution", emotion: "전환", weight: 0.2, sceneType: "product" },
      { name: "변화·증거", nameEn: "Payoff", emotion: "만족", weight: 0.18, sceneType: "montage" },
      { name: "CTA·로고", nameEn: "CTA", emotion: "결단", weight: 0.12, sceneType: "product" },
    ],
  },
  trailer: {
    format: "trailer",
    label: "트레일러",
    labelEn: "Trailer",
    avgShotLenSec: 1.6,
    pacing: "점층적 가속, 비트드롭에서 컷 폭주, 마지막 타이틀에서 정적",
    arc: "분위기 → 떡밥 → 고조 → 몽타주 폭발 → 타이틀",
    sequenceTarget: 3,
    beats: [
      { name: "분위기 오프닝", nameEn: "Mood", emotion: "긴장된 정적", weight: 0.18, sceneType: "establishing" },
      { name: "세계·인물", nameEn: "Setup", emotion: "호기심", weight: 0.2, sceneType: "dialogue" },
      { name: "위협·갈등", nameEn: "Stakes", emotion: "위협", weight: 0.22, sceneType: "action" },
      { name: "몽타주 고조", nameEn: "Escalation", emotion: "아드레날린", weight: 0.25, sceneType: "montage" },
      { name: "타이틀 카드", nameEn: "Title", emotion: "여운", weight: 0.15, sceneType: "transition" },
    ],
  },
  short_drama: {
    format: "short_drama",
    label: "단편 드라마 (3-5분)",
    labelEn: "Short Drama",
    avgShotLenSec: 2.7,
    pacing: "호흡 있는 대화 중심, 감정 빌드업, shot/reverse 코어",
    arc: "도입 → 관계 → 전환점 → 위기 → 해소",
    sequenceTarget: 3,
    beats: [
      { name: "도입", nameEn: "Opening", emotion: "일상", weight: 0.15, sceneType: "establishing" },
      { name: "관계 설정", nameEn: "Relationship", emotion: "친밀·균열", weight: 0.2, sceneType: "dialogue" },
      { name: "전환점", nameEn: "Turn", emotion: "동요", weight: 0.2, sceneType: "emotional" },
      { name: "대립·위기", nameEn: "Crisis", emotion: "갈등", weight: 0.25, sceneType: "dialogue" },
      { name: "해소", nameEn: "Resolution", emotion: "정화", weight: 0.2, sceneType: "emotional" },
    ],
  },
  music_video: {
    format: "music_video",
    label: "뮤직비디오",
    labelEn: "Music Video",
    avgShotLenSec: 1.3,
    pacing: "비트에 컷을 맞춤, 퍼포먼스 + 내러티브 교차",
    arc: "인트로 → 벌스 → 코러스(반복 강화) → 브릿지 → 아웃트로",
    sequenceTarget: 3,
    beats: [
      { name: "인트로", nameEn: "Intro", emotion: "분위기 형성", weight: 0.12, sceneType: "establishing" },
      { name: "벌스 1", nameEn: "Verse", emotion: "내러티브", weight: 0.2, sceneType: "montage" },
      { name: "코러스", nameEn: "Chorus", emotion: "고조·에너지", weight: 0.24, sceneType: "action" },
      { name: "벌스 2·브릿지", nameEn: "Bridge", emotion: "변주", weight: 0.24, sceneType: "emotional" },
      { name: "아웃트로", nameEn: "Outro", emotion: "여운", weight: 0.2, sceneType: "montage" },
    ],
  },
  cinematic_short: {
    format: "cinematic_short",
    label: "시네마틱 단편 (~10분)",
    labelEn: "Cinematic Short",
    avgShotLenSec: 3.5,
    pacing: "영화적 호흡, 시퀀스별 lock 후 합치기",
    arc: "설정 → 발단 → 상승 → 절정 → 하강 → 결말",
    sequenceTarget: 5,
    beats: [
      { name: "설정", nameEn: "Setup", emotion: "세계 몰입", weight: 0.14, sceneType: "establishing" },
      { name: "발단", nameEn: "Inciting", emotion: "변화의 씨앗", weight: 0.16, sceneType: "dialogue" },
      { name: "상승", nameEn: "Rising", emotion: "긴장 누적", weight: 0.22, sceneType: "dialogue" },
      { name: "절정", nameEn: "Climax", emotion: "폭발", weight: 0.2, sceneType: "action" },
      { name: "하강", nameEn: "Falling", emotion: "여진", weight: 0.14, sceneType: "emotional" },
      { name: "결말", nameEn: "Resolution", emotion: "정착", weight: 0.14, sceneType: "establishing" },
    ],
  },
  social_short: {
    format: "social_short",
    label: "소셜 숏폼 (9:16)",
    labelEn: "Social Short",
    avgShotLenSec: 1.8,
    pacing: "첫 1초 훅 필수, 빠른 컷, 자막 친화",
    arc: "훅 → 전개 → 반전·페이오프 → CTA",
    sequenceTarget: 1,
    beats: [
      { name: "1초 훅", nameEn: "Hook", emotion: "스크롤 정지", weight: 0.25, sceneType: "action" },
      { name: "전개", nameEn: "Build", emotion: "몰입", weight: 0.3, sceneType: "montage" },
      { name: "페이오프", nameEn: "Payoff", emotion: "쾌감", weight: 0.25, sceneType: "emotional" },
      { name: "CTA", nameEn: "CTA", emotion: "행동", weight: 0.2, sceneType: "product" },
    ],
  },
};

export const FORMAT_DEFAULT_DURATION: Record<FilmFormat, number> = {
  commercial_30: 30,
  commercial_60: 60,
  trailer: 90,
  short_drama: 240,
  music_video: 180,
  cinematic_short: 600,
  social_short: 30,
};
