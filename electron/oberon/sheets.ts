// Oberon — 마스터 시트 / 콘티 시트 생성 진입점.
//
// 시트는 "생성 전에 정체성과 흐름을 잠그는" 이미지 산출물이다:
//   마스터 시트 → 캐릭터/제품 정체성 락 (I2V Element 주입·검수 기준)
//   콘티 시트   → 한 편 전체 흐름 락 (인간 승인 게이트의 시각 자료)
//   컷 분해 시트 → 핵심 컷의 START/END 프레임 설계 (키프레임 체이닝 소스)
//
// 프롬프트는 shared/oberon-sheets.ts 빌더가 렌더러에서 완성해 보내고,
// 생성·폴링·취소는 키프레임 잡 인프라를 그대로 재사용한다
// (조회는 oberon:getKeyframeJob, 취소는 oberon:cancelKeyframes).

import type { OberonKeyframeJob, OberonKeyframeShotInput, OberonSheetRequest } from "../../shared/types";
import { sheetAspect, sheetAssetKind } from "../../shared/oberon-sheets";
import { startOberonKeyframes } from "./keyframes";

export function startOberonSheets(request: OberonSheetRequest): OberonKeyframeJob {
  if (!request.sheets.length) throw new Error("Oberon sheet generation requires at least one sheet.");
  const shots: OberonKeyframeShotInput[] = request.sheets.map((sheet, index) => ({
    shotId: sheet.id,
    index,
    aspectRatio: sheet.aspectRatio || sheetAspect(sheet.kind),
    prompt: sheet.prompt,
    assetKind: sheetAssetKind(sheet.kind),
  }));
  return startOberonKeyframes({
    productionId: request.productionId,
    title: `${request.title} sheets`,
    aspectRatio: shots[0].aspectRatio,
    shots,
    maxShots: shots.length,
    provider: request.provider,
    model: request.model,
    // 시트는 텍스트 라벨이 들어가는 레퍼런스 — 기본 2K로 또렷하게.
    imageSize: request.imageSize ?? "2K",
  });
}
