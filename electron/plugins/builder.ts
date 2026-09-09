import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { McpInvocationRequest, RunEventUi } from "../../shared/types";
import type {
  PluginBuilderAnswers,
  PluginBuilderPhase,
  PluginBuilderProgressEvent,
  PluginBuilderSeed,
  PluginBuilderSession,
  PluginDraftResult,
  PluginGateReport,
  PluginInstallReceipt,
  PluginProofReceipt,
} from "../../shared/plugin-builder";
import { isOnePluginBuildSignal } from "../../shared/one-suggestions";
import {
  createPluginBuilderSession,
  discardPluginBuilderSession,
  getPluginBuilderSession,
  listAllPluginBuilderSessions,
  listPluginBuilderSessions,
  updatePluginBuilderSession,
  type PluginBuilderSessionRow,
} from "../store/plugin-builder";
import { listRunEvents } from "../store/run-events";
import { invocationService } from "../invocation/service";
import { pluginRouterPrompt, resetPluginRouterCache } from "./router-prompt";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const WORKFLOW_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_RELATIVE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const HOST_CAPABILITIES = new Set(["browser", "computer-use", "agent-routing", "time", "workspace-preview", "data", "custom"]);
const FILE_WRITES = new Set(["none", "project-only", "ask", "full"]);
const NETWORKS = new Set(["none", "ask", "allow"]);
const SHELLS = new Set(["deny", "ask", "allow"]);
const CATEGORIES = new Set(["design", "dev", "data", "web", "productivity", "communication", "custom"]);
const MAX_LINE = 600;
const PROVE_TIMEOUT_MS = 120_000;

type WorkflowRunResult = { ok: boolean; summary: string };
type WorkflowRunner = (input: {
  chatId: string;
  slug: string;
  workflow: string;
  packageDir: string;
}) => Promise<WorkflowRunResult>;

let testWorkflowRunner: WorkflowRunner | null = null;
const progressListeners = new Set<(event: PluginBuilderProgressEvent) => void>();

export function setPluginBuilderWorkflowRunnerForTests(runner: WorkflowRunner | null): void {
  testWorkflowRunner = runner;
}

export function subscribePluginBuilderProgress(listener: (event: PluginBuilderProgressEvent) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function emit(sessionId: string, phase: PluginBuilderPhase, line: string): void {
  const event = { sessionId, phase, line } satisfies PluginBuilderProgressEvent;
  for (const listener of progressListeners) {
    try { listener(event); } catch { /* a renderer disconnect must not stop the builder */ }
  }
}

function pluginsRoot(): string {
  return path.join(os.homedir(), ".agentlas", "plugins");
}

function stagingRoot(): string {
  return path.join(pluginsRoot(), ".staging");
}

function toSession(row: PluginBuilderSessionRow): PluginBuilderSession {
  return {
    id: row.id,
    chatId: row.chatId,
    slug: row.slug,
    phase: row.phase === "discarded" ? "interview" : row.phase,
    stagingDir: row.stagingDir,
    answers: row.answers,
    gateReport: row.gateReport as PluginGateReport | null,
    seed: row.seed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertChatId(chatId: unknown): asserts chatId is string {
  if (typeof chatId !== "string" || !chatId.trim() || chatId.length > 256) {
    throw new TypeError("Plugin builder chatId is invalid");
  }
}

function assertSeed(seed: PluginBuilderSeed): void {
  if (!seed || typeof seed !== "object") throw new TypeError("Plugin builder seed is required");
  if (seed.kind === "suggestion") {
    if (!/^one_suggestion_[a-f0-9]{32}$/.test(seed.suggestionId) || !isOnePluginBuildSignal(seed.signal)) {
      throw new TypeError("Plugin builder suggestion seed is incomplete or unsafe");
    }
    return;
  }
  if ((seed.kind === "mention" || seed.kind === "agent-offer") && !seed.request.trim()) {
    throw new TypeError("Plugin builder request is empty");
  }
  if (seed.kind === "agent-offer") assertChatId(seed.chatId);
}

function cleanText(value: unknown, label: string, min = 1, max = MAX_LINE): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.replace(/\r?\n/g, " ").trim();
  if (text.length < min || text.length > max) throw new TypeError(`${label} must be ${min}-${max} characters`);
  return text.replaceAll("$", "＄");
}

function cleanLines(value: unknown, label: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${label} must contain ${min}-${max} entries`);
  }
  return value.map((item, index) => cleanText(item, `${label}[${index}]`, 1, MAX_LINE));
}

function cleanRelative(value: unknown, label: string): string {
  const text = cleanText(value, label, 1, 160);
  if (!SAFE_RELATIVE_RE.test(text) || path.posix.isAbsolute(text) || text.includes("..") || text.startsWith(".state/")) {
    throw new TypeError(`${label} must be a safe relative state path`);
  }
  return text;
}

function normalizeAnswers(input: PluginBuilderAnswers): PluginBuilderAnswers {
  if (!input || typeof input !== "object") throw new TypeError("Plugin builder answers are required");
  const slug = cleanText(input.slug, "slug", 2, 64);
  if (!SLUG_RE.test(slug)) throw new TypeError("slug must match [a-z0-9][a-z0-9-]{1,63}");
  const name = cleanText(input.name, "name", 1, 120);
  const description = cleanText(input.description, "description", 1, 240);
  if (!CATEGORIES.has(input.category)) throw new TypeError("category is invalid");
  if (!Array.isArray(input.workflows) || input.workflows.length < 1 || input.workflows.length > 12) {
    throw new TypeError("workflows must contain 1-12 entries");
  }
  const workflows = input.workflows.map((workflow, index) => {
    const workflowName = cleanText(workflow.name, `workflows[${index}].name`, 2, 64);
    if (!WORKFLOW_RE.test(workflowName)) throw new TypeError(`workflow name is invalid: ${workflowName}`);
    return {
      name: workflowName,
      description: cleanText(workflow.description, `workflows[${index}].description`, 1, 240),
      steps: cleanLines(workflow.steps, `workflows[${index}].steps`, 1, 24),
      outputs: cleanLines(workflow.outputs, `workflows[${index}].outputs`, 1, 12),
      verification: cleanLines(workflow.verification, `workflows[${index}].verification`, 1, 12),
    };
  });
  if (new Set(workflows.map((workflow) => workflow.name)).size !== workflows.length) {
    throw new TypeError("workflow names must be unique");
  }
  if (!Array.isArray(input.requiresTools) || input.requiresTools.length > 16) {
    throw new TypeError("requiresTools must contain 0-16 capabilities");
  }
  const requiresTools = [...new Set(input.requiresTools.map((tool) => cleanText(tool, "requiresTools", 1, 64)))];
  if (requiresTools.some((tool) => !HOST_CAPABILITIES.has(tool))) {
    throw new TypeError(`requiresTools must use host capabilities: ${[...HOST_CAPABILITIES].join(", ")}`);
  }
  if (!input.permissions || !FILE_WRITES.has(input.permissions.fileWrite)
    || !NETWORKS.has(input.permissions.network) || !SHELLS.has(input.permissions.shell)) {
    throw new TypeError("permissions are invalid");
  }
  if (!input.state || !Array.isArray(input.state.files) || typeof input.state.assets !== "boolean") {
    throw new TypeError("state is invalid");
  }
  const stateFiles = [...new Set(input.state.files.map((file) => cleanRelative(file, "state.files")))];
  return {
    slug,
    name,
    description,
    category: input.category,
    workflows,
    requiresTools,
    permissions: {
      fileWrite: input.permissions.fileWrite,
      network: input.permissions.network,
      shell: input.permissions.shell,
    },
    state: { files: stateFiles, assets: input.state.assets },
  };
}

function safeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|");
}

function iconSvg(name: string): string {
  const mark = name.slice(0, 2).toUpperCase().replace(/[^A-Z0-9]/g, "A");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${mark}"><rect width="128" height="128" rx="28" fill="#1f2937"/><text x="64" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="42" font-weight="700" fill="#fff">${mark}</text></svg>\n`;
}

function routerSkill(answers: PluginBuilderAnswers): string {
  const routes = answers.workflows.map((workflow) => `- **${workflow.name}**: ${workflow.description} → $${workflow.name}`).join("\n");
  return `---\nname: index\ndescription: ${answers.description}\n---\n\n# Routing\n\nUse this procedure plugin when the request matches: ${answers.description}\n\nChoose exactly one workflow and open the referenced skill before acting. If the required host capability is unavailable, report that and stop.\n\n## Workflows\n\n${routes}\n`;
}

function workflowSkill(workflow: PluginBuilderAnswers["workflows"][number]): string {
  return `---\nname: ${workflow.name}\ndescription: ${workflow.description}\n---\n\n# Steps\n\n${workflow.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n# Outputs\n\n${workflow.outputs.map((output) => `- ${output}`).join("\n")}\n\n# Verification\n\n${workflow.verification.map((check) => `- ${check}`).join("\n")}\n`;
}

function readme(answers: PluginBuilderAnswers): string {
  const rows = answers.workflows.map((workflow) => `| ${safeMarkdown(workflow.name)} | ${safeMarkdown(workflow.description)} |`).join("\n");
  return `# ${answers.name}\n\n${answers.description}\n\n## Workflows\n\n| Skill | Purpose |\n| --- | --- |\n${rows}\n\n## Limitations\n\nThis package is local-only. It does not publish to the Agentlas Hub and it does not provide new host tools.\n`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function walkFiles(root: string, current = root, output: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, absolute, output);
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return output.sort();
}

export async function buildPluginPackage(packageDir: string, input: PluginBuilderAnswers): Promise<{
  manifest: Record<string, unknown>;
  files: string[];
}> {
  const answers = normalizeAnswers(input);
  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.mkdir(packageDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    schema: "agentlas.plugin/v2",
    slug: answers.slug,
    name: answers.name,
    version: "0.1.0",
    builtin: false,
    publisher: { name: "Agentlas local", url: "https://agentlas.cloud" },
    surface: {
      displayName: answers.name,
      displayNameKo: answers.name,
      tagline: answers.description,
      taglineKo: answers.description,
      description: answers.description,
      descriptionKo: answers.description,
      category: answers.category,
      brandColor: "#1F2937",
      icon: "assets/icon.svg",
      defaultPrompts: [answers.description],
    },
    invocation: { mention: `@${answers.slug}`, implicit: "router", standalone: true },
    provides: {
      skills: {
        router: "skills/index/SKILL.md",
        workflows: answers.workflows.map((workflow) => workflow.name),
      },
    },
    requires: {
      tools: answers.requiresTools,
      prereq: [{ id: "node", "provided-by": "app" }],
      os: ["darwin", "win32", "linux"],
    },
    permissions: answers.permissions,
    state: answers.state,
    integrity: { algo: "sha256", files: [] },
  };
  const files: Record<string, string> = {
    "README.md": readme(answers),
    "skills/index/SKILL.md": routerSkill(answers),
    "assets/icon.svg": iconSvg(answers.name),
  };
  for (const workflow of answers.workflows) files[`skills/${workflow.name}/SKILL.md`] = workflowSkill(workflow);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(packageDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
  const integrityFiles = [] as Array<{ path: string; sha256: string; bytes: number }>;
  for (const relative of await walkFiles(packageDir)) {
    const bytes = await fs.readFile(path.join(packageDir, relative));
    integrityFiles.push({ path: relative, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  (manifest.integrity as Record<string, unknown>).files = integrityFiles;
  await fs.writeFile(path.join(packageDir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, files: ["plugin.json", ...integrityFiles.map((file) => file.path)] };
}

function gateCandidates(): string[] {
  return [
    path.join(__dirname, "plugin-spec-gate.cjs"),
    path.resolve(process.cwd(), "scripts", "plugin-spec-gate.cjs"),
    path.resolve(__dirname, "../../scripts/plugin-spec-gate.cjs"),
    path.resolve(__dirname, "../../../scripts/plugin-spec-gate.cjs"),
  ];
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try { await fs.access(candidate); return candidate; } catch { /* next candidate */ }
  }
  return null;
}

async function executeGate(gatePath: string, packageDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [gatePath, packageDir], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export async function runPluginSpecGate(packageDir: string): Promise<PluginGateReport> {
  const checkedAt = new Date().toISOString();
  const gatePath = await firstExisting(gateCandidates());
  if (!gatePath) {
    return { ok: false, packageDir, violations: ["GATE: plugin-spec-gate.cjs is not available in this build"], checkedAt };
  }
  const result = await executeGate(gatePath, packageDir);
  const combined = `${result.stdout}\n${result.stderr}`;
  const violations = [...combined.matchAll(/^\s+·\s+(.+)$/gm)].map((match) => match[1].trim());
  if (result.code !== 0 && violations.length === 0) violations.push(`GATE: plugin-spec-gate exited with code ${result.code}`);
  return { ok: result.code === 0 && violations.length === 0, packageDir, violations, checkedAt, stdout: result.stdout, stderr: result.stderr };
}

async function verifyIntegrity(packageDir: string, manifest: Record<string, unknown>): Promise<string[]> {
  const violations: string[] = [];
  const integrity = manifest.integrity as Record<string, unknown> | undefined;
  const declared = Array.isArray(integrity?.files) ? integrity.files : [];
  const declaredByPath = new Map<string, Record<string, unknown>>(
    declared.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => [String(item.path), item]),
  );
  const actual = await walkFiles(packageDir);
  for (const relative of actual) {
    if (relative === "plugin.json") continue;
    const item = declaredByPath.get(relative);
    if (!item) {
      violations.push(`G4: integrity.files does not cover ${relative}`);
      continue;
    }
    const digest = sha256(await fs.readFile(path.join(packageDir, relative)));
    if (item.sha256 !== digest) violations.push(`G4: integrity hash mismatch for ${relative}`);
  }
  for (const relative of declaredByPath.keys()) {
    if (!actual.includes(relative)) violations.push(`G4: integrity.files names missing file ${relative}`);
  }
  return violations;
}

async function sessionOrThrow(sessionId: string): Promise<PluginBuilderSessionRow> {
  const session = getPluginBuilderSession(sessionId);
  if (!session || session.phase === "discarded") throw new Error(`Plugin builder session not found: ${sessionId}`);
  return session;
}

function assertSlugOwner(sessionId: string, slug: string): void {
  const owner = listAllPluginBuilderSessions().find((item) =>
    item.id !== sessionId && item.slug === slug && item.phase !== "discarded" && item.phase !== "prove",
  );
  if (owner) throw new Error(`Plugin slug is already being drafted: ${slug}`);
}

export async function startPluginBuilder(input: { chatId: string; seed: PluginBuilderSeed }): Promise<PluginBuilderSession> {
  assertChatId(input.chatId);
  assertSeed(input.seed);
  if (input.seed.kind === "agent-offer" && input.seed.chatId !== input.chatId) {
    throw new Error("Plugin builder agent-offer seed must belong to the current conversation");
  }
  if (input.seed.kind === "agent-offer") {
    const offered = listAllPluginBuilderSessions().some((session) =>
      session.chatId === input.chatId
      && session.seed.kind === "agent-offer"
      && session.seed.chatId === input.chatId,
    );
    if (offered) throw new Error("Plugin builder was already offered once in this conversation");
  }
  const row = createPluginBuilderSession({ chatId: input.chatId, seed: input.seed });
  emit(row.id, "interview", "Plugin builder session started. Resolve the request and package identity first.");
  return toSession(row);
}

export async function draftPluginBuilder(input: { sessionId: string; answers: PluginBuilderAnswers }): Promise<PluginDraftResult> {
  const session = await sessionOrThrow(input.sessionId);
  const answers = normalizeAnswers(input.answers);
  if (session.slug && session.slug !== answers.slug) throw new Error(`Plugin slug is immutable for this draft: ${session.slug}`);
  assertSlugOwner(session.id, answers.slug);
  const packageDir = path.join(stagingRoot(), answers.slug);
  const stagingParent = path.resolve(stagingRoot());
  if (path.dirname(packageDir) !== stagingParent) throw new Error("Plugin staging path escaped its root");
  emit(session.id, "draft", `Writing ${answers.slug} into the staging directory.`);
  const built = await buildPluginPackage(packageDir, answers);
  const next = updatePluginBuilderSession(session.id, {
    slug: answers.slug,
    phase: "draft",
    stagingDir: packageDir,
    answers,
    gateReport: null,
  });
  emit(session.id, "draft", `Drafted ${built.files.length} UTF-8 files without a manifest BOM.`);
  return {
    session: toSession(next),
    packageDir,
    files: built.files,
    manifest: built.manifest,
    summary: `${answers.name} drafted as @${answers.slug} with ${answers.workflows.length} workflow(s).`,
  };
}

export async function verifyPluginBuilder(input: { sessionId: string }): Promise<PluginGateReport> {
  const session = await sessionOrThrow(input.sessionId);
  const packageDir = session.stagingDir;
  if (!packageDir || !path.basename(packageDir) || !packageDir.includes(`${path.sep}.staging${path.sep}`)) {
    throw new Error("Plugin builder has no staging package to verify");
  }
  emit(session.id, "verify", "Running the canonical plugin-spec gate.");
  const gate = await runPluginSpecGate(packageDir);
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = JSON.parse((await fs.readFile(path.join(packageDir, "plugin.json"))).toString("utf8")) as Record<string, unknown>;
  } catch {
    gate.violations.push("G0: generated plugin.json could not be parsed");
  }
  if (manifest) {
    gate.violations.push(...await verifyIntegrity(packageDir, manifest));
    gate.manifestSha256 = sha256(await fs.readFile(path.join(packageDir, "plugin.json")));
  }
  gate.ok = gate.violations.length === 0 && gate.ok;
  updatePluginBuilderSession(session.id, { phase: "verify", gateReport: gate as unknown as Record<string, unknown> });
  for (const violation of gate.violations) emit(session.id, "verify", violation);
  emit(session.id, "verify", gate.ok ? "Spec gate and integrity verification passed." : "Verification stopped; repair the listed gate violations before install.");
  return gate;
}

async function copyPackageTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyPackageTree(source, target);
    else if (entry.isFile()) await fs.copyFile(source, target);
  }
}

async function clearInstalledPackageFiles(target: string): Promise<void> {
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    await fs.rm(path.join(target, entry.name), { recursive: true, force: true });
  }
}

export async function installPluginBuilder(input: { sessionId: string }): Promise<PluginInstallReceipt> {
  const session = await sessionOrThrow(input.sessionId);
  const gate = await verifyPluginBuilder(input);
  if (!gate.ok) {
    throw new Error(`Plugin builder install refused:\n${gate.violations.join("\n")}`);
  }
  const refreshed = await sessionOrThrow(input.sessionId);
  const slug = refreshed.slug;
  const source = refreshed.stagingDir;
  if (!slug || !source) throw new Error("Plugin builder draft is incomplete");
  const target = path.join(pluginsRoot(), slug);
  await fs.mkdir(pluginsRoot(), { recursive: true });
  let updated = false;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Refusing to install through a plugin symlink");
    if (!stat.isDirectory()) throw new Error("Plugin install target is not a directory");
    updated = true;
    await clearInstalledPackageFiles(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(target, { recursive: true });
  }
  await copyPackageTree(source, target);
  const manifestBytes = await fs.readFile(path.join(target, "plugin.json"));
  const installedAt = new Date().toISOString();
  const installManifestPath = path.join(target, ".install.json");
  await fs.writeFile(installManifestPath, `${JSON.stringify({
    source: { kind: "local-build", builder: "plugin-make", chatId: refreshed.chatId },
    installedAt,
    verified: true,
    manifestSha256: sha256(manifestBytes),
  }, null, 2)}\n`, "utf8");
  await fs.rm(source, { recursive: true, force: true });
  resetPluginRouterCache();
  updatePluginBuilderSession(refreshed.id, { phase: "install", stagingDir: target });
  emit(refreshed.id, "install", `${updated ? "Updated" : "Installed"} ~/.agentlas/plugins/${slug}; .state/ was preserved.`);
  return {
    sessionId: refreshed.id,
    slug,
    installedDir: target,
    installManifestPath,
    updated,
    installedAt,
    manifestSha256: sha256(manifestBytes),
    verified: true,
    summary: `${updated ? "Updated" : "Installed"} @${slug}. User state was not touched.`,
  };
}

function summaryFromEvents(events: RunEventUi[]): string {
  for (const event of [...events].reverse()) {
    for (const key of ["text", "summary", "message", "result"]) {
      const value = event.payload[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    }
  }
  return events.length ? `Workflow completed with ${events.length} recorded runtime event(s).` : "Workflow completed.";
}

async function defaultWorkflowRunner(input: Parameters<WorkflowRunner>[0]): Promise<WorkflowRunResult> {
  const runId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let dispose: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: WorkflowRunResult) => {
      if (settled) return;
      settled = true;
      dispose();
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    dispose = invocationService.onSettled((envelope) => {
      if (envelope.runId !== runId) return;
      const ok = envelope.receipt.status === "completed";
      const events = listRunEvents(runId, 500);
      finish({
        ok,
        summary: ok ? summaryFromEvents(events) : (envelope.receipt.errorMessage || "The workflow runtime did not complete."),
      });
    });
    timer = setTimeout(() => finish({ ok: false, summary: "Workflow proof timed out; the plugin is installed but unproven." }), PROVE_TIMEOUT_MS);
    const request: McpInvocationRequest = {
      runId,
      chatId: input.chatId,
      userPrompt: `@${input.slug} Run the ${input.workflow} workflow with a concrete proof input. Return a concise non-empty summary after following the plugin workflow.`,
      promptOrigin: "system",
      taskIntent: "task",
      locale: "en",
      permissions: "read",
      sessionRouting: false,
      hubMode: "local-only",
      borrowAgents: [],
    };
    try {
      invocationService.start(request);
    } catch (error) {
      finish({ ok: false, summary: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function provePluginBuilder(input: { sessionId: string }): Promise<PluginProofReceipt> {
  const session = await sessionOrThrow(input.sessionId);
  const slug = session.slug;
  const packageDir = session.stagingDir;
  if (!slug || !packageDir || packageDir.includes(`${path.sep}.staging${path.sep}`)) {
    throw new Error("Plugin must be installed before proof");
  }
  const manifest = JSON.parse((await fs.readFile(path.join(packageDir, "plugin.json"))).toString("utf8")) as Record<string, any>;
  const workflows = Array.isArray(manifest.provides?.skills?.workflows) ? manifest.provides.skills.workflows.map(String) : [];
  const workflow = workflows[0] ?? null;
  const router = pluginRouterPrompt(`@${slug} proof`);
  const routerInjected = router.includes(`@${slug}`) && router.includes("Router:") && router.includes("router (invoked in this turn)");
  let workflowRun: PluginProofReceipt["workflowRun"] = null;
  if (workflow) {
    emit(session.id, "prove", `Invoking @${slug} ${workflow} once for execution proof.`);
    const result = await (testWorkflowRunner ?? defaultWorkflowRunner)({ chatId: session.chatId, slug, workflow, packageDir });
    workflowRun = { name: workflow, ok: result.ok, summary: result.summary };
  }
  const proven = routerInjected && Boolean(workflowRun?.ok && workflowRun.summary.trim());
  const reason = proven
    ? undefined
    : !routerInjected
      ? "The installed package was not present in the injected router prompt."
      : !workflowRun
        ? "The package has no workflow to invoke."
        : workflowRun.summary || "The required runtime or tool was unavailable.";
  updatePluginBuilderSession(session.id, { phase: "prove" });
  emit(session.id, "prove", proven ? "Router injection and workflow execution proof passed." : `Installed but unproven: ${reason}`);
  return { sessionId: session.id, slug, installed: true, routerInjected, workflowRun, proven, ...(reason ? { reason } : {}) };
}

export async function discardPluginBuilder(input: { sessionId: string }): Promise<void> {
  const session = await sessionOrThrow(input.sessionId);
  if (session.stagingDir && session.stagingDir.includes(`${path.sep}.staging${path.sep}`)) {
    await fs.rm(session.stagingDir, { recursive: true, force: true });
  }
  discardPluginBuilderSession(session.id);
  emit(session.id, "interview", "Plugin builder draft discarded.");
}

export function listPluginBuilderDrafts(chatId: string): PluginBuilderSession[] {
  assertChatId(chatId);
  return listPluginBuilderSessions(chatId).map(toSession);
}
