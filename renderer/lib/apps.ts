export type AgentlasAppKind = "ai-native" | "utility";

export interface AgentlasAppDefinition {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  kind: AgentlasAppKind;
  route: string;
  accent: string;
  engines: string[];
  vaultKeys: string[];
  artifacts: string[];
  slashCommands: string[];
}

export interface GeneratedDocument {
  title: string;
  subtitle: string;
  body: string;
  figureCaption: string;
  cta: string;
}

export const INSTALLED_APPS: AgentlasAppDefinition[] = [
  {
    id: "document-studio",
    slug: "document-studio",
    name: "문서 스튜디오",
    nameEn: "Document Studio",
    tagline: "라이너식 텍스트 편집과 Genspark식 리포트 생성을 Agentlas 안에서 실행",
    taglineEn: "Liner-style text editing and Genspark-style report generation inside Agentlas",
    kind: "ai-native",
    route: "/apps/document-studio",
    accent: "var(--accent)",
    engines: ["Document renderer", "Figure planner", "Citation scaffold"],
    vaultKeys: [],
    artifacts: ["Markdown report", "Academic figure", "Editable draft"],
    slashCommands: ["/document-studio", "/docstudio", "/문서스튜디오"],
  },
];

export function appDisplayName(app: AgentlasAppDefinition, locale: "ko" | "en"): string {
  return locale === "en" ? app.nameEn : app.name;
}

export function appTagline(app: AgentlasAppDefinition, locale: "ko" | "en"): string {
  return locale === "en" ? app.taglineEn : app.tagline;
}

export function appSlashCommands(app: AgentlasAppDefinition): string[] {
  return app.slashCommands;
}

export interface AppSlashRoute {
  app: AgentlasAppDefinition;
  command: string;
  request: string;
}

export function parseAppSlashRoute(input: string): AppSlashRoute | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const command = normalizeSlashCommand(match[1]);
  for (const app of INSTALLED_APPS) {
    if (app.slashCommands.some((c) => normalizeSlashCommand(c) === command)) {
      return {
        app,
        command: match[1],
        request: (match[2] ?? "").trim(),
      };
    }
  }
  return null;
}

export function buildAppRoutePrompt(
  route: AppSlashRoute,
  locale: "ko" | "en",
): string {
  const appName = appDisplayName(route.app, locale);
  const request = route.request || (locale === "en" ? "Open this App." : "이 App을 열어.");
  if (locale === "en") {
    return [
      "[Agentlas Apps route]",
      `Installed App: ${appName}`,
      `App slug: ${route.app.slug}`,
      `App route: ${route.app.route}`,
      `User slash command: ${route.command}`,
      "",
      "The user is routing this chat through an installed Agentlas App.",
      "If the request asks to change the App itself, edit the App implementation or explain the exact App change.",
      "If the request asks to change an artifact inside the App, use the App as the working surface and leave a stable CTA back to the App route.",
      "",
      `User request: ${request}`,
      "",
      `Finish with: [Open in Apps](${route.app.route})`,
    ].join("\n");
  }
  return [
    "[Agentlas Apps 라우트]",
    `설치된 App: ${appName}`,
    `App slug: ${route.app.slug}`,
    `App route: ${route.app.route}`,
    `사용자 슬래시 명령어: ${route.command}`,
    "",
    "사용자는 이 채팅을 설치된 Agentlas App으로 라우팅하고 있습니다.",
    "요청이 App 자체 UI/UX/동작/소스 수정이면 해당 App 구현을 수정하거나 정확한 App 변경안을 실행하세요.",
    "요청이 App 안의 산출물 수정이면 이 App을 작업 표면으로 사용하고, 완료 후 App route로 돌아가는 안정적인 CTA를 남기세요.",
    "",
    `사용자 요청: ${request}`,
    "",
    `마지막에 남길 CTA: [Apps에서 확인하기](${route.app.route})`,
  ].join("\n");
}

function normalizeSlashCommand(command: string): string {
  return command.trim().toLowerCase();
}

export function buildDocument(goal: string, mode: "report" | "paper" | "brief"): GeneratedDocument {
  const normalized = goal.trim() || "대학교 리포트: AI native Apps가 지식 작업을 바꾸는 방식";
  const title =
    mode === "paper"
      ? `Research Paper: ${normalized}`
      : mode === "brief"
        ? `Executive Brief: ${normalized}`
        : `Document Studio Report: ${normalized}`;
  const subtitle =
    mode === "paper"
      ? "Structured academic draft with claim, method, figure, and references"
      : mode === "brief"
        ? "Decision-ready narrative with evidence blocks and next actions"
        : "Long-form editable document generated as an Agentlas App artifact";
  const framing =
    mode === "brief"
      ? "This brief turns the request into a concrete operating decision."
      : "This draft treats the prompt as a researchable document goal and produces a polished first pass.";
  const body = [
    `# ${title}`,
    "",
    `_${subtitle}_`,
    "",
    "## 1. Thesis",
    `${framing} The central claim is that the user does not need another passive text surface; they need an App that can hold its own interface, source context, generated assets, and follow-up edits in one place.`,
    "",
    "## 2. Context",
    `The requested topic is: **${normalized}**. Document Studio keeps the writing canvas, outline, generated visual plan, and revision controls inside Agentlas rather than scattering them across a chat transcript and loose files.`,
    "",
    "## 3. Draft Structure",
    "- Opening: state the problem in plain language.",
    "- Evidence: group claims into source-ready sections.",
    "- Visual: generate an academic figure or explanatory diagram plan.",
    "- Revision: keep the full text editable inside the App.",
    "- Handoff: leave a CTA so the chat can reopen the finished artifact in Apps.",
    "",
    "## 4. Figure Plan",
    "A three-lane diagram: user goal -> App engine -> editable document artifact. The middle lane shows vault credentials, MCP engines, and generated assets as support systems, not top-level products.",
    "",
    "## 5. References",
    "- Agentlas Desktop Apps architecture note.",
    "- Local user prompt and generated App state.",
    "- Future source connectors attached through Apps Engines.",
    "",
    "## 6. Next Revision",
    "Ask an Agentlas AI to expand a section, add citations, or convert the draft into a presentation. The same installed App remains callable from chat.",
  ].join("\n");
  return {
    title,
    subtitle,
    body,
    figureCaption: "Figure: Agentlas Apps turn chat goals into editable app artifacts with supporting engines underneath.",
    cta: "Open in Apps",
  };
}
