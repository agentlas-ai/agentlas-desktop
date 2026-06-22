# Oberon Film Studio

> AI Film Operating System — 한 줄 브리프를 멀티샷 영상 제작 파이프라인 전체로.

Oberon은 Agentlas Desktop에 내장된 AI 필름 스튜디오의 **에이전트 배포팩(deploy-pack)**
이다. 데스크탑 앱에서 직접 쓰거나, **Hephaestus Network로 다른 Agentlas 워커가 빌려**
영상 제작 방법론(시스템 프롬프트 · 시네마틱 문법 · 연출/연속성/오디오/타이포 레이어)을
재사용할 수 있다.

## 무엇을 하나

브리프 한 줄 → **기획 → 스크립트·비트 → 커버리지 샷 리스트 → 컨티뉴이티 바이블 →
키프레임 → (승인) → 영상 생성 → QA → 편집 → 오디오/자막 → 멀티비율 납품**.

핵심 차별점:
- **초단위 카메라 안무** — 8초 클립을 정적 한 줄이 아니라 `[0–0.3s] 진입 → 전개 →
  컷 핸들` 타임라인으로 연출 (속도 램프·슬로모 포함).
- **순차 연속성 메모리** — 글로벌 바이블 + 이전 샷 → 현재 샷 상태 carry(라스트프레임·
  스크린 디렉션·조명·감정 온도) + 키프레임 체이닝, 180/아이라인/30도 규칙.
- **자막 + 음성 대사** — 화자·감정·딜리버리 구조, 네이티브 동기 오디오 립싱크 지시,
  SRT/VTT 자막(프레임에 안 그리고 후반 번인).
- **폰트 다양화** — 장르/무드별 폰트 페어링(타이틀·자막·로어서드·CTA), 한국어는 CJK
  폰트 강제.

## 능력 (routing card capabilities)

`film_production` · `video_generation` · `shot_planning` · `camera_choreography` ·
`continuity_management` · `keyframe_synthesis` · `dialogue_direction` ·
`subtitle_generation` · `typography_design` · `provider_routing`

## 빌려 쓰기 (Hephaestus Network)

```
/hep-network          # 공개 Agentlas Hub 에이전트를 Hephaestus로 빌려 쓰기
/hep-search oberon    # 후보 검색
```

데스크탑 앱에서 직접 쓰려면 Apps → **Oberon** 진입.

## 퍼블리시 (소유자)

이 폴더(`agents/oberon-film-studio/`)가 클라우드 에이전트 패키징 루트다. 포함:
`AGENT.md`(계약), `.agentlas/routing-card.json`(라우팅 카드 2.0), `README.md`, `memory.md`.

```
# dry-run 정적 리뷰 (시크릿 불필요)
agentlas package --path agents/oberon-film-studio --review static-only

# 실제 퍼블리시는 agentlas.cloud 로그인(세션) 후 dryRun=false 로 명시 실행
```

> 이 패키지는 **자격증명/시크릿을 포함하지 않는다** — vault 키 *이름*만 문서화한다.
> 실제 키는 호스트 런타임의 시크릿 vault가 공급한다.

## 라이선스 / 권리

생성 프레임에는 화면 텍스트를 넣지 않으며(후반 번인), 세이프티 게이트가 실존 인물·IP·
상표·무단 음악을 생성 전에 차단한다.
