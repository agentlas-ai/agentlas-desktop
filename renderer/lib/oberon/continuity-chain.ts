// Oberon — 연속성 체인 (목표 4: 이전 샷·현재 샷·전체 영상에 메모리가 이어지고 유지).
//
// 기존 Continuity Bible은 "전역(global)" 연속성이다 — 인물 외형·팔레트·조명을
// 작품 전체에서 유지한다. 하지만 그것만으로는 "샷 N이 샷 N-1을 이어받는" 느낌이
// 안 난다. 이 파일이 그 빈틈을 메운다: 순차(sequential) 메모리 체인.
//
//   ShotMemory = 한 샷이 "남기고 가는 상태" (라스트 프레임 · 피사체 위치/감정 ·
//   스크린 디렉션 · 조명 · 시간대 · 등장한 자산).
//
// 각 샷은 직전 샷의 exit 상태를 carry로 물려받아 프롬프트에 주입한다
// ("Continue directly from the previous shot: …"). 씬이 바뀌면 메모리를 리셋하되
// 작품 전체 누적 컨텍스트(establishedProps·세계 상태)는 유지한다.
//
// 추가로: 키프레임 체이닝 — 정밀 연결이 필요한 샷은 직전 샷의 last frame을
// 다음 샷의 first frame 후보로 잇는다(180도·아이라인·동작 매치 보존).

import type { Locale } from "@/lib/i18n";
import { CONTINUITY_RULES } from "./taxonomy";
import type {
  Beat,
  ContinuityBible,
  FilmBrief,
  Scene,
  ShotSpec,
} from "./types";

/** CONTINUITY_RULES 항목에서 로케일에 맞는 규칙 설명을 고른다. ruleEn이 아직 카탈로그에
 *  없으면(갱신 전) ko로, rule 자체가 없으면(키 미스매치) 폴백 문구로 안전하게 내려간다. */
function ruleText(
  rule: { rule: string; ruleEn?: string } | undefined,
  fallbackKo: string,
  fallbackEn: string,
  locale: Locale,
): string {
  if (!rule) return locale === "ko" ? fallbackKo : fallbackEn;
  return locale === "ko" ? rule.rule : rule.ruleEn || rule.rule;
}

// ── 샷이 남기는 상태 ─────────────────────────────────────

export type ScreenDirection = "left_to_right" | "right_to_left" | "toward_camera" | "away" | "neutral";

export interface ShotMemory {
  shotId: string;
  sceneId: string;
  /** 이 샷의 마지막 프레임을 한 줄로 — 다음 샷의 출발점. */
  lastFrameSummary: string;
  /** 누가 화면에 있었나 (reference id/이름). */
  subjectsPresent: string[];
  /** 피사체의 감정 온도 (이 비트의 emotion). */
  emotionalTemp: string;
  /** 피사체 이동 방향 — 컷 간 일관 유지(스크린 디렉션). */
  screenDirection: ScreenDirection;
  /** 이 샷의 조명 상태 — 다음 샷이 톤을 잇도록. */
  lightingState: string;
  /** 씬의 시간대 (낮/밤/황혼). */
  timeOfDay: string;
  /** 직전까지 작품에 "확립된" 자산/사실 (누적). */
  establishedRefs: string[];
}

export interface ShotContinuity {
  shotId: string;
  /** 직전 샷에서 물려받은 상태 (씬 첫 샷이면 null). */
  carry: ShotMemory | null;
  /** 이 샷이 남기는 상태. */
  exit: ShotMemory;
  /** 이 샷이 씬의 첫 샷인가. */
  isSceneOpening: boolean;
  /** 프롬프트에 주입할 연속성 구문. */
  continuityPhrase: string;
  /** 정밀 연결: 이 샷의 first frame을 이 샷 id의 last frame에서 잇는다. */
  chainFromShotId?: string;
  /** 적용된 연속성 규칙 키 (QA·UI 표시). */
  appliedRules: string[];
}

// ── 스크린 디렉션 추론 (결정적) ──────────────────────────
// 같은 씬 안에서 방향을 번갈아 뒤집지 않도록, 씬 단위로 기준 방향을 잡는다.

function sceneBaseDirection(scene: Scene, index: number): ScreenDirection {
  if (scene.type === "action") return index % 2 === 0 ? "left_to_right" : "right_to_left";
  if (scene.type === "dialogue") return "neutral"; // OTS reverse가 방향을 만든다.
  if (scene.type === "establishing") return "left_to_right";
  return "neutral";
}

function shotScreenDirection(shot: ShotSpec, base: ScreenDirection): ScreenDirection {
  // OTS reverse 샷은 방향을 뒤집는다 (180도 라인의 반대편). 그 외엔 씬 기준 유지.
  if (shot.camera.angle === "ots") {
    return base === "left_to_right" ? "right_to_left" : base === "right_to_left" ? "left_to_right" : "neutral";
  }
  if (shot.camera.angle === "pov") return "toward_camera";
  if (shot.camera.movement === "push_in") return "toward_camera";
  if (shot.camera.movement === "pull_out") return "away";
  return base;
}

// ── 라스트 프레임 요약 (다음 샷의 출발점) ────────────────

function summarizeLastFrame(shot: ShotSpec, dir: ScreenDirection): string {
  const sizeWord = shot.camera.size;
  const move = shot.camera.movement;
  const dirWord =
    dir === "left_to_right" ? "facing/moving screen-right" :
    dir === "right_to_left" ? "facing/moving screen-left" :
    dir === "toward_camera" ? "oriented toward camera" :
    dir === "away" ? "moving away from camera" : "centered";
  const end =
    move === "push_in" ? "tight on the subject" :
    move === "pull_out" ? "wide, context revealed" :
    move === "whip" ? "mid motion-blur exit" : "settled framing";
  return `ends ${sizeWord}, subject ${dirWord}, ${end}`;
}

// ── 연속성 구문 빌드 (프롬프트 주입) ─────────────────────

function buildContinuityPhrase(args: {
  carry: ShotMemory | null;
  isSceneOpening: boolean;
  scene: Scene;
  emotion: string;
  appliedRules: string[];
}): string {
  const { carry, isSceneOpening, scene, emotion, appliedRules } = args;
  if (isSceneOpening || !carry) {
    return `New scene (${scene.heading}). Establish the space cleanly; this is the first shot of the scene. Maintain the film's global look and any returning characters' locked identity.`;
  }
  const parts = [
    `Continue directly from the previous shot, which ${carry.lastFrameSummary}.`,
    `Keep the same characters (${carry.subjectsPresent.join(", ") || "as established"}) with identical wardrobe, hair and identity.`,
    `Hold lighting continuity (${carry.lightingState}) and ${carry.timeOfDay} time of day.`,
  ];
  // 스크린 디렉션 유지 (180도 법칙).
  if (carry.screenDirection !== "neutral") {
    parts.push(`Preserve screen direction — the subject was ${carry.screenDirection.replace(/_/g, " ")}; do not cross the axis.`);
  }
  // 감정 연속/전환.
  if (emotion && emotion !== carry.emotionalTemp) {
    parts.push(`Emotionally shift from "${carry.emotionalTemp}" toward "${emotion}".`);
  } else if (emotion) {
    parts.push(`Sustain the "${emotion}" emotional tone.`);
  }
  if (appliedRules.length) {
    parts.push(`Continuity rules: ${appliedRules.join("; ")}.`);
  }
  return parts.join(" ");
}

// ── 메인: 샷 배열 → 연속성 체인 ──────────────────────────

export interface ThreadInput {
  shots: ShotSpec[];
  scenes: Scene[];
  beats: Beat[];
  bible: ContinuityBible;
  brief: FilmBrief;
  /** 생성되는 연속성 구문/폴백 텍스트의 로케일 (기본 "ko" — 기존 호출부 호환). */
  locale?: Locale;
}

export function threadContinuity(input: ThreadInput): Map<string, ShotContinuity> {
  const { shots, scenes, beats } = input;
  const locale: Locale = input.locale ?? "en";
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const beatById = new Map(beats.map((b) => [b.id, b]));
  const ruleByKey = new Map(CONTINUITY_RULES.map((r) => [r.key, r]));
  // 캐릭터 ref만 추려 이름으로 — 연속성 노트가 location id를 인물처럼 쓰지 않게.
  const charNameById = new Map(
    input.bible.references.filter((r) => r.kind === "character").map((r) => [r.id, r.name]),
  );
  const charNames = (refs: string[]): string[] =>
    refs.map((id) => charNameById.get(id)).filter((n): n is string => Boolean(n));

  const out = new Map<string, ShotContinuity>();
  const established = new Set<string>(); // 작품 전체 누적.
  let prevExit: ShotMemory | null = null;
  let prevSceneId: string | null = null;

  // 씬별 기준 방향 캐시.
  const sceneDir = new Map<string, ScreenDirection>();
  scenes.forEach((s, i) => sceneDir.set(s.id, sceneBaseDirection(s, i)));

  for (const shot of shots) {
    const scene = sceneById.get(shot.sceneId);
    const beat = beatById.get(shot.beatId);
    const emotion = beat?.emotion ?? "";
    const isSceneOpening = shot.sceneId !== prevSceneId;
    const carry = isSceneOpening ? null : prevExit;

    const baseDir = sceneDir.get(shot.sceneId) ?? "neutral";
    const dir = shotScreenDirection(shot, baseDir);

    // 적용 규칙 결정.
    const appliedRules: string[] = [];
    if (!isSceneOpening) {
      if (carry && carry.screenDirection !== "neutral")
        appliedRules.push(ruleText(ruleByKey.get("180"), "180도", "180-degree rule", locale));
      if (shot.camera.angle === "ots")
        appliedRules.push(ruleText(ruleByKey.get("eyeline"), "아이라인", "eyeline match", locale));
      if (shot.shotType === "action")
        appliedRules.push(ruleText(ruleByKey.get("match_action"), "매치 온 액션", "match on action", locale));
      // 같은 피사체 연속 컷이면 30도 법칙(점프컷 방지).
      if (carry && sameSubjects(carry.subjectsPresent, charNames(shot.continuityRefs)) && carry.screenDirection === dir) {
        appliedRules.push(ruleText(ruleByKey.get("30deg"), "30도", "30-degree rule", locale));
      }
    }

    shot.continuityRefs.forEach((r) => established.add(r));

    const presentChars = charNames(shot.continuityRefs);
    const exit: ShotMemory = {
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      lastFrameSummary: summarizeLastFrame(shot, dir),
      subjectsPresent: presentChars.length ? presentChars : carry?.subjectsPresent ?? [],
      emotionalTemp: emotion || carry?.emotionalTemp || "neutral",
      screenDirection: dir,
      lightingState: input.bible.lightingStyle,
      timeOfDay: scene?.timeOfDay ?? (locale === "ko" ? "낮" : "day"),
      establishedRefs: Array.from(established),
    };

    const continuityPhrase = buildContinuityPhrase({
      carry,
      isSceneOpening,
      scene: scene ?? fallbackScene(shot, locale),
      emotion,
      appliedRules,
    });

    // 키프레임 체이닝: 정밀 연결 샷이면서 씬 중간이면 직전 샷에서 잇는다.
    const chainFromShotId =
      !isSceneOpening && shot.requiresKeyframe && prevExit && prevExit.sceneId === shot.sceneId
        ? prevExit.shotId
        : undefined;

    out.set(shot.shotId, {
      shotId: shot.shotId,
      carry,
      exit,
      isSceneOpening,
      continuityPhrase,
      chainFromShotId,
      appliedRules: Array.from(new Set(appliedRules)),
    });

    prevExit = exit;
    prevSceneId = shot.sceneId;
  }

  return out;
}

function sameSubjects(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  return a.some((x) => b.includes(x));
}

function fallbackScene(shot: ShotSpec, locale: Locale = "en"): Scene {
  return {
    id: shot.sceneId,
    index: 0,
    heading: "SCENE",
    type: shot.shotType,
    location: "",
    timeOfDay: locale === "ko" ? "낮" : "day",
    summary: "",
    characterRefs: [],
    beatIds: [],
    locked: false,
  };
}

// ── 메모리 타임라인 요약 (UI·내보내기) ───────────────────
// "전체 영상에 메모리가 이어지는지"를 사람이 한눈에 검수할 수 있게.

export interface ContinuitySpan {
  sceneId: string;
  heading: string;
  shotCount: number;
  chainedShots: number; // 키프레임 체이닝된 샷 수
  emotionalArc: string[]; // 씬 안 감정 흐름
}

export function summarizeContinuity(
  shots: ShotSpec[],
  scenes: Scene[],
  chain: Map<string, ShotContinuity>,
): ContinuitySpan[] {
  return scenes.map((scene) => {
    const sceneShots = shots.filter((s) => s.sceneId === scene.id);
    const chained = sceneShots.filter((s) => chain.get(s.shotId)?.chainFromShotId).length;
    const arc: string[] = [];
    for (const s of sceneShots) {
      const e = chain.get(s.shotId)?.exit.emotionalTemp;
      if (e && arc[arc.length - 1] !== e) arc.push(e);
    }
    return {
      sceneId: scene.id,
      heading: scene.heading,
      shotCount: sceneShots.length,
      chainedShots: chained,
      emotionalArc: arc,
    };
  });
}
