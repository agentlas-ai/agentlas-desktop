// Main 프로세스 ↔ Renderer 간 공유 타입.
// renderer/lib/types.ts에서 re-export.

export type RuntimeKind = "claude-code" | "codex" | "gemini" | "byok" | "ollama";

/** LLM 제공자. "ollama"는 로컬 머신에서 도는 오픈 모델(gemma/deepseek 등). */
export type RuntimeBackend = "anthropic" | "openai" | "google" | "ollama" | "upstage";

export interface RuntimeSelection {
  kind: RuntimeKind;
  backend?: RuntimeBackend;
  source?: string;
  /** ollama·BYOK 등 모델을 골라야 하는 LLM에서 활성 모델 이름 (예: "llama3.1", "claude-opus-4-8") */
  model?: string;
  /** BYOK 긴 컨텍스트(1M) opt-in 토글. beta-header 모델에만 의미. (auto 모델은 항상 ON 취급) */
  longContext?: boolean;
  /** 작업량(reasoning effort) — Claude Code `--effort` 전용. "" 또는 미설정이면 기본. */
  effort?: string;
}

/** CLI(Claude/Codex/Gemini)에서 스캔한 슬래시 명령 — 챗 입력 `/` 자동완성에 노출. */
export interface RuntimeCommand {
  /** "/deploy", "/frontend:component" 등 (앞에 / 포함) */
  name: string;
  description: string;
  source: "claude-code" | "codex" | "gemini";
}

export interface RuntimeStatus {
  kind: RuntimeKind;
  backend: RuntimeBackend;
  /** CLI 경로 또는 "byok:<backend>" 또는 "ollama" */
  source: string;
  /** CLI 감지된 버전 — BYOK은 null. ollama는 서버 버전 */
  version: string | null;
  /** 사용자가 현재 이 LLM을 활성으로 선택했는지 */
  active: boolean;
  /** ollama·BYOK 활성 모델 이름. 모델 개념 없는 LLM은 미설정 */
  model?: string | null;
  /** ollama가 로컬에 받아둔 모델 목록 (설정 화면의 모델 선택용). 그 외 LLM은 미설정 */
  availableModels?: string[];
  /** BYOK 긴 컨텍스트(1M) 토글 상태. beta-header 모델에서만 의미 있음. */
  longContextEnabled?: boolean;
  /** 작업량(reasoning effort) 현재 선택값 — claude-code 전용. 미설정이면 기본. */
  effort?: string | null;
  /** 이 런타임이 지원하는 작업량 레벨 — `claude --help` 파싱으로 자동 동기화. claude-code만 채움. */
  efforts?: Array<{ id: string; label: string }>;
}

/**
 * 에이전트가 동작하려면 필요한 환경변수 1개.
 * 예: Notion 통합 에이전트는 NOTION_API_KEY 필요.
 *
 * 데스크톱 글로벌 vault(keychain)에 한 번 저장하면 모든 에이전트가 재사용.
 * MCP 서버 spawn 시 자식 프로세스 env로 자동 주입 (M1).
 */
export interface AgentEnvRequirement {
  /** env 키 이름 — 외부 표준 따라가는 게 좋음 (NOTION_API_KEY 등) */
  key: string;
  label: string;
  labelEn: string;
  /** false면 없어도 동작은 함 (제한된 기능) */
  required: boolean;
  /** 어디서 얻는지 한 줄 안내 (URL이면 클릭 가능하게) */
  hint?: string;
  hintEn?: string;
}

export interface InstalledAgent {
  id: string;
  slug: string;
  /** 한국어 표시명 (기본 / fallback) */
  name: string;
  /** 영어 표시명. 비어있으면 name fallback */
  nameEn: string;
  /** 한국어 한 줄 설명 */
  tagline: string;
  /** 영어 한 줄 설명 */
  taglineEn: string;
  /** LLM에 보낼 시스템 프롬프트 — 단일. LLM이 사용자 입력 언어에 자동 매칭 */
  systemPrompt: string;
  mcpServers: string[];
  /** 이 에이전트가 동작에 필요한 env 변수들 */
  envRequirements: AgentEnvRequirement[];
  preferredBackend: RuntimeBackend | null;
  trustGrade: "A" | "B" | "C" | "unknown";
  installedAt: string;
  tone: "blue" | "green" | "purple" | "amber" | "peach";
  /** 로컬 폴더에서 임포트한 경우: 전용 CLI 런타임 라벨 (claude-code/codex/gemini/cursor/generic) */
  runtimeLabel?: "claude-code" | "codex" | "gemini" | "cursor" | "generic";
  /** 로컬 임포트 원본 폴더 절대경로 (있으면 파일 패널이 이 폴더를 사용) */
  localPath?: string;
  /** 단일 에이전트 / 팀 */
  kind?: "agent" | "team";
}

/**
 * UI용 env 메타 — 값 자체는 main에만, renderer는 hasValue boolean만 받는다.
 */
export interface EnvVarMeta {
  key: string;
  hasValue: boolean;
  /** 이 env를 요구하는 설치된 에이전트들 (없으면 사용자가 직접 추가한 free-form) */
  requiredBy: Array<{
    agentId: string;
    agentName: string;
    agentNameEn: string;
    /** 그 에이전트의 envRequirements에서 따온 라벨 — 키별로 다른 라벨 가능 */
    label?: string;
    labelEn?: string;
    hint?: string;
    hintEn?: string;
  }>;
}

export interface TeamBundle {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  persona: string;
  agents: Array<Pick<InstalledAgent, "slug" | "name" | "nameEn" | "tagline" | "taglineEn" | "tone">>;
}

export interface MarketplaceListing {
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  trustGrade: "A" | "B" | "C" | "unknown";
  installCount: number;
  manifestUrl: string;
}

export interface MarketplaceSourceStatus {
  mode: "mcp" | "memory";
  baseUrl: string | null;
  online: boolean;
  usingFallback: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
}

// ── 외부 MCP 툴 플러그인 (Slack / Discord / GitHub 등 — Codex 스타일) ──
// 에이전트의 mcpServers(문자열 ID)와 별개. 이것은 "실제로 연결되는 외부 MCP 서버"다.
// @modelcontextprotocol/sdk로 stdio(npx) 또는 SSE/HTTP로 붙는다.
export type McpTransport = "stdio" | "sse" | "http";

/** 연결 가능한 외부 MCP 툴 카탈로그 항목 — 설정 가이드(setting_guide)의 외부 툴. */
export interface McpToolCatalogEntry {
  id: string; // "slack" | "discord" | "github" | "notion" ...
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  category: "communication" | "dev" | "productivity" | "data" | "web" | "custom";
  transport: McpTransport;
  /** stdio 실행 명령 (예: "npx") */
  command?: string;
  /** stdio 인자 (예: ["-y", "@modelcontextprotocol/server-github"]) */
  args?: string[];
  /** sse/http 엔드포인트 URL */
  url?: string;
  /** 이 서버가 동작하려면 필요한 env — 글로벌 vault 키와 매핑된다 */
  envRequirements: AgentEnvRequirement[];
  /** "공식 MCP 서버" 배지 */
  trust: "official" | "community";
  docsUrl?: string;
  /** 키/토큰을 발급받는 페이지 (UI에 "키 발급 →" 링크) */
  setupUrl?: string;
  /** 로고 타일 배경색 (브랜드 컬러) */
  brandColor?: string;
  /** 로고 타일 모노그램 (1–2자) */
  mark?: string;
}

/** 사용자가 설치/구성한 MCP 서버 (SQLite에 영구화). */
export interface InstalledMcpServer {
  id: string;
  /** 카탈로그 출신이면 카탈로그 id, 커스텀이면 null */
  catalogId: string | null;
  name: string;
  nameEn: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** 이 서버가 쓰는 글로벌 env 키 목록 (값은 keychain) */
  envKeys: string[];
  enabled: boolean;
  installedAt: string;
}

/** 연결 상태 + 노출하는 툴 목록. test() / status()가 반환. */
export interface McpServerStatus {
  id: string;
  connected: boolean;
  tools: Array<{ name: string; description?: string }>;
  error: string | null;
  /** 아직 값이 없는 필수 env 키 — 연결 막힘 원인 */
  missingEnv: string[];
  checkedAt: string;
}

// ── Firm = 위계 조직을 가진 에이전트 회사 풀패키지 ──────────
// Agentlas 웹의 핵심 — 데스크톱은 설치된 firm을 갖고 채팅/자동화.
//
// 예: "쇼핑몰 운영 풀패키지"
//   CEO (오케스트레이터 에이전트) — 사용자 명령 수신, 부서장에게 위임
//   ├─ 콘텐츠 부서장 → 상품설명 작가, 광고 카피라이터
//   ├─ CS 부서장 → CS 답변 도우미, 리뷰 모니터
//   └─ 분석 부서장 → 가격 스카우터, 키워드 발굴자
export interface FirmOrgNode {
  /** 이 노드의 에이전트 slug */
  agentSlug: string;
  /** "CEO" / "마케팅 부서장" / "디자이너" 같은 회사 내 역할 */
  role: string;
  /** 상사 agentSlug — null이면 최상위(CEO) */
  reportsTo: string | null;
}

export interface FirmListing {
  /** 마켓 slug */
  slug: string;
  /** 회사 이름 (한국어) */
  name: string;
  nameEn: string;
  /** 한 줄 설명 (한국어) */
  tagline: string;
  taglineEn: string;
  /** ICP / 페르소나 */
  persona: string;
  /** CEO 에이전트 slug (orgChart에 반드시 포함, reportsTo === null) */
  ceoSlug: string;
  /** 조직도 */
  orgChart: FirmOrgNode[];
  /** 의존하는 모든 에이전트 slug (설치 시 한꺼번에 install) */
  agentSlugs: string[];
}

export interface InstalledFirm {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  persona: string;
  /** orgChart의 CEO 에이전트 id (installed_agents.id, slug 아님) */
  ceoAgentId: string;
  /** orgChart의 각 노드를 installed agent id로 resolve */
  orgChart: Array<FirmOrgNode & { agentId: string }>;
  installedAt: string;
}

// ── 정규화된 3-tier 조직 스펙 (멀티 에이전트 오케스트레이션의 입력) ──────
// firm.orgChart(또는 LLM 리졸버)를 CEO → 본부(division) → 전문가(specialist)
// 3계층으로 정규화한다. 오케스트레이터는 이 스펙만 보고 실행하므로 소스(시드/임포트)와 분리된다.
export interface ResolvedNode {
  /** 안정적 id — 실 installed agent면 그 id, 아니면 slug/role 파생 */
  id: string;
  /** 표시 이름 */
  name: string;
  /** 회사 내 역할 ("CEO" / "마케팅 본부장" / ...) */
  role: string;
  /** 실제 installed agent에 매핑되면 그 id (없으면 라벨/리졸버 생성 노드) */
  agentId?: string;
  /** 이 노드를 실행할 시스템 프롬프트 (에이전트 프롬프트 또는 리졸버 생성). */
  prompt?: string;
  /** 인라인 prompt 대신 런타임에 읽을 프롬프트 파일 절대경로 (리졸버 출력용). */
  promptFileRef?: string;
}

export interface ResolvedDivision extends ResolvedNode {
  /** 이 본부 산하 전문가 (tier 3, ephemeral worker) */
  specialists: ResolvedNode[];
}

export interface ResolvedOrg {
  /** 어떻게 만들어졌는가 — orgChart 파생 / LLM 리졸버 */
  source: "orgchart" | "resolver";
  ceo: ResolvedNode;
  /** tier 2 본부들. 비어있으면 = 단일 에이전트처럼 CEO만 실행 */
  divisions: ResolvedDivision[];
  /** 리졸버가 생성한 경우 원본 팀 폴더 절대경로 (재-resolve·sidecar용) */
  sourcePath?: string;
  /** 만들어진 시각 (ISO) */
  resolvedAt?: string;
}

// ── 프로젝트 / 채팅 (Claude Desktop / Codex 스타일) ──────────
export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** 프로젝트의 기본 에이전트 (선택). 없으면 채팅마다 골라야 함 */
  defaultAgentId: string | null;
  /** 프로젝트 단위로 시스템 프롬프트에 더 얹을 컨텍스트 */
  contextNote: string | null;
  /** 이 프로젝트의 작업 폴더(절대경로). 이 프로젝트의 채팅은 이 폴더를 기본 cwd로 사용 + .agentlas 메모리 활성화 */
  folderPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  /** 프로젝트 소속이면 그 id, 아니면 null */
  projectId: string | null;
  /** 회사 채팅이면 firm id, 아니면 null. firmId가 있으면 agentId = firm.ceoAgentId */
  firmId: string | null;
  /** 이 채팅에 묶인 에이전트 (개별) 또는 firm의 CEO 에이전트 */
  agentId: string;
  /** 'user'(일반, 사이드바 노출) | 'division'(백그라운드 본부/자동화 세션, 숨김) */
  kind: "user" | "division";
  /** 사용자 첫 메시지로 자동 생성된 제목 (사용자 rename 가능) */
  title: string;
  /** 보관 시각 — null이면 활성, 있으면 사이드바에서 숨김 (보관함에서만 보임) */
  archivedAt: string | null;
  createdAt: string;
  /** 마지막 메시지 시각 — 사이드바 정렬 키 */
  updatedAt: string;
}

export interface ChatHistoryEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** 사용자 메시지에 첨부된 이미지 — 영구화는 V1, 현재는 in-flight만 */
  imageDataUrls?: string[];
}

// ── 자동화 (M0 stub — UI만 구현, 실제 cron은 M1) ────────────
export interface Automation {
  id: string;
  name: string;
  /** "매일 9시", "매주 월 14:00" 같은 사용자 친화 텍스트 */
  scheduleHuman: string;
  /** 자동화 타깃: "agent"면 agentId, "firm"이면 firmId (CEO 호출) */
  targetType: "agent" | "firm";
  /** targetType에 따라 installed_agents.id 또는 installed_firms.id */
  targetId: string;
  /** 실행 시 사용자 입력 대신 들어갈 프롬프트 템플릿 */
  promptTemplate: string;
  enabled: boolean;
  /** 'user'(폼에서 사람이 생성) | 'agent'(채팅에서 에이전트가 `## Automation` 블록으로 생성) */
  createdBy: "user" | "agent";
  createdAt: string;
  lastRunAt: string | null;
  /** 다음 실행 예정 시각(ISO). 스케줄러가 이 값으로 due 판단 후 재계산 */
  nextRunAt: string | null;
}

// ── invocation ───────────────────────────────────────────────
export interface ImageAttachment {
  /** "image/png" | "image/jpeg" | "image/gif" | "image/webp" */
  mediaType: string;
  /** base64 (data: 접두사 없이 순수 인코딩) */
  data: string;
}

export interface McpInvocationRequest {
  /** 새 모델: chatId 기반. 에이전트는 chat에서 lookup */
  chatId: string;
  userPrompt: string;
  /** 첨부 이미지 — BYOK API는 멀티모달로 전송. CLI는 무시 (warning 추가) */
  images?: ImageAttachment[];
  /** UI 사용자 locale — main이 emit하는 상태/오류 메시지가 이 언어로 나옴.
   *  영어 사용자에게 한국어 status가 새지 않도록 renderer가 항상 동봉. */
  locale?: "ko" | "en";
  /** 도구 사용 권한 수준 (ChatInput 권한 칩) — 런타임 권한 모드로 매핑 */
  permissions?: "read" | "write" | "full";
  /** 목표 추진 모드 — 사용자의 요청을 지속 가능한 목표로 구조화한다. */
  goalMode?: boolean;
  /** 채팅 목표를 Agentlas 안에서 실행되는 Apps 패키지로 생성하도록 요청한다. */
  appsGenerateMode?: boolean;
}

export interface McpInvocationEvent {
  kind: "thinking" | "tool-use" | "partial" | "final" | "error";
  status?: string;
  text?: string;
  error?: { code: string; message: string };
  /** 도구 호출 이벤트 — Claude Code식 접기/펴기 블록용 (이름 + 인자 JSON) */
  tool?: { name: string; args?: string };
  /** 생성 토큰 수 (final에 동봉) — "N tokens" 표시용 */
  tokens?: number;
  // ── 멀티 에이전트 속성 (firm 오케스트레이션) — 없으면 단일 CEO/에이전트 ──
  /** 이 이벤트를 낸 노드의 안정 id (ResolvedNode.id) — 네트워크 패널 per-agent 버킷 키 */
  agentId?: string;
  /** 표시 이름 */
  agentName?: string;
  /** 회사 내 역할 ("CEO" / "마케팅 본부장" / ...) */
  role?: string;
  /** 계층: 1=CEO, 2=본부, 3=전문가 */
  tier?: 1 | 2 | 3;
  /** 오케스트레이션 단계 — plan(위임 결정) / delegate(하위 실행) / synthesize(종합) */
  phase?: "plan" | "delegate" | "synthesize";
  /** 위임 흐름 표시용 — 이 노드가 위임한 대상 노드 id들 (handoff 엣지) */
  delegateTo?: string[];
}

/** 워킹 폴더 트리의 한 엔트리 — lazy expand. dir이면 hasChildren 힌트로 chevron 표시. */
export interface WorkspaceNode {
  name: string;
  /** 절대 경로 — 다음 expand 요청에 그대로 사용 */
  path: string;
  kind: "dir" | "file";
  size: number;
  hasChildren?: boolean;
  isTextLike?: boolean;
}

export interface DirListing {
  path: string;
  exists: boolean;
  entries: WorkspaceNode[];
}

export interface TextFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  reason?: "binary" | "too-large" | "not-text-ext";
}

/** 로그인 세션 — 백엔드(agentlas.cloud)에서 cookie 기반으로 받아 main에 보관. renderer는 메타만. */
export interface AuthSession {
  /** 로그인되어 있으면 true */
  signedIn: boolean;
  email?: string;
  name?: string;
  workspaceId?: string;
  /** 세션이 만료될 epoch ms — 알 수 없으면 미설정 */
  expiresAt?: number;
}

/** electron-updater의 자동 업데이트 상태. main → renderer로 broadcast. */
export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "not-available"
    | "error";
  /** update-available / update-downloaded 시 채워짐 */
  version?: string;
  /** download-progress의 백분율 (0-100). downloading 상태일 때만 의미 있음 */
  progress?: number;
  error?: string;
}

// ── 마이그레이션 (OpenClaw / Hermes → Agentlas) ──────────────
// 기존 터미널형 에이전트 런처에서 페르소나·API 키·자동화·메모리를 가져온다.
// 값(시크릿)은 절대 renderer로 넘기지 않는다 — preview는 키 "이름"만.
export type MigrationSourceKind = "openclaw" | "hermes";

export interface MigrationApiKeyPreview {
  /** 소스에서 발견된 env 변수 이름 (예: OPENAI_API_KEY) — 값은 포함 안 함 */
  envKey: string;
  /** 인식된 BYOK 백엔드. null이면 글로벌 env vault로 들어감 */
  backend: RuntimeBackend | null;
}

export interface MigrationSourcePreview {
  kind: MigrationSourceKind;
  /** UI 라벨 ("OpenClaw" / "Hermes") */
  label: string;
  /** 디스크에 설정 디렉토리가 있는지 */
  available: boolean;
  /** 스캔한 절대 경로 — 무엇을 읽었는지 사용자에게 투명하게 */
  rootPath: string;
  /** 가져올 페르소나/에이전트. 없으면 null */
  agent: { name: string; personaBytes: number } | null;
  /** 발견된 API 키 (이름만 — 값은 main에만 머묾) */
  apiKeys: MigrationApiKeyPreview[];
  /** 발견된 예약 작업 수 */
  automations: number;
  /** 발견된 메모리/워크스페이스 파일 수 */
  memories: number;
}

export interface MigrationOptions {
  source: MigrationSourceKind;
  /** preview만 — 아무것도 쓰지 않음 */
  dryRun?: boolean;
  /** 이미 가져온 적 있어도 다시 가져옴 (에이전트를 제자리 업데이트) */
  overwrite?: boolean;
  /** API 키를 OS 키체인으로 가져오기 (기본 true) */
  importKeys?: boolean;
}

export interface MigrationResult {
  source: MigrationSourceKind;
  dryRun: boolean;
  agentImported: boolean;
  agentId: string | null;
  agentSlug: string | null;
  /** 실제로 저장한 env 키 이름들 (값 아님) */
  keysImported: string[];
  automationsImported: number;
  projectId: string | null;
  /** UI에 노출할 비치명적 경고 */
  warnings: string[];
}

export interface AgentlasIpc {
  /** Electron 메인이 알려주는 OS 환경 정보 (Apple/Codex/Claude 데스크톱과 동일 패턴) */
  app: {
    /** macOS 시스템 설정의 1순위 언어 — "ko-KR" / "en-US" 등. i18n 자동 감지에 사용 */
    getLocale: () => Promise<string>;
    /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
    getVersion: () => Promise<string>;
  };
  /** 워킹 폴더 — 채팅 우측의 폴더 트리 패널이 사용. read-only. */
  fs: {
    pickDirectory: () => Promise<string | null>;
    listDirectory: (absPath: string, showHidden?: boolean) => Promise<DirListing>;
    readTextFile: (absPath: string) => Promise<TextFilePreview>;
  };
  /** 채팅마다 마지막에 연 워킹 폴더 — SQLite에 저장. null이면 미설정. */
  workspace: {
    get: (chatId: string) => Promise<string | null>;
    set: (chatId: string, absPath: string | null) => Promise<void>;
    /** 네이티브 폴더 선택 다이얼로그 → 선택한 절대경로(취소 시 null) */
    selectFolder: () => Promise<string | null>;
  };
  /** 로그인 — agentlas.cloud 구글 OAuth. BrowserWindow 열고 cookie 추출 → Keychain. */
  auth: {
    /** 현재 세션 메타데이터 — 로그인되어 있지 않으면 signedIn=false */
    getSession: () => Promise<AuthSession>;
    /** Google 로그인 시작 — BrowserWindow를 띄우고 사용자가 끝낼 때까지 await */
    signInWithGoogle: () => Promise<AuthSession>;
    /** 시스템 기본 브라우저(이미 로그인된 크롬 등)로 로그인 — loopback 콜백으로 세션 수신.
     *  웹앱이 desktop callback을 지원하지 않거나 180초 타임아웃 시 signedIn=false (창 방식으로 폴백). */
    signInWithBrowser: () => Promise<AuthSession>;
    signOut: () => Promise<void>;
  };
  /** 자동 업데이트 — electron-updater 래퍼. broadcast는 window.agentlasUpdater.onState로 받음. */
  updater: {
    /** 마운트 직후 현재 상태 동기 조회. broadcast 이전에 새 창이 열려도 onState로 미스되지 않음. */
    getState: () => Promise<UpdaterState>;
    /** 사용자가 "지금 확인" 누름 — 실패해도 throw 안 함 (에러는 broadcast로) */
    check: () => Promise<void>;
    /** "재시작 업데이트" 클릭. downloaded 상태에서만 실제로 동작 */
    install: () => Promise<void>;
  };
  runtime: {
    detect: () => Promise<RuntimeStatus[]>;
    setActive: (selection: RuntimeSelection) => Promise<RuntimeStatus[]>;
    /** CLI 미설치 사용자용 — 고정 명령으로 `npm i -g <pkg>` 실행. 성공 후 detect()로 재인식. */
    installCli: (
      kind: "claude-code" | "codex" | "gemini",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** 시스템 터미널을 열어 CLI 로그인 실행 — 사용자는 브라우저 로그인만 하면 됨. */
    openCliLogin: (
      kind: "claude-code" | "codex" | "gemini",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** CLI(Claude/Codex/Gemini)의 커스텀 슬래시 명령을 스캔 — 매 호출마다 최신. */
    listCommands: () => Promise<RuntimeCommand[]>;
    /** 런타임의 모델 목록을 실시간 조회 — BYOK는 provider /models API, ollama는 동적, CLI는 카탈로그.
     *  하드코딩 대신 실제 소스에서 가져와 자동 동기화 (5분 캐시). */
    listModels: (sel: {
      kind: RuntimeKind;
      backend?: RuntimeBackend | null;
      availableModels?: string[] | null;
    }) => Promise<Array<{ id: string; label: string; tag?: string }>>;
    /** `agentlas` 터미널 CLI 설치 — PATH에 래퍼 스크립트를 둔다. */
    installAgentlasCli: () => Promise<{ ok: boolean; path: string; message: string }>;
  };
  secrets: {
    saveApiKey: (backend: RuntimeBackend, key: string) => Promise<void>;
    hasApiKey: (backend: RuntimeBackend) => Promise<boolean>;
    deleteApiKey: (backend: RuntimeBackend) => Promise<void>;
  };
  /** 글로벌 env vault — 에이전트들이 공유하는 외부 API 키.
   *  값은 macOS Keychain에 저장, renderer는 metadata만 받음.
   *  M1: MCP 서버 spawn 시 envRequirements 매칭해 자동 주입. */
  env: {
    /** 모든 env 키 + 등록 여부 + 어떤 에이전트가 요구하는지 */
    list: () => Promise<EnvVarMeta[]>;
    /** 값 저장 (편집도 동일) */
    set: (key: string, value: string) => Promise<void>;
    /** 값 존재 여부만 — 실제 값은 renderer로 안 보냄 */
    has: (key: string) => Promise<boolean>;
    remove: (key: string) => Promise<void>;
  };
  team: {
    list: () => Promise<InstalledAgent[]>;
    install: (slug: string) => Promise<InstalledAgent>;
    /** 내 에이전트(cargo) 설치 — 로그인 사용자가 agentlas.cloud에서 만든 것 */
    installMine: (id: string) => Promise<InstalledAgent>;
    uninstall: (id: string) => Promise<void>;
    /** 로컬 폴더(기존 에이전트/팀)를 임포트 — 런타임 감지·라벨링 후 라우팅 저장. */
    importLocalFolder: (absPath: string) => Promise<InstalledAgent>;
  };
  /** 에이전트 폴더 파일 — 라이브러리 우측 패널의 파일 목록 + 에디터.
   *  폴더(userData/agents/<slug>/) 내부로만 접근 제한. system-prompt.md 편집은 즉시 적용. */
  agentFiles: {
    /** 폴더를 보장(materialize)하고 최상위 엔트리를 반환 */
    list: (agentId: string) => Promise<DirListing>;
    /** 폴더 내부 파일 본문 읽기 */
    read: (agentId: string, absPath: string) => Promise<TextFilePreview>;
    /** 폴더 내부 파일 저장 (system-prompt.md면 동작 프롬프트도 갱신) */
    write: (agentId: string, absPath: string, content: string) => Promise<{ ok: boolean }>;
  };
  /** 외부 MCP 툴 플러그인 — Slack/Discord/GitHub 등을 실제로 연결한다.
   *  env 값은 글로벌 vault(env)에서 가져와 stdio 자식 프로세스에 주입. */
  mcpTools: {
    /** 연결 가능한 외부 툴 카탈로그 (setting_guide) */
    listCatalog: () => Promise<McpToolCatalogEntry[]>;
    /** 설치/구성된 서버 목록 */
    listInstalled: () => Promise<InstalledMcpServer[]>;
    /** 카탈로그 id로 설치 (env 요구는 vault에 자동 등록) */
    install: (catalogId: string) => Promise<InstalledMcpServer>;
    /** 커스텀 서버 직접 등록 */
    installCustom: (def: {
      name: string;
      transport: McpTransport;
      command?: string;
      args?: string[];
      url?: string;
      envKeys?: string[];
    }) => Promise<InstalledMcpServer>;
    remove: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<InstalledMcpServer>;
    /** 실제로 붙어서 tools/list 해보고 상태 반환 */
    test: (id: string) => Promise<McpServerStatus>;
    /** 활성화된 모든 서버 상태 (env 부족분 포함) */
    status: () => Promise<McpServerStatus[]>;
  };
  marketplace: {
    listBundles: () => Promise<TeamBundle[]>;
    search: (q: string) => Promise<MarketplaceListing[]>;
    listFirms: () => Promise<FirmListing[]>;
    status: () => Promise<MarketplaceSourceStatus>;
    /** 로그인 사용자가 agentlas.cloud에서 만든 내 에이전트 목록. 미로그인/오프라인이면 [] */
    listMine: () => Promise<MarketplaceListing[]>;
  };
  firms: {
    list: () => Promise<InstalledFirm[]>;
    get: (id: string) => Promise<InstalledFirm | null>;
    install: (slug: string) => Promise<InstalledFirm>;
    uninstall: (id: string) => Promise<void>;
    /** 정규화된 3-tier 조직 스펙 (저장된 리졸버 결과 또는 orgChart 파생) */
    getResolvedOrg: (id: string) => Promise<ResolvedOrg | null>;
    /** LLM으로 팀 폴더를 분석해 3-tier 조직 스펙 생성 (임포트 팀용) */
    resolveOrg: (id: string) => Promise<{ ok: boolean; org?: ResolvedOrg; error?: string }>;
  };
  projects: {
    list: () => Promise<Project[]>;
    create: (input: { name: string; defaultAgentId?: string | null; contextNote?: string | null; folderPath?: string | null }) => Promise<Project>;
    get: (id: string) => Promise<Project | null>;
    update: (id: string, patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId" | "folderPath">>) => Promise<Project>;
    remove: (id: string) => Promise<void>;
  };
  chats: {
    /** 최신순 활성 채팅 (보관된 것 제외). 사이드바 "최근 채팅" 섹션에서 사용 */
    listRecent: (limit?: number) => Promise<Chat[]>;
    /** 보관된 채팅 — 보관함 페이지용 */
    listArchived: () => Promise<Chat[]>;
    listByProject: (projectId: string) => Promise<Chat[]>;
    listByFirm: (firmId: string) => Promise<Chat[]>;
    get: (id: string) => Promise<Chat | null>;
    /** firmId가 있으면 firm의 CEO 에이전트로 자동 묶임. agentId 직접 지정도 가능 (개별 에이전트) */
    create: (input: {
      agentId?: string;
      firmId?: string | null;
      projectId?: string | null;
      title?: string;
    }) => Promise<Chat>;
    rename: (id: string, title: string) => Promise<Chat>;
    /** 채팅의 에이전트 변경. firm 채팅이면 firm 해제 후 개별 에이전트 모드로 전환 */
    switchAgent: (id: string, agentId: string) => Promise<Chat>;
    /** 보관 — 사이드바에서 숨김. 채팅·메시지는 그대로 유지 */
    archive: (id: string) => Promise<Chat>;
    /** 보관 해제 — 다시 사이드바에 등장 */
    unarchive: (id: string) => Promise<Chat>;
    /** 영구 삭제 — 메시지까지 cascade */
    remove: (id: string) => Promise<void>;
  };
  automations: {
    list: () => Promise<Automation[]>;
    create: (input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy">) => Promise<Automation>;
    toggle: (id: string, enabled: boolean) => Promise<Automation>;
    remove: (id: string) => Promise<void>;
  };
  /** OpenClaw / Hermes에서 페르소나·키·자동화·메모리를 가져온다.
   *  scan은 디스크를 읽어 preview(이름/개수만) 반환, import는 실제 적용. */
  migration: {
    /** ~/.openclaw, ~/.hermes를 스캔해 가져올 수 있는 것들의 preview */
    scan: () => Promise<MigrationSourcePreview[]>;
    /** preview를 실제 적용 (dryRun이면 적용 없이 결과 형태만) */
    import: (opts: MigrationOptions) => Promise<MigrationResult>;
  };
  /** invoke:run의 chatId가 firm 채팅인지 일반 채팅인지로 자동 라우팅 */
  invoke: {
    run: (req: McpInvocationRequest) => Promise<{ runId: string }>;
    eventChannel: (runId: string) => string;
    /** 진행 중인 실행을 취소 — CLI 자식 프로세스 kill / API fetch abort. 병렬 세션 각각 독립 취소. */
    cancel: (runId: string) => Promise<void>;
    history: (chatId: string) => Promise<ChatHistoryEntry[]>;
    clearHistory: (chatId: string) => Promise<void>;
    /** 현재 실행 중인 chatId 목록 — 사이드바 "실행 중" 인디케이터 초기 시드용. */
    activeChats: () => Promise<string[]>;
    /** 채팅 진입 시 진행 중 실행에 재접속 — 그 chat의 runId + 지금까지 버퍼된 이벤트. 없으면 null. */
    attach: (chatId: string) => Promise<{ runId: string; events: McpInvocationEvent[] } | null>;
  };
}

declare global {
  interface Window {
    agentlas: AgentlasIpc;
  }
}

/** preload가 contextBridge로 노출하는 updater 이벤트 채널 — onState 구독자에게 UpdaterState 푸시. */
export interface AgentlasUpdaterEvents {
  onState: (handler: (state: UpdaterState) => void) => () => void;
}
