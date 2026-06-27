import { MCP_TOOL_CATALOG } from "./catalog";
import { installFromCatalog, listInstalledServers } from "./registry";
import { readEnvVar } from "../secrets/vault";
import type { McpToolCatalogEntry } from "../../shared/types";

export interface AutoSelectedMcpTool {
  id: string;
  name: string;
  reason: string;
  installed: boolean;
  missingEnv: string[];
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

function normalize(text: string): string {
  return text.toLowerCase();
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

async function missingRequiredEnv(entry: McpToolCatalogEntry): Promise<string[]> {
  const missing: string[] = [];
  for (const requirement of entry.envRequirements) {
    if (!requirement.required) continue;
    const value = await readEnvVar(requirement.key);
    if (!value) missing.push(requirement.key);
  }
  return missing;
}

export async function autoSelectMcpTools(input: {
  userPrompt: string;
  systemPrompt: string;
  agentName: string;
  workingFolder?: string | null;
}): Promise<AutoSelectedMcpTool[]> {
  const haystack = normalize(
    [input.userPrompt, input.systemPrompt, input.agentName, input.workingFolder ?? ""].join("\n"),
  );
  const installed = new Set(
    listInstalledServers()
      .map((server) => server.catalogId)
      .filter((id): id is string => Boolean(id)),
  );
  const picked = MCP_TOOL_CATALOG.map((entry) => ({ entry, score: scoreEntry(entry, haystack) }))
    .filter((item) => item.score >= 3 || item.entry.id === "hephaestus-network")
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
      reason: score > 0 ? `matched request/tool need score ${score}` : "always available routing/plugin resolver",
      installed: installedNow,
      missingEnv,
    });
  }
  return result;
}

export function buildMcpAutoSelectionPrompt(selected: AutoSelectedMcpTool[]): string {
  if (selected.length === 0) return "";
  const installed = selected.filter((tool) => tool.installed);
  const blocked = selected.filter((tool) => !tool.installed && tool.missingEnv.length > 0);
  return [
    "Agentlas MCP plugin auto-selection is active.",
    installed.length > 0
      ? `Installed/enabled tools available this run: ${installed.map((tool) => `${tool.id} (${tool.name})`).join(", ")}.`
      : "No additional installable local tools were available for this run.",
    "Use the available MCP tools directly when they are relevant. Do not ask the user to install a tool that is already listed as available.",
    "For Hub/public agents and broader plugin discovery, prefer the hephaestus-network MCP tools; they resolve Agentlas Hub bundles and plugin needs from the Hub catalog.",
    blocked.length > 0
      ? `Tools matched but need credentials before use: ${blocked
          .map((tool) => `${tool.id} missing ${tool.missingEnv.join(", ")}`)
          .join("; ")}. Ask for secure vault setup only if the task truly needs them.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
