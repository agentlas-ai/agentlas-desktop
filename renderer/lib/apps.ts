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
  /** 설정 시 — 타일 클릭이 in-app route 대신 이 명령을 새 채팅에서 실행한다
   *  (예: Hephaestus Network로 GUI를 띄우는 "/hep-network startup"). */
  launchCommand?: string;
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
    id: "oberon",
    slug: "oberon",
    name: "Oberon 영화 스튜디오",
    nameEn: "Oberon Film Studio",
    tagline: "기획→샷 리스트→레퍼런스→생성→QA→편집→납품을 한 흐름으로 묶는 AI 영화 운영체제",
    taglineEn: "An AI Film OS that chains brief → shot list → references → generation → QA → edit → delivery",
    kind: "ai-native",
    route: "/oberon",
    accent: "var(--accent)",
    engines: ["Showrunner", "Shot Planner", "Continuity Bible", "Provider Router", "Vision QA", "Editor & Timeline"],
    vaultKeys: ["GEMINI_API_KEY", "RUNWAY_API_KEY", "LUMA_API_KEY", "OPENAI_API_KEY", "FIREFLY_API_KEY"],
    artifacts: ["Shot list", "Prompt pack", "Continuity bible", "Generated takes", "Timeline / EDL", "Multi-aspect masters"],
    slashCommands: ["/oberon", "/film", "/오베론", "/영화스튜디오"],
  },
  {
    id: "document-studio",
    slug: "document-studio",
    name: "문서 스튜디오",
    nameEn: "Document Studio",
    tagline: "리서치 하이라이트, 인용 스타일, 편집 가능한 문서 초안을 Agentlas 안에서 실행",
    taglineEn: "Research highlights, citation styles, and editable document drafts inside Agentlas",
    kind: "ai-native",
    route: "/apps/document-studio",
    accent: "var(--accent)",
    engines: ["Research highlighter", "Citation style engine", "Document renderer"],
    vaultKeys: [],
    artifacts: ["Source highlights", "Citation draft", "Editable document"],
    slashCommands: ["/document-studio", "/docstudio", "/문서스튜디오"],
  },
  {
    id: "startup-founder-studio",
    slug: "startup-founder-studio",
    name: "스타트업 창업자 스튜디오",
    nameEn: "Startup Founder Studio",
    tagline: "창업 아이디어 → 아이디어·시장·사업설계·PRD·제품·웹·IR 단계로 이어지는 운영 보드. 각 단계는 Agentlas Hub의 전문 HQ를 호출합니다.",
    taglineEn: "One founder idea → a staged operating board (idea, market, business, PRD, product, web, IR), each calling a specialist Agentlas Hub HQ.",
    kind: "ai-native",
    // 네이티브 구동 — 브라우저 GUI 대신 앱 안의 스텝 보드에서 7단계를 엔진(network)으로 돌린다.
    route: "/startup-founder-studio",
    accent: "var(--accent)",
    engines: ["Hephaestus Network", "Business Model Generator", "Market Research Engine", "Pitch Deck Compiler"],
    vaultKeys: ["CRUNCHBASE_API_KEY", "LINKEDIN_API_KEY"],
    artifacts: ["Business Model Canvas", "Competitor Analysis", "Pitch Deck (PDF)"],
    slashCommands: ["/hep-network startup", "/startup"],
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

  let bestMatch: AppSlashRoute | null = null;
  let maxLen = -1;
  const normalizedInput = normalizeSlashCommand(trimmed);

  for (const app of INSTALLED_APPS) {
    for (const rawCmd of app.slashCommands) {
      const cmd = normalizeSlashCommand(rawCmd);
      if (normalizedInput.startsWith(cmd)) {
        if (normalizedInput.length === cmd.length || normalizedInput[cmd.length] === ' ') {
          if (cmd.length > maxLen) {
            maxLen = cmd.length;
            bestMatch = {
              app,
              command: rawCmd,
              request: trimmed.slice(rawCmd.length).trim(),
            };
          }
        }
      }
    }
  }

  return bestMatch;
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
    subtitle,
    "",
    "1. Thesis",
    `${framing} The central claim is that the user does not need another passive text surface; they need an App that can hold its own interface, source context, generated assets, and follow-up edits in one place.`,
    "",
    "2. Context",
    `The requested topic is: ${normalized}. Document Studio keeps the writing canvas, source highlights, citation style, generated visual plan, and revision controls inside Agentlas rather than scattering them across a chat transcript and loose files (Agentlas Apps Architecture, 2026).`,
    "",
    "3. Draft Structure",
    "- Opening: state the problem in plain language.",
    "- Evidence: group claims into source-ready sections and mark weak citation points.",
    "- Visual: generate an academic figure or explanatory diagram plan.",
    "- Revision: keep the full text editable inside the App.",
    "- Handoff: leave a CTA so the chat can reopen the finished artifact in Apps.",
    "",
    "4. Figure Plan",
    "A three-lane diagram: user goal -> App engine -> editable document artifact. The middle lane shows vault credentials, MCP engines, and generated assets as support systems, not top-level products.",
    "",
    "5. References",
    "- Agentlas Desktop Apps architecture note.",
    "- Local user prompt and generated App state.",
    "- Future source connectors attached through Plugins.",
    "- Local source highlight and citation style state.",
    "",
    "6. Next Revision",
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
