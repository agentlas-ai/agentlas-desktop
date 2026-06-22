// Oberon — 대사 · 오디오 · 자막 (목표 3: 자막과 음성 대사를 잘 넣는 프롬프트).
//
// 기존엔 dialogue가 7줄짜리 뱅크에서 뽑은 단순 문자열이었다. 여기서 그 대사를
// "화자 · 감정 · 딜리버리 · 언어"가 박힌 구조로 만들고:
//   1) Veo 3.1 네이티브 동기 오디오를 위한 정밀한 오디오 디렉션 구문을 만들고,
//   2) 글자는 생성 모델에 맡기지 않고(깨진 텍스트 방지) 후반 번인용 자막 큐(SRT/VTT)를 만든다.
//
// 원칙: 대사는 모델이 "입모양과 동기되게" 말하도록 지시하되, 화면 자막은 절대
//       프레임 안에 생성하지 않는다 — 타이포 키트로 후반 합성한다.

import type { ShotSpec } from "./types";
import type { TypographyKit } from "./typography";

// ── 대사 라인 ────────────────────────────────────────────

export type DialogueDelivery =
  | "neutral"
  | "whisper"
  | "intense"
  | "warm"
  | "cold"
  | "urgent"
  | "playful"
  | "broken"; // 울먹임·끊김

export interface DialogueLine {
  /** 화자 reference id 또는 이름. */
  speaker: string;
  text: string;
  language: "ko" | "en";
  /** 감정 (비트의 emotion에서 파생). */
  emotion: string;
  delivery: DialogueDelivery;
  /** 보이스오버(내레이션)인가 — 입모양 동기 불필요. */
  voiceover: boolean;
}

// ── 오디오 베드 (앰비언스 + SFX + 음악) ─────────────────

export interface AudioBed {
  /** 환경음 한 줄 ("rain on glass, distant traffic"). */
  ambience: string;
  /** 효과음 큐들. */
  sfx: string[];
  /** 음악 큐 (있으면). */
  musicCue?: string;
}

// ── 자막 큐 (후반 번인) ──────────────────────────────────

export interface SubtitleCue {
  index: number;
  shotId: string;
  startSec: number;
  endSec: number;
  text: string;
  /** 일반 대사 자막 vs 화자 라벨/위치(로어서드) 구분. */
  kind: "dialogue" | "narration" | "lower_third" | "kicker";
  speaker?: string;
}

// ── 톤·감정 → 딜리버리 매핑 ──────────────────────────────

export function deriveDelivery(emotion: string, tone: string[]): DialogueDelivery {
  const e = emotion.toLowerCase();
  const t = tone.map((x) => x.toLowerCase()).join(" ");
  if (/(긴장|tense|위협|stakes|suspense)/.test(e + t)) return "intense";
  if (/(공감|warm|친밀|intimate|tender|따뜻)/.test(e + t)) return "warm";
  if (/(긴급|urgent|위기|crisis|폭발|adrenaline)/.test(e + t)) return "urgent";
  if (/(차가|cold|noir|냉정)/.test(e + t)) return "cold";
  if (/(정화|여운|melanchol|울|broken|동요)/.test(e + t)) return "broken";
  if (/(경쾌|playful|comedy|코미)/.test(e + t)) return "playful";
  if (/(속삭|whisper|고독|quiet)/.test(e + t)) return "whisper";
  return "neutral";
}

const DELIVERY_PHRASE: Record<DialogueDelivery, string> = {
  neutral: "in a natural, conversational tone",
  whisper: "in a hushed, intimate near-whisper",
  intense: "with controlled, low intensity and tight jaw",
  warm: "warmly, with a soft, caring tone",
  cold: "flatly, cold and detached",
  urgent: "fast and urgent, breath short",
  playful: "lightly, with a playful lilt",
  broken: "voice trembling, on the edge of breaking",
};

// ── Veo 네이티브 오디오 디렉션 ───────────────────────────
// Veo 3.1은 대사·SFX·앰비언스를 영상과 동기 생성한다. 따옴표 안의 정확한
// 대사 + 딜리버리 + 입모양 동기 지시 + 사운드 레이어를 명시한다.

export function composeAudioDirection(args: {
  dialogue?: DialogueLine;
  bed: AudioBed;
  /** 이 프로바이더가 네이티브 오디오를 지원하는가 (Veo/Seedance). */
  nativeAudio: boolean;
}): string {
  const { dialogue, bed, nativeAudio } = args;
  const parts: string[] = [];

  if (dialogue && dialogue.text.trim()) {
    if (dialogue.voiceover) {
      parts.push(`Voiceover narration (off-screen, not lip-synced), ${DELIVERY_PHRASE[dialogue.delivery]}: "${dialogue.text}"`);
    } else {
      parts.push(
        `The character speaks this line ${DELIVERY_PHRASE[dialogue.delivery]}, mouth movements precisely lip-synced to the words: "${dialogue.text}"`,
      );
    }
    if (dialogue.language === "ko") parts.push("Dialogue performed in natural Korean.");
  }

  // 사운드 레이어 — 네이티브 오디오 모델에만.
  if (nativeAudio) {
    if (bed.ambience) parts.push(`Ambient sound: ${bed.ambience}.`);
    if (bed.sfx.length) parts.push(`Synced sound effects: ${bed.sfx.join(", ")}.`);
    if (bed.musicCue) parts.push(`Music: ${bed.musicCue}.`);
    parts.push("Audio must be diegetic and synchronized to the on-screen action.");
  }

  return parts.join(" ");
}

// ── 씬 타입 → 기본 오디오 베드 ───────────────────────────

export function defaultAudioBed(sceneType: string, setting: string, tone: string[]): AudioBed {
  const moody = tone.map((x) => x.toLowerCase()).join(" ");
  const isNight = /(밤|night|neon|noir)/.test(setting + moody);
  switch (sceneType) {
    case "action":
      return { ambience: "tense low-end rumble, wind", sfx: ["impact hits", "fast footsteps", "cloth and gear movement"], musicCue: "driving percussive score, rising" };
    case "dialogue":
      return { ambience: isNight ? "quiet room tone, faint city hum" : "soft room tone", sfx: ["subtle cloth movement"], musicCue: "sparse, warm underscore" };
    case "emotional":
      return { ambience: "intimate quiet, distant ambience", sfx: ["a single breath"], musicCue: "tender piano/strings, slow" };
    case "establishing":
      return { ambience: isNight ? "night ambience, distant traffic" : "location-appropriate ambience", sfx: [], musicCue: "atmospheric pad, world-setting" };
    case "product":
      return { ambience: "clean studio quiet", sfx: ["a crisp tactile click", "subtle whoosh on reveal"], musicCue: "modern, confident brand bed" };
    case "montage":
      return { ambience: "energetic bed", sfx: ["rhythmic accents on cuts"], musicCue: "uplifting, building montage track" };
    default:
      return { ambience: "neutral room tone", sfx: [], musicCue: "subtle transitional swell" };
  }
}

// ── 자막 큐 빌드 (후반 번인 SRT/VTT) ─────────────────────
// EDL이 있으면 컷 타이밍 기준으로, 없으면 샷 누적 길이 기준으로 큐를 만든다.

export interface SubtitleBuildInput {
  shots: ShotSpec[];
  /** 샷별 대사 라인 (engine이 채움). */
  dialogueByShot: Map<string, DialogueLine>;
}

export function buildSubtitleCues(input: SubtitleBuildInput): SubtitleCue[] {
  const { shots, dialogueByShot } = input;
  const cues: SubtitleCue[] = [];
  let clock = 0;
  let index = 0;
  for (const shot of shots) {
    const start = clock;
    const end = Number((clock + shot.durationSec).toFixed(2));
    const line = dialogueByShot.get(shot.shotId);
    if (line && line.text.trim()) {
      index += 1;
      // 자막은 컷 인/아웃에서 0.15초 안쪽으로 — 컷에 딱 붙지 않게.
      cues.push({
        index,
        shotId: shot.shotId,
        startSec: Number((start + 0.15).toFixed(2)),
        endSec: Number((end - 0.1).toFixed(2)),
        text: line.text,
        kind: line.voiceover ? "narration" : "dialogue",
        speaker: line.speaker,
      });
    }
    clock = end;
  }
  return cues;
}

// ── SRT / VTT 직렬화 ─────────────────────────────────────

function fmtTimestamp(sec: number, comma: boolean): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const sep = comma ? "," : ".";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(millis, 3)}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => {
      const label = c.kind === "narration" ? "(V.O.) " : "";
      return `${i + 1}\n${fmtTimestamp(c.startSec, true)} --> ${fmtTimestamp(c.endSec, true)}\n${label}${c.text}\n`;
    })
    .join("\n");
}

export function toVtt(cues: SubtitleCue[], kit?: TypographyKit): string {
  const head: string[] = ["WEBVTT", ""];
  if (kit) {
    const s = kit.styles.subtitle_caption;
    // VTT STYLE 블록 — 자막 폰트/외곽선을 타이포 키트에서.
    head.push("STYLE", "::cue {", `  font-family: ${fontFamilyName(kit, "body")};`, `  font-weight: ${s.weight};`, "  color: #ffffff;", "  background: rgba(0,0,0,0.34);", "}", "");
  }
  const body = cues
    .map((c) => {
      const label = c.kind === "narration" ? "(V.O.) " : "";
      return `${c.index}\n${fmtTimestamp(c.startSec, false)} --> ${fmtTimestamp(c.endSec, false)}\n${label}${c.text}`;
    })
    .join("\n\n");
  return head.join("\n") + body + "\n";
}

function fontFamilyName(kit: TypographyKit, which: "body" | "display"): string {
  // typography.FONT_LIBRARY를 직접 import하면 순환 위험 없음(typography는 audio를 모름).
  return which === "body" ? kit.bodyFontId : kit.displayFontId;
}
