# Agentlas Desktop — UI/UX 안정화 플레이북

> Hermes Desktop(`NousResearch/hermes-agent` → `apps/desktop`, MIT)의 UI/UX
> 아키텍처를 분해해 만든 플레이북. **에이전트/모델 로직은 베끼지 않는다 — 레이아웃·
> 네비게이션·섹션·인터랙션·상태처리·스타일 시스템만** 가져온다.
>
> 목적: "내 데스크탑 UI가 자꾸 터지는" 구조적 원인을 제거한다.

---

## 0. 왜 내 UI가 자꾸 터지나 (근본 원인)

터지는 건 디자인 감각 문제가 아니라 **아키텍처 부재** 때문이다. 지금까지 기록된 사고들이
전부 같은 뿌리에서 나온다:

| 기록된 사고 | 뿌리 원인 |
| --- | --- |
| `.rd button{color:inherit}` 특이도로 검정 버튼 글자가 사라짐 | **단일 버튼 primitive 부재** → 전역/광역 셀렉터가 버튼을 덮어씀 (특이도 전쟁) |
| `McpSource` 비배열 응답 → `listings.filter` 크래시 | **데이터 모양을 UI가 가정** → 비정상 응답이 그대로 렌더 경로로 |
| stale `.next` → `PageNotFoundError` | **빌드 산출물 신뢰** → 클린 안 한 캐시가 화면을 죽임 |
| `I18nProvider _ready` 미사용 → 온보딩 깜빡임/검은 화면 | **준비 안 된 상태를 그리는 것** (게이트 없는 렌더) |
| 메뉴 라벨 영어 하드코딩 → `nav.*` 키 신설로 수습 | **문자열이 JSX에 박힘** (i18n 미경유) |
| 진짜 nav는 `SideNav`인데 `TopNavbar`는 죽은 코드 | **네비게이션 단일 소스 부재** → 중복/표류 |

공통 분모는 다섯 가지다 — Hermes는 이 다섯 개를 **설계 규칙으로 못 박아** 안 터진다:

1. concern 하나당 primitive 하나 (버튼/입력/상태가 단일 소스)
2. 리터럴 대신 토큰 (색·그림자·간격을 CSS 변수로)
3. primitive의 padding/size/radius/chrome을 **호출부에서 className으로 덮지 않음**
4. loading/empty/error를 **표준 컴포넌트**로 (raw 렌더 금지)
5. 깨지는 상호작용은 **DOM 회귀 테스트**로 고정

### 0.1 실측 증거 (내 앱 정적 분석)

추정이 아니라 실제 코드에서 확인된 출혈 지점:

- **단일 5,927줄 `globals.css` + Tailwind/모듈 없음 + ~600개 인라인 `style={{}}`**
  (`library/agents/page.tsx` 329개, `firm/detail/page.tsx` 272개). 토큰 우회 → 테마/간격 표류.
- **전역 bare-element 리셋**: `button{background:none;border:none;padding:0}` +
  `button,input,...{color:inherit}` (globals.css 236–250), 그리고 **`.rd` 안에서 또 재선언**
  (407–413) → 조상에 `.rd` 있고 없고에 따라 버튼이 다르게 동작. (검정 버튼 글자 사고의 구조)
- **`.rd` 스코프 포크**: 284개 `.rd ` 셀렉터, 페이지마다 opt-in 제각각(`apps/page.tsx`는 "NOT .rd
  wrapped" 주석). 스타일 분기의 핵.
- **`!important` 29곳** + 고정 드로어 통째 `!important`(2472–2478) → 캐스케이드 전쟁.
- **z-index 무토큰**: CSS 8~288, 인라인 2~**1000**(`oberon/LoadProjectModal.tsx:49`),
  999(`library/agents/page.tsx:863`) → 모달/툴팁/FAB 가림.
- **에러 바운더리 0개, `error.tsx`/`loading.tsx` 0개** → 한 화면 throw가 Next 기본 예외화면으로.
- **렌더 중 데이터 모양 가정**: `marketplace/page.tsx:196` `listings.filter(...)`,
  `Sidebar.tsx:544/606` `data.chats.slice`/`data.projects.slice` 등. 전체에서 `Array.isArray`
  가드는 17곳뿐 → 비배열 IPC 응답이 렌더에서 throw.
- **`return null` 블랭킹**: `chat/page.tsx:144/367/1836`, `library/agents/page.tsx:1436/1499`
  → 로딩/실패 시 스켈레톤이 아니라 빈 화면.
- **static-export + `file://` 하드 내비 → 화면에 RSC 생텍스트**(`lib/navigation.ts:1-13`,
  `next.config.mjs`). stray `<a href>`/`window.location` 하나로 재발.
- **네비 이중화**: `AppShell.tsx:121-134`가 `SideNav`↔`Sidebar`를 라우트로 스왑(분기),
  `TopNavbar.tsx`(204줄)는 죽은 코드.
- 강점 1개: 토큰 시스템은 존재(globals.css 1–212, `data-theme` 다크). 단 **두 토큰 세트
  (`--rd-*` vs `--ink/--paper/...`)를 수동 동기** + spacing/z 스케일 없음 + 인라인 하드값이 우회.

---

## 1. 핵심 아키텍처 12규칙 (Hermes 분해 → 내 앱 적용)

각 규칙: **규칙 → 왜 안 터지나 → Hermes 증거 → 내 앱에서 할 일.**

### R1. 디자인 시스템 문서를 코드 옆에 둔다 (살아있는 계약)
- **왜**: 규칙이 문서로 박히면 "이미 primitive 있는데 또 만들기"가 리뷰에서 걸린다.
- **Hermes**: `apps/desktop/DESIGN.md` — "one source per concern, tokens over
  literals, flat over boxed" + **커밋 전 체크리스트**(primitive 재사용? 토큰만?
  className으로 padding 덮지 않음? 오버레이는 `shadow-nous`+hairline? …).
- **내 앱**: 이 파일이 그 출발점이다. `agentlas_desktop/docs/desktop-ui-playbook.md`를
  PR 템플릿 체크리스트로 연결한다.

### R2. 토큰 2계층 — 절대 raw hex/rgba 금지
- **왜**: 색/그림자를 한 곳에서 바꾸면 전체가 따라온다. 컴포넌트마다 `#fff`/`bg-white`를
  박으면 다크모드·테마에서 반드시 터진다(검정 버튼 글자 사고가 정확히 이거다).
- **Hermes**: `src/styles.css`가 `@theme inline`으로 **시맨틱 토큰**(`--color-primary`,
  `--color-border`…)을 **테마 토큰**(`--dt-*`)에 매핑. 컴포넌트는 `--ui-text-primary`,
  `--ui-stroke-tertiary`, `--chrome-action-hover`, `shadow-nous`, `--stroke-nous`만 참조.
  `bg-gray-*`/`text-black` 금지 (유일 예외: BrandMark 흰 타일).
- **내 앱**: 전역 토큰 파일 하나(`renderer/styles/tokens.css` 류) 만들고 — text 3단계,
  stroke 4단계, bg, accent, 오버레이 그림자 하나. 컴포넌트의 모든 raw 색을 토큰 참조로 치환.

### R3. concern당 primitive 하나 — 특히 `Button`
- **왜**: 버튼이 단일 소스면 전역 셀렉터로 버튼을 "고칠" 이유가 사라진다 →
  `.rd button{color:inherit}` 같은 특이도 핵이 원천 차단된다.
- **Hermes**: `src/components/ui/button.tsx`가 `cva`로 **variant**(default/destructive/
  secondary/outline/ghost/link/text/textStrong)와 **size**(default/xs/sm/lg/inline/micro/
  icon*)를 소유. 호출부는 `variant`+`size`만 넘기고 `h-*`/`px-*`/`py-*`/아이콘 크기를
  **넘기지 않는다**. base에 `cursor-pointer`, focus-ring, `[&_svg]:size-3.5`(아이콘 자동
  크기)까지 박혀 있음.
  > 디테일 하나: `outline` variant가 border가 아니라 **`inset` ring(shadow)** 을 써서
  > "레이아웃이 안 흔들린다"고 주석에 명시 — 호버 시 1px border가 생기며 점프하는 흔한
  > 버그를 구조로 차단.
- **내 앱**: `renderer/components/ui/button.tsx` 단일 버튼을 만들고(cva or 동등),
  나머지 버튼을 전부 마이그레이션. 마이그레이션 끝나면 버튼을 노리는 전역 CSS를 삭제.

### R4. 입력/선택도 공유 shape로
- **Hermes**: `controlVariants`(`src/components/ui/control.ts`)가 Input/Textarea/
  SelectTrigger의 공유 모양. 검색은 `SearchField` 하나(테두리 없는 밑줄형, 빈 목록은
  검색창 자체를 숨김). 소규모 택1은 `SegmentedControl`(라디오 더미·pill 행 대체).
  토글은 `Switch size="xs"`.
- **내 앱**: 입력류 primitive를 1개 shape로 통일. "boxed 검색바"를 새로 만들지 않는다.

### R5. 레이아웃 거터는 상수 하나로 — 그리고 Tailwind 스캐너 함정 피하기
- **왜**: 페이지마다 `px-6`/`px-8`을 박으면 화면마다 정렬이 어긋난다.
- **Hermes**: `src/app/layout-constants.ts` — `PAGE_INSET_X =
  'px-[clamp(1.25rem,4vw,4rem)]'`(반응형 거터 단일 소스), `PAGE_INSET_NEG_X`(가장자리
  bleed), `SIDEBAR_COLLAPSE_BREAKPOINT_PX = 768`(반응형 접힘 단일 소스).
  > **결정적 함정 주석**: "must stay **literal strings** — Tailwind's scanner only
  > picks up complete class names, so do **not** build them via template
  > interpolation." → 클래스명을 문자열 합성으로 만들면 Tailwind가 못 잡아 **스타일이
  > 통째로 빠진다**(=터진다). 내 앱에서 동적 클래스 합성을 쓰고 있다면 이게 범인일 수 있음.
- **내 앱**: 페이지 좌우 패딩/반응형 breakpoint를 상수 파일 하나로. 동적 Tailwind 클래스
  합성 전수 점검.

### R6. 라우트를 데이터(타입드 테이블)로
- **왜**: 네비가 한 곳에 정의되면 `SideNav`/`TopNavbar` 두 벌이 표류하는 일이 없다.
- **Hermes**: `src/app/routes.ts` — `APP_ROUTES`(id/path/view) 단일 테이블,
  `AppView`/`AppRouteId` 유니언, `RESERVED_PATHS`, 그리고 **OverlayView**(쉘 위에
  전면 모달 카드로 뜨는 뷰) 구분까지 데이터로. nav는 이 테이블을 map해서 그린다.
- **내 앱**: `renderer/app/routes.ts`(또는 동등) 단일 테이블 도입, `SideNav`가 그걸 map.
  죽은 `TopNavbar` 제거. 라벨은 R11(i18n) 경유.

### R7. loading / empty / error를 표준 컴포넌트로
- **왜**: 비정상 응답·로딩 중·빈 목록을 raw로 그리면 화면이 깨지거나 흰/검은 화면이 된다
  (온보딩 깜빡임 사고).
- **Hermes**: `Loader`(리터럴 "Loading…" 금지), `ErrorState`+`ErrorIcon`(React 바운더리·
  in-dialog·부팅 실패 배너가 **한 모양**), `EmptyState`/`EmptyPanel`(손으로 가운데정렬
  금지), `LogView`(raw 로그 표준). a11y 위해 title/description을 노드로 받아 Radix
  DialogTitle/Description에 흘림.
- **내 앱**: 이 4종(Loader/ErrorState/EmptyState/LogView) primitive를 만들고 모든
  데이터 화면에 강제. **렌더 전에 데이터 모양을 가드**(R8).

### R8. 데이터 모양을 절대 가정하지 않는다 (렌더 게이트)
- **왜**: `listings.filter`가 `McpSource` 비배열에서 터진 사고가 정확히 이 위반이다.
- **Hermes**: route root는 "thin", 데이터는 hook이 정규화해서 내려준다(아래 R9).
  렌더 컴포넌트는 항상 정규화된 안전한 shape만 받는다. 준비 안 됐으면 그리지 않음.
- **내 앱**: IPC/네트워크 응답을 받는 즉시 `Array.isArray(x) ? x : []` 식으로 **경계에서
  정규화**. 컴포넌트 본문에서 `.filter/.map` 전에 가드. `provider _ready` 같은 플래그를
  쓰고, 준비 전엔 `Loader`를 그린다.

### R9. 상태는 nanostore 원자 + 좁은 액션 훅 (god-hook/prop-drilling 금지)
- **왜**: 거대한 한 훅/깊은 prop 드릴링은 한 군데 고치면 다른 데가 터진다.
- **Hermes**: 공유 상태는 **nanostores**(피처별 atom, 공유는 `src/store`). 렌더는
  `useStore`로 구독, 비렌더 액션은 `$atom.get()`. **콜로케이트된 액션 모듈 > god hook.
  한 훅은 한 가지 일만.** route root는 얇게. 영속화는 atom 옆에.
  > 증거: chat이 `composer/`(use-composer-submit/queue/draft/voice… 잘게 분리),
  > `sidebar/`, `right-rail/`, `session/hooks/use-message-stream/`처럼 **한 파일 = 한 책임**.
- **내 앱**: 거대한 페이지 컴포넌트/만능 훅을 좁은 훅 + atom으로 분해. (내 앱은 zustand/
  context를 쓰는데 — 핵심은 "한 훅 한 책임 + route root 얇게"이지 라이브러리 교체가 아님.)

### R10. 오버레이/다이얼로그는 공유 쉘로, Esc로 닫힌다
- **왜**: 오버레이마다 타이틀바/그림자/테두리를 새로 만들면 z-index·정렬이 어긋난다.
- **Hermes**: `OverlaySplitLayout` + `OverlaySidebar`/`OverlayMain` + `overlay-chrome`
  (cron/profiles 등이 공유). 모든 dismissable 오버레이는 **`Esc`로 닫힘**, 닫기는
  "Close" 글자가 아니라 **x 아이콘**. 오버레이가 열리면 타이틀바 컨트롤이 숨도록 라우트
  레벨에서 중앙 관리(`use-route-overlay-active`).
- **내 앱**: 모달/드로어용 공유 레이아웃 1개. 오버레이별 그림자/테두리 one-off 제거 →
  토큰(`shadow-nous`+hairline 등가물). Esc-to-close 전역 처리.

### R11. 모든 문자열은 i18n 경유 — 네 로케일 동시 갱신
- **왜**: JSX에 문자열을 박으면 라벨 영어 하드코딩 사고처럼 반드시 표류한다.
- **Hermes**: 모든 사용자 문자열은 `useI18n()`(`src/i18n/context.tsx`). 새/변경 문자열은
  `en/ja/zh/zh-hant`를 **함께** 갱신 — 하나라도 빠지면 회귀로 간주(문장부호·톤 drift).
- **내 앱**: `nav.*` 외에도 전 화면 문자열을 `t()` 경유로. 한국어/영어 등 로케일을
  한 PR에서 같이. JSX 리터럴 린트 룰 추가 고려.

### R12. 깨지는 상호작용은 측정하고 회귀 테스트로 고정
- **왜**: "스크롤 점프, 타이핑 랙, Enter 전송 레이스, IME 조합, 슬래시 네비"는 눈으로는
  안 잡힌다. Hermes는 이걸 **측정·재현 테스트**로 박제한다.
- **Hermes**: `scripts/diag-jump.mjs`, `diag-scroll-reset.mjs`, `measure-jump.mjs`,
  `leak-typing.mjs`, `profile-typing.mjs`, `chat/perf-probe.tsx` +
  `enter-submit-dom-race.test.tsx`, `ime-composition-dom-repro.test.tsx`,
  `slash-nav-dom-repro.test.tsx` 등 **DOM 재현 테스트**. 거의 모든 모듈에 `.test` 동봉.
- **내 앱**: 가장 자주 터지는 상호작용 3개부터 DOM 재현 테스트를 쓴다. 부팅/라우팅/빈
  목록/비정상 응답을 스모크로 묶는다.

---

## 2. 한눈 비교

| 축 | Hermes Desktop | 내 앱(현재 추정) | 위험 |
| --- | --- | --- | --- |
| 디자인 문서 | `DESIGN.md` + 체크리스트 | 없음 | 표류 |
| 토큰 | 2계층 CSS 변수 | raw hex/`bg-white` 혼재 | 다크/테마 깨짐 |
| 버튼 | 단일 `cva` primitive | 제각각 + 전역 셀렉터 핵 | 특이도 전쟁 |
| 거터/breakpoint | 상수 1곳(+스캐너 주석) | 페이지별 하드코딩 | 정렬 어긋남/스타일 누락 |
| 라우트 | 타입드 테이블 | SideNav/TopNavbar 이중 | 죽은 코드/표류 |
| 상태 컴포넌트 | Loader/Error/Empty/Log 표준 | raw 렌더 | 흰/검은 화면, 크래시 |
| 데이터 가드 | 경계 정규화 | `.filter` 직접 | 런타임 크래시 |
| 상태관리 | atom + 좁은 훅 | 큰 컴포넌트/만능 훅 | 연쇄 파손 |
| 오버레이 | 공유 쉘 + Esc | one-off | z-index/정렬 |
| i18n | 전량 경유, 4로케일 동기 | 부분 하드코딩 | 라벨 표류 |
| 회귀 테스트 | DOM repro + 측정 스크립트 | 부족 | 상호작용 재발 |

---

## 3. 도입 순서 (가장 큰 출혈부터)

1. **R8 데이터 가드 + R7 표준 상태**: 크래시·흰화면을 즉시 멈춘다 (최우선, 가장 자주 터짐).
2. **R2 토큰 + R3 단일 Button**: 색/버튼 사고의 뿌리 제거. 끝나면 버튼 노리는 전역 CSS 삭제.
3. **R5 레이아웃 상수 + 동적 Tailwind 클래스 점검**: 스타일 통째 누락 함정 제거.
4. **R6 라우트 테이블 + 죽은 TopNavbar 제거**, **R10 오버레이 공유 쉘**.
5. **R9 상태/훅 분해**, **R11 i18n 전수**, **R12 회귀 테스트** (지속 부채 상환).

---

## 4. 커밋 전 체크리스트 (Hermes 체크리스트 한국어판)

- [ ] primitive 재사용했나? (`Button`/`SearchField`/`SegmentedControl`/`Loader`/`ErrorState`/`EmptyState`) 새로 포크 안 함?
- [ ] 토큰만 썼나? raw hex/`bg-white`/one-off 그림자 0?
- [ ] primitive의 padding/size/radius/chrome을 className으로 덮지 않았나?
- [ ] 데이터 렌더 전 shape 가드(`Array.isArray`/`_ready`)했나? 비정상 응답에 Error/Empty 상태?
- [ ] 페이지 거터/breakpoint를 상수로? 동적 Tailwind 클래스 합성 없음?
- [ ] 라우트는 테이블 경유? 죽은 nav 없음?
- [ ] 오버레이는 공유 쉘 + Esc로 닫힘 + x 아이콘?
- [ ] 모든 문자열 `t()` 경유 + 모든 로케일 함께 갱신?
- [ ] 잘 터지는 상호작용에 DOM 재현 테스트 추가?

---

# Part B — 인프라 / IPC 이벤트 계층 (통신이 터지는 곳)

시각 UI만이 아니라 **main↔renderer 이벤트 통신**도 같은 식으로 터진다. 뿌리는 동일하다:
*상태를 가정하고, 순서를 가정하고, 단일 진실원천과 재조정하지 않는다.*

## 케이스 스터디 — `final` 유실 레이스 (확정)

**증상**: 간단한 작업이 끝나도 busy가 영구 stuck, 타이머 계속. 재진입하면 결과가 보임.

**메커니즘** (코드 확인):
1. `electron/ipc.ts:1289` — main이 `runId = randomUUID()`를 **생성**(렌더러는 모름).
2. `ipc.ts:1299` — `void runMcpInvocation(...)`를 **await 없이** 시작, `:1319`
   `win.webContents.send(channel, ev)`로 이벤트 즉시 발사.
3. `chat/page.tsx:1209` — 렌더러는 `await api.invoke.run(...)`로 **runId를 받은 뒤**,
   `:1229`에서야 `subscribeRun(runId)`로 채널 구독.
4. 빠른 작업 → main의 `final`(`:1319`)이 렌더러 구독(`:1229`)보다 **먼저 발사** → 리스너
   없음 → **final 유실** → busy 안 풀림.
5. `ipc.ts:1322-1324` — 게다가 `final`/`error` 시 `activeRuns.delete(runId)`로 **재접속
   버퍼(`record.events`)를 즉시 폐기** → `invoke:attach`(chatId 기준)도 못 살림. DB엔 final
   직전 영속화돼 있어 재진입 시에만 보임.

이건 **subscribe-after-trigger(트리거 후 구독)** 레이스의 교과서 사례다.

### 권장 수정

**1차 — 상관관계 ID를 렌더러가 만들고, 트리거 전에 구독한다.**
runId 생성을 렌더러로 옮기면 구조적으로 레이스가 사라진다.

```ts
// renderer chat/page.tsx — invoke 전에 구독
const runId = crypto.randomUUID();
subscribeRun(runId, placeholderId);            // ① 리스너 먼저
runIdRef.current = runId;
try {
  await api.invoke.run({ runId, chatId: chat.id, userPrompt, /* … */ });  // ② runId 주입
} catch (err) { subRef.current?.(); subRef.current = null; /* busy 해제 */ }
```
```ts
// electron/ipc.ts — 제공된 runId 수용(없으면 생성)
ipcMain.handle("invoke:run", async (event, req) => {
  const runId = req.runId ?? randomUUID();      // ← 변경점
  // …나머지 동일…
  return { runId };
});
```
구독이 `invoke:run` 호출 *전에* 끝나므로 main이 아무리 빨리 emit해도 잡힌다. 기존
cancel-before-runId 핸들링(`:1230-1233`)도 runId가 처음부터 있어 단순해진다.

**2차(방어) — 종료 이벤트 래치 + 구독 시 재조정.** 재접속/재연결까지 막으려면, 끝난 run의
**terminal 이벤트를 짧게 보존**하고(즉시 delete 대신 `done` 마킹), `subscribeRun`이 붙는
즉시 버퍼를 **리플레이**하거나 main/DB의 현재 상태를 **재조정**한다. 중복 렌더(1322 주석의
이유)는 "chatId 기준 attach=과거 히스토리"와 "runId 기준 구독=내가 방금 시작한 run"을 구분하면
없앨 수 있다(후자는 placeholder로 시작했으므로 히스토리 행과 충돌하지 않음).

## 인프라 규칙 (R13–R17)

### R13. 상관관계 ID는 호출자가 만들고, 트리거 전에 구독한다
- subscribe-before-trigger. ID를 콜백 응답에서 받지 말 것(받는 순간 레이스).
- **Hermes**: 스트리밍이 `session/hooks/use-message-stream/`(`index`/`gateway-event`/`utils`)로
  격리, `enter-submit-dom-race.test.tsx`로 **레이스 자체를 테스트**.

### R14. 이벤트는 per-run 버퍼 + 구독 시 리플레이/재조정
- emit은 휘발성이다. 구독 전에 발사된 건 **버퍼에서 catch-up**하거나 진실원천과 재조정.
- 내 앱엔 `record.events` 버퍼가 *이미 있다* — 단 final에서 폐기돼 무력화. 보존+리플레이로 살린다.
- **Hermes**: `use-route-resume.ts`, `use-session-state-cache.ts` = resume/재조정 패턴.

### R15. 종료는 멱등이고 항상 도달 보장 (watchdog)
- busy 해제를 단일 `final` 이벤트에만 의존하지 말 것. **타임아웃 watchdog**으로 "N초 내 종료
  이벤트 없으면 DB/상태 재조회 후 강제 해제". final이 두 번 와도 멱등.
- 내 앱: busy 타이머가 영원히 도는 건 이 안전망이 없어서다.

### R16. 채널/리스너 생명주기 — 구독 해제·전환 정리
- 채팅 전환·언마운트 시 `subRef.current?.()`로 해제(내 앱 `chat/page.tsx:809/823`은 잘 함).
  규칙으로 못 박아 새 구독마다 이전 것을 끊는다(좀비 리스너=유령 이벤트).

### R17. 단일 진실원천(main/DB) + UI는 그 투영
- main이 저장 → 렌더러는 그걸 **재조정**해서 그린다. "재진입하면 보인다"는 건 진실원천은
  맞는데 라이브 경로만 깨졌다는 신호. 라이브 경로 실패 시 항상 진실원천으로 폴백.

## 인프라 체크리스트 (커밋 전)

- [ ] 이벤트 구독을 **트리거 전에** 했나? (상관관계 ID를 응답에서 받지 않음)
- [ ] 구독 전 발사 이벤트를 버퍼 리플레이/재조정으로 catch-up?
- [ ] busy/로딩 해제에 **watchdog 타임아웃**이 있나? 종료 이벤트는 멱등?
- [ ] 라이브 경로 실패 시 DB/진실원천으로 폴백?
- [ ] 채팅 전환/언마운트에서 리스너 해제(좀비 구독 없음)?

---

## 출처

- Hermes 코드: `github.com/NousResearch/hermes-agent` → `apps/desktop/`
  (`DESIGN.md`, `src/components/ui/button.tsx`, `src/app/routes.ts`,
  `src/app/layout-constants.ts`, `src/styles.css`, `src/app/overlays/*`,
  `scripts/diag-*.mjs`, `*-dom-repro.test.tsx`)
- 문서: https://hermes-agent.nousresearch.com/docs/user-guide/desktop
