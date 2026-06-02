// Per-project memory artifacts inside the user's working folder:
//   <folder>/.agentlas/project-soul-memory.md  — human-readable durable memory (PM Soul)
//   <folder>/.agentlas/sitemap.json            — AI Sitemap (Task Bias governance)
//   <folder>/.agentlas/memory-log.jsonl        — append-only curated event log
//
// These are intentionally plain files: portable, diff-able, and visible to the user.
import fs from "node:fs";
import path from "node:path";
import {
  MEMORY_MAP_FILE,
  MEMORY_LOG_FILE,
  MEMORY_TICKETS_FILE,
  PROJECT_MEMORY_DIR,
  PROJECT_SOUL_FILE,
  SITEMAP_FILE,
  VAULT_REFERENCES_FILE,
} from "../architecture/manifest";

export function projectMemoryDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_MEMORY_DIR);
}

const AUTO_SECTION = "## Auto-curated memory";

function soulTemplate(projectName: string): string {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by the Agentlas PM Soul.
Keep it concise. Auto-curated items are appended under the last section.

## Project Purpose

## Current State

## Decisions

| Date | Decision | Rationale | Evidence |
|------|----------|-----------|----------|

## Pending Work

| Owner | Workstream | Next Action | Status |
|-------|------------|-------------|--------|

## Risks

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|

## User Preferences

## Lessons Learned

${AUTO_SECTION}
`;
}

function sitemapSkeleton(projectName: string, now: string): string {
  return JSON.stringify(
    {
      project: projectName,
      created_at: now,
      updated_at: now,
      priority_policy:
        "priority = risk_weight*risk + (1 - completion_score) + staleness + blocking_dependencies",
      nodes: [],
    },
    null,
    2,
  );
}

function memoryMapSkeleton(projectPath: string, projectName: string, now: string): string {
  return JSON.stringify(
    {
      version: 1,
      project_id: projectName,
      project_root: projectPath,
      surface: ["desktop", "terminal"],
      updated_at: now,
      scope_roots: {
        user_identity: {
          owner: "user",
          paths: ["~/.agentlas/user/profile.md"],
          indexed_by: [],
          write_policy: "user_only",
          notes: "Agents only receive the subset explicitly injected by Agentlas.",
        },
        team_memory: {
          owner: "memory-curator",
          paths: ["agentlas.sqlite:memory_entries(scope=team_memory)"],
          indexed_by: ["Agentlas runtime memory context"],
          write_policy: "curator_gate",
          notes: "Shared cross-agent procedures, handoff conventions, and safety policy.",
        },
        project: {
          owner: "project-pm-soul",
          paths: [
            `${PROJECT_MEMORY_DIR}/${PROJECT_SOUL_FILE}`,
            `${PROJECT_MEMORY_DIR}/${MEMORY_LOG_FILE}`,
          ],
          indexed_by: ["Agentlas runtime memory context"],
          write_policy: "curator_gate",
          notes: "Project decisions, risks, open loops, evidence, and preferences.",
        },
        agent_repo: {
          owner: "imported-agent-owner",
          paths: ["agentlas.sqlite:memory_entries(scope=agent_repo)"],
          indexed_by: ["Agentlas runtime memory context"],
          write_policy: "curator_gate",
          notes: "Agent-specific durable procedures and failure modes.",
        },
        session: {
          owner: "runtime",
          paths: [
            `${PROJECT_MEMORY_DIR}/${MEMORY_LOG_FILE}`,
            `${PROJECT_MEMORY_DIR}/${MEMORY_TICKETS_FILE}`,
          ],
          indexed_by: [],
          write_policy: "append_only",
          notes: "Ephemeral findings and worker-to-curator ticket audit trail.",
        },
      },
      scope_aliases: {
        agent_team: "team_memory",
      },
      memory_ticket_flow: [
        "worker emits ## Memory Events",
        `runtime wraps events in ${PROJECT_MEMORY_DIR}/${MEMORY_TICKETS_FILE}`,
        "memory-curator validates each candidate independently",
        "curator writes, rejects, defers, or proposes approval",
        `ACK and scoped writes are recorded in ${PROJECT_MEMORY_DIR}/${MEMORY_LOG_FILE}`,
      ],
      request_context_capsule: {
        purpose: "Recall similar future requests without storing raw prompts.",
        fields: [
          "user_intent",
          "trigger_terms",
          "cwd_at_request",
          "target_project",
          "target_path",
          "cross_context",
          "outcome",
        ],
        raw_prompt_policy: "never store raw user messages or full transcripts",
      },
      vault_reference_roots: [
        {
          scope: "project",
          owner: "project-pm-soul",
          paths: [`${PROJECT_MEMORY_DIR}/${VAULT_REFERENCES_FILE}`],
          write_policy: "curator_gate",
          value_policy: "references_only_never_values",
          notes:
            "Credential references live with the project. This file may name locations, never secret values.",
        },
      ],
      exclude_patterns: [
        "._*",
        ".DS_Store",
        ".env*",
        "node_modules/**",
        ".git/**",
        "*.p8",
        "*.p12",
        "*.key",
        "*service-account*.json",
      ],
      last_verified_at: null,
    },
    null,
    2,
  );
}

function vaultReferencesSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      version: 1,
      project_id: projectName,
      owner: "project-pm-soul",
      source_map_ref: `${PROJECT_MEMORY_DIR}/${MEMORY_MAP_FILE}`,
      value_policy: {
        stores_secret_values: false,
        allowed_content: [
          "credential label",
          "non-secret location reference",
          "owner",
          "allowed accessor roles",
          "last verified timestamp",
          "stale-check rule",
          "rotation owner",
          "evidence references",
        ],
        forbidden_content: [
          "token value",
          "private key contents",
          "service-account JSON body",
          ".env value",
          "JWS/JWT/Auth header value",
          "app-specific password value",
        ],
      },
      references: [],
      last_audited_at: null,
    },
    null,
    2,
  );
}

/** Create .agentlas/ + skeleton files if missing. Returns the dir, or null on failure. */
export function ensureProjectMemory(
  projectPath: string,
  projectName?: string,
): string | null {
  try {
    const dir = projectMemoryDir(projectPath);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    const now = new Date().toISOString();

    const soul = path.join(dir, PROJECT_SOUL_FILE);
    if (!fs.existsSync(soul)) fs.writeFileSync(soul, soulTemplate(name), "utf8");

    const sitemap = path.join(dir, SITEMAP_FILE);
    if (!fs.existsSync(sitemap)) fs.writeFileSync(sitemap, sitemapSkeleton(name, now), "utf8");

    const memoryMap = path.join(dir, MEMORY_MAP_FILE);
    if (!fs.existsSync(memoryMap)) {
      fs.writeFileSync(memoryMap, memoryMapSkeleton(projectPath, name, now), "utf8");
    }

    const vaultReferences = path.join(dir, VAULT_REFERENCES_FILE);
    if (!fs.existsSync(vaultReferences)) {
      fs.writeFileSync(vaultReferences, vaultReferencesSkeleton(name), "utf8");
    }

    return dir;
  } catch {
    return null;
  }
}

export function appendMemoryTicket(projectPath: string, ticket: unknown): void {
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    fs.appendFileSync(
      path.join(dir, MEMORY_TICKETS_FILE),
      JSON.stringify(ticket) + "\n",
      "utf8",
    );
  } catch {
    // best-effort
  }
}

export function readProjectSoul(projectPath: string): string | null {
  try {
    return fs.readFileSync(path.join(projectMemoryDir(projectPath), PROJECT_SOUL_FILE), "utf8");
  } catch {
    return null;
  }
}

export function readSitemap(projectPath: string): unknown | null {
  try {
    const raw = fs.readFileSync(path.join(projectMemoryDir(projectPath), SITEMAP_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function appendMemoryLog(projectPath: string, record: unknown): void {
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    fs.appendFileSync(
      path.join(dir, MEMORY_LOG_FILE),
      JSON.stringify(record) + "\n",
      "utf8",
    );
  } catch {
    // best-effort
  }
}

/** Append durable items under the auto-curated section of the soul file. */
export function appendSoulMemory(
  projectPath: string,
  lines: string[],
): void {
  if (lines.length === 0) return;
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    const soulPath = path.join(dir, PROJECT_SOUL_FILE);
    let content = "";
    try {
      content = fs.readFileSync(soulPath, "utf8");
    } catch {
      content = soulTemplate(path.basename(projectPath) || "Project");
    }
    if (!content.includes(AUTO_SECTION)) content += `\n${AUTO_SECTION}\n`;
    const block = lines.map((l) => `- ${l}`).join("\n") + "\n";
    fs.writeFileSync(soulPath, content.replace(/\s*$/, "\n") + block, "utf8");
  } catch {
    // best-effort
  }
}
