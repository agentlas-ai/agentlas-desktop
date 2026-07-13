import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SiteAgentAppCapabilityIssue,
  SiteAgentAppContractInput,
  SiteAgentAppContractOutput,
  SiteAgentAppContractSnapshot,
  SiteAstryxTemplate,
} from "../../shared/site-studio";
import {
  declaredSiteAgentAppCapabilities,
  noSiteAgentAppCapabilities,
  normalizeSiteAgentAppCapabilityProfile,
} from "./agent-app-capabilities";

export const SITE_AGENT_APP_CONTRACT_FILE = ".agentlas/agent-app-contract.json" as const;
export const SITE_AGENT_APP_ROUTING_CARD_FILE = ".agentlas/routing-card.json" as const;
const CONTRACT_MAX_BYTES = 64 * 1024;

export type DeclaredSiteAgentAppContract = {
  contract: SiteAgentAppContractSnapshot;
  template: SiteAstryxTemplate | null;
};

function safeText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\0\r\n`<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

/** Strictly rebuild the public JSON contract; unknown/private keys are dropped. */
export function normalizeSiteAgentAppContract(
  value: unknown,
  source: SiteAgentAppContractSnapshot["source"],
): SiteAgentAppContractSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { schemaVersion?: unknown; inputs?: unknown; outputs?: unknown; capabilities?: unknown };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.inputs) || !Array.isArray(raw.outputs)) return null;
  if (!raw.inputs.length || !raw.outputs.length || raw.inputs.length > 8 || raw.outputs.length > 8) return null;

  const names = new Set<string>();
  const inputs: SiteAgentAppContractInput[] = [];
  for (const item of raw.inputs) {
    if (!item || typeof item !== "object") return null;
    const field = item as Partial<SiteAgentAppContractInput>;
    const name = safeText(field.name, 64);
    const type = field.type;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || names.has(name)) return null;
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "object" && type !== "array") return null;
    const format = field.format === "textarea" ? "textarea" as const : field.format === "text" || field.format === undefined ? "text" as const : null;
    if (!format) return null;
    const rawOptions = field.options === undefined ? [] : field.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > 12 || rawOptions.some((option) => typeof option !== "string")) return null;
    const internalDefault = field.defaultValue === undefined ? (type === "boolean" ? false : null) : field.defaultValue;
    if (
      source === "inferred-fallback" &&
      internalDefault !== null &&
      typeof internalDefault !== "string" &&
      typeof internalDefault !== "number" &&
      typeof internalDefault !== "boolean"
    ) return null;
    // Package, routing-card, and composed-target declarations are public
    // contract metadata, never a credential transport. Only the hardcoded
    // inferred fallback may carry its internally authored convenience default.
    const defaultValue = source === "inferred-fallback"
      ? internalDefault as string | number | boolean | null
      : type === "boolean"
        ? false
        : null;
    names.add(name);
    inputs.push({
      name,
      type,
      label: safeText(field.label, 100) || name,
      description: safeText(field.description, 240),
      required: field.required === true,
      format,
      options: rawOptions.map((option) => safeText(option, 80)).filter(Boolean),
      defaultValue,
    });
  }

  const outputNames = new Set<string>();
  const outputs: SiteAgentAppContractOutput[] = [];
  for (const item of raw.outputs) {
    if (!item || typeof item !== "object") return null;
    const output = item as Partial<SiteAgentAppContractOutput>;
    const name = safeText(output.name, 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || outputNames.has(name)) return null;
    outputNames.add(name);
    outputs.push({
      name,
      label: safeText(output.label, 100) || name,
      type: safeText(output.type, 40) || "markdown",
      description: safeText(output.description, 240),
    });
  }
  const capabilitySource = source === "inferred-fallback"
    ? "none"
    : source === "declared-routing-card"
      ? "declared-routing-card"
      : source === "composed-target"
        ? "composed-target"
        : "declared-package";
  const capabilities = source === "inferred-fallback"
    ? noSiteAgentAppCapabilities()
    : normalizeSiteAgentAppCapabilityProfile(raw.capabilities, capabilitySource);
  return { schemaVersion: 1, source, inputs, outputs, capabilities };
}

/**
 * Read only the canonical package declaration. The resolved file must be a
 * regular file contained by the package root; symlink escapes and oversized
 * declarations are rejected before JSON parsing.
 */
export function readDeclaredSiteAgentAppContract(root: string | null | undefined): DeclaredSiteAgentAppContract | null {
  if (!root || !path.isAbsolute(root)) return null;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
    if (!fs.statSync(rootReal).isDirectory()) return null;
  } catch {
    return null;
  }

  const candidate = path.join(rootReal, SITE_AGENT_APP_CONTRACT_FILE);
  let stat: fs.Stats;
  let real: string;
  try {
    const linkStat = fs.lstatSync(candidate);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
    stat = linkStat;
    real = fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Agent App 입출력 계약 파일을 읽을 수 없습니다.", { cause: error });
  }
  const relative = path.relative(rootReal, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent App 입출력 계약 파일이 패키지 경계를 벗어났습니다.");
  }
  if (stat.size <= 0 || stat.size > CONTRACT_MAX_BYTES) {
    throw new Error(`Agent App 입출력 계약은 ${CONTRACT_MAX_BYTES / 1024}KB 이하의 JSON이어야 합니다.`);
  }

  let parsed: unknown;
  try {
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new Error("Agent App 입출력 계약 JSON이 올바르지 않습니다.", { cause: error });
  }
  const contract = normalizeSiteAgentAppContract(parsed, "declared-package");
  if (!contract) throw new Error("Agent App 입출력 계약 스키마가 올바르지 않습니다.");
  const templateValue = (parsed as { template?: unknown }).template;
  if (
    templateValue !== undefined &&
    templateValue !== "ai-chat" &&
    templateValue !== "ai-chat-landing" &&
    templateValue !== "form-two-column"
  ) {
    throw new Error("Agent App 입출력 계약의 Astryx 템플릿 값이 올바르지 않습니다.");
  }
  const template: SiteAstryxTemplate | null =
    templateValue === "ai-chat" || templateValue === "ai-chat-landing" || templateValue === "form-two-column"
      ? templateValue
      : null;
  return { contract, template };
}

function safeFieldName(value: unknown, fallback: string): string {
  const text = safeText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(text) ? text : fallback;
}

function routingInput(item: unknown, required: boolean, index: number): SiteAgentAppContractInput | null {
  if (typeof item === "string") {
    const label = safeText(item, 100);
    if (!label) return null;
    return {
      name: safeFieldName(label, `input-${index + 1}`),
      type: "string",
      label,
      description: "",
      required,
      format: "textarea",
      options: [],
      defaultValue: null,
    };
  }
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const label = safeText(raw.label, 100) || safeText(raw.name, 100) || `Input ${index + 1}`;
  const rawType = safeText(raw.type, 30).toLowerCase();
  const type: SiteAgentAppContractInput["type"] = rawType === "number" || rawType === "integer"
    ? "number"
    : rawType === "boolean"
      ? "boolean"
      : rawType === "object" || rawType === "json"
        ? "object"
        : rawType === "array" || rawType === "list"
          ? "array"
          : "string";
  const optionValues = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.enum) ? raw.enum : [];
  const options = optionValues
    .filter((option): option is string | number | boolean => ["string", "number", "boolean"].includes(typeof option))
    .map((option) => safeText(String(option), 80))
    .filter(Boolean)
    .slice(0, 12);
  return {
    name: safeFieldName(raw.name, `input-${index + 1}`),
    type,
    label,
    description: safeText(raw.description, 240),
    required,
    format: rawType === "textarea" || rawType === "text" || rawType === "file" ? "textarea" : "text",
    options,
    // Routing cards are external declarations. Their defaults must never
    // become public/local generated source, even when the value is scalar.
    defaultValue: type === "boolean" ? false : null,
  };
}

function routingOutput(item: unknown, index: number): SiteAgentAppContractOutput | null {
  if (typeof item === "string") {
    const label = safeText(item, 100);
    if (!label) return null;
    return {
      name: safeFieldName(label, `output-${index + 1}`),
      label,
      type: "markdown",
      description: "",
    };
  }
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const label = safeText(raw.label, 100) || safeText(raw.name, 100) || safeText(raw.kind, 100) || `Output ${index + 1}`;
  return {
    name: safeFieldName(raw.name ?? raw.kind, `output-${index + 1}`),
    label,
    type: safeText(raw.type ?? raw.kind, 40) || "markdown",
    description: safeText(raw.description, 240),
  };
}

function readRoutingCard(root: string): Record<string, unknown> | null {
  if (!path.isAbsolute(root)) return null;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
    if (!fs.statSync(rootReal).isDirectory()) return null;
  } catch {
    return null;
  }
  const candidate = path.join(rootReal, SITE_AGENT_APP_ROUTING_CARD_FILE);
  let stat: fs.Stats;
  let real: string;
  try {
    stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    real = fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Agent App routing-card를 읽을 수 없습니다.", { cause: error });
  }
  const relative = path.relative(rootReal, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent App routing-card가 패키지 경계를 벗어났습니다.");
  }
  if (stat.size <= 0 || stat.size > CONTRACT_MAX_BYTES) {
    throw new Error(`Agent App routing-card는 ${CONTRACT_MAX_BYTES / 1024}KB 이하의 JSON이어야 합니다.`);
  }
  try {
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new Error("Agent App routing-card JSON이 올바르지 않습니다.", { cause: error });
  }
}

function routingPluginIds(card: Record<string, unknown>): string[] {
  const agentApp = card.agent_app && typeof card.agent_app === "object" && !Array.isArray(card.agent_app)
    ? card.agent_app as Record<string, unknown>
    : null;
  const candidates = [
    ...(Array.isArray(card.required_plugins) ? card.required_plugins : []),
    ...(Array.isArray(agentApp?.readonly_mcp_catalog_ids) ? agentApp!.readonly_mcp_catalog_ids as unknown[] : []),
  ];
  return candidates.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    return typeof raw.id === "string" ? [raw.id] : typeof raw.slug === "string" ? [raw.slug] : [];
  });
}

function routingPolicyIssues(card: Record<string, unknown>): SiteAgentAppCapabilityIssue[] {
  const issues: SiteAgentAppCapabilityIssue[] = [];
  const approvals = Array.isArray(card.approval_requirements) ? card.approval_requirements : [];
  for (const approval of approvals) {
    const id = safeFieldName(approval, "restricted-capability");
    if (/(write|shell|exec|publish|publication|payment|cloud|browser|upload|deploy|delete|external)/i.test(id)) {
      issues.push({ id, reason: "blocked-by-agent-app-policy" });
    }
  }
  const memory = card.memory_behavior && typeof card.memory_behavior === "object" && !Array.isArray(card.memory_behavior)
    ? card.memory_behavior as Record<string, unknown>
    : null;
  const writes = memory?.writes;
  if ((Array.isArray(writes) && writes.length > 0) || (typeof writes === "string" && writes.trim() && writes !== "none")) {
    issues.push({ id: "persistence", reason: "blocked-by-agent-app-policy" });
  }
  return issues;
}

/**
 * Resolve the canonical Agent App contract first, then the package's standard
 * routing-card/2.0 declaration. Semantic `capabilities` are display/routing
 * metadata only; only exact required plugin ids may request a runtime grant.
 */
export function readResolvedSiteAgentAppContract(root: string | null | undefined): DeclaredSiteAgentAppContract | null {
  const explicit = readDeclaredSiteAgentAppContract(root);
  if (explicit || !root) return explicit;
  const card = readRoutingCard(root);
  if (!card || card.schemaVersion !== "routing-card/2.0") return null;

  const requiredRaw = Array.isArray(card.required_inputs) ? card.required_inputs : [];
  const optionalRaw = Array.isArray(card.optional_inputs) ? card.optional_inputs : [];
  const inputs = [
    ...requiredRaw.map((item, index) => routingInput(item, true, index)),
    ...optionalRaw.map((item, index) => routingInput(item, false, requiredRaw.length + index)),
  ].filter((item): item is SiteAgentAppContractInput => Boolean(item));
  if (!inputs.length) {
    inputs.push({
      name: "request",
      type: "string",
      label: "Request",
      description: safeText(card.summary ?? card.description, 240),
      required: true,
      format: "textarea",
      options: [],
      defaultValue: null,
    });
  }
  const producesRaw = Array.isArray(card.produces) ? card.produces : [];
  const outputs = producesRaw
    .map((item, index) => routingOutput(item, index))
    .filter((item): item is SiteAgentAppContractOutput => Boolean(item));
  if (!outputs.length) {
    outputs.push({ name: "result", label: "Result", type: "markdown", description: "The declared agent result." });
  }

  const capabilities = declaredSiteAgentAppCapabilities(
    routingPluginIds(card),
    "declared-routing-card",
    routingPolicyIssues(card),
  );
  const contract = normalizeSiteAgentAppContract({
    schemaVersion: 1,
    inputs: inputs.slice(0, 8),
    outputs: outputs.slice(0, 8),
    capabilities,
  }, "declared-routing-card");
  if (!contract) throw new Error("Agent App routing-card 입출력 계약을 정규화할 수 없습니다.");
  return { contract, template: null };
}
