import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceAppRoute,
  AgentlasSurfaceBusinessSpec,
  AgentlasSurfaceManifest,
  AgentlasSurfaceToolParameterSpec,
  AgentlasSurfaceToolSpec,
  AgentlasSurfaceWidget,
} from "./types";

const PUBLIC_COPY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bLiner[-\s]?style\s+text\s+editing\b/gi, "research-first text editing"],
  [/\bGenspark[-\s]?style\s+report\s+generation\b/gi, "structured report generation"],
  [/\bLiner[-\s]?style\b/gi, "research-first"],
  [/\bGenspark[-\s]?style\b/gi, "structured-report"],
  [/라이너식\s*텍스트\s*편집/g, "리서치형 텍스트 편집"],
  [/젠스파크식\s*리포트\s*생성/g, "구조화 리포트 생성"],
  [/\b(?:like|similar to)\s+Liner\b/gi, "with research-first controls"],
  [/\b(?:like|similar to)\s+Genspark\b/gi, "with structured-report controls"],
  [/\binspired by\s+(?:Liner|Genspark)\b/gi, "using a familiar workflow"],
  [/(?:라이너|젠스파크)\s*(?:같은|처럼|스타일|방식)/g, "익숙한 작업 방식"],
  [/\bLiner\b/g, "research workspace"],
  [/\bGenspark\b/g, "report workspace"],
  [/라이너/g, "리서치 워크스페이스"],
  [/젠스파크/g, "리포트 워크스페이스"],
];

export function sanitizePublicAppCopy(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  let next = value;
  for (const [pattern, replacement] of PUBLIC_COPY_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  next = next
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+·\s+/g, " · ")
    .trim();
  return next || fallback;
}

export function sanitizePublicAppManifestCopy<T extends AgentlasSurfaceManifest>(manifest: T): T {
  const next = cloneManifest(manifest);
  next.title = sanitizePublicAppCopy(next.title, next.title);
  next.domain = sanitizePublicAppCopy(next.domain, next.domain);
  const dynamic = next as T & { description?: unknown };
  if (typeof dynamic.description === "string") {
    dynamic.description = sanitizePublicAppCopy(dynamic.description, dynamic.description);
  }
  if (next.app) {
    next.app = {
      ...next.app,
      name: sanitizePublicAppCopy(next.app.name, next.app.name),
      tagline: sanitizePublicAppCopy(next.app.tagline, next.app.tagline),
      valueProp: sanitizePublicAppCopy(next.app.valueProp, next.app.valueProp),
      audience: sanitizePublicAppCopy(next.app.audience, next.app.audience),
      appType: sanitizePublicAppCopy(next.app.appType, next.app.appType),
      business: sanitizeBusiness(next.app.business),
      routes: next.app.routes?.map(sanitizeRoute),
      tools: next.app.tools?.map(sanitizeTool),
    };
  }
  if (next.widgets) next.widgets = next.widgets.map(sanitizeWidget);
  if (next.actions) next.actions = next.actions.map(sanitizeAction);
  if (next.data) next.data = sanitizeDataMap(next.data);
  return next;
}

function cloneManifest<T extends AgentlasSurfaceManifest>(manifest: T): T {
  return JSON.parse(JSON.stringify(manifest)) as T;
}

function sanitizeBusiness<T extends AgentlasSurfaceBusinessSpec | undefined>(business: T): T {
  if (!business) return business;
  const next = { ...business };
  for (const key of ["audience", "offer", "pricing", "moat", "launchMetric", "productType"]) {
    if (typeof next[key] === "string") next[key] = sanitizePublicAppCopy(next[key], next[key]);
  }
  return next as T;
}

function sanitizeRoute(route: AgentlasSurfaceAppRoute): AgentlasSurfaceAppRoute {
  return {
    ...route,
    label: sanitizePublicAppCopy(route.label, route.label),
    purpose: sanitizePublicAppCopy(route.purpose, route.purpose),
    status: sanitizePublicAppCopy(route.status, route.status),
  };
}

function sanitizeTool(tool: AgentlasSurfaceToolSpec): AgentlasSurfaceToolSpec {
  return {
    ...tool,
    name: sanitizePublicAppCopy(tool.name, tool.name),
    description: sanitizePublicAppCopy(tool.description, tool.description),
    parameters: tool.parameters?.map(sanitizeToolParameter),
  };
}

function sanitizeToolParameter(param: AgentlasSurfaceToolParameterSpec): AgentlasSurfaceToolParameterSpec {
  return {
    ...param,
    label: sanitizePublicAppCopy(param.label, param.label),
    description: sanitizePublicAppCopy(param.description, param.description),
  };
}

function sanitizeWidget(widget: AgentlasSurfaceWidget): AgentlasSurfaceWidget {
  const description = widget.description;
  const next: AgentlasSurfaceWidget = {
    ...widget,
    title: sanitizePublicAppCopy(widget.title, widget.title),
  };
  if (typeof description === "string") next.description = sanitizePublicAppCopy(description, description);
  return next;
}

function sanitizeAction(action: AgentlasSurfaceAction): AgentlasSurfaceAction {
  return {
    ...action,
    label: sanitizePublicAppCopy(action.label, action.label),
  };
}

function sanitizeDataMap(data: AgentlasSurfaceManifest["data"]): AgentlasSurfaceManifest["data"] {
  const next: AgentlasSurfaceManifest["data"] = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    next[key] = sanitizeDataRecord(value);
  }
  return next;
}

function sanitizeDataRecord(record: AgentlasSurfaceManifest["data"][string]): AgentlasSurfaceManifest["data"][string] {
  const next = { ...record };
  if (typeof next.title === "string") next.title = sanitizePublicAppCopy(next.title, next.title);
  if (typeof next.summary === "string") next.summary = sanitizePublicAppCopy(next.summary, next.summary);
  if (typeof next.description === "string") next.description = sanitizePublicAppCopy(next.description, next.description);
  return next;
}
