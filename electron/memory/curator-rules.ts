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
  teamLayerByKind?: { coordination?: string[]; shared?: string[]; domainIsDefault?: boolean };
  projectSpecificsGuard?: {
    minFolderNameChars?: number;
    narrowAgentRepoTo?: string;
    noWorkspaceFallback?: string;
  };
  decay?: { dreaming?: { idleRequiredSec?: number; cooldownMs?: number } };
  [key: string]: unknown;
}

// Embedded defaults mirror the canonical file so a broken install fails open
// with identical behaviour; "embedded" in receipts makes that state visible.
const EMBEDDED: CuratorRuleset = {
  rulesetVersion: "embedded",
  teamLayerByKind: {
    coordination: ["decision", "conflict", "deprecation"],
    shared: ["fact"],
    domainIsDefault: true,
  },
  projectSpecificsGuard: {
    minFolderNameChars: 4,
    narrowAgentRepoTo: "project",
    noWorkspaceFallback: "session",
  },
  decay: { dreaming: { idleRequiredSec: 600, cooldownMs: 6 * 60 * 60 * 1000 } },
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
  // The ruleset states which layer catches everything else; reading it keeps the
  // declaration load-bearing instead of a comment that happens to match.
  return (table.domainIsDefault ?? true) ? "domain" : "shared";
}

/** Scope an agent_repo event narrows to when it names project specifics. */
export function narrowAgentRepoScope(): string {
  const { ruleset } = loadCuratorRuleset();
  return ruleset.projectSpecificsGuard?.narrowAgentRepoTo
    ?? EMBEDDED.projectSpecificsGuard?.narrowAgentRepoTo
    ?? "project";
}

/** Scope a project-suggested event falls back to when no folder is bound.
 *
 * The ruleset says `session`. Both local executors used to answer `team_memory`,
 * which promoted a fragment of one person's project into shared team memory —
 * the declaration and the behaviour disagreed, and the behaviour was wider.
 */
export function noWorkspaceFallbackScope(): string {
  const { ruleset } = loadCuratorRuleset();
  return ruleset.projectSpecificsGuard?.noWorkspaceFallback
    ?? EMBEDDED.projectSpecificsGuard?.noWorkspaceFallback
    ?? "session";
}

/** Idle seconds dreaming waits for, from the shared ruleset. */
export function dreamingIdleRequiredSec(): number {
  const { ruleset } = loadCuratorRuleset();
  const value = ruleset.decay?.dreaming?.idleRequiredSec
    ?? EMBEDDED.decay?.dreaming?.idleRequiredSec
    ?? 600;
  return Number.isFinite(value) && value > 0 ? Number(value) : 600;
}

/** Cooldown between dreaming passes, from the shared ruleset. */
export function dreamingCooldownMs(): number {
  const { ruleset } = loadCuratorRuleset();
  const value = ruleset.decay?.dreaming?.cooldownMs
    ?? EMBEDDED.decay?.dreaming?.cooldownMs
    ?? 6 * 60 * 60 * 1000;
  return Number.isFinite(value) && value > 0 ? Number(value) : 6 * 60 * 60 * 1000;
}

/** Filesystem paths that identify where this user works, regardless of project. */
export function projectBoundaryPathRe(): RegExp {
  return rulesetPattern("projectBoundaryPath")
    ?? /(?:^|\s)(?:\/(?:Users|home|var|opt|private)\/|~\/|[A-Za-z]:\\|file:\/\/)/;
}

/**
 * R21 W2b — a memory may make an agent more cautious, never less. Rejects a
 * candidate that asserts a permission/approval gate can be skipped; an
 * OBSERVATION about approvals ("the approval gate was the bottleneck") is
 * deliberately not matched. Ruleset-driven (patterns.capabilityWidening).
 */
export function widensCapability(content: string): boolean {
  const re = rulesetPattern("capabilityWidening");
  if (!re) return false;
  const m = re.exec(content);
  if (!m) return false;
  // Polarity: a single content regex cannot separate "skip approval" (widen)
  // from "never skip approval" (safety lesson) — measured non-separable (R20).
  // A negation/prohibition GOVERNING the widening phrase turns it into a safety
  // lesson; check a short look-back window before the match, NOT the whole
  // sentence, so a trailing "...never wait for approval" after an "auto-approve"
  // assertion cannot excuse it (2026-08-12 set 3 F1/F2). Mirrors
  // one_workspace._classify exactly so Desktop and OS never drift.
  const limits = loadCuratorRuleset().ruleset.limits as
    | { capabilityWideningNegationWindowChars?: number }
    | undefined;
  const win = limits?.capabilityWideningNegationWindowChars ?? 40;
  const lookback = content.slice(Math.max(0, m.index - win), m.index);
  const exc = rulesetPattern("capabilityWideningException");
  return !(exc && exc.test(lookback));
}

/**
 * R21 W2a — evidence must be machine-checkable in SHAPE (path:line, URL,
 * command, hash, test/gate name). Returns true when AT LEAST ONE entry is
 * well-shaped, so real evidence is never starved; a candidate whose only
 * support is self-reported satisfaction ("user rating 5/5") returns false and
 * is held out of durable. Blocks the arXiv:2509.26354 refund reward-hacking
 * case by shape, after semantic screening was measured non-separable (R20).
 */
export function hasWellShapedEvidence(evidence: readonly string[]): boolean {
  const re = rulesetPattern("evidenceShapeAccept");
  if (!re) return evidence.length > 0; // fail-open: never starve when the pattern is missing
  return evidence.some((item) => re.test(String(item)));
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
