// Local meta-agent factory for Agentlas OS.
// It materializes a domain team as a durable local Agentlas firm without using
// a hosted web API. The generated team is plain markdown/config plus registry
// rows; all real provider credentials/payments still flow through the OS gates.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getProject } from "../store/projects";
import { setRoute } from "../agents/routes";
import { upsertLocalTeamFirm } from "../store/firms";
import { saveResolvedOrg } from "../store/org-spec";
import type {
  FirmOrgNode,
  InstalledAgent,
  MetaAgentTeamFactoryFile,
  MetaAgentTeamFactoryRequest,
  MetaAgentTeamFactoryResult,
  ResolvedDivision,
  ResolvedOrg,
} from "../../shared/types";

interface TeamProfile {
  name: string;
  slug: string;
  category: string;
  audience: string;
  tagline: string;
}

const TEAM_ROLES = [
  {
    id: "storefront",
    role: "Storefront Division",
    name: "Storefront Designer",
    specialists: [
      { id: "ux", role: "Conversion UX Specialist", name: "Conversion UX" },
      { id: "brand", role: "Fashion Brand Stylist", name: "Brand Stylist" },
    ],
  },
  {
    id: "catalog",
    role: "Catalog Division",
    name: "Catalog Operator",
    specialists: [
      { id: "copy", role: "Product Copywriter", name: "Product Copy" },
      { id: "image", role: "Image Generation Director", name: "Image Director" },
    ],
  },
  {
    id: "payments-data",
    role: "Payments and Data Division",
    name: "Payment/Data Integrator",
    specialists: [
      { id: "payment", role: "Payment Provider Operator", name: "Payment Operator" },
      { id: "database", role: "Commerce Database Operator", name: "Database Operator" },
    ],
  },
  {
    id: "operations",
    role: "Operations Division",
    name: "Order Desk Operator",
    specialists: [
      { id: "fulfillment", role: "Fulfillment Router", name: "Fulfillment Router" },
      { id: "support", role: "Customer Support Drafter", name: "Support Drafter" },
    ],
  },
] as const;

export function createCommerceAgentTeam(input: MetaAgentTeamFactoryRequest): MetaAgentTeamFactoryResult {
  const chat = getChat(input.chatId);
  if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
  const project = chat.projectId ? getProject(chat.projectId) : null;
  const baseDir =
    input.baseDir ||
    getChatWorkingFolder(chat.id) ||
    project?.folderPath ||
    path.join(app.getPath("userData"), "generated-teams");
  const profile = profileFromManifest(input.manifest);
  const rootPath = path.join(baseDir, ".agentlas", "generated-teams", profile.slug);
  fs.mkdirSync(rootPath, { recursive: true });

  const createdAt = new Date().toISOString();
  const files = writeTeamFiles(rootPath, profile, input, createdAt);
  const agent = upsertTeamAgent(rootPath, profile, createdAt);
  setRoute({
    agentId: agent.id,
    path: rootPath,
    runtime: "generic",
    labels: ["generic", "codex", "claude-code", "gemini"],
    kind: "team",
    importedAt: createdAt,
  });
  const memberAgents = upsertTeamMemberAgents(rootPath, profile, createdAt);
  for (const member of memberAgents.values()) {
    setRoute({
      agentId: member.agent.id,
      path: member.localPath,
      runtime: "generic",
      labels: ["generic", "codex", "claude-code", "gemini"],
      kind: "agent",
      importedAt: createdAt,
    });
  }

  const orgChart = buildOrgChart(profile.slug, agent.id, memberAgents);
  const firm = upsertLocalTeamFirm({
    slug: `firm-${profile.slug}`,
    name: profile.name,
    nameEn: profile.name,
    tagline: profile.tagline,
    persona: profile.audience,
    ceoAgentId: agent.id,
    orgChart,
  });
  const org = buildResolvedOrg(agent, rootPath, profile, createdAt, memberAgents);
  saveResolvedOrg(firm.id, org);

  emitDesktopStoreChange({ entity: "agent", id: agent.id });
  for (const member of memberAgents.values()) {
    emitDesktopStoreChange({ entity: "agent", id: member.agent.id });
  }

  return { rootPath, agent, firm, org, files, createdAt };
}

interface TeamMemberAgent {
  slug: string;
  localPath: string;
  agent: InstalledAgent;
}

function writeTeamFiles(
  rootPath: string,
  profile: TeamProfile,
  input: MetaAgentTeamFactoryRequest,
  createdAt: string,
): MetaAgentTeamFactoryFile[] {
  const files: MetaAgentTeamFactoryFile[] = [];
  const write = (relative: string, kind: MetaAgentTeamFactoryFile["kind"], body: string) => {
    const full = path.join(rootPath, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
    files.push({ path: relative, kind, bytes: Buffer.byteLength(body, "utf8") });
  };

  write("TEAM.md", "doc", teamOverview(profile, input, createdAt));
  write("README.md", "doc", teamOverview(profile, input, createdAt));

  write(
    "AGENTS.md",
    "config",
    runtimeGuide(profile, rootPath, input, "Codex", createdAt),
  );
  write("CLAUDE.md", "config", runtimeGuide(profile, rootPath, input, "Claude Code", createdAt));
  write(path.join(".claude", "CLAUDE.md"), "config", runtimeGuide(profile, rootPath, input, "Claude Code", createdAt));
  write("GEMINI.md", "config", runtimeGuide(profile, rootPath, input, "Gemini", createdAt));

  write("agents/ceo/AGENT.md", "prompt", ceoPrompt(profile, rootPath));
  write("agents/ceo/AGENTS.md", "config", ceoRuntimeGuide(profile, rootPath, "Codex"));
  write("agents/ceo/CLAUDE.md", "config", ceoRuntimeGuide(profile, rootPath, "Claude Code"));
  write("agents/ceo/GEMINI.md", "config", ceoRuntimeGuide(profile, rootPath, "Gemini"));
  for (const role of TEAM_ROLES) {
    write(`agents/${role.id}/AGENT.md`, "prompt", divisionPrompt(profile, role.role, role.name));
    write(`agents/${role.id}/AGENTS.md`, "config", divisionRuntimeGuide(profile, role.role, role.name, "Codex"));
    write(`agents/${role.id}/CLAUDE.md`, "config", divisionRuntimeGuide(profile, role.role, role.name, "Claude Code"));
    write(`agents/${role.id}/GEMINI.md`, "config", divisionRuntimeGuide(profile, role.role, role.name, "Gemini"));
    for (const specialist of role.specialists) {
      write(
        `agents/${role.id}/${specialist.id}.md`,
        "prompt",
        specialistPrompt(profile, role.role, specialist.role, specialist.name),
      );
    }
  }

  write(
    "agentlas.team.json",
    "config",
    JSON.stringify(
      {
        kind: "agentlas-generated-team",
        name: profile.name,
        slug: profile.slug,
        category: profile.category,
        audience: profile.audience,
        createdAt,
        sourceSurfaceId: input.surfaceId ?? null,
        roles: TEAM_ROLES,
        compatibility: {
          agentlasOs: true,
          codex: "AGENTS.md",
          claudeCode: "CLAUDE.md and .claude/CLAUDE.md",
          gemini: "GEMINI.md",
          importLabels: ["generic", "codex", "claude-code", "gemini"],
        },
      },
      null,
      2,
    ),
  );

  return files;
}

function upsertTeamAgent(rootPath: string, profile: TeamProfile, createdAt: string): InstalledAgent {
  const db = getDb();
  const existing = db.prepare("SELECT id, tone, installed_at FROM installed_agents WHERE slug = ?").get(profile.slug) as
    | { id: string; tone: InstalledAgent["tone"]; installed_at: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const tone = existing?.tone ?? "green";
  const systemPrompt = ceoPrompt(profile, rootPath);
  if (existing) {
    db.prepare(
      `UPDATE installed_agents
       SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ?, trust_grade = 'A',
           visibility = 'visible'
       WHERE id = ?`,
    ).run(profile.name, profile.name, profile.tagline, profile.tagline, systemPrompt, id);
  } else {
    db.prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible')`,
    ).run(id, profile.slug, profile.name, profile.name, profile.tagline, profile.tagline, systemPrompt, "[]", "[]", null, "A", createdAt, tone);
  }
  return {
    id,
    slug: profile.slug,
    name: profile.name,
    nameEn: profile.name,
    tagline: profile.tagline,
    taglineEn: profile.tagline,
    systemPrompt,
    mcpServers: [],
    envRequirements: [],
    preferredBackend: null,
    trustGrade: "A",
    installedAt: existing?.installed_at ?? createdAt,
    tone,
    runtimeLabel: "generic",
    localPath: rootPath,
    kind: "team",
    visibility: "visible",
  };
}

function upsertTeamMemberAgents(rootPath: string, profile: TeamProfile, createdAt: string): Map<string, TeamMemberAgent> {
  const members = new Map<string, TeamMemberAgent>();
  for (const role of TEAM_ROLES) {
    const divisionSlug = `${profile.slug}-${role.id}`;
    const divisionPath = path.join(rootPath, "agents", role.id);
    const divisionAgent = upsertGeneratedAgent({
      slug: divisionSlug,
      name: role.name,
      tagline: `${role.role} for ${profile.category} commerce.`,
      systemPrompt: divisionPrompt(profile, role.role, role.name),
      localPath: divisionPath,
      createdAt,
      tone: "blue",
      visibility: "background",
    });
    members.set(divisionSlug, { slug: divisionSlug, localPath: divisionPath, agent: divisionAgent });
    for (const specialist of role.specialists) {
      const specialistSlug = `${divisionSlug}-${specialist.id}`;
      const specialistPath = path.join(rootPath, "agents", role.id);
      const specialistAgent = upsertGeneratedAgent({
        slug: specialistSlug,
        name: specialist.name,
        tagline: `${specialist.role} for ${profile.category} commerce.`,
        systemPrompt: specialistPrompt(profile, role.role, specialist.role, specialist.name),
        localPath: specialistPath,
        createdAt,
        tone: "peach",
        visibility: "background",
      });
      members.set(specialistSlug, { slug: specialistSlug, localPath: specialistPath, agent: specialistAgent });
    }
  }
  return members;
}

function upsertGeneratedAgent(input: {
  slug: string;
  name: string;
  tagline: string;
  systemPrompt: string;
  localPath: string;
  createdAt: string;
  tone: InstalledAgent["tone"];
  visibility: InstalledAgent["visibility"];
}): InstalledAgent {
  const db = getDb();
  const existing = db.prepare("SELECT id, tone, installed_at FROM installed_agents WHERE slug = ?").get(input.slug) as
    | { id: string; tone: InstalledAgent["tone"]; installed_at: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const tone = existing?.tone ?? input.tone;
  if (existing) {
    db.prepare(
      `UPDATE installed_agents
       SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ?, trust_grade = 'A',
           visibility = ?
       WHERE id = ?`,
    ).run(input.name, input.name, input.tagline, input.tagline, input.systemPrompt, input.visibility, id);
  } else {
    db.prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.slug,
      input.name,
      input.name,
      input.tagline,
      input.tagline,
      input.systemPrompt,
      "[]",
      "[]",
      null,
      "A",
      input.createdAt,
      tone,
      input.visibility,
    );
  }
  return {
    id,
    slug: input.slug,
    name: input.name,
    nameEn: input.name,
    tagline: input.tagline,
    taglineEn: input.tagline,
    systemPrompt: input.systemPrompt,
    mcpServers: [],
    envRequirements: [],
    preferredBackend: null,
    trustGrade: "A",
    installedAt: existing?.installed_at ?? input.createdAt,
    tone,
    runtimeLabel: "generic",
    localPath: input.localPath,
    kind: "agent",
    visibility: input.visibility,
  };
}

function buildOrgChart(
  slug: string,
  agentId: string,
  members: Map<string, TeamMemberAgent>,
): Array<FirmOrgNode & { agentId: string }> {
  const chart: Array<FirmOrgNode & { agentId: string }> = [{ agentSlug: slug, agentId, role: "CEO", reportsTo: null }];
  for (const role of TEAM_ROLES) {
    const divisionSlug = `${slug}-${role.id}`;
    chart.push({ agentSlug: divisionSlug, agentId: members.get(divisionSlug)?.agent.id ?? "", role: role.role, reportsTo: slug });
    for (const specialist of role.specialists) {
      const specialistSlug = `${divisionSlug}-${specialist.id}`;
      chart.push({
        agentSlug: specialistSlug,
        agentId: members.get(specialistSlug)?.agent.id ?? "",
        role: specialist.role,
        reportsTo: divisionSlug,
      });
    }
  }
  return chart;
}

function buildResolvedOrg(
  agent: InstalledAgent,
  rootPath: string,
  profile: TeamProfile,
  createdAt: string,
  members: Map<string, TeamMemberAgent>,
): ResolvedOrg {
  const divisions: ResolvedDivision[] = TEAM_ROLES.map((role) => ({
    id: role.id,
    name: role.name,
    role: role.role,
    agentId: members.get(`${profile.slug}-${role.id}`)?.agent.id,
    promptFileRef: `agents/${role.id}/AGENT.md`,
    prompt: divisionPrompt(profile, role.role, role.name),
    specialists: role.specialists.map((specialist) => ({
      id: specialist.id,
      name: specialist.name,
      role: specialist.role,
      agentId: members.get(`${profile.slug}-${role.id}-${specialist.id}`)?.agent.id,
      promptFileRef: `agents/${role.id}/${specialist.id}.md`,
      prompt: specialistPrompt(profile, role.role, specialist.role, specialist.name),
    })),
  }));
  return {
    source: "resolver",
    ceo: { id: agent.id, name: agent.name, role: "CEO", agentId: agent.id, prompt: agent.systemPrompt },
    divisions,
    sourcePath: rootPath,
    resolvedAt: createdAt,
  };
}

function profileFromManifest(manifest: MetaAgentTeamFactoryRequest["manifest"]): TeamProfile {
  const brief = objectValue(manifest.data.brief?.value);
  const category = stringValue(brief?.category) || stringValue(brief?.business) || manifest.domain || "commerce";
  const name = `${toTitle(category)} Agent Team`;
  return {
    name,
    slug: `local-${slugify(category)}-commerce-team`,
    category,
    audience: stringValue(brief?.audience) || manifest.app?.audience || "Online commerce operators",
    tagline: `Local Agentlas team for launching and operating ${category} commerce.`,
  };
}

function teamOverview(profile: TeamProfile, input: MetaAgentTeamFactoryRequest, createdAt: string): string {
  return [
    `# ${profile.name}`,
    "",
    profile.tagline,
    "",
    `Created: ${createdAt}`,
    `Source surface: ${input.surfaceId ?? "not linked"}`,
    "",
    "## What This Package Is",
    "",
    "A portable Agentlas OS team package. Agentlas can install it as a generated firm, while Codex, Claude Code, Gemini, and other local LLM apps can read the same folder without needing the Agentlas renderer.",
    "",
    "## Runtime Entrypoints",
    "",
    "- Agentlas OS: `agentlas.team.json`, installed firm registry, generated app/tool records.",
    "- Codex: `AGENTS.md`.",
    "- Claude Code: `CLAUDE.md` or `.claude/CLAUDE.md`.",
    "- Gemini: `GEMINI.md`.",
    "- Human operators: this `TEAM.md` and the per-division files under `agents/`.",
    "",
    "## Operating Rule",
    "",
    "This team is optimized for Agentlas OS. It may create surfaces, apps, tools, MCP plans, browser delegation steps, vault requests, and payment approvals. It must never store passwords, tokens, cookies, card numbers, CVV/CVC, or OTP values in prompts, manifests, files, logs, or approval metadata.",
    "",
    "## Divisions",
    "",
    ...TEAM_ROLES.map((role) => `- ${role.role}: ${role.name}`),
  ].join("\n");
}

function runtimeGuide(
  profile: TeamProfile,
  rootPath: string,
  input: MetaAgentTeamFactoryRequest,
  runtimeName: string,
  createdAt: string,
): string {
  return [
    `# ${profile.name} - ${runtimeName} Runtime Guide`,
    "",
    `TEAM ROOT: ${rootPath}`,
    `CREATED: ${createdAt}`,
    `SOURCE SURFACE: ${input.surfaceId ?? "not linked"}`,
    "",
    `Use this file when ${runtimeName} opens the generated team outside Agentlas Desktop.`,
    "",
    "## Mission",
    "",
    ceoPrompt(profile, rootPath),
    "",
    "## Agentlas OS Compatibility Contract",
    "",
    "- Prefer declarative Surface Manifests, `agentlas.team.json`, and generated app/tool ledgers over freeform prose.",
    "- If you create or update files, MCPs, provider state, or deployment artifacts, write a reversible lifecycle note and leave evidence.",
    "- If a provider API/MCP is absent, continue through browser delegation, an alternate provider, a generated local helper, or a local fallback.",
    "- Ask for login, signup, OTP, legal identity, CAPTCHA, and card entry only in provider pages or secure Agentlas UI.",
    "- Store API keys and OAuth outputs through Agentlas vault or the host runtime's secret store; generated files may contain only presence/fingerprint/status.",
    "- Mark factual and numeric claims as verified, claimed, estimated, or unverified.",
    "",
    "## Portable Layout",
    "",
    "- `agents/ceo/AGENT.md`: CEO brain.",
    "- `agents/storefront/AGENT.md`: storefront division.",
    "- `agents/catalog/AGENT.md`: catalog and image division.",
    "- `agents/payments-data/AGENT.md`: payment, database, credential, and provider setup division.",
    "- `agents/operations/AGENT.md`: order, fulfillment, support, and dashboard division.",
    "- `agentlas.team.json`: machine-readable team manifest.",
  ].join("\n");
}

function ceoRuntimeGuide(profile: TeamProfile, rootPath: string, runtimeName: string): string {
  return [
    `# ${profile.name} CEO - ${runtimeName}`,
    "",
    ceoPrompt(profile, rootPath),
    "",
    "Route work to the right division, keep the generated app durable, and return structured OS actions or manifest deltas whenever possible.",
  ].join("\n");
}

function divisionRuntimeGuide(profile: TeamProfile, role: string, name: string, runtimeName: string): string {
  return [
    `# ${name} - ${runtimeName}`,
    "",
    divisionPrompt(profile, role, name),
    "",
    "This wrapper exists so Codex, Claude Code, Gemini, and Agentlas importers all detect the division folder as a usable agent. Keep outputs small, typed, evidence-labeled, and safe to merge into the Agentlas OS ledger.",
  ].join("\n");
}

function ceoPrompt(profile: TeamProfile, rootPath: string): string {
  return [
    `You are the CEO of ${profile.name}.`,
    "",
    `TEAM ROOT: ${rootPath}`,
    `DOMAIN: ${profile.category}`,
    `AUDIENCE: ${profile.audience}`,
    "",
    "Mission: turn a user's ecommerce intent into a running Agentlas OS operation: storefront, catalog, payment setup, database setup, Codex/image generation, order desk, and operator dashboard.",
    "",
    "Operating rules:",
    "- Prefer Agentlas Surface manifests and OS actions over plain text.",
    "- Never answer 'API/MCP is unavailable' as a dead end. Use browser delegation, provider console setup, generated local helpers, alternate providers, or a clear secure handoff.",
    "- Ask for passwords, OTPs, legal identity confirmation, and card details only through provider or Agentlas secure UI.",
    "- Before paid checkout, show merchant, amount/currency, recurrence, and purpose, then require explicit approval.",
    "- Mark facts and numbers as verified, claimed, estimated, or unverified. Do not present unsourced revenue, margin, tax, or legal claims as KPI truth.",
    "- Every file/tool/MCP/deploy mutation must be reversible and leave launch proof.",
    "- Capture useful progress screenshots under the system temp directory when running visual tests.",
  ].join("\n");
}

function divisionPrompt(profile: TeamProfile, role: string, name: string): string {
  return [
    `You are ${name}, the ${role} for ${profile.name}.`,
    `Domain: ${profile.category}. Audience: ${profile.audience}.`,
    "Return structured plans, surface deltas, files, or tool specs that the CEO can verify and operate inside Agentlas OS.",
    "Use evidence labels and capability declarations for external calls, PII, payments, credentials, and model generation.",
  ].join("\n");
}

function specialistPrompt(profile: TeamProfile, divisionRole: string, role: string, name: string): string {
  return [
    `You are ${name}, ${role}, reporting to ${divisionRole} in ${profile.name}.`,
    `Focus on ${profile.category} ecommerce execution.`,
    "Produce small, checkable outputs. Do not invent provider state, credentials, prices, or operational facts.",
  ].join("\n");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "commerce"
  );
}

function toTitle(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
