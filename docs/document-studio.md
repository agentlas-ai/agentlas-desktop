# Document Studio — 설계 (v2, "진짜 연구 문서 워크스페이스")

목표: apps 런처의 `document-studio`를 **광고된 모든 기능이 목업 없이 실제 작동하는** 연구 문서
작성 도구로 완성한다. 폴백·가짜 데이터·표시전용 위젯 금지(사용자 독트린 "폴백금지").

## 왜 (경쟁 리서치)
- **Jenni AI**: AI Edit 툴바(rewrite/shorten/expand/improve/tone), 인용·참고문헌 자동(APA/MLA/Chicago).
- **Paperpal**: 문법·레퍼런스 포맷 검사, 저널 규격 체크.
- **SciSpace**: 논문 코퍼스 기반 초안, 근거 있는 작성.
- 공통 핵심 = ①근거(소스) 기반 생성 ②실제 인용/참고문헌 포맷 ③섹션 단위 AI 편집.

## 아키텍처
```
renderer/app/(shell)/apps/document-studio/page.tsx   — UI (에디터 + 소스 + 인용)
renderer/lib/citations.ts                            — 결정적 인용/참고문헌 엔진(순수 TS)
renderer/lib/document-store.ts                        — 소스/문서 로컬 영속(localStorage)
electron/document/generate.ts                         — LLM 생성/개정(agy→codex 키리스, no-fallback)
  · generateDocumentContent(goal, mode, locale, sources)  — 근거 기반 전체 초안
  · reviseDocumentText(text, action, locale)              — 섹션 편집(expand/rewrite/shorten/improve/tone)
IPC: document:generate / document:revise / document:available
```

## 기능 (전부 실작동)
1. **소스 매니저** — 구조화 레퍼런스 추가/편집/삭제(type·authors·title·year·container·publisher·vol·issue·pages·url·doi), localStorage 영속. 생성 근거 + 참고문헌 소스.
2. **인용 엔진(결정적)** — APA/MLA/Chicago/IEEE/Harvard의 참고문헌 목록 + 인라인 인용 포맷. 스타일별 제목(References/Works Cited/Bibliography). 커서 위치에 인라인 인용 삽입.
3. **근거 기반 생성** — goal+mode+소스 → 초안 + 선택 스타일 참고문헌 자동 첨부. no-fallback.
4. **AI 편집 툴바** — 선택 텍스트 expand/rewrite/shorten/improve/tone(agy/codex). no-fallback.
5. **내보내기** — Markdown(참고문헌 포함) + 스타일 HTML(인쇄가능). 둘 다 실작동.
6. **메트릭** — 단어수·읽기시간·섹션수(실측).

## 인용 규칙 요약(구현 근거)
- APA: 저자-연도, 제목 "References", 이니셜(Last, F. M.), (Author, Year), DOI 포함.
- MLA: 제목 "Works Cited", 전체이름(Last, First), (Author page).
- Chicago(author-date 변형 채택): 제목 "Bibliography", (Author Year).
- IEEE: 번호 [1], 참고문헌 숫자순, 인라인 [n].
- Harvard: 저자-연도(APA 유사), 제목 "References".

## 원칙
- LLM 미연결/실패 시 가짜 생성 금지 → 명시적 에러(agy/codex 연결 안내).
- 인용 엔진은 순수 함수 → 격리 하네스로 유닛 검증.
- 모든 변경 typecheck 0/0 + 실동작 검증 후 완료 처리.
