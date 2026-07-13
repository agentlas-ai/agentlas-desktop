import { createHash, randomUUID } from "node:crypto";
import type {
  InstalledMcpServer,
  McpBuildCandidate,
  McpBuildConsent,
  McpBuildPlan,
  McpBuildRecommendationReasonCode,
  McpBuildRecommendationInput,
  McpToolCatalogEntry,
  RuntimeSelection,
} from "../../shared/types";
import { hasEnvVar } from "../secrets/vault";
import { detectRuntimes } from "../runtime/detect";
import { pickActive } from "../runtime/selection";
import { MCP_TOOL_CATALOG } from "./catalog";
import { listInstalledServers } from "./registry";
import {
  isRuntimeMcpCompatible,
  persistHostMcpBuildReceipt,
  resolveApprovedMcpCandidates,
  type InternalMcpBuildCandidate,
  type McpAttachmentResolverDependencies,
  type ResolvedMcpBuildAttachment,
} from "./attachment-resolver";

const PLAN_TTL_MS = 20 * 60 * 1_000;
const APPLIED_PLAN_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CANDIDATES = 10;

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
  "hephaestus-network": {
    capability: "agent-routing",
    fallbackGroup: "agent-routing",
    priority: 100,
    hints: ["agentlas", "hephaestus", "hub", "cloud", "agent", "team", "route", "에이전트", "허브", "클라우드", "팀", "라우팅"],
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
}

const DEFAULT_DEPS: McpBuildPlanDependencies = {
  listInstalled: listInstalledServers,
  hasEnv: hasEnvVar,
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
};

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
  };
  return code[capability] ?? "task-match";
}

function normalized(text: string): string {
  return text.toLowerCase();
}

function scoreCatalog(entry: McpToolCatalogEntry, request: string): number {
  // Lazyweb is never silently recommended in Agentlas product flows. It remains
  // available in the global MCP manager for explicit user choice.
  if (entry.id === "lazyweb" || entry.id === "opencrab") return 0;
  const rule = CATALOG_RULES[entry.id];
  if (!rule) return 0;
  const haystack = normalized(request);
  let score = 0;
  for (const hint of rule.hints) {
    if (haystack.includes(normalized(hint))) score += hint.length >= 6 ? 4 : 3;
  }
  if (score === 0) return 0;
  const catalogText = normalized([entry.id, entry.name, entry.nameEn, entry.description, entry.descriptionEn].join(" "));
  for (const token of haystack.split(/[^a-z0-9가-힣_-]+/i).filter((part) => part.length >= 4)) {
    if (catalogText.includes(token)) score += 1;
  }
  return score;
}

function scoreCustom(server: InstalledMcpServer, request: string): number {
  const haystack = normalized(request);
  const tokens = normalized(`${server.name} ${server.nameEn}`)
    .split(/[^a-z0-9가-힣_-]+/i)
    .filter((part) => part.length >= 3);
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 4 : 0), 0);
}

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

  const directScores = new Map(MCP_TOOL_CATALOG.map((entry) => [entry.id, scoreCatalog(entry, request)]));
  const matchedFallbackGroups = new Set(
    MCP_TOOL_CATALOG
      .filter((entry) => (directScores.get(entry.id) ?? 0) > 0)
      .map((entry) => ruleFor(entry).fallbackGroup),
  );

  const scored: Array<{ score: number; installedRank: number; candidate: InternalMcpBuildCandidate }> = [];
  for (const entry of MCP_TOOL_CATALOG) {
    const directScore = directScores.get(entry.id) ?? 0;
    const score = directScore > 0
      ? directScore
      : matchedFallbackGroups.has(ruleFor(entry).fallbackGroup)
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

  for (const server of installed.filter((item) => !item.catalogId)) {
    const score = scoreCustom(server, request);
    if (score <= 0) continue;
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
