import fs from "node:fs";
import path from "node:path";

const TEST_PATH_RE = /(?:^|[\s"'`=(,])((?:(?:[A-Za-z]:|\.{0,2})[\\/]|[A-Za-z0-9_@-])[A-Za-z0-9_@.:\\/-]*\.(?:test|spec)\.[cm]?[jt]sx?)(?=$|[\s"'`),:;.])/giu;
const MUTATION_TOOL_RE = /^(?:apply_patch|write|edit|multiedit|notebookedit|bash)$/iu;
const SHELL_TOOL_RE = /^(?:bash|shell|terminal)$/iu;

interface PendingTool {
  name: string;
  args?: string;
}

export interface FirmExecutionEvidence {
  readonly schemaVersion: "agentlas.desktop-firm-execution-evidence.v1";
  readonly projectBound: boolean;
  readonly artifactPaths: readonly string[];
  readonly deletedArtifactPaths: readonly string[];
  readonly executedTestPaths: readonly string[];
  readonly failedTestPaths: readonly string[];
  readonly completedToolCount: number;
  readonly successfulCommandCount: number;
  readonly invalidEvidenceCodes: readonly string[];
}

export interface FirmVerificationEvidenceResult {
  readonly ok: boolean;
  readonly requiredTestPaths: readonly string[];
  readonly issues: readonly string[];
}

export function updateFirmPartialCheckpoint(
  current: string,
  incoming: string,
  maxChars = 12_000,
): string {
  const next = incoming.replaceAll("\0", "").trim();
  if (!next) return current;
  let combined = next.startsWith(current)
    ? next
    : current.endsWith(next)
      ? current
      : [current, next].filter(Boolean).join("\n");
  const boundedMax = Math.max(1_024, Math.min(24_000, Math.floor(maxChars)));
  if (combined.length > boundedMax) {
    const marker = "\n[… bounded partial checkpoint …]\n";
    const side = Math.max(1, Math.floor((boundedMax - marker.length) / 2));
    combined = `${combined.slice(0, side)}${marker}${combined.slice(-side)}`;
  }
  return combined;
}

interface RootIdentity {
  root: string;
  dev: bigint;
  ino: bigint;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalRoot(rawRoot: string | null | undefined): RootIdentity | null {
  if (!rawRoot) return null;
  try {
    const root = fs.realpathSync.native(path.resolve(rawRoot));
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n) return null;
    return { root, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function rootStable(identity: RootIdentity): boolean {
  try {
    const stat = fs.lstatSync(identity.root, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function safeParentChain(identity: RootIdentity, absolute: string): boolean {
  const relative = path.relative(identity.root, absolute);
  if (!inside(identity.root, absolute)) return false;
  const segments = relative.split(path.sep).filter(Boolean).slice(0, -1);
  let cursor = identity.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function parsedArgs(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > 128_000) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function commandFromArgs(raw: string | undefined): { command: string; cwd: string | null } | null {
  const parsed = parsedArgs(raw);
  const command = typeof parsed?.command === "string" ? parsed.command : null;
  if (!command || command.length > 128_000) return null;
  return {
    command,
    cwd: typeof parsed?.cwd === "string" ? parsed.cwd : null,
  };
}

function changeKindFor(raw: string | undefined, candidate: string): string | null {
  const changes = parsedArgs(raw)?.changes;
  if (!Array.isArray(changes)) return null;
  for (const item of changes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.path !== candidate) continue;
    if (typeof record.kind === "string") return record.kind;
    if (record.kind && typeof record.kind === "object" && !Array.isArray(record.kind)) {
      const type = (record.kind as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
  }
  return null;
}

function testPathsFromText(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(TEST_PATH_RE)) {
    const raw = match[1]?.trim();
    if (!raw || raw.includes("\0")) continue;
    found.add(raw.replaceAll("\\", path.sep));
    if (found.size >= 64) break;
  }
  return [...found];
}

function exactSingleTestRunnerCommand(command: string): boolean {
  const trimmed = command.trim();
  // No typed argv receipt exists at this boundary yet. Admit only one simple,
  // runner-first shell command. A runner name in echo/printf, a comment,
  // substitution, or an earlier/later shell segment is prose rather than
  // evidence that the runner executed the named target.
  if (!trimmed || /[\r\n;|&<>#`]/u.test(trimmed) || trimmed.includes("$(")) return false;
  const envPrefix = String.raw`(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*`;
  const directRunner = String.raw`(?:(?:npx|bunx)\s+|npm\s+exec\s+(?:--\s+)?|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:\.\/node_modules\/\.bin\/)?(?:vitest|jest|mocha|ava|pytest|phpunit|rspec)`;
  const scriptRunner = String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test`;
  const nativeRunner = String.raw`(?:python3?\s+-m\s+pytest|node\s+--test|go\s+test|cargo\s+test)`;
  return new RegExp(`^${envPrefix}(?:${directRunner}|${scriptRunner}|${nativeRunner})(?:\\s|$)`, "iu").test(trimmed);
}

function testCollectionMissing(output: string | undefined): boolean {
  return typeof output === "string" && /(?:no\s+test\s+files?\s+found|no\s+tests?\s+(?:found|collected)|collected\s+0\s+items?|0\s+tests?\s+(?:run|collected))/iu.test(output);
}

function relativeCandidate(identity: RootIdentity, raw: string): string | null {
  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(identity.root, raw);
  if (!inside(identity.root, absolute)) return null;
  const relative = path.relative(identity.root, absolute);
  return relative && !path.isAbsolute(relative) ? relative : null;
}

function safeRegularProjectFile(identity: RootIdentity, relative: string): boolean {
  if (!rootStable(identity)) return false;
  const absolute = path.resolve(identity.root, relative);
  if (!inside(identity.root, absolute) || !safeParentChain(identity, absolute)) return false;
  try {
    const before = fs.lstatSync(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return false;
    const canonical = fs.realpathSync.native(absolute);
    if (!inside(identity.root, canonical) || canonical !== absolute) return false;
    const after = fs.lstatSync(absolute, { bigint: true });
    return after.isFile() && !after.isSymbolicLink()
      && after.dev === before.dev && after.ino === before.ino && after.size === before.size
      && rootStable(identity);
  } catch {
    return false;
  }
}

export class FirmExecutionEvidenceCollector {
  private readonly rootIdentity: RootIdentity | null;
  private readonly pending = new Map<string, PendingTool>();
  private readonly artifacts = new Set<string>();
  private readonly deletedArtifacts = new Set<string>();
  private readonly executedTests = new Set<string>();
  private readonly failedTests = new Set<string>();
  private readonly invalidCodes = new Set<string>();
  private completedToolCount = 0;
  private successfulCommandCount = 0;

  constructor(projectRoot: string | null | undefined) {
    this.rootIdentity = canonicalRoot(projectRoot);
    if (projectRoot && !this.rootIdentity) this.invalidCodes.add("project-root-unverifiable");
  }

  recordTool(
    name: string,
    args: string | undefined,
    result: string | undefined,
    id: string | undefined,
    isError: boolean | undefined,
    artifactPaths: readonly string[] | undefined,
  ): void {
    const toolId = id?.trim() || null;
    if (toolId && result === undefined && !isError) this.pending.set(toolId, { name, args });
    const pending = toolId ? this.pending.get(toolId) : undefined;
    const effectiveName = pending?.name ?? name;
    const effectiveArgs = args ?? pending?.args;
    const completed = result !== undefined || isError === true;
    if (completed) {
      this.completedToolCount += 1;
      if (toolId) this.pending.delete(toolId);
    }

    if (artifactPaths?.length && MUTATION_TOOL_RE.test(effectiveName)) {
      for (const rawCandidate of artifactPaths.slice(0, 128)) {
        this.recordProjectArtifact(rawCandidate, effectiveArgs, effectiveName);
      }
    }

    if (!completed || !SHELL_TOOL_RE.test(effectiveName)) return;
    const command = commandFromArgs(effectiveArgs);
    if (!command) return;
    if (!this.commandCwdInsideProject(command.cwd)) {
      this.invalidCodes.add("command-cwd-outside-project");
      return;
    }
    const rawTests = testPathsFromText(command.command);
    const tests: string[] = [];
    if (this.rootIdentity) {
      for (const candidate of rawTests) {
        const relative = relativeCandidate(this.rootIdentity, candidate);
        if (!relative) this.invalidCodes.add("test-target-outside-project");
        else tests.push(relative);
      }
    }
    // A path mention is not an execution receipt. `cat foo.test.ts`, `test -f`,
    // or a broad runner invocation can all exit zero without collecting that
    // file. Admit only one exact named target passed to a known test runner;
    // machine/JUnit multi-target receipts can be added later as a separate
    // typed source without weakening this boundary.
    const exactTestRun = exactSingleTestRunnerCommand(command.command) && rawTests.length === 1 && tests.length === 1;
    if (!exactTestRun) return;
    if (isError || testCollectionMissing(result)) {
      for (const test of tests) this.failedTests.add(test);
      if (!isError) this.invalidCodes.add("test-target-not-collected");
      return;
    }
    this.successfulCommandCount += 1;
    for (const test of tests) this.executedTests.add(test);
  }

  private commandCwdInsideProject(rawCwd: string | null): boolean {
    if (!this.rootIdentity) return rawCwd === null;
    if (!rawCwd) return rootStable(this.rootIdentity);
    try {
      const canonical = fs.realpathSync.native(path.resolve(rawCwd));
      const stat = fs.lstatSync(canonical, { bigint: true });
      return inside(this.rootIdentity.root, canonical)
        && stat.isDirectory() && !stat.isSymbolicLink() && rootStable(this.rootIdentity);
    } catch {
      return false;
    }
  }

  private recordProjectArtifact(rawCandidate: string, args: string | undefined, toolName: string): void {
    if (!this.rootIdentity || !path.isAbsolute(rawCandidate)) {
      this.invalidCodes.add("artifact-path-unverifiable");
      return;
    }
    const absolute = path.normalize(rawCandidate);
    const relative = relativeCandidate(this.rootIdentity, absolute);
    if (!relative) {
      this.invalidCodes.add("artifact-outside-project");
      return;
    }
    if (!rootStable(this.rootIdentity) || !safeParentChain(this.rootIdentity, absolute)) {
      this.invalidCodes.add("artifact-parent-unsafe");
      return;
    }
    const kind = /^apply_patch$/iu.test(toolName) ? changeKindFor(args, rawCandidate) : null;
    if (kind && /delete|remove/iu.test(kind)) {
      if (fs.existsSync(absolute)) {
        this.invalidCodes.add("deleted-artifact-still-exists");
        return;
      }
      this.deletedArtifacts.add(relative);
      return;
    }
    if (!safeRegularProjectFile(this.rootIdentity, relative)) {
      this.invalidCodes.add("artifact-not-stable-regular-file");
      return;
    }
    this.artifacts.add(relative);
  }

  finalize(): FirmExecutionEvidence {
    if (this.rootIdentity && !rootStable(this.rootIdentity)) this.invalidCodes.add("project-root-replaced");
    return Object.freeze({
      schemaVersion: "agentlas.desktop-firm-execution-evidence.v1" as const,
      projectBound: Boolean(this.rootIdentity),
      artifactPaths: Object.freeze([...this.artifacts].sort()),
      deletedArtifactPaths: Object.freeze([...this.deletedArtifacts].sort()),
      executedTestPaths: Object.freeze([...this.executedTests].sort()),
      failedTestPaths: Object.freeze([...this.failedTests].sort()),
      completedToolCount: this.completedToolCount,
      successfulCommandCount: this.successfulCommandCount,
      invalidEvidenceCodes: Object.freeze([...this.invalidCodes].sort()),
    });
  }
}

export function mergeFirmExecutionEvidence(
  values: readonly (FirmExecutionEvidence | undefined)[],
): FirmExecutionEvidence {
  const collected = <K extends keyof Pick<FirmExecutionEvidence, "artifactPaths" | "deletedArtifactPaths" | "executedTestPaths" | "failedTestPaths" | "invalidEvidenceCodes">>(key: K) => (
    [...new Set(values.flatMap((value) => value?.[key] ?? []))].sort()
  );
  return Object.freeze({
    schemaVersion: "agentlas.desktop-firm-execution-evidence.v1" as const,
    projectBound: values.some((value) => value?.projectBound),
    artifactPaths: Object.freeze(collected("artifactPaths")),
    deletedArtifactPaths: Object.freeze(collected("deletedArtifactPaths")),
    executedTestPaths: Object.freeze(collected("executedTestPaths")),
    failedTestPaths: Object.freeze(collected("failedTestPaths")),
    completedToolCount: values.reduce((sum, value) => sum + (value?.completedToolCount ?? 0), 0),
    successfulCommandCount: values.reduce((sum, value) => sum + (value?.successfulCommandCount ?? 0), 0),
    invalidEvidenceCodes: Object.freeze(collected("invalidEvidenceCodes")),
  });
}

export function firmExecutionBoundaryOk(evidence: FirmExecutionEvidence | undefined): boolean {
  return !evidence || evidence.invalidEvidenceCodes.length === 0;
}

export function withFirmEvidenceIssues(
  evidence: FirmExecutionEvidence,
  issues: readonly string[],
): FirmExecutionEvidence {
  if (issues.length === 0) return evidence;
  return Object.freeze({
    ...evidence,
    invalidEvidenceCodes: Object.freeze([...new Set([...evidence.invalidEvidenceCodes, ...issues])].sort()),
  });
}

export function evaluateFirmVerificationEvidence(input: {
  evidence: FirmExecutionEvidence | undefined;
  prompt: string;
  projectRoot: string | null | undefined;
  inlineOnly: boolean;
}): FirmVerificationEvidenceResult {
  if (input.inlineOnly) return { ok: true, requiredTestPaths: [], issues: [] };
  const issues = new Set<string>();
  const evidence = input.evidence;
  const root = canonicalRoot(input.projectRoot);
  if (!evidence || !root || !evidence.projectBound) issues.add("project-evidence-unavailable");
  for (const code of evidence?.invalidEvidenceCodes ?? []) issues.add(code);
  const required: string[] = [];
  if (root) {
    for (const candidate of testPathsFromText(input.prompt)) {
      const relative = relativeCandidate(root, candidate);
      if (!relative) issues.add("named-test-outside-project");
      else required.push(relative);
    }
  }
  const requiredTests = [...new Set(required)].sort();
  for (const relative of requiredTests) {
    if (!safeRegularProjectFile(root!, relative)) issues.add(`named-test-missing:${relative}`);
    if (!evidence?.executedTestPaths.includes(relative)) issues.add(`named-test-not-executed:${relative}`);
    if (evidence?.failedTestPaths.includes(relative)) issues.add(`named-test-failed:${relative}`);
  }
  if (requiredTests.length === 0 && (evidence?.completedToolCount ?? 0) === 0) {
    issues.add("verification-tool-receipt-missing");
  }
  return {
    ok: issues.size === 0,
    requiredTestPaths: requiredTests,
    issues: [...issues].sort(),
  };
}

export function firmEvidencePromptSummary(evidence: FirmExecutionEvidence | undefined): string {
  if (!evidence) return "host_evidence: unavailable";
  return [
    `host_project_artifacts: ${evidence.artifactPaths.length ? evidence.artifactPaths.join(", ") : "none"}`,
    `host_deleted_artifacts: ${evidence.deletedArtifactPaths.length ? evidence.deletedArtifactPaths.join(", ") : "none"}`,
    `host_executed_tests: ${evidence.executedTestPaths.length ? evidence.executedTestPaths.join(", ") : "none"}`,
    `host_completed_tools: ${evidence.completedToolCount}`,
    `host_successful_commands: ${evidence.successfulCommandCount}`,
    `host_evidence_issues: ${evidence.invalidEvidenceCodes.length ? evidence.invalidEvidenceCodes.join(", ") : "none"}`,
  ].join("\n");
}
