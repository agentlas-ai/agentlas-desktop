import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceAppRoute,
  AgentlasSurfaceDataSet,
  AgentlasSurfaceManifest,
  AgentlasSurfaceToolParameterSpec,
  AppFactoryAppRecord,
  JsonObject,
  JsonValue,
} from "@/lib/types";

export type GeneratedAppLocale = "ko" | "en";
export type GeneratedAppFieldKind = "text" | "textarea" | "select" | "number" | "range";
export type GeneratedAppExportFormat = "json" | "markdown" | "csv" | "png" | "jpg";

export interface GeneratedAppField {
  id: string;
  label: string;
  kind: GeneratedAppFieldKind;
  defaultValue: string;
  helper?: string;
  options?: Array<{ id: string; label: string }>;
  min?: number;
  max?: number;
}

export interface GeneratedAppRecommendation {
  id: string;
  label: string;
  description: string;
  reason: string;
  tags: string[];
}

export interface GeneratedAppOutput {
  id: string;
  title: string;
  body: string;
  meta: string;
}

export interface GeneratedAppBlueprint {
  id: string;
  title: string;
  subtitle: string;
  appType: string;
  isVisualOutput: boolean;
  fields: GeneratedAppField[];
  recommendations: GeneratedAppRecommendation[];
  outputsLabel: string;
  exportFormats: GeneratedAppExportFormat[];
  routeSummaries: Array<{ label: string; detail: string }>;
  dataSummaries: Array<{ label: string; detail: string }>;
  actionSummaries: Array<{ label: string; detail: string }>;
}

export type GeneratedAppFieldValues = Record<string, string>;

export function buildGeneratedAppBlueprint(app: AppFactoryAppRecord, locale: GeneratedAppLocale): GeneratedAppBlueprint {
  const manifest = app.manifest;
  const appSpec = manifest.app;
  const title = app.appName || appSpec?.name || manifest.title || "Generated App";
  const appType = stringValue(appSpec?.appType) || stringValue(manifest.layout) || "service-app";
  const haystack = [
    title,
    manifest.title,
    manifest.domain,
    manifest.layout,
    appType,
    appSpec?.tagline,
    appSpec?.valueProp,
    appSpec?.audience,
  ].filter(Boolean).join(" ").toLowerCase();
  const isVisualOutput = /card|carousel|instagram|image|creative|asset|poster|storyboard|video|design|카드|인스타|이미지|디자인|스토리/.test(haystack);
  const routes = routesOf(manifest);
  const fields = dedupeFields([
    ...domainFields(manifest, locale, isVisualOutput),
    ...toolParameterFields(manifest, locale),
  ]);
  const recommendations = recommendationsOf(manifest, locale, isVisualOutput);
  const dataSummaries = dataSummariesOf(manifest);
  const actionSummaries = actionSummariesOf(manifest.actions ?? []);
  return {
    id: app.id,
    title,
    subtitle: stringValue(appSpec?.valueProp) || stringValue(appSpec?.tagline) || stringValue(manifest.domain) || "Agentlas internal app",
    appType,
    isVisualOutput,
    fields,
    recommendations,
    outputsLabel: isVisualOutput ? (locale === "en" ? "Generated outputs" : "생성 결과물") : (locale === "en" ? "Workbench result" : "작업 결과"),
    exportFormats: isVisualOutput ? ["png", "jpg", "json", "markdown"] : ["json", "markdown", "csv"],
    routeSummaries: routes.map((route) => ({ label: route.label || route.path, detail: stringValue(route.purpose) || stringValue(route.status) || route.path })),
    dataSummaries,
    actionSummaries,
  };
}

export function initialFieldValues(fields: GeneratedAppField[]): GeneratedAppFieldValues {
  return Object.fromEntries(fields.map((field) => [field.id, field.defaultValue]));
}

export function createGeneratedOutputs(
  blueprint: GeneratedAppBlueprint,
  values: GeneratedAppFieldValues,
  recommendation: GeneratedAppRecommendation | null,
): GeneratedAppOutput[] {
  const count = clamp(Number(values.count || values.pages || values.items || 4) || 4, 2, 9);
  const topic = values.topic || values.goal || values.prompt || blueprint.title;
  const audience = values.audience || values.customer || values.user || "target users";
  const selected = recommendation?.label || blueprint.recommendations[0]?.label || blueprint.appType;
  const routeSeeds = blueprint.routeSummaries.length
    ? blueprint.routeSummaries
    : [
        { label: "Input", detail: "Collect the user's goal and constraints." },
        { label: "Plan", detail: "Rank the best workflow and prepare app-specific options." },
        { label: "Output", detail: "Generate the usable artifact inside Agentlas." },
        { label: "Export", detail: "Save or reuse the result." },
      ];
  return Array.from({ length: count }, (_, index) => {
    const route = routeSeeds[index % routeSeeds.length];
    return {
      id: `output-${index + 1}`,
      title: titleForOutput(route.label, topic, index),
      body: bodyForOutput(route.detail, audience, selected, values, index),
      meta: `${String(index + 1).padStart(2, "0")} · ${selected}`,
    };
  });
}

export function serializeGeneratedOutputs(
  blueprint: GeneratedAppBlueprint,
  values: GeneratedAppFieldValues,
  recommendation: GeneratedAppRecommendation | null,
  outputs: GeneratedAppOutput[],
  format: GeneratedAppExportFormat,
): string {
  if (format === "csv") {
    return [
      ["id", "title", "body", "meta"].join(","),
      ...outputs.map((item) => [item.id, item.title, item.body, item.meta].map(csvCell).join(",")),
    ].join("\n");
  }
  if (format === "markdown") {
    return [
      `# ${blueprint.title}`,
      "",
      `- App type: ${blueprint.appType}`,
      `- Selected flow: ${recommendation?.label || blueprint.recommendations[0]?.label || "Default"}`,
      "",
      "## Inputs",
      ...Object.entries(values).map(([key, value]) => `- ${key}: ${value}`),
      "",
      "## Outputs",
      ...outputs.map((item) => `### ${item.title}\n\n${item.body}\n\n_${item.meta}_\n`),
    ].join("\n");
  }
  return JSON.stringify({ app: blueprint.title, appType: blueprint.appType, selected: recommendation, inputs: values, outputs }, null, 2);
}

export function demoGeneratedApp(id: string | null, locale: GeneratedAppLocale): AppFactoryAppRecord | null {
  if (!id || !/demo|sample/.test(id)) return null;
  const now = new Date().toISOString();
  const title = id.includes("cardnews")
    ? "Cardnews Studio"
    : id.includes("ops")
      ? locale === "en"
        ? "Ops Intake Desk"
        : "운영 요청 데스크"
    : locale === "en"
      ? "Lead Magnet Builder"
      : "리드마그넷 빌더";
  const manifest: AgentlasSurfaceManifest = id.includes("cardnews")
    ? demoCardnewsManifest(title)
    : id.includes("ops")
      ? demoOpsManifest(title)
    : demoGenericManifest(title);
  return {
    id,
    chatId: "demo",
    projectId: null,
    agentId: "demo-agent",
    surfaceId: "demo-surface",
    actionId: null,
    appName: title,
    domain: manifest.domain,
    layout: manifest.layout,
    rootPath: "/tmp/agentlas-demo-app",
    previewPath: "/tmp/agentlas-demo-app/src/index.html",
    setupPath: "/tmp/agentlas-demo-app/README.md",
    smokePath: "/tmp/agentlas-demo-app/tests/smoke.mjs",
    manifest,
    scaffold: {
      appId: id,
      appName: title,
      rootPath: "/tmp/agentlas-demo-app",
      previewPath: "/tmp/agentlas-demo-app/src/index.html",
      setupPath: "/tmp/agentlas-demo-app/README.md",
      smokePath: "/tmp/agentlas-demo-app/tests/smoke.mjs",
      createdAt: now,
      files: [],
      summary: "Demo generated app.",
    },
    status: "scaffolded",
    createdAt: now,
    updatedAt: now,
  };
}

function domainFields(manifest: AgentlasSurfaceManifest, locale: GeneratedAppLocale, visual: boolean): GeneratedAppField[] {
  const title = manifest.app?.name || manifest.title || "Generated App";
  const fields: GeneratedAppField[] = [
    {
      id: visual ? "topic" : "goal",
      label: visual ? (locale === "en" ? "Topic" : "주제") : (locale === "en" ? "Goal" : "목표"),
      kind: "textarea",
      defaultValue: visual ? title : stringValue(manifest.app?.valueProp) || title,
      helper: locale === "en" ? "The app will shape its workflow around this." : "앱이 이 내용을 기준으로 전용 흐름을 구성합니다.",
    },
    {
      id: "audience",
      label: locale === "en" ? "Audience" : "대상 사용자",
      kind: "text",
      defaultValue: stringValue(manifest.app?.audience) || stringValue(manifest.app?.business?.audience) || (locale === "en" ? "target users" : "대상 사용자"),
    },
  ];
  if (visual) {
    fields.push(
      {
        id: "format",
        label: locale === "en" ? "Output format" : "출력 포맷",
        kind: "select",
        defaultValue: "4:5",
        options: [
          { id: "1:1", label: "1:1" },
          { id: "4:5", label: "4:5" },
          { id: "3:4", label: "3:4" },
          { id: "9:16", label: "9:16" },
        ],
      },
      {
        id: "count",
        label: locale === "en" ? "Output count" : "결과물 개수",
        kind: "range",
        defaultValue: "5",
        min: 2,
        max: 9,
      },
      {
        id: "tone",
        label: locale === "en" ? "Tone" : "톤",
        kind: "text",
        defaultValue: locale === "en" ? "clear and practical" : "명확하고 실전적인 톤",
      },
    );
  } else {
    fields.push(
      {
        id: "workflow",
        label: locale === "en" ? "Workflow mode" : "작업 모드",
        kind: "select",
        defaultValue: "guided",
        options: [
          { id: "guided", label: locale === "en" ? "Guided" : "가이드형" },
          { id: "batch", label: locale === "en" ? "Batch" : "일괄 처리" },
          { id: "review", label: locale === "en" ? "Review" : "검토형" },
        ],
      },
      {
        id: "count",
        label: locale === "en" ? "Result items" : "결과 항목 수",
        kind: "range",
        defaultValue: "4",
        min: 2,
        max: 9,
      },
    );
  }
  return fields;
}

function toolParameterFields(manifest: AgentlasSurfaceManifest, locale: GeneratedAppLocale): GeneratedAppField[] {
  const params = (manifest.app?.tools ?? []).flatMap((tool) => tool.parameters ?? []);
  return params.slice(0, 8).map((param) => parameterToField(param, locale));
}

function parameterToField(param: AgentlasSurfaceToolParameterSpec, locale: GeneratedAppLocale): GeneratedAppField {
  const name = sanitizeId(param.name || stringValue(param.label) || "input");
  const type = String(param.type || "string").toLowerCase();
  const optionValues = Array.isArray(param.options) ? param.options : Array.isArray(param.enum) ? param.enum : [];
  return {
    id: name,
    label: stringValue(param.label) || humanize(name),
    kind: optionValues.length ? "select" : type.includes("number") ? "number" : type.includes("boolean") ? "select" : longTextParam(name, param) ? "textarea" : "text",
    defaultValue: stringValue(param.default) || "",
    helper: stringValue(param.description) || (locale === "en" ? "Generated from the app tool schema." : "앱 도구 스키마에서 생성된 입력입니다."),
    options: optionValues.length
      ? optionValues.map((value) => ({ id: String(value), label: String(value) }))
      : type.includes("boolean")
        ? [
            { id: "true", label: locale === "en" ? "Yes" : "예" },
            { id: "false", label: locale === "en" ? "No" : "아니오" },
          ]
        : undefined,
  };
}

function recommendationsOf(manifest: AgentlasSurfaceManifest, locale: GeneratedAppLocale, visual: boolean): GeneratedAppRecommendation[] {
  const routes = routesOf(manifest);
  const routeRecs = routes.map((route, index) => ({
    id: `route-${index}`,
    label: route.label || route.path,
    description: stringValue(route.purpose) || stringValue(route.status) || route.path,
    reason: locale === "en" ? "Declared by the generated app manifest." : "생성 앱 매니페스트가 선언한 화면입니다.",
    tags: [route.status || "route", manifest.layout].filter(Boolean).map(String),
  }));
  const widgetRecs = (manifest.widgets ?? []).slice(0, 4).map((widget, index) => ({
    id: `widget-${index}`,
    label: widget.title || humanize(String(widget.type || "widget")),
    description: widget.data ? `Data: ${widget.data}` : String(widget.type || "widget"),
    reason: locale === "en" ? "Widget declared by the agent." : "에이전트가 선언한 UI 위젯입니다.",
    tags: [String(widget.type || "widget")],
  }));
  const visualRecs: GeneratedAppRecommendation[] = visual
    ? [
        {
          id: "visual-bold",
          label: locale === "en" ? "Bold editorial output" : "강한 에디토리얼 결과물",
          description: locale === "en" ? "Strong hierarchy for social or creative deliverables." : "소셜/크리에이티브 결과물에 맞춘 강한 정보 위계.",
          reason: locale === "en" ? "Visual apps need a selectable output direction." : "시각 결과 앱은 사용자가 출력 방향을 고를 수 있어야 합니다.",
          tags: ["visual", "editorial"],
        },
        {
          id: "visual-clean",
          label: locale === "en" ? "Clean practical output" : "깔끔한 실전형 결과물",
          description: locale === "en" ? "Readable, repeatable, and suitable for quick iteration." : "읽기 쉽고 반복 생성에 적합한 실전형 구성.",
          reason: locale === "en" ? "Good fallback for beginner-facing tools." : "초보자용 도구에 적합한 기본 선택지입니다.",
          tags: ["clean", "practical"],
        },
      ]
    : [];
  return [...routeRecs, ...widgetRecs, ...visualRecs].slice(0, 8);
}

function dataSummariesOf(manifest: AgentlasSurfaceManifest): Array<{ label: string; detail: string }> {
  return Object.entries(manifest.data ?? {}).slice(0, 8).map(([id, data]) => ({
    label: stringValue(data.title) || humanize(id),
    detail: data.summary || stringValue(data.description) || `${Array.isArray(data.rows) ? data.rows.length : Array.isArray(data.items) ? data.items.length : 0} rows`,
  }));
}

function actionSummariesOf(actions: AgentlasSurfaceAction[]): Array<{ label: string; detail: string }> {
  return actions.slice(0, 8).map((action) => ({
    label: action.label || humanize(action.id),
    detail: `${action.type}${action.permission ? ` · ${action.permission}` : ""}`,
  }));
}

function routesOf(manifest: AgentlasSurfaceManifest): AgentlasSurfaceAppRoute[] {
  const direct = manifest.app?.routes ?? [];
  if (direct.length) return direct;
  const routeData = manifest.data?.routes;
  const rows = Array.isArray(routeData?.rows) ? routeData.rows : Array.isArray(routeData?.items) ? routeData.items : [];
  return rows.map((row) => ({
    path: stringValue(row.path) || `/${sanitizeId(stringValue(row.label) || "screen")}`,
    label: stringValue(row.label) || stringValue(row.name) || "Screen",
    purpose: stringValue(row.purpose) || stringValue(row.description),
    status: stringValue(row.status),
  }));
}

function dedupeFields(fields: GeneratedAppField[]): GeneratedAppField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const id = sanitizeId(field.id);
    if (seen.has(id)) return false;
    seen.add(id);
    field.id = id;
    return true;
  });
}

function demoGenericManifest(title: string): AgentlasSurfaceManifest {
  return {
    version: "0.1",
    kind: "surface",
    title,
    domain: "growth",
    layout: "service-app",
    app: {
      name: title,
      appType: "creative-tool",
      audience: "solo founders",
      valueProp: "Turn a product idea into a downloadable lead magnet.",
      routes: [
        { path: "/brief", label: "Brief", purpose: "Capture offer, audience, and promise.", status: "generated" },
        { path: "/outline", label: "Outline", purpose: "Rank the best lead magnet structure.", status: "generated" },
        { path: "/draft", label: "Draft", purpose: "Generate pages and handoff copy.", status: "generated" },
        { path: "/export", label: "Export", purpose: "Download the draft package.", status: "generated" },
      ],
      tools: [
        {
          id: "lead-magnet-builder",
          name: "Lead Magnet Builder",
          description: "Builds a lead magnet draft.",
          parameters: [
            { name: "offer", label: "Offer", type: "string", default: "AI workflow audit" },
            { name: "channel", label: "Channel", type: "string", default: "LinkedIn", enum: ["LinkedIn", "Instagram", "Email"] },
          ],
        },
      ],
    },
    data: {
      routes: { type: "routes", rows: [] },
      examples: { type: "cards", summary: "Starter lead magnet examples", rows: [{ name: "Checklist" }, { name: "Mini guide" }] },
    },
    widgets: [{ type: "form", title: "Brief builder" }, { type: "export-pack", title: "Download package" }],
    actions: [{ id: "export", label: "Export package", type: "export", permission: "read" }],
  };
}

function demoCardnewsManifest(title: string): AgentlasSurfaceManifest {
  const base = demoGenericManifest(title);
  return {
    ...base,
    domain: "creative",
    layout: "creative-studio",
    app: {
      ...base.app,
      name: title,
      appType: "creative-tool",
      audience: "creators",
      valueProp: "Research a topic and export Instagram-optimized cardnews images.",
      routes: [
        { path: "/topic", label: "Topic", purpose: "Collect topic, language, audience, and tone.", status: "generated" },
        { path: "/research", label: "Research", purpose: "Create a brief for the carousel.", status: "generated" },
        { path: "/template", label: "Template counseling", purpose: "Recommend and let the user pick a visual direction.", status: "generated" },
        { path: "/export", label: "Export", purpose: "Save PNG/JPG outputs.", status: "generated" },
      ],
    },
  };
}

function demoOpsManifest(title: string): AgentlasSurfaceManifest {
  return {
    version: "0.1",
    kind: "surface",
    title,
    domain: "operations",
    layout: "service-app",
    app: {
      name: title,
      appType: "internal-tool",
      audience: "operations teams",
      valueProp: "Collect requests, triage priority, and generate the next action list.",
      routes: [
        { path: "/intake", label: "Intake", purpose: "Collect request context, owner, and deadline.", status: "generated" },
        { path: "/triage", label: "Triage", purpose: "Rank urgency and assign the next owner.", status: "generated" },
        { path: "/handoff", label: "Handoff", purpose: "Produce a clear task handoff.", status: "generated" },
        { path: "/ledger", label: "Ledger", purpose: "Export the decision log.", status: "generated" },
      ],
      tools: [
        {
          id: "ops-intake",
          name: "Ops Intake",
          description: "Normalizes an operations request.",
          parameters: [
            { name: "request", label: "Request", type: "string", default: "Review a delayed customer onboarding issue" },
            { name: "priority", label: "Priority", type: "string", default: "medium", enum: ["low", "medium", "high"] },
            { name: "owner", label: "Owner", type: "string", default: "Ops lead" },
          ],
        },
      ],
    },
    data: {
      queue: { type: "table", summary: "Open operations requests", rows: [{ owner: "Ops lead", priority: "medium" }] },
    },
    widgets: [{ type: "form", title: "Request intake" }, { type: "table", title: "Triage queue" }],
    actions: [{ id: "export-ledger", label: "Export ledger", type: "export", permission: "read" }],
  };
}

function titleForOutput(label: string, topic: string, index: number): string {
  if (index === 0) return topic.length > 54 ? `${topic.slice(0, 51)}...` : topic;
  return label.length > 54 ? `${label.slice(0, 51)}...` : label;
}

function bodyForOutput(detail: string, audience: string, selected: string, values: GeneratedAppFieldValues, index: number): string {
  const tone = values.tone ? ` Tone: ${values.tone}.` : "";
  const channel = values.channel ? ` Channel: ${values.channel}.` : "";
  if (index === 0) return `Frame this for ${audience}. Use "${selected}" as the working direction.${tone}${channel}`;
  return `${detail || "Generate the next useful piece of the workflow."} Keep it concrete, editable, and ready to export.`;
}

function longTextParam(name: string, param: AgentlasSurfaceToolParameterSpec): boolean {
  const raw = `${name} ${param.description ?? ""}`.toLowerCase();
  return /prompt|brief|description|content|body|copy|notes|context|요약|설명|본문/.test(raw);
}

function csvCell(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizeId(value: string): string {
  return (value || "input").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "") || "input";
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
