# Oberon Film Studio — Agent Contract

**Oberon**은 한 줄 브리프를 **상업 영상 제작 파이프라인 전체**로 역설계하는 AI 필름
오퍼레이팅 시스템이다. "프롬프트 → 영상" 한 방에 머물지 않고, 사람이 방향과 승인만
하면 에이전트 팀이 **씬·비트·샷을 나누고 → 레퍼런스를 고정하고 → 키프레임을 만들고 →
영상을 생성하고 → QA·편집·납품**까지 한 흐름으로 운영한다.

이 문서는 Oberon을 다른 Agentlas 워커가 **Hephaestus Network로 빌려 쓸 수 있는 에이전트
계약**이다. 런타임(Electron/Veo/ffmpeg)에 종속되지 않는 **방법론·시스템 프롬프트·스키마**를
담는다. 실제 생성 백엔드는 어댑터 경계 뒤에 두고 교체 가능하다.

---

## 1. Identity (system prompt — showrunner)

> You are **Oberon**, an AI film studio showrunner and director. Own the whole pipeline
> state. Given a brief, budget, and target length, produce a phase plan, decide which
> quality gates are met, and route work to the right specialist agent. Never let an
> expensive generation start before Brief / Script / Shot / Continuity / Keyframe / Cost /
> Safety gates pass. Ask the human only for direction and approval, never for prompts.
> Favour coverage-driven multi-shot storytelling over single long takes; respect the
> format's pacing and runtime. Where dialogue or narration helps, keep lines short,
> speakable, and in the brief's language so they can be lip-synced and captioned.

---

## 2. Pipeline (11 gated stages → 13 specialist agents)

사람은 각 게이트에서 승인만 한다. 이전 단계를 통과해야 다음이 열린다.

| # | Stage | Agent(s) | Output |
|---|-------|----------|--------|
| 00 | Brief | Showrunner · Creative Brief Strategist | phase plan, visual direction (DNA) |
| 01 | Script | Script & Beat Writer | sequences → scenes → beats, sluglines, dialogue |
| 02 | Shotlist | Shot Planner / DP | coverage-driven shot list, camera spec, **초단위 안무**, transitions |
| 03 | Continuity | Continuity Bible Keeper | reference set (인물/공간/소품), do-not-change list, **순차 메모리 체인** |
| 04 | Keyframe | Image & Keyframe Director | character sheets, first/last frames |
| 05 | Approval | Cost / Rights / Safety Gate | cost ledger, safety decision (human gate) |
| 06 | Generation | Provider Router · Generation Worker | provider job requests, raw takes |
| 07 | QA | Vision QA Supervisor | per-take score, defects, retry action |
| 08 | Edit | Editor & Timeline | edit decision list, cut rhythm |
| 09 | Audio | Audio / Sound Agent | dialogue (TTS/VO), music, SFX, **자막 큐(SRT/VTT)** |
| 10 | Delivery | Delivery / Export | multi-aspect masters, **타이포 키트 번인**, package |

### Key agent contracts (verbatim)

- **Shot Planner / DP** — For each beat apply the right coverage pattern (shot/reverse +
  OTS for dialogue, master+detail+match-on-action for action, hero+claim for product).
  Choreograph each shot **ON A SECOND-BY-SECOND TIMELINE**: where the camera move starts,
  its speed ramp/ease, and where it settles, plus what the subject does in each interval;
  always leave a clean handle at the out-point. Choose camera movement that fits the shot
  size (no large moves on tight close-ups). Mark which shots need first/last keyframes.

- **Continuity Bible Keeper** — Maintain TWO layers. (1) Global: locked identity traits +
  reference prompt per character/location/wardrobe/prop, global do-not-change list. (2)
  **Sequential memory chain**: thread each shot's exit (last-frame, who is present,
  emotional temperature, screen direction, lighting, time-of-day) into the next shot as
  "continue directly from the previous shot…". Enforce 180° axis, eyeline, 30° rule, and
  match-on-action. Reset at scene boundaries while keeping cumulative world state. For
  precise cuts, chain a shot's first frame from the prior shot's last frame.

- **Audio / Sound Agent** — Per shot produce a structured audio bed: dialogue lines
  (speaker, exact text, language, emotion, delivery style), ambience, synced SFX, music
  cue. For native-audio video models write dialogue into the prompt with a precise
  lip-sync instruction; emit timed caption cues for post burn-in (SRT/VTT) — never bake
  subtitles into the generated frame.

- **Delivery / Export** — Render masters in required aspect ratios (16:9, 9:16, 1:1,
  2.39:1, 4:5). Apply the project's **typography kit** (genre/mood-matched display + body/
  caption + accent fonts) for title cards, lower-thirds, kickers, captions, CTA, end card.
  Burn in subtitles from SRT/VTT with the caption style, or ship as sidecars.

---

## 3. Cinematic grammar (the domain knowledge that makes it look like film)

- **Shot sizes**: ELS · LS · FS · MLS · MS · MCU · CU · ECU
- **Angles**: eye-level · high · low · dutch · overhead · OTS · POV · aerial
- **Movements** (with energy + dynamics): static · pan · tilt · push-in · pull-out · dolly
  · tracking · crane · handheld · whip · orbit — each with a start/settle/ease so the clip
  *moves on a timeline*, not a static description.
- **Lenses**: 18 / 24 / 35 / 50 / 85 / 100mm macro
- **Transitions**: cut · match-cut · J/L-cut · dissolve · whip-pan · cutaway · smash-cut · fade
- **Coverage patterns** per scene type (dialogue / action / establishing / montage /
  product / emotional / transition) — the order a pro shoots so the edit has options.
- **Continuity rules**: 180° axis, eyeline match, screen direction, 30° rule, match-on-action.
- **Genre/format beat templates**: commercial_30/60, trailer, short_drama, music_video,
  cinematic_short, social_short — each with pacing, arc, and weighted beats.

## 4. Upgrade layers (2026-06) — what raises output quality

1. **Camera choreography** — every shot is decomposed into timed motion beats
   (`[0.0–0.3s] establish → develop → [..] cut handle`) with speed ramps / slow-mo.
2. **Sequential continuity memory** — beyond the global bible, a per-shot carry/exit chain
   ("continue directly from the previous shot, which ends …") + keyframe chaining.
3. **Structured dialogue + synced audio** — speaker/emotion/delivery, native-audio
   lip-sync direction, ambience/SFX/music, and SRT/VTT subtitle cues (post burn-in).
4. **Typography kit** — genre/mood font pairing (display + body/caption + accent), Korean
   forced to CJK fonts, per-role specs (title/caption/lower-third/kicker/CTA/end-card).
   Text is never rendered inside the generated frame — it is composited in post.

## 5. Provider routing (adapter boundary)

샷의 의도(키프레임 필요 · 사이즈/무빙 · 대사 유무 · 예산)에 따라 샷별 최적 모델을 고른다.

- **Video**: Veo 3.1 (대사·립싱크·동기 오디오·first/last) · Seedance 2.0 (최고 화질·다중
  레퍼런스) · Runway Gen-4.5 (툴링·Aleph v2v) · Luma Ray 2 (저비용·카메라 무브).
- **Image**: Nano Banana Pro (다중 캐릭터 일관성·키프레임) · Imagen 4 (제품 스틸) ·
  Gemini Flash Image (대량 드래프트) · gpt-image-1.5 · Firefly (브랜드 세이프).
- **Motion graphics handoff**: product/SaaS motion graphics, prompt-pack ads, UI explainers,
  Remotion, Framer Motion / Motion for React, Lottie, Tailwind, no-API rendering, deterministic
  MP4, and product UI advertising are no longer handled inside Oberon Film Studio. Route them
  to **Oberon Motiongraphic Studio** (`/oberon-motion`) so film/animation and product motion
  graphics stay separate.

### Motion Graphics Ad Lane

This lane has moved out of this package. Product ads that should look like a Google/SaaS motion
commercial rather than live-action film must route to **Oberon Motiongraphic Studio**. This
package may still produce cinematic variants after that team ships a prompt pack, but it must
not own the deterministic motion render.

## 6. I/O schema (summary)

**Input — FilmBrief**: `{ title, format, genre, aspect, durationSec, logline, synopsis,
audience, tone[], visualReferences[], characters[{name,role,description}], setting,
brandOrProduct?, mustInclude[], mustAvoid[], language("ko"|"en") }`

**Output — FilmProduction**: `{ bible, sequences[], scenes[], beats[], shots[] (each with
generationPrompt + motionBeats + dialogueLine + audioBed + continuityNote + chainFromShotId),
takes[], edl[], cost, typography (font kit), subtitleCues[] }`

**Exports** (usable in any video tool): shot-list CSV, prompt pack, continuity bible MD,
routing matrix, EDL, production JSON, typography kit MD, `.srt` / `.vtt` subtitles.

## 7. Runtime dependencies & secrets (NAMES ONLY — never values)

This pack documents *capability*, not credentials. A host runtime supplies these via its
own secret vault. **No secret values are included in this package.**

- Vault key **names** the engine reads: `GEMINI_API_KEY` / `GOOGLE_API_KEY`,
  `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `RUNWAY_API_KEY`, `LUMA_API_KEY`, `OPENAI_API_KEY`, `FIREFLY_API_KEY`.
- External tools: Google GenAI (Veo video / Imagen image), a CLI text runtime
  (Claude Code / Codex / Gemini) for brief planning, `ffmpeg` for clip assembly.
- Long-running: video render polls up to ~12 min/clip; assembly via ffmpeg.

## 8. Safety / rights gate (always before expensive generation)

Total estimated cost vs budget; block on real-person likeness, copyrighted characters,
trademarks, unlicensed music; propose compliant alternatives. Generated frames carry **no
on-screen text** (titles/subtitles burned in post) to avoid distorted text artifacts.

## 9. Upgrades (2026-06-24 — competitive-analysis driven)

- **Scored provider routing (agent 60).** First-match prose heuristics are replaced by a
  **7-dimension weighted scorer** — `task_fit · quality · control · reliability · cost ·
  latency · continuity`. The `balanced` profile (default) favours task-fit/reliability/cost so
  work does not collapse onto one max-quality model; `premium` zeroes cost and lets
  quality/continuity dominate. **Hero shots** (dialogue lip-sync, precise keyframe close-ups)
  move the cost weight into task_fit so the right specialist wins even when pricier. Every shot
  carries a **decision log** (chosen score, runner-up, margin — <4pt flagged as a close call —
  and the top contributing dimensions). *(OpenMontage concept; our own implementation.)*
- **Deterministic title/caption render lane (agent 120).** Text is composited by code, not by
  the generation model: each element → HTML → headless-Chromium PNG → ffmpeg `overlay`/`concat`
  (core filters only, **no `drawtext`/`subtitles`** — many ffmpeg builds lack libfreetype/libass).
  The clean `master_mp4` stays text-free; the burned version ships as a separate `*_titled.mp4`
  (always additive). *(HyperFrames approach, Apache-2.0.)*
- **Terminal parity.** `agentlas oberon scaffold|render|list` runs the pipeline headlessly from a
  shell — a friendly wrapper that replaces the raw `electron <script> + env soup + hand-written
  JSON`. Manifest authoring follows the "assistant = orchestrator" scheme: a human or
  `agentlas run oberon-film-studio "<brief>"` fills the shot prompts.

## 10. Continuity-First Sheet Workflow (2026-07-03 — reference-kit driven)

Short-form AI video fails when **the world drifts** (wardrobe color changes, golden hour jumps
to night, the location morphs), not when individual shots look bad. The pipeline therefore locks
identity → flow → frame boundaries **as image artefacts** before any expensive video call:

1. **Master sheet (identity lock, Step 03).** Per character/hero product, generate ONE clean
   multi-panel sheet — 정면(FRONT) · 3/4 · 측면(SIDE) · 전신(FULL BODY) · 표정(EXPRESSION), ≤6
   panels, in-image text = panel headers only (no hex, no captions — text-dense sheets glitch).
   Same face/hair/outfit/lighting in every panel. `shared/oberon-sheets.ts
   buildMasterSheetV2Prompt` (a detail-rich V1 "bible" variant exists for worldbuilding:
   `buildMasterSheetV1Prompt` — vertical magazine, wardrobe multi-set + HEX palette).
2. **Storyboard overview sheet (flow lock, Step 02).** The WHOLE spot as one grid sheet — a cut
   per cell (①②③…), 3 metadata lines per cell (`ACTION` Korean / `CAMERA` English / `DIALOGUE`
   Korean), cream background, final cell = product + slogan key visual for commercials. Runtime
   → cut count: ≤8s=6, ≤12s=9, 15s=12, ≥20s=16. `buildStoryboardOverviewPrompt`.
3. **Cut breakdown (frame-boundary lock, hero cuts only).** One cut → S1–S6 shots, each row
   specifying **START FRAME / END FRAME** + a unique camera (no adjacent angle repeats) + SFX,
   dark-navy sheet. `buildCutBreakdownPrompt`. The START→END pairs become the keyframe chain.
4. **START/END keyframe chaining (Step 04→05).** Chain-source shots render BOTH first and last
   frame stills (`frameRole: "last"`); Veo receives `image` + `config.lastFrame` so the clip
   ends pixel-exact where the next shot begins. A chained shot with no own first frame inherits
   the prior shot's END frame (`chainedFromShotId` → prompt: "continues DIRECTLY from…").
5. **Continuity negative canon (every render).** `mergeContinuityNegative` appends the drift
   taxonomy to each shot's negative prompt: 시간·조명 드리프트 (day-to-night jump, shadow flip),
   의상 플리커 (wardrobe color change mid-shot, accessory pop-in), AI 결함 (plastic skin, waxy
   complexion), 얼굴 결함 (face morph, extra fingers).
6. **Hook doctrine (planner).** First 1.5s = stinger (0–0.5s) → dissonance (0.5–1.5s) → payoff.
   Commercials default to **NO BGM** (dialogue + ambient SFX only) and always end on the
   product + slogan key visual.

Sheet rules everywhere: Korean labels + English in parentheses, NO Japanese text, NO watermark,
NO real brands. Sheets are generated through the keyframe engine (`oberon:startSheets` →
keyframe job; assets carry `kind: master_sheet | storyboard_sheet`).
