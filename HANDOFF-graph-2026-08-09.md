# 핸드오프 — 그래프 강건성 작업 (2026-08-09)

> 에이전트 버스로 회신이 안 가서(`No agent named … is reachable`) 파일로 남깁니다.
> 배포 담당 세션이 읽고 진행해 주세요. **배포 기준은 `c925f6a`** 입니다(0c8baac 아님).

## 푸시 완료 — main = c925f6a

| 커밋 | 내용 |
|---|---|
| `0c8baac` | fix(graph): 규칙 넷 수정 + 막다른 길 구조적 금지 |
| `c925f6a` | release: v0.9.74 (package.json·lock·CHANGELOG·README 범프) |

`npm run release:preflight` → **PASS — v0.9.74**

## 게이트 (전부 초록)

- `npm run test:graph` 전체 — 시나리오 25/25 포함
- `npm run test:route-render-sweep` — 12/12
- `node scripts/test-graph-ergonomics.cjs` — 실렌더, "누르면 카드가 실제로 사라진다" 신규
- `node scripts/test-graph-no-dead-end.cjs` — **신설 13검사**, `test:graph` 체인에 연결

## 배포 시 확인할 것 두 가지

**1. 레지스트리 새 칸**
`shared/graph-registry/fields.json` 에 `approvalSetBy` 등재 + 생성물 재생성
(`node scripts/gen-graph-registry.cjs`). 터미널 쪽 생성물
`agentlas_terminal/engine/graph/vocabulary.generated.cjs` 는 내용 변화 없음(확인함).
터미널 re-vendor 후 `gen-graph-registry.cjs --check` 초록만 봐 주세요.

**2. DB 새 칸 — 사다리가 아니라 백스톱**
`automations.attention_cleared_at` 을 `REQUIRED_COLUMNS`(버전 무관 백스톱)에 추가했습니다.
사다리 단계에 끼우면 그 단계를 이미 지난 **기존 설치에는 영원히 안 생깁니다**
(과거 `automations.goal` 사고와 같은 병). 기존 DB 업그레이드 경로 게이트가 있으면 한 번 돌려 주세요.

## 워킹트리에 남은 것

`scripts/capture-x-graph.cjs`, `scripts/demo/` — 둘 다 scratch. 배포 제외 맞습니다.

## 무엇을 고쳤나 (요약)

오너 목표: *"어떤 그래프라도 블락/오류 없이 돌게, 오류 카드는 막다른 길 금지,
하드코딩 케이스 구분 금지."* 케이스를 늘리지 않고 규칙 넷을 고쳤습니다.

1. **코드 단계 네트워크 차단 해제** — `(deny network*)` 가 최대 블락 원인이었습니다.
   "가져오기"는 바깥을 안 바꾸므로 `effect: "read"` 로 적히는데, read 는 DNS 부터 죽었습니다.
   쓰기·비밀 차단은 그대로.
2. **저장된 자물쇠는 `approvalSetBy: "user"` 표식이 있을 때만 존중** — 정책 변경 전
   청사진이 자동으로 박아 둔 `approval:"ask"` 때문에 기존 자동화가 전부 멈춰 있었습니다.
3. **권한은 그래프에서 유도** — `createFromBlueprint` 가 `executionPermission:"read"` 를
   못박아, 자기 청사진이 mutation 을 선언한 자동화가 read 로 태어나 모델이 거부했습니다.
   화면에 이 값을 고르는 자리가 없으므로(= 사람이 고른 적 없음) 커널도 그래프를 봅니다.
4. **막다른 길 금지** — ① 원인은 기계 표식으로만(사유 문장 정규식 전부 제거)
   ② 종결 행동을 조건 없이 배치 + 실행 id 없이 닫는 `acknowledgeAttention`
   ③ 모든 행동은 실행 후 다시 읽고, 근거가 그대로면 그 사실을 말합니다.

## 실증

오너의 실제 자동화 두 개를 **저장된 정의 그대로** 새 커널에 태워 전 노드 완주:

- `Hacker News 한글 요약 저장` — 이전: step1 이 네트워크 차단으로 CODE_STEP_FAILED.
  지금: 전 노드 done, step1 이 실제 기사를 가져옴(제목·URL 확인).
- `주간 AI 뉴스 요약기` — 이전: 저장된 자물쇠 2개로 승인 대기.
  지금: 승인 대기 0, 전 노드 done.

## 아직 안 고친 것 (다음 사람 몫)

- **엣지 렌더** — 오너 그래프에 연결 7개가 저장돼 있는데 화면에 선이 안 보였습니다.
  렌더 실패인지 배치(좌표가 흐름과 따로 놈) 때문인지 **아직 안 갈랐습니다.**
- **텔레그램 봇 토큰 폐기됨** — `Unauthorized`. DB에 `status: failed` 로 2026-07-06부터
  한 달째 남아 있었고 그동안 자동화 리포트가 안 나갔습니다. 제품이 그 사실을 알리지 않은 것이 문제.
- **런타임 끊김·스톨** — `NODE_FAILED: Claude Code is signed out`, `no response for 480s`.
  마커 종류(auth/timeout)로 다른 런타임에 이어가는 일반 폴백이 아직 없습니다.
