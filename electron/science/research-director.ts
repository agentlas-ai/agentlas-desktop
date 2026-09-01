import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RESEARCH_DIRECTOR_PLUGIN_VERSION,
  RESEARCH_DIRECTOR_SYSTEM_PROMPT_SHA256,
  SCIENCE_RESEARCH_DIRECTOR_SLUG,
  builtinAgentId,
} from "../architecture/manifest";
import {
  agentFolderPath,
  buildEffectiveAgentSystemPrompt,
  materializeAgentFiles,
} from "../agents/files";
import { getDb } from "../store/db";
import { evictRuntimeSessionsForChat } from "../store/runtime-sessions";

const PLUGIN_SCHEMA = "agentlas.plugin/v2";
const INSTALL_SCHEMA = "agentlas.plugin-install/v1";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PROMPT_ASSET_BYTES = 256 * 1024;

export const SCIENCE_RESEARCH_DIRECTOR_AGENT_ID = builtinAgentId(SCIENCE_RESEARCH_DIRECTOR_SLUG);

export interface ResearchDirectorRuntimeBinding {
  agentId: string;
  agentSlug: string;
  packageVersion: string;
  packageDigest: string;
  systemPrompt: string;
  systemPromptSha256: string;
}

export interface ScienceResearchDirectorRuntime {
  bind(input: {
    runtimeChatId: string;
    conversationId: string;
  }): ResearchDirectorRuntimeBinding;
}

interface ResearchDirectorPluginManifest {
  schema?: unknown;
  slug?: unknown;
  version?: unknown;
  builtin?: unknown;
  provides?: {
    skills?: {
      workflows?: unknown;
    };
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function lstatRequired(target: string, kind: "file" | "directory"): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw new Error(`science-research-director-${kind}-missing`);
  }
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`science-research-director-${kind}-invalid`);
  }
  return stat;
}

function readExactUtf8(root: string, relative: string, maximum: number): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("science-research-director-package-path-invalid");
  }
  const stat = lstatRequired(target, "file");
  if (stat.size <= 0 || stat.size > maximum) {
    throw new Error("science-research-director-package-asset-size-invalid");
  }
  const bytes = fs.readFileSync(target);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("science-research-director-package-asset-utf8-invalid");
  }
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function isHostOwnedPluginEntry(name: string): boolean {
  return name === ".state" || name === ".install.json";
}

/** Exact counterpart of the built-in materializer's release digest. */
export function researchDirectorReleaseDigest(root: string): string {
  lstatRequired(root, "directory");
  const hash = createHash("sha256");
  const visit = (directory: string, relativeDirectory: string, topLevel: boolean): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (topLevel && isHostOwnedPluginEntry(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("science-research-director-package-symlink");
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        visit(absolute, relative, false);
      } else if (stat.isFile()) {
        hash.update(`F\0${relative}\0${stat.size}\0${stat.mode & 0o777}\0`);
        hash.update(fs.readFileSync(absolute));
      } else {
        throw new Error("science-research-director-package-entry-invalid");
      }
    }
  };
  visit(root, "", true);
  return `sha256:${hash.digest("hex")}`;
}

export function composeResearchDirectorSystemPrompt(agentContract: string, directStudySkill: string): string {
  return [
    "# Agentlas Science built-in Research Director runtime",
    "",
    "This is the exact package-owned identity and workflow for every Agentlas Science turn.",
    "The user message is not a plugin mention and must not be treated as routing metadata.",
    "",
    "<research-director-agent-contract>",
    agentContract.trim(),
    "</research-director-agent-contract>",
    "",
    "<research-director-direct-study-workflow>",
    directStudySkill.trim(),
    "</research-director-direct-study-workflow>",
  ].join("\n");
}

function defaultInstalledPluginRoot(): string {
  return path.join(os.homedir(), ".agentlas", "plugins", SCIENCE_RESEARCH_DIRECTOR_SLUG);
}

export function loadResearchDirectorRuntimeBinding(
  pluginRoot = defaultInstalledPluginRoot(),
): ResearchDirectorRuntimeBinding {
  lstatRequired(pluginRoot, "directory");
  const manifest = JSON.parse(readExactUtf8(pluginRoot, "plugin.json", MAX_MANIFEST_BYTES)) as ResearchDirectorPluginManifest;
  const workflows = manifest.provides?.skills?.workflows;
  if (
    manifest.schema !== PLUGIN_SCHEMA
    || manifest.slug !== SCIENCE_RESEARCH_DIRECTOR_SLUG
    || manifest.version !== RESEARCH_DIRECTOR_PLUGIN_VERSION
    || manifest.builtin !== true
    || !Array.isArray(workflows)
    || !workflows.includes("direct-study")
  ) {
    throw new Error("science-research-director-package-identity-invalid");
  }

  const packageDigest = researchDirectorReleaseDigest(pluginRoot);
  const install = JSON.parse(readExactUtf8(pluginRoot, ".install.json", MAX_MANIFEST_BYTES)) as Record<string, unknown>;
  if (
    install.schema !== INSTALL_SCHEMA
    || install.slug !== SCIENCE_RESEARCH_DIRECTOR_SLUG
    || install.version !== RESEARCH_DIRECTOR_PLUGIN_VERSION
    || install.digest !== packageDigest
  ) {
    throw new Error("science-research-director-package-integrity-failed");
  }

  const agentContract = readExactUtf8(pluginRoot, "agent/agent.md", MAX_PROMPT_ASSET_BYTES);
  const directStudySkill = readExactUtf8(pluginRoot, "skills/direct-study/SKILL.md", MAX_PROMPT_ASSET_BYTES);
  const systemPrompt = composeResearchDirectorSystemPrompt(agentContract, directStudySkill);
  const systemPromptSha256 = sha256(systemPrompt);
  if (systemPromptSha256 !== RESEARCH_DIRECTOR_SYSTEM_PROMPT_SHA256) {
    throw new Error("science-research-director-prompt-integrity-failed");
  }
  return {
    agentId: SCIENCE_RESEARCH_DIRECTOR_AGENT_ID,
    agentSlug: SCIENCE_RESEARCH_DIRECTOR_SLUG,
    packageVersion: RESEARCH_DIRECTOR_PLUGIN_VERSION,
    packageDigest,
    systemPrompt,
    systemPromptSha256,
  };
}

function writeExactBuiltinPrompt(systemPrompt: string): void {
  materializeAgentFiles(SCIENCE_RESEARCH_DIRECTOR_AGENT_ID);
  const directory = agentFolderPath(SCIENCE_RESEARCH_DIRECTOR_SLUG);
  lstatRequired(directory, "directory");
  const destination = path.join(directory, "system-prompt.md");
  try {
    const existing = fs.lstatSync(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("science-research-director-agent-prompt-path-invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.system-prompt.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, systemPrompt, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename consumed it */ }
  }
  if (buildEffectiveAgentSystemPrompt(SCIENCE_RESEARCH_DIRECTOR_AGENT_ID, "") !== systemPrompt) {
    throw new Error("science-research-director-effective-prompt-mismatch");
  }
}

export function bindResearchDirectorToScienceRuntimeChat(input: {
  runtimeChatId: string;
  conversationId: string;
  pluginRoot?: string;
}): ResearchDirectorRuntimeBinding {
  const binding = loadResearchDirectorRuntimeBinding(input.pluginRoot);
  const db = getDb();
  const agent = db.prepare(
    `SELECT id, slug, builtin, visibility
       FROM installed_agents
      WHERE id = ? OR slug = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END`,
  ).all(binding.agentId, binding.agentSlug, binding.agentId) as Array<{
    id: string;
    slug: string;
    builtin: number;
    visibility: string | null;
  }>;
  if (
    agent.length !== 1
    || agent[0].id !== binding.agentId
    || agent[0].slug !== binding.agentSlug
    || agent[0].builtin !== 1
    || agent[0].visibility !== "background"
  ) {
    throw new Error("science-research-director-builtin-identity-unavailable");
  }

  const chat = db.prepare(
    "SELECT id, agent_id, firm_id, title, kind, origin_surface FROM chats WHERE id = ?",
  ).get(input.runtimeChatId) as {
    id: string;
    agent_id: string;
    firm_id: string | null;
    title: string;
    kind: string | null;
    origin_surface: string | null;
  } | undefined;
  if (
    !chat
    || chat.title !== `⟦science⟧${input.conversationId}`
    || chat.kind !== "division"
    || chat.origin_surface !== "work"
  ) {
    throw new Error("science-research-director-runtime-chat-invalid");
  }

  writeExactBuiltinPrompt(binding.systemPrompt);
  const changed = db.transaction(() => {
    const agentUpdate = db.prepare(
      `UPDATE installed_agents
          SET system_prompt = ?
        WHERE id = ? AND slug = ? AND builtin = 1 AND visibility = 'background'`,
    ).run(binding.systemPrompt, binding.agentId, binding.agentSlug);
    if (agentUpdate.changes !== 1) throw new Error("science-research-director-builtin-update-failed");
    const chatUpdate = db.prepare(
      `UPDATE chats
          SET agent_id = ?, firm_id = NULL
        WHERE id = ? AND title = ? AND kind = 'division' AND origin_surface = 'work'`,
    ).run(binding.agentId, input.runtimeChatId, `⟦science⟧${input.conversationId}`);
    if (chatUpdate.changes !== 1) throw new Error("science-research-director-chat-bind-failed");
    db.prepare("DELETE FROM chat_runtime_sessions WHERE chat_id = ?").run(input.runtimeChatId);
    return chat.agent_id !== binding.agentId || chat.firm_id !== null;
  })();
  evictRuntimeSessionsForChat(input.runtimeChatId);

  const exact = db.prepare(
    `SELECT a.system_prompt AS systemPrompt, c.agent_id AS agentId, c.firm_id AS firmId
       FROM chats c JOIN installed_agents a ON a.id = c.agent_id
      WHERE c.id = ?`,
  ).get(input.runtimeChatId) as { systemPrompt?: unknown; agentId?: unknown; firmId?: unknown } | undefined;
  if (
    exact?.agentId !== binding.agentId
    || exact.firmId !== null
    || exact.systemPrompt !== binding.systemPrompt
    || buildEffectiveAgentSystemPrompt(binding.agentId, "") !== binding.systemPrompt
  ) {
    throw new Error("science-research-director-runtime-binding-mismatch");
  }
  void changed;
  return binding;
}

export const scienceResearchDirectorRuntime: ScienceResearchDirectorRuntime = {
  bind: ({ runtimeChatId, conversationId }) => bindResearchDirectorToScienceRuntimeChat({
    runtimeChatId,
    conversationId,
  }),
};
