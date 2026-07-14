import type { SiteAgentAppTarget, SiteAgentAppVisualSnapshot } from "../../shared/site-studio";

export const SITE_AGENT_APP_VISUAL_META = {
  colorMode: "agentlas-visual-color-mode",
  accent: "agentlas-visual-accent",
  density: "agentlas-visual-density",
  radius: "agentlas-visual-radius",
  headline: "agentlas-visual-headline",
  description: "agentlas-visual-description",
  inputHeading: "agentlas-visual-input-heading",
  outputHeading: "agentlas-visual-output-heading",
  runLabel: "agentlas-visual-run-label",
  emptyOutput: "agentlas-visual-empty-output",
} as const;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\0\r\n`<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function strictDisplayText(value: unknown, max: number): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f<>`\u202a-\u202e\u2066-\u2069]/u.test(value)) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function defaultSiteAgentAppVisual(target: SiteAgentAppTarget): SiteAgentAppVisualSnapshot {
  return {
    schemaVersion: 1,
    colorMode: "light",
    accent: "teal",
    density: "spacious",
    radius: "soft",
    headline: `Where should we start with ${cleanText(target.name, 100)}?`,
    description: cleanText(target.description, 300) || `Complete the declared inputs for ${cleanText(target.name, 100)}.`,
    inputHeading: "Inputs",
    outputHeading: "Outputs",
    runLabel: `Run ${cleanText(target.name, 80)}`,
    emptyOutput: "The agent output will appear here after a successful runtime call.",
  };
}

export function normalizeSiteAgentAppVisual(value: unknown): SiteAgentAppVisualSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SiteAgentAppVisualSnapshot>;
  if (raw.schemaVersion !== 1) return null;
  if (raw.colorMode !== "system" && raw.colorMode !== "light" && raw.colorMode !== "dark") return null;
  if (raw.accent !== "neutral" && raw.accent !== "blue" && raw.accent !== "teal" && raw.accent !== "purple" && raw.accent !== "orange") return null;
  if (raw.density !== "compact" && raw.density !== "comfortable" && raw.density !== "spacious") return null;
  if (raw.radius !== "sharp" && raw.radius !== "soft" && raw.radius !== "round") return null;
  const headline = strictDisplayText(raw.headline, 120);
  const description = strictDisplayText(raw.description, 300);
  const inputHeading = strictDisplayText(raw.inputHeading, 64);
  const outputHeading = strictDisplayText(raw.outputHeading, 64);
  const runLabel = strictDisplayText(raw.runLabel, 64);
  const emptyOutput = strictDisplayText(raw.emptyOutput, 160);
  if (!headline || !description || !inputHeading || !outputHeading || !runLabel || !emptyOutput) return null;
  return {
    schemaVersion: 1,
    colorMode: raw.colorMode,
    accent: raw.accent,
    density: raw.density,
    radius: raw.radius,
    headline,
    description,
    inputHeading,
    outputHeading,
    runLabel,
    emptyOutput,
  };
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag);
  return match ? decodeAttribute(match[2]) : null;
}

function metaContent(html: string, name: string): string | null {
  const values: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (attribute(match[0], "name") === name) {
      const content = attribute(match[0], "content");
      if (content === null) return null;
      values.push(content);
    }
  }
  return values.length === 1 ? values[0] : null;
}

/** Parse only six allowlisted meta values; preview HTML/CSS never reaches source generation. */
export function extractSiteAgentAppVisual(html: string): SiteAgentAppVisualSnapshot {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html);
  if (!headMatch) throw new Error("Agent App preview is missing a valid allowlisted visual snapshot");
  const head = headMatch[1]
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const raw = {
    schemaVersion: 1,
    colorMode: metaContent(head, SITE_AGENT_APP_VISUAL_META.colorMode),
    accent: metaContent(head, SITE_AGENT_APP_VISUAL_META.accent),
    density: metaContent(head, SITE_AGENT_APP_VISUAL_META.density),
    radius: metaContent(head, SITE_AGENT_APP_VISUAL_META.radius),
    headline: metaContent(head, SITE_AGENT_APP_VISUAL_META.headline),
    description: metaContent(head, SITE_AGENT_APP_VISUAL_META.description),
    inputHeading: metaContent(head, SITE_AGENT_APP_VISUAL_META.inputHeading),
    outputHeading: metaContent(head, SITE_AGENT_APP_VISUAL_META.outputHeading),
    runLabel: metaContent(head, SITE_AGENT_APP_VISUAL_META.runLabel),
    emptyOutput: metaContent(head, SITE_AGENT_APP_VISUAL_META.emptyOutput),
  };
  const visual = normalizeSiteAgentAppVisual(raw);
  if (!visual) {
    throw new Error("Agent App preview is missing a valid allowlisted visual snapshot");
  }
  return visual;
}

export function siteAgentAppVisualMetaMarkup(visual: SiteAgentAppVisualSnapshot): string[] {
  const escape = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    `<meta name="${SITE_AGENT_APP_VISUAL_META.colorMode}" content="${visual.colorMode}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.accent}" content="${visual.accent}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.density}" content="${visual.density}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.radius}" content="${visual.radius}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.headline}" content="${escape(visual.headline)}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.description}" content="${escape(visual.description)}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.inputHeading}" content="${escape(visual.inputHeading)}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.outputHeading}" content="${escape(visual.outputHeading)}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.runLabel}" content="${escape(visual.runLabel)}">`,
    `<meta name="${SITE_AGENT_APP_VISUAL_META.emptyOutput}" content="${escape(visual.emptyOutput)}">`,
  ];
}
