// Oberon — 시트 빌더 (마스터 시트 · 콘티 시트 · 컷 분해 시트).
//
// 연속성 우선(continuity-first) 영상 제작 워크플로우의 이미지 산출물 4종을
// 프롬프트로 만든다. 렌더러(기획 단계)와 Electron main(생성 잡) 양쪽에서 쓴다.
//
//   1) master_sheet_v2 — 클린 일관성 시트: 정면·3/4·측면·전신·표정만, 패널 ≤6,
//      이미지 안 텍스트는 패널 헤더뿐. 얼굴/형태 일관성 락 + I2V(Element) 주입용.
//   2) master_sheet_v1 — 풀 디테일 바이블: 의상 멀티세트·컬러 팔레트·브랜드 컨셉까지
//      세로 매거진 한 장에. 세계관·오브제·컬러 락용 (텍스트 많음 = 의도).
//   3) storyboard_overview — 광고/영상 한 편 전체를 한 장 N컷 그리드 콘티로.
//      컷당 ACTION/CAMERA/DIALOGUE 3줄, 마지막 컷 = 제품+슬로건 키비주얼.
//   4) cut_breakdown — 한 컷을 S1~S6 샷으로 분해, 샷마다 START/END 프레임 명세.
//      START→END가 그대로 키프레임 체이닝(first/last frame) 소스가 된다.
//
// 원칙 (원본 워크플로우의 안티-페일 체크리스트):
//   - 시트 안 텍스트는 한국어 라벨 + 영어 병기, 일본어 금지, 워터마크·실브랜드 금지.
//   - 얼굴·헤어·메인 의상·비율은 전 패널 동일 (일관성이 시트의 존재 이유).
//   - V2는 절제(헤더만), V1은 풍부(라벨·HEX 허용) — 역할이 다르다.

export type OberonSheetKind =
  | "master_sheet_v1"
  | "master_sheet_v2"
  | "storyboard_overview"
  | "cut_breakdown"
  // 커버리지 워크플로우 — shared/oberon-cinematic.ts 빌더가 프롬프트를 만든다.
  | "scene_grid_3x3"
  | "scene_stack_4"
  | "storyboard_sequence";

export type OberonSheetMode = "character" | "product";

// ── 연속성 네거티브 캐논 (영상 렌더 공통) ─────────────────────
// 카테고리: 콘텐츠 오염 / 얼굴·신체 결함 / 시간·조명 드리프트 / 의상 플리커 / AI 결함.
// 렌더 시 shot.negativePrompt에 병합해 "세계가 드리프트하는" 실패 모드를 막는다.

export const CONTINUITY_NEGATIVE_VIDEO = [
  // 콘텐츠
  "subtitles",
  "watermark",
  "logo",
  "real brand",
  "real-person face",
  // 얼굴·신체
  "multiple faces",
  "face morph",
  "extra limbs",
  "deformed hands",
  "extra fingers",
  "melting features",
  // 시간·조명 드리프트
  "sudden day-to-night jump",
  "inconsistent shadow direction",
  "shadow direction flip",
  "flickering lighting",
  // 의상 플리커
  "wardrobe color change mid-shot",
  "fabric texture shift",
  "accessory appearing or disappearing",
  // AI 결함
  "plastic skin",
  "uncanny smoothness",
  "over-saturated colors",
  "waxy complexion",
  "blurred hands",
];

/** 기존 네거티브에 연속성 캐논을 중복 없이 병합한다 (전체 길이 상한 보호). */
export function mergeContinuityNegative(base?: string, maxLen = 1400): string {
  const seen = new Set(
    (base || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const merged = [...(base ? [base.trim().replace(/,\s*$/, "")] : [])];
  for (const item of CONTINUITY_NEGATIVE_VIDEO) {
    if (!seen.has(item.toLowerCase())) merged.push(item);
  }
  return merged.join(", ").slice(0, maxLen);
}

// ── 시트 공통 스타일 규칙 ─────────────────────────────────────

const SHEET_COMMON_RULES = [
  "Korean labels with English in parentheses",
  "NO Japanese text",
  "NO watermark",
  "NO real existing brand or logo",
];

// ── 1) 마스터 시트 V2 — 클린 일관성 시트 ─────────────────────

export interface OberonMasterSheetSpec {
  mode: OberonSheetMode;
  /** 캐릭터 이름/역할 또는 제품명(워드마크). */
  name: string;
  /** 외모 서술(성별·나이대·헤어·눈·피부·체형) 또는 제품 형태/내용물. */
  description: string;
  /** LOCKED 메인 의상(색/소재 고정) 또는 라벨 스펙. */
  wardrobe?: string;
  /** 톤/바이브 (예: 한국 인디 거리 스냅, 자연광). */
  vibe?: string;
  /** 표정 컷 라벨 (기본: 기본/미소/놀람). */
  expressions?: string[];
}

export function buildMasterSheetV2Prompt(spec: OberonMasterSheetSpec): string {
  if (spec.mode === "product") {
    return [
      "You are a commercial product photographer and packaging art director. Generate ONE photoreal PRODUCT MASTER SHEET, clean studio layout on a cream/neutral background, landscape orientation.",
      `[PRODUCT] Name/wordmark: ${spec.name} (the ONLY text allowed on the label). Form: ${spec.description}.${spec.wardrobe ? ` Label: ${spec.wardrobe}.` : ""}${spec.vibe ? ` Tone: ${spec.vibe}.` : ""}`,
      "[PANELS — 5 or fewer, header text only] 1. 히어로(HERO) — large front product, soft warm key light, shallow DoF. 2. 360 row: 정면(FRONT) / 측면(SIDE) / 후면(BACK) — identical product. 3. 디테일(DETAIL) — 2 macro insets.",
      "[STYLE RULES] Photoreal commercial product photography, premium clean look. Consistent product shape, label and color in EVERY panel. ONLY panel header labels plus the product wordmark printed — NO hex codes, NO dieline, NO long callouts, NO clutter.",
      SHEET_COMMON_RULES.join(", ") + ".",
    ].join("\n");
  }
  const expressions = (spec.expressions?.length ? spec.expressions : ["기본", "미소", "놀람"]).slice(0, 3).join("/");
  return [
    "You are a professional photographer and character art director. Generate ONE photoreal CHARACTER MASTER SHEET, clean editorial multi-panel layout on a soft neutral background, landscape orientation.",
    `[SUBJECT] ${spec.name}: ${spec.description}, identical across every panel.${spec.wardrobe ? ` Main outfit (LOCKED): ${spec.wardrobe}.` : ""}${spec.vibe ? ` Vibe: ${spec.vibe}.` : ""}`,
    `[PANELS — 6 or fewer, header text only] 1. 정면(FRONT) — large left portrait, calm slight smile. 2. 3/4 — 45° three-quarter view. 3. 측면(SIDE) — clean side profile. 4. 전신(FULL BODY) — full-length in the locked main outfit, head to shoe. 5. 표정(EXPRESSION) — row of head close-ups: ${expressions}.`,
    "[STYLE RULES] Photoreal portrait photography, natural soft light, consistent face/hair/outfit/lighting in EVERY panel. Editorial grid with generous neutral negative space. ONLY panel header labels printed — NO other in-image text, NO hex codes, NO long captions, NO leader-line callouts. NO illustration, NO 3D render, NO over-saturation.",
    SHEET_COMMON_RULES.join(", ") + ".",
  ].join("\n");
}

// ── 2) 마스터 시트 V1 — 풀 디테일 에디토리얼 바이블 ──────────

export interface OberonMasterBibleSpec extends OberonMasterSheetSpec {
  /** 브랜드/작품 워드마크 (히어로 상단 대형 세리프). */
  brand?: string;
  /** 컬러 스와치 (이름+HEX, 6개 이하). */
  palette?: Array<{ name: string; hex: string }>;
  /** 브랜드/세계관 컨셉 2~3줄. */
  concept?: string;
}

export function buildMasterSheetV1Prompt(spec: OberonMasterBibleSpec): string {
  const swatches = (spec.palette ?? [])
    .slice(0, 6)
    .map((s) => `${s.name} ${s.hex}`)
    .join(", ");
  return [
    "You are an editorial photographer, art director, and character designer. Generate ONE rich CHARACTER MASTER BIBLE — a magazine-style multi-section reference sheet on a clean cream/ivory background, portrait orientation. Photoreal editorial.",
    `[HERO] Large left portrait of ${spec.name}. Big serif wordmark "${spec.brand || spec.name}".`,
    `[IDENTITY 캐릭터] ${spec.description}${spec.vibe ? ` — ${spec.vibe}` : ""}`,
    "[FACE REFERENCE 얼굴 특징] 4 reference photos: 정면(Front) · 3/4(Three-quarter) · 측면(Profile) · 미소(Soft smile) — same identity.",
    `[EXPRESSIONS 표정] Row of 6 face close-ups — identical face and hairstyle.`,
    `[WARDROBE 의상] ${spec.wardrobe ? `Main locked outfit: ${spec.wardrobe}, plus 3 outfit variations` : "4 outfit set (main/set/casual/seasonal)"}, each with a short Korean item list.`,
    swatches ? `[COLOR & TONE 컬러] 6 swatches with names and HEX: ${swatches}.` : "[COLOR & TONE 컬러] 6 color swatches with Korean names and HEX codes.",
    spec.concept ? `[BRAND CONCEPT 컨셉] "${spec.concept}"` : "",
    "[STYLE RULES] Photoreal editorial portrait photography, natural soft light, SAME face/hair/main-outfit/proportions across every section. Clean grid-based magazine layout, large hero left, info panels right. This is a DETAIL-RICH bible: section labels, specs, HEX swatches and short descriptions ARE intended — keep each text block short and aligned to avoid glyph errors.",
    SHEET_COMMON_RULES.join(", ") + ".",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── 3) 스토리보드 오버뷰 (V1) — 한 편 전체 한 장 콘티 ────────

export interface OberonStoryboardCell {
  index: number;
  /** ACTION: 한국어 동작/연출 한 줄. */
  action: string;
  /** CAMERA: 영어 카메라 용어 (wide low-angle / tight close-up / OTS …). */
  camera: string;
  /** DIALOGUE: 한국어 대사 (없으면 생략). */
  dialogue?: string;
}

export interface OberonStoryboardSpec {
  title: string;
  /** 브랜드/제품명 (광고면 마지막 컷 키비주얼에 쓰임). */
  brand?: string;
  runtimeSec: number;
  cells: OberonStoryboardCell[];
  /** 전 컷 동일 유지할 캐릭터 서술 (마스터 시트 기준). */
  lockedCharacter?: string;
  /** 전 컷 동일 유지할 제품 서술. */
  lockedProduct?: string;
  /** 배경/세계 톤. */
  world?: string;
  artStyle?: string;
  /** 마지막 컷 키비주얼 슬로건. */
  slogan?: string;
}

/** 러닝타임 → 권장 컷 수 (6~8s=6컷 · 10~12s=9컷 · 15s=12컷 · 20~30s=16컷). */
export function recommendedCutCount(runtimeSec: number): number {
  if (runtimeSec <= 8) return 6;
  if (runtimeSec <= 12) return 9;
  if (runtimeSec <= 16) return 12;
  return 16;
}

function gridFor(count: number): string {
  if (count <= 6) return "2x3";
  if (count <= 9) return "3x3";
  if (count <= 12) return "3x4";
  return "4x4";
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯"];

export function buildStoryboardOverviewPrompt(spec: OberonStoryboardSpec): string {
  const cells = spec.cells.slice(0, 16);
  const cellLines = cells.map((c, i) => {
    const num = CIRCLED[i] ?? `(${i + 1})`;
    const dlg = c.dialogue ? `DIALOGUE: 「${c.dialogue}」` : "DIALOGUE: (없음)";
    return `${num} ACTION: ${c.action} / CAMERA: ${c.camera} / ${dlg}`;
  });
  const locked = [
    spec.lockedCharacter ? `Character(s): ${spec.lockedCharacter}` : "",
    spec.lockedProduct ? `Product: ${spec.lockedProduct}` : "",
    spec.world ? `World/location: ${spec.world}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    "You are a commercial director and storyboard artist. Generate ONE single horizontal AD STORYBOARD SHEET (콘티) that lays out an entire spot at a glance, on a light cream/ivory editorial background with thin grey cell borders.",
    `[SPOT] Title bar (top, one line): ${spec.brand ? `${spec.brand} ` : ""}「${spec.title}」 콘티 — ${spec.runtimeSec}초 / ${cells.length}컷. Art style: ${spec.artStyle || "photoreal cinematic, warm natural light"}, consistent grade across every cell. Grid ${gridFor(cells.length)}, circled numbers ①②③… in the top-left of each cell.`,
    locked ? `[LOCKED DESIGN — identical in every cell] ${locked}` : "",
    "[CELLS — each cell = thumbnail on top + 3 metadata lines below]",
    ...cellLines,
    spec.slogan
      ? `Final cell = product + slogan key visual: product hero shot with slogan overlay "${spec.slogan}".`
      : "Final cell = the story's key visual with the closing beat.",
    "[STYLE RULES] One flat planning sheet, light cream background, thin grey gridlines, circled cut numbers. Each cell thumbnail is a different shot/angle, but the SAME character/product/world design throughout. Printed text = title bar + per-cell ACTION/CAMERA/DIALOGUE labels only — Korean action and dialogue, English camera terms. NO hex codes. Audio policy: NO BGM (dialogue + ambient SFX only).",
    SHEET_COMMON_RULES.join(", ") + ".",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── 4) 컷 분해 시트 (V2) — 한 컷 → S1~S6 START/END ──────────

export interface OberonBreakdownShot {
  id: string;
  /** 컷 내 상대시간 (예: "00:00-00:02"). */
  relTime: string;
  /** 시작 프레임 구체 묘사. */
  startFrame: string;
  /** 끝 프레임 구체 묘사. */
  endFrame: string;
  /** 그 샷만의 고유 앵글/무브 (직전 샷과 중복 금지). */
  camera: string;
  /** 연출·동작 (한국어 간결). */
  action: string;
  dialogue?: string;
  sfx?: string;
}

export interface OberonCutBreakdownSpec {
  cutId: string;
  /** 전체 영상 내 절대시간 (예: "0:26-0:39"). */
  absoluteTime?: string;
  titleKo: string;
  titleEn?: string;
  artStyle?: string;
  /** 전 샷 동일 유지 요소 (마스터 시트 기준). */
  lockedDesign?: string;
  shots: OberonBreakdownShot[];
  directorsIntent?: string;
  /** 다음 컷으로의 매치컷/전환 설계. */
  transition?: string;
}

export function buildCutBreakdownPrompt(spec: OberonCutBreakdownSpec): string {
  const shots = spec.shots.slice(0, 8);
  const rows = shots.map((s) => {
    const dlg = s.dialogue ? `「${s.dialogue}」` : "—";
    return `${s.id} ${s.relTime} | START: ${s.startFrame} | END: ${s.endFrame} | ${s.camera} | ${s.action} | ${dlg} | ${s.sfx || "—"}`;
  });
  return [
    "You are a film director and storyboard artist. Generate ONE single horizontal SHOT-BREAKDOWN SHEET for a SINGLE CUT, on a dark navy-black background (#0A0A12) with crisp white text and thin white dividers.",
    `[HEADER one line] ${spec.cutId}${spec.absoluteTime ? ` (${spec.absoluteTime})` : ""} 「${spec.titleKo}${spec.titleEn ? ` / ${spec.titleEn}` : ""}」 ${spec.artStyle || "photoreal cinematic"} · NO BGM`,
    spec.lockedDesign ? `[LOCKED DESIGN — identical in every shot] ${spec.lockedDesign}` : "",
    "[TABLE — 7 columns] SHOT/TIME | START FRAME | END FRAME | CAMERA/MOVEMENT | ACTION/DIRECTION | 나레이션·대사 | SFX",
    ...rows,
    "[FOOTER — 2 boxes]",
    spec.directorsIntent ? `DIRECTOR'S INTENT: ${spec.directorsIntent}. NO BGM — dialogue + in-clip SFX only.` : "DIRECTOR'S INTENT: NO BGM — dialogue + in-clip SFX only.",
    spec.transition ? `TRANSITION: ${spec.transition} (+ 2 small transition thumbnails)` : "",
    "[STYLE RULES] One flat sheet, dark navy #0A0A12, white text, thin white grid. Each shot uses a DIFFERENT angle/move — no repeats. Same character/world design in every thumbnail (master-sheet consistency). Each shot row shows its START and END frame as two thumbnails. Per-shot times are RELATIVE to the cut. English + Korean only.",
    SHEET_COMMON_RULES.join(", ") + ".",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── 시트 종류별 비율/자산 종류 매핑 ───────────────────────────

/** 키프레임 엔진의 normalizeAspect 입력 기준 — V1 바이블만 세로("4:5"→3:4), 나머지는 가로. */
export function sheetAspect(kind: OberonSheetKind): string {
  return kind === "master_sheet_v1" ? "4:5" : "16:9";
}

export function sheetAssetKind(kind: OberonSheetKind): "master_sheet" | "storyboard_sheet" {
  // 시네마틱 가이드 커버리지 시트(그리드/스택/스토리보드 시퀀스)는 콘티 계열 —
  // keyframes.buildImagePrompt가 완성 프롬프트를 가공 없이 통과시키는 경로를 탄다.
  return kind === "storyboard_overview" ||
    kind === "cut_breakdown" ||
    kind === "scene_grid_3x3" ||
    kind === "scene_stack_4" ||
    kind === "storyboard_sequence"
    ? "storyboard_sheet"
    : "master_sheet";
}
