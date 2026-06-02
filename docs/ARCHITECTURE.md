# AgentlasDesktop — Architecture

PRD [`AgentsAtlas/DESKTOP-APP-PRD.md`](../../AgentsAtlas/DESKTOP-APP-PRD.md) §6 기준 구현 메모. 코드 곳곳에 PRD 섹션 번호로 cross-reference.

## 프로세스 모델

| Process | 책임 | 보안 |
|---|---|---|
| **Main** (`electron/`) | Node API, 파일 시스템, MCP 자식 프로세스 spawn, OS Keychain, SQLite | Node 전권 |
| **Renderer** (`renderer/`) | UI만. `window.agentlas` IPC만 호출 | sandbox: true, contextIsolation: true, nodeIntegration: false |
| **Preload** (`electron/preload.ts`) | contextBridge로 화이트리스트 IPC만 expose | sandbox compatible |

renderer는 노드/파일/네트워크에 직접 접근할 수 없고, 모든 권한 있는 작업은 preload → main으로 raft한다.

## IPC 채널 (PRD §6 — shared/types.ts AgentlasIpc)

| 채널 | 방향 | 페이로드 | 비고 |
|---|---|---|---|
| `runtime:detect` | R→M | — | CLI + BYOK 동시 감지 |
| `runtime:setActive` | R→M | `RuntimeKind` | 활성 백엔드 선택 |
| `secrets:saveApiKey` | R→M | `(backend, key)` | Keychain write only. 키 값은 never sent back |
| `secrets:hasApiKey` | R→M | `backend` | boolean — 키 존재 여부만 |
| `secrets:deleteApiKey` | R→M | `backend` | |
| `team:list` / `install` / `uninstall` | R→M | | SQLite registry |
| `marketplace:listBundles` / `search` | R→M | | M0은 시드, M1은 agentlas.cloud fetch |
| `invoke:run` | R→M | `McpInvocationRequest` | 즉시 `{runId}` 반환 |
| `invoke:event:<runId>` | M→R | `McpInvocationEvent` | 스트리밍 푸시 채널 |

## BYOC 라우팅 (PRD §3.1, §6.4)

```
User prompt → invoke:run → mcp/client.ts.runMcpInvocation
                              ↓
              runtime/detect.ts — 활성 백엔드 결정
                              ↓
        ┌─────────────────────┼─────────────────────┐
   claude-code CLI        codex CLI           gemini CLI         BYOK API
   spawn(args)            spawn(args)         spawn(args)        fetch(...)
                              ↓
                       MCP stdio transport
                              ↓
                  ev → invoke:event:<runId>
```

M0는 mock invocation으로 IPC 채널/타입을 검증한다. M1에서 `@modelcontextprotocol/sdk`의 `StdioClientTransport`로 실제 MCP 서버 spawn.

## Apps 제품 모델

Agentlas Desktop의 상위 사용 단위는 **Apps**다. App은 Electron 안에서 열리는
작은 데스크톱/웹 앱이며, 단순 계산기일 수도 있고 자체 UI, UX, 백엔드 어댑터,
MCP 도구, credential vault 요구사항, 생성 자산, 서브 엔진을 가진 AI-native 앱일
수도 있다.

- **Installed Apps**: 사용자가 설치했거나 채팅에서 생성한 App. Agentlas Desktop
  채팅에서 어떤 AI를 쓰더라도 호출 가능해야 한다.
- **Apps Store**: `agentlas.cloud`와 MCP API가 동기화하는 설치 소스. 운영자가 만든
  App은 private GitHub/GitHub Release/object storage 같은 bundle source에 두고,
  MongoDB에는 marketplace index, manifest URL, 권한, 버전, trust metadata를 둔다.
  MongoDB를 app bundle blob 저장소로 쓰지 않는다.
- **Apps Vault**: App 실행에 필요한 credential/env를 keychain-backed vault로 저장한다.
  vault 자체는 제품이 아니라 App 구동 장치다.
- **Apps Engines**: MCP 서버, backend adapter, browser bridge, generated asset builder처럼
  App을 돌리는 하위 엔진이다.
- **Generated assets**: 문서, 이미지, 리포트, 로컬 파일 등 App 실행 결과물이다. 이들은
  Apps의 부산물이지 별도 top-level 메뉴가 아니다.

현재 concrete proof surface는 `/apps`와 `/apps/document-studio`다. Document Studio는
renderer-only first-party App으로, 라이너식 텍스트 편집과 Genspark식 문서 생성을
Agentlas 안에서 직접 열어 검증할 수 있게 한다. 채팅에서는 `/apps`, `/docstudio`
slash command로 Apps 표면을 열 수 있다.

채팅 입력창의 **Apps Generate** 토글은 숨은 apps-generator 경로를 켜는 신호다. 현재
`McpInvocationRequest.appsGenerateMode`가 main runner로 전달되며, runner는 사용자 목표를
Apps package 생성 지시로 감싸서 실행한다. 응답에 App 링크가 없으면 runner가 안정 CTA를
추가하며, 문서/텍스트/라이너/젠스파크 계열 프롬프트는 `/apps/document-studio`로 연결한다.
향후 실제 App runtime/manifest가 추가되면 이 플래그가 App scaffold, renderer route,
vault requirements, MCP engine wiring으로 확장된다.

## 데이터 영구성

- **SQLite** (`userData/agentlas.sqlite`) — 설치 에이전트, 활성 백엔드 선택, 채팅 런(로컬 only).
- **Keychain** — API 키 only. 키 값은 main 프로세스에서만 읽고, MCP 자식 env로 주입.
- **클라우드 동기화** (PRD §6.3) — M2부터. 팀 구성만 동기화. 채팅 로그는 default off.

## 보안 (PRD §6.2)

1. **MCP 설치 게이트**: Cargo Trust A/B만 통과. `electron/mcp/registry.ts.installAgent`가 enforce.
2. **권한 요청 모달**: M1 — MCP 서버가 파일/네트워크 액세스 요청 시 1-tap approval.
3. **Entitlement 최소화**: `build-resources/entitlements.mac.plist` — Hardened Runtime, sandbox 호환.
4. **외부 링크는 기본 브라우저로**: `main.ts.setWindowOpenHandler`.
5. **CSP**: M1에서 renderer에 명시적 CSP 메타 추가.

## 빌드 / 배포

```bash
npm run build           # tsc(electron) + next build + export(renderer)
npm run package:mac     # electron-builder → release/Agentlas-<v>-<arch>.dmg
npm run release:mac:verify
```

Public release is intentionally blocked unless `release:mac:verify` passes:

- `hdiutil verify` for both DMGs.
- `xcrun stapler validate` for both DMGs.
- `spctl -a -t open --context context:primary-signature` for both DMGs.
- No AppleDouble `._*` files in `release/`.

Notarization은 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env로 주입. Developer ID signing은 `CSC_LINK` / `CSC_KEY_PASSWORD` 또는 GitHub Actions의 `MAC_DEVELOPER_ID_CERTIFICATE` / `MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD` secret으로 주입. CI release workflow는 repo root의 `.github/workflows/agentlas-desktop-release.yml`.

## 디자인 시스템 미러 (PRD §7)

`renderer/app/globals.css`가 `AgentsAtlas/app/src/components/paper/tokens.ts`의 색/폰트 토큰을 CSS variable로 1:1 미러한다. 변경 시 두 곳을 동시에 업데이트해야 한다. M2에서 토큰을 별도 npm 워크스페이스 패키지로 분리해서 단일 source of truth로 정리.

데스크톱 톤다운: 여백 ↑, 그림자/회전 ↓ — 매일 쓰는 도구이므로 시각적 노이즈 최소.

## Renderer ↔ Web Portal 분리

- 데스크톱은 **Apps를 실행**하고, 웹은 hosted build/publish/marketplace sync를 맡는다.
- 사용자가 채팅에서 만드는 Apps는 Desktop에서 local-first로 생성하고, 운영자/웹 publish
  경로는 `agentlas.cloud/build`와 Apps Store manifest sync로 이어진다.
- Apps Store 검색 결과는 같은 데이터 모델을 미러 — 웹과 데스크톱 모두 `MarketplaceListing` 타입 사용.
- 로그인은 매직 링크 (M1). 데스크톱은 OAuth deep link `agentlas://auth/callback?...` 처리.
