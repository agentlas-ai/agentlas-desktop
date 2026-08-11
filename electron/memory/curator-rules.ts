// Pure curator judgment rules — the Desktop executor's half of the shared
// curator ruleset contract (Agentlas-OS system-agents/curator-ruleset.json is
// the canonical data; electron/memory/curator-ruleset.json is this app's
// shipped copy, held equal by the OS-side mirror gate).
//
// This module is deliberately dependency-free (node fs/path/crypto plus the
// pure shared secret patterns) so the conformance gate can require the
// compiled dist file under plain node — importing curator.ts itself would pull
// better-sqlite3's Electron ABI and make the gate unrunnable outside the app.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MemoryKind } from "../architecture/manifest";

export interface CuratorRuleset {
  rulesetVersion?: string;
  patterns?: Record<string, { regex?: string; flags?: string }>;
  kinds?: Record<string, unknown>;
  teamLayerByKind?: { coordination?: string[]; shared?: string[] };
  projectSpecificsGuard?: { minFolderNameChars?: number };
  [key: string]: unknown;
}

// Embedded defaults mirror the canonical file so a broken install fails open
// with identical behaviour; "embedded" in receipts makes that state visible.
const EMBEDDED: CuratorRuleset = {
  rulesetVersion: "embedded",
  teamLayerByKind: { coordination: ["decision", "conflict", "deprecation"], shared: ["fact"] },
  projectSpecificsGuard: { minFolderNameChars: 4 },
  patterns: {
    projectBoundaryPath: {
      regex: "(?:^|\\s)(?:\\/(?:Users|home|var|opt|private)\\/|~\\/|[A-Za-z]:\\\\|file:\\/\\/)",
      flags: "",
    },
  },
};

let cache: { ruleset: CuratorRuleset; sha: string } | null = null;

/** Load the shipped ruleset copy; sha256-16 of the raw bytes goes into receipts. */
export function loadCuratorRuleset(): { ruleset: CuratorRuleset; sha: string } {
  if (cache) return cache;
  const override = process.env.AGENTLAS_CURATOR_RULESET;
  const candidates = [
    ...(override ? [override] : []),
    path.join(__dirname, "curator-ruleset.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate);
      const parsed = JSON.parse(raw.toString("utf8")) as CuratorRuleset;
      if (parsed && typeof parsed === "object" && parsed.patterns) {
        cache = { ruleset: parsed, sha: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
        return cache;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  cache = { ruleset: EMBEDDED, sha: "embedded" };
  return cache;
}

function rulesetPattern(name: string): RegExp | null {
  const { ruleset } = loadCuratorRuleset();
  const spec = ruleset.patterns?.[name] ?? EMBEDDED.patterns?.[name];
  if (!spec?.regex) return null;
  try {
    return new RegExp(spec.regex, spec.flags ?? "");
  } catch {
    return null;
  }
}

/** Deterministic 3-layer team routing target for a durable agent_repo learning. */
export type TeamLearningLayer = "coordination" | "shared" | "domain";

/**
 * Kind → team layer, deterministic (no LLM). Values come from the ruleset
 * (teamLayerByKind); the semantics are unchanged from the original inline
 * implementation: coordination records belong to the orchestrator, portable
 * facts are shared team_memory, everything else is the member's domain cell.
 */
export function classifyTeamLearningRoute(kind: MemoryKind): TeamLearningLayer {
  const { ruleset } = loadCuratorRuleset();
  const table = ruleset.teamLayerByKind ?? EMBEDDED.teamLayerByKind ?? {};
  if ((table.coordination ?? []).includes(kind)) return "coordination";
  if ((table.shared ?? []).includes(kind)) return "shared";
  return "domain";
}

/** Filesystem paths that identify where this user works, regardless of project. */
export function projectBoundaryPathRe(): RegExp {
  return rulesetPattern("projectBoundaryPath")
    ?? /(?:^|\s)(?:\/(?:Users|home|var|opt|private)\/|~\/|[A-Za-z]:\\|file:\/\/)/;
}

/**
 * Does this learning name the project it came from?
 *
 * `agent_repo` is the one scope that deliberately crosses project boundaries;
 * a mislabelled event would carry project A's specifics into project B, so a
 * hit narrows the scope instead of sharing it. Conservative by construction —
 * a false positive costs reach, a false negative leaks.
 */
export function mentionsProjectSpecifics(content: string, projectPath: string | null | undefined): boolean {
  if (projectBoundaryPathRe().test(content)) return true;
  const folder = projectPath?.split(/[\\/]/).filter(Boolean).pop();
  const minChars = loadCuratorRuleset().ruleset.projectSpecificsGuard?.minFolderNameChars
    ?? EMBEDDED.projectSpecificsGuard?.minFolderNameChars
    ?? 4;
  // Short/generic folder names ("app", "web", "src") would match ordinary prose.
  if (folder && folder.length >= minChars) {
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, "i").test(content)) return true;
  }
  return false;
}
