// Oberon — 제작 에이전트 팀 (research §4).
//
// 파이프라인의 각 단계가 곧 하나의 에이전트다. 사람은 방향과 승인만 하고,
// 에이전트가 샷을 나누고·생성하고·검사하고·재시도한다.
// systemPrompt는 실제 LLM 런타임(claude-code/codex/gemini/byok)으로
// 라우팅할 때 그대로 주입되는 계약이다.

import type { Locale } from "@/lib/i18n";
import type { FilmAgentDef, PipelineStageKey, QualityGate, StageStatus } from "./types";

// ── i18n 접근자 ──────────────────────────────────────────
// 소비자가 entry.role / entry.summary 등을 직접 읽는 기존 패턴이라 원본
// 필드는 그대로 두고(source of truth), 표시용 문자열만 이 헬퍼로 고른다.

/** ko/en 문자열 쌍에서 로케일에 맞는 값을 고른다. en이 없으면 ko로 폴백. */
export function agentText(ko: string, en: string | undefined, locale: Locale): string {
  return locale === "en" && en ? en : ko;
}

/** ko/en 문자열 배열 쌍에서 로케일에 맞는 값을 고른다. en이 없거나 비면 ko로 폴백. */
export function agentList(ko: string[], en: string[] | undefined, locale: Locale): string[] {
  return locale === "en" && en && en.length ? en : ko;
}

/** FilmAgentDef + 영문 대응 필드 (role/inputs/outputs/failGate). systemPrompt는 항상 영문이라 대상 아님. */
export interface FilmAgentDefI18n extends FilmAgentDef {
  roleEn: string;
  inputsEn: string[];
  outputsEn: string[];
  failGateEn: string;
}

export const FILM_AGENTS: FilmAgentDefI18n[] = [
  {
    id: "00-showrunner",
    code: "00",
    name: "쇼러너 오케스트레이터",
    nameEn: "Showrunner Orchestrator",
    role: "전체 제작 진행과 상태 관리, 단계 게이트 판정, 작업 분배",
    roleEn: "Owns overall production progress and state, judges stage gates, and distributes work",
    inputs: ["프로젝트 brief", "예산", "목표 길이"],
    inputsEn: ["Project brief", "Budget", "Target length"],
    outputs: ["phase plan", "승인 요청", "작업 분배"],
    outputsEn: ["Phase plan", "Approval requests", "Work distribution"],
    failGate: "다음 단계 진입 조건 미충족",
    failGateEn: "Entry conditions for the next stage are not met",
    accent: "var(--accent)",
    stage: "brief",
    systemPrompt:
      "You are the Showrunner of an AI film production. Own the whole pipeline state. Given a brief, budget, and target length, produce a phase plan, decide which quality gates are met, and route work to the right specialist agent. Never let an expensive generation start before Brief/Script/Shot/Continuity/Keyframe/Cost/Safety gates pass. Ask the human only for direction and approval, never for prompts.",
  },
  {
    id: "10-creative-brief",
    code: "10",
    name: "크리에이티브 브리프 전략가",
    nameEn: "Creative Brief Strategist",
    role: "장르·톤·레퍼런스·금지사항을 정리해 비주얼 방향을 확정",
    roleEn: "Defines genre, tone, references, and constraints to lock the visual direction",
    inputs: ["사용자 입력", "브랜드 자료"],
    inputsEn: ["User input", "Brand materials"],
    outputs: ["creative brief", "visual direction"],
    outputsEn: ["Creative brief", "Visual direction"],
    failGate: "모호한 타깃 / 권리 문제",
    failGateEn: "Ambiguous target audience / rights issue",
    accent: "var(--peach-ink)",
    stage: "brief",
    systemPrompt:
      "You are a Creative Brief Strategist. Turn a rough idea into a sharp creative brief: target audience, genre, tone words, visual references, brand constraints, and an explicit do-not list. Output a single-sentence visual direction that will be injected into every downstream prompt as the film's DNA.",
  },
  {
    id: "20-script-beat",
    code: "20",
    name: "스크립트 & 비트 작가",
    nameEn: "Script & Beat Writer",
    role: "씬/비트/대사/감정선을 목표 길이에 맞춰 작성",
    roleEn: "Writes scenes, beats, dialogue, and emotional arcs to fit the target length",
    inputs: ["brief", "길이", "장르"],
    inputsEn: ["Brief", "Length", "Genre"],
    outputs: ["scene list", "beat sheet", "dialogue"],
    outputsEn: ["Scene list", "Beat sheet", "Dialogue"],
    failGate: "길이 초과 / 전환 불명확",
    failGateEn: "Runtime overshoot / unclear transitions",
    accent: "var(--purple-deep)",
    stage: "script",
    systemPrompt:
      "You are a screenwriter. Break the runtime into sequences → scenes → beats using the genre's beat template. Each scene gets a slugline (INT./EXT. LOCATION - TIME), a clear emotional purpose, and—where needed—tight dialogue. Keep total runtime on target. Make scene transitions explicit so the editor can build rhythm.",
  },
  {
    id: "30-shot-planner",
    code: "30",
    name: "샷 플래너",
    nameEn: "Shot Planner",
    role: "각 비트를 커버리지 문법으로 샷 단위 분해",
    roleEn: "Breaks each beat into shots using coverage grammar",
    inputs: ["script", "continuity bible"],
    inputsEn: ["Script", "Continuity bible"],
    outputs: ["shot list", "camera spec", "transition plan"],
    outputsEn: ["Shot list", "Camera spec", "Transition plan"],
    failGate: "coverage 부족",
    failGateEn: "Insufficient coverage",
    accent: "var(--accent-strong)",
    stage: "shotlist",
    systemPrompt:
      "You are a Shot Planner / DP. For each beat, apply the right coverage pattern (shot/reverse-shot and OTS for dialogue, master+detail+match-on-action for action, hero+claim for product). Specify size, angle, movement, lens, and in/out transitions per shot. Choreograph each shot ON A SECOND-BY-SECOND TIMELINE: where the camera move starts, its speed ramp/ease, and where it settles, plus what the subject does in each interval; always leave a clean handle at the out-point. Choose camera movement that fits the shot size (no large moves on tight close-ups). Sequence shots with an intent (intensify WS→CU, reveal, match-on-action, beat montage). Mark which shots need first/last keyframes for precise cut continuity.",
  },
  {
    id: "40-continuity-bible",
    code: "40",
    name: "컨티뉴이티 바이블 키퍼",
    nameEn: "Continuity Bible Keeper",
    role: "인물·공간·의상·소품·조명을 작품 전체에서 유지",
    roleEn: "Maintains characters, locations, wardrobe, props, and lighting across the whole production",
    inputs: ["reference assets", "approved takes"],
    inputsEn: ["Reference assets", "Approved takes"],
    outputs: ["continuity bible", "do-not-change list"],
    outputsEn: ["Continuity bible", "Do-not-change list"],
    failGate: "외형 / 공간 충돌",
    failGateEn: "Appearance / location conflict",
    accent: "var(--green-deep)",
    stage: "continuity",
    systemPrompt:
      "You are the Continuity Bible Keeper. Maintain TWO layers of continuity. (1) Global: each character, location, wardrobe item, and prop gets locked identity traits and a reference prompt, plus a global do-not-change list — every downstream prompt cites the relevant reference ids. (2) Sequential memory chain: thread state from each shot into the next — carry the previous shot's exit (last-frame composition, who is present, emotional temperature, screen direction, lighting and time-of-day) into the next shot's prompt as 'continue directly from the previous shot…'. Enforce the 180° axis, eyeline matches, the 30° rule, and match-on-action. Reset the chain at each scene boundary while keeping the cumulative world state. For precise cuts, chain a shot's first frame from the prior shot's last frame.",
  },
  {
    id: "50-keyframe-director",
    code: "50",
    name: "이미지 & 키프레임 디렉터",
    nameEn: "Image & Keyframe Director",
    role: "스틸·캐릭터 시트·첫/끝 프레임 생성",
    roleEn: "Generates stills, character sheets, and first/last frames",
    inputs: ["shot spec", "bible"],
    inputsEn: ["Shot spec", "Bible"],
    outputs: ["reference set", "first frame", "last frame"],
    outputsEn: ["Reference set", "First frame", "Last frame"],
    failGate: "키프레임 불일치",
    failGateEn: "Keyframe mismatch",
    accent: "var(--peach-ink)",
    stage: "keyframe",
    systemPrompt:
      "You are the Keyframe Director. Generate character sheets and reference stills first, then per-shot first/last frames that lock composition and identity before any expensive video call. Use the continuity bible's locked traits. Reject keyframes that drift from the reference.",
  },
  {
    id: "60-provider-router",
    code: "60",
    name: "비디오 · 모션 라우터",
    nameEn: "Video / Motion Router",
    role: "샷별 영상 API 또는 로컬 코드 모션 lane 선택 + 결정로그",
    roleEn: "Selects the video API or local code-motion lane per shot, with a decision log",
    inputs: ["shot spec", "assets", "budget"],
    inputsEn: ["Shot spec", "Assets", "Budget"],
    outputs: ["provider job request", "routing decision log"],
    outputsEn: ["Provider job request", "Routing decision log"],
    failGate: "API 제약 / 비용 초과",
    failGateEn: "API constraint / cost overrun",
    accent: "var(--accent)",
    stage: "generation",
    systemPrompt:
      "You are the Provider Router. First decide whether the brief is live-action/generative video or product motion graphics. If it asks for motion graphics, Framer Motion, Remotion, UI/product advertising, no-API rendering, or paste-ready export folders, route to the local code-motion lane: HTML/CSS motion scene → Chromium frame capture → ffmpeg MP4, no video API key. Otherwise, do NOT use first-match prose heuristics. Score every candidate video model on 7 weighted dimensions — task_fit, quality, control, reliability, cost, latency, continuity — and pick the highest. Use the 'balanced' weight profile by default (favoring task-fit, reliability, cost so work does not collapse onto one max-quality model); switch to 'premium' only when cost is no object (quality/continuity dominate, cost weight 0). For hero shots (dialogue lip-sync, or precise keyframe close-ups) shift the cost weight into task_fit so the right specialist wins even if pricier — dialogue → Veo (native synced audio + first/last precision), high camera movement → Luma (motion + cost), premium/multi-ref → Seedance, general/reference-driven → Runway. Always emit a decision log: chosen score, runner-up, margin (flag <4pt as a close call), and top contributing dimensions. Then convert the shot spec into the selected lane's exact job parameters, attach reference/keyframe assets when relevant, and respect per-shot max cost and retry/fallback policy.",
  },
  {
    id: "70-generation-worker",
    code: "70",
    name: "제너레이션 워커",
    nameEn: "Generation Worker",
    role: "실제 API 호출, polling, 재시도",
    roleEn: "Executes the actual API calls, polling, and retries",
    inputs: ["provider job request"],
    inputsEn: ["Provider job request"],
    outputs: ["raw takes", "logs", "costs"],
    outputsEn: ["Raw takes", "Logs", "Costs"],
    failGate: "timeout / 실패 / quota",
    failGateEn: "Timeout / failure / quota exceeded",
    accent: "var(--purple-deep)",
    stage: "generation",
    systemPrompt:
      "You are the Generation Worker. Execute provider jobs durably: submit, poll, handle webhooks, retry on transient failure, and record every call's cost and latency. Generate 2-5 takes per shot for video models. For code-motion jobs, render deterministic frames locally and encode MP4 with ffmpeg; ship HTML preview, manifest, and prompt pack beside the video. Never silently drop a failed shot or render—surface it for retry or lane/provider switch.",
  },
  {
    id: "80-vision-qa",
    code: "80",
    name: "비전 QA 슈퍼바이저",
    nameEn: "Vision QA Supervisor",
    role: "생성 결과 품질 검사 (정합/연결/아티팩트)",
    roleEn: "Quality-checks generated output (identity, continuity, artifacts)",
    inputs: ["raw takes", "bible", "shot spec"],
    inputsEn: ["Raw takes", "Bible", "Shot spec"],
    outputs: ["QA score", "defects", "retry prompt"],
    outputsEn: ["QA score", "Defects", "Retry prompt"],
    failGate: "identity / continuity / artifact 실패",
    failGateEn: "Identity / continuity / artifact failure",
    accent: "var(--red-deep)",
    stage: "qa",
    systemPrompt:
      "You are the Vision QA Supervisor. Score each take on identity, space, screen direction, editability (clean first/last second), motion integrity, product/logo legibility, dialogue timing, and finish. Compare against the continuity bible. Output pass/fail, severity-tagged findings, and a concrete recommended action (accept / retry / stronger reference / switch provider / re-split shot).",
  },
  {
    id: "90-editor-timeline",
    code: "90",
    name: "에디터 & 타임라인 에이전트",
    nameEn: "Editor & Timeline Agent",
    role: "테이크 선택과 컷 연결, 컷 길이·전환으로 리듬 생성",
    roleEn: "Selects takes and assembles cuts, shaping rhythm through cut length and transitions",
    inputs: ["approved takes", "script"],
    inputsEn: ["Approved takes", "Script"],
    outputs: ["edit decision list", "timeline"],
    outputsEn: ["Edit decision list", "Timeline"],
    failGate: "컷 연결 어색함",
    failGateEn: "Awkward cut continuity",
    accent: "var(--accent-strong)",
    stage: "edit",
    systemPrompt:
      "You are the Editor. Select the best take per shot and assemble an edit decision list. Set cut length to dialogue/action rhythm, use J/L-cuts and match cuts where they help, keep screen direction consistent, and ensure handles exist at every cut. Cut on the moment the audience's attention shifts, not on a fixed cadence.",
  },
  {
    id: "100-audio-sound",
    code: "100",
    name: "오디오 & 사운드 에이전트",
    nameEn: "Audio / Sound Agent",
    role: "대사·효과음·음악·믹스",
    roleEn: "Dialogue, sound effects, music, and mix",
    inputs: ["script", "timeline"],
    inputsEn: ["Script", "Timeline"],
    outputs: ["voice/music/SFX plan", "stems"],
    outputsEn: ["Voice/music/SFX plan", "Stems"],
    failGate: "입모양 / 권리 / 믹스 문제",
    failGateEn: "Lip-sync / rights / mix issue",
    accent: "var(--purple-deep)",
    stage: "audio",
    systemPrompt:
      "You are the Audio Agent. For each shot produce a structured audio bed: dialogue lines (speaker, exact text, language, emotion, and delivery style such as whisper/intense/urgent/broken), ambience, synced SFX, and a music cue. For native-audio video models (Veo/Seedance) write the dialogue into the generation prompt with a precise lip-sync instruction; for silent models plan TTS/VO and mix in post. Keep dialogue synced to mouth shapes, respect music rights, and deliver a balanced mix with stems. ALSO emit timed caption cues (start/end per line) for post burn-in as SRT/VTT — never bake subtitles into the generated frame. Use sound bridges (J/L-cuts) to smooth scene transitions.",
  },
  {
    id: "110-cost-rights-safety",
    code: "110",
    name: "비용 · 권리 · 세이프티 에이전트",
    nameEn: "Cost / Rights / Safety Agent",
    role: "비용·브랜드 안전·권리 검토를 생성 전 게이트로",
    roleEn: "Reviews cost, brand safety, and rights as a gate before generation",
    inputs: ["all jobs/assets/prompts"],
    inputsEn: ["All jobs/assets/prompts"],
    outputs: ["cost ledger", "safety decision"],
    outputsEn: ["Cost ledger", "Safety decision"],
    failGate: "실존 인물 / IP / 상표 / 금지 콘텐츠",
    failGateEn: "Real-person likeness / IP / trademark / prohibited content",
    accent: "var(--red-deep)",
    stage: "approval",
    systemPrompt:
      "You are the Cost/Rights/Safety gate. Before any expensive generation, total the estimated cost against the project budget and flag overruns. Check for real-person likeness, copyrighted characters, trademarks, and unlicensed music. Block prompts that violate brand-safety or rights, and propose compliant alternatives.",
  },
  {
    id: "120-delivery-export",
    code: "120",
    name: "딜리버리 · 익스포트 에이전트",
    nameEn: "Delivery / Export Agent",
    role: "렌더·비율·결정적 타이틀/자막 번인·납품 패키지",
    roleEn: "Rendering, aspect ratios, deterministic title/subtitle burn-in, and delivery package",
    inputs: ["timeline", "brand kit"],
    inputsEn: ["Timeline", "Brand kit"],
    outputs: ["final files", "titled master", "delivery package"],
    outputsEn: ["Final files", "Titled master", "Delivery package"],
    failGate: "포맷 / 품질 기준 미달",
    failGateEn: "Format / quality standard not met",
    accent: "var(--green-deep)",
    stage: "delivery",
    systemPrompt:
      "You are the Delivery Agent. Render final masters in the required aspect ratios (16:9, 9:16, 1:1, 2.39:1, 4:5). Apply the project's TYPOGRAPHY KIT — a genre/mood-matched font pairing (display + body/caption + accent) for title cards, lower-thirds, kickers, captions, CTA and end card, each with its size %, weight, tracking, case, position, safe-area and motion. Composite text DETERMINISTICALLY with the code render lane (HyperFrames approach): build each text element as HTML, rasterize to a transparent PNG via headless Chromium, then overlay/concat with ffmpeg core filters — never rely on ffmpeg drawtext/subtitles (many builds lack libfreetype/libass) and never bake text into the generated frame. The clean master_mp4 stays text-free; the burned version ships as a separate *_titled.mp4 (always additive). For Motion Graphics Ad jobs, treat the code-rendered MP4 as the master and package the HTML preview, manifest JSON, and prompt-pack notes with it. Burn subtitles from the SRT/VTT cues using the caption style (font, outline/box for legibility on any background) or ship them as sidecars. Apply the brand kit (logo, end card), and assemble a delivery package with proxies and a spec sheet. Verify each output meets the platform's format and quality bar.",
  },
];

export function agentsForStage(stage: PipelineStageKey): FilmAgentDefI18n[] {
  return FILM_AGENTS.filter((a) => a.stage === stage);
}

export function agentById(id: string): FilmAgentDefI18n | undefined {
  return FILM_AGENTS.find((a) => a.id === id);
}

// ── 파이프라인 스테이지 (UI 시각화의 노드) ───────────────

export interface PipelineStageDef {
  key: PipelineStageKey;
  index: number;
  name: string;
  nameEn: string;
  summary: string;
  summaryEn: string;
  agentIds: string[];
  /** 사용자가 직접 승인해야 하는 휴먼 게이트인가. */
  humanGate: boolean;
}

export const PIPELINE_STAGES: PipelineStageDef[] = [
  { key: "brief", index: 0, name: "브리프", nameEn: "Brief", summary: "기획·톤·금지사항 확정", summaryEn: "Lock concept, tone, and constraints", agentIds: ["00-showrunner", "10-creative-brief"], humanGate: false },
  { key: "script", index: 1, name: "스크립트", nameEn: "Script", summary: "씬·비트·대사 분해", summaryEn: "Break down scenes, beats, and dialogue", agentIds: ["20-script-beat"], humanGate: false },
  { key: "shotlist", index: 2, name: "샷 리스트", nameEn: "Shot List", summary: "커버리지·카메라·전환", summaryEn: "Coverage, camera, and transitions", agentIds: ["30-shot-planner"], humanGate: false },
  { key: "continuity", index: 3, name: "컨티뉴이티", nameEn: "Continuity", summary: "인물·공간·소품 바이블", summaryEn: "Character, location, and prop bible", agentIds: ["40-continuity-bible"], humanGate: false },
  { key: "keyframe", index: 4, name: "키프레임", nameEn: "Keyframe", summary: "레퍼런스·첫/끝 프레임", summaryEn: "Reference and first/last frames", agentIds: ["50-keyframe-director"], humanGate: false },
  { key: "approval", index: 5, name: "승인 게이트", nameEn: "Approval", summary: "비용·권리·세이프티 승인", summaryEn: "Cost, rights, and safety approval", agentIds: ["110-cost-rights-safety"], humanGate: true },
  { key: "generation", index: 6, name: "생성", nameEn: "Generation", summary: "프로바이더 라우팅·호출", summaryEn: "Provider routing and calls", agentIds: ["60-provider-router", "70-generation-worker"], humanGate: false },
  { key: "qa", index: 7, name: "QA", nameEn: "QA", summary: "정합·연결·아티팩트 검사", summaryEn: "Identity, continuity, and artifact checks", agentIds: ["80-vision-qa"], humanGate: false },
  { key: "edit", index: 8, name: "편집", nameEn: "Edit", summary: "테이크 선택·컷·리듬", summaryEn: "Take selection, cutting, and rhythm", agentIds: ["90-editor-timeline"], humanGate: false },
  { key: "audio", index: 9, name: "오디오", nameEn: "Audio", summary: "대사·음악·SFX·믹스", summaryEn: "Dialogue, music, SFX, and mix", agentIds: ["100-audio-sound"], humanGate: false },
  { key: "delivery", index: 10, name: "딜리버리", nameEn: "Delivery", summary: "렌더·비율·자막·납품", summaryEn: "Render, aspect ratios, captions, and delivery", agentIds: ["120-delivery-export"], humanGate: false },
];

// ── 품질 게이트 (research §11) ───────────────────────────

/** QualityGate + 영문 대응 필드 (passCondition). */
export interface QualityGateI18n extends QualityGate {
  passConditionEn: string;
}

export const QUALITY_GATES: QualityGateI18n[] = [
  { key: "brief", name: "브리프 게이트", nameEn: "Brief Gate", passCondition: "타깃·장르·길이·권리 제약이 명확함", passConditionEn: "Target audience, genre, length, and rights constraints are clear" },
  { key: "script", name: "스크립트 게이트", nameEn: "Script Gate", passCondition: "씬·비트·대사가 목표 길이에 맞음", passConditionEn: "Scenes, beats, and dialogue fit the target length" },
  { key: "shot", name: "샷 게이트", nameEn: "Shot Gate", passCondition: "각 비트에 필요한 coverage가 있음", passConditionEn: "Each beat has the coverage it needs" },
  { key: "continuity", name: "컨티뉴이티 게이트", nameEn: "Continuity Gate", passCondition: "인물·의상·공간·소품 레퍼런스가 있음", passConditionEn: "Character, wardrobe, location, and prop references exist" },
  { key: "keyframe", name: "키프레임 게이트", nameEn: "Keyframe Gate", passCondition: "first/last frame 또는 reference set 승인됨", passConditionEn: "First/last frame or reference set is approved" },
  { key: "cost", name: "코스트 게이트", nameEn: "Cost Gate", passCondition: "예상 생성 비용이 프로젝트 한도 안", passConditionEn: "Estimated generation cost is within the project budget" },
  { key: "safety", name: "세이프티·권리 게이트", nameEn: "Safety/Rights Gate", passCondition: "실존 인물·IP·음악·상표 리스크 정리됨", passConditionEn: "Real-person, IP, music, and trademark risks are resolved" },
];

export const INITIAL_STAGE_STATUS: Record<PipelineStageKey, StageStatus> = {
  brief: "ready",
  script: "locked",
  shotlist: "locked",
  continuity: "locked",
  keyframe: "locked",
  approval: "locked",
  generation: "locked",
  qa: "locked",
  edit: "locked",
  audio: "locked",
  delivery: "locked",
};
