import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  SECRET_SCAN_TEXT_EXTENSIONS,
  UPLOAD_AGENT_DEFINITION_FILES,
  UPLOAD_SKIP_DIRECTORIES,
} from "../../shared/upload-scan-catalog.generated";
import { gunzipSync, gzipSync } from "node:zlib";
import { detectRuntimeLabelsFromPaths } from "../agents/runtime-labels";
import { detectRuntimes } from "../runtime/detect";
import { autofixForPublish, remediateBlockers } from "../hephaestus/publish-autofix";
import type { RemediationAction } from "../hephaestus/publish-autofix";
import type { RuntimeStatus } from "../../shared/types";
import { getSessionCookieHeader } from "../auth";
import { invalidateMyAgentsCache } from "../marketplace";
// Registration refusals are thrown as the same typed error the cargo client
// uses, so every surface — Desktop, Mobile Bridge, MCP — reads one machine
// code instead of matching on a sentence. See `cloudRegistrationError`.
import { OwnerCloudActionError } from "../marketplace/mcp-source";
import { readCloudAgentRestoreMarker, writeCloudAgentRegistrationMarker } from "./restore";
import type {
  CloudAgentCloudScope,
  CloudAgentPackageFile,
  CloudAgentPackageManifest,
  CloudAgentLocalizedListing,
  CloudAgentPublicCareerGraph,
  CloudAgentPackageResult,
  CloudAgentPackageRequest,
  CloudAgentPublishStage,
  CloudAgentRegistrationResult,
  CloudAgentReviewResult,
  CloudAgentRevisionIdentity,
  CloudAgentSecurityFinding,
  CloudAgentVisibility,
} from "../../shared/types";
import { userDataPath } from "../runtime-paths";

// THE REAL WALL IS THE DOCUMENT, NOT THE NETWORK.
//
//   The server stores a package's bytes inside one manifest record
//   (ScanManifest.cloudPackage.files[].contentBase64), and that record is a
//   single MongoDB document, capped at 16 MiB by BSON. Content is stored
//   base64, so the document carries 4/3 of these transport bytes: 10 MiB is
//   about 13.3 MiB of base64 plus the manifest's own fields, leaving roughly
//   2 MiB of headroom. Raising it further means moving the bytes out of the
//   document first — and the owner's decision (2026-08-23) is that they stay
//   in the record, because an agent parked in object storage cannot be routed
//   to. Same four numbers in the engine (agentlas_cloud/upload.py), restore.ts,
//   the Terminal (engine/hub/install.cjs) and the server; server deploys first.
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL_BYTES = 4 * MAX_TOTAL_BYTES;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// ★ THE CEILING MEASURES WHAT IS STORED, NOT WHAT WAS AUTHORED.
//
//   Packages travel as base64 with no compression, which inflates text by a
//   third on the way to a 3 MB ceiling. Measured on the published teams, a
//   text-heavy package compresses 1.5x-3.6x — so the ceiling was costing
//   authors most of their room, and the trim pass was deleting knowledge files
//   to save space that compression gives back for free.
//
//   Limits now apply to the COMPRESSED bytes. Original size keeps a bound of
//   its own so a small archive cannot declare an enormous original. The server
//   (api/cloud-agents/v1/register) enforces the identical pair.
const MAX_UNCOMPRESSED_FILE_BYTES = 4 * MAX_FILE_BYTES;
const MAX_FILES = 400;
const MANIFEST_VERSION = "0.1" as const;
const PACKAGE_HASH_VERSION = "path-sha256-executable-v2" as const;
const ROUTING_CARD_PATH = ".agentlas/routing-card.json";
const DESKTOP_RESTORE_MARKER_PATH = ".agentlas-cloud-package.json";
const LOCAL_EXPERIENCE_LINEAGE_PATH = ".agentlas/experience-relations.jsonl";
const ROUTING_CARD_CAPABILITY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const ROUTING_CARD_STATUSES = new Set(["draft", "searchable", "candidate", "routing_ready", "trusted"]);

/**
 * ★ WHAT THE PRODUCT ITSELF CALLS PRIVATE MUST NOT SHIP IN A PACKAGE.
 *
 * The product writes a `.gitignore` into every user project declaring these
 * files machine-local: "per-machine outputs of features each user runs on their
 * own files — nobody else consumes another person's copy — and publishing one
 * leaks the shape of a private working tree" (project-files.ts). The upload
 * scanner shipped almost all of them anyway. Measured 2026-08-18 on Quant
 * Research Desk: the live Hub listing is 56 files / 287KB while the local
 * folder had grown to 62 files / 732KB — the delta was exactly this local
 * state, `ontology-runtime.sqlite` alone 316KB (43% of the folder).
 *
 * The list mirrors hep-upload's `GENERATED_RUNTIME_PATHS` +
 * `UPLOAD_DERIVED_EVIDENCE_PATHS` (Agentlas-OS agentlas_cloud) plus the
 * private-memory files both channels missed. Keeping the two channels'
 * exclusion sets identical keeps the packageHash of one folder identical no
 * matter which product uploads it. Installers lose nothing: first contact
 * regenerates every one of these through the project bootstrap.
 *
 * Deliberately NOT here: `memory-tickets.jsonl` + `ticket-slugs.json` (teams
 * ship authored seed memories — measured: qrd-mem-seed-001 — and One's
 * memory-map consumes them) and `.agentlas/pm/learnings/` (the cross-host
 * shared learning layer, part of the runtime-bundle contract).
 */
const MACHINE_LOCAL_STATE_FILES = new Set([
  // rebuildable runtime indexes (hep-upload: GENERATED_RUNTIME_PATHS)
  ".agentlas/ontology-runtime.json",
  ".agentlas/ontology-sources.json",
  ".agentlas/career-graph-sources.json",
  // derived per-scan evidence (hep-upload: UPLOAD_DERIVED_EVIDENCE_PATHS)
  ".agentlas/security-scan.json",
  ".agentlas/security-llm-judgment.json",
  ".agentlas/field-test-report.json",
  ".agentlas/brief.json",
  // private project memory (product .gitignore: AGENTLAS_PRIVATE_PROJECT_STATE)
  ".agentlas/sitemap.json",
  ".agentlas/project-soul-memory.md",
  ".agentlas/memory-log.jsonl",
  ".agentlas/curator-decisions.jsonl",
  ".agentlas/skill-trials.jsonl",
  ".agentlas/local-credentials.map.json",
]);
const MACHINE_LOCAL_STATE_DIRS = [
  ".agentlas/ontology-inbox/",
  ".agentlas/career-graph-inbox/",
  ".agentlas/code-map/",
];
const MACHINE_LOCAL_STATE_FILE_PREFIXES = [
  ".agentlas/ontology-runtime.sqlite",
  ".agentlas/career-graph.sqlite",
];

/**
 * ★ A RESULT IS NOT A CAPABILITY. Owner decision 2026-08-18.
 *
 * What an agent PRODUCES while it works — the rendered page, the screenshot it
 * took to check itself, the deck it exported, the page dump its browser tool
 * left behind — is an output of one run on one person's machine. It is not what
 * the agent can DO. The thing that must ship is the script/prompt/preset that
 * produces it again on the installer's machine.
 *
 * Measured 2026-08-18 across the published teams: every folder over the 3 MB
 * ceiling was over it because of outputs, never because of knowledge.
 * no-slop-seeder carried 3.0 MB of captures, logs and chat attachments;
 * agentlas-startup-founder-studio 1.1 MB of `.studio-runtime` productions;
 * Web_master 0.6 MB of report screenshots; browser-driving teams carry
 * `.playwright-mcp/page-*.yml` dumps at 286 KB each. Not one of those files is
 * read by the agent that shipped it.
 *
 * `.agentlas/work/` is the declared home for run outputs, so an agent author has
 * somewhere correct to write. Everything here regenerates on first run; leaving
 * it out costs the installer nothing.
 */
/**
 * Cleaning drops these on sight and nobody needs to be told: build output,
 * caches, vendored dependency trees. Everything else it drops gets named in the
 * result — see the `autofix.excluded` loop in packageAndReviewCloudAgent.
 */
const AUTOFIX_SILENT_DROP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__",
  ".venv", "venv", ".env.d", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", ".tox", ".gradle", ".idea", ".terraform",
]);

const WORK_OUTPUT_DIRS = [
  // the declared convention
  ".agentlas/work/",
  // per-run product state that is not the agent
  ".agentlas/chat-attachments/",
  ".agentlas/runs/",
  // tool droppings
  ".playwright-mcp/",
  ".studio-runtime/",
  ".pytest_cache/",
  ".ruff_cache/",
  ".mypy_cache/",
  ".gradle/",
  ".venv/",
  "venv/",
  ".cache/",
  "tmp/",
  "temp/",
  ".tmp/",
];

export function isRegeneratedWorkOutputPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return WORK_OUTPUT_DIRS.some((dir) => normalized === dir.slice(0, -1) || normalized.startsWith(dir) || normalized.includes(`/${dir}`));
}

/**
 * ★ WHAT THE PRODUCT REFUSES TO COMMIT, THE PRODUCT MUST REFUSE TO PUBLISH.
 *
 * `ensureAgentlasCredentialIgnore` (memory/project-files.ts) writes
 * `signing/*` and `credentials/*` into every project's .gitignore, keeping only
 * each folder's README. Upload knew nothing about it: it screened FILE NAMES
 * (`credentials.*`, `*.key`, `*.pem`) and let `credentials/google-services.json`
 * or `signing/anything.txt` straight through. Measured 2026-08-18 — both
 * returned "included".
 *
 * Mirrored here folder-for-folder, README exempted exactly as the .gitignore
 * exempts it, so the installer still reads "put your config here".
 */
const PRODUCT_PRIVATE_DIRS = ["credentials/", "signing/"];
const PRODUCT_PRIVATE_KEPT_FILES = new Set(["readme.md"]);

export function isProductPrivateFolderPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const dir = PRODUCT_PRIVATE_DIRS.find((candidate) => normalized.startsWith(candidate) || normalized.includes(`/${candidate}`));
  if (!dir) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return !PRODUCT_PRIVATE_KEPT_FILES.has(base);
}

export function isMachineLocalStatePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  if (MACHINE_LOCAL_STATE_FILES.has(normalized)) return true;
  if (MACHINE_LOCAL_STATE_DIRS.some((dir) => normalized.startsWith(dir))) return true;
  return MACHINE_LOCAL_STATE_FILE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isLocalExperienceLineagePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized === LOCAL_EXPERIENCE_LINEAGE_PATH
    || normalized.startsWith(`${LOCAL_EXPERIENCE_LINEAGE_PATH}.`)
    || normalized.startsWith(".agentlas/.experience-relations.jsonl.");
}

// Packaging vocabulary comes from the upload contract, generated from
// agentlas/AgentsAtlas/app/src/lib/agentlas-cloud/upload-scan-catalog.json.
// All three of these were hand-typed here and disagreed with the server and
// with Terminal: this scan opened .bat/.cmd/.jsx that the SERVER-side scan
// never did, and it did not skip .studio-runtime, so local studio runtime state
// went up to the Hub.
const TEXT_EXTENSIONS = new Set<string>(SECRET_SCAN_TEXT_EXTENSIONS);

const AGENT_DEF_FILES = new Set<string>(UPLOAD_AGENT_DEFINITION_FILES);

const SKIP_DIRS = new Set<string>(UPLOAD_SKIP_DIRECTORIES);

const BLOCKED_FILE_PATTERNS = [
  // `.env.example` / `.env.sample` / `.env.template` are documentation: they
  // name the variables an installer must set and hold no values. The cleaning
  // pass has always kept them (publish-autofix SECRET_FILE_PATTERNS); the scan
  // did not, so a package that documented its own configuration had that file
  // deleted by the repair pass. Measured on agentlas-startup-founder-studio.
  /^\.env(?:\.(?!example$|sample$|template$).*)?$/i,
  /^id_rsa(?:\.pub)?$/i,
  /^credentials(?:\..*)?$/i,
  /^secrets?(?:\..*)?$/i,
  /(?:^|[._-])service-account(?:[._-]|$)/i,
  /\.(?:key|pem|p12|pfx|mobileprovision)$/i,
];

const SECRET_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, label: "private key material" },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "OpenAI-style API key" },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, label: "GitHub token" },
  { id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, label: "GitLab token" },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "Google API key" },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/, label: "npm access token" },
  { id: "stripe-secret", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/, label: "Stripe secret key" },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, label: "Slack token" },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
  { id: "generic-secret", re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: "hard-coded credential" },
];

export interface PackagedFile {
  path: string;
  /** Size of the ORIGINAL file. packageHash is built from this and sha256, so it does not move with the encoding. */
  bytes: number;
  /** sha256 of the ORIGINAL bytes. */
  sha256: string;
  contentBase64: string;
  executable: boolean;
  /** Omitted means "identity" — exactly what every package written before compression says. */
  encoding?: "gzip";
  /** Bytes that actually travel. Present only alongside `encoding`. */
  encodedBytes?: number;
}

/**
 * Read a packaged file back. Every reader must go through this — reaching for
 * `contentBase64` directly is how the routing card came back as "not valid
 * JSON" the moment compression was switched on.
 */
export function decodePackagedContent(file: Pick<PackagedFile, "contentBase64" | "encoding">): Buffer {
  const raw = Buffer.from(file.contentBase64, "base64");
  return file.encoding === "gzip" ? gunzipSync(raw, { maxOutputLength: MAX_UNCOMPRESSED_FILE_BYTES }) : raw;
}

/**
 * Compress when it helps and say so; otherwise ship the bytes unchanged. Text
 * shrinks 2-3x, already-compressed media does not, and a "compressed" file that
 * grew would cost the author room for nothing.
 */
function encodePackagedContent(bytes: Buffer): Pick<PackagedFile, "contentBase64" | "encoding" | "encodedBytes"> {
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.byteLength >= bytes.byteLength) {
    return { contentBase64: bytes.toString("base64") };
  }
  return {
    contentBase64: compressed.toString("base64"),
    encoding: "gzip",
    encodedBytes: compressed.byteLength,
  };
}

interface StaticScanResult {
  files: CloudAgentPackageFile[];
  included: PackagedFile[];
  findings: CloudAgentSecurityFinding[];
  totalBytes: number;
}

/**
 * Main-only, read-only package snapshot used by review workflows. It reuses
 * the exact Cloud/Hub path, symlink, stable-read, size and secret scanner, but
 * deliberately performs no package write and no Cloud/Hub request.
 */
export interface CloudAgentLocalReviewScan {
  rootPath: string;
  packageHash: string;
  files: CloudAgentPackageFile[];
  included: PackagedFile[];
  findings: CloudAgentSecurityFinding[];
  totalBytes: number;
}

type PackageSnapshot = Map<string, PackagedFile>;

function resolveCloudAgentRoot(inputPath: string): string {
  const requestedRoot = path.resolve(inputPath);
  try {
    const rootStat = fs.lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("not a real directory");
    return fs.realpathSync.native(requestedRoot);
  } catch {
    throw new Error(`Cloud agent root is not a directory: ${inputPath}`);
  }
}

interface RemediationOutcome {
  actions: RemediationAction[];
  passes: number;
  clearedFiles: string[];
}

/**
 * Generic publish-gate convergence loop. Re-scans the throwaway package copy
 * with the REAL gate (scanAgentFolder) and hands every file-level blocker to the
 * connected model to fix, escalating to deterministic secret redaction and then
 * file-exclude, until zero file blockers remain. A blocker never dead-ends a
 * publish: the end state is always an uploadable package. The user's folder is
 * never touched — all edits happen inside the temp copy at `scanRoot`.
 */
/**
 * Bring a package under the two whole-package limits by dropping the least
 * essential files, largest first, until the scan stops reporting them.
 *
 * What can never be dropped is fixed and small: the agent definition files, the
 * `.agentlas` cards, and the package manifests. Everything else is ranked by
 * how unlikely it is to be part of what the agent IS — build output, caches,
 * media, archives, fixtures, logs and benchmarks go before ordinary sources.
 * Nothing here touches the user's own folder: `scanRoot` is the throwaway copy
 * autofix made, and the report lists every dropped path.
 */
/**
 * Every file name mentioned inside the package's own text. A shotplan naming
 * `/samples/angle-frontal.jpg`, a prompt naming `lens-24.jpg`, a skill naming
 * `dossier.md` — each of those makes the named file part of the agent, wherever
 * it happens to live. Names only, never paths: a reference written as
 * `./samples/x.jpg`, `/samples/x.jpg` or `samples/x.jpg` must all count.
 */
function collectReferencedFileNames(root: string): Set<string> {
  const names = new Set<string>();
  // Matching the name pattern against a whole file is quadratic on the lines
  // real packages contain. On a run of identical characters — minified JS, a
  // base64 data URI, a one-line JSON — the greedy class matches to the end at
  // every start position and then backtracks looking for a dot that never
  // comes. Measured here: 256 KB on one line took 58s, and the per-file ceiling
  // is now 2 MB. Tokenize first: a run with no dot is skipped whole, and the
  // name pattern only ever runs on a bounded candidate. Same names out.
  const tokenRe = /[A-Za-z0-9._-]+/g;
  const nameRe = /[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}/g;
  const pending = [root];
  let read = 0;
  while (pending.length > 0 && read < MAX_FILES) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext) && !AGENT_DEF_FILES.has(entry.name)) continue;
      let text: string;
      try {
        if (fs.statSync(absolute).size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      read += 1;
      for (const token of text.match(tokenRe) ?? []) {
        if (!token.includes(".")) continue;
        // A name is short. A dotted token this long is data, and only its tail
        // could carry one.
        const candidate = token.length > 512 ? token.slice(-512) : token;
        for (const match of candidate.match(nameRe) ?? []) names.add(match.toLowerCase());
      }
    }
  }
  return names;
}

export function trimPackageToLimits(
  scanRoot: string,
  restoredExecutablePaths: ReadonlySet<string>,
  onStage?: (stage: CloudAgentPublishStage, detail?: string) => void,
): RemediationAction[] {
  const root = path.resolve(scanRoot);
  const actions: RemediationAction[] = [];
  const LIMIT_FINDING_IDS = new Set(["package-size-limit", "file-count-limit"]);
  const overLimit = (): boolean => {
    try {
      return scanAgentFolder(root, restoredExecutablePaths)
        .findings.some((f) => f.severity === "blocker" && LIMIT_FINDING_IDS.has(f.id));
    } catch {
      return false;
    }
  };
  if (!overLimit()) return actions;

  // ★ TRIMMING MUST NOT COST THE AGENT ITS ABILITIES. Owner decision 2026-08-18.
  //
  //   The old ranking knew file SIZE and file TYPE and nothing about what the
  //   agent needs. Two consequences, both measured on shipped teams:
  //     - `knowledge/`, `skills/`, `prompts/`, `presets/` were ordinary content
  //       (rank 5), so the biggest knowledge file went before any build output.
  //     - `samples/` was rank 3 — dropped early as "examples" — while
  //       photo-studio-agent-team's shotplans name `/samples/angle-frontal.jpg`
  //       on every single cut. Those samples ARE the capability.
  //
  //   So: capability directories are rank 0, and any file another packaged file
  //   actually names is rank 0 regardless of where it sits. What nobody reads
  //   can go; what something reads stays.
  const CAPABILITY_DIR_RE = /(^|\/)(knowledge|skills?|prompts?|presets?|agents|workers|contracts|shotplans|playbooks|templates)\//;
  const referencedNames = collectReferencedFileNames(root);
  const rankOf = (rel: string, bytes: number): number => {
    const lower = rel.toLowerCase();
    const base = path.basename(rel);
    if (AGENT_DEF_FILES.has(base)) return 0;
    if (lower.startsWith(".agentlas/")) return 0;
    if (["agentlas.json", "manifest.json", "package.json"].includes(lower)) return 0;
    if (CAPABILITY_DIR_RE.test(lower)) return 0;
    if (referencedNames.has(base.toLowerCase())) return 0;
    if (/(^|\/)(node_modules|dist|build|out|coverage|\.next|\.venv|__pycache__|\.git)\//.test(lower)) return 1;
    if (/\.(png|jpe?g|gif|webp|svg|mp4|mov|mp3|wav|pdf|zip|tar|gz|tgz|bin|so|dylib|dll|wasm|sqlite|db)$/.test(lower)) return 2;
    if (/(^|\/)(tests?|__tests__|fixtures?|benchmarks?|logs?|examples?)\//.test(lower)) return 3;
    if (/\.(log|jsonl|csv|tsv|lock)$/.test(lower)) return 4;
    // Ordinary content: biggest first, so one huge file goes before many small ones.
    return bytes > 64 * 1024 ? 5 : 6;
  };

  const candidates: Array<{ rel: string; abs: string; bytes: number; rank: number }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
      } catch {
        continue;
      }
      const rank = rankOf(rel, bytes);
      if (rank === 0) continue;
      candidates.push({ rel, abs, bytes, rank });
    }
  };
  walk(root);
  // Least essential first; within one rank, the biggest file buys the most room.
  candidates.sort((a, b) => (a.rank - b.rank) || (b.bytes - a.bytes));

  for (const candidate of candidates) {
    if (!overLimit()) break;
    try {
      fs.rmSync(candidate.abs, { force: true });
    } catch {
      continue;
    }
    actions.push({
      file: candidate.rel,
      action: "excluded",
      detail: "left out to fit the Agent Cloud package limits",
    });
    onStage?.("excluded", candidate.rel);
  }
  if (actions.length > 0) onStage?.("scan-clean");
  return actions;
}

async function remediateUntilClean(
  scanRoot: string,
  restoredExecutablePaths: ReadonlySet<string>,
  active: RuntimeStatus | null,
  locale: "ko" | "en",
  onStage?: (stage: CloudAgentPublishStage, detail?: string) => void,
): Promise<RemediationOutcome> {
  const MAX_PASSES = 5;
  const actions: RemediationAction[] = [];
  const clearedFiles: string[] = [];
  let passes = 0;
  const root = path.resolve(scanRoot);
  const fileBlockers = (): Array<{ id: string; file: string; category: string; message: string }> => {
    let probe: StaticScanResult;
    try {
      probe = scanAgentFolder(root, restoredExecutablePaths);
    } catch {
      return [];
    }
    return probe.findings
      .filter((f) => f.severity === "blocker" && !!f.file)
      .map((f) => ({ id: f.id, file: f.file as string, category: f.category, message: f.message }))
      .filter((b) => {
        const abs = path.resolve(root, b.file);
        try {
          return abs.startsWith(root + path.sep) && fs.statSync(abs).isFile();
        } catch {
          return false;
        }
      });
  };
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    passes = pass;
    const blockers = fileBlockers();
    if (blockers.length === 0) {
      onStage?.("scan-clean");
      break;
    }
    onStage?.("blockers", String(blockers.length));
    if (pass <= 3) {
      const r = await remediateBlockers({
        folder: root,
        blockers,
        active,
        locale,
        deterministicOnly: pass === 3,
        onStage,
      });
      actions.push(...r.actions);
      if (r.changed) continue; // re-scan the now-changed copy
    }
    // Last resort — exclude every remaining blocker file so the package always
    // reaches zero blockers and uploads. (Reached on pass ≥ 4, or earlier when a
    // pass could change nothing.)
    for (const rel of new Set(blockers.map((b) => b.file))) {
      const abs = path.resolve(root, rel);
      try {
        fs.rmSync(abs, { force: true });
        clearedFiles.push(rel);
        actions.push({ file: rel, action: "excluded", detail: "last resort — unremediable blocker" });
        onStage?.("excluded", rel);
      } catch {
        /* ignore; next scan will re-surface it and eventually exhaust passes */
      }
    }
  }
  return { actions, passes, clearedFiles };
}

const ROUTING_CAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "that", "this", "are", "not", "can",
  "agent", "agentlas", "assistant", "bot", "app", "tool", "using", "use", "into",
]);

function deriveRoutingCapabilities(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !ROUTING_CAP_STOPWORDS.has(w));
  const caps: string[] = [];
  for (let i = 0; i + 1 < words.length && caps.length < 3; i += 2) {
    const cap = `${words[i]}_${words[i + 1]}`;
    if (ROUTING_CARD_CAPABILITY_RE.test(cap)) caps.push(cap);
  }
  return Array.from(new Set(caps));
}

function openSemanticId(value: unknown, prefix: "role" | "community" | "skill" | "knowledge"): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  const body = raw.startsWith(`${prefix}:`) ? raw.slice(prefix.length + 1) : raw;
  const slug = body
    .replace(/[_\s/]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${prefix}:${slug}` : null;
}

function declaredKnowledgeIds(scanRoot: string): string[] {
  const out: string[] = [];
  const pending = [scanRoot];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_FILES) {
    const dir = pending.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".agentlas") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(absolute);
        continue;
      }
      visited += 1;
      const relative = normalizeRelative(scanRoot, absolute);
      if (!/(^|\/)knowledge\/[^/]+\.(?:md|markdown|txt)$/i.test(relative)) continue;
      const concept = openSemanticId(path.basename(relative, path.extname(relative)), "knowledge");
      if (concept && !out.includes(concept)) out.push(concept);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function completeWorkforceResume(card: Record<string, unknown>, scanRoot: string): boolean {
  const before = JSON.stringify(card.workforce ?? null);
  const existing = isRecord(card.workforce) ? card.workforce : {};
  const ids = (
    raw: unknown,
    prefix: "role" | "community" | "skill" | "knowledge",
    cap: number,
  ): string[] => {
    if (!Array.isArray(raw)) return [];
    return Array.from(new Set(raw.map((value) => openSemanticId(value, prefix)).filter((value): value is string => Boolean(value)))).slice(0, cap);
  };
  const capabilities = Array.isArray(card.capabilities) ? card.capabilities : [];
  const domains = Array.isArray(card.domains) ? card.domains : [];
  const knowledge = Array.from(new Set([
    ...ids(existing.knowledge, "knowledge", 12),
    ...declaredKnowledgeIds(scanRoot),
  ])).slice(0, 12);
  card.workforce = {
    roles: ids(existing.roles, "role", 4),
    communities: ids(existing.communities, "community", 5).length
      ? ids(existing.communities, "community", 5)
      : ids(domains, "community", 5).length
        ? ids(domains, "community", 5)
        : ids(capabilities, "community", 1),
    skills: ids(existing.skills, "skill", 12).length
      ? ids(existing.skills, "skill", 12)
      : ids(capabilities, "skill", 12),
    knowledge,
    ...(Array.isArray(existing.tools) ? { tools: existing.tools } : {}),
    ...(Array.isArray(existing.authorities) ? { authorities: existing.authorities } : {}),
    ...(Array.isArray(existing.forbiddenAuthorities) ? { forbiddenAuthorities: existing.forbiddenAuthorities } : {}),
    modalities: Array.isArray(existing.modalities) ? existing.modalities : [],
    languages: Array.isArray(existing.languages) ? existing.languages : [],
  };
  return JSON.stringify(card.workforce) !== before;
}

/**
 * Public Hub requires a valid routing-card/2.0. A missing or invalid one is a
 * hard blocker that lives OUTSIDE scanAgentFolder (so the remediation loop can't
 * reach it) — auto-generate a valid card from the agent's own identity so no
 * agent dead-ends on it. Only writes into the throwaway copy at scanRoot.
 */
/**
 * 비공개 저장이 이대로면 막히는가 — 모델 수리 패스를 켤지 정하는 값싼 사전 판정.
 *
 * 파일시스템 스캔만 한다(모델 호출 없음). 라우팅 카드·이중언어 메타데이터처럼
 * **공개 발행에만** 요구되는 항목은 여기서 보지 않는다 — 비공개 저장은 그것들을
 * 애초에 요구하지 않으므로, 없다고 해서 수리 패스를 켜면 헛일이다.
 */
function privateSaveNeedsRemediation(
  rootPath: string,
  restoredExecutablePaths: ReadonlySet<string>,
): boolean {
  try {
    return scanAgentFolder(rootPath, restoredExecutablePaths)
      .findings.some((finding) => finding.severity === "blocker");
  } catch {
    // 사전 판정이 못 돌면 수리 루프에 맡긴다 — 조용히 통과시키지 않는다.
    return true;
  }
}

function ensureRoutingCard(
  scanRoot: string,
  purposeInput?: { summary: string; capabilities: string[] },
): boolean {
  const cardPath = path.join(scanRoot, ROUTING_CARD_PATH);
  let existingCard: Record<string, unknown> | null = null;
  try {
    const existing = JSON.parse(fs.readFileSync(cardPath, "utf8")) as unknown;
    if (isRecord(existing)) existingCard = existing;
  } catch {
    /* missing/invalid → generate */
  }
  const purpose = String(purposeInput?.summary ?? "").trim().slice(0, 1_200);
  const purposeCapabilities = purposeInput?.capabilities ?? [];
  if (existingCard && purpose && purposeCapabilities.length > 0) {
    const name = typeof existingCard.name === "string" && existingCard.name.trim()
      ? existingCard.name.trim()
      : path.basename(scanRoot);
    existingCard.schemaVersion = "routing-card/2.0";
    existingCard.id = typeof existingCard.id === "string" && existingCard.id.trim()
      ? existingCard.id
      : sanitizeSlug(name) || "agent";
    existingCard.type = existingCard.type === "team" || existingCard.type === "plugin"
      ? existingCard.type
      : "agent";
    existingCard.name = name;
    existingCard.summary = purpose.slice(0, 240);
    existingCard.capabilities = purposeCapabilities;
    completeWorkforceResume(existingCard, scanRoot);
    fs.mkdirSync(path.dirname(cardPath), { recursive: true });
    fs.writeFileSync(cardPath, JSON.stringify(existingCard, null, 2) + "\n", "utf8");
    return true;
  }
  if (existingCard) {
    const changed = completeWorkforceResume(existingCard, scanRoot);
    if (routingCardProblem(existingCard) === null) {
      if (!changed) return false;
      fs.writeFileSync(cardPath, JSON.stringify(existingCard, null, 2) + "\n", "utf8");
      return true;
    }
  }
  let name = path.basename(scanRoot);
  let tagline = "";
  let localizedEn = "";
  for (const rel of [".agentlas/agent-card.json", "agentlas.json"]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(scanRoot, rel), "utf8")) as unknown;
      if (isRecord(data)) {
        if (typeof data.name === "string" && data.name.trim()) name = data.name.trim();
        if (typeof data.tagline === "string") tagline = data.tagline.trim();
        const loc = isRecord(data.localized) ? data.localized : undefined;
        if (loc) {
          if (typeof loc.descriptionEn === "string") localizedEn = loc.descriptionEn;
          else if (typeof loc.titleEn === "string") localizedEn = loc.titleEn;
        }
      }
      break;
    } catch {
      /* try next candidate */
    }
  }
  const summary = (purpose || tagline || localizedEn || name).slice(0, 240);
  const card = {
    schemaVersion: "routing-card/2.0",
    id: sanitizeSlug(name) || "agent",
    type: "agent",
    name,
    summary,
    capabilities: purposeCapabilities.length > 0
      ? purposeCapabilities
      : deriveRoutingCapabilities(`${name} ${tagline} ${localizedEn}`),
    routing_status: "searchable",
    generated_by: "agentlas-desktop-publish-autofix",
  };
  completeWorkforceResume(card, scanRoot);
  try {
    fs.mkdirSync(path.dirname(cardPath), { recursive: true });
    fs.writeFileSync(cardPath, JSON.stringify(card, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Scaffold the minimal agent definition when none of the accepted files exist.
 * Content comes only from what the package already declares about itself
 * (agent-card / agentlas.json name+tagline) — nothing is invented. */
function ensureAgentDefinitionFile(scanRoot: string): boolean {
  const hasDefinition = [...AGENT_DEF_FILES].some((name) => {
    try {
      return fs.statSync(path.join(scanRoot, name)).isFile();
    } catch {
      return false;
    }
  });
  if (hasDefinition) return false;
  let name = path.basename(scanRoot);
  let tagline = "";
  for (const rel of [".agentlas/agent-card.json", "agentlas.json"]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(scanRoot, rel), "utf8")) as unknown;
      if (isRecord(data)) {
        if (typeof data.name === "string" && data.name.trim()) name = data.name.trim();
        if (typeof data.tagline === "string" && data.tagline.trim()) tagline = data.tagline.trim();
        else if (typeof data.summary === "string" && data.summary.trim()) tagline = data.summary.trim();
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  try {
    fs.writeFileSync(
      path.join(scanRoot, "AGENTS.md"),
      `# ${name}

${tagline || "Portable Agentlas cloud agent package."}
`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** Friendly one-line breakdown of what the publish auto-fix did, for the user. */
/**
 * ★ A FILE THAT LEFT THE PACKAGE MUST BE NAMED. Owner decision 2026-08-18.
 *
 * Auto-fix ends every publish at zero blockers, and its last resort is deleting
 * the offending file from the scan copy. That is a change to what the agent can
 * do, so it cannot be reported as a count buried in a sentence — and until now
 * it was not reported at all outside `status: "registered"`. Measured: a 600 KB
 * `knowledge.md` vanished under `Private Agent Cloud package ready`, verdict
 * "pass", zero findings.
 *
 * Excluded files are named (up to three, then "+N"). hep-upload does the same
 * thing through its omission receipts; this is Desktop saying it out loud.
 */
function summarizeRemediation(actions: RemediationAction[], locale: "ko" | "en"): string {
  if (actions.length === 0) return "";
  const redacted = actions.filter((a) => a.action === "redacted").length;
  const excludedFiles = actions.filter((a) => a.action === "excluded").map((a) => a.file);
  const rewritten = actions.filter((a) => a.action === "rewritten" && !a.detail.includes("routing card")).length;
  const routingCard = actions.some((a) => a.detail.includes("routing card"));
  const parts: string[] = [];
  const ko = locale === "ko";
  if (routingCard) parts.push(ko ? "라우팅 카드 생성" : "generated routing card");
  if (redacted) parts.push(ko ? `시크릿 ${redacted}건 리댁트` : `redacted ${redacted}`);
  if (rewritten) parts.push(ko ? `${rewritten}건 재작성` : `rewrote ${rewritten}`);
  if (excludedFiles.length > 0) {
    const shown = excludedFiles.slice(0, 3).join(", ");
    const rest = excludedFiles.length - Math.min(3, excludedFiles.length);
    const names = rest > 0 ? `${shown} +${rest}` : shown;
    parts.push(ko ? `${excludedFiles.length}건 제외(${names})` : `excluded ${excludedFiles.length} (${names})`);
  }
  if (parts.length === 0) return "";
  return ko ? ` 자동수정: ${parts.join(", ")}.` : ` Auto-fixed: ${parts.join(", ")}.`;
}

export async function packageAndReviewCloudAgent(
  input: CloudAgentPackageRequest,
  opts?: {
    onStage?: (stage: CloudAgentPublishStage, detail?: string) => void;
    locale?: "ko" | "en";
    /** Override the runtime used for auto-fix. Omit to auto-detect; pass null to force the deterministic path. */
    activeRuntime?: RuntimeStatus | null;
  },
): Promise<CloudAgentPackageResult> {
  // Every phase below already existed; none of it was ever reported. `onStage`
  // had zero callers, so an upload that spends a minute cleaning, scanning,
  // reviewing, and registering looked identical to a frozen button.
  const stage = (name: CloudAgentPublishStage, detail?: string): void => opts?.onStage?.(name, detail);
  stage("starting");
  const rootPath = resolveCloudAgentRoot(input.rootPath);

  const visibility = input.visibility ?? "private-link";
  const isPublicHubPublish = visibility === "marketplace";

  // ★ AN INSTALLED COPY IS NEVER PUBLISHED FROM HERE. Owner decision 2026-08-17.
  //
  //   The server refuses a fork two ways — declared lineage, and identical
  //   bytes already listed by another account — and a local round trip defeats
  //   both: restore the copy, edit one line, and the hash no longer matches
  //   anything while the folder carries no lineage of its own. The restore
  //   marker is what survives that round trip, so the refusal belongs here,
  //   before a minute of scanning and packaging is spent on an upload the
  //   server will reject anyway.
  //
  //   Only the HUB upload is blocked. A private re-upload of your own copy is
  //   ordinary use and stays allowed, which is rule 3 — but it carries the
  //   lineage with it (see `forkLineage` below). Allowing the save while
  //   dropping the parent is what turned this refusal into a speed bump: save
  //   the copy privately, restore THAT into a fresh folder with no marker, and
  //   publish it as original work without ever breaking a rule.
  const forkLineage = readCloudAgentRestoreMarker(rootPath)?.fork;
  {
    if (isPublicHubPublish && forkLineage) {
      throw new Error(
        `This folder is an installed copy of ${forkLineage.originSlug}. ` +
          "It can be run, edited, and staffed into work orders, but the Hub listing belongs to the original creator.",
      );
    }
  }
  const publicCareerPrepareFindings = isPublicHubPublish
    ? await preparePublicCareerGraphCard(rootPath)
    : [];
  const restoreMarker = readCloudAgentRestoreMarker(rootPath);
  const restoredExecutablePaths = new Set(
    restoreMarker?.packageHashVersion === PACKAGE_HASH_VERSION
      ? restoreMarker.executablePaths ?? []
      : [],
  );
  // Public publish auto-fix: the strongest connected model reviews the package
  // into a throwaway clean copy (excludes local build artifacts, secret files,
  // and symlinks, plus anything the model marks; a deterministic backstop always
  // strips secrets/symlinks regardless of the model), so an ordinary agent folder
  // publishes without hand-editing. Only the scan/package INPUT is the clean copy;
  // the original rootPath still owns the restore marker and the returned path, and
  // the user's folder is never mutated.
  let scanRoot = rootPath;
  let autofixCleanup: (() => void) | null = null;
  let remediationActions: RemediationAction[] = [];
  // ★비공개(내 클라우드) 저장도 막다른 길이 되면 안 된다 — 오너 지시(2026-08-08).
  // 이 수리 사전 패스는 공개 Hub 발행에만 걸려 있었다. 그래서 같은 폴더가 공개로는
  // 자동 수리되어 올라가고, 정작 **자기 클라우드에 비공개로** 저장할 때는 blocker
  // 하나에 그대로 멈췄다. 비공개도 같은 루프를 태우되, 값이 드는 모델 패스는
  // **실제로 막혔을 때만** 돈다 — 깨끗한 패키지의 저장 속도는 그대로다.
  if (isPublicHubPublish || privateSaveNeedsRemediation(rootPath, restoredExecutablePaths)) {
    try {
      let active: RuntimeStatus | null;
      if (opts && Object.prototype.hasOwnProperty.call(opts, "activeRuntime")) {
        active = opts.activeRuntime ?? null;
      } else {
        const runtimes = await detectRuntimes().catch(() => [] as Awaited<ReturnType<typeof detectRuntimes>>);
        active = runtimes.find((runtime) => runtime.active) ?? runtimes[0] ?? null;
      }
      opts?.onStage?.("cleaning");
      const autofix = await autofixForPublish({ folder: rootPath, active, locale: opts?.locale });
      if (autofix.packageFolder) {
        // scanAgentFolder compares realpath'd children against this root, so the
        // temp copy path must be canonical (e.g. macOS /var → /private/var), or
        // every child resolves "outside the approved root".
        try {
          scanRoot = fs.realpathSync.native(autofix.packageFolder);
        } catch {
          scanRoot = autofix.packageFolder;
        }
        autofixCleanup = autofix.cleanup;
        // ★ THE CLEANING PASS ALSO DROPS FILES, AND IT SAID NOTHING.
        //
        //   `copyClean` refuses to copy symlinks and never-publish names into
        //   the scan copy — correct, that is how outside bytes stay outside —
        //   but `autofix.excluded` had no reader here, so those files simply
        //   were not in the package and were not in the report either. Measured
        //   2026-08-18: a symlink escape ended as `verdict: "pass"`, zero
        //   findings, `remediation` naming only an unrelated rewrite.
        //
        //   Build and cache directories stay silent — nobody publishes
        //   `node_modules` on purpose and listing it is noise. What the person
        //   actually placed in the folder gets named.
        for (const droppedPath of autofix.excluded) {
          const dirParts = droppedPath.split("/").slice(0, -1);
          if (dirParts.some((part) => AUTOFIX_SILENT_DROP_DIRS.has(part))) continue;
          if (AUTOFIX_SILENT_DROP_DIRS.has(droppedPath)) continue;
          remediationActions.push({
            file: droppedPath,
            action: "excluded",
            detail: "left out during cleaning — a symlink, a never-publish name, or a path that could not be copied safely",
          });
        }
        // A missing/invalid routing card is a hard blocker added outside the scan
        // (the loop can't reach it) — auto-generate one so no agent dead-ends on it.
        const purposeInput = input.purposeAnswer
          ? await normalizePurposeAnswerWithSubmitterRuntime(scanRoot, input.purposeAnswer)
          : undefined;
        // 라우팅 카드는 공개 발행에만 요구된다(readRoutingCard 호출 자체가 공개 전용).
        if (isPublicHubPublish && ensureRoutingCard(scanRoot, purposeInput)) {
          opts?.onStage?.("routing-card");
          remediationActions.push({ file: ROUTING_CARD_PATH, action: "rewritten", detail: "auto-generated routing card" });
        }
        // "No agent definition file" is a blocker that names no file, so the
        // remediation loop below can never reach it — the same blind-spot family
        // as the whole-package size limits. hep-upload scaffolds this from its
        // package contract; Desktop refused the upload instead. Write the
        // minimal definition from what the package already says about itself.
        if (ensureAgentDefinitionFile(scanRoot)) {
          remediationActions.push({ file: "AGENTS.md", action: "rewritten", detail: "auto-generated agent definition" });
        }
        // Generic convergence loop against the real publish gate — the model fixes
        // each offending file (redact secrets to placeholders, defang installers,
        // rewrite), escalating to deterministic redaction then exclude, so ANY
        // agent ends in an uploadable package instead of a dead-end blocker.
        const outcome = await remediateUntilClean(
          scanRoot,
          restoredExecutablePaths,
          active,
          opts?.locale ?? "ko",
          opts?.onStage,
        );
        remediationActions.push(...outcome.actions);
        // ★ THE LOOP ABOVE ONLY SEES BLOCKERS THAT NAME A FILE.
        //   `remediateUntilClean` filters on `!!f.file`, so the two whole-package
        //   limits — more than MAX_FILES files, more than MAX_TOTAL_BYTES total —
        //   were invisible to every pass INCLUDING the last-resort exclude. A
        //   folder over either limit could not be repaired and could not be
        //   published: the upload ended "blocked", and the only remaining fix was
        //   the person hand-deleting files until they guessed their way under a
        //   limit the screen never states. Owner, 2026-08-18: that is exactly what
        //   packaging is supposed to do for them.
        remediationActions.push(...trimPackageToLimits(scanRoot, restoredExecutablePaths, opts?.onStage));
      } else {
        autofix.cleanup();
      }
    } catch {
      /* fall back to publishing the original folder unchanged */
    }
  }
  stage("scanning");
  const scan = scanAgentFolder(scanRoot, restoredExecutablePaths);
  stage("scanning", String(scan.files.length));
  const snapshot = packageSnapshot(scan.included);
  let routingCard: ReturnType<typeof readRoutingCard> = {};
  let careerGraphCard: CloudAgentPublicCareerGraph | undefined;
  if (isPublicHubPublish) {
    scan.findings.unshift(...publicCareerPrepareFindings);
    routingCard = readRoutingCard(snapshot);
    if (routingCard.finding) scan.findings.push(routingCard.finding);
    careerGraphCard = readPublicCareerGraphCard(snapshot, visibility, scan.findings);
    replacePublicCareerCardWithSanitizedSnapshot(scan, careerGraphCard);
  }
  const finalSnapshot = packageSnapshot(scan.included);
  const name = readName(finalSnapshot, path.basename(rootPath));
  const tagline = readTagline(finalSnapshot);
  let localized = readLocalizedListing(finalSnapshot);
  // Public publish auto-translates missing bilingual metadata with the user's
  // connected model by default — never a dead-end that demands hand-editing
  // agent-card.json. (Was gated behind reviewMode "local-runtime", which the
  // publish path never set, so the localized blocker was unavoidable.)
  if (isPublicHubPublish && localizedListingProblems(localized).length > 0) {
    stage("metadata");
    localized = await generateLocalizedListingWithSubmitterRuntime(rootPath, name, tagline);
  }
  if (isPublicHubPublish) {
    const problems = localizedListingProblems(localized);
    if (problems.length > 0) {
      scan.findings.push({
        id: "localized-metadata-required",
        severity: "blocker",
        category: "structure",
        file: ".agentlas/agent-card.json",
        message: `Public Hub metadata needs verified English and Korean fields: ${problems.join(", ")}.`,
        remediation:
          "Add localized.titleEn, titleKo, descriptionEn, and descriptionKo to .agentlas/agent-card.json, or use local-runtime review so Agentlas can translate them with your connected model.",
      });
    }
  }
  // ★ THE PUBLISHING SLUG IS THE PACKAGE'S OWN, NOT THE LOCAL REGISTRY ROW'S.
  //   Uploading a registered agent/team passed the registry slug through, and a
  //   locally imported team is stored as `firm-local-<folder>` (its CEO as
  //   `local-<folder>`, with a `-2` suffix on re-import). The same folder chosen
  //   through "Choose an agent folder" derived `quant-research-desk` from its
  //   agent-card, so ONE asset had two identities depending on which control the
  //   user clicked — and the second one is exactly what the server rejects as
  //   `slug_identity_conflict`. Measured 2026-08-18 on Quant Research Desk.
  // sanitizeSlug("")는 빈 문자열이 아니라 "agentlas-cloud-agent" 폴백을 돌려준다 —
  // 빈 후보를 먼저 걸러야 우선순위 체인이 산다. (dry-run e2e가 잡은 결함:
  // 모든 무명 업로드가 폴백 이름으로 발행될 뻔했다.)
  const callerSlug = input.slug?.trim() ? sanitizeSlug(input.slug) : "";
  const stableSlug = readStableSlug(finalSnapshot);
  const packageSlug = stableSlug ? sanitizeSlug(stableSlug) : "";
  const slug =
    (input.preferPackageSlug ? packageSlug || callerSlug : callerSlug || packageSlug)
    || sanitizeSlug(name || path.basename(rootPath));
  const cloudScope = scopeForVisibility(visibility);
  const markerRegistration = restoreMarker?.registrations?.[cloudScope];
  const baseRegistration = markerRegistration?.slug === slug ? markerRegistration : undefined;
  addSecretFindings(
    JSON.stringify({ name, tagline, slug, routingCard: routingCard.card, careerGraph: careerGraphCard }),
    "package.manifest.json",
    scan.findings,
  );
  if (input.notes) addSecretFindings(input.notes, "registration.notes", scan.findings);
  const packageFindings = isPublicHubPublish
    ? scan.findings
    : privateSaveSafetyFindings(scan.findings);
  const packageHash = hashPackage(scan.included);
  const manifest: CloudAgentPackageManifest & { routingCard?: Record<string, unknown> } = {
    version: MANIFEST_VERSION,
    kind: "agentlas-cloud-agent",
    slug,
    name,
    tagline,
    agentKind: inferAgentKind(finalSnapshot),
    runtimeLabels: detectRuntimeLabelsFromPaths(finalSnapshot.keys()),
    visibility,
    // Content-derived only. Never upload a hash of the owner's absolute local path.
    rootFingerprint: sha256(`agentlas-package-root:${packageHash}`),
    packageHash,
    packageHashVersion: PACKAGE_HASH_VERSION,
    fileCount: scan.files.length,
    includedFileCount: scan.included.length,
    // 업로드되는 bundle은 included 파일만 담는다. 서버 register는 받은 bundle의
    // bytes 합을 totalBytes로 검증하므로, manifest.totalBytes도 included 기준이어야
    // 한다. (scan.totalBytes는 제외 파일까지 포함한 전체 — MAX_TOTAL_BYTES 게이트용.)
    totalBytes: scan.included.reduce((sum, file) => sum + file.bytes, 0),
    createdAt: new Date().toISOString(),
    billingMode: isPublicHubPublish && input.reviewMode === "local-runtime" ? "submitter-local-runtime" : "static-only",
    costOwner: isPublicHubPublish && input.reviewMode === "local-runtime" ? "submitter" : "none",
    ...(localized ? { localized } : {}),
    // Declared on every save, private included — see the manifest field's note.
    ...(forkLineage ? { fork: forkLineage } : {}),
    security: summarizeSecurity(packageFindings),
    ...(routingCard.card ? { routingCard: routingCard.card } : {}),
    ...(careerGraphCard ? { careerGraph: careerGraphCard } : {}),
  };

  stage("packaging", String(scan.included.length));
  const packageDir = packageOutputDir(slug);
  fs.mkdirSync(packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "package.manifest.json");
  const bundlePath = path.join(packageDir, "package.bundle.json");

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    bundlePath,
    JSON.stringify(
      {
        manifest,
        files: scan.included,
        source: {
          packagedBy: "agentlas-desktop",
          packagedAt: manifest.createdAt,
          costOwner: manifest.costOwner,
        },
        ...(careerGraphCard ? { careerGraph: careerGraphCard } : {}),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  stage("reviewing");
  const review =
    isPublicHubPublish && input.reviewMode === "local-runtime"
      ? await runSubmitterRuntimeReview(rootPath, manifest, packageFindings)
      : staticReview(packageFindings, isPublicHubPublish ? "hub-public" : "owner-private");
  manifest.security = summarizeSecurity(review.findings);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    bundlePath,
    JSON.stringify(
      {
        manifest,
        files: scan.included,
        source: {
          packagedBy: "agentlas-desktop",
          packagedAt: manifest.createdAt,
          costOwner: manifest.costOwner,
        },
        ...(careerGraphCard ? { careerGraph: careerGraphCard } : {}),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const blocked = isBlocked(packageFindings, review);
  const dryRun = input.dryRun ?? false;

  let registration: CloudAgentRegistrationResult | undefined;
  let effectiveSlug = slug;
  let status: CloudAgentPackageResult["status"] = blocked ? "blocked" : dryRun ? "dry-run" : "ready";
  if (!blocked && !dryRun) {
    stage("uploading", slug);
    // A confirmation answers ONE question about ONE folder. Main re-reads the
    // target it stored when it asked; the renderer only ever says "yes".
    const confirmedOverwrite = input.confirmOverwrite
      ? readPendingOverwriteTarget(rootPath) ?? undefined
      : undefined;
    if (input.confirmOverwrite && !confirmedOverwrite) {
      throw new OwnerCloudActionError(
        "cloud_overwrite_target_expired",
        "That confirmation no longer matches anything. Upload again to see what is currently in your Cloud.",
        { retryable: false, actionState: "not-committed" },
      );
    }
    registration = await registerCloudAgent({
      manifest,
      bundlePath,
      review,
      visibility,
      notes: input.notes,
      baseRegistration,
      rootPath,
      ...(confirmedOverwrite ? { confirmedOverwrite } : {}),
    });
    // 방금 선반이 바뀌었다. 캐시를 두면 사용자는 자기가 올린 에이전트가 없는
    // 목록을 최대 5분 동안 보게 된다.
    invalidateMyAgentsCache();
    // A self-repaired publish may have landed on the package's canonical slug
    // rather than the one this run asked for. The receipt marker is keyed by
    // slug (`markerRegistration?.slug === slug`), so writing the requested slug
    // here would strand the receipt and make the NEXT save look like a create
    // all over again — the same dead end, one run later.
    if (registration.slug !== slug) {
      effectiveSlug = registration.slug;
      manifest.slug = registration.slug;
      try {
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      } catch {
        // The local manifest copy is a convenience artifact; the server receipt
        // below is the authority for what was actually published.
      }
    }
    stage("receipt");
    try {
      writeCloudAgentRegistrationMarker({
        rootPath,
        slug: effectiveSlug,
        packageHash: manifest.packageHash,
        packageHashVersion: manifest.packageHashVersion,
        fileCount: manifest.includedFileCount,
        totalBytes: manifest.totalBytes,
        executablePaths: scan.included.filter((file) => file.executable).map((file) => file.path),
        registration,
        savedAt: registration.registeredAt,
      });
      registration.localSyncStored = true;
    } catch (error) {
      registration.localSyncStored = false;
      review.findings.push({
        id: "cloud-revision-receipt-not-saved",
        severity: "high",
        category: "runtime",
        message: "Agent Cloud committed the package, but Desktop could not save its local revision receipt.",
        remediation:
          "Restore the latest Cloud copy before editing or saving this slug again; otherwise optimistic concurrency will block the next write.",
      });
      console.warn("Agent Cloud revision receipt could not be saved", error instanceof Error ? error.message : String(error));
    }
    status = "registered";
  }

  if (autofixCleanup) autofixCleanup();
  stage(status === "registered" ? "done" : "error", status);
  return {
    status,
    rootPath,
    packageDir,
    bundlePath,
    manifestPath,
    manifest,
    files: scan.files,
    review,
    registration,
    ...(remediationActions.length ? { remediation: remediationActions } : {}),
    summary:
      status === "registered"
        ? (isPublicHubPublish
            ? `Published ${effectiveSlug} publicly to Agentlas Hub.`
            : `Saved ${effectiveSlug} privately in Agent Cloud.`)
          + summarizeRemediation(remediationActions, opts?.locale ?? "en")
          + (registration?.autoRecovered?.length ? ` ${registration.autoRecovered.join(" ")}` : "")
        : status === "blocked"
          ? isPublicHubPublish
            ? `Hub publish blocked: ${review.summary}`
            : `Private Agent Cloud save blocked: ${review.summary}`
          // "ready" is where auto-fix's own edits used to go unmentioned: the
          // sentence was assembled without `summarizeRemediation`, so a dry run
          // that dropped a file still read as a clean package.
          : (isPublicHubPublish
              ? `Hub package ready: ${slug}.`
              : `Private Agent Cloud package ready: ${slug}.`)
            + summarizeRemediation(remediationActions, opts?.locale ?? "en"),
  };
}

function scanAgentFolder(rootPath: string, restoredExecutablePaths: ReadonlySet<string>): StaticScanResult {
  const files: CloudAgentPackageFile[] = [];
  const included: PackagedFile[] = [];
  const findings: CloudAgentSecurityFinding[] = [];
  // `totalBytes` stays the authored size (what the folder weighs on disk);
  // `transportBytes` is what the package actually costs to send and store, and
  // that is what the ceiling is about.
  let totalBytes = 0;
  let transportBytes = 0;
  let seenFiles = 0;
  let hasAgentDef = false;
  const portableFiles = new Map<string, string>();
  const portableDirectories = new Map<string, string>();

  const isInsideRoot = (candidate: string): boolean => {
    const relative = path.relative(rootPath, candidate);
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const readStableFile = (file: string): { bytes: Buffer; executable: boolean } => {
    const beforeReal = fs.realpathSync.native(file);
    if (!isInsideRoot(beforeReal)) throw new Error("file resolves outside the approved package root");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) throw new Error("package entry is not a regular file");
      if (before.size > MAX_UNCOMPRESSED_FILE_BYTES) throw new Error(`file exceeds ${MAX_UNCOMPRESSED_FILE_BYTES} bytes`);
      const chunks: Buffer[] = [];
      let actualBytes = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_UNCOMPRESSED_FILE_BYTES + 1 - actualBytes));
        if (chunk.byteLength <= 0) throw new Error(`file exceeds ${MAX_UNCOMPRESSED_FILE_BYTES} bytes`);
        const read = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
        if (read === 0) break;
        actualBytes += read;
        if (actualBytes > MAX_UNCOMPRESSED_FILE_BYTES) throw new Error(`file exceeds ${MAX_UNCOMPRESSED_FILE_BYTES} bytes`);
        chunks.push(chunk.subarray(0, read));
      }
      const after = fs.fstatSync(fd);
      const afterReal = fs.realpathSync.native(file);
      const pathStat = fs.statSync(file);
      if (
        !isInsideRoot(afterReal) ||
        beforeReal !== afterReal ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.mode !== after.mode ||
        after.dev !== pathStat.dev ||
        after.ino !== pathStat.ino ||
        after.mode !== pathStat.mode ||
        actualBytes !== after.size
      ) {
        throw new Error("package entry changed while it was being read");
      }
      return {
        bytes: Buffer.concat(chunks, actualBytes),
        executable: portableExecutableForHost(
          process.platform,
          after.mode,
          restoredExecutablePaths.has(normalizeRelative(rootPath, file)),
        ),
      };
    } finally {
      fs.closeSync(fd);
    }
  };

  function walk(dir: string): void {
    const directoryBefore = fs.lstatSync(dir);
    const directoryRealBefore = fs.realpathSync.native(dir);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || !isInsideRoot(directoryRealBefore)) {
      throw new Error("package directory is not a stable directory inside the approved root");
    }
    const relDir = normalizeRelative(rootPath, dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("._")) continue;
      const abs = path.join(dir, entry.name);
      const rel = normalizeRelative(rootPath, abs);
      if (entry.isSymbolicLink()) {
        findings.push({
          id: findingId("symlink", rel),
          severity: "blocker",
          category: "policy",
          file: rel,
          message: "Symbolic links are not allowed in cloud agent packages.",
          remediation: "Replace the symlink with an ordinary file or remove it from the package.",
        });
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "symlink-blocked" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        try {
          const realDirectory = fs.realpathSync.native(abs);
          const current = fs.lstatSync(abs);
          if (!current.isDirectory() || current.isSymbolicLink() || !isInsideRoot(realDirectory)) {
            throw new Error("directory resolves outside the approved package root");
          }
          walk(realDirectory);
        } catch (error) {
          findings.push({
            id: findingId("unsafe-directory", rel),
            severity: "blocker",
            category: "policy",
            file: rel,
            message: `Package directory could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
            remediation: "Remove linked or concurrently changing directories and retry.",
          });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      seenFiles += 1;
      if (seenFiles > MAX_FILES) {
        findings.push({
          id: "file-count-limit",
          severity: "blocker",
          category: "size",
          message: `Package has more than ${MAX_FILES} files.`,
          remediation: "Publish a focused agent/team folder instead of the whole repository.",
        });
        continue;
      }
      if (AGENT_DEF_FILES.has(entry.name)) hasAgentDef = true;
      const st = fs.statSync(abs);
      const portablePathProblem = registerPortablePackagePath(rel, portableFiles, portableDirectories);
      if (portablePathProblem) {
        findings.push({
          id: findingId(portablePathProblem.id, rel),
          severity: "blocker",
          category: "policy",
          file: rel,
          message: portablePathProblem.message,
          remediation: "Rename the file or parent folder to one portable NFC path and retry.",
        });
        files.push({
          path: rel,
          bytes: st.size,
          sha256: "",
          kind: "binary",
          included: false,
          reason: portablePathProblem.id,
        });
        continue;
      }
      if (rel.toLowerCase() === DESKTOP_RESTORE_MARKER_PATH.toLowerCase()) {
        files.push({
          path: rel,
          bytes: st.size,
          sha256: "",
          kind: "text",
          included: false,
          reason: "desktop-restore-marker-excluded",
        });
        continue;
      }
      if (isLocalExperienceLineagePath(rel)) {
        files.push({
          path: rel,
          bytes: st.size,
          sha256: "",
          kind: "text",
          included: false,
          reason: "experience-lineage-separate-asset",
        });
        continue;
      }
      if (isMachineLocalStatePath(rel)) {
        files.push({
          path: rel,
          bytes: st.size,
          sha256: "",
          kind: "binary",
          included: false,
          reason: "machine-local-state",
        });
        continue;
      }
      // A run output, not a capability. Regenerates on the installer's machine.
      if (isRegeneratedWorkOutputPath(rel)) {
        files.push({
          path: rel,
          bytes: st.size,
          sha256: "",
          kind: "binary",
          included: false,
          reason: "work-output-regenerated",
        });
        continue;
      }
      // The product's own .gitignore keeps these out of git; publishing is
      // further than committing, so it keeps them out of packages too.
      if (isProductPrivateFolderPath(rel)) {
        files.push({
          path: rel,
          bytes: st.size,
          sha256: "",
          kind: "binary",
          included: false,
          reason: "product-private-folder",
        });
        continue;
      }
      totalBytes += st.size;
      const blockedName = BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(entry.name));
      if (blockedName) {
        findings.push({
          id: findingId("blocked-file", rel),
          severity: "blocker",
          category: "secret",
          file: rel,
          message: "Secret-bearing file names are not allowed in cloud packages.",
          remediation: "Remove credentials and publish only instructions or env key names.",
        });
        files.push({ path: rel, bytes: st.size, sha256: "", kind: "binary", included: false, reason: "secret-file-blocked" });
        continue;
      }
      // Refuse early only what cannot fit even at the best compression ratio we
      // are willing to assume. Anything smaller is read, compressed, and judged
      // on what it actually costs — that is how a 600 KB knowledge file, which
      // gzips to well under the per-file limit, now ships instead of being
      // silently deleted by the repair pass.
      if (st.size > MAX_UNCOMPRESSED_FILE_BYTES) {
        findings.push({
          id: findingId("large-file", rel),
          severity: "blocker",
          category: "size",
          file: rel,
          message: `File exceeds ${MAX_UNCOMPRESSED_FILE_BYTES} bytes.`,
          remediation: "Move large assets to a documented external source or reduce the package.",
        });
        files.push({ path: rel, bytes: st.size, sha256: "", kind: "binary", included: false, reason: "file-too-large" });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isText = TEXT_EXTENSIONS.has(ext) || AGENT_DEF_FILES.has(entry.name);
      let bytes: Buffer;
      let executable = false;
      try {
        const stable = readStableFile(abs);
        bytes = stable.bytes;
        executable = stable.executable;
      } catch (error) {
        findings.push({
          id: findingId("unstable-file", rel),
          severity: "blocker",
          category: "policy",
          file: rel,
          message: `Package file could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
          remediation: "Remove linked or concurrently changing files and retry.",
        });
        files.push({ path: rel, bytes: st.size, sha256: "", kind: isText ? "text" : "binary", included: false, reason: "unstable-file" });
        continue;
      }
      totalBytes += bytes.length - st.size;
      const digest = sha256(bytes);
      addSecretFindingsFromBytes(bytes, rel, findings);
      if (!isText) {
        {
          const encoded = encodePackagedContent(bytes);
          const stored = encoded.encodedBytes ?? bytes.length;
          if (stored > MAX_FILE_BYTES) {
            findings.push({
              id: findingId("large-file", rel),
              severity: "blocker",
              category: "size",
              file: rel,
              message: `File is ${stored} bytes even after compression, over the ${MAX_FILE_BYTES} byte limit.`,
              remediation: "Move large assets to a documented external source or reduce the package.",
            });
            files.push({ path: rel, bytes: bytes.length, sha256: "", kind: "binary", included: false, reason: "file-too-large" });
            continue;
          }
          transportBytes += stored;
          files.push({ path: rel, bytes: bytes.length, sha256: digest, kind: "binary", executable, included: true });
          included.push({ path: rel, bytes: bytes.length, sha256: digest, executable, ...encoded });
        }
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        findings.push({
          id: findingId("invalid-utf8", rel),
          severity: "blocker",
          category: "policy",
          file: rel,
          message: "A text agent asset is not valid UTF-8.",
          remediation: "Save the file as UTF-8 before storing or publishing the agent package.",
        });
        files.push({ path: rel, bytes: st.size, sha256: digest, kind: "text", included: false, reason: "invalid-utf8" });
        continue;
      }
      if (/(?:curl|wget)[^\n|&;]+[|]\s*(?:sh|bash)/i.test(text)) {
        findings.push({
          id: findingId("curl-pipe-shell", rel),
          severity: "high",
          category: "network",
          file: rel,
          message: "Remote shell install pattern detected.",
          remediation: "Replace curl|sh style commands with explicit, reviewable install steps.",
        });
      }
      {
        const encoded = encodePackagedContent(bytes);
        const stored = encoded.encodedBytes ?? bytes.length;
        if (stored > MAX_FILE_BYTES) {
          findings.push({
            id: findingId("large-file", rel),
            severity: "blocker",
            category: "size",
            file: rel,
            message: `File is ${stored} bytes even after compression, over the ${MAX_FILE_BYTES} byte limit.`,
            remediation: "Move large assets to a documented external source or reduce the package.",
          });
          files.push({ path: rel, bytes: bytes.length, sha256: "", kind: "text", included: false, reason: "file-too-large" });
          continue;
        }
        transportBytes += stored;
        files.push({ path: rel, bytes: bytes.length, sha256: digest, kind: "text", executable, included: true });
        included.push({ path: rel, bytes: bytes.length, sha256: digest, executable, ...encoded });
      }
    }
    const directoryAfter = fs.lstatSync(dir);
    const directoryRealAfter = fs.realpathSync.native(dir);
    if (
      !directoryAfter.isDirectory() ||
      directoryAfter.isSymbolicLink() ||
      !isInsideRoot(directoryRealAfter) ||
      directoryRealBefore !== directoryRealAfter ||
      directoryBefore.dev !== directoryAfter.dev ||
      directoryBefore.ino !== directoryAfter.ino ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryBefore.ctimeMs !== directoryAfter.ctimeMs
    ) {
      findings.push({
        id: findingId("unstable-directory", relDir),
        severity: "blocker",
        category: "policy",
        file: relDir,
        message: "Package directory changed while it was being scanned.",
        remediation: "Stop concurrent package edits, remove links, and retry.",
      });
    }
    if (relDir === ".") {
      files.sort((a, b) => a.path.localeCompare(b.path));
      included.sort((a, b) => a.path.localeCompare(b.path));
    }
  }

  walk(rootPath);
  if (!hasAgentDef) {
    findings.push({
      id: "missing-agent-definition",
      severity: "blocker",
      category: "structure",
      message: "No Agentlas/Claude/Codex/Gemini agent definition file was found.",
      remediation: "Add AGENTS.md, CLAUDE.md, GEMINI.md, AGENT.md, or README.md at the package root.",
    });
  }
  if (totalBytes > MAX_UNCOMPRESSED_TOTAL_BYTES) {
    findings.push({
      id: "package-uncompressed-size-limit",
      severity: "blocker",
      category: "size",
      message: `Package contents exceed ${MAX_UNCOMPRESSED_TOTAL_BYTES} bytes before compression.`,
      remediation: "Publish a focused agent or team folder.",
    });
  }
  if (transportBytes > MAX_TOTAL_BYTES) {
    findings.push({
      id: "package-size-limit",
      severity: "blocker",
      category: "size",
      message: `Package exceeds ${MAX_TOTAL_BYTES} bytes.`,
      remediation: "Publish a smaller agent folder and keep generated artifacts out of the package.",
    });
  }

  return { files, included, findings, totalBytes };
}

export function scanCloudAgentFolderForLocalReview(rootPathValue: string): CloudAgentLocalReviewScan {
  const rootPath = resolveCloudAgentRoot(rootPathValue);
  const restoreMarker = readCloudAgentRestoreMarker(rootPath);
  const restoredExecutablePaths = new Set(
    restoreMarker?.packageHashVersion === PACKAGE_HASH_VERSION
      ? restoreMarker.executablePaths ?? []
      : [],
  );
  const scan = scanAgentFolder(rootPath, restoredExecutablePaths);
  return {
    rootPath,
    packageHash: hashPackage(scan.included),
    files: scan.files.map((file) => ({ ...file })),
    included: scan.included.map((file) => ({ ...file })),
    findings: scan.findings.map((finding) => ({ ...finding })),
    totalBytes: scan.totalBytes,
  };
}

export function portableExecutableForHost(
  platform: NodeJS.Platform,
  mode: number,
  restoredMarkerValue: boolean,
): boolean {
  return platform === "win32" ? restoredMarkerValue : (mode & 0o111) !== 0;
}

function packageSnapshot(files: PackagedFile[]): PackageSnapshot {
  return new Map(files.map((file) => [file.path, file]));
}

function registerPortablePackagePath(
  relativePath: string,
  files: Map<string, string>,
  directories: Map<string, string>,
): { id: string; message: string } | null {
  const unsafe = portablePackagePathProblem(relativePath);
  if (unsafe) return { id: "unsafe-path", message: unsafe };

  const parts = relativePath.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  for (const ancestor of ancestors) {
    const key = portablePathKey(ancestor);
    const existingDirectory = directories.get(key);
    if (existingDirectory && existingDirectory !== ancestor) {
      return {
        id: "path-alias",
        message: `Parent folders ${existingDirectory} and ${ancestor} collide on a supported desktop filesystem.`,
      };
    }
    if (files.has(key)) {
      return {
        id: "path-type-collision",
        message: `${ancestor} is used as both a file and a folder on a supported desktop filesystem.`,
      };
    }
  }

  const fileKey = portablePathKey(relativePath);
  const existingFile = files.get(fileKey);
  if (existingFile) {
    return {
      id: "duplicate-path",
      message: `Files ${existingFile} and ${relativePath} collide on a supported desktop filesystem.`,
    };
  }
  if (directories.has(fileKey)) {
    return {
      id: "path-type-collision",
      message: `${relativePath} is used as both a file and a folder on a supported desktop filesystem.`,
    };
  }

  for (const ancestor of ancestors) directories.set(portablePathKey(ancestor), ancestor);
  files.set(fileKey, relativePath);
  return null;
}

export function portablePackagePathProblem(value: string): string | null {
  if (!value || value !== value.normalize("NFC")) return "Package paths must use Unicode NFC normalization.";
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.endsWith("/")) {
    return "Package path is not a portable relative path.";
  }
  if (value.includes("//") || value.length > 260) return "Package path exceeds the supported portable path contract.";
  for (const part of value.split("/")) {
    if (!part || part === "." || part === "..") return "Package path contains an unsafe segment.";
    if (/[<>:\"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)) {
      return "Package path contains characters or a trailing suffix unsupported by a target desktop.";
    }
    if (part.length > 255 || Buffer.byteLength(part, "utf8") > 255) {
      return "Package path component exceeds the supported desktop limit.";
    }
    if (hasUnpairedSurrogate(part)) return "Package path contains invalid Unicode.";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      return "Package path uses a reserved desktop name.";
    }
  }
  return null;
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function readSnapshotText(snapshot: PackageSnapshot, relativePath: string): string {
  const file = snapshot.get(relativePath);
  if (!file) return "";
  return decodePackagedContent(file).toString("utf8");
}

function addSecretFindings(
  text: string,
  relativePath: string,
  findings: CloudAgentSecurityFinding[],
): void {
  for (const pattern of SECRET_PATTERNS) {
    if (!pattern.re.test(text)) continue;
    const id = findingId(pattern.id, relativePath);
    if (findings.some((finding) => finding.id === id)) continue;
    findings.push({
      id,
      severity: "blocker",
      category: "secret",
      file: relativePath,
      message: `Possible ${pattern.label} found in package content.`,
      remediation: "Remove the secret value and require users to configure their own key through Agentlas env/BYOK vault.",
    });
  }
  addStructuredCredentialFinding(text, relativePath, findings);
}

function addSecretFindingsFromBytes(
  bytes: Buffer,
  relativePath: string,
  findings: CloudAgentSecurityFinding[],
): void {
  const candidates = new Set<string>([bytes.toString("utf8")]);
  const utf16 = decodeUtf16CredentialText(bytes);
  if (utf16) candidates.add(utf16);
  for (const text of candidates) addSecretFindings(text, relativePath, findings);
}

function decodeUtf16CredentialText(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)).toString("utf16le");
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
    body.swap16();
    return body.toString("utf16le");
  }
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096);
  if (sampleLength < 8) return null;
  let oddNuls = 0;
  let evenNuls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenNuls += 1;
    if (bytes[index + 1] === 0) oddNuls += 1;
  }
  const pairs = sampleLength / 2;
  const evenLength = bytes.length - (bytes.length % 2);
  if (oddNuls / pairs > 0.3) return bytes.subarray(0, evenLength).toString("utf16le");
  if (evenNuls / pairs > 0.3) {
    const body = Buffer.from(bytes.subarray(0, evenLength));
    body.swap16();
    return body.toString("utf16le");
  }
  return null;
}

function addStructuredCredentialFinding(
  text: string,
  relativePath: string,
  findings: CloudAgentSecurityFinding[],
): void {
  const assignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)\b["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s#;,]+))/gi;
  for (const match of text.matchAll(assignment)) {
    const value = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!isLikelyRealCredentialValue(value)) continue;
    pushSecretFinding("generic-unquoted-secret", "unquoted credential value", relativePath, findings);
    break;
  }
  const urlQueryCredential = /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password)=([^&#\s]+)/gi;
  for (const match of text.matchAll(urlQueryCredential)) {
    if (!isLikelyRealCredentialValue(String(match[1] ?? ""))) continue;
    pushSecretFinding("url-query-credential", "credential embedded in a URL query", relativePath, findings);
    break;
  }
  const urlCredential = /\bhttps?:\/\/[^/\s:@]+:([^@\s/]{8,})@/gi;
  for (const match of text.matchAll(urlCredential)) {
    if (!isLikelyRealCredentialValue(String(match[1] ?? ""))) continue;
    pushSecretFinding("url-credential", "credential embedded in a URL", relativePath, findings);
    break;
  }
}

function isLikelyRealCredentialValue(value: string): boolean {
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original value when it is not URL encoded.
  }
  if (value.length < 8) return false;
  if (/^(?:\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]+\}\}|<[^>]+>)$/i.test(value)) return false;
  if (/^(?:process\.env\.|os\.environ|env\(|secret\(|vault:)/i.test(value)) return false;
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (/^(?:your|example|sample|dummy|placeholder|changeme|replaceme|replacewith|redacted|masked|none|null|undefined|x+|star+)(?:api)?(?:key|secret|token|password)?(?:here)?$/.test(compact)) {
    return false;
  }
  if (/^(?:\*+|x+|_+|-+)$/.test(value)) return false;
  if (/(?:placeholder|configure|replace[_-]?me|replace[_-]?with|your[_-]|example|sample|redacted|not[_-]?a[_-]?real|changeme|change[_-]?me)/i.test(value)) {
    return false;
  }
  return true;
}

function pushSecretFinding(
  kind: string,
  label: string,
  relativePath: string,
  findings: CloudAgentSecurityFinding[],
): void {
  const id = findingId(kind, relativePath);
  if (findings.some((finding) => finding.id === id)) return;
  findings.push({
    id,
    severity: "blocker",
    category: "secret",
    file: relativePath,
    message: `Possible ${label} found in package content.`,
    remediation: "Replace the value with an environment/BYOK placeholder and keep the real credential in the OS keychain.",
  });
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePackagedFiles(left: PackagedFile, right: PackagedFile): number {
  return comparePaths(left.path, right.path);
}

function isRegularFileInsideRoot(rootPath: string, candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const real = fs.realpathSync.native(candidate);
    const relative = path.relative(rootPath, real);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function preparePublicCareerGraphCard(rootPath: string): Promise<CloudAgentSecurityFinding[]> {
  const agentlasDir = path.join(rootPath, ".agentlas");
  const publicCard = path.join(agentlasDir, "public-career-card.json");
  // Any existing entry (including a link) is left for the stable package scan
  // to accept or block. Never invoke the generator through a linked card path.
  try {
    fs.lstatSync(publicCard);
    return [];
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") return [];
  }
  const markers = [
    path.join(agentlasDir, "career-graph.json"),
    path.join(agentlasDir, "career-graph-sources.json"),
    path.join(agentlasDir, "career-graph.sqlite"),
  ];
  if (!markers.some((marker) => isRegularFileInsideRoot(rootPath, marker))) return [];
  try {
    const { careerGraph } = await import("../hephaestus/commands");
    await careerGraph(["ingest"], { project: rootPath, cwd: rootPath, timeoutMs: 20_000 });
    await careerGraph(["public-card", "--write"], { project: rootPath, cwd: rootPath, timeoutMs: 20_000 });
    return [];
  } catch {
    return [
      {
        id: "career-card-auto-generate-failed",
        severity: "info",
        category: "review",
        file: ".agentlas/public-career-card.json",
        message: "Career Graph public card could not be generated during desktop packaging.",
        remediation: "Run `career-graph ingest --project .` and `career-graph public-card --write --project .` before publishing.",
      },
    ];
  }
}

function readPublicCareerGraphCard(
  snapshot: PackageSnapshot,
  visibility: CloudAgentVisibility,
  findings: CloudAgentSecurityFinding[],
): CloudAgentPublicCareerGraph | undefined {
  const rel = ".agentlas/public-career-card.json";
  if (!snapshot.has(rel)) return undefined;
  const text = readSnapshotText(snapshot, rel);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    findings.push({
      id: "career-card-invalid-json",
      severity: visibility === "marketplace" ? "blocker" : "high",
      category: "structure",
      file: rel,
      message: "Career Graph public card is not valid JSON.",
      remediation: "Regenerate it with `career-graph public-card --write --project .`.",
    });
    return undefined;
  }
  if (!isRecord(parsed) || parsed.kind !== "agentlas-public-career-card") {
    findings.push({
      id: "career-card-invalid-kind",
      severity: visibility === "marketplace" ? "blocker" : "high",
      category: "structure",
      file: rel,
      message: "Career Graph public card has an invalid kind.",
      remediation: "Regenerate it with `career-graph public-card --write --project .`.",
    });
    return undefined;
  }
  const privacy = isRecord(parsed.privacy) ? parsed.privacy : {};
  const privacyKeys = ["rawLocalPathsIncluded", "rawPromptsIncluded", "rawTranscriptsIncluded", "sourceTextIncluded"];
  for (const key of privacyKeys) {
    if (privacy[key] !== false) {
      findings.push({
        id: findingId(`career-card-privacy-${key}`, rel),
        severity: visibility === "marketplace" ? "blocker" : "high",
        category: "policy",
        file: rel,
        message: `Career Graph public card must set privacy.${key}=false.`,
        remediation: "Do not publish raw local memory, prompts, transcripts, source text, or paths.",
      });
    }
  }
  const raw = JSON.stringify(parsed);
  if (containsAbsoluteLocalPath(raw)) {
    findings.push({
      id: findingId("career-card-local-path", rel),
      severity: visibility === "marketplace" ? "blocker" : "high",
      category: "policy",
      file: rel,
      message: "Career Graph public card contains a local absolute path.",
      remediation: "Regenerate the redacted public card before publishing.",
    });
  }
  if (findings.some((finding) => finding.id.startsWith("career-card-") && finding.severity === "blocker")) {
    return undefined;
  }
  return sanitizePublicCareerGraph(parsed);
}

/**
 * The generated public card is useful inside a borrowed package, but its raw
 * source may contain generator-only fields. Replace the captured file itself,
 * not only the manifest copy, so base64 bundle contents cannot bypass the
 * public projection.
 */
function replacePublicCareerCardWithSanitizedSnapshot(
  scan: StaticScanResult,
  card: CloudAgentPublicCareerGraph | undefined,
): void {
  const rel = ".agentlas/public-career-card.json";
  const existingIndex = scan.included.findIndex((file) => file.path === rel);
  if (existingIndex >= 0) scan.included.splice(existingIndex, 1);

  const fileRecord = scan.files.find((file) => file.path === rel);
  if (!card) {
    if (fileRecord) {
      fileRecord.included = false;
      fileRecord.reason = "public-career-card-blocked";
    }
    return;
  }

  const bytes = Buffer.from(`${JSON.stringify(card, null, 2)}\n`, "utf8");
  const digest = sha256(bytes);
  scan.included.push({
    path: rel,
    bytes: bytes.length,
    sha256: digest,
    executable: false,
    ...encodePackagedContent(bytes),
  });
  scan.included.sort(comparePackagedFiles);
  if (fileRecord) {
    fileRecord.bytes = bytes.length;
    fileRecord.sha256 = digest;
    fileRecord.kind = "text";
    fileRecord.executable = false;
    fileRecord.included = true;
    delete fileRecord.reason;
  } else {
    scan.files.push({ path: rel, bytes: bytes.length, sha256: digest, kind: "text", included: true });
    scan.files.sort((a, b) => comparePaths(a.path, b.path));
  }
}

function sanitizePublicCareerGraph(parsed: Record<string, unknown>): CloudAgentPublicCareerGraph {
  const card: CloudAgentPublicCareerGraph = { kind: "agentlas-public-career-card" };
  const copyString = (key: "schemaVersion" | "generatedAt" | "projectName" | "indexStatus" | "policy", max: number): void => {
    const value = parsed[key];
    if (typeof value === "string" && value.length <= max) card[key] = value;
  };
  copyString("schemaVersion", 80);
  copyString("generatedAt", 80);
  copyString("projectName", 200);
  copyString("indexStatus", 80);
  copyString("policy", 160);

  card.privacy = {
    rawLocalPathsIncluded: false,
    rawPromptsIncluded: false,
    rawTranscriptsIncluded: false,
    sourceTextIncluded: false,
  };
  card.counts = sanitizeCountRecord(parsed.counts);
  card.sourceKinds = sanitizeCountRecord(parsed.sourceKinds);
  card.nodeTypes = sanitizeCountRecord(parsed.nodeTypes);
  card.edgeTypes = sanitizeCountRecord(parsed.edgeTypes);
  const canonicalSources = sanitizeCount(parsed.canonicalSources);
  const staleSourceCount = sanitizeCount(parsed.staleSourceCount);
  if (canonicalSources !== undefined) card.canonicalSources = canonicalSources;
  if (staleSourceCount !== undefined) card.staleSourceCount = staleSourceCount;
  return card;
}

function sanitizeCountRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value).slice(0, 200)) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) continue;
    const safeCount = sanitizeCount(count);
    if (safeCount !== undefined) result[key] = safeCount;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function containsAbsoluteLocalPath(value: string): boolean {
  const sensitiveRoots = [os.homedir()].filter(Boolean);
  return (
    sensitiveRoots.some((root) => value.includes(root)) ||
    /(?:^|["'\s:(])\/(?:Users|home|var|tmp|private|Volumes|opt|etc)\//i.test(value) ||
    /(?:^|["'\s:(])[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|["'\s:(])\\\\[^\\\s]+\\/.test(value)
  );
}

function privateSaveSafetyFindings(
  findings: CloudAgentSecurityFinding[],
): CloudAgentSecurityFinding[] {
  return findings.filter(
    (finding) =>
      (finding.severity === "blocker" && finding.id !== "missing-agent-definition") ||
      finding.category === "secret" ||
      finding.category === "size" ||
      /symlink|unsafe[-_]?path|path[-_]?escape|duplicate[-_]?path|hash|integrity/i.test(finding.id),
  );
}

function staticReview(
  findings: CloudAgentSecurityFinding[],
  scope: "owner-private" | "hub-public" = "hub-public",
): CloudAgentReviewResult {
  const blockers = findings.filter((f) => f.severity === "blocker");
  const high = findings.filter((f) => f.severity === "high");
  const verdict = blockers.length > 0 ? "fail" : high.length > 0 ? "needs-review" : "pass";
  const passedSummary =
    scope === "owner-private"
      ? "Private Agent Cloud safety checks passed."
      : "Static public package review passed without blocker findings.";
  return {
    mode: "static-only",
    verdict,
    costOwner: "none",
    summary:
      verdict === "pass"
        ? passedSummary
        : `${blockers.length} blocker(s), ${high.length} high-risk finding(s).`,
    findings,
    reviewedAt: new Date().toISOString(),
  };
}

function readRoutingCard(snapshot: PackageSnapshot): {
  card?: Record<string, unknown>;
  finding?: CloudAgentSecurityFinding;
} {
  if (!snapshot.has(ROUTING_CARD_PATH)) {
    return {
      finding: {
        id: "routing-card-required",
        severity: "blocker",
        category: "structure",
        file: ROUTING_CARD_PATH,
        message: "Cloud registration requires a Hephaestus Network routing card.",
        remediation: "Add .agentlas/routing-card.json before publishing. In Hephaestus packages, run the routing-card migration or package verifier.",
      },
    };
  }
  try {
    const parsed = JSON.parse(readSnapshotText(snapshot, ROUTING_CARD_PATH)) as unknown;
    if (!isRecord(parsed)) {
      return {
        finding: {
          id: "routing-card-invalid",
          severity: "blocker",
          category: "structure",
          file: ROUTING_CARD_PATH,
          message: "Routing card must be a JSON object.",
          remediation: "Replace .agentlas/routing-card.json with a routing-card/2.0 object.",
        },
      };
    }
    const problem = routingCardProblem(parsed);
    if (problem) {
      const needsPurpose = problem.startsWith("capabilities must");
      return {
        finding: {
          id: needsPurpose ? "agent-purpose-missing" : "routing-card-invalid",
          severity: "blocker",
          category: "structure",
          file: ROUTING_CARD_PATH,
          message: needsPurpose
            ? "What concrete work should this agent complete, and what should the finished result look like?"
            : `Routing card is invalid: ${problem}`,
          remediation: needsPurpose
            ? "Answer in ordinary words. Agentlas will turn the answer into the internal agent description and retry the upload."
            : "Fix .agentlas/routing-card.json before publishing.",
        },
      };
    }
    return { card: parsed };
  } catch {
    return {
      finding: {
        id: "routing-card-invalid-json",
        severity: "blocker",
        category: "structure",
        file: ROUTING_CARD_PATH,
        message: "Routing card is not valid JSON.",
        remediation: "Fix .agentlas/routing-card.json before publishing.",
      },
    };
  }
}

function routingCardProblem(card: Record<string, unknown>): string | null {
  if (card.schemaVersion !== "routing-card/2.0") return "schemaVersion must be routing-card/2.0";
  if (typeof card.id !== "string" || !card.id.trim()) return "id must be a non-empty string";
  if (card.type !== "agent" && card.type !== "team" && card.type !== "plugin") return "type must be agent, team, or plugin";
  if (typeof card.name !== "string" || !card.name.trim()) return "name must be a non-empty string";
  if (typeof card.summary !== "string" || !card.summary.trim()) return "summary must be a non-empty string";
  if (card.summary.length > 240) return "summary must be at most 240 characters";
  if (!Array.isArray(card.capabilities) || card.capabilities.length === 0) {
    return "capabilities must be a non-empty array";
  }
  for (const capability of card.capabilities) {
    if (typeof capability !== "string" || !ROUTING_CARD_CAPABILITY_RE.test(capability)) {
      return `capability ${JSON.stringify(capability)} must be snake_case with at least two words`;
    }
  }
  if (typeof card.routing_status !== "string" || !ROUTING_CARD_STATUSES.has(card.routing_status)) {
    return "routing_status must be draft, searchable, candidate, routing_ready, or trusted";
  }
  if (!isRecord(card.workforce)) return "workforce must be a complete semantic resume";
  const workforce = card.workforce;
  // `skills` has a floor of 0, not 1. Skills are modules and live outside the
  // core, so a fully modular agent legitimately declares none. Requiring one
  // here would block publishing every modular package. Kept identical in
  // agentlas_terminal/engine/cloud-assets/package.cjs — the two must not drift.
  const semanticLists: Array<[string, RegExp, number, number]> = [
    ["communities", /^community:[a-z0-9][a-z0-9-]*$/, 1, 5],
    ["roles", /^role:[a-z0-9][a-z0-9-]*$/, 0, 4],
    ["skills", /^skill:[a-z0-9][a-z0-9-]*$/, 0, 12],
    ["knowledge", /^knowledge:[a-z0-9][a-z0-9-]*$/, 0, 256],
  ];
  for (const [field, pattern, minimum, maximum] of semanticLists) {
    const values = workforce[field];
    if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
      return `workforce.${field} must contain ${minimum}-${maximum} English semantic IDs`;
    }
    if (new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string" || !pattern.test(value))) {
      return `workforce.${field} contains an invalid or duplicate semantic ID`;
    }
  }
  for (const field of ["languages", "modalities"]) {
    const values = workforce[field];
    if (!Array.isArray(values) || new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string")) {
      return `workforce.${field} must be a unique string array`;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runSubmitterRuntimeReview(
  rootPath: string,
  manifest: CloudAgentPackageManifest,
  staticFindings: CloudAgentSecurityFinding[],
): Promise<CloudAgentReviewResult> {
  const { pickActiveRunner } = await import("../mcp/client");
  const picked = await pickActiveRunner();
  if (!picked) {
    const finding: CloudAgentSecurityFinding = {
      id: "local-runtime-missing",
      severity: "blocker",
      category: "runtime",
      message: "Local runtime review was requested, but no submitter runtime is connected.",
      remediation: "Connect a CLI subscription, BYOK key, or local model, or use static-only review.",
    };
    return {
      mode: "local-runtime",
      verdict: "fail",
      costOwner: "submitter",
      summary: finding.message,
      findings: [...staticFindings, finding],
      reviewedAt: new Date().toISOString(),
    };
  }

  const systemPrompt = [
    "You are the Agentlas Cloud package security reviewer.",
    "This review runs locally on the submitter machine using the submitter's own runtime or BYOK key.",
    "Do not assume Agentlas Cloud or the platform owner will pay for model calls.",
    "Return strict JSON only: {\"verdict\":\"pass|fail|needs-review\",\"summary\":\"...\",\"findings\":[{\"severity\":\"blocker|high|medium|low|info\",\"category\":\"secret|policy|size|structure|runtime|network|review\",\"message\":\"...\",\"file\":\"optional\",\"remediation\":\"optional\"}]}",
  ].join("\n");
  const prompt = [
    "Review this Agentlas cloud package manifest and static scan.",
    "",
    JSON.stringify({ manifest, staticFindings }, null, 2),
  ].join("\n");

  const result = await picked.runner(
    {
      systemPrompt,
      history: [],
      userPrompt: prompt,
      backendLabel: picked.label,
      model: picked.active.model ?? undefined,
      longContext: picked.active.longContextEnabled,
      effort: picked.active.effort ?? undefined,
      permission: "read",
      cwd: rootPath,
      locale: "en",
    },
    {
      onPartial: () => {},
      onStatus: () => {},
      onTool: () => {},
    },
  );
  const parsed = parseReviewJson(result.text);
  const llmFindings: CloudAgentSecurityFinding[] = parsed.findings.map((finding, index) => ({
    id: typeof finding.id === "string" && finding.id.trim()
      ? finding.id
      : `local-runtime-review-${index + 1}`,
    severity: normalizeSeverity(finding.severity),
    category: normalizeCategory(finding.category),
    message: String(finding.message || "Reviewer finding"),
    file: typeof finding.file === "string" ? finding.file : undefined,
    remediation: typeof finding.remediation === "string" ? finding.remediation : undefined,
  }));
  const findings = [...staticFindings, ...llmFindings];
  return {
    mode: "local-runtime",
    verdict: normalizeVerdict(parsed.verdict, findings),
    costOwner: "submitter",
    runtimeLabel: picked.label,
    summary: parsed.summary || "Local runtime review completed.",
    findings,
    reviewedAt: new Date().toISOString(),
    rawText: result.text.slice(0, 4000),
  };
}

/**
 * ★ WHAT AN UPLOAD MAY DO BY ITSELF — AND WHAT ONLY A PERSON MAY DECIDE.
 *
 * Owner rule, 2026-08-18: self-repair means the packaging agent FIXES THE
 * PACKAGE and uploads the repaired one. It never means talking the server out
 * of a refusal, and it never means writing over something the person did not
 * name. Duplicates and forks are decisions, not defects — each reaches the
 * person as a sentence saying which one it is (`cloudRegistrationError`).
 *
 * ★ AND THE OWNER IS NOT A SPECIAL CASE. An earlier pass here retried a 412 by
 *   itself, reasoning "it is their own asset, so overwriting is what they
 *   meant". Written out for any user that rule reads: WHENEVER A FOLDER'S SLUG
 *   MATCHES A CLOUD LISTING, REPLACE THE LISTING WITH THIS FOLDER. A slug match
 *   is not proof the two are the same work — a template copied from a teammate,
 *   a second checkout edited on another laptop, and a re-import of an older
 *   version all match by slug. The missing revision receipt IS the missing
 *   proof, so the machine has no basis to decide and must not.
 *
 * So the 412 stops here and becomes a question with the facts attached: what is
 * in the Cloud, when it was last saved, and the one action that resolves it.
 * The target is held in main (never renderer) and used only when the person
 * comes back with an explicit confirmation for that same folder.
 */
type PendingOverwriteTarget = {
  slug: string;
  scope: CloudAgentCloudScope;
  cloudId: string;
  revision: string;
  updatedAt: string;
};

/** rootPath -> the target the user was asked about. Main is the authority for
 * this; a renderer may say "yes", never "yes, to this cloudId". */
const pendingOverwriteTargets = new Map<string, PendingOverwriteTarget>();

export function readPendingOverwriteTarget(rootPath: string): PendingOverwriteTarget | null {
  return pendingOverwriteTargets.get(path.resolve(rootPath)) ?? null;
}

function parseOverwriteTarget(input: {
  status: number;
  body: string;
  manifest: CloudAgentPackageManifest;
  scope: CloudAgentCloudScope;
}): PendingOverwriteTarget | null {
  if (input.status !== 412) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(input.body) as unknown;
    parsed = isRecord(value) ? value : null;
  } catch {
    return null;
  }
  if (parsed?.code !== "cloud_agent_revision_conflict") return null;
  const current = isRecord(parsed.current) ? parsed.current : null;
  const cloudId = typeof current?.cloudId === "string" ? current.cloudId : "";
  const revision = typeof current?.revision === "string" ? current.revision : "";
  const slug = typeof current?.slug === "string" ? current.slug : "";
  const scope = typeof current?.scope === "string" ? current.scope : "";
  const updatedAt = typeof current?.updatedAt === "string" ? current.updatedAt : "";
  if (!cloudId || !/^rev_[a-f0-9]{32}$/.test(revision)) return null;
  if (slug !== input.manifest.slug || scope !== input.scope) return null;
  return { slug, scope: input.scope, cloudId, revision, updatedAt };
}

function overwriteConfirmationError(
  target: PendingOverwriteTarget,
  hadReceipt: boolean,
): OwnerCloudActionError {
  const when = target.updatedAt ? new Date(target.updatedAt) : null;
  const savedAt = when && !Number.isNaN(when.getTime())
    ? when.toISOString().slice(0, 10)
    : "an earlier date";
  // Both revision-conflict shapes end in the same question — which version
  // wins — but the honest description differs: with a receipt the Cloud copy
  // was saved somewhere else AFTER this folder's last upload; without one this
  // machine simply has no record tying this folder to the listing.
  const why = hadReceipt
    ? `was saved again elsewhere after this folder's last upload (latest save ${savedAt})`
    : `already exists, last saved ${savedAt}, and this computer has no record of having uploaded it from this folder`;
  return new OwnerCloudActionError(
    "cloud_overwrite_confirmation_required",
    `"${target.slug}" in your Agent Cloud ${why}. Nothing was uploaded and nothing was changed. `
    + "Replace it with this folder's contents only if this folder is the newer version.",
    { retryable: false, actionState: "not-committed" },
  );
}

/** Server-side commit hiccups the server itself marks as retryable. The package
 * is fine and the previous version stays live — one quiet retry beats handing
 * the person an error whose only remedy is pressing the same button again. */
const RETRYABLE_COMMIT_CODES = new Set([
  "registration_commit_failed",
  "cloud_save_commit_failed",
  "workforce_projection_pending",
  "workforce_identity_missing",
  "base_release_materialization_failed",
]);

function retryableCommitCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : "";
    return RETRYABLE_COMMIT_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

async function registerCloudAgent(input: {
  manifest: CloudAgentPackageManifest;
  bundlePath: string;
  review: CloudAgentReviewResult;
  visibility: CloudAgentVisibility;
  notes?: string;
  baseRegistration?: CloudAgentRevisionIdentity;
  rootPath: string;
  /** The person answered the overwrite question for THIS folder. */
  confirmedOverwrite?: PendingOverwriteTarget;
  /** One quiet retry has already been spent on a retryable server commit hiccup. */
  retried?: boolean;
  /** The compressed attempt was refused; this call is the uncompressed resend. */
  retriedUncompressed?: boolean;
}): Promise<CloudAgentRegistrationResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) throw new Error("Sign in to agentlas.cloud before publishing a cloud agent.");
  const base = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const bundle = JSON.parse(fs.readFileSync(input.bundlePath, "utf8")) as unknown;
  const scope = scopeForVisibility(input.visibility);
  // ★ NEVER LET THE ROLLOUT ORDER BREAK AN UPLOAD.
  //
  //   Compressed files are a NEW thing to send. An Agent Cloud that has not
  //   deployed the matching change reads `contentBase64` as raw bytes, finds
  //   the length and hash disagree, and answers 400 — every upload from a
  //   newer desktop would fail until the web deploy landed, and the person
  //   would just see "upload failed". Rather than pin the release order and
  //   hope, the client asks once and falls back: if the refusal looks like the
  //   server not knowing this encoding, resend the same bundle uncompressed.
  //   Identical bytes, identical packageHash — only the wrapper differs.
  const uncompressedBundle = (): unknown => {
    if (!isRecord(bundle) || !Array.isArray(bundle.files)) return bundle;
    return {
      ...bundle,
      files: bundle.files.map((file) => {
        if (!isRecord(file) || file.encoding !== "gzip" || typeof file.contentBase64 !== "string") return file;
        const { encoding: _encoding, encodedBytes: _encodedBytes, ...rest } = file;
        return {
          ...rest,
          contentBase64: gunzipSync(Buffer.from(file.contentBase64, "base64"), {
            maxOutputLength: MAX_UNCOMPRESSED_FILE_BYTES,
          }).toString("base64"),
        };
      }),
    };
  };
  const bundleCarriesCompression = isRecord(bundle)
    && Array.isArray(bundle.files)
    && bundle.files.some((file) => isRecord(file) && file.encoding === "gzip");
  const confirmed = input.confirmedOverwrite;
  const precondition = confirmed
    ? { "if-match": `"${confirmed.revision}"`, "x-agentlas-cloud-id": confirmed.cloudId }
    : cloudRegistrationPreconditionHeaders(input.baseRegistration);
  const response = await fetch(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: base,
      ...precondition,
    },
    body: JSON.stringify({
      manifest: input.manifest,
      bundle,
      review: input.review,
      visibility: input.visibility,
      notes: input.notes ?? null,
      billing: {
        modelCallsPaidBy: input.review.costOwner,
        localRuntime: input.review.runtimeLabel ?? null,
      },
    }),
  });
  if (!response.ok && response.status === 400 && bundleCarriesCompression && !input.retriedUncompressed) {
    const refusal = await response.clone().text().catch(() => "");
    if (/encoding|byte_mismatch|byte length mismatch|invalid_base64|decompress|hash_mismatch/i.test(refusal)) {
      const plainBundlePath = `${input.bundlePath}.uncompressed.json`;
      fs.writeFileSync(plainBundlePath, JSON.stringify(uncompressedBundle()) + "\n", "utf8");
      try {
        return await registerCloudAgent({ ...input, bundlePath: plainBundlePath, retriedUncompressed: true });
      } finally {
        try {
          fs.rmSync(plainBundlePath, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
  if (response.ok) {
    pendingOverwriteTargets.delete(path.resolve(input.rootPath));
    const receipt = validateCloudRegistrationReceipt(
      await response.json(),
      input.manifest,
      input.visibility,
      response.headers.get("etag"),
    );
    return confirmed
      ? { ...receipt, autoRecovered: [`Replaced the copy already in your Cloud ("${confirmed.slug}").`] }
      : receipt;
  }
  const body = await response.text().catch(() => "");
  const target = parseOverwriteTarget({ status: response.status, body, manifest: input.manifest, scope });
  if (target && !confirmed) {
    pendingOverwriteTargets.set(path.resolve(input.rootPath), target);
    throw overwriteConfirmationError(target, Boolean(input.baseRegistration));
  }
  if (!input.retried && retryableCommitCode(body)) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return registerCloudAgent({ ...input, retried: true });
  }
  throw cloudRegistrationError(response.status, body, !input.baseRegistration && !confirmed);
}

/** Build the write precondition independently from authentication headers so
 * tests can prove that every register request is either an explicit create or
 * an exact-revision update. */
export function cloudRegistrationPreconditionHeaders(
  baseRegistration?: CloudAgentRevisionIdentity,
): Record<string, string> {
  if (!baseRegistration) return { "if-none-match": "*" };
  return {
    "if-match": `"${baseRegistration.revision}"`,
    "x-agentlas-cloud-id": baseRegistration.cloudId,
  };
}

export function validateCloudRegistrationReceipt(
  raw: unknown,
  manifest: CloudAgentPackageManifest,
  visibility: CloudAgentVisibility,
  responseEtag: string | null,
): CloudAgentRegistrationResult {
  const json = isRecord(raw) ? raw : {};
  const expectedSource = visibility === "marketplace" ? "hub" : "agent-cloud";
  const expectedVisibility = visibility === "marketplace" ? "marketplace" : "owner-private";
  const expectedScope = scopeForVisibility(visibility);
  const revision = typeof json.revision === "string" ? json.revision : "";
  const expectedEtag = revision ? `"${revision}"` : "";
  if (
    json.schema !== "agentlas.agent_cloud.registration.v1" ||
    json.source !== expectedSource ||
    json.visibility !== expectedVisibility ||
    json.owner !== true ||
    json.publicHubPublished !== (visibility === "marketplace") ||
    json.dryRun !== false ||
    typeof json.cloudId !== "string" ||
    !json.cloudId.trim() ||
    json.slug !== manifest.slug ||
    json.scope !== expectedScope ||
    !registrationSawOurPackage(json, manifest) ||
    json.packageHashVersion !== manifest.packageHashVersion ||
    !/^rev_[a-f0-9]{32}$/.test(revision) ||
    responseEtag !== expectedEtag ||
    typeof json.registeredAt !== "string" ||
    !Number.isFinite(Date.parse(json.registeredAt))
  ) {
    throw new Error("Agentlas Cloud register returned an invalid or mismatched registration receipt.");
  }
  const withheld = serverWithheldPaths(json);
  return {
    cloudId: json.cloudId,
    slug: json.slug,
    scope: expectedScope,
    // What the server actually stored. When it withholds a file of its own,
    // that is a different package than the one sent, and the local record must
    // say so or a later comparison reads as tampering.
    packageHash: typeof json.packageHash === "string" && json.packageHash ? json.packageHash : manifest.packageHash,
    packageHashVersion: manifest.packageHashVersion,
    revision,
    etag: expectedEtag,
    ...(typeof json.url === "string" ? { url: json.url } : {}),
    ...(typeof json.marketplaceUrl === "string" ? { marketplaceUrl: json.marketplaceUrl } : {}),
    registeredAt: json.registeredAt,
    dryRun: false,
    ...(withheld.length
      ? {
          autoRecovered: [
            `Published without ${withheld.length} file(s) the server's own scan withheld: ${withheld.join(", ")}.`,
          ],
        }
      : {}),
  };
}

/**
 * THE SERVER MAY STORE LESS THAN IT RECEIVED, AND THAT IS NOT A FAILED PROOF.
 *
 * Registration verifies the submitted hash, then withholds any file its own
 * scan judged credential-like and stores the remainder under a NEW hash, with
 * `uploadReceipt.omissions` naming every dropped path. Comparing only against
 * the stored hash turns that documented repair into "invalid or mismatched
 * registration receipt" AFTER the listing is live — the agent searchable and
 * callable on the Hub while its publisher is told the upload failed.
 *
 * Attestation is for proving the server saw exactly this package, and
 * `submittedPackageHash` is that proof, so either hash matching ours satisfies
 * it. A response carrying neither still fails closed.
 */
function registrationSawOurPackage(json: Record<string, unknown>, manifest: CloudAgentPackageManifest): boolean {
  const ours = String(manifest.packageHash || "").toLowerCase();
  if (String(json.packageHash ?? "").toLowerCase() === ours) return true;
  const receipt = isRecord(json.uploadReceipt) ? json.uploadReceipt : null;
  if (!receipt) return false;
  return String(receipt.submittedPackageHash ?? "").toLowerCase() === ours;
}

/** Paths the server left out of the stored package, for the user to see. */
function serverWithheldPaths(json: Record<string, unknown>): string[] {
  const receipt = isRecord(json.uploadReceipt) ? json.uploadReceipt : null;
  const omissions = receipt && Array.isArray(receipt.omissions) ? receipt.omissions : [];
  return omissions
    .map((entry) => (isRecord(entry) && typeof entry.path === "string" ? entry.path : ""))
    .filter((value): value is string => value.length > 0);
}

function scopeForVisibility(visibility: CloudAgentVisibility): CloudAgentCloudScope {
  return visibility === "marketplace" ? "hub-public" : "owner-private";
}

function cloudRegistrationError(status: number, body: string, sentAsCreate = false): Error {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(body) as unknown;
    parsed = isRecord(value) ? value : null;
  } catch {
    parsed = null;
  }
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  if (status === 412 && code === "cloud_agent_revision_conflict") {
    const current = isRecord(parsed?.current) ? parsed.current : null;
    const cloudId = typeof current?.cloudId === "string" ? current.cloudId : "unknown";
    const revision = typeof current?.revision === "string" ? current.revision : "unknown";
    const updatedAt = typeof current?.updatedAt === "string" ? current.updatedAt : "unknown";
    // A folder with no saved revision receipt sends "create". When the asset
    // already exists the server refuses, and blaming "another machine" sends the
    // user to restore — which binds the receipt to the restored copy, never to
    // this folder, so the refusal never clears. Name the real precondition.
    // Keep the wording ownership-centric: the user's only question is whether
    // this name belongs to their account, not how folders and receipts relate.
    const guidance = sentAsCreate
      ? "This name already exists in Agent Cloud. If it is yours, restore it once on this machine, then save again."
      : "A newer version of this asset was saved elsewhere. Restore it to compare, then save again.";
    return new Error(
      `cloud_agent_revision_conflict: Nothing was uploaded. ${guidance} `
      + `(server: cloudId ${cloudId}, revision ${revision}, last saved ${updatedAt})`,
    );
  }
  if (status === 428 && code === "cloud_precondition_required") {
    return new Error(
      "cloud_precondition_required: Agent Cloud requires a saved revision receipt before updating this asset. Restore the latest Cloud copy, then retry.",
    );
  }
  // ★ A POLICY REFUSAL IS NOT A MALFUNCTION AND MUST NOT READ LIKE ONE.
  //   Both of these are decisions the server is entitled to make, and each has
  //   exactly one thing for the person to do. Falling through to the generic
  //   branch below put an HTTP status and a JSON body on screen — and on
  //   Mobile that string is the ONLY explanation the user ever sees for why
  //   the save stopped.
  //   Thrown as OwnerCloudActionError so the code survives to every surface.
  //   `retryable: false` and `actionState: not-committed` are the honest facts:
  //   nothing was uploaded, and pressing save again changes nothing until the
  //   person acts. Mobile shows this text verbatim and offers no retry.
  if (status === 402 && code === "cloud_agent_limit_reached") {
    const used = typeof parsed?.usedAgents === "number" ? parsed.usedAgents : null;
    const limit = typeof parsed?.limitAgents === "number" ? parsed.limitAgents : null;
    const counts = used !== null && limit !== null ? ` (${used} of ${limit} used)` : "";
    return new OwnerCloudActionError(
      "cloud_agent_limit_reached",
      // "크레딧이 모자란 건가?"가 이 문장을 읽는 사람의 첫 질문이다 — 업로드는
      // 크레딧을 쓰지 않으므로 먼저 그렇게 말한다.
      `Uploading does not spend credits. Your plan's Agent Cloud seats are full${counts}, `
      + "and nothing was uploaded. Delete a cloud agent you no longer need, or move to a larger plan.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  if (status === 409 && code === "fork_cannot_publish") {
    const origin = typeof parsed?.originSlug === "string" ? parsed.originSlug : "";
    return new OwnerCloudActionError(
      "fork_cannot_publish",
      `This is an installed copy${origin ? ` of ${origin}` : ""}. Run it, edit it, and staff it `
      + "into work orders — but the Hub listing belongs to the original creator.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  if (status === 409 && code === "duplicate_hub_package") {
    return new OwnerCloudActionError(
      "duplicate_hub_package",
      "These exact files are already listed on the Hub by another account. Nothing was uploaded.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  // ★ SAY "DUPLICATE" IN THE WORD THE PERSON USES.
  //   Both codes below mean one thing to the person — this agent is already
  //   listed — and both fell through to the generic branch, which put an HTTP
  //   status and a raw JSON body on screen. Publishing it a second time under
  //   another name is not a repair and is never done on their behalf; the
  //   existing listing is named so they can upload to it instead.
  if (status === 409 && code === "cloud_agent_duplicate") {
    const conflict = isRecord(parsed?.conflict) ? parsed.conflict : null;
    const existing = typeof conflict?.existingSlug === "string" ? conflict.existingSlug : "";
    return new OwnerCloudActionError(
      "cloud_agent_duplicate",
      `This agent is already on the Hub${existing ? ` as "${existing}"` : ""}, listed by another account. `
      + "Nothing was uploaded.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  if (status === 409 && code === "slug_identity_conflict") {
    const conflict = isRecord(parsed?.conflict) ? parsed.conflict : null;
    const canonical = typeof conflict?.canonicalSlug === "string"
      ? conflict.canonicalSlug
      : typeof conflict?.existingSlug === "string" ? conflict.existingSlug : "";
    return new OwnerCloudActionError(
      "slug_identity_conflict",
      `This agent is already in your Cloud${canonical ? ` as "${canonical}"` : ""}, so a second listing for `
      + "the same agent was not created. Nothing was uploaded. "
      + (canonical
        ? `Upload it under "${canonical}" to update that listing.`
        : "Upload it under its existing name to update that listing."),
      { retryable: false, actionState: "not-committed" },
    );
  }
  // ★ MOBILE READS THESE SENTENCES, NOT THE DESKTOP RESULT CARD.
  //   The card classifies by code and writes its own ko/en text; the phone gets
  //   only what a typed OwnerCloudActionError carries (`cloudRefusalOf` returns
  //   null for a plain Error, and the bridge then answers with its generic
  //   "Desktop rejected the request"). So every refusal the card explains must
  //   ALSO be typed here, or the same upload is self-explanatory on the laptop
  //   and unexplained on the phone. Owner rule 2026-08-18: a fix lands on every
  //   channel.
  if (status === 402 || code === "cloud_agent_limit_reached") {
    return new OwnerCloudActionError(
      "cloud_agent_limit_reached",
      "Uploading does not spend credits. Your plan's Agent Cloud seats are full, and nothing was "
      + "uploaded. Delete a cloud agent you no longer need, or move to a larger plan.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  if (code === "cloud_mutations_maintenance") {
    return new OwnerCloudActionError(
      "cloud_mutations_maintenance",
      "Writes to Agent Cloud are paused for maintenance. Nothing was uploaded and nothing changed. "
      + "Try the same folder again shortly.",
      { retryable: true, actionState: "not-committed" },
    );
  }
  if (
    code === "registration_commit_failed"
    || code === "cloud_save_commit_failed"
    || code === "workforce_projection_pending"
    || code === "workforce_identity_missing"
    || code === "base_release_materialization_failed"
  ) {
    return new OwnerCloudActionError(
      code,
      "Nothing is wrong with your package — the Cloud side could not finish the write, and the "
      + "previous version is still live. Upload the same folder again shortly.",
      { retryable: true, actionState: "not-committed" },
    );
  }
  if (code === "localized_metadata_required") {
    return new OwnerCloudActionError(
      "localized_metadata_required",
      "The Hub listing still needs Korean and English text, and Agentlas could not complete it with "
      + "your connected model. Nothing was uploaded. Check that a model is connected, then upload again.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  if (
    code === "bundle_too_large"
    || code === "file_limit"
    || code === "file_too_large"
    || code === "request_too_large"
  ) {
    return new OwnerCloudActionError(
      code,
      "Even after leaving out the less essential files, this package is over the Agent Cloud size or "
      + "file-count limit. Nothing was uploaded. Upload just the agent folder, or split the team into "
      + "smaller packages.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  if (code === "client_upgrade_required") {
    return new OwnerCloudActionError(
      "client_upgrade_required",
      "The Cloud copy of this agent uses a newer format, so this version of Agentlas did not overwrite "
      + "it. Nothing changed. Update Agentlas, then upload again.",
      { retryable: false, actionState: "not-committed" },
    );
  }
  return new Error(`Agentlas Cloud register failed (${status}): ${body.slice(0, 300)}`);
}

function readName(snapshot: PackageSnapshot, fallbackName: string): string {
  const manifest = readPackageJson(snapshot);
  const explicit = firstString(
    manifest.agentlas.displayName,
    manifest.agentlas.name,
    manifest.manifest.name,
    manifest.agentCard.name,
    manifest.routingCard.name,
  );
  if (explicit) return explicit.replace(/\s+/g, " ").slice(0, 80);
  const text = readFirst(snapshot, ["agent.md", "AGENT.md", "README.md", "CLAUDE.md", "AGENTS.md"], 2000);
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || fallbackName).replace(/\s+/g, " ").slice(0, 80);
}

function readTagline(snapshot: PackageSnapshot): string {
  const manifest = readPackageJson(snapshot);
  const explicit = firstString(
    manifest.agentlas.summary,
    manifest.agentlas.description,
    manifest.manifest.description,
    manifest.agentCard.summary,
    manifest.routingCard.summary,
  );
  if (explicit) return explicit.replace(/\s+/g, " ").slice(0, 160);
  const text = readFirst(snapshot, ["README.md", "agent.md", "AGENT.md"], 3000);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
    return trimmed.slice(0, 160);
  }
  return "Portable Agentlas cloud agent package.";
}

function cleanLocalizedField(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max).trim()
    : "";
}

function normalizeLocalizedListing(value: unknown): CloudAgentLocalizedListing | undefined {
  if (!isRecord(value)) return undefined;
  const localized = {
    titleEn: cleanLocalizedField(value.titleEn, 96),
    titleKo: cleanLocalizedField(value.titleKo, 96),
    descriptionEn: cleanLocalizedField(value.descriptionEn, 640),
    descriptionKo: cleanLocalizedField(value.descriptionKo, 640),
  };
  return Object.values(localized).some(Boolean) ? localized : undefined;
}

function readLocalizedListing(snapshot: PackageSnapshot): CloudAgentLocalizedListing | undefined {
  const manifest = readPackageJson(snapshot);
  for (const source of [manifest.agentCard, manifest.agentlas, manifest.manifest, manifest.routingCard]) {
    const nested = normalizeLocalizedListing(source.localized);
    if (nested) return nested;
    const flat = normalizeLocalizedListing(source);
    if (flat) return flat;
  }
  return undefined;
}

export function localizedListingProblems(value: CloudAgentLocalizedListing | undefined): string[] {
  if (!value) return ["localized object missing"];
  const issues: string[] = [];
  if (!value.titleEn) issues.push("titleEn missing");
  if (!value.titleKo) issues.push("titleKo missing");
  if (!value.descriptionEn) issues.push("descriptionEn missing");
  if (!value.descriptionKo) issues.push("descriptionKo missing");
  if (/[가-힣]/.test(value.titleEn)) issues.push("titleEn contains Hangul");
  if (/[가-힣]/.test(value.descriptionEn)) issues.push("descriptionEn contains Hangul");
  if (
    value.descriptionEn
    && value.descriptionEn === value.descriptionKo
    && /[가-힣]/.test(value.descriptionKo)
  ) {
    issues.push("English description is not translated");
  }
  return issues;
}

export async function generateLocalizedListingWithSubmitterRuntime(
  rootPath: string,
  name: string,
  tagline: string,
): Promise<CloudAgentLocalizedListing | undefined> {
  // 활성 모델 하나가 실패하면 끝이었다 — 연결된 다른 모델이 놀고 있는데도.
  // 활성 런타임 먼저, 이어서 연결된 나머지를 성공할 때까지 순서대로 시도한다.
  const { pickRunner } = await import("../runtime/selection");
  const runtimes = await detectRuntimes().catch(() => [] as Awaited<ReturnType<typeof detectRuntimes>>);
  const ordered = [...runtimes].sort((a, b) => Number(b.active) - Number(a.active));
  for (const runtime of ordered) {
    const picked = pickRunner(runtime);
    if (!picked) continue;
    const localized = await generateLocalizedListingWithRunner(
      { runner: picked.runner, label: picked.label, active: runtime },
      rootPath,
      name,
      tagline,
    );
    if (localized) return localized;
  }
  return undefined;
}

async function generateLocalizedListingWithRunner(
  picked: { runner: import("../runtime/runner").Runner; label: string; active: RuntimeStatus },
  rootPath: string,
  name: string,
  tagline: string,
): Promise<CloudAgentLocalizedListing | undefined> {
  try {
    const result = await picked.runner(
      {
        systemPrompt: [
          "Translate public Agentlas Hub listing metadata.",
          "Return one strict JSON object with exactly titleEn, titleKo, descriptionEn, descriptionKo.",
          "Translate only the supplied name and description. Do not invent features, claims, prices, or setup details.",
          "English fields must contain natural English and no Hangul. Korean fields must be natural Korean.",
        ].join("\n"),
        history: [],
        userPrompt: JSON.stringify({ sourceTitle: name, sourceDescription: tagline }),
        backendLabel: picked.label,
        model: picked.active.model ?? undefined,
        longContext: picked.active.longContextEnabled,
        effort: picked.active.effort ?? undefined,
        permission: "read",
        cwd: rootPath,
        locale: "en",
      },
      {
        onPartial: () => {},
        onStatus: () => {},
        onTool: () => {},
      },
    );
    const candidate = result.text.match(/\{[\s\S]*\}/)?.[0];
    const localized = candidate
      ? normalizeLocalizedListing(JSON.parse(candidate) as unknown)
      : undefined;
    return localizedListingProblems(localized).length === 0 ? localized : undefined;
  } catch {
    return undefined;
  }
}

async function normalizePurposeAnswerWithSubmitterRuntime(
  rootPath: string,
  answer: string,
): Promise<{ summary: string; capabilities: string[] }> {
  const source = answer.trim().slice(0, 1_200);
  const deterministic = {
    summary: source.slice(0, 240),
    capabilities: deriveRoutingCapabilities(source),
  };
  if (!source) return deterministic;
  try {
    const { pickActiveRunner } = await import("../mcp/client");
    const picked = await pickActiveRunner();
    if (!picked) return deterministic;
    const result = await picked.runner(
      {
        systemPrompt: [
          "Convert one ordinary-language answer into internal Agentlas routing metadata.",
          "Return strict JSON only: {\"summary\":\"one factual English sentence\",\"capabilities\":[\"english_verb_object\"]}.",
          "Use 2-8 concrete English verb_object capabilities in snake_case, each with at least two words.",
          "Preserve the user's meaning. Do not invent tools, permissions, runtimes, languages, modalities, or claims.",
        ].join("\n"),
        history: [],
        userPrompt: source,
        backendLabel: picked.label,
        model: picked.active.model ?? undefined,
        longContext: picked.active.longContextEnabled,
        effort: picked.active.effort ?? undefined,
        permission: "read",
        cwd: rootPath,
        locale: "en",
      },
      {
        onPartial: () => {},
        onStatus: () => {},
        onTool: () => {},
      },
    );
    const candidate = result.text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = candidate ? JSON.parse(candidate) as unknown : null;
    if (!isRecord(parsed)) return deterministic;
    const summary = typeof parsed.summary === "string"
      ? parsed.summary.trim().slice(0, 240)
      : "";
    const capabilities = Array.isArray(parsed.capabilities)
      ? Array.from(new Set(
          parsed.capabilities
            .map((value) => String(value).trim().toLowerCase())
            .filter((value) => ROUTING_CARD_CAPABILITY_RE.test(value)),
        )).slice(0, 8)
      : [];
    if (!summary || /[가-힣]/.test(summary) || capabilities.length === 0) return deterministic;
    return { summary, capabilities };
  } catch {
    return deterministic;
  }
}

function readStableSlug(snapshot: PackageSnapshot): string {
  const manifest = readPackageJson(snapshot);
  return firstString(
    manifest.agentlas.slug,
    manifest.agentlas.id,
    manifest.manifest.package,
    manifest.manifest.slug,
    manifest.agentCard.slug,
    manifest.agentCard.id,
    nestedString(manifest.routingCard.agent_card_ref, "slug"),
  );
}

function readPackageJson(snapshot: PackageSnapshot): {
  agentlas: Record<string, unknown>;
  manifest: Record<string, unknown>;
  agentCard: Record<string, unknown>;
  routingCard: Record<string, unknown>;
} {
  return {
    agentlas: readJsonObject(snapshot, "agentlas.json"),
    manifest: readJsonObject(snapshot, "manifest.json"),
    agentCard: readJsonObject(snapshot, ".agentlas/agent-card.json"),
    routingCard: readJsonObject(snapshot, ".agentlas/routing-card.json"),
  };
}

function readJsonObject(snapshot: PackageSnapshot, file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readSnapshotText(snapshot, file)) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function nestedString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const nested = value[key];
  return typeof nested === "string" ? nested : "";
}

function readFirst(snapshot: PackageSnapshot, names: string[], maxChars: number): string {
  for (const name of names) {
    if (!snapshot.has(name)) continue;
    return readSnapshotText(snapshot, name).slice(0, maxChars);
  }
  return "";
}

function inferAgentKind(snapshot: PackageSnapshot): "agent" | "team" | "repo" {
  for (const name of ["TEAM.md", "team.json", "agents", "team", "departments", "hr-departments"]) {
    if (snapshot.has(name) || Array.from(snapshot.keys()).some((entry) => entry.startsWith(`${name}/`))) return "team";
  }
  if (readFirst(snapshot, ["AGENT.md", "agent.md", "CLAUDE.md", "AGENTS.md"], 2000)) return "agent";
  return "repo";
}

function packageOutputDir(slug: string): string {
  const root =
    process.env.AGENTLAS_CLOUD_PACKAGE_DIR ||
    userDataPath("cloud-agent-packages");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(root, `${slug}-${stamp}`);
}

export function hashPackage(files: PackagedFile[]): string {
  const h = createHash("sha256");
  // 코드포인트 정렬 — localeCompare 금지. 서버(register/route.ts hashPackage)·Python
  // upload.py와 바이트 동일해야 한다. localeCompare는 ICU/로케일 의존이라 대소문자 혼합
  // 경로에서 순서가 갈려 package_hash_mismatch를 유발한다(BUG1과 동일 계열, 2026-07-02).
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(file.path);
    h.update("\0");
    h.update(file.sha256);
    h.update("\0");
    h.update(file.executable ? "x" : "-");
    h.update("\0");
  }
  return h.digest("hex");
}

function summarizeSecurity(findings: CloudAgentSecurityFinding[]): CloudAgentPackageManifest["security"] {
  const blockerCount = findings.filter((f) => f.severity === "blocker").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  return {
    verdict: blockerCount > 0 ? "fail" : highCount > 0 ? "needs-review" : "pass",
    blockerCount,
    highCount,
    findingCount: findings.length,
  };
}

function isBlocked(findings: CloudAgentSecurityFinding[], review: CloudAgentReviewResult): boolean {
  return review.verdict === "fail" || findings.some((finding) => finding.severity === "blocker");
}

function parseReviewJson(text: string): {
  verdict?: string;
  summary?: string;
  findings: Array<Record<string, unknown>>;
} {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0] || "{}";
  try {
    const parsed = JSON.parse(candidate) as {
      verdict?: string;
      summary?: string;
      findings?: Array<Record<string, unknown>>;
    };
    return {
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch {
    return {
      verdict: "needs-review",
      summary: "Local runtime returned non-JSON review output.",
      findings: [
        {
          severity: "medium",
          category: "review",
          message: "Review output could not be parsed as strict JSON.",
          remediation: "Run static-only review or repeat local runtime review.",
        },
      ],
    };
  }
}

function normalizeVerdict(verdict: unknown, findings: CloudAgentSecurityFinding[]): CloudAgentReviewResult["verdict"] {
  if (verdict === "pass" || verdict === "fail" || verdict === "needs-review") return verdict;
  return findings.some((finding) => finding.severity === "blocker") ? "fail" : "needs-review";
}

function normalizeSeverity(value: unknown): CloudAgentSecurityFinding["severity"] {
  if (value === "blocker" || value === "high" || value === "medium" || value === "low" || value === "info") {
    return value;
  }
  return "medium";
}

function normalizeCategory(value: unknown): CloudAgentSecurityFinding["category"] {
  if (
    value === "secret" ||
    value === "policy" ||
    value === "size" ||
    value === "structure" ||
    value === "runtime" ||
    value === "network" ||
    value === "review"
  ) {
    return value;
  }
  return "review";
}

function sanitizeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agentlas-cloud-agent"
  );
}

function normalizeRelative(rootPath: string, absPath: string): string {
  const rel = path.relative(rootPath, absPath);
  return rel ? rel.split(path.sep).join("/") : ".";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function findingId(kind: string, relPath: string): string {
  return `${kind}-${sha256(relPath).slice(0, 10)}`;
}
