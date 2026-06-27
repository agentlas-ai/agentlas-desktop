# Agentlas Desktop Release Recovery

Date: 2026-06-27
Owner: Agentlas Desktop
Mode: AppBridge swarm, Hephaestus Network assisted
Status: in progress

## Problem

최근 데스크톱 개편 과정에서 Hub, Apps, Agents, Build, Chat 입력 표면이 서로 다른 제품처럼 보이고 일부 기능이 실제 IPC와 분리되었다. 출시 전 기준으로 각 메뉴가 하는 일, 눌렀을 때의 실제 동작, 다른 화면에 미치는 영향을 다시 고정하고 구현해야 한다.

## Scope

- Hub는 Agentlas Web Hub의 Team, Plugin, Agent 구조를 데스크톱에 맞게 복원한다.
- Plugin 탭은 데스크톱 내장 MCP 카탈로그와 설치 상태를 직접 사용한다.
- Build는 `hep-build`, `hep-upload`, Hub publish 흐름의 상태와 위험 경계를 명확히 보여준다.
- Chat 입력창은 `hep-cloud`, `hep-network`, `hep-build`, `hep-upload` 명령을 시각 토글로 제공하고 실제 전송 프롬프트에 반영한다.
- Agents는 메모리, 플레이북, 프롬프트, 진화 로그, 라우팅 카드를 쉬운 대시보드로 정리한다.
- Apps와 Studio는 실제 스튜디오 런타임, 로컬 미디어, 생성 앱 상태를 기준으로 검증한다.
- 첫 사용자에게 온보딩과 셸 튜토리얼 말풍선을 제공한다.

## Non Goals

- Hub 공개 배포, 결제, 외부 프로덕션 배포는 이 PRD 범위 밖이다.
- 새 Hephaestus 백엔드 프로토콜을 만들지 않는다. 기존 IPC와 CLI/Hub 라우팅을 우선 사용한다.
- Studio를 새로 재구현하지 않는다. 패키지의 실제 GUI를 임베드한다.

## Menu Contract

상세 계약은 `docs/menu-action-contract.md`를 기준으로 한다. 코드 변경은 이 문서의 메뉴별 책임과 상태 전파를 만족해야 한다.

## Acceptance

- Hub Team, Plugin, Agent 탭이 모두 데이터가 있는 상태로 렌더링된다.
- Plugin 설치 버튼은 `mcpTools.install()`을 호출하고 설치 상태가 UI에 반영된다.
- Chat의 Hephaestus 토글은 선택, 해제, 전송 시 실제 명령 프롬프트 반영까지 동작한다.
- Agents 상세 화면에서 가짜 날짜, 특정 영상 제작 전용 단계, 데모성 카메라 위젯이 일반 에이전트 화면을 오염시키지 않는다.
- Studio 시작은 실제 `hephaestus.startStudio()` 경로로 검증되고, 외부 샘플 미디어 의존이 없어야 한다.
- 온보딩 또는 첫 실행 튜토리얼에서 주요 메뉴가 짧은 말풍선으로 설명된다.
- TypeScript, production build, Playwright UI pass가 통과한다.
- bug-hunter 및 UI/UX 검증 루프에서 5회 연속 새 P0/P1/P2 이슈가 없어야 한다.

## Release Risks

- Hub/Marketplace는 계정 로그인과 네트워크 상태에 따라 데이터 소스가 달라질 수 있으므로 source status를 숨기지 않는다.
- Plugin 설치는 로컬 MCP 서버를 등록하는 작업이므로 토큰 요구사항과 disabled 상태를 명확히 보여준다.
- Agents 파일 편집은 로컬 에이전트 폴더에 직접 쓰므로 저장 버튼과 적용 결과를 즉시 보여준다.
- Studio는 로컬 서버를 띄우므로 포트, Python, launcher security gate 실패를 사용자에게 그대로 보여준다.
