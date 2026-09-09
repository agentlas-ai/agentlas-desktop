import { createHash, randomUUID } from "node:crypto";
import type {
  InstalledMcpServer,
  McpBuildCandidate,
  McpBuildConsent,
  McpBuildPlan,
  McpBuildRecommendationReasonCode,
  McpBuildRecommendationInput,
  McpToolCatalogEntry,
  MarketplaceListing,
  RuntimeSelection,
} from "../../shared/types";
import { hasEnvVar } from "../secrets/vault";
import { detectRuntimes } from "../runtime/detect";
import { pickActive } from "../runtime/selection";
import { MCP_TOOL_CATALOG } from "./catalog";
import { fetchHubPluginInventory, hubListingDescription } from "./auto-select";
import { installedServerMatchesPluginSlug, normalizePluginSlug } from "../../shared/plugin-slug";
import { listInstalledServers } from "./registry";
import {
  isRuntimeMcpCompatible,
  persistHostMcpBuildReceipt,
  resolveApprovedMcpCandidates,
  type InternalMcpBuildCandidate,
  type McpAttachmentResolverDependencies,
  type ResolvedMcpBuildAttachment,
} from "./attachment-resolver";
import {
  resolveMcpBuildRecommendations,
  type McpBuildRecommendCandidate,
  type ResolvedMcpBuildRecommendations,
} from "./need-resolver";

const PLAN_TTL_MS = 20 * 60 * 1_000;
const APPLIED_PLAN_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CANDIDATES = 10;

// Which tools get OFFERED is decided by the connected model (resolveMcpBuildRecommendations).
// The `hints` wordlists below no longer score anything: they ride along as reference material
// in the judgment prompt ("these words *may* suggest this tool"), because a hand-maintained
// list can never enumerate every language a build request arrives in.
interface CatalogRule {
  capability: string;
  fallbackGroup: string;
  priority: number;
  hints: string[];
}

const CATALOG_RULES: Record<string, CatalogRule> = {
  "agentlas-browser": {
    capability: "browser",
    fallbackGroup: "browser",
    priority: 100,
    hints: ["browser", "chrome", "login", "click", "instagram", "upload", "post", "브라우저", "크롬", "로그인", "클릭", "인스타", "업로드", "게시"],
  },
  playwright: {
    capability: "browser",
    fallbackGroup: "browser",
    priority: 80,
    hints: ["browser", "web", "click", "screenshot", "test", "브라우저", "웹", "클릭", "스크린샷", "테스트"],
  },
  "cua-driver": {
    capability: "computer-use",
    fallbackGroup: "computer-use",
    priority: 100,
    hints: ["desktop", "screen", "app", "electron", "mac", "데스크탑", "화면", "앱", "검증"],
  },
  "workspace-preview": {
    capability: "workspace-preview",
    fallbackGroup: "workspace-preview",
    priority: 100,
    hints: ["dev server", "development server", "preview", "localhost", "vite", "next dev", "개발 서버", "미리보기", "로컬 서버"],
  },
  "hephaestus-network": {
    capability: "agent-routing",
    fallbackGroup: "agent-routing",
    priority: 100,
    // "agent"/"team"/"에이전트"/"팀" 단독 단어는 빼야 한다 — 빌드 요청은 거의 항상
    // "~하는 에이전트 만들어줘"라서 그 단어들만으로는 모든 빌드가 자동 매치되는
    // 자기참조 오탐이 난다(2026-07-16 실측). 실제 Hub/Cloud 라우팅 의도가 드러나는
    // 구체적인 구문만 남긴다.
    hints: [
      "hephaestus",
      "agentlas hub",
      "agentlas 허브",
      "허브에서",
      "허브 에이전트",
      "허브 플러그인",
      "허브 팀",
      "hub agent",
      "hub specialist",
      "hub plugin",
      "에이전트 빌려",
      "팀 빌려",
      "다른 에이전트 호출",
      "에이전트 라우팅",
      "클라우드 에이전트",
      "클라우드 팀",
    ],
  },
  "brave-search": {
    capability: "web-search",
    fallbackGroup: "web-search",
    priority: 100,
    hints: ["research", "search", "latest", "news", "source", "리서치", "검색", "최신", "뉴스", "출처", "조사"],
  },
  github: {
    capability: "github",
    fallbackGroup: "github",
    priority: 100,
    hints: ["github", "repo", "repository", "pull request", "issue", "commit", "깃허브", "리포", "이슈", "커밋"],
  },
  filesystem: {
    capability: "filesystem",
    fallbackGroup: "filesystem",
    priority: 100,
    hints: ["file", "folder", "workspace", "repo", "write", "edit", "파일", "폴더", "워크스페이스", "수정", "생성"],
  },
  postgres: {
    capability: "database",
    fallbackGroup: "database",
    priority: 100,
    hints: ["postgres", "postgresql", "database", "sql", "db", "데이터베이스"],
  },
  notion: {
    capability: "notion",
    fallbackGroup: "notion",
    priority: 100,
    hints: ["notion", "노션"],
  },
  linear: {
    capability: "linear",
    fallbackGroup: "linear",
    priority: 100,
    hints: ["linear", "sprint", "리니어", "스프린트"],
  },
  slack: {
    capability: "slack",
    fallbackGroup: "slack",
    priority: 100,
    hints: ["slack", "channel", "슬랙", "채널"],
  },
  discord: {
    capability: "discord",
    fallbackGroup: "discord",
    priority: 100,
    hints: ["discord", "디스코드"],
  },
  shadcn: {
    capability: "ui-components",
    fallbackGroup: "ui-components",
    priority: 100,
    hints: ["shadcn", "component", "ui", "컴포넌트"],
  },
};

export interface McpBuildPlanDependencies {
  listInstalled: () => InstalledMcpServer[];
  hasEnv: (key: string) => Promise<boolean>;
  now: () => Date;
  resolveRuntime: () => Promise<RuntimeSelection | null>;
  /** The connected model decides which tools to offer. Tests inject a deterministic double. */
  resolveRecommendations: (input: {
    request: string;
    candidates: McpBuildRecommendCandidate[];
    hints?: Array<{ label: string; words: string[] }>;
  }) => Promise<ResolvedMcpBuildRecommendations>;
  /** Hub plugin inventory. Shares the agent-execution path's wiring so the two never diverge. */
  fetchHubPlugins: () => Promise<{ listings: MarketplaceListing[]; hubPluginError?: string }>;
}

const DEFAULT_DEPS: McpBuildPlanDependencies = {
  listInstalled: listInstalledServers,
  hasEnv: hasEnvVar,
  fetchHubPlugins: () => fetchHubPluginInventory(true),
  now: () => new Date(),
  resolveRuntime: async () => {
    const active = pickActive(await detectRuntimes());
    return active
      ? {
          kind: active.kind,
          backend: active.backend,
          source: active.source,
          model: active.model ?? undefined,
          longContext: active.longContextEnabled,
          effort: active.effort ?? undefined,
        }
      : null;
  },
  resolveRecommendations: resolveMcpBuildRecommendations,
};

/** Exposed so tests can spread the real defaults and replace only the judge. */
export const defaultMcpBuildPlanDeps: McpBuildPlanDependencies = DEFAULT_DEPS;

interface StoredBuildPlan {
  publicPlan: McpBuildPlan;
  requestHash: string;
  runtime: RuntimeSelection | null;
  candidates: InternalMcpBuildCandidate[];
  /**
   * Frozen before the first resolver microtask is allowed to run. Keeping the
   * promise (including a rejection) makes consent a true one-shot operation:
   * retries cannot repeat installs, probes, config writes, or receipt writes.
   */
  application?: {
    selectedKey: string;
    promise: Promise<ResolvedMcpBuildAttachment>;
  };
}

const plans = new Map<string, StoredBuildPlan>();

function runtimeKey(runtime: RuntimeSelection | undefined | null): string {
  if (!runtime) return "auto:none";
  return [
    runtime.kind,
    runtime.backend ?? "",
    runtime.source ?? "",
    runtime.model ?? "",
    runtime.longContext ? "long" : "standard",
    runtime.effort ?? "",
  ].join(":");
}

function requestHash(input: McpBuildRecommendationInput): string {
  return createHash("sha256")
    .update(input.request.trim())
    .update("\0")
    .update(input.mode ?? "auto")
    .update("\0")
    .update(runtimeKey(input.runtime))
    .digest("hex");
}

function safeName(raw: string, fallback: string): string {
  const value = raw.trim().slice(0, 120);
  if (
    !value ||
    /(?:https?|sse|vault):\/\/|(?:token|secret|key)=|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
  ) return fallback;
  return value;
}

function minimumPermission(capability: string): "read" | "write" | "full" {
  if (capability === "web-search" || capability === "database") return "read";
  if (capability === "workspace-preview") return "full";
  if (capability === "github" || capability === "filesystem" || capability === "notion") return "write";
  return "full";
}

function minimumScopes(capability: string): string[] {
  const scopes: Record<string, string[]> = {
    browser: ["approved-browser-session"],
    "computer-use": ["approved-desktop-session"],
    "agent-routing": ["agent-discovery"],
    "web-search": ["public-web-read"],
    github: ["selected-repository"],
    filesystem: ["selected-workspace"],
    database: ["selected-database-read"],
    notion: ["selected-workspace-pages"],
    linear: ["selected-workspace-issues"],
    slack: ["selected-workspace-channels"],
    discord: ["selected-server-channels"],
    "ui-components": ["public-component-catalog"],
    custom: ["user-configured-server"],
    "workspace-preview": ["selected-workspace", "full-execution-approval"],
  };
  return scopes[capability] ?? ["task-relevant-only"];
}

function recommendationReasonCode(capability: string): McpBuildRecommendationReasonCode {
  const code: Record<string, McpBuildRecommendationReasonCode> = {
    browser: "browser-interaction",
    "computer-use": "desktop-interaction",
    "agent-routing": "agent-routing",
    "web-search": "current-web-research",
    github: "repository-work",
    filesystem: "workspace-files",
    database: "database-work",
    notion: "notion-work",
    linear: "linear-work",
    slack: "slack-work",
    discord: "discord-work",
    "ui-components": "ui-components",
    custom: "custom-name-match",
    "workspace-preview": "workspace-preview",
  };
  return code[capability] ?? "task-match";
}

// Lazyweb/opencrab are never silently recommended in Agentlas product flows. They remain
// available in the global MCP manager for explicit user choice.
// OpenCrab used to be excluded here and offered instead through a bespoke
// "shall I check OpenCrab?" interview card with its own request field and prompt
// block. Owner decision 2026-08-16: it is one MCP among many — no special case.
// It now competes for selection like every other tool.
const NEVER_AUTO_RECOMMENDED = new Set(["lazyweb"]);

const CUSTOM_ID_PREFIX = "custom:";
const HUB_ID_PREFIX = "hub:";

async function keyState(
  keys: string[],
  deps: McpBuildPlanDependencies,
): Promise<"not-required" | "present" | "missing"> {
  if (keys.length === 0) return "not-required";
  const checks = await Promise.all(keys.map((key) => deps.hasEnv(key).catch(() => false)));
  return checks.every(Boolean) ? "present" : "missing";
}

function cleanupExpired(now: Date): void {
  for (const [id, plan] of plans) {
    if (Date.parse(plan.publicPlan.expiresAt) <= now.getTime()) plans.delete(id);
  }
}

function ruleFor(entry: McpToolCatalogEntry): CatalogRule {
  return CATALOG_RULES[entry.id] ?? {
    capability: entry.category,
    fallbackGroup: entry.id,
    priority: 50,
    hints: [],
  };
}

/** Read-only: global registry + catalog metadata + Keychain presence booleans only. */
export async function recommendMcpBuildPlan(
  input: McpBuildRecommendationInput,
  deps: McpBuildPlanDependencies = DEFAULT_DEPS,
): Promise<McpBuildPlan> {
  const request = input.request.trim();
  if (!request) throw new Error("Build MCP recommendation requires a request.");
  const now = deps.now();
  cleanupExpired(now);
  let warningCode: McpBuildPlan["warningCode"] = null;
  let runtime: RuntimeSelection | null = input.runtime ?? null;
  if (!input.runtime) {
    try {
      runtime = await deps.resolveRuntime();
    } catch {
      runtime = null;
      warningCode = "runtime_detection_unavailable";
    }
  }
  let installed: InstalledMcpServer[] = [];
  try {
    installed = deps.listInstalled();
  } catch {
    installed = [];
    warningCode = warningCode ? "recommendation_unavailable" : "registry_unavailable";
  }
  const installedByCatalog = new Map(
    installed
      .filter((server): server is InstalledMcpServer & { catalogId: string } => Boolean(server.catalogId))
      .map((server) => [server.catalogId, server]),
  );

  const offerableCatalog = MCP_TOOL_CATALOG.filter((entry) => !NEVER_AUTO_RECOMMENDED.has(entry.id));
  const customServers = installed.filter((item) => !item.catalogId);

  // 허브 플러그인을 후보에 합친다.
  //
  // 2026-08-16 실측: 이 목록은 로컬 카탈로그 14개 + 커스텀뿐이었고, 허브의 플러그인
  // 140여 개는 빌드에서 아예 보이지 않았다. 그래서 어떤 요청을 넣어도 그 14개 안에서만
  // 골라졌고(예: "경영전략 기획" → Brave Search 하나), 사용자는 도구가 안 붙는다고 느꼈다.
  // 에이전트 **실행** 경로는 이미 허브를 합치고 있었으므로(auto-select.ts) 그 배선을
  // 그대로 재사용한다 — 빌드만 따로 구현하면 다시 갈라진다.
  const hubInventory = await deps.fetchHubPlugins().catch(() => ({ listings: [], hubPluginError: "hub lookup failed" }));
  // 허브 플러그인 중에는 MCP 서버가 아니라 스킬을 싣는 것들이 있다
  // (`packageShape.mcpReference === "none"`). 붙일 서버가 없는 게 정상이므로
  // 연결 실패로 처리하면 안 되고, 능력 선언으로 빌더에게 넘겨야 한다.
  const skillBundles = new Map<string, { slug: string; name: string; intent: string; capabilities: string[] }>();
  await Promise.all(hubInventory.listings.slice(0, 60).map(async (listing) => {
    try {
      const res = await fetch(listing.manifestUrl, { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const m = (await res.json()) as Record<string, unknown>;
      const mcp = Array.isArray(m.mcp) ? m.mcp : [];
      const shape = (m.architecture as { packageShape?: { mcpReference?: unknown } } | undefined)?.packageShape;
      const skillOnly = mcp.length === 0 && (shape?.mcpReference === "none" || Array.isArray(m.skills));
      if (!skillOnly) return;
      const agents = Array.isArray(m.agents) ? m.agents as Array<{ intent?: unknown }> : [];
      skillBundles.set(listing.slug, {
        slug: listing.slug,
        name: String(m.name ?? listing.name),
        intent: String(agents[0]?.intent ?? m.description ?? listing.tagline ?? ""),
        capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
      });
    } catch {
      /* 매니페스트를 못 읽으면 그냥 일반 후보로 둔다 — 추측하지 않는다 */
    }
  }));
  const catalogSlugs = new Set(offerableCatalog.map((entry) => normalizePluginSlug(entry.id)));
  const hubCandidates = hubInventory.listings
    // 로컬 카탈로그에 같은 도구가 있으면 로컬이 이긴다 — 로컬은 설치 경로가 검증돼 있다.
    .filter((listing) => !catalogSlugs.has(normalizePluginSlug(listing.slug)))
    .map((listing) => ({
      id: `${HUB_ID_PREFIX}${listing.slug}`,
      name: listing.nameEn || listing.name,
      description: hubListingDescription(listing),
      origin: "hub" as const,
      needsCredential: false,
    }));
  if (hubInventory.hubPluginError) {
    // 허브가 죽어도 빌드는 계속된다. 다만 "후보가 원래 이것뿐"인 것과
    // "허브를 못 읽어 좁아진 것"은 다른 상태이므로 경고로 남긴다.
    warningCode = warningCode ?? "recommendation_unavailable";
  }

  const judgeInventory: McpBuildRecommendCandidate[] = [
    ...offerableCatalog.map((entry) => ({
      id: entry.id,
      name: entry.nameEn || entry.name,
      description: entry.descriptionEn || entry.description,
      origin: "catalog" as const,
      needsCredential: entry.envRequirements.some((requirement) => requirement.required),
    })),
    ...customServers.map((server) => ({
      id: `${CUSTOM_ID_PREFIX}${server.id}`,
      name: server.nameEn || server.name,
      description: "User-installed custom MCP server.",
      origin: "custom" as const,
      needsCredential: server.envKeys.length > 0,
    })),
    ...hubCandidates,
  ];
  const referenceHints = offerableCatalog
    .map((entry) => ({ label: entry.id, words: CATALOG_RULES[entry.id]?.hints ?? [] }))
    .filter((hint) => hint.words.length > 0);

  let recommendation: ResolvedMcpBuildRecommendations;
  try {
    recommendation = await deps.resolveRecommendations({
      request,
      candidates: judgeInventory,
      hints: referenceHints,
    });
  } catch {
    recommendation = { recommended: [], decided: false, reason: "recommendation judge failed", omitted: [] };
  }
  if (!recommendation.decided) {
    // No connected model reached a verdict. An undecided plan offers nothing —
    // it never falls back to keyword scores — and the renderer's existing
    // recommendation_unavailable path lets the build proceed without MCP.
    const planId = randomUUID();
    const publicPlan: McpBuildPlan = {
      id: planId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
      runtimeKind: runtime?.kind ?? null,
      status: "degraded",
      warningCode: "recommendation_unavailable",
      candidates: [],
    };
    plans.set(planId, { publicPlan, requestHash: requestHash(input), runtime, candidates: [] });
    return publicPlan;
  }

  // 판정은 모델이 한다. 다만 모델이 "보지도 못한" 후보가 있으면 그건 판정이 아니라
  // 절단이므로 반드시 남긴다 — 조용한 절단은 "모델이 안 골랐다"로 위장된다.
  console.log(
    `[mcp-build] candidates=${judgeInventory.length} `
    + `(catalog=${offerableCatalog.length} custom=${customServers.length} hub=${hubCandidates.length}) `
    + `recommended=${recommendation.recommended.length} decided=${recommendation.decided}`
    + (recommendation.omitted.length > 0 ? ` OMITTED=${recommendation.omitted.length}` : "")
    + (hubInventory.hubPluginError ? ` hubError=${hubInventory.hubPluginError}` : ""),
  );

  const directRank = new Map(recommendation.recommended.map((id, index) => [id, index]));
  const pickedGroups = new Set(
    offerableCatalog.filter((entry) => directRank.has(entry.id)).map((entry) => ruleFor(entry).fallbackGroup),
  );

  const scored: Array<{ score: number; installedRank: number; candidate: InternalMcpBuildCandidate }> = [];
  for (const entry of offerableCatalog) {
    // Direct model picks rank first; the rest of a picked capability group rides
    // along as failover alternates (the attachment resolver attaches one per group).
    const rank = directRank.get(entry.id);
    const score = rank !== undefined
      ? 1_000 - rank
      : pickedGroups.has(ruleFor(entry).fallbackGroup)
        ? 1
        : 0;
    const server = installedByCatalog.get(entry.id) ?? null;
    if (score <= 0) continue;
    const envKeys = server?.envKeys ?? entry.envRequirements.filter((requirement) => requirement.required).map((requirement) => requirement.key);
    const keys = await keyState(envKeys, deps);
    const enabled = server?.enabled ?? true;
    const compatible = isRuntimeMcpCompatible(runtime, entry.transport);
    const readiness = !compatible
      ? "runtime-incompatible"
      : !enabled
        ? "disabled"
        : keys === "missing"
          ? "missing-key"
          : server
            ? "ready"
            : "available";
    const rule = ruleFor(entry);
    const publicCandidate: McpBuildCandidate = {
      id: `candidate-${randomUUID()}`,
      catalogId: entry.id,
      name: safeName(entry.nameEn || entry.name, entry.id),
      capability: rule.capability,
      reason: server ? "installed-match" : "request-match",
      recommendationReasonCode: recommendationReasonCode(rule.capability),
      requiresKey: envKeys.length > 0,
      minimumPermission: minimumPermission(rule.capability),
      minimumScopes: minimumScopes(rule.capability),
      permissionBasis: "host-inferred",
      permissionEnforced: false,
      source: server ? "system-registry" : "catalog",
      installed: Boolean(server),
      enabled,
      keyState: keys,
      readiness,
      defaultSelected: readiness === "ready" || readiness === "available",
      fallbackGroup: rule.fallbackGroup,
      priority: rule.priority,
    };
    scored.push({
      score,
      installedRank: server ? 1 : 0,
      candidate: {
        public: publicCandidate,
        serverId: server?.id ?? null,
        envKeys,
        transport: entry.transport,
      },
    });
  }

  // 모델이 고른 허브 플러그인을 실제 후보로 만든다. 이 루프가 없으면 후보 목록에만
  // 허브가 실리고 선택은 조용히 버려진다 — 선언만 하고 배선을 안 하는 그 결함이다.
  for (const listing of hubInventory.listings) {
    const rank = directRank.get(`${HUB_ID_PREFIX}${listing.slug}`);
    if (rank === undefined) continue;
    const existing = installed.find((server) => installedServerMatchesPluginSlug(server, listing.slug)) ?? null;
    // 허브 플러그인의 전송 방식은 매니페스트를 열어야 알 수 있다. 승인 시점에
    // 실제로 붙여 보고 판정하므로, 목록 단계에서는 런타임 호환을 막지 않는다.
    const transport = existing?.transport ?? "http";
    const envKeys = existing?.envKeys ?? [];
    const keys = await keyState(envKeys, deps);
    const readiness = existing
      ? existing.enabled
        ? keys === "missing" ? "missing-key" : "ready"
        : "disabled"
      : "available";
    scored.push({
      score: 1_000 - rank,
      installedRank: existing ? 1 : 0,
      candidate: {
        public: {
          id: `candidate-${randomUUID()}`,
          catalogId: null,
          name: safeName(listing.nameEn || listing.name, listing.slug),
          capability: listing.category || "hub-plugin",
          reason: existing ? "installed-match" : "request-match",
          recommendationReasonCode: "hub-plugin-match",
          requiresKey: envKeys.length > 0,
          minimumPermission: "read",
          minimumScopes: [],
          permissionBasis: "host-inferred",
          permissionEnforced: false,
          source: "hub",
          installed: Boolean(existing),
          enabled: existing?.enabled ?? true,
          keyState: keys,
          readiness,
          defaultSelected: readiness === "ready" || readiness === "available",
          // 허브 항목은 slug 자체가 기능 그룹이다 — 로컬 규칙표에 없으므로
          // 같은 slug끼리만 폴백 형제로 묶인다.
          fallbackGroup: `hub:${normalizePluginSlug(listing.slug)}`,
          priority: 50,
        },
        serverId: existing?.id ?? null,
        envKeys,
        transport,
        hub: { slug: listing.slug, manifestUrl: listing.manifestUrl },
        ...(skillBundles.has(listing.slug) ? { skillBundle: skillBundles.get(listing.slug)! } : {}),
      },
    });
  }

  for (const server of customServers) {
    const rank = directRank.get(`${CUSTOM_ID_PREFIX}${server.id}`);
    if (rank === undefined) continue;
    const score = 1_000 - rank;
    const keys = await keyState(server.envKeys, deps);
    const compatible = isRuntimeMcpCompatible(runtime, server.transport);
    const readiness = !compatible
      ? "runtime-incompatible"
      : !server.enabled
        ? "disabled"
        : keys === "missing"
          ? "missing-key"
          : "ready";
    const id = `candidate-${randomUUID()}`;
    scored.push({
      score,
      installedRank: 1,
      candidate: {
        public: {
          id,
          catalogId: null,
          name: safeName(server.nameEn || server.name, "Custom MCP"),
          capability: "custom",
          reason: "user-installed",
          recommendationReasonCode: recommendationReasonCode("custom"),
          requiresKey: server.envKeys.length > 0,
          minimumPermission: "full",
          minimumScopes: minimumScopes("custom"),
          permissionBasis: "unknown",
          permissionEnforced: false,
          source: "system-registry",
          installed: true,
          enabled: server.enabled,
          keyState: keys,
          readiness,
          defaultSelected: readiness === "ready",
          fallbackGroup: id,
          priority: 100,
        },
        serverId: server.id,
        envKeys: [...server.envKeys],
        transport: server.transport,
      },
    });
  }

  scored.sort((a, b) => {
    if (b.installedRank !== a.installedRank) return b.installedRank - a.installedRank;
    if (b.score !== a.score) return b.score - a.score;
    if (b.candidate.public.priority !== a.candidate.public.priority) {
      return b.candidate.public.priority - a.candidate.public.priority;
    }
    return a.candidate.public.id.localeCompare(b.candidate.public.id);
  });
  const candidates = scored.slice(0, MAX_CANDIDATES).map((item) => item.candidate);
  const planId = randomUUID();
  const expiresAt = new Date(now.getTime() + PLAN_TTL_MS).toISOString();
  const publicPlan: McpBuildPlan = {
    id: planId,
    createdAt: now.toISOString(),
    expiresAt,
    runtimeKind: runtime?.kind ?? null,
    status: warningCode ? "degraded" : "ready",
    warningCode,
    candidates: candidates.map((candidate) => candidate.public),
  };
  plans.set(planId, {
    publicPlan,
    requestHash: requestHash(input),
    runtime,
    candidates,
  });
  return publicPlan;
}

export async function applyMcpBuildConsent(input: {
  request: string;
  mode?: McpBuildRecommendationInput["mode"];
  runtime?: RuntimeSelection;
  consent: McpBuildConsent;
  resolverDeps?: McpAttachmentResolverDependencies;
  receiptPersistence?: (receipt: ResolvedMcpBuildAttachment["receipt"]) => string;
}): Promise<{ runtime: RuntimeSelection | null; attachment: ResolvedMcpBuildAttachment }> {
  const now = new Date();
  cleanupExpired(now);
  let plan = plans.get(input.consent.planId);
  if (!plan && input.consent.fallbackReason === "recommendation_unavailable") {
    if (
      !/^renderer-mcp-unavailable-[a-z0-9-]{8,100}$/i.test(input.consent.planId) ||
      input.consent.selectedCandidateIds.length > 0
    ) {
      throw new Error("Unavailable MCP recommendation fallback must use an empty reviewed plan.");
    }
    const runtime = input.runtime ?? null;
    const createdAt = now.toISOString();
    plan = {
      publicPlan: {
        id: input.consent.planId,
        createdAt,
        expiresAt: new Date(now.getTime() + APPLIED_PLAN_TTL_MS).toISOString(),
        runtimeKind: runtime?.kind ?? null,
        status: "unavailable",
        warningCode: "recommendation_unavailable",
        candidates: [],
      },
      requestHash: requestHash({ request: input.request, mode: input.mode, runtime: input.runtime }),
      runtime,
      candidates: [],
    };
    // Publish the synthetic plan before any async resolver/persistence work so
    // two renderer retries also share the same single flight.
    plans.set(input.consent.planId, plan);
  }
  if (!plan) throw new Error("MCP build plan is missing or expired. Review the MCP plan again.");
  if (
    plan.requestHash !==
    requestHash({ request: input.request, mode: input.mode, runtime: input.runtime })
  ) {
    throw new Error("MCP build plan no longer matches this request, mode, or runtime.");
  }
  const selected = [...new Set(input.consent.selectedCandidateIds)].sort();
  if (selected.length > plan.candidates.length) throw new Error("MCP consent exceeds the reviewed plan.");
  const reviewedIds = new Set(plan.candidates.map((candidate) => candidate.public.id));
  if (selected.some((candidateId) => !reviewedIds.has(candidateId))) {
    throw new Error("MCP consent contains a candidate outside its plan.");
  }
  const selectedKey = selected.join("\0");
  if (plan.application) {
    if (plan.application.selectedKey !== selectedKey) {
      throw new Error("An applied MCP plan cannot be changed. Review a new plan instead.");
    }
    return { runtime: plan.runtime, attachment: await plan.application.promise };
  }

  // Promise.resolve().then(...) is deliberate: it gives us a synchronous point
  // to freeze selectedKey before list/install/probe/config/receipt side effects.
  const application = Promise.resolve().then(async () => {
    const attachment = await resolveApprovedMcpCandidates({
      planId: plan!.publicPlan.id,
      candidates: plan!.candidates,
      selectedCandidateIds: selected,
      runtime: plan!.runtime,
      deps: input.resolverDeps,
    });
    persistAttachmentBestEffort(attachment, input.receiptPersistence);
    plan!.publicPlan.expiresAt = new Date(now.getTime() + APPLIED_PLAN_TTL_MS).toISOString();
    return attachment;
  });
  plan.application = { selectedKey, promise: application };
  const attachment = await application;
  return { runtime: plan.runtime, attachment };
}

function persistAttachmentBestEffort(
  attachment: ResolvedMcpBuildAttachment,
  persistence?: (receipt: ResolvedMcpBuildAttachment["receipt"]) => string,
): void {
  try {
    attachment.receipt.hostReceiptStored = true;
    attachment.receipt.hostReceiptWarning = null;
    (persistence ?? persistHostMcpBuildReceipt)(attachment.receipt);
  } catch {
    // Receipt durability is diagnostic only. Disk-full, permissions, or an
    // interrupted rename must never turn a healthy MCP resolution into a Build
    // shortage. The cached applied plan also prevents a second write attempt.
    attachment.receipt.hostReceiptStored = false;
    attachment.receipt.hostReceiptWarning = "receipt_storage_failed";
  }
}

/** Test-only isolation. Production callers never enumerate or mutate plan internals. */
export function clearMcpBuildPlansForTest(): void {
  plans.clear();
}
