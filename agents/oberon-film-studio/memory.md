# Oberon Film Studio — Memory

작품 간(cross-production)에 유지할 학습·결정·게이트 근거를 적는다. 작품별 휘발 상태
(takes, render job ids)는 여기 두지 않는다.

## Decisions

- **글자는 생성 모델이 그리지 않는다.** 타이틀/자막/로어서드는 후반 번인(타이포 키트).
  영상/이미지 프롬프트는 `Do not render any on-screen text …` 정책을 항상 포함한다.
  근거: 생성 모델의 깨진 텍스트 아티팩트 방지.
- **연속성은 2층이다.** 글로벌 바이블(정체성·룩 고정) + 순차 메모리 체인(이전 샷 →
  현재 샷 carry). 씬 경계에서 메모리를 리셋하되 누적 세계 상태는 유지한다.
- **샷은 시간 위에서 움직인다.** 모든 샷을 초단위 모션 비트로 안무하고 컷 핸들(끝
  0.3초 정지)을 남긴다 — 편집 연결을 위해.
- **프로바이더는 샷별로 고른다.** 대사·립싱크 → Veo, 최고 화질 → Seedance,
  카메라 무브 → Luma, 범용 → Runway. 어댑터 경계 뒤에 두어 API 종료(예: Sora)에 대비.
- **모션그래픽 광고는 별도 팀이다.** 제품/SaaS/UI 광고, Framer Motion/Remotion/Lottie/Tailwind
  요청, "API 없이" 요청은 이 Oberon Film Studio 패키지에서 처리하지 않는다.
  `oberon-motiongraphic-studio`의 `/oberon-motion` HQ로 넘긴다.

## Gotchas

- 한국어 작품은 본문/자막 폰트를 반드시 CJK(Pretendard/Noto)로 강제한다 — 디스플레이
  폰트가 한글 미지원일 수 있으므로 스택에 한글 폴백을 포함.
- 클라우드 퍼블리시는 `.agentlas/routing-card.json`(routing-card/2.0)이 **필수**다.
  없으면 `routing-card-required` blocker로 패키징이 막힌다.
- 패키지 매니페스트의 `totalBytes`는 **included 파일 합계**여야 한다(스캔 전체 X) —
  아니면 서버 register가 400(manifest_count_mismatch)로 거부한다.

## Open

- Oberon은 현재 데스크탑 빌트인 기능 + 이 배포팩(계약/지식)으로 이중 존재한다.
  엔진 자체의 플랫폼 비종속 추출(Veo/ffmpeg/IPC 분리)은 향후 리팩터 과제.
- 2026-07-01: deterministic product motion graphics는
  `Hephaestus_agent_forge/Paid/oberon-motiongraphic-studio`로 분리했다. Film Studio는
  cinematic/animation continuity만 맡는다.
- `routing_status`는 candidate로 시작 — 클라우드 동작 검증 후 routing_ready로 승격.
