// Main 프로세스 ↔ Renderer 간 공유 타입.
// renderer/lib/types.ts에서 re-export.
import type {
  MultimodalProvider,
  MultimodalProviderStatus,
  MultimodalSettings,
} from "./multimodal";
import type { OberonTitleSpec } from "./oberon-titles";
import type { SiteConversationEntry, SiteProjectMeta, SiteProjectOperation, SiteScreenMeta, SiteWorkspaceHandoff } from "./site-studio";
import type { MobileBridgePairingPayload } from "./mobile-bridge";
export type {
  OberonLowerThird,
  OberonSubtitleCue,
  OberonTextStyle,
  OberonTitleCard,
  OberonTitleSpec,
} from "./oberon-titles";
export type {
  MultimodalModality,
  MultimodalProvider,
  MultimodalProviderMode,
  MultimodalProviderStatus,
  MultimodalSettings,
} from "./multimodal";

export type RuntimeKind = "claude-code" | "codex" | "gemini" | "grok" | "byok" | "ollama";

/** LLM 제공자. "ollama"는 로컬 머신에서 도는 오픈 모델(gemma/deepseek 등). */
export type RuntimeBackend =
  | "anthropic"
  | "openai"
  | "google"
  | "ollama"
  | "upstage"
  | "custom"
  // Anthropic Messages API 호환 서드파티(구독/종량제 코딩 플랜)
  | "glm"
  | "kimi"
  | "deepseek";

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

export type AgentRuntimeOverrideScope = "agent" | "firm" | "division";

export interface AgentRuntimeOverride {
  scope: AgentRuntimeOverrideScope;
  /** agent id, firm id, or `${firmId}:${divisionNodeId}` for division-wide defaults. */
  targetId: string;
  /** User-facing source label such as agent name, firm name, or division role. */
  label?: string | null;
  selection: RuntimeSelection;
  updatedAt: string;
}

export interface AgentRuntimeOverrideSetInput {
  scope: AgentRuntimeOverrideScope;
  targetId: string;
  label?: string | null;
  selection: RuntimeSelection;
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

export type AgentVisibility = "visible" | "background" | "private";

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
  /** 실행 폴더의 권위 출처. Agent Cloud 복원본도 로컬 실행을 위해 localPath를 가진다. */
  assetSource?: "local-import" | "agent-cloud" | "hub";
  /** Agent Cloud 복원본의 검증된 불변 package hash. */
  packageHash?: string;
  /** 단일 에이전트 / 팀 */
  kind?: "agent" | "team";
  /** UI/routing contract: visible user agent, background control agent, or private web-only agent. */
  visibility?: AgentVisibility;
}

/**
 * UI용 env 메타 — 값 자체는 main에만, renderer는 hasValue boolean만 받는다.
 */
export interface EnvVarMeta {
  key: string;
  hasValue: boolean;
  /** 저장된 값의 마스킹 미리보기 (메인에서 생성, 전체 평문 아님). 미저장이면 null. */
  preview?: string | null;
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
  agents: Array<Pick<InstalledAgent, "slug" | "name" | "nameEn" | "tagline" | "taglineEn" | "tone" | "visibility">>;
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
  ownerName?: string;
  publishedAt?: string;
  visibility?: AgentVisibility;
  cloudPackage?: CloudAgentPackageDownload;
  /** Owner restore baseline used only for optimistic Cloud writes. */
  cloudRegistration?: CloudAgentRevisionIdentity;
  kind?: "cloud-callable" | "install-only" | string;
  callable?: boolean;
  routingReady?: boolean;
  routingStatus?: string | null;
  source?: string;
  entityKind?: "agent" | "team" | string;
  perCallCredits?: number;
  verifiedInvocations?: number;
  totalBorrows?: number;
  todayBorrows?: number;
  assetCount?: number;
  agentCount?: number;
  lastRoutingSuccessAt?: string;
  recentFailureRate?: number;
  evalPassRate?: number;
  rating?: number;
  category?: string;
  developer?: string;
  detailUrl?: string;
  installCli?: string;
}

export interface HubAgentBookmark {
  slug: string;
  listing: MarketplaceListing;
  bookmarkedAt: string;
}

export interface HubBookmarkSnapshotEvent {
  bookmarks: HubAgentBookmark[];
  syncedAt: string;
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
/** 엔진 skills/ 디렉토리에서 읽은 주입 가능한 스킬 한 건. */
export interface SkillCatalogEntry {
  slug: string;
  name: string;
  description: string;
}

/** Main-owned exact SKILL.md source selected from the Hephaestus catalog. */
export interface SkillCatalogAsset extends SkillCatalogEntry {
  content: string;
  contentHash: string;
  byteLength: number;
}

export interface AgentFileTextSnapshotUi {
  path: string;
  relativePath: string;
  exists: boolean;
  content: string;
  hash: string;
}

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

export type AgentGroupMemberSource = "installed" | "firm-node" | "hub";
export type AgentGroupMemberStatus = "ok" | "moved" | "missing";

export interface AgentGroupMemberSnapshot {
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  routeLabel: string;
  trustGrade?: InstalledAgent["trustGrade"];
  runtimeLabel?: InstalledAgent["runtimeLabel"];
  entityKind?: string;
  routingStatus?: string | null;
}

export interface AgentGroupMember {
  id: string;
  source: AgentGroupMemberSource;
  /** Stable local installed_agents.id when available. */
  agentId?: string;
  /** Local or Hub slug used for automatic re-resolution after upgrades. */
  agentSlug?: string;
  /** Explicit Hub slug; kept separate so missing Hub catalog entries can warn. */
  hubSlug?: string;
  /** Hub entity namespace. Optional so pre-v0.7.34 slug-only rows keep loading. */
  hubEntityKind?: "agent" | "team";
  /** Firm/org-chart route where the agent was picked. */
  firmId?: string;
  firmSlug?: string;
  /** Resolved org node id or raw firm orgChart agentSlug. */
  nodeId?: string;
  role?: string;
  snapshot: AgentGroupMemberSnapshot;
  addedAt: string;
}

export interface AgentGroupResolvedMember extends AgentGroupMember {
  status: AgentGroupMemberStatus;
  warnings: Array<
    "agent_missing" | "hub_missing" | "route_missing" | "route_changed" | "unsupported_multi" | "unsupported_plugin"
  >;
  /** Latest display/routing metadata, re-resolved from installed agents/org chart/Hub. */
  current?: AgentGroupMemberSnapshot;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  orchestratorName: string;
  members: AgentGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupResolved extends Omit<AgentGroup, "members"> {
  members: AgentGroupResolvedMember[];
  warningCount: number;
}

export interface AgentGroupCreateInput {
  name: string;
  description?: string;
  orchestratorName?: string;
  members: AgentGroupMember[];
}

export interface AgentGroupUpdateInput {
  name?: string;
  description?: string;
  orchestratorName?: string;
  members?: AgentGroupMember[];
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

/** standalone 팀 에이전트의 하위 서브에이전트 해석 결과. */
export interface AgentTeamResolution {
  /** LLM/구조 판정 종류 — 'agent'면 실제로는 싱글(다음 새로고침에 이동). */
  kind: "agent" | "team";
  /** 사용자 대면 서브에이전트(시스템 역할 제외). */
  subAgents: Array<{ name: string; role: string }>;
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

export type OntologySourceScope = "public" | "internal" | "private";
export type OntologySourceKind = "project" | "company" | "personal";

export interface OntologyRegisteredSource {
  path: string;
  scope: OntologySourceScope;
  kind: OntologySourceKind;
  exists: boolean;
  registeredAt?: string;
}

export interface OntologyInboxEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  supported: boolean;
}

export interface OntologyProjectStatus {
  projectId: string;
  projectName: string;
  state: "active" | "needs_project_folder" | "error";
  projectPath: string | null;
  memoryDir: string | null;
  inboxPath: string | null;
  dbPath: string | null;
  configPath: string | null;
  sourceManifestPath: string | null;
  policy: {
    mode: "inbox_and_registered_sources_only";
    neverScanHomeDirectory: true;
    neverScanSiblingProjects: true;
    crossProjectSearchDefault: "disabled";
    privateScopeDefaultSearch: "excluded";
  };
  sources: OntologyRegisteredSource[];
  inboxEntries: OntologyInboxEntry[];
  error?: string;
}

export interface Chat {
  id: string;
  /** 프로젝트 소속이면 그 id, 아니면 null */
  projectId: string | null;
  /** 회사 채팅이면 firm id, 아니면 null. firmId가 있으면 agentId = firm.ceoAgentId */
  firmId: string | null;
  /** 에이전트 조합 채팅이면 그 group id, 아니면 null. firm보다 상위 오케스트레이터 대상이다. */
  agentGroupId: string | null;
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
  /** "계속 라이브로" 모드 — Stormbreaker 연속실행 상한에 닿아도 백그라운드로 넘기지 않고
   *  같은 채팅에서 라이브 스트리밍을 계속 이어간다(수 시간 단위). */
  continuousMode: boolean;
  /** 스웜 모드 — 목표를 작업 그래프로 분해해 여러 워커가 병렬로 협업(emergent A2A). */
  swarmMode: boolean;
  /** 이 채팅에 고용(빌림)된 허브 에이전트 카드 — 메타데이터만(패키지 내용 없음, 복사 방지).
   *  있으면 매 send에 borrowAgents로 자동 재주입된다. 해고(clear) 전까지 유지. */
  hiredAgents: HiredAgentCard[];
}

/** 고용(빌림) 카드 — 허브 에이전트의 로컬 표시용 메타데이터. 시스템 프롬프트/플레이북 등
 *  패키지 내용은 절대 담지 않는다(렌트 경제의 복사 방지 설계). 과금 권위는 허브 서버의
 *  24h 리스이며, 이 카드는 채팅 바인딩과 UI 표시만 담당한다. */
export interface HiredAgentCard {
  slug: string;
  name?: string;
  source?: "hub" | "installed" | "firm-node";
  routeLabel?: string;
  hiredAt: string;
}

/** 사이드바 "고용 중" 로스터 항목 — 리스 표시 캐시 + 기억 둥지 스캔의 합. 읽기 전용. */
export interface HiredRosterItem {
  slug: string;
  /** 라우팅 카드에서 찾은 표시 이름 (없으면 UI가 slug을 보여준다) */
  name?: string;
  nameKo?: string;
  /** 활성 리스 만료 시각 — 없거나 지났으면 "만료됨(재고용 시 기억 그대로)" 카드 */
  leasedUntil?: string;
  leaseActive: boolean;
  /** 기억 둥지 존재 여부 — 재고용 시 이어서 일할 수 있다는 표시 */
  hasMemory: boolean;
  /** 마지막으로 같이 일한 시각 (invocation-ledger.jsonl mtime) */
  lastWorkedAt?: string;
}

/** 에이전트 동시 실행 수(스웜 크기) — 사양 기반 추천 + 사용자 슬라이더값. */
export interface AgentConcurrencyInfo {
  cores: number;
  totalMemGB: number;
  recommended: number;
  current: number;
  hardMax: number;
  userSet: boolean;
}

export interface ChatHistoryEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** 사용자 메시지에 첨부된 이미지 — 영구화는 V1, 현재는 in-flight만 */
  imageDataUrls?: string[];
}

export type TelegramConnectTargetKind = "agent" | "firm" | "group";
export type TelegramConnectStatus =
  | "draft"
  | "bot_verified"
  | "waiting_for_chat"
  | "chat_paired"
  | "test_passed"
  | "running"
  | "failed"
  | "disabled";

export interface TelegramConnectBinding {
  id: string;
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  targetName: string;
  /** True when the bound agent/firm/group no longer exists (deleted target → orphaned port). */
  targetMissing: boolean;
  status: TelegramConnectStatus;
  enabled: boolean;
  sessionRunning: boolean;
  automationReportEnabled: boolean;
  hasToken: boolean;
  tokenPreview: string | null;
  botUserId: number | null;
  botUsername: string | null;
  botDisplayName: string | null;
  telegramChatId: string | null;
  telegramChatTitle: string | null;
  chatSessionId: string | null;
  lastUpdateId: number;
  lastError: string | null;
  lastTestAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramConnectStartInput {
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  /** BotFather token. Stored in Keychain by main; never returned to renderer. */
  botToken: string;
}

export interface TelegramConnectCloneInput {
  sourceBindingId: string;
  targetKind?: TelegramConnectTargetKind;
  targetId?: string;
}

export interface TelegramConnectAutoInput {
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  /** 사용자가 지정한 봇 표시 이름(텔레그램에 보이는 이름). 비우면 "Agentlas <타겟명>" 자동. */
  botName?: string;
}

export interface TelegramConnectActionResult {
  binding: TelegramConnectBinding;
  message: string;
}

// ── 스케줄 트리거 spec — 저장/문법/표시 분리(설계 §2.1) ───────────
// 내부 진실은 이 discriminated union 하나. 프리셋은 별도 kind가 아니라 라벨 붙은 cron.
export type ScheduleSpec =
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "interval"; everyMs: number; anchor: "wallclock" | "lastRun" }
  | { kind: "once"; atIso: string }
  | { kind: "manual" };

// ── 조건 게이트(설계 §3.5) — 트리거 발사 시 or 그래프 워크 중 평가하는 순수 조건 ──────
// P1은 Tier 0(이벤트/체인/스케줄+게이트)만. poll 계열의 cond도 같은 타입을 쓴다.
export interface TriggerCondition {
  /** 비교할 좌변 — 변수명({{var}}) 또는 리터럴 문자열. */
  left: string;
  op: "eq" | "ne" | "contains" | "gt" | "lt" | "gte" | "lte" | "exists" | "changed";
  /** 우변 — 리터럴(연산자가 exists/changed면 무시). */
  right?: string;
}

// ── 트리거 union(설계 §3.5) — "언제 fire하나"만 바꾸는 전위 레이어. 실행 엔진은 불변. ──
// schedule = 기존 시간 트리거(scheduleSpec/scheduleHuman으로 표현, 하위호환).
// 이벤트 계열(fs/chain)은 스케줄러가 아니라 트리거 매니저의 리스너에 등록 → 유휴 0.
export type Trigger =
  | { kind: "schedule"; onlyIf?: TriggerCondition }
  | { kind: "fs"; path: string; on: "create" | "modify" | "delete"; debounceMs?: number; onlyIf?: TriggerCondition }
  | { kind: "chain"; afterAutomationId: string; onlyIf?: TriggerCondition }
  | { kind: "webhook"; token: string; onlyIf?: TriggerCondition }
  | {
      kind: "poll";
      /** 폴 소스 명세(설계 §3.4 Tier 1). 어떤 외부 값을 어떻게 읽을지. */
      source: PollSource;
      cond: TriggerCondition;
      /** 적응형 백오프 하한(변화·임계근접 시 이 간격으로 조임). */
      minIntervalMs: number;
      /** 적응형 백오프 상한(값 안 변하면 여기까지 지수 증가). */
      maxIntervalMs: number;
      /** dedup 커서 — 마지막으로 관측한 값(같으면 재발사 안 함). */
      lastSeen?: string;
    };

export type TriggerKind = Trigger["kind"];

// ── 폴 소스(설계 §3.2, §3.4 Tier 1) — 폴링 강제 트리거의 데이터 소스 명세 ──────
// 폴링은 유일한 실질 비용이므로(설계 §3.1) 적응형 간격 + lastSeen 커서로 통제한다.
// 각 소스는 하나의 스칼라/문자열 값을 관측한다(조건 평가기가 이 값을 좌변으로 쓴다).
export type PollSource =
  | {
      /** 주가/지표 임계값 — stock/alphavantage MCP(GLOBAL_QUOTE/RSI 등). MARKET_STATUS로 게이팅. */
      kind: "stock";
      /** 티커 심볼(예 "AAPL", "005930.KS"). */
      symbol: string;
      /** 관측 지표 — "price"(현재가) | 지표명(rsi 등). 기본 price. */
      metric?: string;
      /** 시장이 닫혀 있으면 폴을 더 늘린다(설계 §3.3 게이팅). 기본 true. */
      gateMarket?: boolean;
    }
  | {
      /** GitHub 이슈/PR 폴링. lastSeen 커서로 새 항목만 발사. */
      kind: "github";
      /** "owner/repo". */
      repo: string;
      /** issues | pulls. 기본 issues. */
      resource?: "issues" | "pulls";
    }
  | {
      /** Slack 채널 새 메시지 폴링(webhook 없을 때). */
      kind: "slack";
      /** 채널 id 또는 "#name". */
      channel: string;
    }
  | {
      /** Notion 데이터베이스 새 항목 폴링. */
      kind: "notion";
      /** 데이터베이스 id. */
      databaseId: string;
    };

// ── 비주얼 워크플로우 그래프(설계 §4.2) ───────────────────────────
// automations 행의 nullable graph_json 컬럼에 직렬화. null = 오늘의 단일-프롬프트 동작.
export type WorkflowNodeType =
  | "trigger" // schedule | manual → schedule 컬럼 미러
  | "agent" // agent.id | firm.id | agentGroupId | borrowAgents[] | swarm | pipeline
  | "tool" // MCP catalog id / 커스텀 → 인접 agent 런타임 MCP 설정에 컴파일
  | "action" // surface action.type / appFactory:* / toolFactory:* / hep-call
  | "condition" // 이전 출력 분기
  | "transform" // 노드 간 변수 map/extract/format
  | "output"; // Slack post / notification / file write / chat surface

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  /** 타입별 자유형 설정(스케줄/에이전트 ref/툴 catalog/변수 produces·consumes 등). */
  config: Record<string, unknown>;
  label?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** condition 노드의 분기 핸들: "true" | "false" | 변수명 라벨. */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// ── run history — 놓친 실행/스킵 가시화(설계 §2.7) ─────────────────
export interface AutomationRunRecord {
  id: string;
  automationId: string;
  /** 이 실행이 겨냥한 예정 시각(ISO). catch-up 시 놓쳤던 슬롯. */
  scheduledFor: string | null;
  /** 실제 실행 시각(ISO). */
  ranAt: string;
  status: "ok" | "error" | "skipped";
  /** 이 실행에서 병합/스킵된 놓친 발생 수. */
  skippedCount: number;
  error: string | null;
}

export type AutomationToolMode = "auto" | "browser" | "computer-use";
export type AutomationHubMode = "hub-allowed" | "hub-first" | "local-only";
export type AutomationTargetType = "agent" | "firm" | "hub";

// ── Browser 기능 (자격증명 볼트 · 전용 프로필 · 승인 게이트 · 로그) ──
export type BrowserSessionStatus = "valid" | "expired" | "none";
export type BrowserApprovalDecision = "once" | "always" | "deny";

export interface BrowserStatus {
  chromeFound: boolean;
  chromePath: string | null;
  profilePath: string;
  cdpPort: number;
}
export interface BrowserSite {
  id: string;
  site: string;
  label: string | null;
  username: string | null;
  session: { status: BrowserSessionStatus; capturedAt: string | null };
  createdAt: string;
  updatedAt: string;
}
export interface BrowserSiteInput {
  site: string;
  label?: string | null;
  username?: string | null;
}
export interface BrowserPermissionEntry {
  site: string;
  actionType: string;
  decision: BrowserApprovalDecision;
}
export interface BrowserActionLog {
  id: string;
  ts: string;
  site: string | null;
  action: string;
  target: string | null;
  result: string | null;
  approval: string | null;
}
/** electron → renderer 로 밀리는 승인 요청(경량 바텀시트가 받는다). */
export interface BrowserApprovalRequestEvent {
  requestId: string;
  site: string;
  actionType: string;
  summary: string;
  target: string | null;
  allowAlways: boolean;
  /** Main-process fail-closed deadline; renderer auto-closes the stale sheet. */
  expiresAt: number;
}

// ── 자동화 — SQLite 영속 + 앱 실행 중 백그라운드 스케줄러 ────────────
export interface Automation {
  id: string;
  name: string;
  /** "매일 9시", "매주 월 14:00" 같은 사용자 친화 텍스트 */
  scheduleHuman: string;
  /** 자동화 타깃: agent=로컬 에이전트, firm=로컬 회사/팀, hub=Agentlas Hub 에이전트 slug */
  targetType: AutomationTargetType;
  /** targetType에 따라 installed_agents.id, installed_firms.id, 또는 Hub agent slug */
  targetId: string;
  /** 실행 시 사용자 입력 대신 들어갈 프롬프트 템플릿 */
  promptTemplate: string;
  /** 자동화가 웹/화면 조작을 해야 할 때 선호하는 실행 도구. */
  toolMode?: AutomationToolMode;
  /** 로컬 도구만 쓸지, Agentlas Hub 후보까지 빌려 쓸지. */
  hubMode?: AutomationHubMode;
  enabled: boolean;
  /** 'user'(폼에서 사람이 생성) | 'agent'(채팅에서 에이전트가 `## Automation` 블록으로 생성) */
  createdBy: "user" | "agent";
  createdAt: string;
  lastRunAt: string | null;
  /** 다음 실행 예정 시각(ISO). 스케줄러가 이 값으로 due 판단 후 재계산 */
  nextRunAt: string | null;
  /** 저장된 워크플로우 그래프(있으면 그래프 러너로 실행). null = 단일 프롬프트. */
  graph?: WorkflowGraph | null;
  /** IANA 타임존(예 "Asia/Seoul"). cron 해석 기준. */
  timezone?: string | null;
  /** 구조화 스케줄 spec(있으면 scheduleHuman 레거시 토큰보다 우선). */
  scheduleSpec?: ScheduleSpec | null;
  /** 트리거 종류(설계 §3.5). 기본 'schedule'(기존 시간 트리거). */
  triggerType?: TriggerKind;
  /** 트리거 상세(fs 경로/chain afterId/webhook token/poll source 등). 'schedule'이면 null. */
  trigger?: Trigger | null;
}

/** 기존 자동화 편집 패치(설계 한계 #7 — 삭제-재생성 대신 in-place 수정). */
export interface AutomationUpdatePatch {
  name?: string;
  scheduleHuman?: string;
  targetType?: AutomationTargetType;
  targetId?: string;
  promptTemplate?: string;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
  scheduleJson?: string | null;
  timezone?: string | null;
  endAt?: string | null;
  maxRuns?: number | null;
  triggerType?: TriggerKind;
  trigger?: Trigger | null;
}

/** launchd LaunchAgent 상태(설계 §2.6). macOS 전용. */
export interface LaunchdStatus {
  /** 이 플랫폼에서 지원되는지(현재 macOS(darwin)만). */
  supported: boolean;
  /** plist가 설치돼 있는지(파일 존재). */
  installed: boolean;
  /** launchd에 로드/부트스트랩돼 실제로 도는지. */
  loaded: boolean;
  /** plist 절대 경로(진단용). */
  plistPath: string;
  /** 마지막 작업 실패 사유(있으면). */
  error?: string;
}

// ── invocation ───────────────────────────────────────────────
export interface ImageAttachment {
  /** "image/png" | "image/jpeg" | "image/gif" | "image/webp" */
  mediaType: string;
  /** 원본 파일명. CLI 런타임에서 임시 파일로 스테이징할 때 사용자 맥락 보존용. */
  name?: string;
  /** base64 (data: 접두사 없이 순수 인코딩) */
  data: string;
}

// ── Agent OS interactive surfaces ─────────────────────────
// Safe, declarative UI artifacts emitted by agents. The model declares data,
// widgets, actions, and provenance; Agentlas renders them through trusted
// components instead of executing arbitrary model-generated code.
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type AgentlasSurfaceLayout =
  | "report"
  | "table"
  | "dashboard"
  | "map-list"
  | "timeline"
  | "workflow"
  | "form"
  | "creative-studio"
  | "service-app"
  | string;

export type AgentlasSurfaceDataType =
  | "table"
  | "timeline"
  | "cards"
  | "metrics"
  | "markdown"
  | "media"
  | "routes"
  | "connectors"
  | "launch-checklist"
  | "pricing"
  | "artifacts"
  | "json"
  | string;

export interface AgentlasSurfaceDataSet {
  type: AgentlasSurfaceDataType;
  columns?: string[];
  rows?: JsonObject[];
  items?: JsonObject[];
  value?: JsonValue;
  summary?: string;
  [key: string]: unknown;
}

export type AgentlasSurfaceWidgetType =
  | "map"
  | "cards"
  | "table"
  | "chart"
  | "timeline"
  | "workflow"
  | "form"
  | "report"
  | "brief-panel"
  | "storyboard"
  | "shot-list"
  | "asset-board"
  | "model-router"
  | "rights-provenance"
  | "export-pack"
  | "cost-summary"
  | "source-matrix"
  | "issue-tree"
  | "app-shell"
  | "service-blueprint"
  | "mcp-builder"
  | "tool-builder"
  | "connector-matrix"
  | "launch-checklist"
  | "pricing-model"
  | "deployment-plan"
  | string;

export interface AgentlasSurfaceWidget {
  type: AgentlasSurfaceWidgetType;
  data?: string;
  title?: string;
  [key: string]: unknown;
}

export type AgentlasSurfaceActionType =
  | "external-link"
  | "agent-followup"
  | "generate"
  | "retry"
  | "copy"
  | "export"
  | "open-file"
  | "scaffold-agent-team"
  | "scaffold-app"
  | "install-mcp"
  | "operate-app"
  | "deploy-preview"
  | "scaffold-tool"
  | "run-tool-smoke"
  | "install-tool-mcp"
  | "materialize-asset-pack"
  | "connect-service"
  | "delegate-browser"
  | "request-credential"
  | "request-payment-approval"
  | "save-as-product"
  | "run-smoke-test"
  | "publish-as-tool"
  | string;

export interface AgentlasSurfaceAction {
  id: string;
  label: string;
  type: AgentlasSurfaceActionType;
  url?: string;
  prompt?: string;
  permission?: "read" | "write" | "full";
  [key: string]: unknown;
}

export interface AgentlasSurfaceProvenance {
  source: string;
  retrievedAt?: string;
  url?: string;
  note?: string;
  [key: string]: unknown;
}

export type AgentlasSurfaceEvidenceKind =
  | "verified"
  | "claimed"
  | "estimated"
  | "unverified"
  | string;

export interface AgentlasSurfaceEvidence {
  id: string;
  kind: AgentlasSurfaceEvidenceKind;
  label?: string;
  source?: string;
  url?: string;
  retrievedAt?: string;
  confidence?: number;
  note?: string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceClaim {
  id: string;
  text: string;
  kind?: AgentlasSurfaceEvidenceKind;
  evidenceIds?: string[];
  status?: "unchecked" | "passed" | "failed" | "needs-review" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceCapability {
  id: string;
  type:
    | "network"
    | "filesystem"
    | "pii"
    | "payment"
    | "payment-method"
    | "credential"
    | "browser-session"
    | "external-api"
    | "model-generation"
    | "human-approval"
    | string;
  purpose: string;
  scope?: string;
  approval?: "none" | "once" | "per-run" | "per-action" | string;
  allowlist?: string[];
  dataClasses?: string[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceBudget {
  currency?: string;
  limit?: number;
  spent?: number;
  approvalThreshold?: number;
  unit?: "surface" | "job" | "session" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceStateField {
  path: string;
  owner: "agent" | "user" | "derived" | string;
  description?: string;
  merge?: "preserve-user" | "replace" | "append" | "derive" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceJob {
  id: string;
  label: string;
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | string;
  costEstimate?: number;
  costSpent?: number;
  currency?: string;
  resumable?: boolean;
  [key: string]: unknown;
}

export interface AgentlasSurfaceDelegationSpec {
  mode?: "agent-operated" | string;
  autonomy?: {
    mode?: "agent-first" | "supervised" | string;
    allowedWithoutPrompt?: string[];
    checkpoints?: string[];
    noDeadEndReasons?: string[];
    destructiveActions?: string[];
    [key: string]: unknown;
  };
  credentials?: JsonObject[];
  payments?: JsonObject[];
  fallbackLadder?: string[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceAppRoute {
  path: string;
  label: string;
  purpose?: string;
  status?: "planned" | "generated" | "wired" | "verified" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceConnectorSpec {
  id: string;
  name: string;
  type: "mcp" | "api" | "oauth" | "database" | "storage" | "payment" | "model" | string;
  purpose?: string;
  auth?: "none" | "api-key" | "oauth" | "user-approval" | string;
  status?: "proposed" | "configured" | "missing-credential" | "verified" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceDeploymentSpec {
  target?: string;
  repoPath?: string;
  command?: string;
  previewUrl?: string;
  readiness?: "concept" | "prototype" | "launch-candidate" | "production" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceBusinessSpec {
  audience?: string;
  offer?: string;
  pricing?: string;
  moat?: string;
  launchMetric?: string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceToolParameterSpec {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | string;
  label?: string;
  description?: string;
  required?: boolean;
  default?: JsonValue;
  [key: string]: unknown;
}

export interface AgentlasSurfaceToolSpec {
  id: string;
  name: string;
  description: string;
  domain?: string;
  kind?: "calculator" | "normalizer" | "scorer" | "extractor" | "validator" | "router" | string;
  purpose?: string;
  inputSchema?: JsonObject;
  parameters?: AgentlasSurfaceToolParameterSpec[];
  outputs?: JsonObject[];
  examples?: JsonObject[];
  safety?: {
    externalCalls?: boolean;
    fileWrites?: boolean;
    requiresApproval?: boolean;
    notes?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgentlasSurfaceAppSpec {
  name: string;
  tagline?: string;
  appType?: "saas" | "internal-tool" | "marketplace-agent" | "automation" | "creative-tool" | string;
  audience?: string;
  valueProp?: string;
  routes?: AgentlasSurfaceAppRoute[];
  connectors?: AgentlasSurfaceConnectorSpec[];
  tools?: AgentlasSurfaceToolSpec[];
  deployment?: AgentlasSurfaceDeploymentSpec;
  business?: AgentlasSurfaceBusinessSpec;
  generatedArtifacts?: string[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceManifest {
  version: "0.1" | string;
  kind: "surface";
  title: string;
  domain: string;
  layout: AgentlasSurfaceLayout;
  /** Launch-ready app/product blueprint when an agent builds a tool it can operate or ship. */
  app?: AgentlasSurfaceAppSpec;
  data: Record<string, AgentlasSurfaceDataSet>;
  widgets: AgentlasSurfaceWidget[];
  actions?: AgentlasSurfaceAction[];
  provenance?: AgentlasSurfaceProvenance[];
  evidence?: AgentlasSurfaceEvidence[];
  claims?: AgentlasSurfaceClaim[];
  capabilities?: AgentlasSurfaceCapability[];
  delegation?: AgentlasSurfaceDelegationSpec;
  budget?: AgentlasSurfaceBudget;
  stateSchema?: { fields?: AgentlasSurfaceStateField[]; [key: string]: unknown };
  jobs?: AgentlasSurfaceJob[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  title: string;
  domain: string;
  layout: string;
  manifest: AgentlasSurfaceManifest;
  state: JsonObject;
  provenance: AgentlasSurfaceProvenance[];
  jobSummary?: SurfaceJobCostSummary;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceJobRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  jobId: string;
  label: string;
  status: string;
  costEstimate: number | null;
  costSpent: number | null;
  currency: string | null;
  resumable: boolean;
  manifestJob: AgentlasSurfaceJob;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceJobCostSummary {
  currency: string;
  jobCount: number;
  queuedCount: number;
  runningCount: number;
  pausedCount: number;
  succeededCount: number;
  failedCount: number;
  resumableCount: number;
  costEstimate: number;
  costSpent: number;
  budgetLimit?: number;
  approvalThreshold?: number;
  overLimit: boolean;
  needsApproval: boolean;
}

export interface SurfaceJobUpdateRequest {
  surfaceId: string;
  jobId: string;
  status?: string;
  costSpent?: number;
  note?: string;
}

export interface SurfaceStatePatchRequest {
  surfaceId: string;
  /** JSON Pointer path inside the surface state overlay, e.g. /data/shots/rows/0/status. */
  path: string;
  value: JsonValue;
  actor?: "user" | "agent" | "system" | string;
  label?: string;
}

export interface SurfaceStateEventRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actor: string;
  eventType: "state-patch" | string;
  path: string;
  value: JsonValue;
  previousValue: JsonValue | null;
  label: string | null;
  createdAt: string;
}

export type SurfaceApprovalKind =
  | "capability"
  | "budget"
  | "payment"
  | "credential"
  | "browser-session"
  | "full-permission"
  | string;

export interface SurfaceApprovalRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  actionType: string;
  kind: SurfaceApprovalKind;
  scopeKey: string;
  title: string;
  summary: string;
  metadata: JsonObject;
  revokedAt: string | null;
  createdAt: string;
}

export interface SurfaceApprovalGrantRequest {
  surfaceId: string;
  actionId?: string | null;
  actionType: string;
  kind: SurfaceApprovalKind;
  scopeKey: string;
  title: string;
  summary: string;
  metadata?: JsonObject;
}

export interface SurfaceApprovalCheckRequest {
  surfaceId: string;
  scopeKey: string;
}

export interface SurfaceAssetPackRequest {
  chatId: string;
  surfaceId: string;
  actionId?: string;
  manifest: AgentlasSurfaceManifest;
}

export interface SurfaceAssetPackGeneratedFile {
  path: string;
  kind: "doc" | "manifest" | "html" | "metadata" | "prompt" | "media";
  bytes: number;
}

export interface SurfaceAssetPackRemoteAsset {
  id: string;
  label: string;
  url: string;
  evidenceIds?: string[];
  sourceData?: string;
  status?: "referenced" | "downloaded" | "skipped";
  downloadedPath?: string;
  mediaType?: string;
  bytes?: number;
  reason?: string;
}

export interface SurfaceAssetPackSnapshot {
  packId: string;
  packName: string;
  rootPath: string;
  manifestPath: string;
  indexPath: string;
  assetsPath: string;
  fileUrl?: string;
  createdAt: string;
  files: SurfaceAssetPackGeneratedFile[];
  remoteAssets: SurfaceAssetPackRemoteAsset[];
  summary: string;
}

export type SurfaceAssetPackStatus = "materialized" | "restored" | "archived";

export type SurfaceAssetPackOperationKind = "materialize" | "archive" | "restore";

export interface SurfaceAssetPackRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  packName: string;
  domain: string;
  layout: string;
  rootPath: string;
  manifestPath: string;
  indexPath: string;
  assetsPath: string;
  manifest: AgentlasSurfaceManifest;
  snapshot: SurfaceAssetPackSnapshot;
  status: SurfaceAssetPackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceAssetPackOperationRecord {
  id: string;
  packId: string;
  operation: SurfaceAssetPackOperationKind;
  ok: boolean;
  result: JsonValue;
  createdAt: string;
}

export interface SurfaceAssetPackMaterializeResult extends SurfaceAssetPackSnapshot {
  fileUrl: string;
  record?: SurfaceAssetPackRecord;
}

export interface SurfaceAssetPackRootRequest {
  rootPath: string;
}

export interface AppFactoryScaffoldRequest {
  chatId: string;
  surfaceId: string;
  actionId?: string;
  manifest: AgentlasSurfaceManifest;
}

export interface AppFactoryGeneratedFile {
  path: string;
  kind: "doc" | "source" | "config" | "test" | "data";
  bytes: number;
}

export interface AppFactoryScaffoldSnapshot {
  appId: string;
  appName: string;
  rootPath: string;
  previewPath: string;
  setupPath: string;
  smokePath: string;
  runtimeMode?: "external-local-webapp" | "cloud-manifest" | "legacy-internal-runner" | string;
  launchUrl?: string;
  devCommand?: string;
  localPort?: number;
  createdAt: string;
  files: AppFactoryGeneratedFile[];
  summary: string;
}

export type AppFactoryRuntimeEngine =
  | "generated-app"
  | "cardnews"
  | "document-studio"
  | string;

export interface AppFactoryCloudAppManifestRequest {
  cloudId: string;
  slug: string;
  version: string;
  runtimeEngine: AppFactoryRuntimeEngine;
  minDesktopVersion?: string;
  sourceUrl?: string;
  launchUrl?: string;
  devCommand?: string;
  manifest: AgentlasSurfaceManifest;
  chatId?: string;
  projectId?: string | null;
  agentId?: string;
  surfaceId?: string;
  actionId?: string | null;
  fileCount?: number;
  publishedAt?: string;
  updatedAt?: string;
  metadata?: JsonObject;
}

export type AppFactoryAppStatus =
  | "scaffolded"
  | "cloud-installed"
  | "cloud-synced"
  | "mcp-ready"
  | "operations-ready"
  | "smoke-passed"
  | "smoke-failed"
  | "preview-ready"
  | "tool-published"
  | "restored"
  | "archived";

export type AppFactoryOperationKind =
  | "scaffold"
  | "install-cloud-app"
  | "sync-cloud-manifest"
  | "open-launch-target"
  | "run-autopilot"
  | "install-mcp"
  | "run-provider-tasks"
  | "materialize-assets"
  | "activate-local-commerce-stack"
  | "capture-provider-browser-sessions"
  | "launch-provider-session"
  | "sync-provider-browser-results"
  | "resolve-provider-credentials"
  | "approve-provider-payment"
  | "open-provider-browser"
  | "run-smoke-test"
  | "deploy-preview"
  | "publish-as-tool"
  | "archive"
  | "restore";

export interface AppFactoryAppRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  appName: string;
  domain: string;
  layout: string;
  rootPath: string;
  previewPath: string;
  setupPath: string;
  smokePath: string;
  manifest: AgentlasSurfaceManifest;
  scaffold: AppFactoryScaffoldSnapshot;
  status: AppFactoryAppStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppFactoryOperationRecord {
  id: string;
  appId: string;
  operation: AppFactoryOperationKind;
  ok: boolean;
  result: JsonValue;
  createdAt: string;
}

export interface AppFactoryScaffoldResult extends AppFactoryScaffoldSnapshot {
  record?: AppFactoryAppRecord;
}

export interface AppFactoryCloudAppInstallResult {
  app: AppFactoryAppRecord;
  operation: AppFactoryOperationRecord;
  rootPath: string;
  installed: boolean;
}

export interface AppFactoryRootRequest {
  rootPath: string;
}

export interface AppFactoryLaunchTargetResult {
  rootPath: string;
  target: string;
  mode: "external-url" | "local-file" | "local-folder";
  opened: boolean;
  summary: string;
}

export interface MetaAgentTeamFactoryFile {
  path: string;
  kind: "doc" | "prompt" | "config";
  bytes: number;
}

export interface MetaAgentTeamFactoryRequest {
  chatId: string;
  surfaceId?: string;
  manifest: AgentlasSurfaceManifest;
  baseDir?: string;
}

export interface MetaAgentTeamFactoryResult {
  rootPath: string;
  agent: InstalledAgent;
  firm: InstalledFirm;
  org: ResolvedOrg;
  files: MetaAgentTeamFactoryFile[];
  createdAt: string;
}

export interface AppFactorySmokeResult {
  rootPath: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  testedAt: string;
}

export interface AppFactoryMcpInstallResult {
  rootPath: string;
  configPath: string;
  envPath: string;
  adapters: Array<{
    id: string;
    name: string;
    type: string;
    path: string;
    envKey?: string;
    status: string;
  }>;
  missingCredentials: string[];
  createdAt: string;
}

export interface AppFactoryProviderTaskRunRequest extends AppFactoryRootRequest {
  taskId?: string;
}

export interface AppFactoryProviderBrowserPlan {
  connectorId: string;
  connectorName: string;
  type: string;
  startUrl: string;
  purpose?: string;
  auth?: string;
  envKey?: string;
}

export interface AppFactoryProviderCredentialGate {
  envKey: string;
  label: string;
  connectorId?: string;
  provider?: string;
  scope?: string;
  allowedHosts?: string[];
  allowedOperations?: string[];
  setupUrl?: string;
  brokerMode?:
    | "host-bound-broker"
    | "runtime-env-injection"
    | "provider-managed-oauth"
    | "manual-provider-page"
    | string;
  inputMode: "agentlas-vault" | "provider-page" | "oauth-browser" | string;
  saveTarget: "agentlas-env-vault" | string;
  hasValue?: boolean;
}

export interface AppFactoryProviderPaymentGate {
  merchant: string;
  quoteRequired: boolean;
  amount?: number | null;
  currency?: string | null;
  recurrence: string;
  approvalMode: string;
  cardHandling: string;
  actionId?: string;
}

export interface AppFactoryProviderPaymentApproveRequest extends AppFactoryRootRequest {
  merchant: string;
  quoteRequired?: boolean;
  amount?: number | null;
  currency?: string | null;
  recurrence?: string;
  approvalMode?: string;
  cardHandling?: string;
  actionId?: string;
  scopeKey?: string;
  approvedBy?: string;
  purpose?: string;
}

export interface AppFactoryProviderPaymentApproval extends AppFactoryProviderPaymentGate {
  status: "approved";
  scopeKey: string;
  approvedBy: string;
  approvedAt: string;
  purpose: string;
}

export interface AppFactoryProviderPaymentApproveResult {
  rootPath: string;
  approvalPath: string;
  approval: AppFactoryProviderPaymentApproval;
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderActionRecipe {
  id: string;
  connectorId: string;
  connectorName: string;
  type: string;
  mode: "api-or-browser" | "browser-first" | "local-fallback" | string;
  status: "planned" | "credential-ready" | "secure-checkpoint-required" | string;
  requiredEnvKeys: string[];
  browserStartUrl?: string;
  nextActions: string[];
  checkpoints: string[];
  fallbackProviders: string[];
  resolutionLadder?: string[];
  localFallback?: string;
  humanInputPolicy?: string;
  deadEndPolicy?: string;
  liveGuard: string;
}

export interface AppFactoryProviderResolutionAttempt {
  id: string;
  label: string;
  status: "ready" | "planned" | "needs-secure-input" | "needs-payment-approval" | "not-needed" | "unavailable" | string;
  detail: string;
  artifact?: string;
}

export interface AppFactoryProviderResolutionPlan {
  connectorId: string;
  connectorName: string;
  type: string;
  status: "ready" | "recoverable" | "needs-secure-input" | "contract-violation" | string;
  canProceedWithoutMcp: boolean;
  currentBestPath: string;
  attempts: AppFactoryProviderResolutionAttempt[];
  fallbackProviders: string[];
  deadEndReasonsCovered: string[];
  humanCheckpoints: string[];
  localFallback?: string;
}

export interface AppFactoryProviderNoDeadEndStrategy {
  version: "0.1" | string;
  status: "recoverable" | "contract-violation" | string;
  generatedAt: string;
  fallbackLadder: string[];
  plans: AppFactoryProviderResolutionPlan[];
  violations: string[];
  policy: string[];
  summary: string;
}

export interface AppFactoryProviderTaskResult {
  id: string;
  label: string;
  type: string;
  beforeStatus: string;
  afterStatus: string;
  secureInputRequired: boolean;
  summary: string;
  browserStartUrl?: string;
  vaultEnvKeys?: string[];
  paymentApproval?: AppFactoryProviderPaymentGate;
  humanCheckpoints?: string[];
}

export interface AppFactoryProviderTaskRunResult {
  rootPath: string;
  operationsPath: string;
  providerTasksPath: string;
  resultsPath: string;
  recipesPath: string;
  runbookPath: string;
  tasks: AppFactoryProviderTaskResult[];
  browserPlans: AppFactoryProviderBrowserPlan[];
  credentialGates: AppFactoryProviderCredentialGate[];
  paymentGates: AppFactoryProviderPaymentGate[];
  providerRecipes: AppFactoryProviderActionRecipe[];
  noDeadEndStrategy: AppFactoryProviderNoDeadEndStrategy;
  noDeadEndStrategyPath: string;
  readyCount: number;
  secureInputRequiredCount: number;
  createdAt: string;
  summary: string;
}

export interface AppFactoryAssetMaterializeRequest extends AppFactoryRootRequest {
  budgetApproved?: boolean;
  approvedBy?: string;
  approvalReason?: string;
}

export interface AppFactoryMaterializedAsset {
  name: string;
  path: string;
  sourcePath: string;
  productName?: string;
  kind: string;
  status: string;
  evidenceKind: string;
}

export interface AppFactoryAssetMaterializeResult {
  rootPath: string;
  operationsPath: string;
  assetsDir: string;
  assets: AppFactoryMaterializedAsset[];
  budget: JsonObject;
  createdAt: string;
  summary: string;
}

export interface AppFactoryLocalCommerceActivationRequest extends AppFactoryRootRequest {
  mode?: "sandbox" | "local-first";
  activatedBy?: string;
}

export interface AppFactoryLocalCommerceActivationResult {
  rootPath: string;
  operationsPath: string;
  localDatabasePath: string;
  runtimePath: string;
  checkoutPath: string;
  products: number;
  orders: number;
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderBrowserOpenRequest extends AppFactoryRootRequest {
  connectorId?: string;
}

export interface AppFactoryProviderBrowserOpenResult {
  rootPath: string;
  opened: AppFactoryProviderBrowserPlan[];
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderBrowserSessionRequest extends AppFactoryRootRequest {
  connectorId?: string;
  mode?: "plan-only" | "headless";
  timeoutMs?: number;
  screenshot?: boolean;
}

export interface AppFactoryProviderBrowserSession {
  connectorId: string;
  connectorName: string;
  type: string;
  startUrl: string;
  status: string;
  checkpoints: string[];
  capturedAt: string;
  finalUrl?: string;
  title?: string;
  screenshotPath?: string;
  blockerKind?: string;
  nextAction?: string;
  evidenceKind?: string;
  agentCanContinue?: boolean;
  safeStorage?: string[];
  resumeProfileDir?: string;
  resumeLauncherPath?: string;
  resumeCommand?: string;
  handoffPath?: string;
  actionQueuePath?: string;
  checkpointManifestPath?: string;
  resultPath?: string;
  resultStatus?: string;
  resultSyncedAt?: string;
  resultObservedAt?: string;
  resultSummary?: string;
  credentialContainer?: string;
  error?: string;
}

export interface AppFactoryProviderBrowserSessionResult {
  rootPath: string;
  sessionsPath: string;
  screenshotsDir: string;
  mode: "plan-only" | "headless";
  sessions: AppFactoryProviderBrowserSession[];
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderBrowserLaunchRequest extends AppFactoryRootRequest {
  connectorId?: string;
  approved?: boolean;
  dryRun?: boolean;
}

export interface AppFactoryProviderBrowserLaunchResult {
  rootPath: string;
  ok: boolean;
  connectorId: string;
  connectorName: string;
  status: "dry-run" | "approval-required" | "launched";
  dryRun: boolean;
  launched: boolean;
  approved: boolean;
  pid?: number;
  launcherPath: string;
  resumeCommand: string;
  actionQueuePath?: string;
  handoffPath?: string;
  checkpointManifestPath?: string;
  resultPath?: string;
  actionQueue?: JsonObject | null;
  createdAt: string;
  summary: string;
  safety: string;
}

export interface AppFactoryProviderBrowserResultSyncRequest extends AppFactoryRootRequest {
  connectorId?: string;
}

export interface AppFactoryProviderBrowserResultSyncItem {
  connectorId: string;
  connectorName: string;
  status: "synced" | "pending";
  resultStatus?: string;
  resultPath?: string;
  finalUrl?: string;
  title?: string;
  error?: string;
  observedAt?: string;
  agentCanContinue: boolean;
  summary: string;
}

export interface AppFactoryProviderBrowserResultSyncResult {
  rootPath: string;
  operationsPath: string;
  synced: number;
  pending: number;
  results: AppFactoryProviderBrowserResultSyncItem[];
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderCredentialResolveRequest extends AppFactoryRootRequest {
  source?: "env" | "agentlas-env-vault" | "auto";
}

export interface AppFactoryProviderCredentialResolution {
  envKey: string;
  label: string;
  connectorId?: string;
  provider?: string;
  scope?: string;
  allowedHosts?: string[];
  allowedOperations?: string[];
  setupUrl?: string;
  brokerMode?: string;
  status: "live-credential-ready" | "secure-input-required";
  source: string;
  saveTarget: string;
  inputMode: string;
  fingerprint?: string;
}

export interface AppFactoryProviderCredentialResolveResult {
  rootPath: string;
  resolutionPath: string;
  runbookPath: string;
  credentials: AppFactoryProviderCredentialResolution[];
  resolvedCount: number;
  missingCount: number;
  createdAt: string;
  summary: string;
}

export type AppFactoryAutopilotStepStatus = "completed" | "skipped" | "waiting" | "failed";

export interface AppFactoryAutopilotStep {
  id: string;
  label: string;
  status: AppFactoryAutopilotStepStatus;
  summary: string;
}

export interface AppFactoryAutopilotRequest extends AppFactoryRootRequest {
  budgetApproved?: boolean;
  approvedBy?: string;
  approvalReason?: string;
  credentialSource?: "env" | "agentlas-env-vault" | "auto";
  captureProviderSessions?: boolean;
  browserMode?: "plan-only" | "headless";
  timeoutMs?: number;
}

export interface AppFactoryAutopilotResult {
  rootPath: string;
  appName: string;
  domain: string;
  status: "operated" | "waiting-for-secure-input" | "needs-review";
  steps: AppFactoryAutopilotStep[];
  waitingOn: string[];
  providerRun?: AppFactoryProviderTaskRunResult;
  materializedAssets?: AppFactoryAssetMaterializeResult;
  localStack?: AppFactoryLocalCommerceActivationResult;
  providerBrowser?: AppFactoryProviderBrowserOpenResult;
  providerBrowserSessions?: AppFactoryProviderBrowserSessionResult;
  credentialResolution?: AppFactoryProviderCredentialResolveResult;
  mcp?: AppFactoryMcpInstallResult;
  smoke?: AppFactorySmokeResult;
  preview?: AppFactoryPreviewResult;
  appTool?: AppFactoryAppToolPublishResult;
  createdAt: string;
  summary: string;
}

export interface AppFactoryPreviewResult {
  rootPath: string;
  previewPath: string;
  deployPath: string;
  manifestPath: string;
  fileUrl: string;
  serveCommand: string;
  launchUrl?: string;
  devCommand?: string;
  createdAt: string;
}

export interface AppFactoryAppToolPublishResult {
  rootPath: string;
  toolName: string;
  toolDir: string;
  configPath: string;
  mcpPath: string;
  server: InstalledMcpServer;
  publishedAt: string;
  summary: string;
}

// ── Agentlas Cloud agent packaging / marketplace registration ─────────────
// Packaging and security review run on the submitter's machine. Agentlas Cloud
// receives package hashes, manifests, and review evidence; it must not call a
// platform-owned LLM for this flow.
export type CloudAgentReviewMode = "static-only" | "local-runtime";
export type CloudAgentVisibility = "private-link" | "marketplace";
export type CloudAgentPackageStatus = "ready" | "blocked" | "registered" | "dry-run";

export interface CloudAgentPackageRequest {
  /** Local agent/team/repo folder to package. */
  rootPath: string;
  /** Optional public slug. If omitted, derived from the folder/name. */
  slug?: string;
  /** Defaults to owner-private Agent Cloud storage. Use marketplace only for an explicit public Hub publish. */
  visibility?: CloudAgentVisibility;
  /** true packages and reviews locally but does not call agentlas.cloud. */
  dryRun?: boolean;
  /** static-only is free; local-runtime uses the submitter's active CLI/BYOK/local runtime. */
  reviewMode?: CloudAgentReviewMode;
  /** Optional operator note stored with the registration request. */
  notes?: string;
}

/** Renderer-to-main request. The native picker capability, not a renderer path,
 * authorizes which local package root may be read. */
export type CloudAgentPublishRequest = Omit<CloudAgentPackageRequest, "rootPath"> & {
  rootGrant: FsPathGrant;
};

/** Owner-only Agent Cloud save. Public routing cards and model review do not apply. */
export type CloudAgentPrivateSaveRequest = Omit<
  CloudAgentPublishRequest,
  "visibility" | "reviewMode"
>;

/** Explicit public Agentlas Hub publish. Public routing and review gates apply. */
export type CloudAgentHubPublishRequest = Omit<CloudAgentPublishRequest, "visibility">;

export interface CloudAgentSecurityFinding {
  id: string;
  severity: "blocker" | "high" | "medium" | "low" | "info";
  category: "secret" | "policy" | "size" | "structure" | "runtime" | "network" | "review";
  message: string;
  file?: string;
  remediation?: string;
}

export interface CloudAgentPackageFile {
  path: string;
  bytes: number;
  sha256: string;
  kind: "text" | "binary";
  executable?: boolean;
  included: boolean;
  reason?: string;
}

export interface CloudAgentPackageDownloadFile {
  path: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
  /** Portable execution bit. Raw host permission bits are never transferred. */
  executable?: boolean;
}

export type CloudAgentPackageHashVersion = "path-sha256-v1" | "path-sha256-executable-v2";
export type CloudAgentCloudScope = "owner-private" | "hub-public";

/** Opaque optimistic-concurrency identity returned by Agent Cloud. Revisions
 * are equality tokens only; clients must never infer ordering from them. */
export interface CloudAgentRevisionIdentity {
  cloudId: string;
  slug: string;
  scope: CloudAgentCloudScope;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  revision: string;
  updatedAt?: string;
}

export interface CloudAgentPackageDownload {
  packageHash: string;
  /** Missing means legacy path-sha256-v1. New packages use executable-protected v2. */
  packageHashVersion?: CloudAgentPackageHashVersion;
  fileCount: number;
  totalBytes: number;
  agentKind: "agent" | "team" | "repo";
  runtimeLabels: string[];
  files: CloudAgentPackageDownloadFile[];
  /** Optional owner-restore CAS identity. Package bytes remain independently hashed. */
  cloudId?: string;
  scope?: CloudAgentCloudScope;
  revision?: string;
  updatedAt?: string;
}

export interface CloudAgentPublicCareerGraph {
  schemaVersion?: string;
  kind: "agentlas-public-career-card";
  generatedAt?: string;
  projectName?: string;
  indexStatus?: string;
  policy?: string;
  privacy?: {
    rawLocalPathsIncluded?: false;
    rawPromptsIncluded?: false;
    rawTranscriptsIncluded?: false;
    sourceTextIncluded?: false;
  };
  counts?: Record<string, number>;
  canonicalSources?: number;
  staleSourceCount?: number;
  sourceKinds?: Record<string, number>;
  nodeTypes?: Record<string, number>;
  edgeTypes?: Record<string, number>;
}

export interface CloudAgentPackageManifest {
  version: "0.1";
  kind: "agentlas-cloud-agent";
  slug: string;
  name: string;
  tagline: string;
  agentKind: "agent" | "team" | "repo";
  runtimeLabels: string[];
  visibility: CloudAgentVisibility;
  rootFingerprint: string;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  fileCount: number;
  includedFileCount: number;
  totalBytes: number;
  createdAt: string;
  billingMode: "submitter-local-runtime" | "static-only";
  costOwner: "submitter" | "none";
  security: {
    verdict: "pass" | "fail" | "needs-review";
    blockerCount: number;
    highCount: number;
    findingCount: number;
  };
  careerGraph?: CloudAgentPublicCareerGraph;
}

export interface CloudAgentReviewResult {
  mode: CloudAgentReviewMode;
  verdict: "pass" | "fail" | "needs-review";
  costOwner: "submitter" | "none";
  runtimeLabel?: string;
  summary: string;
  findings: CloudAgentSecurityFinding[];
  reviewedAt: string;
  rawText?: string;
}

export interface CloudAgentRegistrationResult {
  cloudId: string;
  slug: string;
  scope: CloudAgentCloudScope;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  revision: string;
  etag: string;
  url?: string;
  marketplaceUrl?: string;
  registeredAt: string;
  dryRun: boolean;
  /** False means the server commit succeeded but its local CAS receipt could not be persisted. */
  localSyncStored?: boolean;
}

export interface CloudAgentPackageResult {
  status: CloudAgentPackageStatus;
  rootPath: string;
  packageDir: string;
  bundlePath: string;
  manifestPath: string;
  manifest: CloudAgentPackageManifest;
  files: CloudAgentPackageFile[];
  review: CloudAgentReviewResult;
  registration?: CloudAgentRegistrationResult;
  summary: string;
}

export interface ToolFactoryScaffoldRequest {
  chatId: string;
  surfaceId: string;
  actionId?: string;
  toolId?: string;
  manifest: AgentlasSurfaceManifest;
}

export interface ToolFactoryGeneratedFile {
  path: string;
  kind: "doc" | "source" | "config" | "test" | "data";
  bytes: number;
}

export type ToolFactoryToolStatus =
  | "scaffolded"
  | "smoke-passed"
  | "smoke-failed"
  | "mcp-installed"
  | "restored"
  | "archived";

export type ToolFactoryOperationKind =
  | "scaffold"
  | "run-smoke-test"
  | "install-mcp"
  | "archive"
  | "restore";

export interface ToolFactoryScaffoldSnapshot {
  toolId: string;
  requestedToolId: string;
  toolName: string;
  domain: string;
  kind: string;
  rootPath: string;
  configPath: string;
  toolPath: string;
  mcpPath: string;
  smokePath: string;
  createdAt: string;
  files: ToolFactoryGeneratedFile[];
  summary: string;
}

export interface ToolFactoryToolRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  requestedToolId: string;
  toolId: string;
  toolName: string;
  domain: string;
  kind: string;
  rootPath: string;
  configPath: string;
  toolPath: string;
  mcpPath: string;
  smokePath: string;
  scaffold: ToolFactoryScaffoldSnapshot;
  status: ToolFactoryToolStatus;
  installedServerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolFactoryOperationRecord {
  id: string;
  toolId: string;
  operation: ToolFactoryOperationKind;
  ok: boolean;
  result: JsonValue;
  createdAt: string;
}

export interface ToolFactoryScaffoldResult extends ToolFactoryScaffoldSnapshot {
  record?: ToolFactoryToolRecord;
}

export interface ToolFactoryRootRequest {
  rootPath: string;
}

export interface ToolFactorySmokeResult {
  rootPath: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  testedAt: string;
}

export interface ToolFactoryMcpInstallResult {
  rootPath: string;
  configPath: string;
  mcpPath: string;
  command: string;
  args: string[];
  server: InstalledMcpServer;
  installedAt: string;
}

export interface McpInvocationRequest {
  /** 렌더러가 미리 생성한 실행 id — invoke.run 왕복 전에 이벤트 채널을 구독하기 위함
   *  (subscribe-before-trigger). 없으면 main이 randomUUID로 생성한다(하위호환). */
  runId?: string;
  /** 새 모델: chatId 기반. 에이전트는 chat에서 lookup */
  chatId: string;
  userPrompt: string;
  /** 첨부 이미지 — BYOK/Ollama는 멀티모달로, CLI는 읽을 수 있는 로컬 파일로 스테이징해 전송. */
  images?: ImageAttachment[];
  /** UI 사용자 locale — main이 emit하는 상태/오류 메시지가 이 언어로 나옴.
   *  영어 사용자에게 한국어 status가 새지 않도록 renderer가 항상 동봉. */
  locale?: "ko" | "en";
  /** 도구 사용 권한 수준 (ChatInput 권한 칩) — 런타임 권한 모드로 매핑 */
  permissions?: "read" | "write" | "full";
  /** 자동화 등 백그라운드 실행에서 Playwright persistent profile lock을 피하기 위한 MCP 브라우저 프로필 키. */
  mcpBrowserProfileKey?: string;
  /** 자동화가 저장한 실행 도구 선호도. */
  toolMode?: AutomationToolMode;
  /** 자동화가 저장한 Hub 사용 정책. */
  hubMode?: AutomationHubMode;
  /** 계획 모드 — 실행 전에 사용자에게 읽히는 작업 계획과 검증 기준을 먼저 세운다. */
  planMode?: boolean;
  /** 목표 추진 모드 — 사용자의 요청을 지속 가능한 목표로 구조화한다. */
  goalMode?: boolean;
  /** 채팅 목표를 Agentlas 안에서 실행되는 Apps 패키지로 생성하도록 요청한다. */
  appsGenerateMode?: boolean;
  /** 기존 생성 App을 채팅에서 수정/보관할 때 지정하는 대상. */
  targetAppId?: string;
  targetAppAction?: "edit" | "archive";
  /** 추천 시트의 네트워크 모드에서 고른 Hub 에이전트 슬러그 — runMcpInvocation 이 hep-call 로
   *  이들을 빌려와(BYOM) 프롬프트 앞에 borrow 지시를 붙여 데스크탑 런타임으로 실행한다. */
  borrowAgents?: string[];
  /** 추천 시트의 pipeline 모드에서 받은 stage 계약 — 런타임이 단계별 입력/출력 handoff로 실행한다. */
  pipelineStages?: RecStage[];
  /** 저신뢰 라우팅 결정을 호스트 LLM Router Agent로 재판단해야 할 때 전달되는 에스컬레이션. */
  routerAgent?: RecRouterAgent;
}

/** Main-owned Codex-style steering acknowledgement shared by Desktop and Mobile. */
export interface InvocationSteerResult {
  accepted: true;
  queued: boolean;
  activeRunId?: string;
  position?: number;
  runId?: string;
}

export interface MobileBridgeDeviceSummary {
  deviceId: string;
  name: string;
  platform: "ios" | "android";
  appVersion: string | null;
  issuedAt: string;
  revokedAt: string | null;
}

export interface MobileBridgeRuntimeStatus {
  running: boolean;
  endpoint: string | null;
  secure: boolean;
  hostId: string | null;
  devices: MobileBridgeDeviceSummary[];
  error: string | null;
}

export interface McpInvocationEvent {
  kind: "thinking" | "tool-use" | "partial" | "final" | "error" | "surface";
  status?: string;
  text?: string;
  /** partial 델타 스트리밍(무-agentId 메인 스트림 한정) — text(누적 전문) 대신 직전 partial
   *  이후 추가분만 담는다. IPC 페이로드를 O(전체)→O(증분)으로 줄인다. 리플레이/폴백 이벤트는
   *  여전히 text를 쓴다. */
  delta?: string;
  /** 델타 적용 후 전체 텍스트 길이 — 렌더러가 누적 결과를 검증해 어긋나면 재동기화한다. */
  textLen?: number;
  error?: { code: string; message: string };
  /** Agent OS surface manifest, emitted when an agent produces a safe interactive surface. */
  surfaceId?: string;
  surface?: AgentlasSurfaceManifest;
  /** 도구 호출/결과 이벤트 — Claude Code식 접기/펴기 블록용 (이름 + 인자 JSON + 결과) */
  tool?: { name: string; args?: string; result?: string; id?: string; isError?: boolean };
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
  /** per-node 완료 신호 — 이 노드의 한 턴이 끝났음(성공/실패). UI가 그 노드만 비활성(✓)으로 처리. */
  done?: boolean;
  /** 이 노드가 실행 중인 모델/런타임 라벨(예: "grok-4.3", "claude", "gpt-5") — 트리에 "모델 사용 중" 표시. */
  model?: string;
  // ── 워크플로우 그래프 라이브 실행(설계 §5 P2) — run-graph.ts가 per-node 상태를 emit ──
  /** 이 이벤트가 겨냥한 워크플로우 노드 id(그래프 러너 라이브 오버레이용). */
  nodeId?: string;
  /** 노드 실행 상태 — 캔버스가 이 값으로 노드/엣지 애니메이션을 그린다. */
  nodeState?: WorkflowNodeRunState;
}

/** 워크플로우 그래프 노드의 라이브 실행 상태(설계 §5 P2 — 캔버스 오버레이). */
export type WorkflowNodeRunState = "pending" | "running" | "done" | "failed" | "skipped";

/** 워크플로우 1회 실행의 per-node 상태 스냅샷(automation_runs.node_states_json에 직렬화). */
export interface WorkflowRunSnapshot {
  /** 이 실행 식별자. */
  runId: string;
  automationId: string;
  startedAt: string;
  status: "running" | "ok" | "error";
  /** 노드 id → 마지막 상태. */
  nodeStates: Record<string, WorkflowNodeRunState>;
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

/** Main-authoritative read scope. Renderer paths never act as their own roots. */
export type FsReadScope =
  | { kind: "capability"; token: string }
  | { kind: "chat-workspace"; chatId: string }
  | { kind: "chat-assets"; chatId: string };

/** Opaque authority issued only after a native picker or trusted drop event. */
export interface FsPathGrant {
  path: string;
  kind: "file" | "directory";
  durable: boolean;
  scope: Extract<FsReadScope, { kind: "capability" }>;
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

// ── LLM 엔진 사용량 (구독 rate-limit 창 + 크레딧) ──────────────
// Claude/Codex/Gemini의 프로바이더 OAuth usage 엔드포인트에서 조회한 정규화 결과.
/** 사용량 창 종류. 5h=5시간 롤링, 7d=주간(7일), monthly=월 크레딧, daily=일일(모델별·Gemini). */
export type UsageWindowKind = "5h" | "7d" | "monthly" | "daily";

/** 한 프로바이더의 단일 사용량 창. */
export interface UsageWindow {
  /** 안정 id — "five_hour" | "seven_day" | "seven_day_opus" | "extra_usage" 등 */
  id: string;
  /** 영문 기본 라벨(폴백). 표시는 렌더러가 kind/model로 로컬라이즈. */
  label: string;
  kind: UsageWindowKind;
  /** 0–100. monthly는 used/limit로 계산. */
  usedPercent: number;
  /** 리셋 시각(epoch ms). 모르면 미설정. */
  resetAt?: number | null;
  /** 모델 한정 창이면 "opus" | "sonnet" 등. */
  model?: string | null;
  /** monthly 크레딧 창: 사용/한도/단위($·credits). */
  used?: number;
  limit?: number;
  unit?: string;
}

export type UsageProviderStatus =
  | "ok" // 사용량 창 있음
  | "key_billed" // API 키형 — 구독 창 없음(키 과금)
  | "local" // 로컬(Ollama) — 무제한
  | "no_quota" // 연결됐으나 한도 메타 없음
  | "error"; // 조회 실패

/** 한 LLM 프로바이더의 사용량 스냅샷. */
export interface ProviderUsage {
  /** "claude-code" | "codex" | "gemini" | "deepseek" | "glm" | "grok" | "pi" | "ollama" */
  provider: string;
  backend?: RuntimeBackend | string;
  label: string;
  status: UsageProviderStatus;
  windows: UsageWindow[];
  /** 조회 시각(epoch ms). */
  fetchedAt: number;
  /** status=error일 때 사유(민감정보 없음). */
  error?: string;
}

/** 전체 엔진 사용량 스냅샷 — 대시보드 "엔진 연결·사용량" 모듈이 소비. */
export interface UsageSnapshot {
  providers: ProviderUsage[];
  fetchedAt: number;
}

/** 확인 요청 — 에이전트가 챗에서 사용자 결정을 기다리는 항목.
 *  마지막 메시지가 미답변 질문 fence(<<agentlas-ask>>)인 채팅에서 도출. */
export interface PendingConfirmation {
  chatId: string;
  chatTitle: string;
  /** 에이전트가 던진 질문 본문 */
  question: string;
  /** 짧은 칩 라벨(선택) */
  header?: string;
  /** 선택지 개수 */
  optionCount: number;
  /** Desktop 질문 카드와 Mobile이 공유하는 실제 안전한 선택지. */
  options: Array<{ label: string; description?: string }>;
  /** 여러 선택을 허용하는 질문인지 여부. */
  multiSelect: boolean;
  agentId: string;
  firmId: string | null;
  /** 질문 메시지 시각(ISO) */
  createdAt: string;
}

/** electron-updater의 자동 업데이트 상태. main → renderer로 broadcast. */
export type UpdaterErrorCode =
  | "config-missing"
  | "check-failed"
  | "download-failed"
  | "install-not-owned"
  | "install-not-applied"
  | "install-state-corrupt"
  | "legacy-cleanup-failed"
  | "install-start-failed"
  | "continuity-backup-failed"
  | "continuity-violation"
  | "compatibility-metadata-missing"
  | "minimum-app-version"
  | "minimum-runtime-version"
  | "minimum-schema-version";

export interface UpdaterCompatibility {
  minimumSourceAppVersion: string;
  minimumRuntimeVersion: string;
  minimumSchemaVersion: number;
  targetSchemaVersion: number;
  bundledRuntimeVersion: string;
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "updated"
    | "not-available"
    | "manual-required"
    | "incompatible"
    | "recovery-required"
    | "error";
  /** update-available / update-downloaded 시 채워짐 */
  version?: string;
  /** download-progress의 백분율 (0-100). downloading 상태일 때만 의미 있음 */
  progress?: number;
  /** renderer가 원문 오류를 추측하지 않고 안전한 복구 UI를 고를 수 있는 안정 코드. */
  code?: UpdaterErrorCode;
  /** 사용자에게 보여도 되는 짧은 설명. 내부 경로/토큰/스택은 포함하지 않는다. */
  error?: string;
  /** 네트워크 등 일시 실패일 때만 true. 권한/호환성/연속성 실패는 false다. */
  canRetry?: boolean;
  /** 고정된 공식 다운로드 경로. renderer 입력으로 URL을 받지 않는다. */
  manualDownloadUrl?: string;
  /** 복구본이 있을 때만 true. 실제 경로는 main이 보관하고 reveal IPC로만 연다. */
  recoveryBackupAvailable?: boolean;
  /** 릴리스가 선언한 최소 호환 경계. */
  compatibility?: UpdaterCompatibility;
  /** 마지막으로 서버 확인이 끝난 시각(epoch ms). */
  lastCheckedAt?: number;
}

export interface UpdaterActionResult {
  accepted: boolean;
  state: UpdaterState;
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
  /** UI 표시 언어 — 결과 경고 메시지를 이 언어로 낸다. */
  locale?: "ko" | "en";
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

// ── Oberon real render jobs ───────────────────────────────────
export type OberonRenderProvider = "google-gemini-veo" | "google-enterprise-veo";
export type OberonRenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type OberonRenderFileKind =
  | "clip_mp4"
  | "master_mp4"
  | "master_mov"
  | "master_wav"
  | "titled_mp4"
  | "titled_mov";
export type OberonRenderClipStatus = "queued" | "generating" | "ready" | "failed";

export interface OberonRenderShotInput {
  shotId: string;
  index: number;
  durationSec: number;
  aspectRatio: string;
  prompt: string;
  negativePrompt?: string;
  providerId?: string;
  providerMode?: string;
  firstFrame?: {
    absPath?: string;
    imageBytes?: string;
    mimeType: string;
  };
  /** END 프레임 — Veo가 이 이미지로 정확히 끝나도록 보간(START/END 체이닝). firstFrame이 있을 때만 적용. */
  lastFrame?: {
    absPath?: string;
    imageBytes?: string;
    mimeType: string;
  };
  /** 이 샷의 첫 프레임이 직전 샷(id)의 END 프레임에서 이어짐 — 프롬프트에 연속성 지시로 반영. */
  chainedFromShotId?: string;
}

export interface OberonRenderRequest {
  productionId: string;
  title: string;
  aspectRatio: string;
  shots: OberonRenderShotInput[];
  /** Live renders are capped by default to avoid surprise spend. */
  maxShots?: number;
  takesPerShot?: number;
  provider?: OberonRenderProvider;
  model?: string;
  resolution?: "720p" | "1080p" | "4k";
  /** 타이틀/로어서드/자막 결정적 번인 스펙 (있으면 *_titled.mp4 추가 생성). */
  titles?: OberonTitleSpec;
}

export interface OberonRenderFile {
  id: string;
  kind: OberonRenderFileKind;
  name: string;
  label: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
}

export interface OberonRenderClip {
  shotId: string;
  takeId: string;
  attempt: number;
  status: OberonRenderClipStatus;
  provider: OberonRenderProvider;
  model: string;
  prompt: string;
  absPath?: string;
  url?: string;
  mime?: string;
  sizeBytes?: number;
  error?: string;
  createdAtMs: number;
}

export interface OberonRenderProgress {
  phase: "queued" | "generating" | "assembling" | "complete" | "failed" | "cancelled";
  totalClips: number;
  completedClips: number;
  currentShotId?: string;
  percent: number;
}

export interface OberonRenderJob {
  id: string;
  productionId: string;
  title: string;
  provider: OberonRenderProvider;
  model: string;
  status: OberonRenderJobStatus;
  outputDir: string;
  progress: OberonRenderProgress;
  clips: OberonRenderClip[];
  files: OberonRenderFile[];
  message: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

// ── Oberon local motion graphics jobs ─────────────────────────
export type OberonMotionAdJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type OberonMotionAdFileKind = "motion_mp4" | "html_preview" | "prompt_pack" | "manifest_json";

export interface OberonMotionAdRequest {
  productionId?: string;
  title?: string;
  brand?: string;
  concept?: string;
  aspectRatio?: "16:9" | "9:16";
  durationSec?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** 고객 로고 — 이미지 URL/로컬 절대경로/data-uri. 없으면 브랜드 이니셜 모노그램. */
  logoSource?: string;
  /** 브랜드 강조색 #hex. 없으면 브랜드명에서 결정적으로 선택. */
  accentColor?: string;
  outputDir?: string;
}

export interface OberonMotionAdFile {
  id: string;
  kind: OberonMotionAdFileKind;
  name: string;
  label: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
}

export interface OberonMotionAdProgress {
  phase: "queued" | "rendering_frames" | "encoding" | "complete" | "failed" | "cancelled";
  totalFrames: number;
  completedFrames: number;
  percent: number;
}

export interface OberonMotionAdJob {
  id: string;
  productionId?: string;
  title: string;
  brand: string;
  status: OberonMotionAdJobStatus;
  outputDir: string;
  progress: OberonMotionAdProgress;
  files: OberonMotionAdFile[];
  message: string;
  error?: string;
  warnings: string[];
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  createdAtMs: number;
  updatedAtMs: number;
}

// ── Oberon image-to-video (애니메이션 스튜디오) ──────────────
export type OberonAnimateProvider = "runway" | "luma" | "veo" | "seedance" | "kling" | "grok";
export type OberonAnimateJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface OberonAnimateRequest {
  productionId?: string;
  title?: string;
  provider?: OberonAnimateProvider;
  /** 입력 이미지 — 로컬 절대경로(runway는 base64 data-uri로 인라인). */
  imagePath?: string;
  /** 입력 이미지 — 공개 HTTPS URL(luma는 공개 URL만 허용). */
  imageUrl?: string;
  prompt: string;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  durationSec?: number;
  model?: string;
}

export interface OberonAnimateFile {
  id: string;
  kind: "animation_mp4";
  name: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
}

export interface OberonAnimateProgress {
  phase: "queued" | "submitting" | "generating" | "downloading" | "complete" | "failed" | "cancelled";
  percent: number;
}

export interface OberonAnimateJob {
  id: string;
  productionId?: string;
  title: string;
  provider: OberonAnimateProvider;
  model: string;
  status: OberonAnimateJobStatus;
  outputDir: string;
  progress: OberonAnimateProgress;
  files: OberonAnimateFile[];
  message: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface OberonAnimateKeyStatus {
  runway: boolean;
  luma: boolean;
  veo: boolean;
  seedance: boolean;
  kling: boolean;
  /** Grok CLI(Imagine) — API 키가 아니라 구독 로그인된 grok 바이너리 존재 여부. */
  grok: boolean;
}

// ── Oberon text planning jobs ──────────────────────────────────
export type OberonPlanRuntime = "claude-code" | "codex" | "gemini";

/** Optional, main-process-owned OpenCrab ontology enrichment. No endpoint or result body crosses IPC. */
export interface OpenCrabReadiness {
  state: "absent" | "needs-credential" | "disabled" | "ready" | "unreachable";
  installed: boolean;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  reason?: string;
}

export interface OpenCrabEnrichment {
  requested: boolean;
  used: boolean;
  reason?: string;
  /** Main-owned safe projection. No ontology result text crosses IPC. */
  evidenceCount?: number;
  matchedQueryTerms?: string[];
}

export interface OberonPlanRequest {
  productionId?: string;
  brief: JsonObject;
  runtime?: OberonPlanRuntime | string;
  runtimeLabel?: string;
  premium?: boolean;
  /** Explicit per-run consent. False/omitted preserves the current local-only planning flow. */
  useOpenCrab?: boolean;
}

export interface OberonPlanResult {
  ok: boolean;
  runtime: OberonPlanRuntime | string;
  runtimeLabel: string;
  patch?: JsonObject;
  rawText?: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  openCrab?: OpenCrabEnrichment;
}

// ── Oberon keyframe image jobs ─────────────────────────────────
export type OberonKeyframeProvider = "codex-imagegen-cli" | "google-imagen";
export type OberonKeyframeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type OberonKeyframeAssetKind = "first_frame" | "last_frame" | "master_sheet" | "storyboard_sheet";

export interface OberonKeyframeShotInput {
  shotId: string;
  index: number;
  aspectRatio: string;
  prompt: string;
  negativePrompt?: string;
  cameraSize?: string;
  continuityRefs?: string[];
  /** START/END 프레임 체이닝 — "last"면 샷의 END 프레임을 생성(파일명·자산 kind 반영). 기본 "first". */
  frameRole?: "first" | "last";
  /** 자산 종류 오버라이드 — 마스터 시트/콘티 시트 생성 시 사용. */
  assetKind?: OberonKeyframeAssetKind;
}

export interface OberonKeyframeRequest {
  productionId: string;
  title: string;
  aspectRatio: string;
  shots: OberonKeyframeShotInput[];
  maxShots?: number;
  provider?: OberonKeyframeProvider;
  model?: string;
  imageSize?: "1K" | "2K";
}

export interface OberonKeyframeAsset {
  id: string;
  shotId: string;
  kind: OberonKeyframeAssetKind;
  provider: OberonKeyframeProvider;
  model: string;
  prompt: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface OberonKeyframeProgress {
  phase: "queued" | "generating" | "complete" | "failed" | "cancelled";
  totalImages: number;
  completedImages: number;
  currentShotId?: string;
  percent: number;
}

export interface OberonKeyframeJob {
  id: string;
  productionId: string;
  title: string;
  provider: OberonKeyframeProvider;
  model: string;
  status: OberonKeyframeJobStatus;
  outputDir: string;
  progress: OberonKeyframeProgress;
  assets: OberonKeyframeAsset[];
  message: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

// ── Oberon 시트 생성 (마스터 시트 · 콘티 시트 · 컷 분해 시트) ──
// 프롬프트는 shared/oberon-sheets.ts 빌더로 만들고, 생성은 키프레임 엔진을 재사용한다.
export type OberonSheetKindInput =
  | "master_sheet_v1"
  | "master_sheet_v2"
  | "storyboard_overview"
  | "cut_breakdown"
  // 커버리지 워크플로우: 3x3 그리드 / 4단 스택 / 스토리보드 시퀀스.
  | "scene_grid_3x3"
  | "scene_stack_4"
  | "storyboard_sequence";

export interface OberonSheetItemInput {
  /** 시트 id — 캐릭터 시트면 reference id, 콘티면 "storyboard_overview" 등. */
  id: string;
  kind: OberonSheetKindInput;
  /** shared/oberon-sheets 빌더가 만든 완성 프롬프트. */
  prompt: string;
  /** normalizeAspect 입력 기준 비율 (기본: kind별 sheetAspect). */
  aspectRatio?: string;
}

export interface OberonSheetRequest {
  productionId: string;
  title: string;
  sheets: OberonSheetItemInput[];
  provider?: OberonKeyframeProvider;
  model?: string;
  imageSize?: "1K" | "2K";
}

// ── Hephaestus 엔진 브리지 ──────────────────────────────────────────────────
/** 임베딩된 Hephaestus 엔진의 가용성. */
export interface HephaestusStatus {
  available: boolean;
  reason?: string;
  root: string | null;
  python: string | null;
  version: string | null;
  pythonVersion: string | null;
}
/** 엔진 CLI 명령 결과(JSON 출력 + 원시 stdout/stderr). */
export interface HephaestusCommandResult<T = unknown> {
  ok: boolean;
  exitCode: number | null;
  json: T | null;
  stdout: string;
  stderr: string;
  error?: string;
}
export type HephaestusUploadVisibility = "private-link" | "marketplace";
/** hep-build(빌더) 스트리밍 이벤트 — 데스크탑 런타임으로 Hephaestus 빌더 에이전트 구동. */
export interface HephaestusBuildEvent {
  runId: string;
  kind: "log" | "stage" | "partial" | "done" | "error";
  text?: string;
  stage?: string;
  /** CLI 런타임이 반환한 재개 가능한 세션 id. 다음 인터뷰 턴에서 그대로 이어간다. */
  sessionId?: string;
  result?: unknown;
}

/** Main-authored supplemental question. It never comes from model text. */
export interface HephaestusBuildSupplementalQuestion {
  kind: "opencrab-ontology";
  question: string;
  options: Array<{ label: string; description?: string }>;
}

export interface HephaestusBuildResult {
  workspace: string;
  securityScan: unknown;
  supplementalQuestion?: HephaestusBuildSupplementalQuestion;
}
/** 빌드 지시문 첨부 — 사용자 디스크의 파일/폴더(기존 에이전트·스킬·이미지·문서 등). */
export interface HephaestusBuildAttachment {
  /** Native picker / trusted drop에서 발급된 opaque 파일 권한. Renderer 경로는 권한이 아니다. */
  grant: FsPathGrant;
  /** 표시용 이름(기본 basename). */
  name?: string;
}

export interface HephaestusBuildRequest {
  /** 이번 턴의 사용자 입력(자연어). 1턴=원 요청, 인터뷰 답변 턴=사용자의 답변. */
  request: string;
  /** 첨부 파일/폴더 — 첫 턴에만 유효. 워크스페이스 `_attachments/`로 복사되고 프롬프트에 참조가 주입된다. */
  attachments?: HephaestusBuildAttachment[];
  /** single | team | package(repair) — 미지정 시 엔진 mode-classification 에 위임. */
  mode?: "single" | "team" | "package";
  /** 결과 패키지 작업 폴더 권한. Main이 검증한 경로만 런타임 cwd가 된다. */
  workspaceGrant: FsPathGrant;
  /** 사용할 런타임 선택(미지정 시 활성 런타임). */
  runtime?: RuntimeSelection;
  /** 이전 인터뷰 턴에서 받은 CLI 세션 id. 있으면 새 호출 대신 같은 대화를 resume한다. */
  runtimeSessionId?: string;
  /** 대화형 딥인터뷰용 이전 대화(이번 턴 입력 이전까지). 빌더가 인터뷰 맥락을 이어간다. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Explicit answer to the conditional OpenCrab interview question. */
  openCrabOntology?: "use" | "skip";
  /** 렌더러 표시 언어. 빌더가 UI 노출 로그/상태 메시지를 이 언어로 낸다. 미지정 시 백엔드 기본. */
  locale?: "ko" | "en";
}

// ── 추천 바텀시트(Recommendation) ──────────────────────────────────────────
// routePreview 가 routeOnly(실행 없음) 결정 JSON 을 정규화해 렌더러에 넘기는 모양.
// 렌더러는 엔진 내부 JSON 을 직접 파싱하지 않고 이 정규형만 소비한다.
export type RecMode = "single" | "multi" | "network" | "pipeline" | "clarify" | "build" | "none";
export type RecSource = "local" | "cloud" | "hub";
export interface RecAgent {
  id: string;
  name: string;
  source: RecSource;
  /** 점추정 크레딧(예상). 알 수 없으면 null. */
  estCredits: number | null;
  /** 범위 추정(pipeline/network 처럼 패스·규모 불확실할 때). */
  estCreditsRange?: [number, number];
  /** single 라우트의 정규 실행 명령(entrypoints.canonical_command). */
  canonicalCommand?: string;
  /** type 이 팀/회사면 firm 바인딩 경로로 실행. */
  isFirm?: boolean;
}
export interface RecStage {
  order: number;
  /** 단계 라벨(plan/build/qa/deploy 등 엔진 stage 키). */
  kind: string;
  agentId?: string;
  agentName?: string;
  produces?: string[];
  consumes?: string[];
  estCredits?: number | null;
}
export interface Recommendation {
  mode: RecMode;
  /** single→1, multi/network→N. */
  agents: RecAgent[];
  /** mode==="pipeline" 일 때 단계. */
  stages?: RecStage[];
  /** 전체 예상 크레딧(점추정). */
  totalEstCredits: number | null;
  totalEstCreditsRange?: [number, number];
  /** 항상 추정치임을 UI 가 명시하도록 하는 리터럴 플래그. */
  estimate: true;
  receiptId?: string;
  /** 원본 엔진 action(텔레메트리/디버그). */
  rawAction: string;
  /** action==="clarify" 일 때 되물을 질문. */
  clarifyQuestion?: string;
  /** action==="propose_new"(적합 에이전트 없음 → 빌드 제안) 일 때 엔진이 준 사유. */
  buildReason?: string;
  /** 원 요청 텍스트(시트가 실행할 때 사용). */
  query: string;
  /** 저신뢰(clarify/propose_new) 결정에 엔진이 붙인 Router Agent 에스컬레이션.
   *  있으면 호스트 런타임이 LLM 추론으로 의도 재해석·후보 재정렬해 재라우팅한다(BYOC). */
  routerAgent?: RecRouterAgent;
}

export interface RecRouterAgent {
  /** 호스트가 로드·실행할 Router Agent id. */
  agent: string;
  /** 에스컬레이션 사유(clarify|propose_new). */
  reason: string;
  /** 호스트 런타임이 따를 지침(엔진이 생성, 모델 호출은 호스트). */
  directive?: string;
  /** 엔진이 첨부한 구조화 컨텍스트. query/candidates/hub_candidates 등을 포함할 수 있음. */
  context?: JsonObject;
}

/** 추천 시트에서 사용자가 고른 실행 경로 — 페이지가 적절한 send/switch 로 디스패치한다. */
export type RecExecChoice =
  | { kind: "agent"; agentId: string; isFirm?: boolean; routerAgent?: RecRouterAgent }
  | { kind: "network"; agents?: string[]; routerAgent?: RecRouterAgent }
  | { kind: "pipeline"; stages?: RecStage[]; routerAgent?: RecRouterAgent }
  | { kind: "plain"; routerAgent?: RecRouterAgent };

/** Agentlas Hub 크레딧 잔액 — GET /api/billing/credits 응답 형태.
 *  구독 계좌(A: 월 초기화 + 톱업 + 전송분)와 렌트수익 계좌(B: 적립 전용)를 분리해서 본다.
 *  `remainingCredits`=사용 가능(A), `earningsCredits`=이동 가능한 렌트수익(B). */
export interface HubCreditBalance {
  authenticated: boolean;
  plan?: string;
  usedCredits?: number;
  planCreditLimit?: number;
  topUpCredits?: number;
  limitCredits?: number;
  remainingCredits?: number;
  earningsCredits?: number;
  error?: string;
}

/** 렌트수익(B) → 구독(A) 일방 전송 결과. POST /api/billing/earnings/transfer. */
export interface EarningsTransferResult {
  ok: boolean;
  moved?: number;
  earningsCredits?: number;
  remainingCredits?: number;
  error?: string;
}

// ── 프롬프트 저장소 (웹 /api/prompts 프록시 — electron/prompts-hub.ts) ─────────
/** 카탈로그/상세 공통 프롬프트 요약. body/tips는 절대 카탈로그에 오지 않는다. */
export interface HubPromptSummary {
  id: string;
  slug: string;
  category?: string;
  titleKo?: string;
  titleEn?: string;
  summaryKo?: string;
  summaryEn?: string;
  models?: string[];
  /** 필요한 입력물 안내(사진/문서 등) — "써보기" 전에 반드시 표시할 것. */
  inputsKo?: string;
  inputsEn?: string;
  exampleImages?: string[];
  exampleResultKo?: string;
  exampleResultEn?: string;
  tags?: string[];
  authorName?: string;
  unlockCount?: number;
  viewCount?: number;
  // 로그인 사용자 전용 플래그
  unlocked?: boolean;
  tasted?: boolean;
  bookmarked?: boolean;
  mine?: boolean;
}

export interface HubPromptViewer {
  signedIn: boolean;
  /** 유료 구독(free 아님 + active/trialing/past_due) — 전 프롬프트 무제한 열람+저장. */
  paidAccess: boolean;
}

export interface HubPromptCatalog {
  ok: boolean;
  prompts: HubPromptSummary[];
  viewer: HubPromptViewer | null;
  error?: string;
}

export interface HubPromptDetailResult {
  ok: boolean;
  prompt?: HubPromptSummary & { body?: string; tipsKo?: string; tipsEn?: string; paidAccess?: boolean | null };
  error?: string;
}

/** 언락/맛보기 공통 결과 — code: subscription_required / already_tasted / unauthenticated / network. */
export interface HubPromptOpenResult {
  ok: boolean;
  body?: string;
  tipsKo?: string;
  tipsEn?: string;
  alreadyUnlocked?: boolean;
  tasted?: boolean;
  code?: string;
  error?: string;
  upgradeUrl?: string;
}

export interface HubPromptTastesResult {
  ok: boolean;
  count: number;
  slugs: string[];
  code?: string;
}

export interface HubPromptBookmarkResult {
  ok: boolean;
  bookmarked?: boolean;
  code?: string;
  error?: string;
}

// ── 퀘스트 (온보딩 대체 신규 유저 튜토리얼 — 웹 /api/quests 프록시) ────────────
export interface QuestInfo {
  id: string;
  titleKo: string;
  titleEn: string;
  descKo: string;
  descEn: string;
  rewardCredits: number;
  verification: "server" | "client-attested";
  claimed: boolean;
  claimedAt: string | null;
}

export interface QuestListResult {
  ok: boolean;
  authenticated: boolean;
  quests: QuestInfo[];
  error?: string;
}

export interface QuestClaimResult {
  ok: boolean;
  questId?: string;
  rewardCredits?: number;
  code?: string;
  error?: string;
}

// ── 에이전트 durable 메모리(런타임 큐레이터 DB) — 자가진화/타임라인 UI 소스 ────
export interface AgentMemoryEntryUi {
  id: string;
  scope: string;
  kind: string;
  content: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  chatId: string | null;
  projectPath: string | null;
  createdAt: string;
}

export interface RunEventUi {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  kind: string;
  chatId?: string;
  automationId?: string;
  nodeId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface FailureEventUi {
  id: string;
  runId?: string;
  ts: string;
  source: string;
  chatId?: string;
  automationId?: string;
  nodeId?: string;
  agentId?: string;
  errorCode?: string;
  errorMessage: string;
  payload: Record<string, unknown>;
}

export type InvocationRunStatus =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Durable execution receipt. Renderer busy state is deliberately not part of
 * this contract: main's live registry owns running/cancelling, while the DB
 * ledger owns terminal recovery and retry deduplication.
 */
export interface InvocationRunReceipt {
  runId: string;
  chatId: string;
  status: InvocationRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  eventCount: number;
  resultFolder?: string;
  hasImages?: boolean;
  borrowAgents?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export type AgentEvolutionProposalStatus =
  | "candidate"
  | "approved"
  | "applying"
  | "rejected"
  | "applied"
  | "measured"
  | "rolling_back"
  | "rolled_back"
  | "apply_failed"
  | "conflicted"
  | "recovery_required";

export interface AgentEvolutionReceiptUi {
  id: string;
  proposalId: string;
  agentId: string;
  action: "apply" | "rollback";
  targetPath: string;
  versionBefore: number;
  versionAfter: number;
  targetHashBefore: string;
  targetHashAfter: string;
  /** Hash of governed prompt/skill/playbook assets, not the Agent Cloud bundle hash. */
  governedAssetHashBefore: string;
  governedAssetHashAfter: string;
  /** @deprecated compatibility alias; use governedAssetHashBefore. */
  packageHashBefore: string;
  /** @deprecated compatibility alias; use governedAssetHashAfter. */
  packageHashAfter: string;
  createdAt: string;
}

export interface AgentEvolutionProposalUi {
  id: string;
  agentId: string;
  proposalType: "rule" | "playbook" | "skill" | "setup_doc" | "plugin";
  summary: string;
  targetPath: string;
  beforeHash: string;
  afterHash: string;
  /** Local-only diff payload used for explicit review and crash recovery. */
  beforeContent: string;
  afterContent: string;
  risk: "low" | "medium" | "high";
  status: AgentEvolutionProposalStatus;
  source: Record<string, unknown>;
  receipts: AgentEvolutionReceiptUi[];
  decisionNote?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  appliedAt?: string;
  measuredAt?: string;
  rolledBackAt?: string;
}

export interface CreateAgentEvolutionProposalInput {
  agentId: string;
  targetPath: string;
  currentContent: string;
  proposedContent: string;
  proposalType?: AgentEvolutionProposalUi["proposalType"];
  summary?: string;
  risk?: AgentEvolutionProposalUi["risk"];
  source?: Record<string, unknown>;
  decisionNote?: string;
}

/** 버그 신고 입력 — 우측 하단 도움말(?) 메뉴의 신고 폼에서 전달. */
export interface BugReportInput {
  message: string;
  title?: string;
  severity?: "low" | "medium" | "high";
  email?: string;
  /** 신고 당시 화면 경로(예: "/chat") — 재현에 도움. */
  page?: string;
  /** 표시 언어(ko/en). */
  locale?: string;
}

/** 버그 신고 결과 — 웹 API가 MongoDB에 적재. */
export interface BugReportResult {
  ok: boolean;
  /** 저장된 신고 id(성공 시). */
  id?: string;
  /** 실패 코드: message_required / network / http_4xx / store_failed 등. */
  code?: string;
  error?: string;
}

export interface AgentlasIpc {
  /** Electron 메인이 알려주는 OS 환경 정보 (Apple/Codex/Claude 데스크톱과 동일 패턴) */
  app: {
    /** macOS 시스템 설정의 1순위 언어 — "ko-KR" / "en-US" 등. i18n 자동 감지에 사용 */
    getLocale: () => Promise<string>;
    /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
    getVersion: () => Promise<string>;
  };
  /** DESKTOP_MOBILE_BRIDGE: pairing UI only; tokens never cross renderer IPC. */
  mobileBridge: {
    status: () => Promise<MobileBridgeRuntimeStatus>;
    issuePairing: () => Promise<MobileBridgePairingPayload>;
    listDevices: () => Promise<MobileBridgeDeviceSummary[]>;
    revokeDevice: (deviceId: string) => Promise<{ ok: boolean }>;
  };
  /** T-rex 슬라이드 스튜디오 — 키리스 CLI 이미지 생성(codex image_gen / gemini). */
  trex: {
    generateImage: (payload: { model?: "codex" | "gemini" | "auto"; prompt: string }) => Promise<{ ok: boolean; src?: string; reason?: string; engine?: "codex" | "gemini" }>;
    imageProviders: () => Promise<{ codex: boolean; gemini: boolean }>;
    generateContent: (payload: { topic: string; count?: number; mode?: string; sources?: string; locale?: "ko" | "en"; useOpenCrab?: boolean }) => Promise<{ ok: boolean; text?: string; engine?: "agent" | "agy" | "codex"; reason?: string; openCrab?: OpenCrabEnrichment }>;
    contentAvailable: () => Promise<{ agy: boolean; codex: boolean }>;
    /** 선택 요소 LLM 수정(select-to-edit) — 현재 텍스트 + 지시 → 다시 쓴 텍스트. */
    refineText: (payload: { current: string; instruction: string; context?: string }) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  };
  /**
   * 사이트 디자인 스튜디오 — 디자인 전용(백엔드/실행 없음).
   * 화면당 self-contained HTML 1문서, sandbox iframe 렌더 + select-to-edit.
   * 디자인 두뇌 = Hub 에이전트 "웹앱 디자인 마스터"(web-master)를 hep-call(borrow)로 호출.
   */
  site: {
    listProjects: () => Promise<SiteProjectMeta[]>;
    /** Main-authoritative project mutex, used to restore busy UI after remount. */
    operationStatus: (payload: { projectId: string }) => Promise<SiteProjectOperation | null>;
    /** 사람이 읽는 Site Copilot 기록 — 내부 모델 프롬프트와 분리된 프로젝트별 영속 로그. */
    listConversation: (payload: { projectId: string }) => Promise<SiteConversationEntry[]>;
    createProject: (payload: { name: string }) => Promise<SiteProjectMeta>;
    deleteProject: (payload: { projectId: string }) => Promise<{ ok: boolean }>;
    /** 화면 생성 — variants(1~3)만큼 시안을 만든다(순차 — 프로젝트 세션 공유). */
    generateScreen: (payload: {
      projectId: string;
      brief: string;
      variants?: number;
      styleHint?: string;
      /** 스타일 참조 화면 — 같은 제품처럼 보이게 팔레트/타이포를 따라간다. */
      baseScreenId?: string;
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; screens?: SiteScreenMeta[]; engine?: string; feedback?: string; reason?: string }>;
    /** 선택 요소 부분 patch 우선 수정. selectionId = data-agentlas-id. */
    editScreen: (payload: {
      projectId: string;
      screenId: string;
      instruction: string;
      selectionId?: string;
      /** 사용자에게 보이는 선택 대상 식별자 — 내부 HTML 프롬프트와 분리해 대화 로그에만 저장. */
      selectionContext?: string;
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; screen?: SiteScreenMeta; engine?: string; mode?: "patch" | "full"; feedback?: string; reason?: string }>;
    readScreen: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean; html?: string; reason?: string }>;
    /** 렌더 직전 태깅+오버레이/CSP 주입 — iframe srcDoc으로 쓸 HTML과 nonce 반환. */
    prepareRender: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean; renderHtml?: string; nonce?: string; reason?: string }>;
    renameScreen: (payload: { projectId: string; screenId: string; name: string }) => Promise<{ ok: boolean; screen?: SiteScreenMeta }>;
    deleteScreen: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean }>;
    /** 창 좌표(rect, CSS px) 크롭 스크린샷 — 선택 요소 썸네일용. */
    captureRect: (payload: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; reason?: string }>;
    exportScreen: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; reason?: string }>;
    exportProjectZip: (payload: { projectId: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; reason?: string }>;
    /** 사용자가 직접 고른 작업공간에 디자인 리비전을 기록하고 Build 입력으로 이어간다. */
    handoffToWorkspace: (payload: {
      projectId: string;
      workspaceGrant: FsPathGrant;
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; handoff?: SiteWorkspaceHandoff; reason?: string }>;
    /** 활성 런타임 존재 여부 + 붙어 있는 Hub 에이전트 슬러그. */
    contentAvailable: () => Promise<{ ready: boolean; agent: string }>;
  };
  /** 문서 스튜디오 내용 생성/개정 — 연결된 LLM(agy/codex), no-fallback. */
  document: {
    generate: (payload: {
      goal: string;
      mode?: "report" | "paper" | "brief";
      locale?: "ko" | "en";
      sources?: { authors?: string; title: string; year?: string; container?: string }[];
    }) => Promise<{
      ok: boolean;
      doc?: { title: string; subtitle: string; body: string; figureCaption: string };
      engine?: "agy" | "codex";
      reason?: string;
    }>;
    revise: (payload: {
      text: string;
      action: "expand" | "rewrite" | "shorten" | "improve" | "formal" | "casual";
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; text?: string; engine?: "agy" | "codex"; reason?: string }>;
    available: () => Promise<{ agy: boolean; codex: boolean }>;
  };
  /** 버그 신고 — 우측 하단 도움말(?) 메뉴에서 신고를 받아 웹 API(→MongoDB)로 적재. */
  support: {
    submitBugReport: (payload: BugReportInput) => Promise<BugReportResult>;
  };
  /** 네이티브 macOS 메뉴바 제어 — 인앱 언어 설정을 메인 프로세스로 전달해 메뉴를 다시 그린다. */
  menu: {
    /** 현재 표시 언어를 메인에 알려 네이티브 메뉴 라벨을 ko/en으로 갱신. */
    setLocale: (locale: "ko" | "en") => Promise<void>;
  };
  /** 워킹 폴더 — 채팅 우측의 폴더 트리 패널이 사용. read-only. */
  fs: {
    pickDirectory: () => Promise<FsPathGrant | null>;
    listDirectory: (absPath: string, scope: FsReadScope, showHidden?: boolean) => Promise<DirListing>;
    readTextFile: (absPath: string, scope: FsReadScope) => Promise<TextFilePreview>;
    /** 로컬 파일/폴더 또는 http(s) URL을 OS 기본 앱/브라우저로 연다. */
    openPath: (target: string) => Promise<{ ok: boolean; message?: string }>;
    /** 로컬 파일/폴더를 Finder/Explorer에서 표시한다. */
    showItemInFolder?: (target: string) => Promise<{ ok: boolean; message?: string }>;
    /** 네이티브 저장 다이얼로그로 텍스트를 디스크에 쓴다(산출물 내보내기). 취소 시 canceled=true. */
    saveTextFile: (
      suggestedName: string,
      content: string,
    ) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  };
  /** 채팅마다 마지막에 연 워킹 폴더 — SQLite에 저장. null이면 미설정. */
  workspace: {
    get: (chatId: string) => Promise<string | null>;
    set: (chatId: string, grant: FsPathGrant | null) => Promise<void>;
    /** Apply a main-owned project folder without accepting a renderer-supplied path. */
    setFromProject: (chatId: string, projectId: string) => Promise<void>;
    /** CLI 실행 기본 폴더(userData/agent-cwd). 채팅 working_folder가 없을 때 산출물 상대경로 해석에 사용. */
    defaultRunFolder: () => Promise<string | null>;
    /** 네이티브 폴더 선택 다이얼로그 → 선택한 절대경로(취소 시 null) */
    selectFolder: () => Promise<FsPathGrant | null>;
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
    /** Main-authoritative TTL/server invalidation notification. */
    onSessionChanged?: (callback: (session: AuthSession) => void) => () => void;
  };
  /** LLM 엔진 사용량 — 프로바이더 OAuth usage 엔드포인트(Claude/Codex/Gemini)에서
   *  5시간·주간(7일)·모델별·월 크레딧 조회. main에서 60초 캐시; force로 강제 갱신. */
  usage: {
    snapshot: (opts?: { force?: boolean }) => Promise<UsageSnapshot>;
    /** 재로그인/재시도 직후 캐시(lastResult·429 백오프·감지 캐시) 명시 무효화 — 새 토큰 즉시 반영.
     *  (구 preload 호환을 위해 optional.) */
    invalidate?: (providerId?: string) => Promise<void>;
  };
  /** Agentlas Hub 크레딧 — 구독(사용 가능) 잔액과 렌트수익(이동 가능) 잔액을 함께 조회하고,
   *  렌트수익 → 구독 일방 전송을 수행한다. 세션 쿠키로 Hub HTTP API를 main에서 호출. */
  billing: {
    getCredits: () => Promise<HubCreditBalance>;
    transferEarnings: (credits: number) => Promise<EarningsTransferResult>;
  };
  /** 프롬프트 저장소 — 웹 프롬프트 카탈로그 탐색/열람/맛보기/저장(북마크). Hub 메뉴와 동형. */
  promptHub: {
    list: (params?: { q?: string; category?: string }) => Promise<HubPromptCatalog>;
    get: (slug: string) => Promise<HubPromptDetailResult>;
    unlock: (slug: string) => Promise<HubPromptOpenResult>;
    taste: (slug: string) => Promise<HubPromptOpenResult>;
    tastes: () => Promise<HubPromptTastesResult>;
    bookmarks: () => Promise<{ ok: boolean; slugs: string[]; code?: string }>;
    bookmarkAdd: (slug: string) => Promise<HubPromptBookmarkResult>;
    bookmarkRemove: (slug: string) => Promise<HubPromptBookmarkResult>;
  };
  /** 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체). 클레임 성공 시 크레딧 지급. */
  quests: {
    list: () => Promise<QuestListResult>;
    claim: (questId: string) => Promise<QuestClaimResult>;
  };
  /** 에이전트 durable 메모리(런타임 큐레이터가 쌓는 DB) — 자가진화/타임라인 UI 소스. */
  agentMemory: {
    entries: (agentId: string, limit?: number) => Promise<AgentMemoryEntryUi[]>;
  };
  /** 실행/실패 원장 — 긴 원문 없이 runId, 노드, 도구, 오류 메타데이터만 조회한다. */
  runLedger: {
    events: (runId: string, limit?: number) => Promise<RunEventUi[]>;
    failures: (input?: { runId?: string; automationId?: string; chatId?: string; limit?: number }) => Promise<FailureEventUi[]>;
  };
  /** 에이전트 자가진화 proposal 원장 — 제안/승인/적용/측정/롤백 상태를 로컬 DB에 남긴다. */
  agentEvolution: {
    list: (agentId: string, limit?: number) => Promise<AgentEvolutionProposalUi[]>;
    /** Candidate collection only; this call never writes an agent package file. */
    createProposal: (input: CreateAgentEvolutionProposalInput) => Promise<AgentEvolutionProposalUi>;
    /** Explicit approval applies the already-reviewed candidate and creates a hash/version receipt. */
    approveAndApply: (proposalId: string, note?: string) => Promise<AgentEvolutionProposalUi>;
    reject: (proposalId: string, note?: string) => Promise<AgentEvolutionProposalUi>;
    markMeasured: (proposalId: string, note?: string) => Promise<AgentEvolutionProposalUi>;
    rollback: (proposalId: string) => Promise<AgentEvolutionProposalUi>;
  };
  /** 유휴 드리밍 큐레이션 — 옵트인(기본 OFF). 유휴+슬롯 완전 유휴+쿨다운 가드로 메모리 통합. */
  memoryDreaming: {
    status: () => Promise<{ enabled: boolean; lastRunAt: string | null; running: boolean }>;
    setEnabled: (enabled: boolean) => Promise<{ enabled: boolean; lastRunAt: string | null; running: boolean }>;
  };
  /** 확인 요청 — 에이전트가 챗에서 사용자 결정을 기다리는 채팅 목록(미답변 질문 fence 기준). */
  confirm: {
    listPending: () => Promise<PendingConfirmation[]>;
  };
  /** 앱 주의 표시 — Dock/taskbar badge와 네이티브 알림을 갱신한다. */
  attention: {
    setPendingConfirmations: (count: number) => Promise<void>;
  };
  /** 자동 업데이트 — electron-updater 래퍼. broadcast는 window.agentlasUpdater.onState로 받음. */
  updater: {
    /** 마운트 직후 현재 상태 동기 조회. broadcast 이전에 새 창이 열려도 onState로 미스되지 않음. */
    getState: () => Promise<UpdaterState>;
    /** 사용자가 "지금 확인" 누름. 동시 호출은 하나로 합치고 최종 authoritative state를 반환한다. */
    check: () => Promise<UpdaterState>;
    /** "재시작 업데이트" 클릭. 백업·권한·버전 가드를 모두 통과해야 종료/설치를 시작한다. */
    install: () => Promise<UpdaterActionResult>;
    /** 권한/호환성 때문에 자동 적용하지 않은 경우 고정된 공식 다운로드 페이지를 연다. */
    openManualDownload: () => Promise<UpdaterActionResult>;
    /** 연속성 검증 실패 때 main이 보관한 복구본을 Finder/Explorer에서 연다. */
    revealRecoveryBackup: () => Promise<UpdaterActionResult>;
  };
  runtime: {
    detect: (force?: boolean) => Promise<RuntimeStatus[]>;
    setActive: (selection: RuntimeSelection) => Promise<RuntimeStatus[]>;
    /** CLI 미설치 사용자용 — 고정 명령으로 `npm i -g <pkg>` 실행. 성공 후 detect()로 재인식. */
    installCli: (
      kind: "claude-code" | "codex" | "gemini" | "grok",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** 시스템 터미널을 열어 CLI 로그인 실행 — 사용자는 브라우저 로그인만 하면 됨. */
    openCliLogin: (
      kind: "claude-code" | "codex" | "gemini" | "grok",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** CLI를 최신으로 업데이트 — 미설치면 설치, npm 관리본은 재설치, claude는 self-updater. */
    updateCli: (
      kind: "claude-code" | "codex" | "gemini" | "grok",
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
  };
  agentRuntime: {
    list: () => Promise<AgentRuntimeOverride[]>;
    get: (
      scope: AgentRuntimeOverrideScope,
      targetId: string,
    ) => Promise<AgentRuntimeOverride | null>;
    set: (input: AgentRuntimeOverrideSetInput) => Promise<AgentRuntimeOverride>;
    remove: (scope: AgentRuntimeOverrideScope, targetId: string) => Promise<void>;
  };
  config: {
    getCustomBaseUrl: () => Promise<string>;
    setCustomBaseUrl: (url: string) => Promise<void>;
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
    /** 저장된 값의 마스킹 미리보기 (전체 평문 아님). 미저장이면 null. */
    preview: (key: string) => Promise<string | null>;
    remove: (key: string) => Promise<void>;
  };
  /** 멀티모달 전역 fallback — 에이전트/프로젝트 env가 없을 때 이미지·영상·음성 provider를 고른다. */
  multimodal: {
    listProviders: () => Promise<MultimodalProvider[]>;
    getSettings: () => Promise<MultimodalSettings>;
    saveSettings: (settings: Partial<MultimodalSettings>) => Promise<MultimodalSettings>;
    status: () => Promise<MultimodalProviderStatus[]>;
  };
  /** Oberon real render bridge — API keys stay in the Electron main process. */
  oberon: {
    planWithCli: (request: OberonPlanRequest) => Promise<OberonPlanResult>;
    startKeyframes: (request: OberonKeyframeRequest) => Promise<OberonKeyframeJob>;
    /** 마스터 시트/콘티 시트 생성 — 키프레임 잡을 재사용하므로 조회/취소는 keyframe API로. */
    startSheets: (request: OberonSheetRequest) => Promise<OberonKeyframeJob>;
    getKeyframeJob: (id: string) => Promise<OberonKeyframeJob | null>;
    cancelKeyframes: (id: string) => Promise<OberonKeyframeJob | null>;
    openKeyframeOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
    startRender: (request: OberonRenderRequest) => Promise<OberonRenderJob>;
    getRenderJob: (id: string) => Promise<OberonRenderJob | null>;
    cancelRender: (id: string) => Promise<OberonRenderJob | null>;
    openRenderOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
    startMotionAd: (request: OberonMotionAdRequest) => Promise<OberonMotionAdJob>;
    getMotionAdJob: (id: string) => Promise<OberonMotionAdJob | null>;
    cancelMotionAd: (id: string) => Promise<OberonMotionAdJob | null>;
    openMotionAdOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
    startAnimate: (request: OberonAnimateRequest) => Promise<OberonAnimateJob>;
    getAnimateJob: (id: string) => Promise<OberonAnimateJob | null>;
    cancelAnimate: (id: string) => Promise<OberonAnimateJob | null>;
    openAnimateOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
    animateKeyStatus: () => Promise<OberonAnimateKeyStatus>;
  };
  team: {
    list: () => Promise<InstalledAgent[]>;
    install: (slug: string) => Promise<InstalledAgent>;
    /** 내 에이전트(cargo) 설치 — 로그인 사용자가 agentlas.cloud에서 만든 것 */
    installMine: (id: string) => Promise<InstalledAgent>;
    uninstall: (id: string) => Promise<void>;
    /** 로컬 폴더(기존 에이전트/팀)를 임포트 — 런타임 감지·라벨링 후 라우팅 저장. */
    importLocalFolder: (input: { path: string; scope: FsReadScope }) => Promise<InstalledAgent>;
    /** 팀 에이전트의 하위 서브에이전트 해석 — 즉시 결정적 + 백그라운드 LLM 정밀판정/자가교정. */
    resolveSubAgents: (agentId: string) => Promise<AgentTeamResolution | null>;
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
    /** Main-owned canonical runtime prompt source for this package. */
    promptSource: (agentId: string) => Promise<AgentFileTextSnapshotUi | null>;
  };
  /** 스킬 카탈로그 — 엔진(Hephaestus)의 skills/ 디렉토리를 실제로 스캔해 반환한다.
   *  하드코딩 목록이 아니라 디스크의 SKILL.md 프론트매터에서 읽는다. */
  skills: {
    /** 주입 가능한 스킬 카탈로그 (엔진 skills/ 디렉토리 실측) */
    listCatalog: () => Promise<SkillCatalogEntry[]>;
    /** allowlisted catalog slug의 실제 SKILL.md 원문과 sha256. */
    readCatalog: (slug: string) => Promise<SkillCatalogAsset>;
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
  /** Optional ontology context. Endpoint and returned context remain in Electron main. */
  openCrab: {
    readiness: () => Promise<OpenCrabReadiness>;
  };
  marketplace: {
    listBundles: () => Promise<TeamBundle[]>;
    search: (q: string) => Promise<MarketplaceListing[]>;
    listFirms: () => Promise<FirmListing[]>;
    status: (force?: boolean) => Promise<MarketplaceSourceStatus>;
    /** 로그인 사용자의 실제 복원 가능한 Agent Cloud 패키지 목록. 미로그인/오프라인이면 [] */
    listMine: () => Promise<MarketplaceListing[]>;
    bookmarks: () => Promise<HubAgentBookmark[]>;
    /** Web account snapshot + local outbox reconciliation. No polling; callers trigger lifecycle sync. */
    syncBookmarks: () => Promise<HubAgentBookmark[]>;
    /** Main-owned full snapshot broadcast after local mutation or account sync. */
    onBookmarksSnapshot: (handler: (event: HubBookmarkSnapshotEvent) => void) => () => void;
    bookmarkAdd: (listing: MarketplaceListing) => Promise<HubAgentBookmark>;
    bookmarkRemove: (slug: string, entityKind?: string) => Promise<void>;
  };
  /** Store owned packages privately in Agent Cloud or explicitly publish them to the public Hub. */
  cloudAgents: {
    savePrivate: (input: CloudAgentPrivateSaveRequest) => Promise<CloudAgentPackageResult>;
    publishPublic: (input: CloudAgentHubPublishRequest) => Promise<CloudAgentPackageResult>;
    /** Compatibility surface. Omitted visibility now means private-link; marketplace remains an explicit flag. */
    publish: (input: CloudAgentPublishRequest) => Promise<CloudAgentPackageResult>;
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
  agentGroups: {
    list: () => Promise<AgentGroup[]>;
    listResolved: () => Promise<AgentGroupResolved[]>;
    getResolved: (id: string) => Promise<AgentGroupResolved | null>;
    create: (input: AgentGroupCreateInput) => Promise<AgentGroup>;
    update: (id: string, patch: AgentGroupUpdateInput) => Promise<AgentGroup>;
    removeMember: (groupId: string, memberId: string) => Promise<AgentGroup>;
    remove: (id: string) => Promise<void>;
  };
  telegram: {
    listBindings: () => Promise<TelegramConnectBinding[]>;
    autoConnect: (input: TelegramConnectAutoInput) => Promise<TelegramConnectActionResult>;
    start: (input: TelegramConnectStartInput) => Promise<TelegramConnectActionResult>;
    clone: (input: TelegramConnectCloneInput) => Promise<TelegramConnectActionResult>;
    resume: (id: string) => Promise<TelegramConnectBinding>;
    stop: (id: string) => Promise<TelegramConnectBinding>;
    remove: (id: string, deleteBot?: boolean) => Promise<{ botDeleted: boolean }>;
    resetConversation: (id: string) => Promise<TelegramConnectBinding>;
    sendTest: (id: string) => Promise<TelegramConnectActionResult>;
    openBot: (id: string) => Promise<{ ok: boolean; message: string }>;
    configureBotSettings: (id: string) => Promise<{ ok: boolean; message: string }>;
    pruneOrphans: () => Promise<{ removed: number }>;
  };
  browser: {
    status: () => Promise<BrowserStatus>;
    listSites: () => Promise<BrowserSite[]>;
    saveSite: (input: BrowserSiteInput) => Promise<BrowserSite>;
    deleteSite: (site: string) => Promise<{ ok: true }>;
    openLogin: (site: string) => Promise<{ ok: boolean; error?: string }>;
    markSession: (site: string, status: BrowserSessionStatus) => Promise<{ ok: true }>;
    listPermissions: () => Promise<BrowserPermissionEntry[]>;
    revokePermission: (site: string, actionType: string) => Promise<{ ok: true }>;
    resolveApproval: (requestId: string, decision: BrowserApprovalDecision) => Promise<{ ok: boolean }>;
    listLogs: (limit?: number) => Promise<BrowserActionLog[]>;
  };
  projects: {
    list: () => Promise<Project[]>;
    create: (input: { name: string; defaultAgentId?: string | null; contextNote?: string | null; folderGrant?: FsPathGrant | null }) => Promise<Project>;
    get: (id: string) => Promise<Project | null>;
    update: (
      id: string,
      patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId">> & { folderGrant?: FsPathGrant | null },
    ) => Promise<Project>;
    remove: (id: string) => Promise<void>;
  };
  ontology: {
    getProject: (projectId: string) => Promise<OntologyProjectStatus>;
    addSource: (
      projectId: string,
      absPath: string,
      scope: OntologySourceScope,
      kind: OntologySourceKind,
    ) => Promise<OntologyProjectStatus>;
    openInbox: (projectId: string) => Promise<{ ok: boolean; path: string | null; message: string }>;
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
      agentGroupId?: string | null;
      projectId?: string | null;
      title?: string;
      /** 새 컨텍스트지만 기존 채팅의 main-owned 작업 폴더를 이어받는다. */
      continueFromChatId?: string | null;
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
    /** "계속 라이브로" 모드 — 켜두면 Stormbreaker 연속실행이 짧은 상한에 닿아도 이 채팅에서
     *  라이브 스트리밍을 계속 이어간다(수 시간 단위). */
    setContinuousMode: (id: string, enabled: boolean) => Promise<Chat>;
    /** 스웜 모드 on/off — 여러 워커가 목표를 분해해 병렬 협업. */
    setSwarmMode: (id: string, enabled: boolean) => Promise<Chat>;
    /** 고용(빌림) 카드 채팅 바인딩 — 빈 배열이면 해고. 매 send에 자동 재주입되는 원본. */
    setHiredAgents: (id: string, cards: HiredAgentCard[]) => Promise<Chat>;
    /** 세션 recap — 자리를 비운 사이 도착한 에이전트 응답 한 줄 요약(없으면 null). */
    recap: (id: string) => Promise<{ summary: string; count: number; sinceIso: string } | null>;
    /** 이 채팅을 방금 봤다고 기록(recap 기준점 갱신). */
    markViewed: (id: string) => Promise<void>;
  };
  /** 고용(빌림) 로스터 — 사이드바 "고용 중" 섹션. 리스 캐시+기억 둥지 기반 읽기 전용. */
  hired: {
    list: () => Promise<HiredRosterItem[]>;
  };
  /** 시스템/하드웨어 설정 — 에이전트 동시성(스웜 크기) 슬라이더 등. */
  system: {
    concurrencyInfo: () => Promise<AgentConcurrencyInfo>;
    setConcurrency: (value: number) => Promise<AgentConcurrencyInfo>;
  };
  automations: {
    list: () => Promise<Automation[]>;
    get: (id: string) => Promise<Automation | null>;
    create: (input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy">) => Promise<Automation>;
    toggle: (id: string, enabled: boolean) => Promise<Automation>;
    remove: (id: string) => Promise<void>;
    /** 기존 자동화의 이름/스케줄/타깃/프롬프트/트리거를 갱신(삭제-재생성 회피, 설계 한계 #7). */
    update: (id: string, patch: AutomationUpdatePatch) => Promise<Automation>;
    updateGraph: (id: string, graph: WorkflowGraph | null) => Promise<Automation>;
    runNow: (id: string) => Promise<void>;
    listRuns: (id: string, limit?: number) => Promise<AutomationRunRecord[]>;
    /** 그래프 라이브 실행 상태 채널명 — agentlasEvents.on으로 구독해 per-node 상태를 받는다(설계 §5 P2). */
    liveRunChannel: (automationId: string) => string;
    /** 이 자동화의 최근 실행 스냅샷(per-node 상태). 라이브 오버레이 초기 하이드레이트용. */
    latestRun: (automationId: string) => Promise<WorkflowRunSnapshot | null>;
    /** 자동화 결과가 누적되는 숨김 실행 세션. 사용자가 원하면 채팅 화면에서 열 수 있다. */
    getSession: (automationId: string) => Promise<Chat>;
  };
  /** launchd LaunchAgent — 앱이 꺼져도 자동화를 도는 macOS 영속성(opt-in, 설계 §2.6). */
  launchd: {
    status: () => Promise<LaunchdStatus>;
    enable: () => Promise<LaunchdStatus>;
    disable: () => Promise<LaunchdStatus>;
  };
  /** 스케줄 문법 헬퍼 — croner는 메인에서만 돌므로 렌더러 스케줄 빌더가 IPC로 검증/표시. */
  schedule: {
    validateCron: (expr: string) => Promise<boolean>;
    describe: (spec: ScheduleSpec, locale?: "ko" | "en") => Promise<string>;
    nextRun: (spec: ScheduleSpec) => Promise<string | null>;
    defaultTz: () => Promise<string>;
  };
  /** Agent-made interactive work surfaces emitted by agents. */
  surfaces: {
    listSurfaces: (chatId?: string) => Promise<AgentlasSurfaceRecord[]>;
    getSurface: (id: string) => Promise<AgentlasSurfaceRecord | null>;
    listJobs: (surfaceId: string) => Promise<SurfaceJobRecord[]>;
    getJobSummary: (surfaceId: string) => Promise<SurfaceJobCostSummary | null>;
    updateJob: (input: SurfaceJobUpdateRequest) => Promise<SurfaceJobRecord>;
    updateState: (input: SurfaceStatePatchRequest) => Promise<AgentlasSurfaceRecord>;
    listEvents: (surfaceId: string) => Promise<SurfaceStateEventRecord[]>;
    approve: (input: SurfaceApprovalGrantRequest) => Promise<SurfaceApprovalRecord>;
    hasApproval: (input: SurfaceApprovalCheckRequest) => Promise<boolean>;
    listApprovals: (surfaceId: string) => Promise<SurfaceApprovalRecord[]>;
    revokeApproval: (id: string) => Promise<SurfaceApprovalRecord>;
  };
  /** Reusable asset packs materialized from declarative surface media/storyboard/export data. */
  surfaceAssets: {
    materialize: (input: SurfaceAssetPackRequest) => Promise<SurfaceAssetPackMaterializeResult>;
    archive: (input: SurfaceAssetPackRootRequest) => Promise<SurfaceAssetPackOperationRecord>;
    restore: (input: SurfaceAssetPackRootRequest) => Promise<SurfaceAssetPackOperationRecord>;
    listPacks: (chatId?: string) => Promise<SurfaceAssetPackRecord[]>;
    getPack: (id: string) => Promise<SurfaceAssetPackRecord | null>;
    getPackBySurface: (chatId: string, surfaceId: string) => Promise<SurfaceAssetPackRecord | null>;
    listOperations: (packId: string) => Promise<SurfaceAssetPackOperationRecord[]>;
  };
  /** Agent-made service apps generated from safe Agentlas Surface manifests. */
  appFactory: {
    scaffold: (input: AppFactoryScaffoldRequest) => Promise<AppFactoryScaffoldResult>;
    syncCloudManifest: (input: AppFactoryCloudAppManifestRequest) => Promise<AppFactoryCloudAppInstallResult>;
    runAutopilot: (input: AppFactoryAutopilotRequest) => Promise<AppFactoryAutopilotResult>;
    installMcpPlan: (input: AppFactoryRootRequest) => Promise<AppFactoryMcpInstallResult>;
    runProviderTasks: (input: AppFactoryProviderTaskRunRequest) => Promise<AppFactoryProviderTaskRunResult>;
    materializeAssets: (input: AppFactoryAssetMaterializeRequest) => Promise<AppFactoryAssetMaterializeResult>;
    activateLocalCommerceStack: (input: AppFactoryLocalCommerceActivationRequest) => Promise<AppFactoryLocalCommerceActivationResult>;
    openProviderBrowser: (input: AppFactoryProviderBrowserOpenRequest) => Promise<AppFactoryProviderBrowserOpenResult>;
    captureProviderBrowserSessions: (input: AppFactoryProviderBrowserSessionRequest) => Promise<AppFactoryProviderBrowserSessionResult>;
    launchProviderBrowserSession: (input: AppFactoryProviderBrowserLaunchRequest) => Promise<AppFactoryProviderBrowserLaunchResult>;
    syncProviderBrowserResults: (input: AppFactoryProviderBrowserResultSyncRequest) => Promise<AppFactoryProviderBrowserResultSyncResult>;
    resolveProviderCredentials: (input: AppFactoryProviderCredentialResolveRequest) => Promise<AppFactoryProviderCredentialResolveResult>;
    approveProviderPayment: (input: AppFactoryProviderPaymentApproveRequest) => Promise<AppFactoryProviderPaymentApproveResult>;
    runSmoke: (input: AppFactoryRootRequest) => Promise<AppFactorySmokeResult>;
    preparePreview: (input: AppFactoryRootRequest) => Promise<AppFactoryPreviewResult>;
    openLaunchTarget: (input: AppFactoryRootRequest) => Promise<AppFactoryLaunchTargetResult>;
    publishAsTool: (input: AppFactoryRootRequest) => Promise<AppFactoryAppToolPublishResult>;
    archive: (input: AppFactoryRootRequest) => Promise<AppFactoryOperationRecord>;
    restore: (input: AppFactoryRootRequest) => Promise<AppFactoryOperationRecord>;
    listApps: (chatId?: string) => Promise<AppFactoryAppRecord[]>;
    getApp: (id: string) => Promise<AppFactoryAppRecord | null>;
    getAppBySurface: (chatId: string, surfaceId: string) => Promise<AppFactoryAppRecord | null>;
    listOperations: (appId: string) => Promise<AppFactoryOperationRecord[]>;
  };
  /** Local meta-agent factory that materializes domain teams for Agentlas OS. */
  metaAgent: {
    createCommerceTeam: (input: MetaAgentTeamFactoryRequest) => Promise<MetaAgentTeamFactoryResult>;
  };
  /** Agent-made local tools generated from safe tool specs in Agentlas Surface manifests. */
  toolFactory: {
    scaffold: (input: ToolFactoryScaffoldRequest) => Promise<ToolFactoryScaffoldResult>;
    runSmoke: (input: ToolFactoryRootRequest) => Promise<ToolFactorySmokeResult>;
    installMcp: (input: ToolFactoryRootRequest) => Promise<ToolFactoryMcpInstallResult>;
    archive: (input: ToolFactoryRootRequest) => Promise<ToolFactoryOperationRecord>;
    restore: (input: ToolFactoryRootRequest) => Promise<ToolFactoryOperationRecord>;
    listTools: (chatId?: string) => Promise<ToolFactoryToolRecord[]>;
    getTool: (id: string) => Promise<ToolFactoryToolRecord | null>;
    getToolBySurface: (
      chatId: string,
      surfaceId: string,
      requestedToolId?: string,
    ) => Promise<ToolFactoryToolRecord | null>;
    listOperations: (toolRecordId: string) => Promise<ToolFactoryOperationRecord[]>;
  };
  /** OpenClaw / Hermes에서 페르소나·키·자동화·메모리를 가져온다.
   *  scan은 디스크를 읽어 preview(이름/개수만) 반환, import는 실제 적용. */
  migration: {
    /** ~/.openclaw, ~/.hermes를 스캔해 가져올 수 있는 것들의 preview */
    scan: () => Promise<MigrationSourcePreview[]>;
    /** preview를 실제 적용 (dryRun이면 적용 없이 결과 형태만) */
    import: (opts: MigrationOptions) => Promise<MigrationResult>;
  };
  /** 브리핑 인터뷰 모드 — 모호한 실행형 요청 앞 배치 질문 게이트 설정. */
  interview: {
    getMode: () => Promise<"smart" | "build-only" | "off">;
    setMode: (mode: "smart" | "build-only" | "off") => Promise<"smart" | "build-only" | "off">;
  };
  /** invoke:run의 chatId가 firm 채팅인지 일반 채팅인지로 자동 라우팅 */
  invoke: {
    run: (req: McpInvocationRequest) => Promise<{ runId: string }>;
    /** Queue a follow-up, cancel the current turn, then resume this chat after terminal settlement. */
    steer: (req: McpInvocationRequest) => Promise<InvocationSteerResult>;
    eventChannel: (runId: string) => string;
    /** 진행 중인 실행을 취소 — CLI 자식 프로세스 kill / API fetch abort. 병렬 세션 각각 독립 취소. */
    cancel: (runId: string) => Promise<void>;
    history: (chatId: string) => Promise<ChatHistoryEntry[]>;
    clearHistory: (chatId: string) => Promise<void>;
    /** 현재 실행 중인 chatId 목록 — 사이드바 "실행 중" 인디케이터 초기 시드용. */
    activeChats: () => Promise<string[]>;
    /** 채팅 진입 시 진행 중 실행에 재접속 — 그 chat의 runId + 지금까지 버퍼된 이벤트. 없으면 null. */
    attach: (chatId: string) => Promise<{ runId: string; events: McpInvocationEvent[] } | null>;
    /** 실행 ID의 live+durable 상태. 앱 재시작 뒤 미종결 started receipt는 interrupted로 판정한다. */
    receipt: (runId: string) => Promise<InvocationRunReceipt | null>;
    /** 채팅의 가장 최근 실행 receipt — 결과 폴더/실패 진단 복원용. */
    latestReceipt: (chatId: string) => Promise<InvocationRunReceipt | null>;
  };
  /** 임베딩된 Hephaestus 엔진 브리지. 데스크탑↔엔진 연결은 전부 이 도메인으로 흐른다.
   *  (Hephaestus 소스에는 데스크탑 흔적이 없다 — 엔진은 범용 CLI/JSON 으로만 호출됨.) */
  hephaestus: {
    /** 엔진 가용성(번들 + Python). UI 게이트에 사용. */
    status: (locale?: "ko" | "en") => Promise<HephaestusStatus>;
    /** 엔진 자가진단(JSON). */
    doctor: () => Promise<HephaestusCommandResult>;
    /** Stormbreaker 견고-실행: 쿼리 라우팅 후 가능한 pipeline execution_fabric 실행. */
    stormbreaker: (input: {
      query: string;
      project?: string;
      background?: boolean;
      researchEvidence?: boolean;
    }) => Promise<HephaestusCommandResult>;
    /** Stormbreaker 슈퍼바이저 상태. 현재 제품 UI에서는 항상 ON이며 토글은 호환 API다. */
    getSupervisor: () => Promise<{ enabled: boolean }>;
    setSupervisor: (enabled: boolean) => Promise<{ enabled: boolean }>;
    /** Stormbreaker 런 저널 검사(재개/감사). */
    journal: (input: {
      action: "status" | "verify" | "repair" | "gate";
      runId?: string;
      project?: string;
    }) => Promise<HephaestusCommandResult>;
    /** Hub/Cloud 후보 검색(실행 없음). 마켓플레이스/허브. */
    search: (input: { query: string; limit?: number }) => Promise<HephaestusCommandResult>;
    /** Hub 네트워크 라우팅(GUI 숏컷 → 라우팅 폴백). */
    network: (input: { query: string; autoRun?: boolean; noOpen?: boolean }) => Promise<HephaestusCommandResult>;
    /** 추천 미리보기 — routeOnly(실행 없음) 결정을 정규화해 추천 바텀시트에 넘긴다. 짧은 timeout(인터랙티브). */
    routePreview: (input: {
      query: string;
      project?: string;
      scope?: "network" | "cloud";
      allowLocal?: boolean;
      offline?: boolean;
    }) => Promise<Recommendation>;
    /** 패키지된 GUI 숏컷(스튜디오 등) 복원/실행. */
    localGui: (input: { shortcut: string; detach?: boolean; noOpen?: boolean }) => Promise<HephaestusCommandResult>;
    /** 에이전트 폴더 → Cloud/Hub 업로드(실 패키징 + 보안 스캔 + publish). */
    publish: (input: {
      folder: string;
      scope: FsReadScope;
      visibility: HephaestusUploadVisibility;
      dryRun?: boolean;
    }) => Promise<HephaestusCommandResult>;
    /** 업로드 전 패키징 + 정적 검토 리포트. */
    package: (input: { folder: string; scope: FsReadScope; visibility?: HephaestusUploadVisibility }) => Promise<HephaestusCommandResult>;
    /** 정적 보안 스캔. */
    securityScan: (input: { folder: string; scope: FsReadScope; strict?: boolean }) => Promise<HephaestusCommandResult>;
    /** AO(에이전트 온톨로지) 그래프 — 정보 흐름 맵 백킹 데이터. */
    aoGraph: (input?: { agent?: string; dir?: string }) => Promise<HephaestusCommandResult>;
    /** 빌더(hep-build) 스트리밍 실행 — 데스크탑 런타임 + Hephaestus 빌더 에이전트. */
    build: (input: HephaestusBuildRequest) => Promise<{ runId: string }>;
    /** 빌더 이벤트 채널명(window.agentlasEvents.on 으로 구독). */
    buildEventChannel: (runId: string) => string;
    /** 채널 구독 완료 신호 — 구독 전 버퍼링된 초기 이벤트를 flush 한다(첫 stage 틱 유실 방지). */
    buildReady: (runId: string) => Promise<void>;
    /** 진행 중 빌드 취소. */
    cancelBuild: (runId: string) => Promise<void>;
    /** Startup Founder Studio — 패키지의 실제 GUI 런처를 띄우고 iframe 용 로컬 URL 반환. */
    startStudio: (input?: { idea?: string }) => Promise<{ ok: boolean; url?: string; reason?: string; ideaQueued?: boolean }>;
    stopStudio: () => Promise<void>;
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
