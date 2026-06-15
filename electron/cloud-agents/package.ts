import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { detectRuntimeLabels } from "../agents/import-local";
import { getSessionCookieHeader } from "../auth";
import { pickActiveRunner } from "../mcp/client";
import type {
  CloudAgentPackageFile,
  CloudAgentPackageManifest,
  CloudAgentPackageResult,
  CloudAgentPublishRequest,
  CloudAgentRegistrationResult,
  CloudAgentReviewResult,
  CloudAgentSecurityFinding,
  CloudAgentVisibility,
} from "../../shared/types";

const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MANIFEST_VERSION = "0.1" as const;
const ROUTING_CARD_PATH = ".agentlas/routing-card.json";
const ROUTING_CARD_CAPABILITY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const ROUTING_CARD_STATUSES = new Set(["draft", "searchable", "candidate", "routing_ready", "trusted"]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
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
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, label: "Slack token" },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
  { id: "generic-secret", re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: "hard-coded credential" },
];

interface PackagedTextFile {
  path: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
}

interface StaticScanResult {
  files: CloudAgentPackageFile[];
  included: PackagedTextFile[];
  findings: CloudAgentSecurityFinding[];
  totalBytes: number;
}

export async function packageAndReviewCloudAgent(
  input: CloudAgentPublishRequest,
): Promise<CloudAgentPackageResult> {
  const rootPath = path.resolve(input.rootPath);
  const stat = statSafe(rootPath);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Cloud agent root is not a directory: ${input.rootPath}`);
  }

  const visibility = input.visibility ?? "marketplace";
  const scan = scanAgentFolder(rootPath);
  const routingCard = readRoutingCard(rootPath);
  if (routingCard.finding) scan.findings.push(routingCard.finding);
  const name = readName(rootPath);
  const tagline = readTagline(rootPath);
  const slug = sanitizeSlug(input.slug || name || path.basename(rootPath));
  const packageHash = hashPackage(scan.included);
  const manifest: CloudAgentPackageManifest & { routingCard?: Record<string, unknown> } = {
    version: MANIFEST_VERSION,
    kind: "agentlas-cloud-agent",
    slug,
    name,
    tagline,
    agentKind: inferAgentKind(rootPath),
    runtimeLabels: detectRuntimeLabels(rootPath),
    visibility,
    rootFingerprint: sha256(rootPath),
    packageHash,
    fileCount: scan.files.length,
    includedFileCount: scan.included.length,
    // 업로드되는 bundle은 included 파일만 담는다. 서버 register는 받은 bundle의
    // bytes 합을 totalBytes로 검증하므로, manifest.totalBytes도 included 기준이어야
    // 한다. (scan.totalBytes는 제외 파일까지 포함한 전체 — MAX_TOTAL_BYTES 게이트용.)
    totalBytes: scan.included.reduce((sum, file) => sum + file.bytes, 0),
    createdAt: new Date().toISOString(),
    billingMode: input.reviewMode === "local-runtime" ? "submitter-local-runtime" : "static-only",
    costOwner: input.reviewMode === "local-runtime" ? "submitter" : "none",
    security: summarizeSecurity(scan.findings),
    ...(routingCard.card ? { routingCard: routingCard.card } : {}),
  };

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
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const review =
    input.reviewMode === "local-runtime"
      ? await runSubmitterRuntimeReview(rootPath, manifest, scan.findings)
      : staticReview(scan.findings);
  const blocked = isBlocked(scan.findings, review);
  const dryRun = input.dryRun ?? false;

  let registration: CloudAgentRegistrationResult | undefined;
  let status: CloudAgentPackageResult["status"] = blocked ? "blocked" : dryRun ? "dry-run" : "ready";
  if (!blocked && !dryRun) {
    registration = await registerCloudAgent({
      manifest,
      bundlePath,
      review,
      visibility,
      notes: input.notes,
    });
    status = "registered";
  }

  return {
    status,
    rootPath,
    packageDir,
    bundlePath,
    manifestPath,
    manifest: {
      ...manifest,
      security: summarizeSecurity([...scan.findings, ...review.findings]),
    },
    files: scan.files,
    review,
    registration,
    summary:
      status === "registered"
        ? `Registered ${slug} on Agentlas Cloud.`
        : status === "blocked"
          ? `Package blocked: ${review.summary}`
          : `Package ready: ${slug}.`,
  };
}

function scanAgentFolder(rootPath: string): StaticScanResult {
  const files: CloudAgentPackageFile[] = [];
  const included: PackagedTextFile[] = [];
  const findings: CloudAgentSecurityFinding[] = [];
  let totalBytes = 0;
  let seenFiles = 0;
  let hasAgentDef = false;

  function walk(dir: string): void {
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
        walk(abs);
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
        files.push({ path: rel, bytes: st.size, sha256: hashFile(abs), kind: "binary", included: false, reason: "secret-file-blocked" });
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        findings.push({
          id: findingId("large-file", rel),
          severity: "high",
          category: "size",
          file: rel,
          message: `File exceeds ${MAX_FILE_BYTES} bytes.`,
          remediation: "Move large assets to a documented external source or reduce the package.",
        });
        files.push({ path: rel, bytes: st.size, sha256: hashFile(abs), kind: "binary", included: false, reason: "file-too-large" });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isText = TEXT_EXTENSIONS.has(ext) || AGENT_DEF_FILES.has(entry.name);
      const digest = hashFile(abs);
      if (!isText) {
        files.push({ path: rel, bytes: st.size, sha256: digest, kind: "binary", included: false, reason: "binary-skipped" });
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) {
          findings.push({
            id: findingId(pattern.id, rel),
            severity: "blocker",
            category: "secret",
            file: rel,
            message: `Possible ${pattern.label} found in package content.`,
            remediation: "Remove the secret value and require users to configure their own key through Agentlas env/BYOK vault.",
          });
        }
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
      files.push({ path: rel, bytes: st.size, sha256: digest, kind: "text", included: true });
      included.push({ path: rel, bytes: st.size, sha256: digest, contentBase64: Buffer.from(text, "utf8").toString("base64") });
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

function staticReview(findings: CloudAgentSecurityFinding[]): CloudAgentReviewResult {
  const blockers = findings.filter((f) => f.severity === "blocker");
  const high = findings.filter((f) => f.severity === "high");
  const verdict = blockers.length > 0 ? "fail" : high.length > 0 ? "needs-review" : "pass";
  return {
    mode: "static-only",
    verdict,
    costOwner: "none",
    summary:
      verdict === "pass"
        ? "Static package review passed without blocker findings."
        : `${blockers.length} blocker(s), ${high.length} high-risk finding(s).`,
    findings,
    reviewedAt: new Date().toISOString(),
  };
}

function readRoutingCard(rootPath: string): {
  card?: Record<string, unknown>;
  finding?: CloudAgentSecurityFinding;
} {
  const abs = path.join(rootPath, ROUTING_CARD_PATH);
  if (!fs.existsSync(abs)) {
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
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
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
      return {
        finding: {
          id: "routing-card-invalid",
          severity: "blocker",
          category: "structure",
          file: ROUTING_CARD_PATH,
          message: `Routing card is invalid: ${problem}`,
          remediation: "Fix .agentlas/routing-card.json before publishing.",
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
}): Promise<CloudAgentRegistrationResult> {
  const cookie = getSessionCookieHeader();
  if (!cookie) throw new Error("Sign in to agentlas.cloud before publishing a cloud agent.");
  const base = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const bundle = JSON.parse(fs.readFileSync(input.bundlePath, "utf8")) as unknown;
  const response = await fetch(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: base,
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
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Agentlas Cloud register failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as Partial<CloudAgentRegistrationResult>;
  return {
    cloudId: json.cloudId || randomUUID(),
    slug: json.slug || input.manifest.slug,
    url: json.url,
    marketplaceUrl: json.marketplaceUrl,
    registeredAt: json.registeredAt || new Date().toISOString(),
    dryRun: false,
  };
}

function readName(rootPath: string): string {
  const text = readFirst(rootPath, ["agent.md", "AGENT.md", "README.md", "CLAUDE.md", "AGENTS.md"], 2000);
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || path.basename(rootPath)).replace(/\s+/g, " ").slice(0, 80);
}

function readTagline(rootPath: string): string {
  const text = readFirst(rootPath, ["README.md", "agent.md", "AGENT.md"], 3000);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
    return trimmed.slice(0, 160);
  }
  return "Portable Agentlas cloud agent package.";
}

function readFirst(rootPath: string, names: string[], maxChars: number): string {
  for (const name of names) {
    const file = path.join(rootPath, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) return fs.readFileSync(file, "utf8").slice(0, maxChars);
    } catch {
      // continue
    }
  }
  return "";
}

function inferAgentKind(rootPath: string): "agent" | "team" | "repo" {
  for (const name of ["TEAM.md", "team.json", "agents", "team", "departments", "hr-departments"]) {
    try {
      if (fs.existsSync(path.join(rootPath, name))) return "team";
    } catch {
      // continue
    }
  }
  if (readFirst(rootPath, ["AGENT.md", "agent.md", "CLAUDE.md", "AGENTS.md"], 2000)) return "agent";
  return "repo";
}

function packageOutputDir(slug: string): string {
  const root =
    process.env.AGENTLAS_CLOUD_PACKAGE_DIR ||
    path.join(app.getPath("userData"), "cloud-agent-packages");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(root, `${slug}-${stamp}`);
}

function hashPackage(files: PackagedTextFile[]): string {
  const h = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(file.path);
    h.update("\0");
    h.update(file.sha256);
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

function statSafe(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function hashFile(file: string): string {
  return sha256(fs.readFileSync(file));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function findingId(kind: string, relPath: string): string {
  return `${kind}-${sha256(relPath).slice(0, 10)}`;
}
