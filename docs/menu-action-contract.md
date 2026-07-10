# Agentlas Desktop Menu Action Contract

Date: 2026-06-27

## Hub (`/marketplace`)

- Purpose: Agentlas Web Hub와 같은 Registry Hub로, Team, Plugin, Agent를 한 곳에서 찾고 설치한다.
- Team action: Firm은 `firms.install(slug)` 후 `/firm/detail`로 이동하고, bundle은 포함 에이전트를 순차 설치한다.
- Plugin action: `mcpTools.listCatalog()`로 도구를 보여주고 `mcpTools.install(catalogId)`로 로컬 MCP 서버를 등록한다.
- Agent action: `team.install(slug)`로 단일 에이전트를 설치한다.
- Org chart boundary: Firm 설치는 조직도에 생기고, bundle/single agent 설치는 Agents Library/Chat 후보에 생긴다. Plugin 설치는 조직도가 아니라 MCP 도구 레이어에 생긴다.
- Cross screen: 설치된 팀과 에이전트는 Chat 멘션, Agents Library, Sidebar recent context에 나타난다.
- Cross screen: 설치된 플러그인은 Library MCP, Chat plus menu, invocation tool layer에 나타난다.

## Build (`/build`)

- Purpose: 자연어 요청을 Hephaestus build request로 보내고 진행 단계, 산출물, 업로드 경로를 보여준다.
- Build action: native picker capability를 포함한 `hephaestus.build({ request, mode, workspaceGrant })`를 호출하고, main이 capability를 검증한 뒤 build event stream을 표시한다.
- Upload action: private link는 검토용, marketplace는 공개 전 단계로 분리해 보여준다.
- Cross screen: 산출물이 설치되면 Agents Library와 Chat 라우팅 후보에 반영된다.
- Cross screen: Hub 업로드는 Hub/Marketplace에 보일 수 있는 상태로 이어지므로 signed-in 및 review 경계를 노출한다.

## Chat (`/chat`)

- Purpose: 사용자가 에이전트, 팀, 앱, Hephaestus 명령을 한 입력창에서 실행한다.
- Hep toggle action: `hep-cloud`, `hep-network`, `hep-build`, `hep-upload` 중 하나를 선택하면 전송 프롬프트 앞에 해당 명령을 붙인다.
- Plan/Goal action: 기존 plan, goal payload를 유지한다.
- Cross screen: `hep-build`는 Build 메뉴의 산출물과 같은 의미를 갖고, `hep-upload`는 Hub publish 흐름과 연결된다.
- Cross screen: Chat에서 설치 앱을 수정/삭제하면 Apps 화면 목록이 바뀐다.

## Agents (`/library/agents`)

- Purpose: 설치된 에이전트와 팀의 정체성, 메모리, 플레이북, 라우팅, 진화 로그를 쉽게 확인하고 수정한다.
- Identity action: `AGENT.md` 또는 `system-prompt.md`를 읽고 저장한다.
- Memory action: `memory.md`의 Decisions, Gotchas, Open Questions를 읽고 활성화, 승격, Hub 공유 후보 플래그를 관리한다. 실제 원격 업로드는 Hub/Cloud publish 흐름에서 수행한다.
- Playbook action: 실제 파일과 런타임 메타를 기준으로 실행 루프, 라우팅 카드, MCP 요구사항을 보여준다.
- Evolution action: 메모리 규칙을 프롬프트 부록으로 접어 넣는 수동 진화 제안을 저장한다.
- Runtime action: agent, firm, division scope로 CLI/BYOK/Ollama runtime, model, effort override를 저장한다.
- Cross screen: 프롬프트/메모리 변경은 다음 Chat invocation과 team routing에 즉시 영향을 준다.
- Cross screen: 런타임 override는 단일 Chat, firm CEO, division, specialist 실행에서 agent > division > firm > global 순서로 적용된다.

## Apps and Studio (`/apps`, `/apps/*`)

- Purpose: first-party Studio와 생성 앱을 실행 가능한 작업 표면으로 제공한다.
- Studio action: Startup Founder Studio는 `hephaestus.startStudio()`가 반환한 로컬 URL을 iframe으로 표시한다.
- Generated app action: App Factory 목록에서 active 앱만 보여주고 `/apps/generated?id=...`로 이동한다.
- Cross screen: Chat의 apps generate mode와 generated app edit/archive 요청이 Apps 목록에 반영된다.

## Onboarding and Tutorial (`/onboarding`, shell tour)

- Purpose: 첫 사용자가 메뉴 의미를 모르고 헤매지 않게 주요 화면을 짧은 말풍선으로 설명한다.
- Onboarding action: runtime, permission, tour preference를 저장하고 첫 작업 화면으로 보낸다.
- Tutorial action: 셸 진입 후 한 번만 Hub, Build, Studio, Agents, Chat command toggle을 설명하고 dismiss 상태를 저장한다.
- Cross screen: tutorial dismiss는 모든 shell route에서 유지된다.
