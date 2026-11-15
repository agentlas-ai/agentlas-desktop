import { composeDeclaredPrompt } from "../runtime/prompt-order";
// Local meta-agent factory for Agentlas OS.
// It materializes a domain team as a durable local Agentlas firm without using
// a hosted web API. The generated team is plain markdown/config plus registry
// rows; all real provider credentials/payments still flow through the OS gates.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getProject } from "../store/projects";
import { agentHomeDir, ensureAgentOwnerMarker, classifyAgentFolder, invalidateOwnerIndex, ownerIds } from "../agents/home";
import { getRoute, setRoute } from "../agents/routes";
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
  // 프로젝트·작업 폴더가 있으면 팀은 그 안에(사용자의 폴더). 없으면 한 에이전트 = 한 폴더로 에이전트 루트(`~/.agentlas/agents/<이름>`)에 태어난다.
  const workspace = input.baseDir || getChatWorkingFolder(chat.id) || project?.folderPath || null;
  const profile = profileFromManifest(input.manifest);
  const existing = existingTeamAgent(profile.slug);
  const teamId = existing?.id ?? randomUUID();
  const rootPath = workspace
    ? path.join(workspace, ".agentlas", "generated-teams", profile.slug)
    : appTeamFolder({ id: teamId, slug: profile.slug });
  // 이 호출이 에이전트 루트에 새로 만드는 폴더인가(이미 있던 팀 폴더·사용자의 프로젝트 폴더는 아니다): 파일을 쓰다 실패하면 이 폴더만 치운다.
  const born = !workspace && !fs.existsSync(rootPath);
  fs.mkdirSync(rootPath, { recursive: true });
  if (!workspace) {
    const placed = classifyAgentFolder(rootPath);
    if (placed.owner === "app" && placed.appRoot === "agent-home") ensureAgentOwnerMarker(placed.unit, teamId);
  }

  const createdAt = new Date().toISOString();
  let files: MetaAgentTeamFactoryFile[];
  try {
    files = writeTeamFiles(rootPath, profile, input, createdAt);
  } catch (error) {
    // 소유 표식은 행을 쓰기 전에 만들어져 있다: 실패한 채 두면 행 없는 id 의 표식을 가진 고아 폴더가 쌓이고 다시 만들 때 `-id6` 이름이 생긴다(감사 35-10). 행·라우트는 아직 없다.
    if (born) removeBornTeamFolder(rootPath, teamId);
    throw error;
  }
  const agent = upsertTeamAgent(rootPath, profile, createdAt, teamId, existing);
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

/** 이 실행이 방금 만든 팀 폴더를 정확한 경로로 지운다: 링크가 아니고, 앱 소유 폴더이고, 소유 표식이 이 id 이고, 단위 폴더 자체일 때만. 던지지 않는다. */
function removeBornTeamFolder(rootPath: string, teamId: string): void {
  try {
    const placed = classifyAgentFolder(rootPath);
    if (placed.owner !== "app" || placed.appRoot !== "agent-home" || placed.nested || path.resolve(placed.unit) !== path.resolve(rootPath)) return;
    if (fs.lstatSync(rootPath).isSymbolicLink()) return;
    const owners = ownerIds(rootPath);
    if (owners.length !== 1 || owners[0] !== teamId) return;
    fs.rmSync(rootPath, { recursive: true, force: true });
    invalidateOwnerIndex();
  } catch { /* a left-over folder with its own marker is found again by the next create */ }
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

  write("agentlas.json", "config", JSON.stringify({ schemaVersion: "1.0", entry: "agents/ceo/AGENT.md" }, null, 2));
  write("TEAM.md", "doc", teamOverview(profile, input, createdAt));
  write("README.md", "doc", teamOverview(profile, input, createdAt));

  write(
    "AGENTS.md",
    "config",
    runtimeGuide(profile, input, "Codex", createdAt),
  );
  write("CLAUDE.md", "config", runtimeGuide(profile, input, "Claude Code", createdAt));
  write(path.join(".claude", "CLAUDE.md"), "config", runtimeGuide(profile, input, "Claude Code", createdAt));
  write("GEMINI.md", "config", runtimeGuide(profile, input, "Gemini", createdAt));

  write("agents/ceo/agentlas.json", "config", JSON.stringify({ schemaVersion: "1.0", entry: "AGENT.md" }, null, 2));
  write("agents/ceo/AGENT.md", "prompt", ceoPrompt(profile));
  write("agents/ceo/AGENTS.md", "config", ceoRuntimeGuide(profile, "Codex"));
  write("agents/ceo/CLAUDE.md", "config", ceoRuntimeGuide(profile, "Claude Code"));
  write("agents/ceo/GEMINI.md", "config", ceoRuntimeGuide(profile, "Gemini"));
  for (const role of TEAM_ROLES) {
    write(`agents/${role.id}/agentlas.json`, "config", JSON.stringify({ schemaVersion: "1.0", entry: "AGENT.md" }, null, 2));
    write(`agents/${role.id}/AGENT.md`, "prompt", divisionPrompt(profile, role.role, role.name));
    write(`agents/${role.id}/AGENTS.md`, "config", divisionRuntimeGuide(profile, role.role, role.name, "Codex"));
    write(`agents/${role.id}/CLAUDE.md`, "config", divisionRuntimeGuide(profile, role.role, role.name, "Claude Code"));
    write(`agents/${role.id}/GEMINI.md`, "config", divisionRuntimeGuide(profile, role.role, role.name, "Gemini"));
    for (const specialist of role.specialists) {
      const relative = `agents/${role.id}/specialists/${specialist.id}`;
      write(`${relative}/agentlas.json`, "config", JSON.stringify({ schemaVersion: "1.0", entry: "AGENT.md" }, null, 2));
      write(`${relative}/AGENT.md`, "prompt", specialistPrompt(profile, role.role, specialist.role, specialist.name));
      for (const adapter of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) write(`${relative}/${adapter}`, "config", composeDeclaredPrompt([{ id: "commerce.specialist.adapter-policy", stability: "fixed-policy", changeTriggers: ["release"], text: "Read AGENT.md in this folder with the runtime file reader before work; it is the canonical role contract." }, { id: "commerce.specialist.adapter-profile", stability: "configuration", changeTriggers: ["owner-profile"], text: `# ${specialist.name}` }]) + "\n");
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

interface ExistingTeamAgent { id: string; tone: InstalledAgent["tone"]; installed_at: string }

function existingTeamAgent(slug: string): ExistingTeamAgent | undefined {
  return getDb().prepare("SELECT id, tone, installed_at FROM installed_agents WHERE slug = ?").get(slug) as ExistingTeamAgent | undefined;
}

/** 같은 팀을 다시 만들면 이미 있는 앱 폴더를 그대로 쓴다(둘로 갈리지 않게). 없으면 에이전트 루트 안의 새 폴더 — 이미 다른 폴더가 쓰는 이름이면 `-id6`. */
function appTeamFolder(row: { id: string; slug: string }): string {
  const route = getRoute(row.id);
  if (route?.path && fs.existsSync(route.path) && classifyAgentFolder(route.path).owner === "app") return route.path;
  return agentHomeDir(row, null);
}

function upsertTeamAgent(rootPath: string, profile: TeamProfile, createdAt: string, id: string, existing: ExistingTeamAgent | undefined): InstalledAgent {
  const db = getDb();
  const tone = existing?.tone ?? "green";
  const systemPrompt = ceoPrompt(profile);
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
      const specialistPath = path.join(rootPath, "agents", role.id, "specialists", specialist.id);
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
    "portable Agentlas OS team package; installs as a generated firm; Codex, Claude Code, Gemini, other local LLM apps read the same folder",
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
    "may create: surfaces, apps, tools, MCP plans, browser delegation steps, vault requests, payment approvals; never store passwords, tokens, cookies, card numbers, CVV/CVC, OTP in prompts, manifests, files, logs, approval metadata",
    "",
    "## Divisions",
    "",
    ...TEAM_ROLES.map((role) => `- ${role.role}: ${role.name}`),
  ].join("\n");
}

/** One shared semantic core in each canonical role prompt, not repeated in adapters. */
const COMMERCE_ROLE_CORE = `Owner/runtime authorization governs payments and all actions; no added cap/wait. Use OS manifests. Connector recovery: only for requested operations that need a missing connector; reuse existing authorized authentication first, then authorized browser/console/local/alternate paths. Supplied-receipt reports need no service setup or operational declarations. Secrets only secure UI/Vault. Label verified/claimed/estimated/unverified; prove effects. Retain files/screenshots, rollback/launch checks permanently. Return upward; Curator owns durable writes.`;

function runtimeGuide(profile: TeamProfile, input: MetaAgentTeamFactoryRequest, runtimeName: string, createdAt: string): string {
  return composeDeclaredPrompt([
    { id: "commerce.adapter.reader-policy", stability: "fixed-policy", changeTriggers: ["release"], text: "Read agents/ceo/AGENT.md with the runtime file reader before work. agentlas.json declares this same canonical entry for Agentlas hosts; no second policy copy lives here.\n\nRead agentlas.team.json for roster/layout; division entries live at agents/<division>/AGENT.md and specialist entries at agents/<division>/specialists/<id>/AGENT.md. Return manifests, files, evidence and blockers to the CEO." },
    { id: "commerce.adapter.profile", stability: "configuration", changeTriggers: ["owner-profile", "runtime"], text: `# ${profile.name} - ${runtimeName}` },
    { id: "commerce.adapter.source", stability: "task-context", changeTriggers: ["task"], text: `created: ${createdAt}; source: ${input.surfaceId ?? "not linked"}` },
  ]);
}
function ceoRuntimeGuide(profile: TeamProfile, runtimeName: string): string {
  return composeDeclaredPrompt([
    { id: "commerce.ceo.adapter.reader-policy", stability: "fixed-policy", changeTriggers: ["release"], text: "Read AGENT.md in this folder with the runtime file reader before work; agentlas.json declares that canonical entry. Route typed briefs to divisions and verify their returned results." },
    { id: "commerce.ceo.adapter.profile", stability: "configuration", changeTriggers: ["owner-profile", "runtime"], text: `# ${profile.name} CEO - ${runtimeName}` },
  ]);
}
function divisionRuntimeGuide(profile: TeamProfile, role: string, name: string, runtimeName: string): string {
  return composeDeclaredPrompt([
    { id: "commerce.division.adapter.reader-policy", stability: "fixed-policy", changeTriggers: ["release"], text: "Read AGENT.md in this folder with the runtime file reader before work; agentlas.json declares that canonical entry. Return small typed evidence/results to the CEO." },
    { id: "commerce.division.adapter.profile", stability: "configuration", changeTriggers: ["owner-profile", "runtime"], text: `# ${name} - ${runtimeName}\n\n${role} of ${profile.name}.` },
  ]);
}
function ceoPrompt(profile: TeamProfile): string {
  return composeDeclaredPrompt([
    { id: "commerce.ceo.mission", stability: "fixed-policy", changeTriggers: ["release"], order: 0, text: "Deliver a running commerce operation: storefront/catalog, verified image capability, payments/database, order desk and dashboard. Assign divisions and merge checkable Surface/OS deltas." },
    { id: "commerce.role.core", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], order: 10, text: COMMERCE_ROLE_CORE },
    { id: "commerce.ceo.receipt", stability: "fixed-policy", changeTriggers: ["release"], order: 20, text: "Payment receipts: merchant, amount/currency, recurrence and purpose." },
    { id: "commerce.ceo.profile-root", stability: "task-context", changeTriggers: ["owner-profile", "task"], text: `CEO of ${profile.name}; ${profile.category}; audience: ${profile.audience}` },
  ], "\n");
}
function divisionPrompt(profile: TeamProfile, role: string, name: string): string {
  return composeDeclaredPrompt([
    { id: "commerce.division.mission", stability: "fixed-policy", changeTriggers: ["release"], order: 0, text: "Return structured plans, surface deltas, files or tool specs the CEO can verify and operate." },
    { id: "commerce.role.core", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], order: 10, text: COMMERCE_ROLE_CORE },
    { id: "commerce.division.profile", stability: "configuration", changeTriggers: ["owner-profile"], text: `${name}: ${role} of ${profile.name}; ${profile.category}; audience: ${profile.audience}` },
  ], "\n");
}
function specialistPrompt(profile: TeamProfile, divisionRole: string, role: string, name: string): string {
  return composeDeclaredPrompt([
    { id: "commerce.specialist.mission", stability: "fixed-policy", changeTriggers: ["release"], order: 0, text: "Return a small checkable result within your specialist scope; never invent provider state, prices or operational facts." },
    { id: "commerce.role.core", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], order: 10, text: COMMERCE_ROLE_CORE },
    { id: "commerce.specialist.profile", stability: "configuration", changeTriggers: ["owner-profile"], text: `${name}: ${role}, reports to ${divisionRole} in ${profile.name}; ${profile.category} commerce.` },
  ], "\n");
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
