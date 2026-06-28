# Agentlas Desktop 기능 QA 매트릭스

작성일: 2026-06-28

원칙:

- `PASS`: 실제 코드/화면/명령으로 확인했다.
- `FAIL`: 실제로 실행했거나 코드 경로를 따라갔을 때 깨지는 부분을 찾았다.
- `PARTIAL`: 일부는 확인했지만 끝까지는 못 봤다.
- `NOT RUN`: 테스트 시나리오는 썼지만 아직 실제 실행은 안 했다.
- `WEAK`: 기능은 있으나 사용자에게 보이는 설명, 상태 표시, 실패 처리 중 하나가 약하다.
- 폴백 결과, 추측, 예전 기억만으로 `PASS`라고 쓰지 않는다.

## 1. 에이전트 빌드 기능

실제 연결:

- 화면: `renderer/app/(shell)/build/page.tsx`
- 상태 저장: `renderer/lib/build-session.ts`
- 실행: `electron/hephaestus/builder.ts`
- IPC: `hephaestus.build`, `hephaestus.buildReady`, `hephaestus.publish`, `team.importLocalFolder`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| BUILD-01 | 빌드 모드 선택 | 단일 에이전트, 멀티 에이전트 팀, 기존 패키징 선택/해제 | Build 화면에서 각 모드 버튼을 눌러 `mode`가 바뀌는지 확인 | 버튼 active 상태, 시작 로그의 모드 값 | PARTIAL |
| BUILD-02 | 스타터 프롬프트 | 스타터 칩 클릭 시 요청 입력 채움 | 세 스타터를 눌러 textarea 값 변경 확인 | 입력창 값 캡처 | PASS |
| BUILD-03 | 빌드 모델 선택 | 런타임 목록 조회, 모델 선택, 자동 선택 | 런타임 mock/실제 상태에서 select 옵션 확인 | `runtime.detect` 호출, 선택값 반영 | PASS |
| BUILD-04 | 생성 폴더 선택 | 폴더 선택, localStorage 저장, 다음 진입 복구 | 폴더 선택 후 화면 이동/복귀 | 버튼에 폴더명 표시, localStorage 키 | PARTIAL |
| BUILD-05 | 딥인터뷰 시작 | 요청+폴더가 있을 때 빌드 실행 | `hephaestus.build`가 호출되고 runId 수신 | runId, build 이벤트 채널 | PASS |
| BUILD-06 | 질문 대기 | `BUILD_COMPLETE` 전에는 인터뷰 상태로 멈춤 | 빌더 응답에 `<<agentlas-ask>>`가 있을 때 질문 UI 표시 | 질문 카드, 답변 버튼, phase=`interview` | NOT RUN |
| BUILD-07 | 답변 후 다음 턴 | 사용자가 답하면 history 포함해 다음 빌드 턴 실행 | 답변 입력/옵션 클릭 후 `hephaestus.build` 재호출 | 로그에 답변, turn 증가 | NOT RUN |
| BUILD-08 | 완료 판정 | `BUILD_COMPLETE:`가 있을 때만 완료 처리 | 완료 문자열 포함/미포함 응답 비교 | phase=`done` vs `interview` | PARTIAL |
| BUILD-09 | 산출물 표시 | 생성 폴더 파일 목록 표시 | 완료 후 폴더에 `AGENTS.md`, `.agentlas` 등 생성 | ArtifactPreview 파일 목록 | PASS |
| BUILD-10 | 보안 스캔 결과 | 빌드 후 security scan 결과 표시 | scan pass/fail/unverified mock | VerifyGate 문구가 상태별로 다름 | PASS |
| BUILD-11 | 자동 조직도 등록 | 완료 폴더를 `team.importLocalFolder`로 등록 | 완료 후 등록 성공/실패 시나리오 | 로그 `조직도에 추가됨` 또는 실패 안내 | PASS |
| BUILD-12 | 중지/취소 | 실행 중 `cancelBuild` 호출 | 실행 중 중지 버튼 클릭 | `hephaestus.cancelBuild` 호출, phase reset | NOT RUN |
| BUILD-13 | 업로드 선택 | 비공개 Cloud, 공개 Hub 선택 | 완료 상태에서 두 버튼 클릭 | `hephaestus.publish({visibility})` 호출 | PARTIAL |

위험/주의:

- 실제 LLM 빌더 실행은 활성 런타임이 필요하다.
- 빌드 완료처럼 보여도 `BUILD_COMPLETE:`가 없으면 완료가 아니다.
- 보안 스캔 실패/타임아웃은 깨끗함이 아니라 `unverified`로 봐야 한다.

## 2. 마이 에이전트 자가진화 및 메모리 관리

실제 연결:

- 화면: `renderer/app/(shell)/library/agents/page.tsx`
- 메모리 파서: `renderer/lib/agent-memory.ts`
- 파일 읽기/쓰기: `electron/agents/files.ts`
- IPC: `agentFiles.list`, `agentFiles.read`, `agentFiles.write`, `skills.listCatalog`, `agentRuntime.*`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| MEM-01 | 에이전트 파일 로드 | 선택한 agentId로 파일 목록 읽기 | 라이브러리에서 에이전트 선택 | `agentFiles.list` 호출, 파일 카드 표시 | PASS |
| MEM-02 | `memory.md` 파싱 | Decisions, Gotchas, Open 분리 | 샘플 memory.md를 가진 에이전트 선택 | 세 섹션 카운트 일치 | PASS |
| MEM-03 | 메모리 저장 | 토글/승격 후 직렬화해서 파일에 씀 | 규칙 토글 후 파일 다시 읽기 | HTML 마커 유지, 저장 순서 유지 | PASS |
| MEM-04 | 빠른 연속 저장 방지 | 저장 큐로 lost update 방지 | 두 규칙을 빠르게 토글 | 두 변경 모두 파일에 남음 | NOT RUN |
| MEM-05 | 규칙 켜기/끄기 | enabled 상태 토글 | 규칙 비활성화 후 새로고침 | `<!--agentlas:disabled-->` 유지 | PASS |
| MEM-06 | Hub 공유 후보 표시 | synced 상태 토글 | Hub 공유 토글 후 새로고침 | `<!--agentlas:synced-->` 유지 | NOT RUN |
| MEM-07 | 미결 과제 승격 | Open 항목을 Decision으로 이동 | Open 항목의 결정 승격 클릭 | Open 감소, Decisions 증가 | NOT RUN |
| MEM-08 | 프롬프트 편집 | AGENT.md/system-prompt.md 저장 | 프롬프트 수정 후 파일 확인 | 파일 내용 변경, system-prompt는 DB도 변경 | PARTIAL |
| MEM-09 | 프롬프트 기본값 재설정 | 에이전트 기본 프롬프트로 되돌림 | 재설정 승인 후 파일 확인 | AGENT.md 또는 system-prompt.md 변경 | NOT RUN |
| MEM-10 | 자가 프롬프트 진화 | 메모리 규칙을 프롬프트 부록으로 병합 | 새 Decision 추가 후 Activity에서 승인 | `Learned rules` 부록 저장 | NOT RUN |
| MEM-11 | 스킬 주입 | `.agentlas/skills/<slug>/SKILL.md` 생성 | 스킬 카탈로그에서 하나 선택 | 스킬 파일 생성, memory.md 결정 추가 | NOT RUN |
| MEM-12 | 진화 히스토리 | 파일 로드/메모리/프롬프트/스킬 이벤트 표시 | 에이전트 선택 후 Activity 탭 | 이벤트 수/내용 표시 | NOT RUN |
| MEM-13 | 런타임 모델 지정 | agent/division/firm 범위로 모델 고정 | Runtime Assignment 저장/해제 | `agentRuntime.set/remove` 호출 | PARTIAL |
| MEM-14 | 파일 경로 보호 | agent 폴더 밖 쓰기 차단 | `../escape.md` 쓰기 시도 | 에러 또는 빈 미리보기 | NOT RUN |

위험/주의:

- 로컬 임포트 에이전트는 원본 폴더를 직접 쓴다. 테스트는 임시 폴더로 해야 한다.
- `system-prompt.md`를 저장하면 DB 프롬프트도 바뀐다. AGENT.md 저장은 파일만 바뀔 수 있다.
- UI의 “Hub 공유 후보” 토글은 원격 업로드가 아니라 메모리 메타데이터 표시다.

## 3. 에이전트 불러오기 기능

실제 연결:

- 화면: `renderer/app/(shell)/library/agents/page.tsx`
- 임포트: `electron/agents/import-local.ts`
- 라우트 저장: `electron/agents/routes.ts`
- 파일 접근: `electron/agents/files.ts`
- 스모크: `scripts/smoke-local-import.cjs`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| IMPORT-01 | 폴더 선택 | `fs.pickDirectory`로 경로 선택 | 가져오기 버튼 클릭 | 폴더 picker 호출 | NOT RUN |
| IMPORT-02 | 런타임 감지 | CLAUDE/AGENTS/GEMINI/Cursor 감지 | 각 파일이 있는 샘플 폴더 임포트 | runtime label 일치 | PARTIAL |
| IMPORT-03 | 단일 에이전트 감지 | AGENT/AGENTS 등 단일 폴더 인식 | 샘플 단일 에이전트 임포트 | kind=`agent` | PASS |
| IMPORT-04 | 팀 감지 | TEAM/ceo/agents 등 팀 폴더 인식 | 샘플 팀 임포트 | kind=`team`, firm 생성 | PASS |
| IMPORT-05 | 같은 폴더 멱등성 | 같은 폴더 재임포트 시 중복 방지 | 같은 폴더 두 번 임포트 | agent id 동일 | PASS |
| IMPORT-06 | 원본 폴더 라우팅 | 복사 대신 원본 경로 저장 | 임포트 후 route 파일 확인 | route.path가 원본 절대경로 | PASS |
| IMPORT-07 | 정크 폴더 가드 | trash/tmp 같은 공유 폴더 팀 오인 방지 | 정크명 샘플 임포트 | firm 미생성 또는 단일 처리 | NOT RUN |
| IMPORT-08 | 사이드바 반영 | 가져온 에이전트/팀이 목록에 표시 | UI에서 임포트 후 refresh | 로스터에 이름 표시 | NOT RUN |

위험/주의:

- 임포트는 원본 파일을 수정하지 않는 것이 원칙이다.
- 팀 리졸버가 LLM 분석에 실패하면 휴리스틱으로 폴백한다. 이 폴백은 PASS가 아니라 별도 확인 대상이다.

## 4. 에이전트 허브 내보내기 기능

실제 연결:

- Build 업로드 UI: `renderer/app/(shell)/build/page.tsx`
- Hephaestus publish IPC: `electron/ipc.ts`
- 명령 래퍼: `electron/hephaestus/commands.ts`
- Cloud package review: `scripts/test-cloud-agent-package.cjs`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| EXPORT-01 | 비공개 Cloud 선택 | `visibility=private-link`로 publish | Build 완료 후 Cloud 버튼 클릭 | `hephaestus.publish` payload | NOT RUN |
| EXPORT-02 | 공개 Hub 선택 | `visibility=marketplace`로 publish | Build 완료 후 Hub 버튼 클릭 | `hephaestus.publish` payload | PASS |
| EXPORT-03 | 업로드 전 확인 | dry-run이 아니면 확인 모달 | publish 호출 전에 취소/승인 테스트 | 취소 시 업로드 안 됨 | NOT RUN |
| EXPORT-04 | 폴더 인자 보호 | 잘못된 `-flag`/금지 경로 방지 | 위험 path로 publish 호출 | 에러 반환 | NOT RUN |
| EXPORT-05 | 패키징 리뷰 | 정적 리뷰 pass/fail | 깨끗한 패키지와 secret 포함 패키지 비교 | clean=pass, secret=blocked | PASS |
| EXPORT-06 | 실제 Hub 등록 | 공개 Hub에 실제 업로드 | 로그인/네트워크 상태에서 publish 실행 | Hub 또는 API에서 등록 확인 | NOT RUN |

위험/주의:

- `dry-run` 패키징 성공은 실제 Hub 등록 성공이 아니다.
- UI 버튼 클릭 확인과 원격 Hub 등록 확인은 별개다.
- 원격 업로드 테스트는 계정/네트워크/승인 상태가 필요하다.

## 5. 새 채팅 창 옵션

실제 연결:

- 입력창: `renderer/components/ChatInput.tsx`
- 채팅 실행: `renderer/app/(shell)/chat/page.tsx`
- IPC 실행: `invoke.run`, `hephaestus.routePreview`, `chats.switchAgent`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| CHAT-01 | 텍스트 전송 | Enter/Cmd 전송, 빈 값 방지 | 텍스트 입력 후 전송 | `invoke.run.userPrompt` 일치 | PASS |
| CHAT-02 | 이미지 첨부 | 파일 선택/붙여넣기/드롭 | 이미지 붙여넣기 후 전송 | images 배열 포함 | NOT RUN |
| CHAT-03 | 이미지 크기 제한 | 5MB 초과 차단 | 큰 이미지 첨부 | alert 또는 거부 | NOT RUN |
| CHAT-04 | 슬래시 자동완성 | `/new`, `/folder`, 앱 명령, CLI 명령 | `/` 입력 후 후보 선택 | 후보 표시, 선택 동작 | NOT RUN |
| CHAT-05 | 앱 슬래시 실행 | `/new`, `/folder`, `/help` 등 | 각 명령 선택 | 텍스트 삽입이 아니라 앱 동작 | NOT RUN |
| CHAT-06 | @ 에이전트 호출 | @agent 선택 시 활성 에이전트 변경 | @ 입력 후 에이전트 선택 | `chats.switchAgent` 호출 | NOT RUN |
| CHAT-07 | @firm 호출 | @firm 선택 시 CEO 에이전트 호출 | firm 선택 | CEO agent id로 switch | NOT RUN |
| CHAT-08 | @project/env 삽입 | 프로젝트/env는 텍스트 삽입 | 후보 선택 | 입력창에 토큰 삽입 | NOT RUN |
| CHAT-09 | Network 토글 | prompt 앞에 `hep-network` 붙임 | 토글 ON 후 전송 | userPrompt prefix | PASS |
| CHAT-10 | Stormbreaker 토글 | prompt 앞에 `stormbreaker` 붙임 | 토글 ON 후 전송 | userPrompt prefix, 첫 경고 표시 | PASS |
| CHAT-11 | Network+Stormbreaker | 둘 다 켜면 `hep-network --stormbreaker` | 두 토글 ON 후 전송 | prefix 정확 | PASS |
| CHAT-12 | Recommend 토글 | 전송 전 추천 시트 표시 | Recommend ON 후 전송 | `routePreview` 호출, 시트 표시 | NOT RUN |
| CHAT-13 | 추천 실행 선택 | agent/network/pipeline/plain 선택 | 추천 시트 선택 | send/switch/borrow/pipeline 분기 | NOT RUN |
| CHAT-14 | 권한 선택 | read/write/full 선택 | 권한 메뉴에서 변경 후 전송 | `permissions` payload | PASS |
| CHAT-15 | 모델 선택 | 모델/effort 선택 | 모델 메뉴 선택 | `switchModel/switchEffort` 호출 | PARTIAL |
| CHAT-16 | Plan 모드 | Plan 토글 상태 전송 | Plan ON 후 전송 | `planMode` 옵션 생성 | PASS |
| CHAT-17 | Goal 모드 | Goal 토글 상태 전송 | Goal ON 후 전송 | `goalMode` payload | PASS |
| CHAT-18 | Apps Generate 모드 | + 메뉴에서 질문 시트 후 전송 | dedicated 선택 후 전송 | `appsGenerateMode` payload | PASS |
| CHAT-19 | 정지 버튼 | busy 중 send 버튼이 stop으로 변경 | 실행 중 클릭 | `invoke.cancel` 호출 | NOT RUN |
| CHAT-20 | IME 보호 | 한글 조합 중 Enter 오발송 방지 | 한글 조합 입력 중 Enter | 메시지 전송 안 됨 | NOT RUN |

위험/주의:

- `planMode` 누락 버그는 수정했고, `invoke.run` payload에서 `planMode=true`까지 확인했다.
- 토글은 전송 후에도 유지된다. 테스트에서 다음 케이스에 영향을 줄 수 있다.
- 추천은 실패해도 plain send 폴백이 있으므로, 추천 실패를 성공으로 오해하면 안 된다.

## 6. 자동화 페이지 자동화 기능

실제 연결:

- 목록: `renderer/app/(shell)/automation/page.tsx`
- 생성: `renderer/app/(shell)/automation/new/page.tsx`
- 상세: `renderer/app/(shell)/automation/detail/page.tsx`
- 저장/스케줄: `electron/store/automations.ts`
- 실행기: `electron/automation-scheduler.ts`
- 채팅 자동 생성 프로토콜: `electron/automation-emitter.ts`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| AUTO-01 | 자동화 목록 | SQLite에서 자동화 목록 읽기 | 목록 페이지 진입 | `automations.list` 호출, 카드 표시 | PASS |
| AUTO-02 | 빈 상태 | 자동화 없을 때 안내 | 빈 DB로 진입 | empty 문구 표시 | PASS |
| AUTO-03 | 새 자동화 생성 | 이름/스케줄/대상/프롬프트 저장 | 폼 입력 후 생성 | DB row 생성, 목록 이동 | PASS |
| AUTO-04 | 대상 선택 | firm/agent 탭 선택 | firm/agent 전환 | targetType/targetId 반영 | PASS |
| AUTO-05 | 기본 프롬프트 | prompt 비면 기본값 사용 | 프롬프트 비우고 생성 | promptTemplate 기본값 | NOT RUN |
| AUTO-06 | 스케줄 계산 | daily/weekday/weekly/monthly/every/hourly | 기준 시각별 nextRun 계산 | 예상 ISO 시각 | PASS |
| AUTO-07 | 켜기/끄기 | toggle 저장, 다시 켤 때 nextRun 재계산 | 목록/상세에서 토글 | enabled/nextRun 변경 | PASS |
| AUTO-08 | 삭제 | confirm 후 삭제 | 삭제 버튼 클릭 | DB row 삭제 | PASS |
| AUTO-09 | 상세 보기 | schedule/target/lastRun/prompt 표시 | detail?id로 진입 | 값 표시 | NOT RUN |
| AUTO-10 | due 실행 | nextRunAt 지난 항목 실행 | due row 생성 후 tick | 자동 chat 생성, lastRunAt 갱신 | PARTIAL |
| AUTO-11 | 중복 실행 방지 | 같은 자동화가 실행 중이면 건너뜀 | 긴 실행 중 tick 반복 | running set으로 중복 없음 | NOT RUN |
| AUTO-12 | 실패 후 무한 재실행 방지 | 실패해도 nextRun 전진 | runMcpInvocation 실패 mock | markAutomationRun 호출 | PARTIAL |
| AUTO-13 | Stormbreaker 장기 작업 자동 비활성 | continue 없으면 자동화 끔 | 장기 프롬프트 실행 결과 | enabled=false | NOT RUN |
| AUTO-14 | 에이전트 응답에서 자동화 생성 | `## Automation` JSON 블록 파싱 | 응답 텍스트 parse | cleanedText와 automations 분리 | PASS |

위험/주의:

- 스케줄러는 앱이 켜져 있을 때만 돈다. 앱이 꺼져 있을 때 실행되는 데몬은 아니다.
- 번역 키 이름에는 `stub`가 남아 있지만, 사용자에게 보이는 문구는 “백그라운드에서 예약 실행”으로 설명되어 있다.
- 자동화 실행은 백그라운드 chat에 기록되므로, UI에서 “실행 결과”까지 보려면 세션 접근 경로가 필요하다.

## 7. 허브 페이지 연결 및 폴백 표시

실제 연결:

- 화면: `renderer/app/(shell)/marketplace/page.tsx`
- 소스 선택/폴백: `electron/marketplace/index.ts`
- 원격 MCP 호출: `electron/marketplace/mcp-source.ts`
- 기본 목록: `electron/marketplace/in-memory-source.ts`
- 설치: `electron/mcp/registry.ts`, `electron/store/firms.ts`
- 스모크: `scripts/test-marketplace-fallback.cjs`

기능 목록:

| ID | 기능 | 작업 목록 | 테스트 시나리오 | 증거 기준 | 현재 판정 |
| --- | --- | --- | --- | --- | --- |
| HUB-01 | 실시간 Hub 연결 상태 | MCP endpoint 호출 성공/실패 기록 | `marketplace.search_agents` 직접 호출 | HTTP 200 또는 오류 | PASS |
| HUB-02 | 앱 내부 source status | live/fallback 상태 분리 | 정상 endpoint와 강제 오프라인 endpoint 비교 | `online`, `usingFallback`, `lastError` | PASS |
| HUB-03 | 로그인 상태와 Hub 연결 상태 분리 | 상단 문구가 계정 로그인과 Hub source를 따로 표시 | 로그인=true, source=offline mock | `계정 로그인됨` + `Hub 오프라인` | PASS |
| HUB-04 | fallback 경고 표시 | 원격 실패 시 내장 기본 목록임을 명시 | `usingFallback=true` mock으로 Hub 페이지 진입 | “실제 Hub에 연결되지 않았습니다” 표시 | PASS |
| HUB-05 | fallback 카드 출처 표시 | 카드가 Hub가 아니라 기본 목록임을 표시 | fallback 상태에서 팀/에이전트 탭 확인 | “앱 내장 기본 목록”, “실시간 Hub 아님” | PASS |
| HUB-06 | live 상태 카드 표시 | 원격 성공 시 fallback 경고가 없어야 함 | live mock/실제 연결에서 페이지 진입 | `Hub 실시간`, fallback 경고 없음 | PASS |
| HUB-07 | fallback 설치 의미 | fallback에서 설치 버튼이 “Hub 설치”처럼 보이지 않음 | fallback 상태 카드 버튼 확인 | `기본 설치` 표시 | PASS |
| HUB-08 | 원격 응답 shape 정규화 | `{results:[...]}` 응답을 배열로 처리 | 실제 endpoint 응답을 앱 source로 읽기 | agents count > 0, 에러 없음 | PASS |

현재 확인한 사실:

- 2026-06-28 현재 이 Mac에서 `https://agentlas.cloud/api/mcp/v1/tools/call`은 200으로 응답했다.
- 강제 오프라인 base URL에서는 `online=false`, `usingFallback=true`, `lastError=fetch failed`가 기록됐다.
- 강제 오프라인에서도 기본 목록이 반환된다. 따라서 화면이 이를 명확히 표시하지 않으면 “허브가 연결된 척”처럼 보일 수 있다.
- Playwright fallback 화면 검증 증거: `output/playwright/hub-offline-fallback.png`.
- Playwright live 화면 검증 증거: `output/playwright/desktop-feature-surfaces/hub-live-surface.png`.

위험/주의:

- `계정 로그인됨`은 Hub 데이터 연결 성공이 아니다.
- fallback 목록 설치는 실시간 Hub 등록/호출 검증이 아니다.
- `usingFallback=true` 상태에서는 최신 공개 목록, 호출 가능 여부, Hub 등록 상태를 확인했다고 말하면 안 된다.

## 이번 QA에서 먼저 실행할 최소 테스트

1. TypeScript 전체 타입 검사.
2. Electron 빌드.
3. Renderer 빌드.
4. 로컬 에이전트/팀 임포트 스모크.
5. 앱 빌더 라우팅 스모크.
6. Cloud agent package 정적 리뷰 스모크.
7. Marketplace fallback 스모크.
8. 자동화 store 스케줄/CRUD/파서 테스트.
9. Playwright로 Build, My Agents, Chat, Automation, Hub 화면의 핵심 컨트롤 노출 확인.

## 실행 결과 기록

2026-06-28 실제 실행:

| 범위 | 실행 | 결과 | 증거 |
| --- | --- | --- | --- |
| 전체 타입 | `npm run typecheck` | PASS | Electron + renderer TypeScript 통과 |
| Electron 빌드 | `npm run build:electron` | PASS | `cli/architecture.data.json` v1.5.34 생성 |
| Renderer 빌드 | `npm run build:renderer` | PASS | 33개 static page 생성 |
| Build/My Agents/Chat/Automation/Hub 표면 | `node scripts/test-desktop-feature-surfaces.cjs` | PASS | `output/playwright/desktop-feature-surfaces/proof-summary.json`, screenshots |
| 로컬 에이전트/팀 임포트 | `./node_modules/.bin/electron scripts/smoke-local-import.cjs` | PASS | imported agent/team, routes=2, firms=1 |
| 앱 빌더 라우팅 | `node scripts/test-app-builder-routing.cjs` | PASS | positive 4, negative 5 |
| Cloud 패키징 리뷰 | `./node_modules/.bin/electron scripts/test-cloud-agent-package.cjs` | PASS | clean pass, secret blocked |
| 자동화 저장소/스케줄/파서 | `./node_modules/.bin/electron scripts/test-automations-store.cjs` | PASS | CRUD, nextRun, due, parseAutomations |
| Hub 강제 오프라인 | `./node_modules/.bin/electron scripts/test-marketplace-fallback.cjs --offline` | PASS | `online=false`, `usingFallback=true`, `lastError=fetch failed` |
| Hub live | `./node_modules/.bin/electron scripts/test-marketplace-fallback.cjs --live` | PASS | `online=true`, `usingFallback=false`, agents=10 |
| scoped whitespace check | `git diff --check -- <changed QA files>` | PASS | 현재 작업 범위 diff check 통과 |

이번 QA 중 발견해서 수정한 문제:

- Hub fallback이 실제 Hub 연결처럼 보일 수 있었다. 화면에 `Hub 오프라인`, `실제 Hub에 연결되지 않았습니다`, `앱 내장 기본 목록`, `기본 설치`를 표시하도록 수정했다.
- Chat `Plan` 모드는 입력창에는 있었지만 `invoke.run` payload와 backend 지시에 연결되지 않았다. `planMode` 타입, renderer 전달, backend plan prompt를 추가하고 payload에서 `planMode=true`를 확인했다.
- 채팅 화면 우하단 도움말 버튼이 보내기 버튼 클릭을 가로막았다. `/chat` 경로에서는 도움말 버튼을 입력창 위로 올리도록 수정했다.

아직 실제로 안 돌린 큰 항목:

- 원격 Hub 공개 등록(EXPORT-06)은 실제 계정/승인/네트워크 업로드까지 실행하지 않았다.
- 빌드 딥인터뷰 질문/답변 멀티턴(BUILD-06, BUILD-07)은 아직 별도 이벤트 시나리오로 돌리지 않았다.
- 이미지 첨부/5MB 제한/IME 보호/추천 시트 실행(CHAT-02, CHAT-03, CHAT-12, CHAT-13, CHAT-20)은 아직 미실행이다.
- 자동화 스케줄러의 실제 `runMcpInvocation` 실패/중복/Stormbreaker 장기작업 비활성(AUTO-11, AUTO-13)은 아직 미실행이다.
