// Generates cli/architecture.data.json from the COMPILED architecture manifest.
// The CLI (CommonJS, shipped raw) can't import the TS manifest, so it reads this JSON.
// Run after `tsc -p electron/tsconfig.json` — wired into build:electron + package-mac.sh.
import { createRequire } from "node:module";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "dist/electron/architecture/manifest.js");

if (!existsSync(manifestPath)) {
  console.error(
    `[gen-cli-architecture] compiled manifest not found at ${manifestPath}\n` +
      "Run `tsc -p electron/tsconfig.json` first.",
  );
  process.exit(1);
}

const m = require(manifestPath);

const data = {
  version: m.ARCHITECTURE_VERSION,
  emitterBlock: m.MEMORY_EMITTER_BLOCK,
  eventsHeading: m.MEMORY_EVENTS_HEADING,
  memoryDir: m.PROJECT_MEMORY_DIR,
  soulFile: m.PROJECT_SOUL_FILE,
  sitemapFile: m.SITEMAP_FILE,
  logFile: m.MEMORY_LOG_FILE,
  skillRegistryFile: m.SKILL_REGISTRY_FILE,
  skillTrialsFile: m.SKILL_TRIALS_FILE,
  curatorDecisionsFile: m.CURATOR_DECISIONS_FILE,
  superOntologyContractFile: m.SUPER_ONTOLOGY_CONTRACT_FILE,
  superOntologyReplaysFile: m.SUPER_ONTOLOGY_REPLAYS_FILE,
  superOntologyEvidenceFile: m.SUPER_ONTOLOGY_EVIDENCE_FILE,
  superOntologyMemoryBridgeFile: m.SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
  kinds: m.MEMORY_KINDS,
  scopes: m.MEMORY_SCOPES,
  agents: m.BUILTIN_AGENTS.map((a) => ({
    id: m.builtinAgentId(a.slug),
    slug: a.slug,
    name: a.name,
    nameEn: a.nameEn,
    tagline: a.tagline,
    taglineEn: a.taglineEn,
    role: a.role,
    visibility: a.visibility,
    tone: a.tone,
    systemPrompt: a.systemPrompt,
  })),
};

const outPath = path.join(root, "cli/architecture.data.json");
writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(
  `[gen-cli-architecture] wrote ${outPath} (v${data.version}, ${data.agents.length} agents)`,
);
