# Electron 내부 Agent 라이브 프리뷰 — 연구 노트

작성: 2026-07-10 · 브랜치 `claude/electron-agent-live-preview-lkmo47`
성격: **연구 전용**(코드 변경 없음). "Electron 안에서 에이전트가 웹/앱을 만들고 바로 실행·수정하는 제작 환경" 요청에 대한 타당성/설계 조사.

---

## 0. 한 줄 결론

기반 인프라(App Factory 스캐폴딩, 로컬 dev 커맨드, cross-spawn 프로세스 실행, Playwright/CDP)는 **이미 대부분 존재**한다. 빠진 것은 단 두 조각이다.

1. **Electron 안에 dev server URL을 붙이는 라이브 프리뷰 뷰** (현재 없음 — 오히려 정책상 금지되어 있음).
2. **dev server 프로세스 매니저 + 프리뷰 상태(스크린샷/DOM/console) 피드백 루프**.

즉 새 런타임을 발명할 필요는 없고, "외부 브라우저로 연다"는 현재 정책을 "선택적으로 앱 내부 프리뷰로도 연다"로 확장하는 문제다.

---

## 1. 현재 코드베이스가 실제로 하는 일 (grounding)

요청서의 그림과 대조하기 위해 실제 코드 기준으로 정리한다.

### 1.1 App Factory = 스캐폴딩까지만
- `electron/app-factory/scaffold.ts` : 에이전트가 낸 **Surface Manifest**(`kind:"surface"`, `app.routes/tools`, `data`, `widgets`, `actions`)를 받아 `agentlas-apps/<appId>/` 아래에 **평범한 로컬 웹앱 패키지**를 물질화한다.
- 산출물에는 `launchUrl`(예: `http://localhost:3000`), `devCommand`(예: `node scripts/serve.mjs`), `setup`/`smoke` 경로가 붙는다.
- 결정적 사실: `runtimeMode: "external-local-webapp"` 로 하드코딩되어 있다 (`scaffold.ts:73, 99`).

### 1.2 실행 = 외부 브라우저 (핵심 갭)
- `docs/generated-app-engine.md:25` — **"Desktop does not render generated user-app UI in the Electron/Next renderer."**
- 즉 지금은 사용자용 앱을 **기본 브라우저/로컬 웹 런타임에서 연다.** Electron 내부에 라이브 프리뷰가 없다. 이게 요청의 핵심 목표와 정면으로 다른 지점이다.

### 1.3 "surface-preview" 는 라이브 프리뷰가 아니다
- `renderer/app/(no-shell)/surface-preview/page.tsx` 는 **Manifest를 선언적으로 렌더**하는 `WorkbenchPanel`이다. 실제 URL/dev server를 로드하는 브라우저 프리뷰가 아니라, JSON 매니페스트 → React 위젯 렌더러다.
- 따라서 "코드 바뀌면 HMR로 화면 갱신" 루프와는 무관하다.

### 1.4 이미 있는 재사용 가능한 부품
| 부품 | 위치 | 라이브 프리뷰에서의 쓸모 |
|---|---|---|
| 크로스플랫폼 프로세스 실행 | `electron/runtime/exec.ts` (cross-spawn, GUI PATH 보정) | dev server를 안정적으로 spawn |
| 앱 프로세스 spawn 예시 | `electron/app-factory/operations.ts` (`spawn`, `execNode`) | dev server 라이프사이클 관리의 뼈대 |
| 라이브 이벤트 방송 패턴 | `electron/workflow/live-run.ts` (`webContents.send` per-id 채널) | 프리뷰 상태/HMR 이벤트를 렌더러로 브로드캐스트 |
| Playwright/Chromium | `operations.ts` (`chromium.launch`), `electron/mcp-tools/browser-cdp-launcher.ts` (CDP) | 스크린샷/DOM/console 수집 |
| 메인 윈도우 보안 기준선 | `electron/main.ts:158-171` (contextIsolation:true, nodeIntegration:false, sandbox:true) | 프리뷰 뷰가 지켜야 할 격리 기준 |

### 1.5 환경
- Electron `^33.0.0` → `WebContentsView`(Electron 30+ 정식 API) 사용 가능. 구식 `BrowserView`(deprecated)나 `<webview>`(비권장)에 의존할 필요 없음.
- Renderer는 Next.js `^15`. dev는 `next dev -p 3100`, Electron은 `ELECTRON_START_URL`로 그 URL 로드.

---

## 2. 프리뷰 렌더링 방식 3택 비교

요청서가 나열한 세 후보. Electron 33 기준 권장은 명확하다.

| 방식 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **`WebContentsView`** (권장) | 별도 webContents = 완전한 프로세스/보안 격리, DevTools·CDP·`capturePage()`·`executeJavaScript()` 전부 사용 가능, 메인 프로세스가 라이프사이클/네비게이션 완전 제어 | 네이티브 뷰라 DOM 레이어 위에 얹히는 오버레이라서 **레이아웃을 메인 프로세스에서 bounds로 수동 배치**해야 함(리사이즈/스크롤 동기화 필요) | ✅ 데스크톱/웹 프리뷰의 기본 |
| `<webview>` 태그 | 렌더러 HTML 안에 인라인 배치(레이아웃 쉬움) | Electron이 공식적으로 **비권장**, 버그·성능 이슈, 보안 표면 큼 | ⚠️ 지양 |
| `<iframe>` | 가장 단순, 순수 웹 | dev server가 `X-Frame-Options`/CSP로 막으면 로드 불가, cross-origin이면 스크린샷·DOM 접근 차단, 프로세스 격리 없음 | 🔸 폴백/경량 미리보기용만 |

**권장 조합**: 웹·데스크톱 프리뷰는 `WebContentsView`. 저부담 경량 미리보기(예: 정적 매니페스트)는 iframe 폴백.

### 2.1 WebContentsView 배치 문제 해결책
네이티브 뷰라 CSS로 위치를 못 잡는다. 표준 패턴:
- 렌더러에 프리뷰가 놓일 자리표시자 `<div ref>`를 두고, `ResizeObserver`로 bounds(`x,y,width,height`)를 측정.
- IPC로 메인에 bounds 전달 → `view.setBounds(bounds)`.
- 창 리사이즈·패널 접힘·devtools 토글마다 갱신.
- 이 프로젝트는 이미 `live-run.ts`식 per-id 채널 방송 패턴이 있으니 `preview:bounds:<previewId>` 같은 채널로 자연스럽게 확장 가능.

---

## 3. Dev server 프로세스 매니저 설계

새 모듈 예: `electron/app-factory/preview-runtime.ts` (신설 제안, 이번엔 미구현).

책임:
1. **기동**: `agentlas-apps/<appId>/`에서 `devCommand`를 `runtime/exec.ts`의 cross-spawn 헬퍼로 실행. `PORT` 주입, `cwd=rootPath`.
2. **준비 감지**: stdout에서 "ready"/URL 매칭 또는 포트 폴링(TCP connect)으로 `http://localhost:<port>` 준비 확인 후에야 프리뷰 로드. (프로젝트에 `wait-on` 이미 의존성 존재 — 재사용 가능.)
3. **포트 할당**: 충돌 방지 위해 사용 가능 포트 동적 선택, manifest의 `launchUrl` 갱신.
4. **로그 스트리밍**: stdout/stderr를 `live-run.ts` 패턴으로 렌더러 Logs 패널에 방송.
5. **종료/정리**: 앱 전환·창 종료 시 프로세스 트리 kill(자식 포함). Windows는 `tree-kill` 또는 detached+`process.kill(-pid)` 패턴 유의.
6. **크래시 복구**: dev server exit 코드 감지 → 재시작 or 에러 배너.

동시성: 여러 앱 프리뷰를 동시에 띄우려면 appId→{child, port, view} 레지스트리. 단일 활성 프리뷰만이면 훨씬 단순.

---

## 4. 파일 patch → 즉시 반영 경로 (요청서 3분류 검증)

### 4.1 웹앱 (React/Vite/Next) — 완전 가능
- Agent가 `src/*`, `styles.css`, `package.json` patch → dev server의 **HMR/Fast Refresh**가 변경분만 반영 → `WebContentsView`는 같은 URL 유지, 새로고침 불필요.
- 주의: 현재 스캐폴드는 `node scripts/serve.mjs`(정적 serve)라 **HMR이 없다**. 진짜 HMR을 원하면 스캐폴드 템플릿을 Vite 기반(`vite dev`)으로 바꾸거나 HMR 지원 템플릿을 추가해야 한다. → 이게 "빌드 없이 바로 바뀜" 체감의 실제 전제조건.

### 4.2 Electron 데스크톱 앱 프리뷰 — 부분 가능
- 요청서 표현대로 **renderer 코드 변경은 HMR, main process 변경은 재시작**이 물리적 한계다.
- 실현법: 대상 앱의 renderer(dev URL)를 호스트의 `WebContentsView`로 로드하면 renderer HMR은 그대로 동작. main process 변경은 별도 자식 Electron 인스턴스를 재시작하는 방식이 필요 → 복잡도 상승. **MVP에서는 "웹 런타임으로서의 프리뷰"만 지원하고 실제 별도 Electron 스폰은 후순위 권장.**

### 4.3 모바일 (RN/Expo) — 진짜 프리뷰는 제약
- 요청서도 인정하듯 **완전 네이티브를 "빌드 없이" 앱 안에 렌더할 수 없다.** 현실안:
  - (a) **Expo web** 타깃을 `WebContentsView`로 로드(Fast Refresh 동작, 단 네이티브 모듈은 없음).
  - (b) 시뮬레이터/기기 화면을 스트리밍(별도 도구, 무거움).
  - MVP 권장: (a) Expo web 프리뷰. 네이티브 정합은 "기기에서 열기" QR로 위임.

**요약**: 요청서 3분류 중 **웹앱만 1급 지원**, 데스크톱/모바일은 명시적 제약을 UX로 흡수해야 한다.

---

## 5. 프리뷰 → Agent 피드백 루프

`WebContentsView`를 쓰면 이 프로젝트에 이미 있는 부품으로 대부분 수집 가능:

| 신호 | 수집 방법 | 재사용 부품 |
|---|---|---|
| 스크린샷 | `view.webContents.capturePage()` → PNG | multimodal 파이프라인에 그대로 투입 가능 |
| DOM 구조 | `view.webContents.executeJavaScript('document.documentElement.outerHTML')` 또는 접근성 트리 | — |
| console error | `view.webContents.on('console-message', …)` | `live-run.ts` 방송 패턴 |
| network error | `webContents.session.webRequest.onErrorOccurred` / `on('did-fail-load')` | — |
| selected element / click 위치 | 프리뷰에 주입한 preload가 클릭 좌표·`elementFromPoint` 캡처 후 IPC | 별도 격리 preload 필요 |
| current route | `webContents.getURL()` / `did-navigate` | — |

- CDP가 필요할 만큼 깊은 상호작용(요소 하이라이트, 정밀 클릭 주입)은 `browser-cdp-launcher.ts`가 이미 확립한 CDP 접속 패턴을 프리뷰 webContents(`webContents.debugger.attach`)에 재적용하면 된다.
- 이 신호들을 하나의 "Preview Observation" 객체로 묶어 Agent 턴 입력에 넣는 것이 루프의 핵심. (screenshot + console + route + selected element)

---

## 6. 보안 / 격리 (중요)

생성된 사용자 앱 코드를 앱 내부에서 실행하므로 메인 윈도우 기준선(`main.ts`)을 **그대로 상속**해야 한다:
- 프리뷰 `WebContentsView`: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true` 필수.
- 프리뷰 preload는 **최소 표면**(클릭/DOM 관측만), 시크릿·파일시스템 API 절대 노출 금지 — 이 레포는 이미 `secrets/vault`·fs 경계 테스트(`test:fs-access-boundary`, `test:mcp-secret-isolation`)를 운영 중이므로 동일 기준 적용.
- dev server는 `127.0.0.1`에만 바인드. 외부 노출 금지.
- 생성 코드는 신뢰 불가 입력으로 취급 → `surface-trust.ts` 신뢰 메타데이터 흐름과 연결.
- 현행 정책 문서(`generated-app-engine.md`)가 "임베드 금지"를 명시하므로, 프리뷰 도입 시 **정책 문서/`runtimeMode` 확장**(예: `"embedded-preview"` 추가)이 선행 결정 사항이다. 이건 코드보다 제품 결정.

---

## 7. 통합 지점 (실제 파일 매핑)

| 레이어 | 붙일 곳 |
|---|---|
| 프리뷰 뷰 생성/배치 | `electron/main.ts`(윈도우 소유) + 신설 `electron/app-factory/preview-view.ts` |
| dev server 매니저 | 신설 `electron/app-factory/preview-runtime.ts`, `runtime/exec.ts` 재사용 |
| IPC 채널/preload | `electron/ipc.ts`, `electron/preload.ts` (bounds·observation·log 채널 화이트리스트 추가) |
| 상태 방송 | `electron/workflow/live-run.ts` 패턴 복제 (`preview:*:<id>`) |
| 우측 프리뷰 UI | `renderer/components/`(WorkbenchPanel 옆) 신설 `LivePreviewPanel.tsx`, bounds 자리표시자 |
| HMR 템플릿 | `electron/app-factory/scaffold.ts` — Vite 기반 dev 템플릿 옵션 추가 |
| 관측→Agent | multimodal + chat 런타임 입력에 Preview Observation 주입 |

---

## 8. 단계적 로드맵 (권장 순서)

1. **M0 정책 결정**: `runtimeMode: "embedded-preview"` 허용 여부 + `generated-app-engine.md` 개정. (제품/보안 승인)
2. **M1 뷰 골격**: 하드코딩 URL(`localhost:3100` 등)을 `WebContentsView`로 우측 패널에 bounds 동기화하여 로드. 순수 표시만.
3. **M2 프로세스 매니저**: `devCommand` spawn + ready 감지 + 로그 방송 + 정리. 스캐폴드 앱 하나를 실제로 띄움.
4. **M3 HMR 템플릿**: Vite dev 템플릿으로 "파일 patch → 즉시 반영" 실증.
5. **M4 관측 루프**: screenshot/console/route/selected-element 수집 → Agent 입력.
6. **M5 확장**: 다중 프리뷰, Expo web, (후순위) 별도 Electron 데스크톱 프리뷰.

각 단계는 독립적으로 가치가 있고 M1~M2만으로도 요청의 80%(만들고→띄우고→본다)를 충족한다.

---

## 9. 리스크 / 오픈 이슈

- **HMR 전제**: 현행 `serve.mjs` 정적 서빙으로는 "빌드 없이 즉시 반영" 체감이 안 난다. Vite 템플릿 전환이 사실상 필수.
- **정책 충돌**: 현재 명문화된 "임베드 금지" 정책과 정면 충돌 → 먼저 합의 필요.
- **WebContentsView 배치 동기화** 버그(리사이즈/스크롤/z-order)는 잔손질이 많은 영역.
- **프로세스 누수**: dev server 좀비 프로세스, 포트 고갈. 크로스플랫폼 kill 필요.
- **보안 표면 확대**: 신뢰 불가 생성 코드 실행 → 격리·CSP·시크릿 경계 재검증 필요.
- **모바일 네이티브**: 앱 내부 진짜 렌더 불가 — 기대치 관리 필요.

---

## 10. 최종 판단

요청 아키텍처는 **이 레포에서 현실적으로 구현 가능**하며, 새 런타임이 아니라 **기존 App Factory 파이프라인에 "임베디드 라이브 프리뷰" 레인을 추가**하는 확장이다. 기술 스택(Electron 33 `WebContentsView`, cross-spawn, Playwright/CDP, live-run 방송)은 이미 손에 있다. 가장 큰 비-코드 결정은 "생성 앱을 앱 내부에서 실행해도 되는가(현 정책 뒤집기)"이고, 가장 큰 코드 전제는 "HMR 되는 dev 템플릿"이다.
