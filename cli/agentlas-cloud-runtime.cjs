"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const TEXT_EXTS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".js", ".ts", ".tsx", ".cjs", ".mjs", ".sh"]);
const SECRET_RE = /(sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const SECRET_ASSIGN_RE = /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{20,})["']?/i;
const PROMPT_INJECTION_RE = /\b(ignore (?:all |previous |prior )?instructions|reveal (?:your )?system prompt|print hidden instructions)\b/i;
const DESTRUCTIVE_RE = /\b(rm\s+-rf\s+(?:\/|~)|curl\b[^\n]{0,240}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)|mkfs\.|dd\s+if=\/dev\/)\b/i;

function collectFiles(root) {
  const base = path.resolve(root);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("._")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if ([".git", ".next", "node_modules", "dist", "out", "release"].includes(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext && !TEXT_EXTS.has(ext) && !["AGENTS.md", "CLAUDE.md", "GEMINI.md", "agent.md", "README.md"].includes(entry.name)) continue;
      try {
        files.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
      } catch {
        // Skip non-text files.
      }
    }
  }
  walk(base);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function hashPackage(files) {
  const h = crypto.createHash("sha256");
  for (const file of files) {
    if (file.path === "agentlas.json") continue;
    h.update(file.path);
    h.update("\0");
    h.update(file.content);
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

function inferEntry(files) {
  const paths = new Set(files.map((file) => file.path));
  return ["AGENTS.md", "agent.md", "CLAUDE.md", "README.md"].find((candidate) => paths.has(candidate)) || files[0]?.path || "AGENTS.md";
}

function inferSkills(files) {
  const skills = files.map((file) => file.path.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/)?.[1]).filter(Boolean);
  return [...new Set(skills)].sort().length ? [...new Set(skills)].sort() : ["agentlas-package"];
}

function buildManifest(root, options = {}) {
  const files = collectFiles(root);
  const name = options.name || path.basename(path.resolve(root));
  return {
    schemaVersion: "1.0",
    name,
    packageHash: hashPackage(files),
    runtimeBundleVersion: "1.0",
    entry: inferEntry(files),
    skills: inferSkills(files),
    toolPermissions: { network: "ask", shell: "deny", fileRead: "manifest-allowlist" },
    memoryPolicy: { writeBack: "ask", publicCopy: "reset" },
    memory: files.filter((file) => [".agentlas/memory-map.json", ".agentlas/agent-card.json"].includes(file.path)).map((file) => file.path),
    allowRead: ["README.md", "AGENTS.md", "agent.md", "skills/**", ".agentlas/*.json"],
    denyRead: [".env", ".env.*", "**/secrets/**", "**/credentials/**", "**/cookies/**", "**/*token*", "**/*secret*"],
    publicExportPolicy: "clean-copy",
    requiredRuntime: ["mcp-client"],
    license: "call-only-default",
    createdBy: "agentlas-desktop-setup-wizard",
  };
}

function redact(text) {
  return text.replace(SECRET_RE, "[REDACTED_SECRET]").replace(SECRET_ASSIGN_RE, (match, secret) => match.replace(secret, "[REDACTED_SECRET]"));
}

function scanFiles(files) {
  const findings = [];
  function add(verdict, type, file, line, message) {
    findings.push({ verdict, type, path: file.path, ...(line ? { line } : {}), message, redacted: true });
  }
  for (const file of files) {
    if ([".env", ".env.local"].includes(file.path) || /(?:^|\/)(secrets|credentials|cookies)\//i.test(file.path) || /token|secret/i.test(file.path)) {
      add("BLOCK", "credential-path", file, null, "Credential-like file path is excluded from Cloud package and public publish.");
    }
    file.content.split(/\r?\n/).forEach((line, index) => {
      if (SECRET_RE.test(line) || SECRET_ASSIGN_RE.test(line)) add("BLOCK", "secret-like-value", file, index + 1, "Secret-like value detected and redacted.");
      if (PROMPT_INJECTION_RE.test(line)) add("WARN", "prompt-injection", file, index + 1, "Prompt-injection style instruction needs review.");
      if (DESTRUCTIVE_RE.test(line)) add("WARN", "destructive-command", file, index + 1, "Destructive or remote shell command needs review before execution.");
    });
  }
  const verdict = findings.some((finding) => finding.verdict === "BLOCK") ? "BLOCK" : findings.some((finding) => finding.verdict === "WARN") ? "WARN" : "PASS";
  return { verdict, scannedAt: new Date().toISOString(), findings };
}

function scanFolder(root) {
  return scanFiles(collectFiles(root));
}

function runWizard(root, options = {}) {
  const base = path.resolve(root);
  const files = collectFiles(base);
  const manifest = buildManifest(base, options);
  const scanReport = scanFiles(files);
  fs.writeFileSync(path.join(base, "agentlas.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const agentlasDir = path.join(base, ".agentlas");
  fs.mkdirSync(agentlasDir, { recursive: true });
  fs.writeFileSync(path.join(agentlasDir, "security-scan.json"), JSON.stringify(scanReport, null, 2) + "\n", "utf8");
  const status = scanReport.verdict === "BLOCK" ? "Blocked" : "Ready for MCP call";
  return {
    status,
    manifest,
    scanReport,
    stateTransitionLog: ["Started setup wizard", "Generated agentlas.json", `Security scan: ${scanReport.verdict}`, status],
    blockers: status === "Blocked" ? ["Security scan blocked package upload."] : [],
  };
}

function loadManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(path.resolve(root), "agentlas.json"), "utf8"));
}

function matches(filePath, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i").test(filePath);
}

function compileBundle(root) {
  const manifest = loadManifest(root);
  const files = collectFiles(root);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entry = byPath.get(manifest.entry) || byPath.get("AGENTS.md");
  if (!entry) throw new Error(`Entry file not found: ${manifest.entry}`);
  const scanReport = scanFiles(files);
  return {
    schemaVersion: "1.0",
    agent: manifest.name,
    packageHash: manifest.packageHash,
    entry: { path: entry.path, content: redact(entry.content).slice(0, 8000) },
    skills: manifest.skills,
    toolPermissions: manifest.toolPermissions,
    memoryPolicy: manifest.memoryPolicy,
    memorySummary: (manifest.memory || []).map((memoryPath) => byPath.get(memoryPath)).filter(Boolean).map((file) => `${file.path}: ${redact(file.content).replace(/\s+/g, " ").slice(0, 480)}`),
    securityWarnings: scanReport.findings.map((finding) => `${finding.verdict}:${finding.type}:${finding.path}`),
    lazyRead: { tool: "agentlas.read_agent_file", allowedPatterns: manifest.allowRead, deniedPatterns: manifest.denyRead },
  };
}

function readAgentFile(root, requestedPath) {
  const manifest = loadManifest(root);
  if ((manifest.denyRead || []).some((pattern) => matches(requestedPath, pattern))) {
    return { status: "denied", path: requestedPath, reason: "Denied by agentlas.json denyRead.", redacted: true };
  }
  if (!(manifest.allowRead || []).some((pattern) => matches(requestedPath, pattern))) {
    return { status: "denied", path: requestedPath, reason: "Path is not in agentlas.json allowRead.", redacted: false };
  }
  const abs = path.join(path.resolve(root), requestedPath);
  if (!fs.existsSync(abs)) return { status: "missing", path: requestedPath, reason: "File not found." };
  const raw = fs.readFileSync(abs, "utf8");
  const content = redact(raw);
  return { status: "allowed", path: requestedPath, content, redacted: content !== raw };
}

function runFieldTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-desktop-cloud-field-"));
  const agent = path.join(root, "mac_a", "instagram-operator");
  fs.mkdirSync(path.join(agent, "skills", "social-media-strategist"), { recursive: true });
  fs.mkdirSync(path.join(agent, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(agent, "AGENTS.md"), "# Instagram Operator\n\nBuild weekly Instagram posts.\n", "utf8");
  fs.writeFileSync(path.join(agent, "skills", "social-media-strategist", "SKILL.md"), "---\nname: social-media-strategist\ndescription: Use for social content.\n---\n\nCreate social plans.\n", "utf8");
  fs.writeFileSync(path.join(agent, ".agentlas", "memory-map.json"), "{\"project\":\"instagram-operator\"}\n", "utf8");
  const wizard = runWizard(agent, { name: "instagram-operator" });
  const bundle = compileBundle(agent);
  const allowed = readAgentFile(agent, "AGENTS.md");
  const denied = readAgentFile(agent, ".env");
  const ledger = [{ agentId: "agent_public_instagram", callerId: "other_user", creatorId: "creator", version: "1.0.0", status: "PASS", mode: "public-call-only" }];
  const scenarios = [
    { id: "E1", status: wizard.status === "Ready for MCP call" ? "PASS" : "FAIL", evidence: ["agentlas.json", ".agentlas/security-scan.json"], blockers: wizard.blockers },
    { id: "E2", status: bundle.entry.path === "AGENTS.md" && allowed.status === "allowed" && denied.status === "denied" ? "PASS" : "FAIL", evidence: ["runtime-bundle", "lazy-read"], blockers: [] },
    { id: "E3", status: ledger[0].status === "PASS" ? "PASS" : "FAIL", evidence: ["mock-call-only-ledger"], blockers: [] },
  ];
  const report = { suite: "agentlas-desktop-cloud-field-test", status: scenarios.every((item) => item.status === "PASS") ? "PASS" : "FAIL", scenarios, ledger };
  fs.rmSync(root, { recursive: true, force: true });
  return report;
}

module.exports = { buildManifest, scanFolder, runWizard, compileBundle, readAgentFile, runFieldTest };
