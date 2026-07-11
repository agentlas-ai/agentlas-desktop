import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_TOOL_CATALOG } from "./catalog";
import { installFromCatalog, listInstalledServers } from "./registry";
import { readEnvVar } from "../secrets/vault";
import { getSource as getMarketSource } from "../marketplace";
import { resolveAutomationToolMode } from "../../shared/automation-tool-policy";
import type {
  AutomationHubMode,
  AutomationToolMode,
  MarketplaceListing,
  McpToolCatalogEntry,
} from "../../shared/types";

export interface AutoSelectedMcpTool {
  id: string;
  name: string;
  reason: string;
  installed: boolean;
  missingEnv: string[];
}

export interface HubPluginCandidate {
  slug: string;
  name: string;
  reason: string;
  installCli?: string;
  manifestUrl?: string;
  category?: string;
  score: number;
}

export interface AutoSelectedMcpContext {
  tools: AutoSelectedMcpTool[];
  localInventory: string[];
  localPluginCount: number;
  hubPluginCount: number;
  hubPlugins: HubPluginCandidate[];
  hubPluginError?: string;
}

const KEYWORD_HINTS: Record<string, string[]> = {
  "hephaestus-network": [
    "agent",
    "agents",
    "agentlas",
    "hephaestus",
    "hub",
    "cloud",
    "plugin",
    "plugins",
    "team",
    "route",
    "routing",
    "subagent",
    "sub-agent",
    "에이전트",
    "허브",
    "클라우드",
    "플러그인",
    "팀",
    "라우팅",
    "서브에이전트",
  ],
  playwright: [
    "browser",
    "chrome",
    "web",
    "click",
    "login",
    "instagram",
    "upload",
    "post",
    "screenshot",
    "브라우저",
    "크롬",
    "클릭",
    "로그인",
    "인스타",
    "업로드",
    "게시",
    "스크린샷",
  ],
  "cua-driver": ["desktop", "app", "screen", "ui", "electron", "mac", "데스크탑", "앱", "화면", "검증"],
  "brave-search": ["latest", "recent", "news", "research", "search", "오늘", "최신", "뉴스", "검색", "리서치", "조사"],
  github: ["github", "repo", "repository", "pull request", "pr", "issue", "commit", "깃허브", "리포", "이슈"],
  filesystem: ["file", "folder", "repo", "workspace", "write", "edit", "파일", "폴더", "워크스페이스", "수정"],
  postgres: ["postgres", "postgresql", "database", "sql", "db", "데이터베이스"],
  notion: ["notion", "docs", "database", "page", "노션"],
  linear: ["linear", "issue", "project", "sprint", "리니어"],
  slack: ["slack", "channel", "message", "슬랙"],
  discord: ["discord", "server", "message", "디스코드"],
  shadcn: ["shadcn", "ui component", "component library"],
};

const HUB_PLUGIN_LOOKUP_TIMEOUT_MS = 8_000;
const HUB_PLUGIN_CANDIDATE_LIMIT = 8;

const HUB_PLUGIN_NEEDS: Array<{
  need: string;
  requestHints: string[];
  pluginHints: string[];
}> = [
  {
    need: "computer-use",
    requestHints: [
      "computer use",
      "cua",
      "screen",
      "desktop",
      "mac",
      "blocked",
      "permission",
      "컴퓨터 유즈",
      "화면",
      "데스크탑",
      "권한",
    ],
    pluginHints: ["computer-use", "computer use", "cua"],
  },
  {
    need: "browser automation",
    requestHints: [
      "browser",
      "chrome",
      "web",
      "click",
      "login",
      "upload",
      "post",
      "comment",
      "브라우저",
      "크롬",
      "클릭",
      "로그인",
      "업로드",
      "게시",
      "댓글",
    ],
    pluginHints: ["browser", "chrome", "browserbase", "playwright", "computer-use"],
  },
  {
    need: "reddit",
    requestHints: ["reddit", "subreddit", "레딧"],
    pluginHints: ["reddit"],
  },
  {
    need: "social posting",
    requestHints: [
      "instagram",
      "twitter",
      "x.com",
      "facebook",
      "linkedin",
      "social",
      "post",
      "comment",
      "인스타",
      "소셜",
      "게시",
      "댓글",
    ],
    pluginHints: ["instagram", "twitter", "linkedin", "reddit", "social", "canva"],
  },
  {
    need: "github",
    requestHints: ["github", "pull request", "repo", "repository", "issue", "깃허브", "리포", "이슈"],
    pluginHints: ["github"],
  },
  {
    need: "notion",
    requestHints: ["notion", "노션"],
    pluginHints: ["notion"],
  },
  {
    need: "slack",
    requestHints: ["slack", "channel", "message", "슬랙"],
    pluginHints: ["slack"],
  },
  {
    need: "image generation",
    requestHints: ["image", "generate", "photo", "creative", "이미지", "사진", "생성"],
    pluginHints: ["image", "fal", "creative", "product-design"],
  },
  {
    need: "analytics",
    requestHints: ["analytics", "metric", "dashboard", "report", "분석", "지표", "리포트"],
    pluginHints: ["analytics", "google-analytics", "axiom", "honeycomb", "new-relic"],
  },
];

const LOCAL_PLUGIN_SCAN_DIRS = [
  path.join(os.homedir(), ".codex", "plugins", "cache"),
  path.join(os.homedir(), ".claude", "plugins", "cache"),
  path.join(os.homedir(), ".claude", "plugins", "marketplaces"),
  path.join(os.homedir(), ".agentlas", "plugins"),
];

function normalize(text: string): string {
  return text.toLowerCase();
}

function splitTokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9가-힣_+-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(normalize(needle)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Hub plugin lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function scoreEntry(entry: McpToolCatalogEntry, haystack: string): number {
  if (entry.id === "lazyweb") return 0;
  let score = 0;
  const localHints = KEYWORD_HINTS[entry.id] ?? [];
  const catalogText = normalize(
    [entry.id, entry.name, entry.nameEn, entry.category, entry.description, entry.descriptionEn].join(" "),
  );
  for (const hint of localHints) {
    if (haystack.includes(normalize(hint))) score += 3;
  }
  for (const token of catalogText.split(/[^a-z0-9가-힣_+-]+/i).filter((part) => part.length >= 4)) {
    if (haystack.includes(token)) score += 1;
  }
  if (entry.id === "hephaestus-network") score += 2;
  return score;
}

function scoreWithAutomationPolicy(
  entry: McpToolCatalogEntry,
  score: number,
  toolMode: AutomationToolMode | undefined,
): number {
  if (toolMode === "browser") {
    // 브라우저 조작은 무조건 agentlas-browser(실로그인 CDP)로 — 신선 프로필 playwright는
    // 봇/네트워크 보안에 차단되므로 최우선은 agentlas-browser, playwright는 폴백으로만.
    if (entry.id === "agentlas-browser") return Math.max(score, 100);
    if (entry.id === "playwright") return Math.max(score, 40);
    if (entry.id === "cua-driver") return 0;
  }
  if (toolMode === "computer-use") {
    if (entry.id === "cua-driver") return Math.max(score, 100);
    if (entry.id === "playwright") return 0;
  }
  return score;
}

async function missingRequiredEnv(entry: McpToolCatalogEntry): Promise<string[]> {
  const missing: string[] = [];
  for (const requirement of entry.envRequirements) {
    if (!requirement.required) continue;
    const value = await readEnvVar(requirement.key);
    if (!value) missing.push(requirement.key);
  }
  return missing;
}

function readDirectoryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function listLocalPluginInventory(installed: Set<string>): string[] {
  const inventory = new Set<string>();
  for (const entry of MCP_TOOL_CATALOG) inventory.add(entry.id);
  for (const id of installed) inventory.add(id);
  for (const dir of LOCAL_PLUGIN_SCAN_DIRS) {
    for (const name of readDirectoryNames(dir)) inventory.add(name);
  }
  return Array.from(inventory).sort((a, b) => a.localeCompare(b));
}

function isHubPluginListing(listing: MarketplaceListing): boolean {
  return listing.entityKind === "plugin" || listing.source === "hub-plugin" || listing.kind === "hub-plugin";
}

function hubListingText(listing: MarketplaceListing): string {
  return normalize(
    [
      listing.slug,
      listing.name,
      listing.nameEn,
      listing.tagline,
      listing.taglineEn,
      listing.ownerName,
      listing.category,
      listing.developer,
      listing.installCli,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function scoreHubPlugin(listing: MarketplaceListing, haystack: string): { score: number; reasons: string[] } {
  const listingText = hubListingText(listing);
  const reasons = new Set<string>();
  let score = 0;

  for (const token of splitTokens(listingText)) {
    if (haystack.includes(token)) {
      score += 2;
      if (reasons.size < 2) reasons.add(`matched "${token}"`);
    }
  }

  for (const need of HUB_PLUGIN_NEEDS) {
    if (includesAny(haystack, need.requestHints) && includesAny(listingText, need.pluginHints)) {
      score += 12;
      reasons.add(`matched ${need.need} need`);
    }
  }

  if (haystack.includes("plugin") || haystack.includes("플러그인") || haystack.includes("hub") || haystack.includes("허브")) {
    score += 1;
  }

  return { score, reasons: Array.from(reasons) };
}

async function resolveHubPluginCandidates(input: {
  haystack: string;
  hubAllowed: boolean;
}): Promise<Pick<AutoSelectedMcpContext, "hubPluginCount" | "hubPlugins" | "hubPluginError">> {
  if (!input.hubAllowed) {
    return { hubPluginCount: 0, hubPlugins: [] };
  }

  try {
    const listings = await withTimeout(getMarketSource().searchAgents(""), HUB_PLUGIN_LOOKUP_TIMEOUT_MS);
    const plugins = listings.filter(isHubPluginListing);
    const candidates = plugins
      .map((listing) => {
        const scored = scoreHubPlugin(listing, input.haystack);
        return { listing, ...scored };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.listing.slug.localeCompare(b.listing.slug);
      })
      .slice(0, HUB_PLUGIN_CANDIDATE_LIMIT)
      .map(({ listing, score, reasons }): HubPluginCandidate => ({
        slug: listing.slug,
        name: listing.nameEn || listing.name || listing.slug,
        reason: reasons.length > 0 ? reasons.join("; ") : "matched Hub plugin catalog",
        installCli: listing.installCli,
        manifestUrl: listing.manifestUrl || listing.detailUrl,
        category: listing.category,
        score,
      }));

    return {
      hubPluginCount: plugins.length,
      hubPlugins: candidates,
    };
  } catch (err) {
    return {
      hubPluginCount: 0,
      hubPlugins: [],
      hubPluginError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function autoSelectMcpTools(input: {
  userPrompt: string;
  systemPrompt: string;
  agentName: string;
  workingFolder?: string | null;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
}): Promise<AutoSelectedMcpContext> {
  const haystack = normalize(
    [input.userPrompt, input.systemPrompt, input.agentName, input.workingFolder ?? ""].join("\n"),
  );
  const effectiveToolMode = resolveAutomationToolMode({
    toolMode: input.toolMode,
    name: input.agentName,
    promptTemplate: input.userPrompt,
    targetLabel: input.workingFolder,
  });
  const installed = new Set(
    listInstalledServers()
      .map((server) => server.catalogId)
      .filter((id): id is string => Boolean(id)),
  );
  const hubAllowed = input.hubMode !== "local-only";
  const localInventory = listLocalPluginInventory(installed);
  const picked = MCP_TOOL_CATALOG.map((entry) => ({
    entry,
    score: scoreWithAutomationPolicy(entry, scoreEntry(entry, haystack), effectiveToolMode),
  }))
    .filter((item) => {
      if (item.entry.id === "hephaestus-network") return hubAllowed;
      return item.score >= 3;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const result: AutoSelectedMcpTool[] = [];
  for (const { entry, score } of picked) {
    const missingEnv = await missingRequiredEnv(entry);
    let installedNow = installed.has(entry.id);
    if (!installedNow && missingEnv.length === 0) {
      installFromCatalog(entry.id);
      installed.add(entry.id);
      installedNow = true;
    }
    result.push({
      id: entry.id,
      name: entry.nameEn || entry.name,
      reason:
        effectiveToolMode === "browser" && entry.id === "agentlas-browser"
          ? "Browser plugin (real-login CDP) for this automation"
          : effectiveToolMode === "computer-use" && entry.id === "cua-driver"
            ? input.toolMode === "computer-use"
              ? "user-selected Computer Use for this automation"
              : "Agentlas policy selected Computer Use for human web/social automation"
            : score > 0
              ? `matched request/tool need score ${score}`
              : "always available routing/plugin resolver",
      installed: installedNow,
      missingEnv,
    });
  }

  // 사용자가 손수 등록한 커스텀 MCP(카탈로그에 없는 catalogId=null)는 위 MCP_TOOL_CATALOG
  // 스캔에 잡히지 않아 채팅 런타임(.mcp.json)에서 늘 누락됐다 — 명시적으로 추가한 서버이므로
  // 항상 후보에 포함한다. remote(헤더 없는 URL)는 envKeys가 비어 바로 사용 가능하고,
  // 헤더/키가 필요한 서버는 vault에 값이 있을 때만 installed로 잡힌다.
  for (const server of listInstalledServers()) {
    if (!server.enabled || server.catalogId) continue;
    if (result.some((tool) => tool.id === server.id)) continue;
    const missingEnv: string[] = [];
    for (const key of server.envKeys) {
      const value = await readEnvVar(key);
      if (!value) missingEnv.push(key);
    }
    result.push({
      id: server.id,
      name: server.nameEn || server.name,
      reason: "user-added custom MCP (always available)",
      installed: missingEnv.length === 0,
      missingEnv,
    });
  }

  const hub = await resolveHubPluginCandidates({ haystack, hubAllowed });
  return {
    tools: result,
    localInventory,
    localPluginCount: localInventory.length,
    ...hub,
  };
}

export function buildMcpAutoSelectionPrompt(
  selected: AutoSelectedMcpContext,
  opts?: { toolMode?: AutomationToolMode; hubMode?: AutomationHubMode },
): string {
  if (selected.tools.length === 0 && selected.hubPluginCount === 0) return "";
  const installed = selected.tools.filter((tool) => tool.installed);
  const blocked = selected.tools.filter((tool) => !tool.installed && tool.missingEnv.length > 0);
  const modeLine =
    opts?.toolMode === "browser"
      ? "This automation explicitly selected Browser plugin mode; use Playwright/browser tools for web work."
      : opts?.toolMode === "computer-use"
        ? "This automation explicitly selected Computer Use mode; use desktop/screen tools for UI work."
        : "";
  const hubLine =
    opts?.hubMode === "hub-first"
      ? "This automation is Hub-first: prefer Agentlas Hub specialists/plugins through hephaestus-network before local fallbacks."
      : opts?.hubMode === "hub-allowed"
        ? "This automation may use Agentlas Hub specialists/plugins through hephaestus-network when local tools are insufficient."
        : opts?.hubMode === "local-only"
          ? "This automation is local-only: do not use Agentlas Hub routing or borrowed Hub agents."
          : "";
  const hubCandidates =
    selected.hubPlugins.length > 0
      ? `Relevant Hub plugin candidates: ${selected.hubPlugins
          .map((plugin) =>
            `${plugin.slug} (${plugin.name}; ${plugin.reason}${plugin.installCli ? `; install: ${plugin.installCli}` : ""})`,
          )
          .join("; ")}.`
      : selected.hubPluginCount > 0
        ? "Hub plugin catalog is available; resolve plugin needs dynamically before declaring a tool unavailable."
        : selected.hubPluginError
          ? `Hub plugin catalog lookup failed for this run: ${selected.hubPluginError}.`
          : "";
  const inventoryPreview = selected.localInventory.slice(0, 24).join(", ");
  const inventoryMore = selected.localInventory.length > 24 ? `, +${selected.localInventory.length - 24} more` : "";
  return [
    "Agentlas MCP plugin auto-selection is active.",
    `Agentlas plugin universe is active: ${selected.localPluginCount} local plugin/tool entries + ${selected.hubPluginCount} Hub plugins.`,
    modeLine,
    hubLine,
    selected.localInventory.length > 0
      ? `Local inventory for Hub plugin resolution: ${inventoryPreview}${inventoryMore}.`
      : "",
    installed.length > 0
      ? `Installed/enabled tools available this run: ${installed.map((tool) => `${tool.id} (${tool.name})`).join(", ")}.`
      : "No additional installable local tools were available for this run.",
    hubCandidates,
    "Use the available MCP tools directly when they are relevant. Do not ask the user to install a tool that is already listed as available.",
    "Before saying a tool/plugin is unavailable, resolve against both local inventory and Agentlas Hub. If an agentlas_resolve_plugins MCP tool is exposed, call it with the needed capabilities and localInventory. Otherwise use the Hephaestus Network MCP tools to route Hub specialists/plugins.",
    "Only ask the user when the selected Hub plugin requires login, OAuth, credentials, paid/credit approval, or a macOS/browser permission. Include the exact plugin slug or install command in that question.",
    blocked.length > 0
      ? `Tools matched but need credentials before use: ${blocked
          .map((tool) => `${tool.id} missing ${tool.missingEnv.join(", ")}`)
          .join("; ")}. Ask for secure vault setup only if the task truly needs them.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
