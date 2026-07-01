<!-- 자동 생성: automation-workflow-design 워크플로우(에이전트 7, 2026-07-01) 통합 산출. 상세 리서치 원본은 scratchpad auto-{scheduling,conditions,builder,curauto,palette,graphui}.md -->

# Agentlas Desktop 자동화 재설계 — 스케줄 · 조건 트리거 · 비주얼 워크플로우 빌더

리드 아키텍트 설계 문서. 모든 주장은 검증된 코드 `file:line`에 근거하며, 근거 없는 API·라이브러리는 도입하지 않는다.

---

## 1. 현재 상태 & 무엇이 부족한가

### 1.1 지금 있는 것 (감사 결과)

오늘의 자동화는 **시간 전용, 인프로세스, 폼 기반** 시스템이다.

- **스케줄 문법**: 하이픈 구분 문자열 하나를 위치 기반으로 파싱 (`electron/store/automations.ts:42-91`). 지원 종류 6개뿐 — `hourly`, `every-Nm/h`, `daily-HH:MM`, `weekday-HH:MM`, `weekly-<dow>-HH:MM`, `monthly-<day>-HH:MM`. 나머지는 전부 `from + 24h` 폴백.
- **세 층위의 문법 불일치**: 코드는 6종을 받지만, LLM 에미터는 4종만 광고하고 (`electron/automation-emitter.ts:8-9,23`), UI 폼은 **하드코딩 프리셋 4개**만 노출한다 (`renderer/app/(shell)/automation/new/page.tsx:17-22`). `hourly`/`every`/09:00 아닌 시각/월요일 아닌 요일은 UI로 도달 불가.
- **체크 주기**: 인프로세스 `setInterval(tick, 60_000)` (`electron/automation-scheduler.ts:87`), `unref()` 처리됨 (`:88`), `main.ts:268`에서 1회 기동.
- **저장 단위**: SQLite `automations` 테이블, 스키마 v32, `schedule` 문자열 컬럼 하나. `trigger_type` 필드 없음 (`shared/types.ts:552-570`).
- **챗 → 자동화**: 비-`division` 챗에 `AUTOMATION_PROTOCOL` 주입 (`client.ts:993`) → 모델이 `## Automation` JSON 블록 방출 → `parseAutomations` (`automation-emitter.ts:29-64`) → `createAutomation`. **확인 단계 없이 즉시 enabled로 생성** (`client.ts:1124-1136`).
- **실행**: due 항목이 `runOne`에서 백그라운드 `division` 챗을 통해 `runMcpInvocation`으로 실행 (`automation-scheduler.ts:38-68`), sink은 no-op (`:49-51`).

### 1.2 "60초 타이머가 낭비"라는 오해 — 정정

**60초 체크 자체는 낭비가 아니다.** 정확히 정량화하면:

- 틱 1회는 인덱스된 SQLite 쿼리 하나다. `dueAutomations`는 `SELECT * FROM automations WHERE enabled=1 AND next_run_at<=?`를 `idx_automations_due(enabled, next_run_at)` 인덱스로 실행한다 (`db.ts:344`, `automations.ts:161-164`).
- better-sqlite3는 동기·인프로세스(네트워크·IPC 없음). 수천 개 자동화까지도 **서브밀리초 B-트리 범위 스캔**. 하루 비용 = 1,440회 인덱스 프로브 = 사실상 0. 게다가 타이머는 `unref()`라 앱을 붙잡지도 않는다 (`:88`).
- 자동화 한 개가 **실제로 실행**되면 CLI/LLM 프로세스가 스폰된다 — 그 비용이 60초 스캔 1,440회를 다 합친 것보다 수십~수백 배 크다. 폴링은 병목이 아니다.

**60초 폴링이 유일하게 지불하는 비용은 정밀도(latency)뿐이다.** 잡이 최대 ~60초 늦게 뜨고, 분 이하 스케줄이 불가능하다 (`every-1m`이 폴에 반올림). 이건 정밀도 한계지 자원 한계가 아니다. 필요하면 폴을 빠르게 하지 말고, 스캔 후 가장 가까운 `next_run_at`으로 `setTimeout`을 self-adjusting하면 된다 — 하지만 이건 리파인먼트지 아무도 겪는 문제의 해결이 아니다.

### 1.3 진짜 한계 4가지

폴링 빈도와 무관한, 손대야 할 실제 갭:

1. **스케줄 문법의 빈곤** — cron 없음, ~6개 고정 패턴, 인터벌이 정렬 대신 드리프트(`every-30m`가 :00/:30에 안 붙고 실행시각 기준 상대), 타임존/DST 정책 없음, end-date/run-N 없음 (`automations.ts:42-91,47,57`).
2. **앱이 켜져 있어야 함** — OS 영속성 없음. 파일 헤더가 명시: *"M1: 인프로세스 타이머. 앱이 꺼져 있으면 안 돎"* (`automation-scheduler.ts:3`). **이게 가장 큰 갭.** (뉘앙스: macOS는 `window-all-closed`에서 종료하지 않아 (`main.ts:221-223`) 창을 닫아도 dock에 살아 스케줄러가 계속 돈다. 진짜로 죽는 건 `Cmd+Q`/재부팅/크래시.)
3. **조건 트리거 부재** — 시스템 전체가 시간 전용. 스키마에 `trigger_type`조차 없어 "파일 변경 시", "webhook 수신 시", "가격 > X"가 **아키텍처상 부재**이지 미구현이 아니다 (`shared/types.ts:552-570`).
4. **시각화·편집 부재** — 그래프 라이브러리 0개 설치. 모든 "그래프/조직도/파이프라인" 표면(`OrgTree.tsx`, `PipelineMap.tsx`, Information Flow Mapper)은 손으로 만든 flexbox 리스트로, 2D 캔버스·노드 위치·엣지 라우팅·drag-connect가 전무하다. 상세 페이지는 view+toggle+delete 뿐이라 편집하려면 삭제 후 재생성해야 한다 (`detail/page.tsx:70-92`). `nextRunAt`은 계산·저장되지만 UI에 표시조차 안 된다.

부차 한계: 놓친 실행이 조용히 1회로 병합(N개 손실, `automations.ts:152-157`), 타임존 없음, 무한 실패 루프(에러 삼키고 재스케줄, `:57-65`), 결과 미표출(숨은 division 챗에만), 모델 생성 자동화 무확인, `{{변수}}` 치환 없음(`promptTemplate` 이름값 못함, `:48`).

---

## 2. 스케줄 트리거 재설계

### 2.1 핵심: 저장 문자열 = 문법 = 표시를 분리

오늘의 실수는 **저장된 문자열이 곧 문법이자 표시**라는 점이다. 세 개를 나눈다. 내부 진실을 discriminated union 하나로 두고, 모든 저작 경로(프리셋·cron·시간피커·챗 NL)가 이걸로 컴파일된다.

```ts
// shared/types.ts — 신규
type ScheduleSpec =
  | { kind: "cron"; expr: string; tz: string }                        // "*/15 * * * *"
  | { kind: "interval"; everyMs: number; anchor: "wallclock" | "lastRun" }
  | { kind: "once"; atIso: string }                                   // 신규: 1회 실행
  | { kind: "manual" };                                               // 트리거 전용, 시계 없음
```

**프리셋은 별도 kind가 아니라 라벨 붙은 cron이다:**

| 프리셋 (UI) | 컴파일 결과 |
|---|---|
| 매일 09:00 | `cron "0 9 * * *"` |
| 평일 09:00 | `cron "0 9 * * 1-5"` |
| 매주 월 10:00 | `cron "0 10 * * 1"` |
| 매월 1일 09:00 | `cron "0 9 1 * *"` |
| 15분마다 (정렬) | `interval` wallclock |
| 매시 | `cron "0 * * * *"` |

`interval`을 별도 kind로 유지하는 정직한 이유 둘: (a) cron은 "90분마다"·"45초마다"를 깔끔히 표현 못하고, (b) **wall-clock 정렬**(`*/15`→:00/:15)과 **last-run 드리프트**(오늘 유일한 동작) 중 사용자 선택을 보존해야 한다. `anchor`를 명시화하는 것이 한계 #1(드리프트)의 수정이다.

### 2.2 라이브러리 추천: **croner** (검증됨)

현재 설치 의존성은 `@google/genai, @modelcontextprotocol/sdk, better-sqlite3, cross-spawn, electron-updater, keytar, zod`뿐 — cron/date 라이브러리는 없다.

| | **croner** ✅ | cron-parser | node-cron |
|---|---|---|---|
| 정체 | next-run **계산** | cron 필드 **이터레이터** | 인프로세스 **러너** |
| next-run API | `new Cron(expr,{timezone}).nextRun(from)` → `Date` | `parseExpression().next()` | ❌ 없음(콜백만) |
| TZ/DST | ✅ 내장 IANA + DST(대표 기능) | ✅ (내부 luxon) | ⚠️ 약함 |
| 의존성 | **zero deps** | luxon 끌어옴 | 자체 |
| "계산만, 실행 안 함" 적합 | ✅ 자체 틱 유지 가능 | ✅ | ❌ 내부 타이머와 충돌 |

**croner를 선택한다.** 이유: (1) 순수 `nextRun(from)` 계산을 **기존 틱 루프 안에서** 자기 스케줄러 채택 없이 쓸 수 있고, (2) 손대면 안 되는 IANA 타임존+DST 수학을 정확히 처리한다. **zero transitive deps**라 의도적으로 미니멀한 루트 트리에 맞다. cron-parser는 luxon을 끌어와 무겁고, node-cron은 러너라 이미 소유한 wake 메커니즘(§2.4)과 충돌한다.

**루트 `package.json`에만** `croner` 1개 추가. `renderer/package.json`에는 넣지 않는다(React 트리 깨짐). UI의 cron 검증도 같은 croner 생성자를 메인 프로세스에서 IPC로 호출 — 렌더러는 croner를 import하지 않는다.

### 2.3 next-run 계산 (computeNextRun 교체)

```ts
// electron/store/schedule.ts — 신규
import { Cron } from "croner";
export function nextRun(spec: ScheduleSpec, from = new Date()): string | null {
  switch (spec.kind) {
    case "cron": {
      const next = new Cron(spec.expr, { timezone: spec.tz }).nextRun(from);
      return next ? next.toISOString() : null;        // null = 미래 발생 없음
    }
    case "interval":
      if (spec.anchor === "wallclock") {
        const a = Math.ceil((from.getTime() + 1) / spec.everyMs) * spec.everyMs;
        return new Date(a).toISOString();             // 그리드 정렬
      }
      return new Date(from.getTime() + spec.everyMs).toISOString();  // 드리프트(레거시)
    case "once":
      return Date.parse(spec.atIso) > from.getTime() ? spec.atIso : null;
    case "manual": return null;
  }
}
```

두 가지 정확성 개선: **wall-clock 정렬**(한계 #1 드리프트 수정)과 진짜 **`null` 종료 상태** — `once`가 실행됐거나 cron이 미래 매치 없으면 `null` 반환 → 스케줄러가 auto-disable. 오늘의 "`finally`에서 무조건 전진"(깨진 잡을 영원히 재스케줄)을 대체한다. `end_at`/`max_runs` 컬럼을 추가해 "N회 실행"·"~까지"를 표현 가능하게 한다.

### 2.4 타임존/DST — 추론 말고 저장

오늘은 `Date.setHours`로 호스트 로컬존에서 해석, 저장된 tz 없음 (`automations.ts:65-66`). `timezone TEXT` 컬럼(IANA, 예 `Asia/Seoul`) 추가, 생성 시 `Intl.DateTimeFormat().resolvedOptions().timeZone` 기본값. croner에 넘기면 `0 9 * * *`가 DST 전환 넘어서도 **그 존의 09:00**을 뜻한다. **이 부분만은 절대 직접 구현하지 않는다** — croner를 추천하는 이유다.

### 2.5 챗 자연어 → 스케줄

에미터 계약(`automation-emitter.ts:14-27`)을 업그레이드해 모델이 **구조화된 스케줄 필드**를 방출하게 한다(자주 틀리는 손조립 토큰 대신):

```json
{ "name":"...", "prompt":"...",
  "schedule": { "preset":"daily", "time":"09:00", "tz":"Asia/Seoul" } }
// 불규칙하면:
{ "schedule": { "cron":"*/30 9-18 * * 1-5", "tz":"Asia/Seoul" } }
```

`parseAutomations`는: `cron` 있으면 croner로 검증하고 **파싱 실패 시 표면화**(오늘처럼 조용히 드롭하지 않음, `automation-emitter.ts:51-53`), 없으면 `preset`+`time`→cron 매핑. **모든 모델 생성 cron을 insert 전 검증**해 한계 #11의 절반(가짜 스케줄)을 막고, §5의 확인 단계와 짝지운다.

### 2.6 앱 꺼져도 도는 launchd (검증된 macOS 동작)

**LaunchAgent**는 `~/Library/LaunchAgents/`의 per-user plist로 launchd가 소유하며 재부팅을 넘어 GUI 없이 돈다. macOS의 올바른 프리미티브(cron은 Apple이 deprecate, 로그인 아이템 아님).

**권장 형태: 자동화별 cron을 plist로 미러링하지 말고, 헤드리스 러너를 coarse 인터벌로 poke하는 LaunchAgent 하나** + DB가 스케줄 권위. N개 plist 동기화보다 훨씬 단순하다.

```xml
<!-- ~/Library/LaunchAgents/ai.agentlas.automations.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>ai.agentlas.automations</string>
  <key>ProgramArguments</key><array>
     <string>/Applications/Agentlas.app/Contents/MacOS/Agentlas</string>
     <string>--headless-automations</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict></plist>
```

사용자가 "앱 꺼져도 실행" 토글을 **opt-in**할 때 `launchctl bootstrap gui/$(id -u) <plist>`로 설치, 해제 시 `launchctl bootout`. 영속성은 의미 있는 escalation이므로 기본값 아닌 동의 대상. macOS 게이트, Win/Linux는 후속.

**헤드리스 러너**: 풀 Electron 창 불필요. 권장 = **패키지된 Electron 바이너리를 `--headless-automations` 플래그로 재사용**. `main.ts`의 `whenReady` 최상단에서 플래그 있으면 `createWindow()` 건너뛰고 `initStore()` → `runDueAutomationsNow()` 1회 → `app.quit()`. 자동화 러너는 이미 렌더러를 안 건드리므로(sink no-op, `automation-scheduler.ts:49-51`) 엔진 전체를 그대로 재사용. (순수 Node 진입도 가능하나 `db.ts:17`의 `app.getPath` 때문에 `AGENTLAS_STORE_PATH` override로 추상화가 필요 — 헤드리스-Electron 메모리가 문제될 때만.)

**단일 라이터 안전장치**: LaunchAgent 러너와 열린 GUI가 같은 SQLite를 공유. WAL은 이미 켜짐 (`db.ts:19`)이나 같은 due 행의 **이중 실행**을 막아야 한다. 인메모리 `running` Set (`automation-scheduler.ts:11`)은 프로세스 간에 안 통하므로 DB 리스로 대체: `claimed_at`/`lease_owner` 컬럼 + 원자적 `UPDATE ... WHERE id=? AND (claimed_at IS NULL OR claimed_at < ?)`. 행을 잡은 쪽이 실행.

### 2.7 놓친 실행 catch-up — 사고가 아니라 정책으로

오늘은 N개 놓친 발생이 조용히 1개로 병합된다(`markAutomationRun`이 실제 실행시각으로 재앵커+미래로 점프, `automations.ts:152-157`). 합리적 **기본값**이지만 per-automation **misfire 정책**이어야 하고, 스킵은 **기록**돼야 한다:

| 정책 | 다운타임 후 앱 열릴 때 | 적합 |
|---|---|---|
| **coalesce** (기본, =오늘) | 1회 발사, 다음 미래 슬롯으로 점프 | "아침 요약" — 최신만 필요 |
| **skip** | 놓친 것 발사 안 함, 다음 슬롯 대기 | 엄격 신선 작업 |
| **backfill(k)** | 놓친 것 최대 k회 발사(레인 스로틀) | 각 발생이 의미 있는 누적 작업 |

구현: `let t=lastRun; while((t=cron.nextRun(t)) && t<=now) missed.push(t);`. coalesce는 1회 실행 후 `next_run_at = cron.nextRun(now)`. backfill은 `missed.slice(-k)` 큐잉하되 기존 `MAX_CONCURRENT_AUTOMATIONS` 레인(`automation-scheduler.ts:16-18`)으로 스로틀하고 k 상한. 어느 쪽이든 **`run_history` 행 기록**(`{automationId, scheduledFor, ranAt, status, skipped}`)으로 "앱 꺼진 동안 6회 스킵됨"을 가시화 — 한계 #2/#10의 silent 손실 제거.

---

## 3. 조건 트리거

### 3.1 "감시=자원낭비?"에 대한 정직한 답

**대부분 낭비 아니다. 단 "감시 방식"에 따라 갈린다.** 트리거는 물리적으로 두 종류뿐:

- **EVENT-DRIVEN (푸시)**: OS/외부가 나에게 알림을 밀어줌. 나는 잠들어 있다 깨어남. 유휴 비용 ≈ 0.
- **POLLING (당김)**: "변했냐?"를 내가 주기적으로 물음. 대부분 응답이 "안 변함". 비용 = 빈도 × 호출단가. **낭비가 생기는 유일한 자리.**

사용자 걱정은 이 둘을 뭉뚱그린 데서 나온다. 숫자로 못 박으면:

| 감시 방식 | 유휴 CPU | 메모리/트리거 | 조건 100개 유휴 | 비쌈? |
|---|---|---|---|---|
| **FSEvents 파일 감시** | **0%** (커널 푸시) | 수십 KB | 반올림 0 | **안 비쌈** |
| **내부 완료 이벤트** | **0%** | ~0 (EventEmitter 공유) | 0 | **안 비쌈** |
| **webhook 리스너** | **0%** (요청 시만) | 소켓 1개 공유 | ~0 | **안 비쌈** |
| **폴링 5분** | 무시 가능 | ~0 | 하루 28,800 API콜 | **경계** — 단가 따라 |
| **폴링 30초** | 낭비 | ~0 | 하루 288,000 API콜 | **비쌈(안티패턴)** |
| **자동화당 프로세스 1개** | ×100 오버헤드 | **수십 MB×100=수 GB** | 램 폭발 | **절대 금지** |

**결론**: 파일/이벤트/내부/webhook 감시 → 아무리 켜도 유휴 0. 외부 API 폴링만 비용이 있고 그것도 "빈도"가 전부 — 적응형 백오프로 유휴 시 간격을 늘리면 100개도 무해. **진짜 낭비는 오직 짧은 고정 간격 폴링과 트리거당 프로세스 스폰 두 안티패턴뿐**, 둘 다 설계로 차단. 게다가 agentlas는 인프로세스라 **앱 꺼지면 감시도 전부 멈춤** (`automation-scheduler.ts:3`) — "밤새 갉아먹는 데몬" 시나리오가 아키텍처상 불가능(지금은 단점이지만 자원 관점에선 장점).

Make/n8n/Zapier도 정확히 같은 이분법을 쓴다: Instant(webhook 푸시, 무료)와 Scheduled(폴링, 요금제로 15분~1분 차등). **폴링 간격이 곧 요금 차등**이라는 건 업계도 "폴링=실제 원가"임을 인정한 것. 이들은 폴링을 자동화별 프로세스로 안 돌리고 중앙 스케줄러가 due한 것만 깨우며, **dedup 커서**로 같은 이벤트 중복 발사를 막는다.

### 3.2 event vs polling 분류표

| 트리거 | 가족 | 진짜 원가 | 근거/비고 |
|---|---|---|---|
| **파일/폴더 변경** | 이벤트(OS) | 거의 공짜, watcher당 수십 KB | Node `fs.watch`가 macOS FSEvents 백킹. **현재 부재**(grep 0건) — 신규 도입 |
| **다른 자동화 완료 시** | 이벤트(내부 버스) | 완전 공짜 | `runOne` finally(`automation-scheduler.ts:59-65`)에 `emit`만 추가 |
| **인바운드 webhook** | 이벤트(푸시) | 유휴 거의 공짜 | 로컬 HTTP 리스너 선례 있음 (`auth.ts:282`, `studio.ts:224`). 데스크톱은 공인 URL 없어 터널 필요 |
| **git/CI 이벤트** | webhook 이상적, 현실 폴링 | webhook면 공짜 | catalog `github` (`catalog.ts:77`) MCP 폴링 |
| **가격/지표 임계값** | **폴링 강제** | **유일 실질 비용** = 간격 × 호출 | 세션 stock/alphavantage MCP(`GLOBAL_QUOTE`, `RSI`)가 정확히 이 소스. 적응형 필수 |
| **Slack/Notion 새 항목** | 혼합 | webhook 있으면 공짜, MCP 경유는 폴링 | catalog `slack`·`notion` (`catalog.ts:14,149`) |

### 3.3 자원 존중형 설계

원칙: **이벤트 > webhook > FSEvents 최대 활용, 폴링은 어쩔 수 없을 때만, 그것도 단일 공유 스케줄러 + 트리거별 적응형 간격.** 금지: (a) busy loop, (b) 자동화당 watcher-프로세스.

```
┌── 단일 공유 트리거 매니저 (인프로세스, unref'd) ──────────────┐
│ [이벤트 소스]                      [폴링 소스]                  │
│  fs.watch 1개/경로 → debounce      기존 60s 틱 재사용            │
│  EventEmitter (자동화 완료)         due한 폴링만 검사             │
│  http 리스너 1개 (auth.ts 패턴)     nextPollAt + 적응형 간격     │
│         모두 → 같은 조건 평가기 → 참이면 기존 runMcpInvocation   │
└────────────────────────────────────────────────────────────────┘
      (앱 켜졌을 때만 — 꺼지면 전부 정지, 오히려 안전장치)
```

- **이벤트 소스는 리스너 1개씩만.** FSEvents는 경로당 1개(자동화당 X, 같은 폴더는 공유). 내부 완료는 `EventEmitter` 하나. webhook은 소켓 1개.
- **폴링은 새 타이머 안 만듦.** 기존 60초 틱 안에서 "지금 due한 폴링 트리거"만 골라 검사(`dueAutomations` 패턴 재사용).
- **적응형 간격 (핵심 절약)**: 값 안 변하면 지수 백오프(1분→2→5→15→최대 60분), 변하거나 임계 근접하면 다시 조임. 시장 닫힘/야간엔 더 늘림(주가는 `MARKET_STATUS`로 게이팅).
- **dedup 커서**: 오늘은 `markAutomationRun`이 무조건 미래로 재앵커(`automations.ts:152-157`)라 커서 개념이 없음 → 조건 트리거엔 `lastSeenValue`/`lastSeenId` 저장 필요.

### 3.4 먼저 출시할 트리거 (신규 인프라 0)

**Tier 0 — 이번 주에 가능 (의존성 0, 순수 로컬, 비용 0)**

1. **파일/폴더 변경** — Node `fs.watch`(FSEvents). 표준 라이브러리라 의존성 추가 없음. **가장 확실한 이벤트 드리븐.** "이 폴더에 새 파일 → 요약 실행"이 첫 데모로 완벽.
2. **자동화 완료 → 체인** — 내부 `EventEmitter`. `runOne` finally에 `emit(automationId, result)` 한 줄. 완전 공짜.
3. **스케줄 + 조건 게이트(하이브리드)** — 기존 시간 트리거 발사 시 조건 1회 평가, false면 스킵. "매일 9시, 단 미읽음 이슈 있을 때만". 기존 스케줄러 위 얇은 레이어라 리스크 최소.

**Tier 1 — 그다음 (기존 MCP 카탈로그 폴링, 적응형 필수)**: 가격/지표 임계값(stock MCP + `MARKET_STATUS` 게이팅), GitHub 이슈/PR 폴링, Slack/Notion 새 항목 폴링 (전부 lastSeen 커서).

**Tier 2 — 인프라 더 필요**: 인바운드 webhook (`auth.ts:282` 리스너 재사용, 단 데스크톱은 터널/릴레이 필요).

### 3.5 트리거 스키마 확장

```ts
type Trigger =
  | { kind: "schedule"; schedule: string }                          // 기존(시간)
  | { kind: "fs"; path: string; on: "create"|"modify"|"delete"; debounceMs?: number }  // 이벤트, 공짜
  | { kind: "chain"; afterAutomationId: string; onlyIf?: Cond }     // 내부 버스, 공짜
  | { kind: "webhook"; token: string }                             // 이벤트, 리스너 공유
  | { kind: "poll"; source: PollSource; cond: Cond;                // 폴링
      minIntervalMs: number; maxIntervalMs: number;                // 적응형 백오프 경계
      lastSeen?: string };                                         // dedup 커서
```

이벤트 계열(fs/chain/webhook)은 스케줄러가 아니라 **리스너에 등록** → 유휴 0. poll 계열만 60초 틱이 `nextPollAt <= now`로 필터. 평가 참이면 전부 기존 `runMcpInvocation` 경로(`client.ts:571`)로 합류 — **실행 엔진은 손 안 댐**. 트리거는 "언제 fire하나"만 바꾸는 전위 레이어.

---

## 4. 비주얼 워크플로우 빌더

### 4.1 렌더링 기술: React Flow (@xyflow/react), 커스텀 SVG 아님

**추천: `@xyflow/react` (React Flow v12).** SVG 캔버스를 손으로 만들지 않는다. 근거: 그래프 라이브러리 0개 설치, 기존 "그래프" 표면 전부 flexbox 리스트(엣지 라우팅·drag-connect·x/y 없음). React Flow는 노드 위치·베지어 엣지·pan/zoom·drag-connect 핸들·미니맵을 **의존성 1개**로 제공. 커스텀 SVG는 이 전부를 재구현(수 주)하고도 hit-testing/엣지 라우팅이 빠진다.

**이 앱에 맞는 이유**: v12는 client-only 설계 — 렌더러가 Next.js `output:"export"`(정적 export, `file://`)이고 모든 인터랙티브 페이지가 이미 `"use client"`라 마찰 0. React 18.3(루트) 지원.

**설치 + 마운트 (정적 export 제약 충족)**:
1. **루트 `package.json`에만** `"@xyflow/react": "^12"` 1줄. 렌더러 트리에 넣으면 단일 React 트리 깨짐.
2. 신규 클라이언트 라우트 `renderer/app/(shell)/automation/flow/page.tsx`, 첫 줄 `"use client"`, `<ReactFlowProvider>` 래핑.
3. **`file://` 하의 CSS가 유일한 진짜 함정.** `@xyflow/react/dist/style.css`를 `assetPrefix:"./"` 하에서 bare import하면 404 가능. 2단 안전장치: 라우트에서 1회 import하고, **패키지 빌드에서 해석 검증**(`next dev` 아님). 404면 ~8KB 스타일시트를 `reactflow.css`로 복사해 로컬 import(메모리 플레이북 `desktop-ipc-final-race-ui-playbook.md`가 정적-export 에셋 취약성으로 이미 플래그).
4. **MVP엔 `dagre`/`elkjs` 없음.** 오토레이아웃은 결정적 좌→우 컬럼 워크(트리거 x=0, 이후 +280px). 분기 fan-out이 정돈된 라우팅 필요할 때만 나중에 `dagre` 추가(elkjs는 WASM/worker라 `file://` 검증 필요 — 분기 요구 전엔 회피).

### 4.2 데이터 모델: 기존 `automations` 행에 JSON 그래프 컬럼

**핵심 결정: `automations`를 진실의 원천으로 유지, nullable `graph_json` 컬럼 1개만 추가.** MVP엔 신규 필수 테이블 없음. 모든 기존 자동화가 그대로 발사(computeNextRun은 `schedule`, 스케줄러는 `prompt_template` 읽음).

**마이그레이션 (v32→v33), `db.ts`의 idempotent idiom 그대로:**

```ts
// electron/store/db.ts — SCHEMA_VERSION 32 → 33
if (userVersion < 33) {
  const cols = _db.prepare("PRAGMA table_info(automations)").all() as Array<{name:string}>;
  if (!cols.some(c => c.name === "graph_json"))
    _db.exec("ALTER TABLE automations ADD COLUMN graph_json TEXT"); // nullable
}
```

`graph_json = NULL` ⇒ 레거시/단순 자동화(즉석에서 trigger→executor 2노드 그래프 합성). `graph_json` 있음 ⇒ 저장 그래프 렌더/실행. **트리거 노드 스케줄은 여전히 plain `schedule` 컬럼에 미러**돼 기존 스케줄러/computeNextRun이 무손상 — 그래프는 additive이지 fork 아님.

**그래프 스키마 (`graph_json`에 JSON):**

```ts
// shared/types.ts — 신규
interface WorkflowGraph { version: 1; nodes: WorkflowNode[]; edges: WorkflowEdge[]; }
interface WorkflowNode { id: string; type: WorkflowNodeType; position: {x:number;y:number}; config: WorkflowNodeConfig; label?: string; }
type WorkflowNodeType =
  | "trigger"    // schedule | manual | stormbreaker → schedule 미러
  | "agent"      // agent.id | firm.id | agentGroupId | borrowAgents[] | swarm | pipeline
  | "tool"       // MCP catalog id / 커스텀 → buildMcpConfigFile로 컴파일
  | "action"     // surface action.type / appFactory:* / toolFactory:* / hep-call
  | "condition"  // 이전 출력 분기
  | "transform"  // 노드 간 변수 map/extract/format
  | "output";    // Slack post / notification / file write / chat surface
interface WorkflowEdge { id:string; source:string; target:string; sourceHandle?:string; } // "true"|"false"
```

**JSON 컬럼인 이유(정규화 테이블 아님)**: 그래프는 항상 자동화당 전체로 read/write, 노드 단위 cross-automation 쿼리 없음. JSON 블롭이 join 오버헤드 없애고 마이그레이션을 `ALTER TABLE` 1개로 유지. **run_history만은 동반 테이블**(per-run 시계열 쿼리 대상, §5). `Automation` 타입에 `graphJson?` 1필드, IPC `automations:get`/`updateGraph` 추가.

### 4.3 챗 → 그래프 자동 생성

기존 에미터(`automation-emitter.ts:14-27`)를 확장해 `steps[]`를 선택적으로 방출. 옛 3필드 shape는 유효 유지(backward-compat: `steps` 없으면 2노드 합성, `graph_json=NULL`).

**"매일 아침 이메일 요약해서 Slack에" → 구체 매핑:**

```json
## Automation
[{
  "name":"Morning email digest → Slack", "schedule":"daily-08:00",
  "prompt":"Summarize my unread email and post to Slack",
  "steps":[
    {"kind":"trigger","schedule":"daily-08:00"},
    {"kind":"agent","ref":"email-summarizer","prompt":"Summarize my unread email","produces":"summary"},
    {"kind":"tool","catalog":"slack","consumes":"summary","action":"post","params":{"channel":"#daily"}}
  ]
}]
```

모델은 **순서 있는 선형 step 리스트**를 방출(x/y 아님 — 앱이 레이아웃 소유). `parseAutomations` 확장이 이를 `WorkflowGraph`로 변환:
1. **trigger 노드** — `daily-08:00`, 이 값을 plain `schedule` 컬럼에도 기록해 기존 스케줄러가 발사.
2. **agent 노드** — `ref`를 `listInstalledAgents()`(`registry.ts:72`)로 해석, 미매치 시 챗 추론 타겟(`chat.firmId ?? chat.agentId`, `client.ts:1131`)으로 폴백해 dangling 없음. `produces:"summary"`.
3. **tool 노드** — `catalog:"slack"`을 `MCP_TOOL_CATALOG`(`catalog.ts:11`)로 해석. env(`SLACK_BOT_TOKEN`) 미충족이면 노드 생성하되 `needsCredential` 플래그 → "Connect Slack" 배지(기존 `connect-service`/`request-credential` surface action 재사용).

**오토레이아웃(앱측 결정적)**: 위상 순서로 노드 i → `{x: i*280, y:120}`, condition 분기 자식은 `y±90`. 연속 step마다 엣지 1개, `consumes`가 상류 `produces`를 참조하면 엣지에 변수명 스탬프. 검증: 모든 비-트리거 노드는 inbound 엣지 필수, 모든 `consumes`는 상류 `produces` 매치 필수, 미지 `ref`/`catalog`는 드롭 대신 `unresolved`(노랑) 표시.

**무확인 라이브 생성 폐지.** 오늘 모델은 조용히 enabled 자동화를 만든다(`client.ts:1124-1136`). 그래프 경로는 **confirm 단계**를 거친다: emit → parse → 미리보기 캔버스(`enabled=0`) 렌더 → 사용자 "Activate" 클릭. Codex의 list-row 대비 가장 큰 UX 승리이자 한계 #11 수정.

### 4.4 노드 → 실제 실행 바인딩

**모든 노드는 기존 엔진이 이미 실행하는 무언가로 컴파일된다.** 그래프 러너는 `runMcpInvocation`(`client.ts:571`)의 기존 dispatch 테이블 위 얇은 위상 워커 — "branch table = 노드 타입 dispatcher"가 정확히 바인딩 표면.

| 노드 타입 | 바인딩 대상 | 메커니즘 |
|---|---|---|
| trigger(schedule) | 기존 스케줄러 | `schedule` 컬럼 기록, `dueAutomations`/computeNextRun 무변 (`automations.ts:161`) |
| trigger(manual) | `invoke:run` | "Run now" → `McpInvocationRequest` 구성 |
| agent(agent) | 단일 에이전트 경로 (`client.ts:1015`) | `{chatId,userPrompt}` bound to `agent.id` |
| agent(firm) | `runFirmInvocation` (`firm-orchestrator.ts:372`) | `chat.firmId` |
| agent(agent-group) | `runBorrowedTaskForceInvocation` (`client.ts:781`) | `agentGroupId` |
| agent(borrow) | `buildBorrowDirective`/borrowed-task-force (`client.ts:622,849`) | `borrowAgents: string[]` |
| agent(swarm) | `runSwarmInvocation` (`client.ts:825`) | `swarmMode` |
| agent(pipeline) | `buildRecommendedPipelineUserPrompt` (`client.ts:616`) | `pipelineStages` |
| tool | `buildMcpConfigFile()` (`mcp-config.ts:57`) + `agentlas_resolve_plugins` | 인접 agent 노드 런타임 MCP 설정에 컴파일, **직접 호출 안 함** |
| action | surface `action.type`(`surface-emitter.ts:72-96`), appFactory:*, toolFactory:*, hep-call(`commands.ts:85`) | 실행 후 또는 자체 step |
| condition | 인러너 분기 | 변수 평가, `sourceHandle:"true"/"false"` 엣지 선택 |
| transform | 인러너 순수 함수 | 변수 reshape(extract/format/json) |
| output | `output.sink` | Slack post/OS 알림/파일 쓰기/챗 surface |

**결정적 바인딩 사실**: 툴은 러너가 per-call 호출하지 않는다. agent 노드에 인접한 tool 노드는 "이 툴을 그 agent 런타임에 available하게" 의미. 실행 시 러너가 agent 노드로 흐르는 tool 노드들을 모아 `buildMcpConfigFile()`에 넘기고(`agentlas-mcp.json` 작성, `allowedTools` 반환) → **agent의 LLM이 툴을 호출**. `agentlas_resolve_plugins(needs, localInventory)`가 Hub-only 툴을 로컬(`listInstalledServers()`)+Hub에서 해석. 예의 Slack 노드는 summarizer가 post하는 allowed MCP 툴이 되지 별도 명령 호출이 아님.

**노드 간 데이터 흐름 ("Set/Get 변수")**: per-run **변수 백** `Record<string,unknown>`이 위상 워크를 관통. 노드의 `produces:"summary"`는 노드 최종 displayText(runMcpInvocation이 이미 반환)를 `vars.summary`에 기록. 하류 `consumes:"summary"`는 `{{summary}}` 치환으로 프롬프트/파라미터에 삽입 — **`promptTemplate` 이름이 늘 약속했던 파라미터화를 드디어 구현**(한계 #12: 오늘 verbatim, 치환 0). transform이 백을 변형, condition이 백을 읽어 분기. 엣지가 변수명 라벨을 실어 "wire = data" 시맨틱.

**러너** (`electron/workflow/run-graph.ts`, 신규): 위상 정렬 → 각 노드마다 config 해석, `{{vars}}` 치환, 적절한 `McpInvocationRequest` 구성, `runMcpInvocation` 호출, `produces` 백 기록, 올바른 엣지 추종. 기존 백그라운드 `division` 챗 + `permissions:"write"` 패턴(`automation-scheduler.ts:38-68`) 재사용. 스케줄러 `runOne`에 분기 1개: `graph_json` 있으면 `runGraph`, 없으면 오늘의 단일 `runMcpInvocation`(완전 backward-compat).

---

## 5. 단계별 계획 (P0 / P1 / P2)

### P0 — 스케줄 재설계 + 그래프 뷰어 (엔진·문법 토대)

**내놓는 것**: 제대로 된 cron/tz/DST 스케줄, 놓친 실행 정책+기록, 챗이 만든 자동화가 **실제 노드 그래프로 렌더**되고 실행됨(읽기 위주, drag-connect 없음), confirm-before-activate, "Run now".

- 루트 `package.json` — `croner` + `@xyflow/react` 추가.
- `electron/store/schedule.ts` — **신규**: `ScheduleSpec`, `nextRun(spec,from)`(croner), `parseLegacyToken`, `compilePreset`, `validateCron`.
- `electron/store/db.ts` — `SCHEMA_VERSION 32→33`: `graph_json, schedule_json, timezone, end_at, max_runs, run_count` 컬럼 + `parseLegacyToken` 백필(`db.ts:773-780` 패턴), `run_history` 테이블.
- `electron/store/automations.ts` — `computeNextRun`을 `nextRun(spec)`에 위임; `markAutomationRun`에 misfire 정책 적용, `null` 반환 시 `enabled=0`; `run_history` 기록; `toAutomation`에 `graphJson`.
- `electron/automation-emitter.ts` — 구조화 `{preset,time,tz}`/`{cron,tz}` + `steps[]` 방출, cron 서버측 검증, **파싱 실패 표면화**, `stepsToGraph()`+`synthesizeLegacyGraph()`.
- `electron/workflow/run-graph.ts` — **신규**: `runMcpInvocation` 위 위상 러너.
- `electron/automation-scheduler.ts` — 인메모리 `running` Set → DB 리스; `runOne`이 `graph_json` 분기; 완료 시 Electron `Notification`(한계 #10).
- `electron/main.ts` — `whenReady` 최상단 `--headless-automations` 분기.
- `electron/ipc.ts` — `automations:get`, `automations:updateGraph`, `automations:runNow`.
- `renderer/app/(shell)/automation/flow/page.tsx` — **신규** `"use client"` 읽기 전용 React Flow 캔버스 + 노드 인스펙터.
- `renderer/components/automation/nodes/*` — `TriggerNode/AgentNode/ToolNode/OutputNode.tsx`.
- `renderer/lib/workflow-layout.ts` — 결정적 위상→x/y.

### P1 — 조건 트리거 + launchd 영속성 + 편집 캔버스

**내놓는 것**: Tier 0 조건 트리거(fs 변경/체인/스케줄+게이트), 앱 꺼져도 도는 launchd(opt-in), UI로 전체 문법 도달, 편집 가능 캔버스+팔레트, 자동화 편집(한계 #7), run history 표시.

- `shared/types.ts` — `Trigger` union, `trigger_type` 확장.
- `electron/triggers/*` — **신규**: `fs-watcher.ts`(`fs.watch` 경로 공유), `chain-bus.ts`(EventEmitter), 공유 폴 매니저(적응형 백오프+lastSeen 커서).
- `electron/launchd/agent.ts` — **신규**: plist write + `launchctl bootstrap`/`bootout`, opt-in 토글.
- `renderer/app/(shell)/automation/flow/page.tsx` — editable 업그레이드(`onConnect/onNodesChange/onEdgesChange`, `updateGraph` 저장).
- `renderer/components/automation/NodePalette.tsx` — **신규**: 4섹션 드로어(Flow Control/Tools/Triggers/Actions), 소스=`MCP_TOOL_CATALOG`+`listInstalledAgents/listFirms/agentGroups`+surface action enum.
- `renderer/components/automation/NodeConfigPanel.tsx` — **신규**: 타입별 config(전체 문법 스케줄 빌더로 한계 #8 수정, 11 런타임 override 피커).
- `renderer/app/(shell)/automation/new/page.tsx` — 4-프리셋 `<select>`를 프리셋 칩+커스텀 cron(라이브 검증)+시간피커+tz+edit로 교체; "Blank canvas" 진입점.

### P2 — 폴링 조건 + webhook + 라이브 실행 오버레이 + 분기

**내놓는 것**: Tier 1 폴링 조건(가격/지표 임계값 + `MARKET_STATUS` 게이팅, GitHub/Slack/Notion 폴링+커서), Tier 2 webhook(터널), condition/transform 분기, per-node 라이브 상태 오버레이.

- `electron/triggers/poll-sources.ts` — stock/github/slack/notion MCP 폴 소스, 적응형 간격.
- `electron/triggers/webhook-server.ts` — `auth.ts:282` 리스너 재사용 + 터널/릴레이.
- `electron/store/db.ts` — v34: `automation_runs` 테이블(`id, automation_id, started_at, status, node_states_json`).
- `renderer/components/automation/nodes/ConditionNode.tsx`, `TransformNode.tsx` — **신규**, true/false 핸들; 분기 정돈에 `dagre` 여기서.
- `electron/workflow/run-graph.ts` — per-node 상태를 sink로 emit → 캔버스가 실행 중 노드 상태 애니메이션(`PipelineMap.tsx` 개념 재사용).
- `renderer/lib/workflow-validate.ts` — dangling/변수-매치 검증.

**참조 파일**: `renderer/components/oberon/PipelineMap.tsx`(stage→stage + 라이브 상태 오버레이 개념), `renderer/next.config.mjs`(정적 export/`assetPrefix:"./"` 제약), `electron/store/db.ts:331`+`:773-780`(DDL+마이그레이션 idiom), `electron/mcp/client.ts:571`(모든 노드 바인딩 대상), `catalog.ts:11`+`mcp-config.ts:57`(팔레트+컴파일).

---

## 6. 정직한 트레이드오프 & 열린 질문

### 트레이드오프

- **croner는 의존성 추가**지만 zero-transitive-dep 하나이고, 직접 구현하면 안 되는 DST/tz 수학을 산다. 값어치 있음.
- **launchd 영속성은 실제 표면적 증가** — plist, `launchctl` 호출, 헤드리스 코드 경로, cross-process DB 조정. 여기서 가장 큰 엔지니어링 비용이지만 #1 사용자 갭("앱 꺼져서 아침 요약 안 뜸")이므로 opt-in 뒤에 두어 필요 없는 사용자는 아무 비용 안 냄.
- **헤드리스-Electron은 수 초간 수백 MB** 사용. 모던 Mac엔 무방; 저사양이 힘들면 나중에 순수-Node 진입(`db.ts:17`의 `AGENTLAS_STORE_PATH` override가 대부분 가능케 함).
- **backfill은 storm 가능** — 긴 다운타임 후 k가 크면. 기존 `MAX_CONCURRENT_AUTOMATIONS` 레인으로 스로틀+k 상한. coalesce가 안전 기본.
- **React Flow는 정적-export/`file://` CSS 함정** — 패키지 빌드에서 반드시 검증, 404면 인라인. 메모리 플레이북이 이미 경고한 영역.
- **JSON graph 컬럼 vs 정규화 테이블** — cross-graph 분석이 생기면 그때 테이블로 승격. 지금은 join 회피가 이득.
- **조건 트리거의 폴링은 실제 비용** — 이벤트 계열은 공짜지만 가격/지표는 폴링 강제. 적응형 백오프+게이팅으로 통제하되 "공짜 아님"을 UI에 정직히 표시(Zapier식 간격=요금 인식).

### 열린 질문

1. **webhook 공인 URL** — 데스크톱은 공인 URL이 없다. ngrok류 터널 vs Hub 릴레이 중 무엇? 릴레이면 Hub 백엔드 작업 필요 — 별도 스코프.
2. **모델 생성 자동화의 타겟** — 오늘 타겟은 챗의 firm/agent로 강제(`client.ts:1131`). confirm 단계에서 사용자가 타겟/런타임을 재선택하게 할지, 아니면 추론 유지할지.
3. **Stormbreaker 연속 자동화와의 상호작용** — `continuousMode`가 캡을 20,000으로 올려(`loop-engineering.ts:18`) 자기종료 분기가 거의 죽음. 그래프 러너가 이 hidden `every-30m` 자동화(`client.ts:1084`)를 어떻게 표현/노출할지 미정.
4. **run_history 보존 정책** — per-run 행이 무한 누적. TTL/롤업 필요 시점과 정책.
5. **DB 리스 만료(claimed_at 임계)** — 헤드리스 러너가 실행 중 크래시하면 lease가 고아. 만료 시간과 회수 정책 확정 필요.
6. **조건 평가기의 위치** — condition 노드 평가를 인러너(그래프 워크 중)로 할지, 트리거 매니저(발사 게이트)로 할지. §3의 "스케줄+게이트"는 후자, §4의 condition 노드는 전자 — 두 경로를 하나의 `Cond` 평가기로 통일할지 정리 필요.

---

**한 줄 요약**: 60초 폴은 싸다 — 진짜 갭은 **문법(→croner+ScheduleSpec)**, **영속성(→launchd opt-in+헤드리스 Electron)**, **조건(→이벤트는 공짜/폴링만 적응형)**, **시각화(→React Flow, graph_json 1컬럼, runMcpInvocation 위 위상 러너)**. 넷 다 기존 엔진(`client.ts:571`)에 additive로 얹히며 실행 경로는 손대지 않는다.