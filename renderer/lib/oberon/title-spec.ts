// Oberon — FilmProduction → OberonTitleSpec (결정적 타이틀/자막 번인 입력).
//
// 엔진이 만든 TypographyKit + 자막 큐를 electron 렌더 레인이 쓰는 직렬화 형태로 옮긴다.
// 렌더 요청에 titles로 실으면 render.ts가 *_titled.mp4(타이틀 카드 + 로어서드 + 자막 번인)를
// 추가 생성한다. master_mp4는 그대로(글자 없는 클린본) 유지되므로 번인은 항상 additive.

import type { OberonLowerThird, OberonSubtitleCue, OberonTextStyle, OberonTitleSpec } from "@shared/oberon-titles";
import { FONT_LIBRARY, googleFontsHref, type TextStyleSpec, type TypographyKit } from "./typography";
import type { FilmProduction } from "./types";

function styleToOberon(spec: TextStyleSpec): OberonTextStyle {
  const font = FONT_LIBRARY[spec.fontId];
  return {
    fontName: font.name,
    fontStack: font.stack,
    fontCategory: font.category,
    cjk: font.cjk,
    sizePct: spec.sizePct,
    weight: spec.weight,
    tracking: spec.tracking,
    case: spec.case,
    position: spec.position,
    fill: spec.fill,
    outline: spec.outline,
    boxBg: spec.boxBg,
    safeAreaPct: spec.safeAreaPct,
  };
}

/** 제목을 너무 길면 공백 기준 2줄로 접는다(타이틀 카드 가독성). */
function wrapTitle(title: string): string[] {
  const t = title.trim();
  if (t.length <= 16 || !t.includes(" ")) return [t];
  const words = t.split(/\s+/);
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

/** FilmProduction → OberonTitleSpec. 타이포 키트가 없으면 undefined(번인 생략). */
export function buildTitleSpec(production: FilmProduction): OberonTitleSpec | undefined {
  const kit: TypographyKit | undefined = production.typography;
  if (!kit) return undefined;

  const cues = production.subtitleCues ?? [];
  const subtitles: OberonSubtitleCue[] = cues.map((c) => ({
    startSec: c.startSec,
    endSec: c.endSec,
    text: c.text,
    speaker: c.speaker,
    voiceover: c.kind === "narration",
  }));

  // 로어서드 — 화자별 첫 등장에 이름 라벨(최대 3명).
  const lowerThirds: OberonLowerThird[] = [];
  const seen = new Set<string>();
  for (const c of cues) {
    if (!c.speaker || seen.has(c.speaker) || c.kind === "narration") continue;
    seen.add(c.speaker);
    lowerThirds.push({
      lines: [c.speaker],
      style: styleToOberon(kit.styles.lower_third),
      startSec: Number(c.startSec.toFixed(2)),
      endSec: Number((c.startSec + 2.5).toFixed(2)),
    });
    if (lowerThirds.length >= 3) break;
  }

  return {
    aspectRatio: production.brief.aspect,
    titleCard: {
      kind: "title",
      lines: wrapTitle(production.brief.title),
      style: styleToOberon(kit.styles.title),
      bg: "#000000",
      durationSec: 2.4,
    },
    endCard: {
      kind: "end_card",
      lines: [production.brief.title.trim()],
      style: styleToOberon(kit.styles.end_card),
      bg: "#0A0A0A",
      durationSec: 1.8,
    },
    lowerThirds,
    subtitles,
    subtitleStyle: styleToOberon(kit.styles.subtitle_caption),
    fontImportHref: googleFontsHref(kit) ?? undefined,
    rationale: kit.rationale,
  };
}
