// Oberon — 제작 엔진 (the brain).
//
// 브리프 하나를 받아 상업 제작 파이프라인 전체 산출물을 역설계한다:
//   Project → Sequence → Scene → Beat → Shot (+ 샷별 프롬프트/프로바이더/비용)
//   + Continuity Bible (인물/공간/소품 레퍼런스 + do-not-change)
//   + Keyframe 명세 + Cost Ledger
//
// 결정적(deterministic) 생성 — 같은 브리프는 같은 계획을 낸다(시드).
// 실제 LLM/이미지/영상 API는 어댑터 경계 뒤에 있고, 여기서는 "계획 + 프롬프트"를
// 완전하게 만든다(그 자체로 어떤 영상툴에든 바로 쓸 수 있는 산출물).

import type { Locale } from "@/lib/i18n";
import { INITIAL_STAGE_STATUS } from "./agents";
import {
  buildSubtitleCues,
  composeAudioDirection,
  defaultAudioBed,
  deriveDelivery,
  type DialogueLine,
} from "./audio-dialogue";
import { composeChoreography, transitionDirective } from "./directing";
import { threadContinuity } from "./continuity-chain";
import { pickTypography } from "./typography";
import {
  composeKeyframePrompt,
  composeNegativePrompt,
  composeReferencePrompt,
  composeShotPrompt,
  suggestShotDuration,
} from "./prompt-craft";
import {
  providerById,
  routeVideoProvider,
} from "./providers";
import { COVERAGE_PATTERNS, FORMAT_DEFAULT_DURATION, GENRE_TEMPLATES, MOVEMENTS } from "./taxonomy";
import type {
  Beat,
  ContinuityBible,
  CostLedger,
  CostLine,
  EditDecision,
  FilmBrief,
  FilmProduction,
  PaletteSwatch,
  ProductionStats,
  QAFinding,
  QAResult,
  ReferenceEntry,
  Scene,
  Sequence,
  ShotSpec,
  Take,
} from "./types";

// ── 시드 RNG (안정적 변주) ───────────────────────────────

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

// ── 로케일 (UI 표시 언어) ────────────────────────────────
// brief.language(대사 언어)와는 별개 — 이 값은 생성되는 라벨/설명 텍스트의 언어를 결정한다.
// taxonomy.ts/providers.ts와 동일하게 lib/i18n의 Locale을 그대로 쓴다.

/** 카탈로그(taxonomy/agents/providers/steps)의 ko/en 텍스트 쌍 중 로케일에 맞는 값을 고른다.
 *  en 값이 아직 없으면(카탈로그 갱신 전) ko로 폴백. */
function pickText(ko: string, en: string | undefined, locale: Locale): string {
  return locale === "ko" ? ko : en || ko;
}

/** BeatTemplate에 emotionEn이 아직 없을 수 있어(카탈로그 갱신 전) 구조적으로 안전하게 읽는다. */
function readEmotionEn(tb: { emotion: string; emotionEn?: string }): string | undefined {
  return tb.emotionEn;
}

// ── 팔레트 / 룩 프리셋 ───────────────────────────────────

const PALETTE_PRESETS: Record<string, PaletteSwatch[]> = {
  warm: [
    { name: "amber", hex: "#E8A04B" },
    { name: "terracotta", hex: "#B5532A" },
    { name: "cream", hex: "#F2E4C9" },
  ],
  cold: [
    { name: "steel blue", hex: "#3E5C76" },
    { name: "slate", hex: "#1F2A37" },
    { name: "ice", hex: "#CFE3EE" },
  ],
  neon: [
    { name: "cyan", hex: "#22D3EE" },
    { name: "magenta", hex: "#E5379B" },
    { name: "deep night", hex: "#0B1020" },
  ],
  natural: [
    { name: "sage", hex: "#8FA68A" },
    { name: "oat", hex: "#D8CDB8" },
    { name: "bark", hex: "#5A4632" },
  ],
  sleek: [
    { name: "graphite", hex: "#2B2B2F" },
    { name: "platinum", hex: "#D9DBE0" },
    { name: "signal", hex: "#FF5A36" },
  ],
};

function pickPalette(tone: string[]): { palette: PaletteSwatch[]; stock: string; lighting: string } {
  const t = tone.map((x) => x.toLowerCase()).join(" ");
  if (/(neon|city|도시|night|밤|cyber)/.test(t)) return { palette: PALETTE_PRESETS.neon, stock: "anamorphic 2x squeeze, oval bokeh", lighting: "neon practicals, cyan-magenta contrast" };
  if (/(warm|따뜻|golden|로맨|romance)/.test(t)) return { palette: PALETTE_PRESETS.warm, stock: "Kodak Vision3 500T film grain", lighting: "warm motivated practicals, soft key" };
  if (/(cold|차가|thriller|noir|tense)/.test(t)) return { palette: PALETTE_PRESETS.cold, stock: "shot on Arri Alexa, cinematic color science", lighting: "cool moonlight key, hard rim" };
  if (/(sleek|product|광고|brand|tech|modern)/.test(t)) return { palette: PALETTE_PRESETS.sleek, stock: "RED Komodo, crisp highlight rolloff", lighting: "softbox studio lighting, controlled gradient" };
  return { palette: PALETTE_PRESETS.natural, stock: "35mm film, subtle halation", lighting: "naturalistic window light, soft diffusion" };
}

// ── Continuity Bible 빌드 ────────────────────────────────

function buildBible(brief: FilmBrief, locale: Locale = "ko"): ContinuityBible {
  const { palette, stock, lighting } = pickPalette([...brief.tone, brief.setting, brief.genre]);
  const visualDirection =
    `${brief.tone.join(", ") || "cinematic"} ${brief.genre} look — ${brief.logline}` +
    (brief.visualReferences.length ? `; referencing ${brief.visualReferences.join(", ")}` : "");

  const references: ReferenceEntry[] = [];

  // 1) 캐릭터
  brief.characters.forEach((c, i) => {
    references.push({
      id: `char_${pad(i + 1)}`,
      kind: "character",
      name: c.name,
      prompt: composeReferencePrompt({
        kind: "character",
        name: c.name,
        description: `${c.role}. ${c.description}`,
        tone: brief.tone,
        visualDirection,
      }),
      lockedTraits: deriveTraits(c.description),
      notes: c.role,
      approvedAssetIds: [],
    });
  });

  // 2) 공간 (setting을 1차 location으로)
  if (brief.setting) {
    references.push({
      id: "loc_01",
      kind: "location",
      name: brief.setting,
      prompt: composeReferencePrompt({
        kind: "location",
        name: brief.setting,
        description: brief.setting,
        tone: brief.tone,
        visualDirection,
      }),
      lockedTraits: [lighting, palette.map((p) => p.name).join("/")],
      notes: locale === "ko" ? "주 배경" : "Primary location",
      approvedAssetIds: [],
    });
  }

  // 3) 제품/브랜드
  if (brief.brandOrProduct) {
    references.push({
      id: "prod_01",
      kind: "prop",
      name: brief.brandOrProduct,
      prompt: composeReferencePrompt({
        kind: "prop",
        name: brief.brandOrProduct,
        description: brief.brandOrProduct,
        tone: brief.tone,
        visualDirection,
      }),
      lockedTraits:
        locale === "ko"
          ? ["정확한 로고·색상", "제품 비율 유지"]
          : ["accurate logo and color", "maintain product proportions"],
      notes: locale === "ko" ? "히어로 제품" : "Hero product",
      approvedAssetIds: [],
    });
  }

  // 4) mustInclude에서 소품 후보 추출
  brief.mustInclude.slice(0, 4).forEach((item, i) => {
    references.push({
      id: `prop_${pad(i + 2)}`,
      kind: "prop",
      name: item,
      prompt: composeReferencePrompt({ kind: "prop", name: item, description: item, tone: brief.tone, visualDirection }),
      lockedTraits: [item],
      notes: locale === "ko" ? "필수 소품" : "Required prop",
      approvedAssetIds: [],
    });
  });

  return {
    visualDirection,
    filmStock: stock,
    colorPalette: palette,
    lightingStyle: lighting,
    references,
    globalMustKeep: [
      ...brief.mustInclude,
      `color palette: ${palette.map((p) => p.name).join(", ")}`,
      `lighting: ${lighting}`,
    ],
    globalMustAvoid: [...brief.mustAvoid, "identity drift", "axis crossing", "logo distortion"],
  };
}

function deriveTraits(desc: string): string[] {
  const traits = desc
    .split(/[,，·、]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  return traits.length ? traits : [desc];
}

// ── 슬러그라인 / 씬 생성 헬퍼 ────────────────────────────

function sceneHeading(brief: FilmBrief, idx: number, timeOfDay: string): string {
  const interior = /(office|오피스|room|방|실내|interior|집|home|카페|cafe)/i.test(brief.setting);
  const place = brief.setting || "LOCATION";
  return `${interior ? "INT." : "EXT."} ${place.toUpperCase()} - ${timeOfDay.toUpperCase()}`;
}

const TIMES_OF_DAY = ["낮", "밤", "황혼", "새벽", "오후"];
const TIMES_OF_DAY_EN = ["day", "night", "dusk", "dawn", "afternoon"];

function timeOfDayLabel(idx: number, locale: Locale): string {
  return locale === "ko" ? TIMES_OF_DAY[idx] : TIMES_OF_DAY_EN[idx];
}

// ── 메인: 기획 → 전체 제작 ───────────────────────────────

export interface PlanOptions {
  premium?: boolean; // 최고 품질 우선 (비용 무시)
  budgetUsd?: number;
  imageProviderId?: string;
  videoProviderIds?: string[];
  billableKeyframeShots?: number;
  billableVideoShots?: number;
  videoTakesPerShot?: number;
  /** 생성되는 라벨/설명 텍스트의 UI 로케일 (기본 "ko" — 기존 호출부 호환). */
  locale?: Locale;
}

export function planProduction(brief: FilmBrief, opts: PlanOptions = {}): FilmProduction {
  const premium = opts.premium ?? true;
  const locale: Locale = opts.locale ?? "ko";
  const rng = mulberry32(hashSeed(`${brief.title}|${brief.logline}|${brief.format}`));
  const template = GENRE_TEMPLATES[brief.format];
  const duration = brief.durationSec || FORMAT_DEFAULT_DURATION[brief.format];
  const avgShotLen = template.avgShotLenSec;

  // 1) 규모 계산
  const totalShotsTarget = clamp(Math.round(duration / avgShotLen), 6, 600);
  const avgCoverage = 4;
  const beatsTotal = clamp(Math.round(totalShotsTarget / avgCoverage), template.beats.length, 140);
  const beatsPerScene = duration <= 90 ? 1 : duration <= 300 ? 2 : 3;
  const sequences = template.sequenceTarget;

  // 2) 바이블
  const bible = buildBible(brief, locale);
  const characterRefs = bible.references.filter((r) => r.kind === "character");
  const locationRef = bible.references.find((r) => r.kind === "location");
  const propRefs = bible.references.filter((r) => r.kind === "prop");

  // 3) 비트 확장 — 템플릿 비트를 weight 비례로 세분
  interface ExpandedBeat {
    tplName: string;
    tplNameEn: string;
    emotion: string;
    /** taxonomy가 emotionEn을 아직 안 주면 undefined — ko로 폴백. */
    emotionEn?: string;
    sceneType: Scene["type"];
    durationSec: number;
    /** 같은 템플릿 비트의 몇 번째 반복인지 (0-based) — 복붙처럼 보이지 않게 번호·진행을 붙인다. */
    copyIndex: number;
    copyCount: number;
  }
  const expanded: ExpandedBeat[] = [];
  for (const tb of template.beats) {
    const n = Math.max(1, Math.round(tb.weight * beatsTotal));
    const beatDur = (tb.weight * duration) / n;
    for (let i = 0; i < n; i++) {
      expanded.push({
        tplName: tb.name,
        tplNameEn: tb.nameEn,
        emotion: tb.emotion,
        emotionEn: readEmotionEn(tb),
        sceneType: tb.sceneType,
        durationSec: beatDur,
        copyIndex: i,
        copyCount: n,
      });
    }
  }

  // 4) 계층 빌드
  const scenesArr: Scene[] = [];
  const beatsArr: Beat[] = [];
  const shotsArr: ShotSpec[] = [];
  const sequencesArr: Sequence[] = [];

  let globalShotIndex = 0;
  let beatGlobal = 0;

  // 비트를 씬으로 그룹핑
  const sceneChunks: ExpandedBeat[][] = [];
  for (let i = 0; i < expanded.length; i += beatsPerScene) {
    sceneChunks.push(expanded.slice(i, i + beatsPerScene));
  }

  // 씬을 시퀀스로 그룹핑
  const scenesPerSeq = Math.ceil(sceneChunks.length / sequences);

  sceneChunks.forEach((chunk, sceneIdx) => {
    const sceneId = `sc${pad(sceneIdx + 1)}`;
    const lead = chunk[0];
    const timeOfDay = timeOfDayLabel((sceneIdx + Math.floor(rng() * 5)) % TIMES_OF_DAY.length, locale);
    const beatIds: string[] = [];

    chunk.forEach((eb) => {
      beatGlobal += 1;
      const beatId = `${sceneId}_bt${pad(beatGlobal)}`;
      beatIds.push(beatId);

      // 이 비트의 샷 생성 — 커버리지 패턴을 채워 넣음
      const pattern = COVERAGE_PATTERNS[eb.sceneType];
      const shotsInBeat = Math.max(pattern.length >= 3 ? 2 : 1, Math.round(eb.durationSec / avgShotLen));
      const shotIds: string[] = [];

      for (let s = 0; s < shotsInBeat; s++) {
        const cov = pattern[s % pattern.length];
        globalShotIndex += 1;
        const shotId = `${beatId}_sh${pad(globalShotIndex, 3)}`;

        // 이 샷에 등장할 레퍼런스 결정
        const refsForShot: ReferenceEntry[] = [];
        if (eb.sceneType === "product" && propRefs[0]) refsForShot.push(propRefs[0]);
        // 대화/감정엔 인물 1-2명, OTS면 둘
        if (["dialogue", "emotional", "establishing", "action", "montage"].includes(eb.sceneType)) {
          if (cov.angle === "ots" && characterRefs.length >= 2) {
            // reverse는 인물 순서 교차
            const a = characterRefs[(s % characterRefs.length)];
            const b = characterRefs[((s + 1) % characterRefs.length)];
            refsForShot.push(a, b);
          } else if (characterRefs.length) {
            refsForShot.push(characterRefs[s % characterRefs.length]);
          }
        }
        if (locationRef && cov.size !== "ECU") refsForShot.push(locationRef);

        const dur = suggestShotDuration(cov.size, avgShotLen);
        const hasDialogue = eb.sceneType === "dialogue" && cov.size !== "ELS" && cov.size !== "LS" && rng() > 0.4;
        const dialogue = hasDialogue ? sampleDialogue(brief, eb.emotion, rng) : undefined;
        const action = buildActionLine(brief, eb, cov, refsForShot, locale);
        // 생성 모델 프롬프트는 항상 영어 액션 라인으로 — 표시 언어와 분리.
        const actionEn = locale === "ko" ? buildActionLine(brief, eb, cov, refsForShot, "en") : action;

        const camera = { size: cov.size, angle: cov.angle, movement: cov.movement, lens: cov.lens };
        const generationPrompt = composeShotPrompt({
          action: actionEn,
          dialogue,
          camera,
          scene: {
            id: sceneId,
            index: sceneIdx,
            heading: sceneHeading(brief, sceneIdx, timeOfDay),
            type: eb.sceneType,
            location: brief.setting,
            timeOfDay,
            summary: "",
            characterRefs: characterRefs.map((c) => c.id),
            beatIds,
            locked: false,
          },
          bible,
          tone: brief.tone,
          refs: refsForShot,
          aspect: brief.aspect,
        });

        const movementEnergy = MOVEMENTS[cov.movement].energy;
        const route = routeVideoProvider({
          needsKeyframes: cov.needsKeyframes,
          hasDialogue,
          movementEnergy,
          size: cov.size,
          premium,
        });
        const provider = providerById(route.providerId);
        const estCost = provider ? provider.approxCostUsd * (premium ? 1.15 : 1) : 2;

        shotsArr.push({
          shotId,
          sceneId,
          beatId,
          index: globalShotIndex,
          durationSec: dur,
          shotType: eb.sceneType,
          camera,
          action,
          actionEn,
          dialogue,
          continuityRefs: refsForShot.map((r) => r.id),
          requiresKeyframe: cov.needsKeyframes,
          mustKeep: [...bible.globalMustKeep.slice(0, 2), ...refsForShot.flatMap((r) => r.lockedTraits.slice(0, 1))],
          mustAvoid: bible.globalMustAvoid.slice(0, 4),
          transitionIn: s === 0 ? "cut" : pickTransition(eb.sceneType, s, rng),
          transitionOut: pickTransition(eb.sceneType, s + 1, rng),
          generationPrompt,
          negativePrompt: composeNegativePrompt(eb.sceneType === "product" ? ["text artifacts"] : []),
          providerId: route.providerId,
          providerMode: route.mode,
          estCostUsd: Number(estCost.toFixed(2)),
          routing: route,
        });
        shotIds.push(shotId);
      }

      beatsArr.push({
        id: beatId,
        name:
          pickText(eb.tplName, eb.tplNameEn, locale) +
          (eb.copyCount > 1 ? ` ${eb.copyIndex + 1}/${eb.copyCount}` : ""),
        description: buildBeatDescription(brief, eb, locale),
        emotion: pickText(eb.emotion, eb.emotionEn, locale),
        shotIds,
      });
    });

    scenesArr.push({
      id: sceneId,
      index: sceneIdx,
      heading: sceneHeading(brief, sceneIdx, timeOfDay),
      type: lead.sceneType,
      location: brief.setting,
      timeOfDay,
      summary: buildSceneSummary(brief, lead, sceneIdx, locale),
      characterRefs: characterRefs.map((c) => c.id),
      beatIds,
      locked: false,
    });
  });

  // 시퀀스 그룹핑
  for (let q = 0; q < sequences; q++) {
    const slice = scenesArr.slice(q * scenesPerSeq, (q + 1) * scenesPerSeq);
    if (!slice.length) continue;
    sequencesArr.push({
      id: `seq${pad(q + 1)}`,
      index: q,
      title: sequenceTitle(template, q, sequences, locale),
      purpose: sequencePurpose(template, q, sequences, locale),
      sceneIds: slice.map((s) => s.id),
    });
  }

  // 4b) 부가 연출 레이어 (업그레이드) — 연속성 체인 + 초단위 안무 + 대사/오디오 + 타이포.
  const { typography, subtitleCues } = enrichShots({
    shots: shotsArr,
    scenes: scenesArr,
    beats: beatsArr,
    bible,
    brief,
    locale,
  });

  // 5) 비용 레저
  const cost = buildCostLedger(shotsArr, bible, opts.budgetUsd, {
    imageProviderId: opts.imageProviderId,
    videoProviderIds: opts.videoProviderIds,
    billableKeyframeShots: opts.billableKeyframeShots,
    billableVideoShots: opts.billableVideoShots,
    videoTakesPerShot: opts.videoTakesPerShot,
    costBasis: "next-run",
  });

  // 6) 통계
  const totalDur = shotsArr.reduce((a, s) => a + s.durationSec, 0);
  const stats: ProductionStats = {
    sequenceCount: sequencesArr.length,
    sceneCount: scenesArr.length,
    beatCount: beatsArr.length,
    shotCount: shotsArr.length,
    totalDurationSec: Number(totalDur.toFixed(1)),
    avgShotLenSec: Number((totalDur / Math.max(1, shotsArr.length)).toFixed(1)),
    estTotalCostUsd: cost.totalUsd,
    referenceCount: bible.references.length,
  };

  return {
    id: `oberon_${hashSeed(brief.title + Date.now()).toString(36)}`,
    brief,
    bible,
    sequences: sequencesArr,
    scenes: scenesArr,
    beats: beatsArr,
    shots: shotsArr,
    takes: [],
    edl: [],
    cost,
    stageStatus: { ...INITIAL_STAGE_STATUS, brief: "done", script: "ready" },
    createdAtMs: Date.now(),
    stats,
    typography,
    subtitleCues,
  };
}

// ── 부가 연출 레이어 통합 ────────────────────────────────
// 샷 전체를 한 번 더 훑어 (1) 연속성 체인을 잇고 (2) 초단위 안무 + 대사·오디오를
// 붙여 generationPrompt를 영화적으로 다시 합성한다. 글자는 후반 번인을 전제로
// 프레임 안에 그리지 않도록 지시한다.

function enrichShots(args: {
  shots: ShotSpec[];
  scenes: Scene[];
  beats: Beat[];
  bible: ContinuityBible;
  brief: FilmBrief;
  locale: Locale;
}): { typography: FilmProduction["typography"]; subtitleCues: FilmProduction["subtitleCues"] } {
  const { shots, scenes, beats, bible, brief, locale } = args;
  const refsById = new Map(bible.references.map((r) => [r.id, r]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const beatById = new Map(beats.map((b) => [b.id, b]));
  const chain = threadContinuity({ shots, scenes, beats, bible, brief, locale });

  // 속도 연출을 환영하는 포맷/장르인가 (슬로모·속도 램프).
  const allowSpeedFx =
    brief.format === "trailer" ||
    brief.format === "music_video" ||
    brief.format === "social_short" ||
    brief.genre === "action" ||
    brief.genre === "thriller";

  const dialogueByShot = new Map<string, DialogueLine>();

  for (const shot of shots) {
    const scene = sceneById.get(shot.sceneId);
    const beat = beatById.get(shot.beatId);
    const cont = chain.get(shot.shotId);
    const refsForShot = shot.continuityRefs
      .map((id) => refsById.get(id))
      .filter((r): r is ReferenceEntry => Boolean(r));
    const energy = MOVEMENTS[shot.camera.movement].energy;

    // 1) 초 단위 안무 — 프롬프트 합성 계열은 영어 액션 라인 사용.
    const chor = composeChoreography({
      durationSec: shot.durationSec,
      camera: shot.camera,
      action: shot.actionEn ?? shot.action,
      energy,
      hasDialogue: Boolean(shot.dialogue),
      allowSpeedFx,
    });

    // 2) 구조화된 대사 라인.
    let dialogueLine: DialogueLine | undefined;
    if (shot.dialogue) {
      const speaker = refsForShot.find((r) => r.kind === "character")?.name || brief.characters[0]?.name || "speaker";
      dialogueLine = {
        speaker,
        text: shot.dialogue,
        language: brief.language,
        emotion: beat?.emotion ?? "",
        delivery: deriveDelivery(beat?.emotion ?? "", brief.tone),
        voiceover: false,
      };
      dialogueByShot.set(shot.shotId, dialogueLine);
    }

    // 3) 오디오 베드 + 네이티브 오디오 디렉션.
    const provider = providerById(shot.providerId);
    const nativeAudio = provider?.nativeAudio ?? false;
    const bed = defaultAudioBed(shot.shotType, brief.setting, brief.tone);
    const audioDirection = composeAudioDirection({ dialogue: dialogueLine, bed, nativeAudio });
    const transDirective = transitionDirective(shot.transitionOut);

    // 4) 영화적 프롬프트 재합성 (연속성 + 안무 + 오디오 + 텍스트 금지).
    shot.generationPrompt = composeShotPrompt({
      action: shot.actionEn ?? shot.action,
      dialogue: shot.dialogue,
      camera: shot.camera,
      scene: scene ?? {
        id: shot.sceneId,
        index: 0,
        heading: "SCENE",
        type: shot.shotType,
        location: brief.setting,
        timeOfDay: locale === "ko" ? "낮" : "day",
        summary: "",
        characterRefs: [],
        beatIds: [],
        locked: false,
      },
      bible,
      tone: brief.tone,
      refs: refsForShot,
      aspect: brief.aspect,
      continuityNote: cont?.continuityPhrase,
      motionPhrase: chor.motionPhrase,
      audioDirection,
      transitionDirective: transDirective,
      suppressOnScreenText: true,
    });

    // 5) 샷에 저장 (UI·내보내기·렌더 어댑터가 읽음).
    shot.motionBeats = chor.beats;
    shot.motionPhrase = chor.motionPhrase;
    shot.speed = chor.speed;
    shot.dialogueLine = dialogueLine;
    shot.audioBed = bed;
    shot.audioDirection = audioDirection;
    shot.continuityNote = cont?.continuityPhrase;
    shot.appliedContinuityRules = cont?.appliedRules;
    shot.chainFromShotId = cont?.chainFromShotId;
    shot.isSceneOpening = cont?.isSceneOpening;
  }

  const typography = pickTypography({
    genre: brief.genre,
    format: brief.format,
    language: brief.language,
    tone: brief.tone,
    locale,
  });
  const subtitleCues = buildSubtitleCues({ shots, dialogueByShot });

  return { typography, subtitleCues };
}

// ── 비용 ─────────────────────────────────────────────────
// 외부 API 노출 추정 = 확인된 공급자 단가 × 이번 실행에서 실제 보낼 범위.
// 구독/CLI 경로와 공개 단가 미확인 공급자는 임의 달러 비용으로 부풀리지 않는다.

/** 현재 데스크톱 실렌더가 한 번에 외부 영상 API로 보내는 안전 상한. */
export const LIVE_KEYFRAME_MAX_SHOTS = 12;
export const LIVE_RENDER_MAX_SHOTS = 3;
export const LIVE_RENDER_TAKES_PER_SHOT = 1;
export const TAKES_PER_SHOT = LIVE_RENDER_TAKES_PER_SHOT;

export interface CostEstimateOptions {
  imageProviderId?: string;
  videoProviderIds?: string[];
  billableKeyframeShots?: number;
  billableVideoShots?: number;
  videoTakesPerShot?: number;
  costBasis?: CostLedger["costBasis"];
}

export function recomputeCost(
  shots: ShotSpec[],
  imageCostUsd: number,
  budgetUsd?: number,
  opts: CostEstimateOptions = {},
): CostLedger {
  const billableVideoShots = Math.max(
    0,
    Math.min(opts.billableVideoShots ?? LIVE_RENDER_MAX_SHOTS, shots.length),
  );
  const takesPerShot = Math.max(1, Math.min(opts.videoTakesPerShot ?? LIVE_RENDER_TAKES_PER_SHOT, 4));
  const videoRate = videoRatePerSecond(opts.videoProviderIds);
  const lines: CostLine[] = shots.slice(0, billableVideoShots).map((s) => ({
    shotId: s.shotId,
    providerId: videoRate.providerId,
    attempts: takesPerShot,
    costUsd: videoRate.usdPerSecond == null ? 0 : Number((s.durationSec * videoRate.usdPerSecond).toFixed(2)),
  }));
  const videoCost = Number(lines.reduce((a, l) => a + l.costUsd, 0).toFixed(2));
  const total = Number((videoCost + imageCostUsd).toFixed(2));
  const budget = budgetUsd ?? Math.max(10, Math.ceil((Math.max(total, 1) * 1.35) / 5) * 5);
  const noteParts = [videoRate.note].filter(Boolean);
  return {
    lines,
    imageCostUsd: Number(imageCostUsd.toFixed(2)),
    videoCostUsd: videoCost,
    takesPerShot,
    billableVideoShots,
    costBasis: opts.costBasis ?? "next-run",
    externalCostNote: noteParts.join(" · ") || undefined,
    totalUsd: total,
    budgetUsd: budget,
    withinBudget: total <= budget,
  };
}

function buildCostLedger(
  shots: ShotSpec[],
  bible: ContinuityBible,
  budgetUsd?: number,
  opts: CostEstimateOptions = {},
): CostLedger {
  // 이미지: 레퍼런스 시트(~3컷) + 실제 영상 전에 확인할 첫 프레임.
  const imageCost = estimateImageExternalCostUsd(shots, bible, opts.imageProviderId, opts.billableKeyframeShots);
  return recomputeCost(shots, imageCost, budgetUsd, opts);
}

export function recomputeProductionCost(
  production: FilmProduction,
  modelSettings = production.modelSettings,
): CostLedger {
  return buildCostLedger(production.shots, production.bible, production.cost.budgetUsd, {
    imageProviderId: modelSettings?.imageProvider,
    videoProviderIds: modelSettings?.videoProviders,
    billableKeyframeShots: LIVE_KEYFRAME_MAX_SHOTS,
    billableVideoShots: LIVE_RENDER_MAX_SHOTS,
    videoTakesPerShot: LIVE_RENDER_TAKES_PER_SHOT,
    costBasis: "next-run",
  });
}

function estimateImageExternalCostUsd(
  shots: ShotSpec[],
  bible: ContinuityBible,
  imageProviderId = "codex-cli-image",
  billableKeyframeShots = LIVE_KEYFRAME_MAX_SHOTS,
): number {
  const keyframeCount = Math.min(billableKeyframeShots, shots.filter((s) => s.requiresKeyframe).length);
  const count = keyframeCount + bible.references.length * 3;
  switch (imageProviderId) {
    case "codex-cli-image":
    case "nanobanana-image":
      return 0;
    case "google-image":
      return Number((count * 0.04).toFixed(2));
    default:
      return 0;
  }
}

function videoRatePerSecond(videoProviderIds: string[] | undefined): {
  providerId: string;
  usdPerSecond?: number;
  note?: string;
} {
  const ids = videoProviderIds?.length ? videoProviderIds : ["google-veo"];
  for (const id of ids) {
    switch (id) {
      case "grok-cli-video":
        return { providerId: id, usdPerSecond: 0, note: "Grok Imagine — SuperGrok 구독(추가 과금 없음)" };
      case "google-veo":
        return { providerId: id, usdPerSecond: 0.05, note: "Veo 3.1 Lite 720p audio upper-bound" };
      case "runway-video":
        return { providerId: id, usdPerSecond: 0.12, note: "Runway Gen-4.5 credit rate" };
      case "seedance-video":
        return { providerId: id, usdPerSecond: 0.3034, note: "fal Seedance 2.0 720p audio" };
      case "openai-sora":
        return { providerId: id, usdPerSecond: 0.1, note: "OpenAI Sora 2 720p" };
      case "luma-video":
      case "higgsfield-video":
      case "kling-video":
      case "replicate-video":
        return { providerId: id, note: "public per-second price not verified" };
      default:
        break;
    }
  }
  return { providerId: ids[0] ?? "unknown", note: "public per-second price not verified" };
}

// ── 내러티브 템플릿 (결정적) ─────────────────────────────

// 액션 라인은 두 벌이다: 표시용(로케일 완결 문장)과 프롬프트용(영어).
// 한 문장 틀에 양쪽 언어를 끼워 넣으면 "the subject alone — 눈·미세표정, 정화 on the face"
// 같은 깨진 문장이 나온다 — 절대 섞지 않는다.
function buildActionLine(
  brief: FilmBrief,
  eb: { tplName: string; tplNameEn: string; sceneType: Scene["type"]; emotion: string; emotionEn?: string },
  cov: { role: string; roleEn?: string },
  refs: ReferenceEntry[],
  locale: Locale,
): string {
  const product = brief.brandOrProduct;
  if (locale === "ko") {
    const who = refs.find((r) => r.kind === "character")?.name || brief.characters[0]?.name || "주인공";
    const role = cov.role;
    const emotion = eb.emotion;
    const tplName = eb.tplName;
    switch (eb.sceneType) {
      case "product":
        return `${product || "제품"}의 ${role} — ${emotion} 무드, 형태와 디테일 강조`;
      case "dialogue":
        return `${who}의 대화 — ${role}, ${emotion}`;
      case "action":
        return `${who}의 움직임 — ${role}, 역동적인 ${emotion}`;
      case "emotional":
        return `홀로 있는 ${who} — ${role}, 얼굴에 번지는 ${emotion}`;
      case "establishing":
        return `${brief.setting || "공간"}의 ${role} — "${tplName}"의 ${emotion}을 여는 컷`;
      case "montage":
        return `${role} — "${tplName}"를 밀고 가는 짧은 ${emotion}의 조각`;
      default:
        return `${role} — ${emotion} 브리지`;
    }
  }
  const who = refs.find((r) => r.kind === "character")?.name || brief.characters[0]?.name || "the subject";
  const role = cov.roleEn || cov.role;
  const emotion = eb.emotionEn || eb.emotion;
  const tplName = eb.tplNameEn || eb.tplName;
  switch (eb.sceneType) {
    case "product":
      return `${role} of ${product || "the product"}, ${emotion} mood, emphasizing form and detail`;
    case "dialogue":
      return `${who} in conversation — ${role}, ${emotion}`;
    case "action":
      return `${who} in motion — ${role}, kinetic ${emotion}`;
    case "emotional":
      return `${who} alone — ${role}, ${emotion} on the face`;
    case "establishing":
      return `${role} of ${brief.setting} — sets the ${emotion} of "${tplName}"`;
    case "montage":
      return `${role} — quick ${emotion} fragment advancing "${tplName}"`;
    default:
      return `${role} — ${emotion} bridge`;
  }
}

function buildBeatDescription(
  brief: FilmBrief,
  eb: {
    tplName: string;
    tplNameEn: string;
    emotion: string;
    emotionEn?: string;
    sceneType: Scene["type"];
    copyIndex?: number;
    copyCount?: number;
  },
  locale: Locale,
): string {
  const tplName = pickText(eb.tplName, eb.tplNameEn, locale);
  const emotion = pickText(eb.emotion, eb.emotionEn, locale);
  const phase = beatProgression(eb.copyIndex ?? 0, eb.copyCount ?? 1, locale);
  return `[${tplName}] ${emotion}${phase ? ` · ${phase}` : ""} — ${brief.logline.slice(0, 80)}${brief.logline.length > 80 ? "…" : ""}`;
}

/** 같은 템플릿 비트가 여러 번 반복될 때 각 반복에 서사적 진행을 부여한다. */
function beatProgression(i: number, n: number, locale: Locale): string {
  if (n <= 1) return "";
  if (locale === "ko") {
    if (i === 0) return "비트를 연다";
    if (i === n - 1) return "다음 국면으로 넘긴다";
    return "밀도를 한 단계 올린다";
  }
  if (i === 0) return "opens the beat";
  if (i === n - 1) return "hands off to the next movement";
  return "raises the density";
}

function buildSceneSummary(
  brief: FilmBrief,
  eb: { tplName: string; tplNameEn: string; emotion: string; emotionEn?: string },
  idx: number,
  locale: Locale,
): string {
  const tplName = pickText(eb.tplName, eb.tplNameEn, locale);
  const emotion = pickText(eb.emotion, eb.emotionEn, locale);
  if (locale === "ko") {
    return `씬 ${idx + 1} · "${tplName}" — ${emotion}. ${brief.setting}에서 ${brief.characters[0]?.name || "주인공"}을 중심으로 전개.`;
  }
  return `Scene ${idx + 1} · "${tplName}" — ${emotion}. Unfolds around ${brief.characters[0]?.name || "the protagonist"} in ${brief.setting}.`;
}

const DIALOGUE_BANK: Record<string, string[]> = {
  ko: ["…괜찮아?", "이게 마지막 기회야.", "내가 말했잖아.", "준비됐어.", "믿어도 돼?", "시간이 없어.", "여기서 끝내자."],
  en: ["…you okay?", "This is our last shot.", "I told you.", "I'm ready.", "Can I trust you?", "We're out of time.", "Let's end this here."],
};

function sampleDialogue(brief: FilmBrief, emotion: string, rng: () => number): string {
  const bank = DIALOGUE_BANK[brief.language] ?? DIALOGUE_BANK.en;
  return bank[Math.floor(rng() * bank.length)];
}

function pickTransition(sceneType: Scene["type"], i: number, rng: () => number): ShotSpec["transitionOut"] {
  if (sceneType === "action") return rng() > 0.6 ? "smash_cut" : "cut";
  if (sceneType === "montage") return rng() > 0.5 ? "match_cut" : "cut";
  if (sceneType === "transition") return "whip_pan";
  if (sceneType === "dialogue") return rng() > 0.7 ? "l_cut" : "cut";
  if (sceneType === "emotional") return rng() > 0.6 ? "dissolve" : "cut";
  return "cut";
}

function sequenceTitle(template: { label: string; labelEn?: string }, q: number, total: number, locale: Locale): string {
  if (locale === "ko") {
    if (total === 1) return "메인 시퀀스";
    const names = ["오프닝", "전개", "고조", "절정", "결말"];
    return names[Math.min(q, names.length - 1)];
  }
  if (total === 1) return "Main Sequence";
  const namesEn = ["Opening", "Rising Action", "Escalation", "Climax", "Resolution"];
  return namesEn[Math.min(q, namesEn.length - 1)];
}

function sequencePurpose(template: { arc: string; arcEn?: string }, q: number, total: number, locale: Locale): string {
  const arc = pickText(template.arc, template.arcEn, locale);
  const parts = arc.split("→").map((s) => s.trim());
  if (parts.length >= total) return parts[Math.min(q, parts.length - 1)];
  return arc;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── 생성 시뮬레이션 (실제 API 없이 파이프라인 실증) ───────
// 실제 키 연결 시 이 함수가 어댑터 호출로 교체된다.

// 차분한 차콜 — 무지개 금지 (컷팅룸 컨택트시트 톤).
const GRADIENTS = [
  "linear-gradient(160deg,#2A2824,#3A3833)",
  "linear-gradient(160deg,#262420,#363430)",
  "linear-gradient(160deg,#2C2A25,#3C3A34)",
  "linear-gradient(160deg,#222019,#34322C)",
];

export function makeTakesForShot(shot: ShotSpec, count = 3): Take[] {
  const rng = mulberry32(hashSeed(shot.shotId));
  const takes: Take[] = [];
  for (let i = 0; i < count; i++) {
    takes.push({
      id: `${shot.shotId}_tk${pad(i + 1)}`,
      shotId: shot.shotId,
      attempt: i + 1,
      status: "queued",
      providerId: shot.providerId,
      providerMode: shot.providerMode,
      thumbnailGradient: GRADIENTS[(shot.index + i) % GRADIENTS.length],
      costUsd: shot.estCostUsd,
      createdAtMs: Date.now(),
    });
  }
  return takes;
}

/** 합성 QA — 실제로는 Vision QA 에이전트가 채점. */
export function scoreTake(take: Take, shot: ShotSpec, locale: Locale = "ko"): QAResult {
  const rng = mulberry32(hashSeed(take.id + shot.shotId));
  const base = 0.7 + rng() * 0.28;
  const findings: QAFinding[] = [];
  if (rng() > 0.78)
    findings.push({
      type: "continuity",
      severity: "medium",
      note: locale === "ko" ? "의상 색이 레퍼런스와 미세하게 다름" : "Wardrobe color drifts slightly from the reference",
    });
  if (rng() > 0.85)
    findings.push({
      type: "editability",
      severity: "low",
      note: locale === "ko" ? "마지막 0.5초 카메라가 불안정 — 핸들 부족" : "Camera unstable in the final 0.5s — insufficient cut handle",
    });
  if (shot.dialogue && rng() > 0.8)
    findings.push({
      type: "dialogue",
      severity: "medium",
      note: locale === "ko" ? "립싱크 타이밍 약간 어긋남" : "Lip-sync timing is slightly off",
    });
  if (rng() > 0.9)
    findings.push({ type: "motion", severity: "high", note: locale === "ko" ? "손 모션 깨짐" : "Hand motion breaks down" });
  const score = Number(Math.max(0.4, base - findings.length * 0.08).toFixed(2));
  const highFail = findings.some((f) => f.severity === "high");
  const pass = score >= 0.75 && !highFail;
  return {
    takeId: take.id,
    shotId: shot.shotId,
    score,
    pass,
    findings,
    recommendedAction: pass
      ? "accept"
      : highFail
        ? "retry_stronger_reference"
        : findings.some((f) => f.type === "continuity")
          ? "retry_stronger_reference"
          : "retry_same_provider",
  };
}

/** EDL 빌드 — shot별 best take를 골라 컷 순서/길이/전환 결정. */
export function buildEdl(shots: ShotSpec[], takes: Take[]): EditDecision[] {
  const byShot = new Map<string, Take[]>();
  for (const t of takes) {
    const arr = byShot.get(t.shotId) ?? [];
    arr.push(t);
    byShot.set(t.shotId, arr);
  }
  const edl: EditDecision[] = [];
  let order = 0;
  for (const shot of shots) {
    const cands = (byShot.get(shot.shotId) ?? []).filter((t) => t.status !== "failed");
    if (!cands.length) continue;
    const best = cands.reduce((a, b) => ((b.qa?.score ?? 0) > (a.qa?.score ?? 0) ? b : a));
    order += 1;
    // 핸들: 첫/마지막 0.3초 trim (컷 연결용)
    const handle = 0.3;
    edl.push({
      shotId: shot.shotId,
      takeId: best.id,
      order,
      inSec: handle,
      outSec: Number((shot.durationSec - handle).toFixed(1)),
      transitionIn: shot.transitionIn,
      durationSec: Number((shot.durationSec - handle * 2).toFixed(1)),
    });
  }
  return edl;
}
