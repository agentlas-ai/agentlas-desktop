// Main 프로세스 ↔ Renderer 간 공유 타입.
// renderer/lib/types.ts에서 re-export.
import type {
  MultimodalProvider,
  MultimodalProviderStatus,
  MultimodalSettings,
} from "./multimodal";
import type { OberonTitleSpec } from "./oberon-titles";
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

export type RuntimeKind = "claude-code" | "codex" | "gemini" | "byok" | "ollama";

/** LLM 제공자. "ollama"는 로컬 머신에서 도는 오픈 모델(gemma/deepseek 등). */
export type RuntimeBackend = "anthropic" | "openai" | "google" | "ollama" | "upstage" | "custom";

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
  visibility?: AgentVisibility;
  cloudPackage?: CloudAgentPackageDownload;
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

export interface CloudAgentPublishRequest {
  /** Local agent/team/repo folder to package. */
  rootPath: string;
  /** Optional public slug. If omitted, derived from the folder/name. */
  slug?: string;
  /** Default marketplace; private-link creates an unlisted package once server supports it. */
  visibility?: CloudAgentVisibility;
  /** true packages and reviews locally but does not call agentlas.cloud. */
  dryRun?: boolean;
  /** static-only is free; local-runtime uses the submitter's active CLI/BYOK/local runtime. */
  reviewMode?: CloudAgentReviewMode;
  /** Optional operator note stored with the registration request. */
  notes?: string;
}

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
  included: boolean;
  reason?: string;
}

export interface CloudAgentPackageDownloadFile {
  path: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
}

export interface CloudAgentPackageDownload {
  packageHash: string;
  fileCount: number;
  totalBytes: number;
  agentKind: "agent" | "team" | "repo";
  runtimeLabels: string[];
  files: CloudAgentPackageDownloadFile[];
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
  url?: string;
  marketplaceUrl?: string;
  registeredAt: string;
  dryRun: boolean;
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
  /** 기존 생성 App을 채팅에서 수정/보관할 때 지정하는 대상. */
  targetAppId?: string;
  targetAppAction?: "edit" | "archive";
}

export interface McpInvocationEvent {
  kind: "thinking" | "tool-use" | "partial" | "final" | "error" | "surface";
  status?: string;
  text?: string;
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
  agentId: string;
  firmId: string | null;
  /** 질문 메시지 시각(ISO) */
  createdAt: string;
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

// ── Oberon text planning jobs ──────────────────────────────────
export type OberonPlanRuntime = "claude-code" | "codex" | "gemini";

export interface OberonPlanRequest {
  productionId?: string;
  brief: JsonObject;
  runtime?: OberonPlanRuntime | string;
  runtimeLabel?: string;
  premium?: boolean;
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
}

// ── Oberon keyframe image jobs ─────────────────────────────────
export type OberonKeyframeProvider = "codex-imagegen-cli" | "google-imagen";
export type OberonKeyframeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface OberonKeyframeShotInput {
  shotId: string;
  index: number;
  aspectRatio: string;
  prompt: string;
  negativePrompt?: string;
  cameraSize?: string;
  continuityRefs?: string[];
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
  kind: "first_frame";
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

// ── Hephaestus 엔진 브리지 ──────────────────────────────────────────────────
/** 임베딩된 Hephaestus 엔진의 가용성. */
export interface HephaestusStatus {
  available: boolean;
  reason?: string;
  root: string | null;
  python: string | null;
  version: string | null;
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
  result?: unknown;
}
export interface HephaestusBuildRequest {
  /** 빌드 요청(자연어). */
  request: string;
  /** single | team | package(repair) — 미지정 시 엔진 mode-classification 에 위임. */
  mode?: "single" | "team" | "package";
  /** 결과 패키지를 생성할 작업 폴더(워크스페이스). */
  workspace: string;
  /** 사용할 런타임 선택(미지정 시 활성 런타임). */
  runtime?: RuntimeSelection;
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
  /** LLM 엔진 사용량 — 프로바이더 OAuth usage 엔드포인트(Claude/Codex/Gemini)에서
   *  5시간·주간(7일)·모델별·월 크레딧 조회. main에서 60초 캐시; force로 강제 갱신. */
  usage: {
    snapshot: (opts?: { force?: boolean }) => Promise<UsageSnapshot>;
  };
  /** 확인 요청 — 에이전트가 챗에서 사용자 결정을 기다리는 채팅 목록(미답변 질문 fence 기준). */
  confirm: {
    listPending: () => Promise<PendingConfirmation[]>;
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
    getKeyframeJob: (id: string) => Promise<OberonKeyframeJob | null>;
    cancelKeyframes: (id: string) => Promise<OberonKeyframeJob | null>;
    openKeyframeOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
    startRender: (request: OberonRenderRequest) => Promise<OberonRenderJob>;
    getRenderJob: (id: string) => Promise<OberonRenderJob | null>;
    cancelRender: (id: string) => Promise<OberonRenderJob | null>;
    openRenderOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
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
  /** Publish local agent/team packages to Agentlas Cloud. Review runs locally on the submitter machine. */
  cloudAgents: {
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
  projects: {
    list: () => Promise<Project[]>;
    create: (input: { name: string; defaultAgentId?: string | null; contextNote?: string | null; folderPath?: string | null }) => Promise<Project>;
    get: (id: string) => Promise<Project | null>;
    update: (id: string, patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId" | "folderPath">>) => Promise<Project>;
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
  /** 임베딩된 Hephaestus 엔진 브리지. 데스크탑↔엔진 연결은 전부 이 도메인으로 흐른다.
   *  (Hephaestus 소스에는 데스크탑 흔적이 없다 — 엔진은 범용 CLI/JSON 으로만 호출됨.) */
  hephaestus: {
    /** 엔진 가용성(번들 + Python). UI 게이트에 사용. */
    status: () => Promise<HephaestusStatus>;
    /** 엔진 자가진단(JSON). */
    doctor: () => Promise<HephaestusCommandResult>;
    /** Stormbreaker 견고-실행: 쿼리 라우팅 후 pipeline execution_fabric 자동 실행. */
    stormbreaker: (input: {
      query: string;
      project?: string;
      background?: boolean;
      researchEvidence?: boolean;
    }) => Promise<HephaestusCommandResult>;
    /** Stormbreaker 슈퍼바이저(앱 전역 자동 실행) 상태/토글. */
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
    /** 패키지된 GUI 숏컷(스튜디오 등) 복원/실행. */
    localGui: (input: { shortcut: string; detach?: boolean; noOpen?: boolean }) => Promise<HephaestusCommandResult>;
    /** 에이전트 폴더 → Cloud/Hub 업로드(실 패키징 + 보안 스캔 + publish). */
    publish: (input: {
      folder: string;
      visibility: HephaestusUploadVisibility;
      dryRun?: boolean;
    }) => Promise<HephaestusCommandResult>;
    /** 업로드 전 패키징 + 정적 검토 리포트. */
    package: (input: { folder: string; visibility?: HephaestusUploadVisibility }) => Promise<HephaestusCommandResult>;
    /** 정적 보안 스캔. */
    securityScan: (input: { folder: string; strict?: boolean }) => Promise<HephaestusCommandResult>;
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
    startStudio: () => Promise<{ ok: boolean; url?: string; reason?: string }>;
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
