# Agentlas Science Research Director

Research Director는 하나의 연구 질문을 여러 채팅과 Lab 사이에서 잃지 않고, 검증 가능한
연구 상태와 정확한 계보를 유지하며 저널 제출 패키지까지 지휘하는 built-in agent 패키지입니다.

| Workflow | Purpose |
|---|---|
| `direct-study` | 질문 정제, 선행연구, 가설, 분석계획 동결, Lab 실행, 증거 원장, 결론, 논문, 저널 검증을 하나의 상태 기계로 운영합니다. |

이 패키지는 실험 결과를 생성하는 엔진이 아닙니다. 설치된 Science 도구가 반환한 출처,
run, artifact 영수증을 조정하며, 도구가 없거나 실패하면 그 상태를 그대로 남깁니다.

통계 Figure는 화면 캡처를 제출본으로 취급하지 않습니다. 벡터 저널 규칙은 run-backed exact
SVG artifact와 `figure-vector-profile`을, 래스터 규칙은 300/600 DPI exact PNG artifact와
`figure-raster-profile`을 각각 요구하며 PDF·CMYK·TIFF는 live capability가 생기기 전까지
지원한다고 주장하지 않습니다.

`response_surface_regression`이 반환한 exact `response-surface-grid`만 전용
`materialize_statistics_numeric_surface` 경로로 run-backed `chart.numeric-3d` v2 artifact가
됩니다. 관측점과 관측 데이터 convex-hull support mask 밖의 셀은 해석하지 않으며, 카메라
영수증은 협업용 검사 상태일 뿐 분석 근거나 원고 Figure가 아닙니다. 2D SVG/PNG exporter를
3D 제출 자산으로 오인하지 않고, 전용 3D publication export capability가 없으면 그 공백을
명시합니다.

도메인 분석도 같은 원칙을 따릅니다. 지진 Gutenberg–Richter와 Omori–Utsu, HEPData
chi-square, OQMD 격자 지표, 불규칙 광도곡선 GLS 주기 분석은 exact source/run과 명시적 방법
입력을 요구합니다. mainshock·완전성·frequency grid·time system 같은 과학적 경계를 추측하지
않습니다. 현재 SIMBAD 검색 결과에는 천문 운동학에 필요한 오차항이 없으므로 이를 임의 보완해
`analyze_astrometric_kinematics`를 실행하지 않습니다.

Desktop Main은 매 Science turn 직전에 설치된 exact release와 `agent/agent.md` +
`skills/direct-study/SKILL.md`의 canonical prompt hash를 검증합니다. 검증이 끝난 뒤에만 숨겨진
Science runtime chat을 deterministic built-in identity에 묶습니다. 패키지가 없거나 변경됐거나
동일 slug가 다른 agent ID를 가리키면 model 호출 전에 fail closed 합니다. mention
`@agentlas-science-research-director`는 일반 표면의 명시적 plugin route로만 남아 있으며,
Science turn의 사용자 메시지에는 주입되지 않습니다.
