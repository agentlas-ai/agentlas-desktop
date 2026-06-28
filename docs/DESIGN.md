# Agentlas Desktop — Design System

데스크탑 렌더러(Next.js)의 디자인 단일 출처. UI를 만들거나 고칠 때 **여기 토큰과 규칙을 먼저 따른다.**
임의 inline 하드코딩(색·그림자·폰트) 금지 — 토큰을 쓴다. 토큰 정의는 `renderer/app/globals.css`의 `:root`.

## 1. 원칙

- **Soft over hard.** 그림자·경계·대비는 부드럽게. "떠 있는 느낌"을 만들되 무겁지 않게.
- **Tokens, not literals.** 색은 `var(--ink/--paper/--accent…)`, 그림자는 `var(--rd-shadow-1…)`, 반경은 `var(--rd-r-md…)`.
- **System font first (desktop).** 데스크탑은 웹폰트를 번들하지 않는다 → 시스템 폰트(SF) 1순위. 커스텀 폰트를
  앞세우면 부분 설치 환경에서 글리프가 섞여 "텍스트가 깨져" 보인다.
- **Density with air.** 정보 밀도는 높되, 카드/섹션 사이 여백(12–16px)과 카드 내부 패딩(14–20px)으로 숨 쉬게.
- **One accent.** 인디고(`--accent #5a56dc`)가 주 강조. 화면당 강조 1개 원칙. 상태색(ok/warn/err)은 의미일 때만.

## 2. Soft Shadows (가장 자주 틀리는 부분)

레퍼런스 규칙: **낮은 opacity + 높은 blur + 큰 Y + 탈채도(쿨) 색**. 하드한 `0 1px 2px`(타이트·검정)은 금지.
음의 spread(`-6px`~`-16px`)로 접점은 좁고 가장자리는 부드럽게 — 진짜 떠 있는 그림자.

| 토큰 | 용도 | 값(light) |
|---|---|---|
| `--rd-shadow-1` | 기본 카드/패널 | `0 1px 2px /.04, 0 6px 20px -6px /.10` |
| `--rd-shadow-2` | 들린 카드/팝오버 | `0 4px 10px -2px /.06, 0 18px 44px -12px /.16` |
| `--rd-shadow-3` | 모달/시트 | `0 8px 18px -4px /.08, 0 36px 80px -16px /.22` |
| `--neu-raised` | 버튼/박스 | `0 1px 2px /.05, 0 4px 12px -2px /.08` |

- 그림자 색은 순검정이 아니라 **탈채도 쿨톤** `rgba(20,22,45, …)`(브랜드 인디고-네이비) → 페이지에 자연스럽게 녹는다.
- 다크 테마는 동일 구조 + 순검정 저opacity·고blur.
- 새 그림자가 필요하면 토큰을 쓰고, 정 없으면 같은 공식(저opacity/고blur/음의 spread)으로.

## 3. Color

- Ink: `--ink #0b0b0f`, `--ink-soft`, `--muted-deep`, `--muted`. 본문=ink, 보조=ink-soft, 캡션=muted-deep.
- Surface: `--paper #fff`, `--paper-2`, `--paper-edge`(경계). rd 계열: `--rd-surface/-2`, `--rd-hair`(헤어라인).
- Accent: `--accent`(인디고). 채움 `--fill-1/-2`, 텍스트 `--rd-accent-text`.
- Status: `--rd-ok/--rd-warn/--rd-err`(또는 green/amber/red-deep). 의미 전달일 때만, 장식 금지.
- **색 위 텍스트**: 같은 색 계열의 진한 톤을 쓴다(순검정/회색 금지).

## 4. Typography

- Family: `--rd-f-display`(제목), `--rd-f-body`(본문), `--rd-f-mono`(로그·코드·수치). 모두 시스템 폰트 1순위.
- Weight: 본문 400, 강조/라벨 600–650. 700+는 큰 제목에만. 한 화면에 굵기 2–3종.
- Size: 본문 13–14px, 캡션 11–12px, 카드 제목 14–16px, 페이지 H1 18–22px. **11px 미만 금지.**
- Case: 한국어/문장형. ALL CAPS는 작은 eyebrow 라벨에만(letter-spacing 약간).

## 5. Spacing & Shape

- Radius: 칩/버튼 `--rd-r-sm(10)`~`--rd-r-xs(8)`, 카드 `--rd-r-md(14)`, 큰 패널 `--rd-r-lg(20)`. 단면 보더에는 둥근 모서리 금지.
- Gap: 카드 사이 12–16px, 카드 내부 패딩 14–20px, 인라인 요소 gap 6–10px.
- Border: 기본 헤어라인 `1px solid var(--rd-hair)` 또는 `--paper-edge`.

## 6. Buttons

- Primary: `background var(--rd-ink)` + `color var(--rd-bg)`(테마 적응). **주의**: `.rd button{color:inherit}`(특이도 0,1,1)가
  단일 클래스 규칙을 이긴다 → 버튼 색 규칙은 `.rd .my-button`처럼 `.rd` 프리픽스로 올려야 글자가 안 사라진다.
- Secondary: 투명 배경 + `1px solid var(--rd-hair)` + hover `--fill-1`.
- 모든 버튼 `border-radius: 999px`(필) 또는 카드 내부는 `--rd-r-sm`.

## 7. 체크리스트 (UI 변경 전/후)

- [ ] 색·그림자·반경·폰트를 토큰으로 썼는가(하드코딩 X)
- [ ] 그림자가 소프트(저opacity/고blur/음의 spread)인가
- [ ] 텍스트 ≥11px, 대비 충분, 다크모드에서도 읽히는가
- [ ] 화면당 강조 1개, 여백 충분, 정렬·간격 일관
- [ ] 새 버튼 글자색이 `.rd button{color:inherit}`에 먹히지 않는가(`.rd` 프리픽스)
