import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { detectRuntimeLabelsFromPaths } from "../agents/runtime-labels";
import { detectRuntimes } from "../runtime/detect";
import { autofixForPublish, remediateBlockers } from "../hephaestus/publish-autofix";
import type { RemediationAction } from "../hephaestus/publish-autofix";
import type { RuntimeStatus } from "../../shared/types";
import { getSessionCookieHeader } from "../auth";
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

const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MANIFEST_VERSION = "0.1" as const;
const PACKAGE_HASH_VERSION = "path-sha256-executable-v2" as const;
const ROUTING_CARD_PATH = ".agentlas/routing-card.json";
const DESKTOP_RESTORE_MARKER_PATH = ".agentlas-cloud-package.json";
const LOCAL_EXPERIENCE_LINEAGE_PATH = ".agentlas/experience-relations.jsonl";
const ROUTING_CARD_CAPABILITY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const ROUTING_CARD_STATUSES = new Set(["draft", "searchable", "candidate", "routing_ready", "trusted"]);

function isLocalExperienceLineagePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized === LOCAL_EXPERIENCE_LINEAGE_PATH
    || normalized.startsWith(`${LOCAL_EXPERIENCE_LINEAGE_PATH}.`)
    || normalized.startsWith(".agentlas/.experience-relations.jsonl.");
}

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cfg",
  ".cmd",
  ".conf",
  ".config",
  ".css",
  ".csv",
  ".js",
  ".html",
  ".jsx",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".ini",
  ".properties",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
  ".xml",
  ".bat",
]);

const AGENT_DEF_FILES = new Set([
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
]);

const BLOCKED_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
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
  bytes: number;
  sha256: string;
  contentBase64: string;
  executable: boolean;
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

/** Friendly one-line breakdown of what the publish auto-fix did, for the user. */
function summarizeRemediation(actions: RemediationAction[], locale: "ko" | "en"): string {
  if (actions.length === 0) return "";
  const redacted = actions.filter((a) => a.action === "redacted").length;
  const excluded = actions.filter((a) => a.action === "excluded").length;
  const rewritten = actions.filter((a) => a.action === "rewritten" && !a.detail.includes("routing card")).length;
  const routingCard = actions.some((a) => a.detail.includes("routing card"));
  const parts: string[] = [];
  const ko = locale === "ko";
  if (routingCard) parts.push(ko ? "라우팅 카드 생성" : "generated routing card");
  if (redacted) parts.push(ko ? `시크릿 ${redacted}건 리댁트` : `redacted ${redacted}`);
  if (rewritten) parts.push(ko ? `${rewritten}건 재작성` : `rewrote ${rewritten}`);
  if (excluded) parts.push(ko ? `${excluded}건 제외` : `excluded ${excluded}`);
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
  if (isPublicHubPublish) {
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
        // A missing/invalid routing card is a hard blocker added outside the scan
        // (the loop can't reach it) — auto-generate one so no agent dead-ends on it.
        const purposeInput = input.purposeAnswer
          ? await normalizePurposeAnswerWithSubmitterRuntime(scanRoot, input.purposeAnswer)
          : undefined;
        if (ensureRoutingCard(scanRoot, purposeInput)) {
          opts?.onStage?.("routing-card");
          remediationActions.push({ file: ROUTING_CARD_PATH, action: "rewritten", detail: "auto-generated routing card" });
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
  const slug = sanitizeSlug(input.slug || readStableSlug(finalSnapshot) || name || path.basename(rootPath));
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
  let status: CloudAgentPackageResult["status"] = blocked ? "blocked" : dryRun ? "dry-run" : "ready";
  if (!blocked && !dryRun) {
    stage("uploading", slug);
    registration = await registerCloudAgent({
      manifest,
      bundlePath,
      review,
      visibility,
      notes: input.notes,
      baseRegistration,
    });
    stage("receipt");
    try {
      writeCloudAgentRegistrationMarker({
        rootPath,
        slug,
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
            ? `Published ${slug} publicly to Agentlas Hub.`
            : `Saved ${slug} privately in Agent Cloud.`) + summarizeRemediation(remediationActions, opts?.locale ?? "en")
        : status === "blocked"
          ? isPublicHubPublish
            ? `Hub publish blocked: ${review.summary}`
            : `Private Agent Cloud save blocked: ${review.summary}`
          : isPublicHubPublish
            ? `Hub package ready: ${slug}.`
            : `Private Agent Cloud package ready: ${slug}.`,
  };
}

function scanAgentFolder(rootPath: string, restoredExecutablePaths: ReadonlySet<string>): StaticScanResult {
  const files: CloudAgentPackageFile[] = [];
  const included: PackagedFile[] = [];
  const findings: CloudAgentSecurityFinding[] = [];
  let totalBytes = 0;
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
      if (before.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
      const chunks: Buffer[] = [];
      let actualBytes = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - actualBytes));
        if (chunk.byteLength <= 0) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
        const read = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
        if (read === 0) break;
        actualBytes += read;
        if (actualBytes > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
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
      if (st.size > MAX_FILE_BYTES) {
        findings.push({
          id: findingId("large-file", rel),
          severity: "blocker",
          category: "size",
          file: rel,
          message: `File exceeds ${MAX_FILE_BYTES} bytes.`,
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
        files.push({ path: rel, bytes: bytes.length, sha256: digest, kind: "binary", executable, included: true });
        included.push({ path: rel, bytes: bytes.length, sha256: digest, contentBase64: bytes.toString("base64"), executable });
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
      files.push({ path: rel, bytes: bytes.length, sha256: digest, kind: "text", executable, included: true });
      included.push({ path: rel, bytes: bytes.length, sha256: digest, contentBase64: bytes.toString("base64"), executable });
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
  if (totalBytes > MAX_TOTAL_BYTES) {
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
  return Buffer.from(file.contentBase64, "base64").toString("utf8");
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
    contentBase64: bytes.toString("base64"),
    executable: false,
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

async function registerCloudAgent(input: {
  manifest: CloudAgentPackageManifest;
  bundlePath: string;
  review: CloudAgentReviewResult;
  visibility: CloudAgentVisibility;
  notes?: string;
  baseRegistration?: CloudAgentRevisionIdentity;
}): Promise<CloudAgentRegistrationResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) throw new Error("Sign in to agentlas.cloud before publishing a cloud agent.");
  const base = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const bundle = JSON.parse(fs.readFileSync(input.bundlePath, "utf8")) as unknown;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie,
    origin: base,
    ...cloudRegistrationPreconditionHeaders(input.baseRegistration),
  };
  const response = await fetch(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers,
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
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw cloudRegistrationError(response.status, body, !input.baseRegistration);
  }
  return validateCloudRegistrationReceipt(
    await response.json(),
    input.manifest,
    input.visibility,
    response.headers.get("etag"),
  );
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
    json.packageHash !== manifest.packageHash ||
    json.packageHashVersion !== manifest.packageHashVersion ||
    !/^rev_[a-f0-9]{32}$/.test(revision) ||
    responseEtag !== expectedEtag ||
    typeof json.registeredAt !== "string" ||
    !Number.isFinite(Date.parse(json.registeredAt))
  ) {
    throw new Error("Agentlas Cloud register returned an invalid or mismatched registration receipt.");
  }
  return {
    cloudId: json.cloudId,
    slug: json.slug,
    scope: expectedScope,
    packageHash: manifest.packageHash,
    packageHashVersion: manifest.packageHashVersion,
    revision,
    etag: expectedEtag,
    ...(typeof json.url === "string" ? { url: json.url } : {}),
    ...(typeof json.marketplaceUrl === "string" ? { marketplaceUrl: json.marketplaceUrl } : {}),
    registeredAt: json.registeredAt,
    dryRun: false,
  };
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
  try {
    const { pickActiveRunner } = await import("../mcp/client");
    const picked = await pickActiveRunner();
    if (!picked) return undefined;
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
    path.join(app.getPath("userData"), "cloud-agent-packages");
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
