# Upstage Solar (한국 소버린 LLM) 통합 기획 — 2026-05-31

> 목표: Upstage의 **Solar**(한국 소버린 LLM)를 agentlas의 런타임으로 추가해, claude/codex/gemini와
> 동일하게 에이전트·회사를 구동하고 BYOK로 선택할 수 있게 한다. 근거: agentlas는 이미 멀티-LLM
> 호스트이며 Solar는 **OpenAI 호환 API**라, 기존 BYOK(OpenAI) 경로를 base URL만 바꿔 재사용하면 된다.

---

## 0. 왜 — 포지셔닝 (제품 관점)

- **한국 소버린 AI 수요**: Upstage Solar는 한국 유일의 Artificial Analysis "Frontier" 등재 모델이며,
  **공공부문 1호 생성형 AI 공급자**(조달청 디지털서비스몰 등록)로 **폐쇄망/분리망**에서도 쓸 수 있다.
- **agentlas는 이미 한국-우선 앱**(ko 로케일 기본·IME 가드·로케일 권위화). "claude/codex/gemini +
  **한국 소버린 Solar**를 한 터미널에서" 는 강력한 차별화 — 데이터가 한국 벤더에 직접(agentlas 서버 미경유,
  BYOK 원칙 그대로), 공공/규제 고객에게 소버린 옵션 제공.
- 비용/주권 선택지: 영어권 모델과 한국 모델을 에이전트별로 `/team`에서 핀 고정 가능.

## 1. Upstage Solar 사실관계 (검증)

- **API**: OpenAI 호환 `chat/completions`. **Base URL `https://api.upstage.ai/v1`** (Upstage 공식 cookbook 기준).
  - ⚠️ 확인 필요: 일부 서드파티(Mastra)는 `https://api.upstage.ai/v1/solar` + `upstage/` 프리픽스 모델ID를
    보고 — 이는 게이트웨이 변형으로 보임. 구현 시 `console.upstage.ai` 공식 문서로 base/모델ID 최종 확인.
- **인증**: `Authorization: Bearer <UPSTAGE_API_KEY>` (OpenAI 동일).
- **모델 (bare ID)**:
  | id | context | vision | tool calling | 비고 |
  |---|---|:--:|:--:|---|
  | `solar-mini` | ~33K | ✗ | (확인) | 경량·저비용 |
  | `solar-pro2` | ~66K | ✗ | (확인) | 31B, Chat/Reasoning 하이브리드, **기본값 권장** |
  | `solar-pro3` | ~131K | ✗ | (확인) | 최신·롱컨텍스트 |
  - ⚠️ tool calling: Upstage는 Solar Pro 2 "tool use" 표방하나 일부 호환 표는 미지원으로 표기 →
    agentlas api-agent는 `toolDefs.length`일 때만 tools를 붙이고 모델이 안 부르면 그냥 텍스트로 동작하므로
    **미지원이어도 안전**(degrade). 실측으로 function-calling 동작 확인 후 capability에 반영.
- 멀티모달(이미지 입력) 없음 → capability `image:false`, `multimodal:false`.

## 2. 아키텍처 적합성

agentlas BYOK는 `RuntimeKind="byok"` + `RuntimeBackend`(anthropic/openai/google/ollama)로 모델링.
Solar는 **OpenAI 호환**이므로 `backend:"upstage"`를 추가하고 **OpenAI 루프를 base URL만 바꿔 재사용**한다.
키는 keytar `byok:upstage`로 자동 저장(네임스페이스 이미 일반화돼 있음).

핵심: 신규 프로토콜 구현이 **전혀 필요 없다**. OpenAI 경로의 URL 상수만 backend로 분기.

## 3. 변경 surface (파일별, 앵커 포함)

### A. 타입/카탈로그 (앱·CLI 공유)
1. `shared/types.ts:7` — `RuntimeBackend`에 `"upstage"` 추가:
   `export type RuntimeBackend = "anthropic" | "openai" | "google" | "ollama" | "upstage";`
2. `shared/models.ts`:
   - `ByokBackend`(L11)에 `"upstage"` 추가.
   - `BYOK_MODELS`(L39)에 `upstage: [ {id:"solar-pro2",label:"Solar Pro 2 (한국 소버린)",contextWindow:65536,multimodal:false},
     {id:"solar-pro3",label:"Solar Pro 3",contextWindow:131072,multimodal:false,longContext:{tokens:131072,mode:"auto"}},
     {id:"solar-mini",label:"Solar Mini",contextWindow:32768,multimodal:false} ]`.
   - `DEFAULT_BYOK_MODEL`(L99)에 `upstage:"solar-pro2"`.
   - `isByokBackend`(L105) 분기에 `|| backend === "upstage"`.

### B. CLI 대화형/에이전트 루프
3. `cli/agentlas-api-agent.cjs`:
   - `streamOpenAI`의 하드코딩 URL(L189 `https://api.openai.com/v1/chat/completions`)을
     `req.baseUrl || "https://api.openai.com/v1"` + `"/chat/completions"`로 파라미터화.
   - `runOpenAILoop`가 `req.baseUrl`을 `streamOpenAI`에 전달.
   - 디스패치(L403 switch)에 `case "upstage": return runOpenAILoop({ ...req, baseUrl: "https://api.upstage.ai/v1" });`
4. `cli/agentlas.cjs`:
   - `DEFAULT_API_MODEL`(L702)에 `upstage:"solar-pro2"`.
   - 1회성 `runApi()`(L713)의 openai 분기를 base URL로 일반화하고 upstage 추가(스크립트/`run` 경로용).
   - `apiKey(backend)`(L708)는 keytar `byok:<backend>`로 이미 일반화 → upstage 자동 동작.
5. `cli/agentlas-capabilities.cjs:14` — `RUNTIME_CAPS`에 `upstage: { code:true, image:false, label:"solar" }`.
6. `cli/agentlas-repl.cjs` — `setRuntime`의 `apiBackends`(L213 근처)에 `upstage:1`. (i18n `runtimeUsage` 문자열에 upstage 추가)
7. `cli/agentlas-input.cjs` — `RUNTIME_SPECS`에 `"upstage"` 추가(탭 자동완성).

### C. 앱(Electron) BYOK 러너
8. `electron/secrets/vault.ts` — `RuntimeBackend`에 upstage 포함되면 키 저장 자동(`byok:upstage`). 추가 코드 불필요.
9. `electron/runtime/byok.ts` — `runOpenAIByok`을 base URL 파라미터화한 헬퍼로 추출 후
   `runUpstageByok = (req,ev) => runOpenAICompatible(req,ev,{backend:"upstage", baseUrl:"https://api.upstage.ai/v1", keyName:"upstage", label:"Solar"})`.
10. 러너 레지스트리(`electron/runtime/runner.ts` 또는 `detect.ts`의 backend→runner 매핑)에 `upstage→runUpstageByok` 등록.
    `prepareContext`/`compactHistory`는 `effectiveContextWindow("upstage", model, ...)`로 그대로 동작(카탈로그 추가했으므로).

### D. 렌더러 설정 UI (키 입력 — "쓸 수 있게"의 핵심)
11. `renderer/app/(shell)/settings/page.tsx` — BYOK 프로바이더 목록에 **Upstage Solar** 카드 추가:
    라벨 "Upstage Solar · 🇰🇷 한국 소버린 LLM", `window.api.saveApiKey("upstage", key)` / `hasApiKey` / `deleteApiKey`,
    모델 선택은 `byokModels("upstage")`. 키 발급 안내 링크 `console.upstage.ai/api-keys`.
12. `renderer/app/(no-shell)/onboarding/page.tsx` — 런타임 선택지에 Solar 노출(선택).
13. (선택) 라이브 모델 조회: BYOK `/models` 핸들러가 upstage일 때 `GET https://api.upstage.ai/v1/models`(OpenAI 호환)
    조회 — 실패 시 카탈로그 fallback.

### E. 능력 라우팅/표기
14. `agentlas-capabilities.cjs`의 이미지 라우팅은 그대로 — Solar는 image:false라 이미지 에이전트가 Solar로
    오라우팅되지 않음(정상). 코딩/한국어 텍스트 에이전트는 `/team <agent> upstage`로 핀 가능.

## 4. 단계별 롤아웃

- **P0 — CLI BYOK 백엔드** (A,B): `/runtime upstage` + `agentlas run`이 Solar로 동작. (keytar에 키 선주입 필요)
- **P1 — 앱 UI 키 입력 + 러너** (C,D): 설정에서 키 등록 → GUI/CLI 공통으로 "쓸 수 있게". **여기서 실사용 완성.**
- **P2 — 고도화**: 라이브 `/models`, function-calling 실측 반영, Solar **Document Parse/OCR**(Upstage 강점)을
  도구로 노출, Reasoning 모드 토글(`reasoning_effort`), 소버린 배지/필터(공공망 모드).

## 5. 검증 계획

- 타입: `npm run typecheck` (shared/electron/renderer TS — backend 유니온 확장 누락 컴파일 에러로 전부 잡힘).
- CLI: `node --check` 전 cjs + `agentlas-input` 단위테스트(RUNTIME_SPECS upstage 완성 확인) + electron 실구동
  `/runtime upstage` → `/status`에 `runtime upstage` 표기, 키 없으면 `noKey` 안내.
- 엔드투엔드: 더미 키로 `solar-pro2` 한 턴 호출 → 스트리밍/usage/`/cost` 원장에 `upstage` 라인.
- 회귀: 기존 anthropic/openai/google/ollama 경로 무변화.

## 6. 리스크 / 확인 필요

1. **Base URL**: 공식 `…/v1` vs 서드파티 보고 `…/v1/solar` — 구현 직전 console.upstage.ai 문서로 확정(상수 1곳).
2. **Tool calling**: 미지원이어도 안전 degrade. 실측 후 capability/문서 반영.
3. **Context window 정확값**: 33K/66K/131K는 근사 — 공식 문서로 확정해 압축 임계값 정밀화.
4. **Rate/region**: 소버린/폐쇄망 배포 시 엔드포인트가 다를 수 있음(엔터프라이즈) → base URL을 설정 가능하게(고급 옵션) 두면 폐쇄망 대응.
5. 키 보안: 기존 BYOK 원칙대로 메인 프로세스 keytar만, renderer 비노출, agentlas 서버 미경유 — 소버린 요건과 합치.

## 7. 1줄 요약

Solar는 OpenAI 호환이라 **신규 프로토콜 0** — `backend:"upstage"` 추가 + OpenAI 루프 base URL 분기 +
카탈로그/설정 UI만으로, agentlas가 "claude·codex·gemini·**한국 소버린 Solar**"를 한 터미널에서 굴리는
유일한 멀티-LLM·소버린 런처가 된다.
