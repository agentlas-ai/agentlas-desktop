import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

type RuntimeCandidate = {
  root: string;
  kind: "managed" | "bundled";
  order: number;
  version: string | null;
};

const rejectedRuntimeTargets = new Set<string>();

function normalizeHephaestusVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(
    /^[vV]?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/,
  );
  return match?.[1] ?? null;
}

/** Read the canonical Agentlas OS version without importing Desktop bootstrap code. */
export function readHephaestusVersion(root: string | null): string | null {
  if (!root) return null;
  try {
    const release = normalizeHephaestusVersion(fs.readFileSync(path.join(root, "RELEASE"), "utf8"));
    if (release) return release;
  } catch {
    // Bundled/development roots use manifest metadata instead.
  }
  for (const fileName of ["manifest.json", "package.json"]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8")) as { version?: unknown };
      const version = normalizeHephaestusVersion(parsed.version);
      if (version) return version;
    } catch {
      // Try the next canonical version file.
    }
  }
  return null;
}

type ParsedSemver = {
  core: [string, string, string];
  prerelease: string[];
};

function parseSemver(value: string | null): ParsedSemver | null {
  if (!value) return null;
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((item) => /^\d+$/.test(item) && item.length > 1 && item.startsWith("0"))) return null;
  return { core: [match[1], match[2], match[3]], prerelease };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

/** SemVer precedence. Build metadata does not affect runtime selection. */
export function compareHephaestusVersions(left: string | null, right: string | null): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumericIdentifier(a.core[index], b.core[index]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const leftItem = a.prerelease[index];
    const rightItem = b.prerelease[index];
    if (leftItem === rightItem) continue;
    const leftNumeric = /^\d+$/.test(leftItem);
    const rightNumeric = /^\d+$/.test(rightItem);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftItem, rightItem);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftItem < rightItem ? -1 : 1;
  }
  return 0;
}

function isRuntimeRoot(candidate: string): boolean {
  try {
    return Boolean(candidate) && fs.existsSync(path.join(candidate, "agentlas_cloud", "__main__.py"));
  } catch {
    return false;
  }
}

function runtimeTarget(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function isRejected(root: string): boolean {
  return rejectedRuntimeTargets.has(runtimeTarget(root));
}

function preferCandidate(left: RuntimeCandidate, right: RuntimeCandidate): RuntimeCandidate {
  const compared = compareHephaestusVersions(left.version, right.version);
  if (compared !== null && compared !== 0) return compared > 0 ? left : right;
  if (left.version && !right.version) return left;
  if (right.version && !left.version) return right;
  // Equal or unversioned managed copies are not allowed to shadow the immutable
  // runtime shipped with Desktop. A managed copy wins only when it is newer.
  if (left.kind !== right.kind) return left.kind === "bundled" ? left : right;
  return left.order <= right.order ? left : right;
}

/**
 * Select an Agentlas OS root without trusting mutable `current` ahead of the
 * immutable Desktop bundle. A strictly newer managed runtime wins; an older,
 * equal, unversioned, or rejected managed runtime cannot shadow the bundle.
 */
export function hephaestusRoot(): string | null {
  const explicit = process.env.HEPHAESTUS_RUNTIME_ROOT?.trim();
  if (explicit && isRuntimeRoot(explicit) && !isRejected(explicit)) return path.resolve(explicit);

  const paths: Array<{ root: string; kind: RuntimeCandidate["kind"] }> = [
    { root: path.join(os.homedir(), ".agentlas", "runtime", "current"), kind: "managed" },
  ];
  if (process.resourcesPath) paths.push({ root: path.join(process.resourcesPath, "Hephaestus"), kind: "bundled" });
  try {
    paths.push({ root: path.join(app.getAppPath(), "Hephaestus"), kind: "bundled" });
  } catch {
    // Electron app path is unavailable in some isolated tests.
  }
  paths.push({ root: path.join(__dirname, "..", "..", "..", "Hephaestus"), kind: "bundled" });
  paths.push({ root: path.join(__dirname, "..", "..", "Hephaestus"), kind: "bundled" });
  try {
    paths.push({ root: path.join(process.cwd(), "Hephaestus"), kind: "bundled" });
  } catch {
    // No cwd candidate.
  }

  const candidates = paths
    .map((candidate, order): RuntimeCandidate | null => {
      if (!isRuntimeRoot(candidate.root) || isRejected(candidate.root)) return null;
      const root = path.resolve(candidate.root);
      return { ...candidate, root, order, version: readHephaestusVersion(root) };
    })
    .filter((candidate): candidate is RuntimeCandidate => candidate !== null);
  if (candidates.length === 0) return null;
  const managed = candidates.find((candidate) => candidate.kind === "managed") ?? null;
  // Preserve the old trust order among immutable/dev fallbacks. In particular,
  // a caller-controlled cwd/Hephaestus directory must never outrank packaged
  // process.resourcesPath merely by claiming a larger version.
  const bundled = candidates.find((candidate) => candidate.kind === "bundled") ?? null;
  if (managed && bundled) return preferCandidate(managed, bundled).root;
  return (bundled ?? managed)!.root;
}

export function resetHephaestusRootCache(): void {
  // Root selection is intentionally live so an atomic `runtime/current`
  // switch is observed without restarting Desktop. Kept for API compatibility.
}

/** Reject one concrete runtime target after a failed MCP capability preflight. */
export function rejectHephaestusRuntimeRoot(root: string): void {
  if (root) rejectedRuntimeTargets.add(runtimeTarget(root));
}

/** Test/diagnostic reset; normal updates change `current` to a new real target. */
export function clearRejectedHephaestusRuntimeRoots(): void {
  rejectedRuntimeTargets.clear();
}
