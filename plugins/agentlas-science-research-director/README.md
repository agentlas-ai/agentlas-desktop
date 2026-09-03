# Agentlas Science Research Director

Research Director는 하나의 연구를 책임지는 연구책임자(principal investigator) 인격의 built-in
agent 패키지입니다. 사용자가 Lab을 고르거나 채팅에 연구하고 싶은 내용을 적으면, 선행연구 →
가설 → 설계 → 데이터 → 분석 → 강건성 검토 → 결론 → 논문 → 저널 검증까지 기본적으로 스스로
끝까지 진행합니다. 사용자에게 묻는 경우는 연구가 실질적으로 다른 방향으로 갈 수 있을 때,
요청이 모호할 때, 필수 입력이 없을 때뿐이며, 그때도 구체적 선택지와 자기 추천을 함께 냅니다.

| File | Purpose |
|---|---|
| `agent/soul.md` | 인격: 결단력 있고 호기심 많은 연구책임자. 증거로 논증하고, 음성 결과를 정직하게 다루며, 멈출 때를 압니다. |
| `agent/agent.md` | 운영 계약: 자율 기본값, 자기질문 5개, 연구 단계 플레이북, 도메인 팩, 도구 라우팅, 상태 기계. |
| `skills/direct-study/SKILL.md` | 질문 정제부터 결론까지 하나의 상태 기계로 운영하는 워크플로. |
| `skills/write-manuscript/SKILL.md` | IMRaD 원고를 manuscript Markdown dialect로 작성하고 저널 프로필·제출 검증까지 닫는 워크플로. |

이 패키지는 실험 결과를 생성하는 엔진이 아닙니다. 설치된 Science 도구가 반환한 출처,
run, artifact 영수증을 조정하며, 도구가 없거나 실패하면 그 상태를 그대로 남깁니다. 데이터·
해시·인용·검증 결과를 지어내지 않고, 산문을 로컬에서 해시하지 않으며, 라이프사이클 단계를
건너뛰지 않습니다. 이 규칙은 호스트가 강제하는 제품 정확성이지 윤리 설교가 아니며, 프롬프트에
윤리·안전 서문은 없습니다.

분석·표·그림을 만들기 전에 매번 다섯 가지를 답합니다: 지금 왜 필요한가, 어떤 결정이 걸려
있는가, 연구자에게 무엇이 보여야 하는가, 연구자가 그것으로 무엇을 하려는가, 이어지는 다음
단계는 무엇인가. 통계 엔진이 모든 결과에 싣는
`agentlas.science.statistics.research-decision-linkage/v1` 진단이 같은 다섯 질문에 답하므로
그 `nextActions` 중 실제 결과가 뒷받침하는 것만 다음 행동으로 고릅니다.

원고는 `{{figure:<locator>}}`, `{{table:<locator>}}`, `{{cite:<locator>}}`,
`{{ref:fig:<locator>}}`, `{{ref:tab:<locator>}}`, `{{eq:<label>}}` placeholder와 `$…$`/`$$…$$`
수식, GFM 표, YAML front matter로 작성하며 모든 그림·표·인용은 exact artifact/source version에
묶입니다. 렌더러는 `electron/science/manuscript/`에 있습니다.

통계 Figure는 화면 캡처를 제출본으로 취급하지 않습니다. 벡터 저널 규칙은 run-backed exact
SVG artifact와 `figure-vector-profile`을, 래스터 규칙은 300/600 DPI exact PNG artifact와
`figure-raster-profile`을 각각 요구하며 PDF·CMYK·TIFF는 live capability가 생기기 전까지
지원한다고 주장하지 않습니다. `response_surface_regression`이 반환한 exact
`response-surface-grid`만 `materialize_statistics_numeric_surface` 경로로 run-backed
`chart.numeric-3d` v2 artifact가 되며 convex-hull support mask 밖의 셀은 해석하지 않습니다.

도메인 분석(천문·지구과학·물리·재료·유전체·화학·경제·생물다양성)은 일반 계산보다 exact
도메인 도구를 우선하고, `docs/science/<domain>-tools.md`가 있으면 그 문서의 도구 계약을 먼저
따릅니다. 지진 Gutenberg–Richter와 Omori–Utsu, HEPData chi-square, OQMD 격자 지표, 불규칙
광도곡선 GLS 주기 분석은 exact source/run과 명시적 방법 입력을 요구하며, 연구자가 줘야 하는
값이 없으면 추천값과 근거를 붙여 한 번만 묻습니다.

Desktop Main은 매 Science turn 직전에 설치된 exact release와 `agent/soul.md` +
`agent/agent.md` + `skills/direct-study/SKILL.md` + `skills/write-manuscript/SKILL.md`로
조립한 canonical prompt hash(persona → contract → workflows)를 검증합니다. 검증이 끝난 뒤에만
숨겨진 Science runtime chat을 deterministic built-in identity에 묶습니다. 패키지가 없거나
변경됐거나 동일 slug가 다른 agent ID를 가리키면 model 호출 전에 fail closed 합니다. 해시
재생성은 `node tests/validate-package.mjs --print-hash`. mention
`@agentlas-science-research-director`는 일반 표면의 명시적 plugin route로만 남아 있으며,
Science turn의 사용자 메시지에는 주입되지 않습니다.
