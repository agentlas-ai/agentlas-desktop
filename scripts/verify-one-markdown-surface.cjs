#!/usr/bin/env node
const assert = require("node:assert/strict");
const { buildOneSurfaceFromMarkdown, chooseOneSurfaceForDisplay } = require("../dist/electron/one/markdown-surface.js");
const { parseSurfaces } = require("../dist/electron/surface-emitter.js");
const { adaptLegacySurfaceToOneV1 } = require("../dist/shared/one-surface.js");

const markdown = `## 결론: 추천 제품 A

제품 A가 조건에 가장 잘 맞습니다.

| 제품 | 가격 | 장점 | 한계 |
|---|---|---|---|
| 제품 A | 390,000원 | 넓은 면적 | 크기가 큼 |
| 제품 B | 310,000원 | 작은 크기 | 면적이 작음 |

Sources: [제조사](https://example.com/product-a) · [가격 비교](https://example.org/compare)`;

const legacy = buildOneSurfaceFromMarkdown({ markdown, fallbackTitle: "공기청정기 비교" });
assert.ok(legacy, "a cited Markdown comparison must become a validated legacy Surface");
assert.equal(legacy.data.comparison.type, "table");
assert.equal(legacy.data.comparison.rows.length, 2);
assert.equal(legacy.evidence.length, 2);

const one = adaptLegacySurfaceToOneV1({
  manifest: legacy,
  taskId: "task_markdown_surface",
  surfaceId: "surface_markdown_surface",
  fallbackMarkdown: markdown,
  recordedAt: new Date().toISOString(),
});
assert.ok(one.blocks.some((block) => block.type === "Table"), "One must render a native Table block");
assert.ok(one.blocks.some((block) => block.type === "SourceList"), "One must render the cited sources as a native SourceList block");
assert.equal(one.evidence.length, 2);

const travelMarkdown = `## 날짜별 일정

**날짜별 일정 (7/24 목 ~ 7/26 토)**

- **1일차 (목)** — 09:30 제주공항 도착 → 12:20 협재로 이동 → 15:00 협재해수욕장
- **2일차 (금)** — 10:00 한림공원 → 13:00 숙소에서 낮잠 → 16:00 실내 전시
- **3일차 (토)** — 10:00 해안 산책 → 13:00 공항 이동

## 예상 비용

| 항목 | 금액 | 근거 |
|---|---|---|
| 항공권 | 300,000원 | 추정 |
| 숙소 2박 | 300,000원 | 추정 |
| 입장료 | 83,000원 | 공식 가격 확인됨 |

**출발 전 체크리스트**

예약 3건(항공 — 아이 운임 확인 포함, 숙소 — 얼리체크인 문의, 렌터카 — 카시트 포함)과 짐 준비(물놀이용품·방수기저귀, 자외선 차단, 아이 상비약, 낮잠용품·유모차), 그리고 **출발 2~3일 전 태풍·날씨 예보 확인**이 필수입니다.

출처: [공식 관광](https://example.com/travel), [공식 요금](https://example.org/price)`;
const travelPrompt = "아이와 제주 2박 3일 여행 계획을 짜줘. 총예산 120만원, 날짜별 일정과 동선, 예상 비용, 체크리스트가 필요해.";
// A judged travel verdict (source:"llm") is required for the travel layout — the
// travel/product regexes no longer decide it.
const travelLegacy = buildOneSurfaceFromMarkdown({
  markdown: travelMarkdown,
  fallbackTitle: "제주 가족 여행",
  taskPrompt: travelPrompt,
  judgedIntent: { intent: "travel", source: "llm" },
});
assert.ok(travelLegacy, "a judged travel verdict must preserve travel semantics instead of flattening everything into a table");
assert.equal(travelLegacy.data.schedule.type, "timeline");
assert.equal(travelLegacy.data.schedule.items.length, 3);
assert.equal(travelLegacy.data.costs.type, "pricing");
assert.equal(travelLegacy.data.costs.limit, 1_200_000);
assert.equal(travelLegacy.data.costs.items[2].verificationStatus, "verified");
assert.equal(travelLegacy.data.checklist.items.length, 8);
assert.equal(travelLegacy.data.comparison, undefined);
const travelOne = adaptLegacySurfaceToOneV1({
  manifest: travelLegacy,
  taskId: "task_travel_markdown",
  surfaceId: "surface_travel_markdown",
  syncedAt: new Date().toISOString(),
});
assert.deepEqual(
  travelOne.blocks.map((block) => block.type),
  ["Narrative", "Timeline", "Budget", "Checklist", "SourceList"],
  "desktop and mobile must receive portable travel blocks",
);

// ── The judged surface intent decides; no model → GENERIC, never keyword ──
const arabicTravelPrompt = "خطط لي رحلة عائلية ليومين في جيجو مع ميزانية وجدول يومي وقائمة تحضير";
// (a) A judged travel verdict FIRES on a prompt every wordlist misses (Arabic).
const judgedTravel = buildOneSurfaceFromMarkdown({
  markdown: travelMarkdown,
  fallbackTitle: "family trip",
  taskPrompt: arabicTravelPrompt,
  judgedIntent: { intent: "travel", source: "llm" },
});
assert.ok(judgedTravel, "the judged travel intent must produce the travel surface");
assert.equal(judgedTravel.data.schedule.type, "timeline", "a judged travel verdict must win over the regex miss");
assert.equal(judgedTravel.data.costs.type, "pricing");
// (b) NO model verdict is NOT a decision. source:"fallback" AND an absent
// judgedIntent both fall to the neutral GENERIC layout — never the keyword travel
// guess from the (Korean, travel-shaped) taskPrompt.
const fallbackTravel = buildOneSurfaceFromMarkdown({
  markdown: travelMarkdown,
  fallbackTitle: "family trip",
  taskPrompt: arabicTravelPrompt,
  judgedIntent: { intent: "travel", source: "fallback" },
});
assert.ok(fallbackTravel);
assert.equal(fallbackTravel.data.schedule, undefined, "source:fallback must keep the neutral generic layout, not keyword travel");
const noModelTravel = buildOneSurfaceFromMarkdown({
  markdown: travelMarkdown,
  fallbackTitle: "family trip",
  taskPrompt: travelPrompt,
});
assert.ok(noModelTravel);
assert.equal(noModelTravel.data.schedule, undefined,
  "no judgedIntent (no connected model) must not keyword-infer a travel plan from the prompt");
assert.equal(noModelTravel.data.costs, undefined, "no-model travel prompt must not build a travel budget from keywords");
// (c) A judged product-comparison verdict decides the comparison presentation.
const judgedProduct = buildOneSurfaceFromMarkdown({
  markdown,
  fallbackTitle: "비교",
  judgedIntent: { intent: "product-comparison", source: "llm" },
});
const judgedGeneric = buildOneSurfaceFromMarkdown({
  markdown,
  fallbackTitle: "비교",
  judgedIntent: { intent: "generic", source: "llm" },
});
const comparisonTitle = (manifest) => manifest.widgets.find((widget) => widget.data === "comparison").title;
assert.notEqual(comparisonTitle(judgedProduct), comparisonTitle(judgedGeneric),
  "the judged intent must pick the comparison presentation");

const recommendationMarkdown = `## 최종 추천: LG Example — 약 34만원

조건에 가장 균형 잡힌 선택입니다.

**대안 비교**:

1. **쿠쿠 Example** — 약 32만원. 더 넓은 면적을 커버합니다.
2. **삼성 Example** — 약 37만원. 앱 연동이 편리합니다.

Sources: [리뷰](https://example.com/review), [가격](https://example.org/price)`;
const recommendationSurface = buildOneSurfaceFromMarkdown({
  markdown: recommendationMarkdown,
  fallbackTitle: "추천 비교",
});
assert.ok(recommendationSurface, "a cited recommendation plus alternatives must become a comparison table");
assert.equal(recommendationSurface.data.comparison.rows.length, 3);

const toolBackedPlainRecommendation = buildOneSurfaceFromMarkdown({
  markdown: `30만원 예산이면 **위닉스 타워 프라임 (APRM833-JWK)** 을 고르시면 됩니다. 확인한 가격은 27만8천원이며 사용면적은 85.8㎡입니다.\n\n- 이전 추천 제품은 현재 예산을 넘어서 제외했습니다.\n- 더 싼 후보는 인증과 사용면적을 확인하지 못해 제외했습니다.\n- 이 제품은 예산, 인증, 사용면적 조건을 모두 만족했습니다.\n\n다만 넉넉한 여유 용량이 필요하면 예산을 높여야 합니다.`,
  fallbackTitle: "30만원 이하 공기청정기 선택",
  taskPrompt: "30만원 이하에서 제품을 다시 골라줘",
  allowUncitedStructured: true,
});
assert.ok(toolBackedPlainRecommendation, "a successful tool-backed recommendation must survive even when the provider omits headings and Surface JSON");
assert.equal(toolBackedPlainRecommendation.data.summary.type, "markdown");

const toolBackedOfficeResult = buildOneSurfaceFromMarkdown({
  markdown: `스크립트에 오타(줄바꿈된 콜론)가 있어 수정합니다. 파일이 생성됐습니다. 실제로 열리는 Excel과 Word 파일 두 개를 만들고, 다시 열어서 내용까지 검증했습니다.

Excel 파일과 Word 보고서를 실제로 만들겠습니다. 먼저 Python 라이브러리가 있는지 확인합니다.

두 라이브러리 모두 사용 가능합니다. 파일 생성 스크립트를 작성해 실행합니다.

## 7월 영수증 정리 결과

**합계: 221,700원 (5건)** — 최대 지출은 비품 87,500원입니다.

| 날짜 | 분류 | 사용처 | 금액 | 메모 |
|---|---|---|---:|---|
| 2026-07-02 | 교통 | 카카오T | 18,400원 | 출장 |
| 2026-07-03 | 식비 | 행복식당 | 32,000원 | 팀 점심 |
| 2026-07-05 | 소프트웨어 | Figma | 24,000원 | 구독 |

### 만든 파일

- **7월-영수증-정리.xlsx** — 실제 Excel 파일입니다. openpyxl로 재개방 검증 완료.
- **7월-지출-보고서.docx** — 실제 Word 파일입니다. python-docx로 재개방 검증 완료.`,
  fallbackTitle: "7월 영수증 정리",
  taskPrompt: "실제 Excel과 Word 파일을 만들어줘",
  allowUncitedStructured: true,
});
assert.ok(toolBackedOfficeResult, "a completed local office run must survive without public web citations");
assert.deepEqual(Object.keys(toolBackedOfficeResult.data), ["summary", "comparison", "artifacts"]);
assert.doesNotMatch(
  toolBackedOfficeResult.data.summary.value,
  /Python|openpyxl|python-docx|라이브러리|스크립트|오타|생성됐|다시 열어서/i,
  "developer implementation details must not leak into a beginner-facing office result",
);
assert.deepEqual(
  toolBackedOfficeResult.data.artifacts.items.map((item) => item.path),
  ["7월-영수증-정리.xlsx", "7월-지출-보고서.docx"],
  "claimed local files must remain relative until Main verifies them inside the exact result folder",
);

const bulletComparison = `## 결론: 쿠쿠 Example, 약 33만원

- **쿠쿠 Example** — 115㎡, 약 33만원. 넓은 거실에 맞습니다.
- **차선: 위닉스 Example** — 122㎡, 약 42만원. 효율이 좋습니다.

Sources: [가격](https://example.com/price), [공식](https://example.org/official)`;
const bulletSurface = buildOneSurfaceFromMarkdown({ markdown: bulletComparison, fallbackTitle: "대형 제품 비교" });
assert.ok(bulletSurface, "bold candidate bullets must become a comparison table");
assert.equal(bulletSurface.data.comparison.rows.length, 2);

const colonBullets = `## 결론: 위닉스 Example 추천 — 약 35만원

- **위닉스 Example**: 122㎡, 약 35만원으로 조건에 맞습니다.
- **가성비 대안 — 쿠쿠 Example**: 115㎡, 약 33만원으로 저렴합니다.

Sources: [리뷰](https://example.com/review), [공식](https://example.org/official)`;
assert.ok(
  buildOneSurfaceFromMarkdown({ markdown: colonBullets, fallbackTitle: "콜론 후보 비교" }),
  "bold candidate bullets separated by a colon must become a comparison table",
);

const actualRunShape = `## 결론: 쿠쿠 인스퓨어 울트라 12000 (AC-35U20FWS) 추천

- **커버리지**: 표준사용면적 115.5㎡로 여유 있게 커버합니다.
- **가격**: 다나와 최저 331,700원입니다.
- **스펙**: 360도 필터와 PM1.0 센서를 제공합니다.

### 대안

- **LG 퓨리케어360° Hit AS186HWWA (약 34.8만원, 62㎡)**: 최신성과 저소음이 장점입니다.
- **삼성 블루스카이 5500 (약 28.8만원, 60㎡)**: 가격을 우선할 때 적합합니다.

Sources: [리뷰](https://example.com/review), [가격](https://example.org/price)`;
const actualRunSurface = buildOneSurfaceFromMarkdown({ markdown: actualRunShape, fallbackTitle: "실제 리서치" });
assert.ok(actualRunSurface, "a recommendation with spec bullets and an alternatives section must form a comparison");
assert.deepEqual(
  actualRunSurface.data.comparison.rows.map((row) => row.제품),
  [
    "쿠쿠 인스퓨어 울트라 12000 (AC-35U20FWS)",
    "LG 퓨리케어360° Hit AS186HWWA (약 34.8만원, 62㎡)",
    "삼성 블루스카이 5500 (약 28.8만원, 60㎡)",
  ],
  "spec labels must not be mistaken for product candidates",
);

const boldAlternativeSection = `## 최종 추천: 위닉스 타워 프라임 (APRM833-JWK) — 약 27.8만원

면적과 가격이 가장 잘 맞습니다.

**대안 (모두 50만원 이하)**

- **쿠쿠 W8300 (AC-28W20FWS), 최저 239,000원** — 가장 저렴하지만 전력 사용량이 큽니다.
- **LG 퓨리케어 360 Hit (AS183HWWA), 약 369,140원** — 기능은 좋지만 사용면적이 작습니다.

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const boldAlternativeSurface = buildOneSurfaceFromMarkdown({
  markdown: boldAlternativeSection,
  fallbackTitle: "굵은 대안 구역",
});
assert.ok(boldAlternativeSurface, "a bold alternative heading with a qualifier must retain the explicit recommendation");
assert.deepEqual(
  boldAlternativeSurface.data.comparison.rows.map((row) => row.제품),
  [
    "위닉스 타워 프라임 (APRM833-JWK)",
    "쿠쿠 W8300 (AC-28W20FWS), 최저 239,000원",
    "LG 퓨리케어 360 Hit (AS183HWWA), 약 369,140원",
  ],
  "alternative bullets must never replace the recommendation named in the result heading",
);

const recommendationMissingFromMarkdownTable = `## 추천: 위닉스 타워 프라임 플러스 ATTG115-MGK — 약 390,720원

결론은 위닉스 타워 프라임 플러스입니다.

- **사용면적 116.3㎡(35.1평)** — 25평 거실을 여유 있게 커버합니다.

| 제품 | 사용면적 | 최저가 | 비고 |
|---|---|---|---|
| LG 퓨리케어 360 Hit (AS186HWWA) | 62㎡ (18.7평) | 348,050원 | 작은 거실 대안 |
| 위닉스 타워 프라임 (APRM833-JWK) | 85.8㎡ (26평) | 278,100원 | 예산 대안 |

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const completedRecommendationTable = buildOneSurfaceFromMarkdown({
  markdown: recommendationMissingFromMarkdownTable,
  fallbackTitle: "25평 거실 공기청정기",
});
assert.ok(completedRecommendationTable, "an explicit recommendation must remain visible when the provider table lists only alternatives");
assert.equal(completedRecommendationTable.data.comparison.rows.length, 3);
assert.equal(
  completedRecommendationTable.data.comparison.rows[0].제품,
  "위닉스 타워 프라임 플러스 ATTG115-MGK",
  "the recommended product must be the first comparison row",
);
assert.equal(completedRecommendationTable.data.comparison.rows[0].사용면적, "116.3㎡(35.1평)");
assert.equal(completedRecommendationTable.data.comparison.rows[0].최저가, "약 390,720원");

const recommendationNameAlreadyPresent = `## 최종 추천: 위닉스 타워프라임 플러스 35평형 (ATTG115-MGK)

| 제품 | 표준사용면적 | 확인 가격 |
|---|---|---|
| **위닉스 타워프라임 플러스 35평형** | 116.3㎡ | 약 39.1만~49.9만 |
| 위닉스 타워 프라임 (APRM833-JWK) | 85.8㎡ | 약 27.8만 |

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const deduplicatedRecommendationTable = buildOneSurfaceFromMarkdown({
  markdown: recommendationNameAlreadyPresent,
  fallbackTitle: "제품 비교",
});
assert.ok(deduplicatedRecommendationTable);
assert.equal(
  deduplicatedRecommendationTable.data.comparison.rows.length,
  2,
  "a recommendation row without the model code must not be duplicated when its product name already matches",
);

const conversationalRecommendationHeading = `## 결론: 셋 중에서는 위닉스 타워 XQ를 고르시면 됩니다 — 단, 셋 다 지금 30만원 아래로는 못 삽니다

예산을 낮춰 다시 확인한 결과입니다.

| 제품 | 표준사용면적 | 현재 최저가 | 30만원 대비 |
|---|---|---|---|
| **위닉스 타워 XQ** | 78.6㎡ (23평) | 360,370원 | +6만원 |
| LG 퓨리케어 360 Hit | 62㎡ (18.7평) | 348,050원 | +4.8만원 |
| 위닉스 마스터 S | 99㎡ (30평) | 445,050원 | +14.5만원 |

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const conversationalRecommendationSurface = buildOneSurfaceFromMarkdown({
  markdown: conversationalRecommendationHeading,
  fallbackTitle: "30만원 예산 재검토",
});
assert.ok(conversationalRecommendationSurface);
assert.equal(conversationalRecommendationSurface.title, "위닉스 타워 XQ 추천");
assert.equal(
  conversationalRecommendationSurface.data.comparison.rows.length,
  3,
  "a conversational conclusion must match the real product row instead of fabricating a sentence-shaped row",
);
assert.equal(conversationalRecommendationSurface.data.comparison.rows[0].제품, "**위닉스 타워 XQ**");

const factsMixedIntoProductColumn = `## 추천: 위닉스 타워 프라임 APRM833-JWK

| 제품 | 확인 내용 |
|---|---|
| 표준사용면적 85.8㎡(26평형) | 세 곳 일치 |
| 에너지효율 1등급, 소비전력 47W | 세 곳 일치 |
| LG 퓨리케어 360 Hit AS186HWWA | 작은 거실 대안 |
| 위닉스 마스터 AMSM993-IWK | 넓은 공간 대안 |
| 삼성은 예산 내 대안이 사실상 없음 | 예산 초과 |

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const cleanedProductColumnSurface = buildOneSurfaceFromMarkdown({
  markdown: factsMixedIntoProductColumn,
  fallbackTitle: "공기청정기 추천",
});
assert.ok(cleanedProductColumnSurface);
assert.deepEqual(
  cleanedProductColumnSurface.data.comparison.rows.map((row) => row.제품),
  ["위닉스 타워 프라임 APRM833-JWK", "LG 퓨리케어 360 Hit AS186HWWA", "위닉스 마스터 AMSM993-IWK"],
  "fact labels and no-candidate sentences must not occupy product rows",
);
const inconsistentModelSurface = {
  ...cleanedProductColumnSurface,
  data: {
    comparison: {
      ...cleanedProductColumnSurface.data.comparison,
      rows: cleanedProductColumnSurface.data.comparison.rows.slice(1),
    },
  },
};
assert.equal(
  chooseOneSurfaceForDisplay(inconsistentModelSurface, cleanedProductColumnSurface),
  cleanedProductColumnSurface,
  "a model-authored table that omits its own recommended product must not replace the corrected deterministic table",
);

const internalMemoryHeading = `## Memory Events

## Summary

30만원 예산이면 위닉스 타워 프라임을 고르면 됩니다.

## Comparison

| 제품 | 가격 |
|---|---|
| 위닉스 타워 프라임 APRM833-JWK | 278,100원 |
| LG 퓨리케어 AS186HWWA | 348,050원 |

Sources: [공식](https://example.com/official), [가격](https://example.org/price)`;
const localizedInternalHeadingSurface = buildOneSurfaceFromMarkdown({
  markdown: internalMemoryHeading,
  fallbackTitle: "30만원 이하 추천",
});
assert.ok(localizedInternalHeadingSurface, "a useful Korean result must survive internal provider headings");
assert.equal(localizedInternalHeadingSurface.title, "30만원 이하 추천");
assert.deepEqual(
  localizedInternalHeadingSurface.widgets.map((widget) => widget.title),
  ["핵심 요약", "비교", "확인한 출처"],
  "Korean content must not receive English system section labels",
);

const productFactTable = `## 결론: 위닉스 타워 프라임 APRM833-JWK (최저 278,100원)

스펙과 실제 판매가를 여러 출처로 교차 검증한 뒤 추천을 드리겠습니다. 먼저 웹 검색 도구를 불러오겠습니다. 결과를 정리해 드립니다.

25평 거실에 맞고 에너지효율 1등급인 모델입니다.

| 항목 | 확인 내용 | 출처 일치 여부 |
|---|---|---|
| 표준사용면적 | 85.8㎡ (25.9평) | 세 곳 일치 |
| 에너지효율 | 1등급, 47W | 세 곳 일치 |
| 필터/인증 | H13 헤파, CA 인증 | 두 곳 일치 |

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const productFactSurface = buildOneSurfaceFromMarkdown({ markdown: productFactTable, fallbackTitle: "제품 확인" });
assert.ok(productFactSurface, "a checked fact table for one recommendation must remain a useful table");
assert.deepEqual(
  productFactSurface.widgets.map((widget) => widget.title),
  ["핵심 요약", "확인한 내용", "확인한 출처"],
  "a fact table must not be mislabeled as a product comparison",
);
assert.doesNotMatch(
  productFactSurface.data.summary.value,
  /추천을 드리겠습니다|검색 도구를 불러오겠습니다|결과를 정리해 드립니다/,
  "provider process narration must not appear above the checked facts",
);

const malformedHiddenSurface = parseSurfaces(
  `${actualRunShape}\n\n<<agentlas-surface>>\n{"broken":\n<</agentlas-surface>>`,
);
assert.ok(malformedHiddenSurface.errors.length > 0, "the invalid hidden Surface must be rejected");
assert.ok(
  buildOneSurfaceFromMarkdown({ markdown: malformedHiddenSurface.cleanedText, fallbackTitle: "실제 리서치" }),
  "useful cited Markdown must remain eligible after an invalid hidden Surface is removed",
);

const rankedParagraphResult = `## 핵심 결론

**\"25평 거실\"의 함정부터 짚고 갈게요.** 실제 공간을 먼저 확인해야 합니다.

**1순위 — 위닉스 타워 프라임 플러스 (ATTM115-MWK):** 표준사용면적 35평, 최저가 약 36만원입니다.

**공동 1순위(가성비) — 위닉스 타워 프라임 (APRM833-JWK):** 표준사용면적 26평, 최저가 약 28만원입니다.

**대안 A — 쿠쿠 인스퓨어 (AC-35U20 계열):** 35평, 실구매 32만~50만원입니다.

**대안 B — 삼성 블루스카이 5500 (AP70F06103):** 18평, 최저가 약 37만원입니다.

출처: [추천](https://example.com/recommend), [가격](https://example.org/price)`;
const rankedParagraphSurface = buildOneSurfaceFromMarkdown({
  markdown: rankedParagraphResult,
  fallbackTitle: "공기청정기 조사",
});
assert.ok(rankedParagraphSurface, "ranked recommendation paragraphs must form a comparison");
assert.equal(rankedParagraphSurface.data.comparison.rows.length, 4);
assert.equal(rankedParagraphSurface.data.comparison.rows[0].제품, "위닉스 타워 프라임 플러스 (ATTM115-MWK)");

const rankedProductSectionResult = `## 결론: 위닉스 타워 프라임 플러스 추천

결론부터 정리해 드립니다.

**25평(약 82.6㎡) 거실**에는 1.3배 이상 면적 제품이 적합합니다.

**1위 — 위닉스 타워 프라임 플러스 ATTM115-MWK · 약 36만~43만원**
표준사용면적 115.5㎡로 25평 거실에 여유가 있습니다.

**2위(최저 예산 대안) — 쿠쿠 인스퓨어 울트라 12000 AC-35U20FWS · 약 33만원**
표준사용면적 115.5㎡이고 가격이 더 낮습니다.

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const rankedProductSectionSurface = buildOneSurfaceFromMarkdown({
  markdown: rankedProductSectionResult,
  fallbackTitle: "25평 거실 공기청정기 추천",
});
assert.ok(rankedProductSectionSurface, "ranked product sections must form a comparison");
assert.deepEqual(
  rankedProductSectionSurface.data.comparison.rows.map((row) => row.제품),
  [
    "위닉스 타워 프라임 플러스 ATTM115-MWK · 약 36만~43만원",
    "쿠쿠 인스퓨어 울트라 12000 AC-35U20FWS · 약 33만원",
  ],
  "room-size context must not be mistaken for a product row when ranked products are present",
);
assert.doesNotMatch(
  rankedProductSectionSurface.data.summary.value,
  /결론부터 정리해 드립니다/,
  "generic conclusion prefaces must not occupy the first result line",
);

const actualBudgetFollowUp = `이전 조사 결과를 확인한 뒤, 30만원 기준으로 다시 판단해 드리겠습니다. 먼저 조사 기록을 불러올게요. 작업 폴더에는 기록이 없네요. 세션 메모리 디렉토리를 확인해 보겠습니다. 이전 조사 결과 스냅샷을 찾았습니다. 내용을 읽어볼게요. 이전 조사 기록을 복원했습니다.

## 결론: 30만원이면 **위닉스 타워프라임 (APRM833-JWK, 약 278,100원)** 입니다

셋 중 30만원 안에 들어오는 제품이 이것뿐이기 때문입니다.

- **위닉스 타워프라임** — 약 278,100원 · 예산 내
- 쿠쿠 인스퓨어 울트라 12000 — 약 331,700원 · 약 3.2만원 초과
- 위닉스 타워프라임 플러스 — 약 362,850원 · 약 6.3만원 초과

### 이전 추천과 달라진 이유

50만원 예산에서는 사용면적에 여유가 있는 타워프라임 플러스를 골랐습니다. 예산이 30만원으로 내려가면 두 제품이 예산을 벗어나므로 타워프라임으로 바뀝니다.

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const actualBudgetSurface = buildOneSurfaceFromMarkdown({
  markdown: actualBudgetFollowUp,
  fallbackTitle: "30만원 이하 공기청정기 추천",
});
assert.ok(actualBudgetSurface, "a real budget follow-up must remain a useful structured result");
assert.deepEqual(
  actualBudgetSurface.data.comparison.rows.map((row) => row.제품),
  ["위닉스 타워프라임", "쿠쿠 인스퓨어 울트라 12000", "위닉스 타워프라임 플러스"],
  "plain and bold product bullets must form the visible comparison together",
);
assert.doesNotMatch(
  actualBudgetSurface.data.summary.value,
  /작업 폴더|세션 메모리|메모리 디렉토리|스냅샷|조사 기록을 불러|복원했습니다|내용을 읽어볼게요/,
  "provider process narration must not appear in a beginner-facing result",
);

const proseOnlyPriceComparison = `이전 조사 결과를 확인해서 30만원 예산 기준으로 다시 비교해 드릴게요. 렌탈 매물만 잡혔네요. 일시불 구매가만 걸러서 다시 조회합니다. 가격 확인이 끝났습니다. 메모리에 정정 기록을 남기고 최종 정리하겠습니다. 다나와 가격 조회 스킬을 사용할게요. 세 후보 상품의 현재 최저가를 동시에 조회합니다. 세 제품의 청정면적 스펙도 확인해 판단 근거를 갖추겠습니다. 결과를 정리해 드릴게요.

**결론: 30만원 예산이면 셋 중 예산 안에 들어오는 제품은 없습니다.** 현재 최저가가 LG 348,050원, 쿠쿠 349,080원, 삼성 376,910원이라 셋 다 30만원을 넘습니다. 그래도 셋 중에서 골라야 한다면 **LG 퓨리케어360˚ Hit AS186HWWA**를 추천합니다.

이전 추천과 달라진 이유는 예산 안에 들어오는지가 가장 중요한 기준으로 바뀌었기 때문입니다.

출처: [공식](https://example.com/official), [가격](https://example.org/price)`;
const proseOnlyPriceSurface = buildOneSurfaceFromMarkdown({
  markdown: proseOnlyPriceComparison,
  fallbackTitle: "예산을 30만원으로 낮추면 셋 중 어떤 걸 고르면 돼",
});
assert.ok(proseOnlyPriceSurface, "a prose-only three-product price comparison must still become a useful result");
assert.deepEqual(
  proseOnlyPriceSurface.data.comparison.rows,
  [
    { 선택: "추천", 제품: "LG", 가격: "348,050원", evidenceIds: ["source_1", "source_2"] },
    { 선택: "대안 1", 제품: "쿠쿠", 가격: "349,080원", evidenceIds: ["source_1", "source_2"] },
    { 선택: "대안 2", 제품: "삼성", 가격: "376,910원", evidenceIds: ["source_1", "source_2"] },
  ],
  "prices stated in one sentence must become a three-row comparison with the recommended candidate first",
);
assert.doesNotMatch(
  proseOnlyPriceSurface.data.summary.value,
  /이전 조사 결과|렌탈 매물|메모리에 정정 기록|조회 스킬|조회합니다|갖추겠습니다|정리해 드릴게요/,
  "tool and research narration must not appear above a prose-derived comparison",
);
const sourceOnlyModelSurface = {
  ...actualBudgetSurface,
  data: {},
  widgets: [{ type: "source-matrix", title: "확인한 출처" }],
};
assert.equal(
  chooseOneSurfaceForDisplay(sourceOnlyModelSurface, actualBudgetSurface),
  actualBudgetSurface,
  "a valid but source-only model Surface must not hide a richer deterministic result",
);
const meaningfulModelSurface = {
  ...actualBudgetSurface,
  data: {
    ...actualBudgetSurface.data,
    summary: { type: "markdown", value: "A complete model-authored explanation that is long enough to be useful." },
  },
};
assert.equal(
  chooseOneSurfaceForDisplay(meaningfulModelSurface, actualBudgetSurface),
  meaningfulModelSurface,
  "a model Surface that preserves the same useful content kinds must remain authoritative",
);
const processNarratedModelSurface = {
  ...actualBudgetSurface,
  data: {
    ...actualBudgetSurface.data,
    summary: {
      type: "markdown",
      value: "이제 후보 모델을 찾기 위해 웹 검색을 병렬로 실행하겠습니다. 네이버쇼핑에서 4개 모델 가격을 병렬 조회합니다.\n\n가격 필드가 다른 이름인 것 같습니다. 정리해 드립니다.\n\n30만원 예산에서는 위닉스 타워프라임이 조건에 가장 잘 맞습니다.",
    },
  },
};
const sanitizedModelSurface = chooseOneSurfaceForDisplay(processNarratedModelSurface, actualBudgetSurface);
assert.ok(sanitizedModelSurface, "a useful model Surface must survive process-narration cleanup");
assert.equal(
  sanitizedModelSurface.data.summary.value,
  "30만원 예산에서는 위닉스 타워프라임이 조건에 가장 잘 맞습니다.",
  "a schema-valid model Surface must not persist future tool plans in its user-facing narrative",
);
const tableOnlyModelSurface = {
  ...actualBudgetSurface,
  data: { comparison: actualBudgetSurface.data.comparison },
  widgets: [{ type: "table", data: "comparison", title: "비교" }],
};
assert.equal(
  chooseOneSurfaceForDisplay(tableOnlyModelSurface, actualBudgetSurface),
  actualBudgetSurface,
  "a model table must not erase the explanation preserved by the deterministic Surface",
);
const actualFileSurface = {
  ...tableOnlyModelSurface,
  data: {
    ...tableOnlyModelSurface.data,
    artifacts: {
      type: "artifacts",
      items: [{ name: "7월-영수증-정리.xlsx", path: "7월-영수증-정리.xlsx", format: "xlsx", trust: "unverified" }],
    },
  },
};
assert.equal(
  chooseOneSurfaceForDisplay(actualFileSurface, actualBudgetSurface),
  actualFileSurface,
  "deterministic prose must never erase a real file result that Markdown cannot reconstruct",
);

const evidenceLabelBullets = `## 결론: 위닉스 타워 프라임 플러스 — 약 36만원

조건에 가장 잘 맞습니다.

- **스펙(사용면적·등급)**: 공식몰과 가격 DB가 일치합니다.
- **적정 용량 기준(130~150%)**: 세 구매 가이드가 일치합니다.
- **평판**: 추천 목록에서 교집합을 확인했습니다.

더 작은 실제 거실이라면 **위닉스 타워 프라임 APRM833-JWK(85.8㎡, 278,100원)**가 대안입니다.

Sources: [공식](https://example.com/official), [가격](https://example.org/price)`;
const evidenceLabelSurface = buildOneSurfaceFromMarkdown({ markdown: evidenceLabelBullets, fallbackTitle: "제품 추천" });
assert.ok(evidenceLabelSurface, "evidence labels plus an inline alternative must still form a comparison");
assert.deepEqual(
  evidenceLabelSurface.data.comparison.rows.map((row) => row.제품),
  ["위닉스 타워 프라임 플러스", "위닉스 타워 프라임 APRM833-JWK(85.8㎡, 278,100원)"],
  "evidence labels must never be promoted as product candidates",
);

assert.equal(
  buildOneSurfaceFromMarkdown({ markdown: "긴 평문만 있는 답변", fallbackTitle: "평문" }),
  null,
  "plain prose must not be fabricated into a structured comparison",
);
assert.equal(
  buildOneSurfaceFromMarkdown({
    markdown: "도구를 사용했지만 구조가 없는 긴 평문만 있는 답변입니다.",
    fallbackTitle: "평문",
    allowUncitedStructured: true,
  }),
  null,
  "a tool receipt alone must not fabricate a visual result from unstructured prose",
);

const localOperationalMarkdown = `## 결론: 오늘의 한 가지

Agentlas One 구현을 검증 가능한 상태로 매듭짓는 것을 추천합니다.

## 실제 저장소를 확인한 근거

현재 작업 트리와 준비된 검증 스크립트를 직접 확인했습니다.

## 제안 실행 순서

1. 결제 보안 수정의 배포 상태를 확인합니다.
2. One 실제 앱 QA를 실행하고 실패 항목을 수정합니다.
3. 검증된 변경을 논리 단위로 정리합니다.`;
const localOperationalSurface = buildOneSurfaceFromMarkdown({
  markdown: localOperationalMarkdown,
  fallbackTitle: "오늘의 우선순위",
  allowUncitedStructured: true,
});
assert.ok(localOperationalSurface, "a structured local tool result must become an unverified operational Surface");
assert.equal(localOperationalSurface.layout, "workflow");
assert.equal(localOperationalSurface.evidence, undefined, "an uncited local result must never invent public evidence");
assert.equal(localOperationalSurface.data.checklist.items.length, 3);

const citedNarrative = buildOneSurfaceFromMarkdown({
  markdown: "## 조사 결과\n\n확인한 사실과 판단 근거를 정리했습니다.\n\nSources: [공식](https://example.com/official), [검토](https://example.org/review)",
  fallbackTitle: "조사 결과",
});
assert.ok(citedNarrative, "a cited result must still persist as a native report when no comparison template matches");
assert.equal(citedNarrative.data.comparison, undefined);
assert.ok(citedNarrative.widgets.some((widget) => widget.type === "source-matrix"));

const inlineAlternatives = `## 결론: LG Example 추천

**최저가 약 34만원, 사용면적 62㎡**로 가장 균형 잡혔습니다.

거실이 더 넓다면 **위닉스 Example(약 36만원, 122㎡)**가 대안입니다.
예산을 아끼려면 **쿠쿠 Example(약 15만원, 53.8㎡)**도 있습니다.`;
const observedSourceSurface = buildOneSurfaceFromMarkdown({
  markdown: inlineAlternatives,
  fallbackTitle: "도구 근거 비교",
  observedSourceUrls: ["https://example.com/review", "https://example.org/price"],
});
assert.ok(observedSourceSurface, "verified tool URLs plus inline product alternatives must form a comparison");
assert.equal(observedSourceSurface.data.comparison.rows.length, 3);
assert.equal(
  buildOneSurfaceFromMarkdown({
    markdown: "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n[한 곳](https://example.com)",
    fallbackTitle: "출처 부족",
  }),
  null,
  "a table without at least two HTTPS citations must fail closed",
);

const beginnerFacingResult = buildOneSurfaceFromMarkdown({
  markdown: `## 전제

요청하신 조건에 맞는 제품을 조사하겠습니다. 먼저 후보 모델을 웹에서 확인하고 가격을 교차 검증할게요. 관련도순으로 본품 가격을 다시 조회하겠습니다. 조사와 교차 검증이 끝났습니다. 결론부터 정리드립니다.

## 최종 후보 비교 (모두 50만원 이하)

위닉스 타워 프라임 플러스가 25평 거실에 가장 여유 있는 선택입니다.

| 제품 | 가격 | 사용면적 |
|---|---|---|
| 위닉스 타워 프라임 플러스 | 362,850원 | 115㎡ |
| 쿠쿠 인스퓨어 울트라 | 349,080원 | 115.5㎡ |

출처: [위닉스 공식 1](https://example.com/products/one), [위닉스 공식 2](https://example.com/products/two)`,
  fallbackTitle: "25평 거실 공기청정기 추천",
  observedSourceUrls: [
    "https://example.com/search-result",
    "https://shop.example.org/item-a",
    "https://www.example.org/item-b",
    "https://source-1.example.net/a",
    "https://source-2.example.net/a",
    "https://source-3.example.net/a",
    "https://source-4.example.net/a",
    "https://source-5.example.net/a",
    "https://source-6.example.net/a",
    "https://source-7.example.net/a",
    "https://source-8.example.net/a",
    "https://source-9.example.net/a",
    "https://source-10.example.net/a",
    "https://source-11.example.net/a",
    "https://source-12.example.net/a",
  ],
});
assert.ok(beginnerFacingResult, "a real recommendation shape must become a result surface");
assert.equal(
  beginnerFacingResult.title,
  "최종 후보 비교 (모두 50만원 이하)",
  "a generic assumptions heading must never become the visible result title",
);
assert.doesNotMatch(
  beginnerFacingResult.data.summary.value,
  /조사하겠습니다|웹에서 확인하고|검증할게요|조회하겠습니다|검증이 끝났습니다|결론부터 정리드립니다/,
  "the visible result summary must remove future-tense process narration",
);
assert.match(
  beginnerFacingResult.data.summary.value,
  /위닉스 타워 프라임 플러스가 25평 거실에 가장 여유 있는 선택/,
  "the visible result summary must start from the useful finding",
);
assert.ok(beginnerFacingResult.evidence.length <= 12, "a result must show no more than twelve useful sources");
assert.equal(
  beginnerFacingResult.evidence.filter((item) => new URL(item.url).hostname.replace(/^www\./, "") === "example.org").length,
  1,
  "observed tool URLs from the same host must collapse into one source",
);
assert.equal(
  beginnerFacingResult.evidence.filter((item) => new URL(item.url).hostname === "example.com").length,
  2,
  "explicitly named citations may keep distinct product pages from the same host",
);

process.stdout.write(`${JSON.stringify({ ok: true, blocks: one.blocks.map((block) => block.type), evidence: one.evidence.length })}\n`);
