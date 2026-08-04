// 그래프 도구 결합 — "이 단계가 무엇을 가지고 일하는가"를 **타입으로** 적는 자리.
//
// 왜 필요한가(실사용 실측):
//   제품: "할 일은 어디서 가져올까요?" → 사람: "캘린더요"
//   제품이 저장한 것: `title: "캘린더에서 일정 가져오기"` — **사람 말 한 줄이 전부**
//   → 어느 캘린더인지도, 연결됐는지도 어디에도 없다. 검사할 것이 없으니 막을 수도 없었고,
//     실행하고 나서야 죽었다.
//
// 조사한 8개 제품(n8n·Zapier·Make·Power Automate·MCP·ADK·A2A·Home Assistant) 중
// **자연어를 저장하는 곳은 0개**다. 전부 `capability → provider → connection → resource`
// 네 층으로 나눠 저장한다. 여기가 그 네 층이다.
//
// ★업계 합의는 **create-then-gate**다(filter-then-create가 아니다).
//   연결이 없어도 단계는 만든다. 대신 **켜기를 막는다.** Zapier: "If your Zap is missing
//   steps or doesn't have all the required fields filled out, you will not be able to turn
//   it on." n8n: "{count} node has issues, fix them before publishing."
//
// ★연결 여부를 모델에게 묻지 않는다. n8n의 플래너 프롬프트가 이걸 명시적으로 금지한다:
//   "NEVER mention API keys, credentials, authentication, or account setup — n8n handles
//   credentials separately." 연결은 **여기 결정론 코드가 그래프를 훑어 계산한다.**
//   그래서 메시지가 언제나 맞고, 지어내지 않는다.
import type { WorkflowGraph, WorkflowNode } from "./types";

export const TOOL_BINDING_SCHEMA = "agentlas.graph-tool-binding.v1";

/**
 * 공급자 묶음 — **한 번 로그인해서 여러 도구를 한꺼번에 여는 단위**.
 *
 * 조사한 어느 제품도 이걸 안 한다. Power Automate는 커넥터마다
 * "새 탭 → 사용자가 직접 닫기 → Refresh → 드롭다운에서 다시 선택"을 반복시켜,
 * 커넥터 3개면 12스텝이 된다. 구글 캘린더·시트·지메일은 **같은 구글 계정 하나**로 열린다.
 */
export type ProviderGroup =
  | "google" | "microsoft" | "apple" | "slack" | "notion" | "atlassian"
  | "github" | "local" | "other";

export interface ProviderSpec {
  /** 저장되는 값. 사람 말이 아니라 이 id가 정본이다. */
  id: string;
  /** 사람에게 보여줄 이름. */
  label: string;
  labelEn: string;
  /** 한 번의 로그인으로 함께 열리는 묶음. */
  group: ProviderGroup;
  /** 이 공급자가 할 수 있는 일들. */
  capabilities: string[];
  /**
   * 어떻게 연결하는가.
   *  · "oauth"   — 브라우저에서 그 서비스에 로그인해야 한다. **폼으로 받지 않는다**
   *                (MCP: 자격이 LLM 컨텍스트나 중간 서버를 통과해선 안 된다).
   *  · "api-key" — 사용자가 그 서비스에서 만든 키를 붙여넣는다. n8n·Zapier도 이건 폼이다.
   *  · "none"    — 연결이 필요 없다.
   */
  authKind: "oauth" | "api-key" | "none";
  /** 키를 어디서 만드는지. api-key일 때 사람에게 보여준다. */
  keyHelpUrl?: string;
  /** 이 공급자를 쓰려면 채워져야 하는 것. 비었으면 로그인이 필요 없다는 뜻. */
  requires: {
    /** MCP 카탈로그 id — 이 서버가 설치·활성이어야 한다. */
    mcpCatalogId?: string;
    /** 금고에 있어야 하는 키들. */
    envKeys?: string[];
  };
}

/**
 * 공급자 명부. **닫힌 목록이다** — 모델이 여기 없는 공급자를 적으면 받지 않는다.
 * 단, "연결된 것만" 보여주지는 않는다(create-then-gate). 아직 연결 안 한 것도 고를 수 있고,
 * 켤 때 막힌다. 근거: Zapier가 "may suggest workflows that require premium apps…
 * unavailable in your current plan"이라고 스스로 경고하듯, 계획 단계에서 인벤토리로
 * 좁히는 제품은 없었다.
 */
export const PROVIDER_CATALOG: ProviderSpec[] = [
  {
    id: "google_calendar", label: "Google 캘린더", labelEn: "Google Calendar", group: "google",
    capabilities: ["calendar.events.list", "calendar.events.create"],
    authKind: "oauth", requires: { envKeys: ["GOOGLE_OAUTH_TOKEN"] },
  },
  {
    id: "google_sheets", label: "Google 스프레드시트", labelEn: "Google Sheets", group: "google",
    capabilities: ["sheets.rows.read", "sheets.rows.append"],
    authKind: "oauth", requires: { envKeys: ["GOOGLE_OAUTH_TOKEN"] },
  },
  {
    id: "gmail", label: "Gmail", labelEn: "Gmail", group: "google",
    capabilities: ["mail.messages.list", "mail.messages.send"],
    authKind: "oauth", requires: { envKeys: ["GOOGLE_OAUTH_TOKEN"] },
  },
  {
    id: "outlook_calendar", label: "Outlook 캘린더", labelEn: "Outlook Calendar", group: "microsoft",
    capabilities: ["calendar.events.list", "calendar.events.create"],
    authKind: "oauth", requires: { envKeys: ["MICROSOFT_OAUTH_TOKEN"] },
  },
  {
    id: "outlook_mail", label: "Outlook 메일", labelEn: "Outlook Mail", group: "microsoft",
    capabilities: ["mail.messages.list", "mail.messages.send"],
    authKind: "oauth", requires: { envKeys: ["MICROSOFT_OAUTH_TOKEN"] },
  },
  {
    id: "apple_calendar", label: "Apple 캘린더", labelEn: "Apple Calendar", group: "apple",
    capabilities: ["calendar.events.list", "calendar.events.create"],
    authKind: "none", requires: {},
  },
  {
    id: "slack", label: "Slack", labelEn: "Slack", group: "slack",
    capabilities: ["chat.messages.post", "chat.messages.list"],
    authKind: "api-key", keyHelpUrl: "https://api.slack.com/apps", requires: { mcpCatalogId: "slack", envKeys: ["SLACK_BOT_TOKEN"] },
  },
  {
    id: "notion", label: "Notion", labelEn: "Notion", group: "notion",
    capabilities: ["docs.pages.read", "docs.pages.create", "docs.database.query"],
    authKind: "api-key", keyHelpUrl: "https://www.notion.so/my-integrations", requires: { mcpCatalogId: "notion", envKeys: ["NOTION_API_KEY"] },
  },
  {
    id: "github", label: "GitHub", labelEn: "GitHub", group: "github",
    capabilities: ["code.issues.list", "code.issues.create", "code.repo.read"],
    authKind: "api-key", keyHelpUrl: "https://github.com/settings/tokens", requires: { mcpCatalogId: "github", envKeys: ["GITHUB_TOKEN"] },
  },
  {
    id: "linear", label: "Linear", labelEn: "Linear", group: "atlassian",
    capabilities: ["tasks.issues.list", "tasks.issues.create"],
    authKind: "api-key", keyHelpUrl: "https://linear.app/settings/api", requires: { mcpCatalogId: "linear", envKeys: ["LINEAR_API_KEY"] },
  },
  {
    id: "local_files", label: "이 컴퓨터의 파일", labelEn: "Files on this computer", group: "local",
    capabilities: ["files.read", "files.write"],
    authKind: "none", requires: { mcpCatalogId: "filesystem" },
  },
  {
    id: "web_search", label: "웹 검색", labelEn: "Web search", group: "other",
    capabilities: ["web.search"],
    authKind: "api-key", keyHelpUrl: "https://brave.com/search/api/", requires: { mcpCatalogId: "brave-search", envKeys: ["BRAVE_API_KEY"] },
  },
];

/** 이 제품이 아는 capability 전부. 모델은 여기서만 고를 수 있다. */
export const CAPABILITIES: string[] = [
  ...new Set(PROVIDER_CATALOG.flatMap((provider) => provider.capabilities)),
].sort();

export function findProvider(id: string | null | undefined): ProviderSpec | null {
  if (!id) return null;
  return PROVIDER_CATALOG.find((provider) => provider.id === id) ?? null;
}

/** 이 capability를 할 수 있는 공급자들. "캘린더"라고만 말했을 때 보여줄 후보. */
export function providersFor(capability: string): ProviderSpec[] {
  return PROVIDER_CATALOG.filter((provider) => provider.capabilities.includes(capability));
}

/** 한 단계가 선언하는 도구 요구. 노드 config의 `needs`에 산다. */
export interface ToolRequirement {
  /** 무엇을 하려는가. 닫힌 어휘(CAPABILITIES). */
  capability: string;
  /** 어느 서비스로. 아직 안 정했으면 null — 그래도 저장은 된다. */
  provider: string | null;
  /** 없으면 이 단계가 아예 못 돈다. */
  required: boolean;
  /**
   * 어느 것(캘린더 하나·시트 하나·채널 하나). n8n resourceLocator와 같은 규칙 —
   * 어떤 모드로 골랐든 저장은 **id로 정규화**한다. 표시명은 바뀌어도 id는 안 바뀐다.
   */
  resource?: { mode: "list" | "url" | "id"; id: string | null; label?: string };
}

export function readRequirements(node: WorkflowNode | null | undefined): ToolRequirement[] {
  const raw = node?.config?.needs;
  if (!Array.isArray(raw)) return [];
  const out: ToolRequirement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<ToolRequirement>;
    if (typeof entry.capability !== "string" || !CAPABILITIES.includes(entry.capability)) continue;
    out.push({
      capability: entry.capability,
      provider: typeof entry.provider === "string" && findProvider(entry.provider) ? entry.provider : null,
      required: entry.required !== false,
      ...(entry.resource && typeof entry.resource === "object" ? { resource: entry.resource } : {}),
    });
  }
  return out;
}

/** 이 컴퓨터에 지금 무엇이 준비돼 있는가. 결정론 검사가 이것과 그래프를 대조한다. */
export interface ToolInventory {
  /** 설치·활성된 MCP 카탈로그 id들. */
  mcpCatalogIds: string[];
  /** 금고에 값이 들어 있는 키들. **값은 절대 여기 담지 않는다.** */
  filledEnvKeys: string[];
}

export type RequirementStatus = "ready" | "provider-unset" | "not-connected" | "resource-unset";

export interface RequirementGap {
  nodeId: string;
  nodeLabel: string;
  requirement: ToolRequirement;
  status: Exclude<RequirementStatus, "ready">;
  /** 채워야 하는 것 — 화면이 이걸로 "지금 누를 버튼"을 만든다. */
  missing: { mcpCatalogId?: string; envKeys: string[] };
}

/** 이 요구가 지금 만족되는가. 모르면 만족으로 치지 않는다. */
export function requirementStatus(
  requirement: ToolRequirement,
  inventory: ToolInventory,
): { status: RequirementStatus; missing: { mcpCatalogId?: string; envKeys: string[] } } {
  const empty = { envKeys: [] as string[] };
  if (!requirement.provider) return { status: "provider-unset", missing: empty };
  const provider = findProvider(requirement.provider);
  if (!provider) return { status: "provider-unset", missing: empty };
  const missingEnv = (provider.requires.envKeys ?? [])
    .filter((key) => !inventory.filledEnvKeys.includes(key));
  const missingMcp = provider.requires.mcpCatalogId
    && !inventory.mcpCatalogIds.includes(provider.requires.mcpCatalogId)
    ? provider.requires.mcpCatalogId
    : undefined;
  if (missingEnv.length || missingMcp) {
    return {
      status: "not-connected",
      missing: { ...(missingMcp ? { mcpCatalogId: missingMcp } : {}), envKeys: missingEnv },
    };
  }
  // 리소스를 골라야 하는데 안 골랐으면 아직 준비된 게 아니다.
  if (requirement.resource && !requirement.resource.id) {
    return { status: "resource-unset", missing: empty };
  }
  return { status: "ready", missing: empty };
}

/** 그래프를 훑어 **못 채운 것**만 모은다. 이 목록이 "켜기 전에 할 일"이다. */
export function collectGaps(
  graph: WorkflowGraph | null | undefined,
  inventory: ToolInventory,
): RequirementGap[] {
  const gaps: RequirementGap[] = [];
  for (const node of graph?.nodes ?? []) {
    for (const requirement of readRequirements(node)) {
      const { status, missing } = requirementStatus(requirement, inventory);
      if (status === "ready") continue;
      gaps.push({
        nodeId: node.id,
        nodeLabel: node.label || node.id,
        requirement,
        status,
        missing,
      });
    }
  }
  return gaps;
}

export interface ProviderTask {
  group: ProviderGroup;
  /** 이 묶음을 한 번에 여는 로그인. 예: 구글 하나로 캘린더·시트·지메일이 함께 열린다. */
  groupLabel: string;
  groupLabelEn: string;
  providers: Array<{
    provider: ProviderSpec | null;
    /** 공급자를 아직 안 골랐을 때 고를 수 있는 후보들. */
    candidates: ProviderSpec[];
    gaps: RequirementGap[];
  }>;
  /** 이 묶음에서 채워야 하는 것 전부(중복 제거). */
  missing: { mcpCatalogIds: string[]; envKeys: string[] };
  /**
   * 이 묶음을 어떻게 연결하는가. 한 묶음 안에 섞이면 "mixed"다.
   * 화면은 이걸 보고 폼을 낼지(api-key), 브라우저 로그인을 낼지(oauth) 정한다.
   */
  authKind: "oauth" | "api-key" | "none" | "mixed";
}

const GROUP_LABEL: Record<ProviderGroup, { ko: string; en: string }> = {
  google: { ko: "Google 계정", en: "Google account" },
  microsoft: { ko: "Microsoft 계정", en: "Microsoft account" },
  apple: { ko: "Apple", en: "Apple" },
  slack: { ko: "Slack", en: "Slack" },
  notion: { ko: "Notion", en: "Notion" },
  atlassian: { ko: "Atlassian · Linear", en: "Atlassian · Linear" },
  github: { ko: "GitHub", en: "GitHub" },
  local: { ko: "이 컴퓨터", en: "This computer" },
  other: { ko: "그 밖에", en: "Other" },
};

/**
 * 못 채운 것을 **공급자 묶음으로** 정리한다.
 * 화면은 이걸로 "구글 계정 한 번 연결하면 3개가 함께 채워집니다"를 말할 수 있다.
 * 조사한 어느 제품도 이 묶기를 하지 않는다(Power Automate는 커넥터마다 4스텝 왕복).
 */
export function groupGapsByProvider(gaps: RequirementGap[]): ProviderTask[] {
  const byGroup = new Map<ProviderGroup, ProviderTask>();
  for (const gap of gaps) {
    const provider = findProvider(gap.requirement.provider);
    const candidates = provider ? [] : providersFor(gap.requirement.capability);
    // 공급자를 안 골랐으면, 후보들의 묶음이 여럿일 수 있다 — 사람이 고를 때까지 "그 밖에".
    const group: ProviderGroup = provider
      ? provider.group
      : (candidates.length === 1 ? candidates[0].group : "other");
    let task = byGroup.get(group);
    if (!task) {
      task = {
        group,
        groupLabel: GROUP_LABEL[group].ko,
        groupLabelEn: GROUP_LABEL[group].en,
        providers: [],
        missing: { mcpCatalogIds: [], envKeys: [] },
        authKind: "none",
      };
      byGroup.set(group, task);
    }
    let row = task.providers.find((p) => p.provider?.id === (provider?.id ?? null)
      || (!p.provider && !provider && p.gaps[0]?.requirement.capability === gap.requirement.capability));
    if (!row) {
      row = { provider, candidates, gaps: [] };
      task.providers.push(row);
    }
    row.gaps.push(gap);
    if (provider) {
      task.authKind = task.authKind === "none" || task.authKind === provider.authKind
        ? provider.authKind
        : "mixed";
    }
    if (gap.missing.mcpCatalogId && !task.missing.mcpCatalogIds.includes(gap.missing.mcpCatalogId)) {
      task.missing.mcpCatalogIds.push(gap.missing.mcpCatalogId);
    }
    for (const key of gap.missing.envKeys) {
      if (!task.missing.envKeys.includes(key)) task.missing.envKeys.push(key);
    }
  }
  return [...byGroup.values()];
}

export type ActivationDecision =
  | { canActivate: true }
  | { canActivate: false; reason: string; nextAction: string; gaps: RequirementGap[] };

/**
 * 켜도 되는가. **부분 충족으로 통과시키지 않는다.**
 *
 * n8n은 여기서 결함이 있다 — `Fill remaining credentials to continue` 툴팁이
 * 채운 개수가 **0일 때만** 뜨고, 3개 중 1개만 채워도 Continue가 활성된다.
 * 사용자는 아무 경고 없이 반쯤 망가진 워크플로를 받는다. 그걸 베끼지 않는다.
 */
export function decideActivation(
  graph: WorkflowGraph | null | undefined,
  inventory: ToolInventory,
  locale: "ko" | "en" = "ko",
): ActivationDecision {
  const gaps = collectGaps(graph, inventory).filter((gap) => gap.requirement.required);
  if (gaps.length === 0) return { canActivate: true };
  const groups = groupGapsByProvider(gaps);
  const names = groups.map((task) => (locale === "ko" ? task.groupLabel : task.groupLabelEn));
  return {
    canActivate: false,
    reason: locale === "ko"
      ? `아직 연결되지 않은 것이 있어 켤 수 없습니다: ${names.join(" · ")}`
      : `Not connected yet, so this cannot be turned on: ${names.join(" · ")}`,
    nextAction: locale === "ko"
      ? "‘연결 설정’을 열어 계정을 연결하면 그때 켤 수 있습니다."
      : "Open “Connections” and sign in — then you can turn it on.",
    gaps,
  };
}

/** IPC로 렌더러에 건너가는 보고 형태. 렌더러가 electron/ 을 import 하지 않게 여기에 둔다. */
export interface GraphConnectionReportShape {
  activation: ActivationDecision;
  tasks: ProviderTask[];
  hasRequirements: boolean;
}
