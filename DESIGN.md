# Agentlas Design — Color System

단일 색상 팔레트. **아래 색 외에는 쓰지 않는다.** 모든 컴포넌트는 하드코딩된 hex 대신
`globals.css`의 디자인 토큰(`--rd-*`, 레거시 `--ink/--paper/--accent`)만 참조한다.
토큰 값만 바꾸면 전 화면이 일관되게 따라온다.

## 팔레트 (원천 색 — 이것만 사용)

| 이름 | HEX | 역할 |
|---|---|---|
| Navy (deep) | `#0A2342` | 라이트모드 텍스트(잉크), 다크모드 캔버스 |
| Navy (slate) | `#1D3557` | 강조 텍스트, 다크 표면 |
| Blue (steel) | `#2C6E9B` | **주 액센트** — 버튼·링크·인터랙션 |
| Blue (bright) | `#2C6CB0` | 액센트 대체 / 정보 상태 |
| Blue (light) | `#6EA8DA` | 보조 액센트, 다크모드 액센트 |
| Blue (pale) | `#EAF2F8` | 연한 캔버스/리세스 표면, 다크모드 텍스트 |
| Gray | `#D6D6D6` | 헤어라인·경계·비활성 |
| Off-white | `#FAFAFA` | 부드러운 배경 |
| White | `#FFFFFF` | **페이지 배경(기본)** — 캔버스·카드 |
| Tan (gold) | `#C8A27A` | 따뜻한 보조 강조 / **경고(warn)** |
| Wine | `#8B1E3F` | **오류·위험(err)**, 파괴적 액션 강조 |

배경은 흰색이 기본. 파생색(투명도 rgba, color-mix)은 위 원천 색에서만 만든다.

## 시맨틱 매핑 (globals.css 토큰)

### Light (기본, 배경 흰색)
- `--rd-bg` / `--paper` = `#FFFFFF` (페이지·카드)
- `--rd-bg-soft` / `--paper-2` = `#EAF2F8` (연한 캔버스)
- `--rd-surface-2` = `#F1F6FB` (인풋/리세스)
- `--rd-ink` / `--ink` = `#0A2342` (본문 텍스트)
- `--rd-ink-2/3/4` = navy 투명도 램프
- `--rd-hair` / `--paper-edge` = `#D6D6D6` 계열(navy 12% 헤어라인)
- `--rd-accent` / `--accent` = `#2C6E9B` (주 액센트)
- `--rd-accent-2` = `#6EA8DA` (보조)
- `--rd-accent-text` = `#1D3557` (밝은 배경 위 액센트 텍스트, 대비 확보)
- `--rd-ok` = `#2C6CB0` (긍정 — 팔레트에 초록 없음 → 블루로)
- `--rd-warn` = `#C8A27A` (탄/골드)
- `--rd-err` / `--red-deep` = `#8B1E3F` (와인)

### Dark (네이비 캔버스)
- `--rd-bg` = `#0A2342`, `--rd-surface` = `#16335A`, `--rd-surface-2` = `#20406B`
- `--rd-ink` = `#EAF2F8` (텍스트), 램프는 pale-blue 투명도
- `--rd-accent` = `#6EA8DA` (다크 위 밝은 블루), `--rd-accent-text` = `#8FBFE4`
- `--rd-ok` = `#6EA8DA`, `--rd-warn` = `#D7B48C`, `--rd-err` = `#C25A72` (밝힌 와인)

## 규칙
- **초록/보라/올리브/청록 등 팔레트 밖 색 금지.** 상태색도 팔레트 안에서(ok=블루, warn=탄, err=와인).
- 카테고리 구분이 필요하면 hue가 아니라 명도/채도(navy↔blue↔light-blue)와 라벨로.
- 새 컴포넌트는 hex 직접 쓰지 말고 토큰 참조. 부득이한 파생은 `color-mix(in oklch, var(--rd-accent) N%, …)`.
- 액센트는 한 곳에 집중(주로 블루). 와인은 위험/파괴에만, 탄은 따뜻한 보조에만 아껴서.
