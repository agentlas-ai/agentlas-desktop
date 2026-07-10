// 외부 MCP 툴 카탈로그 — 사용자가 한 번에 연결할 수 있는 "외부 툴" 목록.
// 설정 가이드(setting_guide)의 Slack/Discord/GitHub 같은 통합들이 여기 산다.
//
// 대부분 stdio 트랜스포트로 `npx -y <패키지>` 형태. 연결 시 글로벌 vault의 env가
// 자식 프로세스에 주입된다. URL형(sse/http) MCP 서버도 지원.
//
// 각 항목의 envRequirements는 해당 MCP 서버 README 기준으로 맞춘 값이다(아래 주석 참고).
// docsUrl(서버 문서) + setupUrl(키 발급 페이지)을 함께 제공해 정확성/편의를 높였다.
import type { McpToolCatalogEntry } from "../../shared/types";

export const MCP_TOOL_CATALOG: McpToolCatalogEntry[] = [
  // ── 커뮤니케이션 ──────────────────────────────────────────
  {
    id: "slack",
    name: "Slack",
    nameEn: "Slack",
    description: "채널 메시지 읽기·전송, 스레드 답글, 사용자 조회",
    descriptionEn: "Read/post channel messages, reply in threads, look up users",
    category: "communication",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    setupUrl: "https://api.slack.com/apps",
    brandColor: "#4A154B",
    mark: "S",
    // server-slack README: SLACK_BOT_TOKEN(xoxb-) + SLACK_TEAM_ID 필수
    envRequirements: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Slack 봇 토큰",
        labelEn: "Slack Bot Token",
        required: true,
        hint: "api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...)",
        hintEn: "api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...)",
      },
      {
        key: "SLACK_TEAM_ID",
        label: "Slack 팀 ID",
        labelEn: "Slack Team ID",
        required: true,
        hint: "워크스페이스 설정 또는 URL의 T로 시작하는 ID",
        hintEn: "Workspace settings or the T-prefixed ID in the URL",
      },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    nameEn: "Discord",
    description: "서버·채널 메시지 읽기/전송, 멤버 조회",
    descriptionEn: "Read/send server & channel messages, look up members",
    category: "communication",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-discord"],
    trust: "community",
    docsUrl: "https://github.com/barryyip0625/mcp-discord",
    setupUrl: "https://discord.com/developers/applications",
    brandColor: "#5865F2",
    mark: "D",
    envRequirements: [
      {
        key: "DISCORD_TOKEN",
        label: "Discord 봇 토큰",
        labelEn: "Discord Bot Token",
        required: true,
        hint: "discord.com/developers → 앱 생성 → Bot → Reset Token",
        hintEn: "discord.com/developers → create app → Bot → Reset Token",
      },
    ],
  },

  // ── 개발 ──────────────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    nameEn: "GitHub",
    description: "이슈·PR·코드 검색, 파일 읽기, 리포 관리",
    descriptionEn: "Search issues/PRs/code, read files, manage repos",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    setupUrl: "https://github.com/settings/tokens",
    brandColor: "#24292F",
    mark: "GH",
    // server-github README: GITHUB_PERSONAL_ACCESS_TOKEN
    envRequirements: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub 개인 액세스 토큰",
        labelEn: "GitHub Personal Access Token",
        required: true,
        hint: "github.com/settings/tokens → Fine-grained 또는 classic 토큰",
        hintEn: "github.com/settings/tokens → fine-grained or classic token",
      },
    ],
  },
  {
    id: "filesystem",
    name: "파일 시스템",
    nameEn: "Filesystem",
    description: "허용한 로컬 폴더의 파일 읽기·쓰기·검색 (키 불필요)",
    descriptionEn: "Read/write/search files in folders you allow (no key)",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "~"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    brandColor: "#6B7280",
    mark: "FS",
    // 키 없음 — 허용 폴더 경로를 인자로 받음 (위 args의 "~")
    envRequirements: [],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    nameEn: "PostgreSQL",
    description: "읽기 전용 SQL 쿼리, 스키마 조회",
    descriptionEn: "Read-only SQL queries and schema inspection",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    brandColor: "#336791",
    mark: "PG",
    // 참고: 이 서버는 연결 문자열을 실행 인자로 받는다. 앱은 DATABASE_URL 값을 실행 시 인자로 전달.
    envRequirements: [
      {
        key: "DATABASE_URL",
        label: "PostgreSQL 연결 문자열",
        labelEn: "PostgreSQL connection string",
        required: true,
        hint: "postgres://user:pass@host:5432/dbname (실행 시 인자로 전달됨)",
        hintEn: "postgres://user:pass@host:5432/dbname (passed as a launch argument)",
      },
    ],
  },

  // ── 생산성 ────────────────────────────────────────────────
  {
    id: "notion",
    name: "Notion",
    nameEn: "Notion",
    description: "페이지·데이터베이스 검색, 읽기, 생성",
    descriptionEn: "Search, read, and create pages & databases",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    trust: "official",
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
    setupUrl: "https://www.notion.so/my-integrations",
    brandColor: "#191919",
    mark: "N",
    // 공식 @notionhq/notion-mcp-server: NOTION_TOKEN (Internal Integration Token, ntn_.../secret_...)
    envRequirements: [
      {
        key: "NOTION_TOKEN",
        label: "Notion 통합 토큰",
        labelEn: "Notion Integration Token",
        required: true,
        hint: "notion.so/my-integrations → New integration → Internal Integration Token",
        hintEn: "notion.so/my-integrations → New integration → Internal Integration Token",
      },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    nameEn: "Linear",
    description: "이슈 생성·검색·업데이트, 프로젝트 조회",
    descriptionEn: "Create/search/update issues, view projects",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-linear"],
    trust: "community",
    docsUrl: "https://github.com/tacticlaunch/mcp-linear",
    setupUrl: "https://linear.app/settings/api",
    brandColor: "#5E6AD2",
    mark: "L",
    envRequirements: [
      {
        key: "LINEAR_API_KEY",
        label: "Linear API 키",
        labelEn: "Linear API Key",
        required: true,
        hint: "linear.app → Settings → Security & access → API → Personal API key",
        hintEn: "linear.app → Settings → Security & access → API → Personal API key",
      },
    ],
  },

  // ── 웹 / 컴퓨터 유즈 ──────────────────────────────────────
  {
    id: "hephaestus-network",
    name: "Hephaestus Network",
    nameEn: "Hephaestus Network",
    description: "Agentlas Hub/Cloud 에이전트 라우팅, 런타임 번들 준비, Hub 플러그인 해석",
    descriptionEn: "Route Agentlas Hub/Cloud agents, prepare runtime bundles, resolve Hub plugin needs",
    category: "dev",
    transport: "stdio",
    command: "~/.agentlas/runtime/current/bin/hephaestus",
    args: ["mcp", "serve"],
    trust: "official",
    docsUrl: "https://github.com/agentlas-ai/hephaestus",
    brandColor: "#111827",
    mark: "HN",
    envRequirements: [],
  },
  {
    id: "cua-driver",
    name: "CUA Driver",
    nameEn: "CUA Driver",
    description:
      "로컬 데스크톱 앱을 조작·검증하는 Computer Use Driver (MCP, 키 불필요)",
    descriptionEn:
      "Drive and verify local desktop apps with CUA Driver (MCP, no key)",
    category: "web",
    transport: "stdio",
    command: "cua-driver",
    args: ["mcp"],
    trust: "official",
    docsUrl: "https://cua.ai/docs/cua-driver/guide/getting-started/installation",
    setupUrl: "https://cua.ai/docs/cua-driver/guide/getting-started/installation",
    brandColor: "#F97316",
    mark: "CU",
    // 키 없음 — 드라이버 설치와 OS Accessibility/Screen Recording 권한이 필요.
    envRequirements: [],
  },
  {
    id: "playwright",
    name: "Playwright (브라우저)",
    nameEn: "Playwright (browser)",
    description: "실제 브라우저로 웹 탐색·클릭·입력·스크린샷 (컴퓨터 유즈, 키 불필요)",
    descriptionEn: "Drive a real browser — navigate, click, type, screenshot (computer use, no key)",
    category: "web",
    transport: "stdio",
    command: "npx",
    // --user-data-dir: 영속 프로파일(persistent context). 매번 새 임시 브라우저(쿠키·로그인 날아감)
    // 대신 디스크의 프로파일로 띄워, 한 번 로그인하면 다음 실행에도 세션이 유지된다(expandHome가 ~ 확장).
    args: ["-y", "@playwright/mcp@latest", "--user-data-dir", "~/.agentlas/browser-profile"],
    trust: "official",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    brandColor: "#2EAD33",
    mark: "PW",
    // 키 없음 — 로컬 브라우저를 띄워 동작. 첫 실행 시 브라우저 바이너리를 받을 수 있음.
    envRequirements: [],
  },
  {
    id: "agentlas-browser",
    name: "Agentlas 브라우저 (실제 로그인)",
    nameEn: "Agentlas Browser (real login)",
    description:
      "Agentlas 전용 Chrome에서 사용자가 직접 로그인한 세션으로 웹 조작 (개인 Chrome 프로필은 복사하지 않음, 키 불필요)",
    descriptionEn:
      "Drive the web with sessions you sign in to inside Agentlas Chrome; your personal Chrome profile is never copied (general, no key)",
    category: "web",
    transport: "stdio",
    // ~/.agentlas/agentlas-browser-cdp.mjs 는 부팅 시 materializeBrowserCdpLauncher() 가 씀.
    // 전용 로그인 프로필을 원격 디버깅 포트로 띄우고 @playwright/mcp 를 CDP attach 한다.
    command: "node",
    args: ["~/.agentlas/agentlas-browser-cdp.mjs"],
    trust: "official",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    brandColor: "#1D7E67",
    mark: "AB",
    // 키 없음 — 로컬 Chrome 을 CDP 로 띄워 동작. 개인 프로필은 로컬에서만 사용.
    envRequirements: [],
  },
  {
    id: "brave-search",
    name: "Brave 검색",
    nameEn: "Brave Search",
    description: "웹·로컬 검색 (실시간 정보)",
    descriptionEn: "Web & local search (real-time info)",
    category: "web",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    setupUrl: "https://brave.com/search/api/",
    brandColor: "#FB542B",
    mark: "B",
    envRequirements: [
      {
        key: "BRAVE_API_KEY",
        label: "Brave Search API 키",
        labelEn: "Brave Search API Key",
        required: true,
        hint: "brave.com/search/api → 무료 플랜 API 키",
        hintEn: "brave.com/search/api → free-plan API key",
      },
    ],
  },
  // ── 디자인 (AI 티 안 나는 production-grade 산출물) ──────────
  {
    id: "lazyweb",
    name: "Lazyweb 디자인",
    nameEn: "Lazyweb Design",
    description:
      "257k+ 실제 앱 화면 기반 디자인 리서치 — 레퍼런스·경쟁분석·웹사이트 디자인 토큰 추출. 'evidence, not vibes'로 AI 티 안 나는 디자인.",
    descriptionEn:
      "Design research over 257k+ real app screens — references, competitive analysis, design-token extraction. Evidence, not vibes.",
    category: "web",
    transport: "stdio",
    command: "npx",
    // 원격 streamable-HTTP MCP(https://www.lazyweb.com/mcp)를 mcp-remote로 stdio 브리지.
    args: ["-y", "mcp-remote", "https://www.lazyweb.com/mcp"],
    trust: "community",
    docsUrl: "https://github.com/aboul3ata/lazyweb-skill",
    setupUrl: "https://www.lazyweb.com/mcp-install",
    brandColor: "#0B0B0B",
    mark: "Lz",
    envRequirements: [
      {
        key: "LAZYWEB_MCP_TOKEN",
        label: "Lazyweb 토큰",
        labelEn: "Lazyweb token",
        required: true,
        hint: "lazyweb.com/mcp-install에서 무료 발급(가입 불필요)",
        hintEn: "Free token at lazyweb.com/mcp-install",
      },
    ],
  },
  {
    id: "shadcn",
    name: "shadcn/ui 컴포넌트",
    nameEn: "shadcn/ui Components",
    description: "6,000+ 프로덕션급 UI 컴포넌트/블록을 자연어로 검색·설치 (Radix + Tailwind).",
    descriptionEn: "Search & install 6,000+ production-grade UI components/blocks (Radix + Tailwind).",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "shadcn@latest", "mcp"],
    trust: "official",
    docsUrl: "https://ui.shadcn.com/docs/mcp",
    setupUrl: "https://ui.shadcn.com/",
    brandColor: "#000000",
    mark: "sh",
    envRequirements: [],
  },
];

export function getCatalogEntry(id: string): McpToolCatalogEntry | null {
  return MCP_TOOL_CATALOG.find((e) => e.id === id) ?? null;
}
