import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import Module, { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";

const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;

/**
 * Build-pinned manifests are outside each unpacked plugin root. A same-UID
 * path swap can therefore never substitute a self-consistent second release.
 * Reconciliation must update a pin whenever a built-in plugin manifest moves.
 */
const SOURCE_MANIFEST_PINS: Readonly<Record<string, string>> = Object.freeze({
  "agentlas-comparative-genomics": "962b9f5ca94853471d3500f41b04819a0c950e63b70cdf8352d7a07cd31fe95e",
  "agentlas-astronomy": "bbe7be29d107701d1201cd9fedf45d8ce806fc7bed6d8699af6b10952ac4a770",
  "agentlas-earth-science": "f536feae47f1241065b620b7ddc5f7f47a6b671f307ea34eea0844c9942159c0",
  "agentlas-physics": "946c84cc3d7e64182608624c64286170d5ad95aadc7d49d5b08f4749a73d050b",
  "agentlas-materials-science": "fe4b6a90efb60d0f60c424ef3fb9e063f8728ae6566b5a19452b173903a3725e",
  "agentlas-paleontology": "75915dc8dddc06e2e37a0bd688dd982d3b99793639de26fb0009858ac89f3753",
  "agentlas-economic-data": "d5a92c6e8d64c57f61ee6ee7176ddb2f97181f7a6eaa837a50ce8e71e0a5cf6e",
  "agentlas-science-statistics": "e8f2ffa2e8529c0eb39ef1ac449a3a712995f455cffac54f122be93b552c5d59",
});
const PUBLIC_MANIFEST_PINS_SCHEMA = "agentlas.science-public-plugin-manifest-pins/v1";
let cachedPublicManifestPins: Readonly<Record<string, string>> | null = null;

function publicManifestPins(): Readonly<Record<string, string>> {
  if (cachedPublicManifestPins) return cachedPublicManifestPins;
  const target = path.join(__dirname, "public-plugin-manifest-pins.json");
  const stat = lstatOrNull(target);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 64 * 1024) {
    throw new Error("science-plugin-runtime-public-pins-missing");
  }
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(target, "utf8")); }
  catch { throw new Error("science-plugin-runtime-public-pins-invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "pins,schemaVersion"
    || (value as Record<string, unknown>).schemaVersion !== PUBLIC_MANIFEST_PINS_SCHEMA) {
    throw new Error("science-plugin-runtime-public-pins-invalid");
  }
  const rawPins = (value as Record<string, unknown>).pins;
  if (!rawPins || typeof rawPins !== "object" || Array.isArray(rawPins)
    || Object.keys(rawPins).sort().join(",") !== Object.keys(SOURCE_MANIFEST_PINS).sort().join(",")) {
    throw new Error("science-plugin-runtime-public-pins-invalid");
  }
  const pins = Object.fromEntries(Object.entries(rawPins as Record<string, unknown>).map(([slug, digest]) => {
    if (!Object.hasOwn(SOURCE_MANIFEST_PINS, slug) || typeof digest !== "string" || !SHA256_RE.test(digest)) {
      throw new Error("science-plugin-runtime-public-pins-invalid");
    }
    return [slug, digest];
  }));
  cachedPublicManifestPins = Object.freeze(pins);
  return cachedPublicManifestPins;
}

function manifestPinForRoot(slug: string, pluginRoot: string): string | undefined {
  if (!Object.hasOwn(SOURCE_MANIFEST_PINS, slug)) return undefined;
  const normalized = path.normalize(pluginRoot);
  const publicSegment = `${path.sep}dist${path.sep}plugins${path.sep}`;
  return normalized.includes(publicSegment) ? publicManifestPins()[slug] : SOURCE_MANIFEST_PINS[slug];
}

/**
 * Native ESM is deliberately narrower than CommonJS memory loading. Only an
 * audited, build-pinned entry may execute, and every static dependency must be
 * a named Node builtin. Relative, file, data, remote, package, and dynamic
 * imports fail closed instead of escaping the verified release graph.
 */
const BUILTIN_ESM_ENTRY_POLICIES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  "agentlas-economic-data": Object.freeze({
    "runtime/world-bank-client.mjs": Object.freeze(["node:crypto"]),
  }),
});

const NATIVE_REQUIRE = createRequire(__filename);
const BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`),
]);

type PluginIntegrityEntry = {
  path: string;
  sha256: string;
  bytes: number;
};

type DirectoryIdentity = {
  path: string;
  dev: number;
  ino: number;
  mtimeMs: number;
};

type ParsedManifest = {
  manifest: SciencePluginManifest;
  bytes: Buffer;
  sha256: string;
};

type RequiredSelector = { kind: "prefix" | "exact"; value: string };

type MemoryModule = {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: MemoryModule[];
  paths: string[];
};

export type SciencePluginManifest = {
  schema: "agentlas.plugin/v2";
  slug: string;
  version: string;
  integrity: {
    algo: "sha256";
    files: PluginIntegrityEntry[];
  };
};

export type SciencePluginFile = {
  pluginRoot: string;
  path: string;
  bytes: Buffer;
  sha256: string;
  manifest: SciencePluginManifest;
};

export type SciencePluginRelease = {
  pluginRoot: string;
  manifest: SciencePluginManifest;
  manifestBytes: Buffer;
  manifestSha256: string;
  releaseSha256: string;
  files: ReadonlyMap<string, SciencePluginFile>;
  missingFiles: readonly string[];
};

export type SciencePluginRuntime<T> = SciencePluginFile & {
  runtime: T;
  executionPath: string;
  releaseSha256: string;
};

export type SciencePluginRuntimeLoadOptions = {
  /**
   * Optional allowlist for CommonJS builtin requests. Omit it to preserve the
   * historical loader behavior, which permits every Node builtin.
   */
  allowedBuiltins?: readonly string[];
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSlug(slug: string): void {
  if (!PLUGIN_SLUG_RE.test(slug) || slug.includes("..")) {
    throw new Error("science-plugin-runtime-slug-invalid");
  }
}

function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("science-plugin-runtime-path-invalid");
  }
  return relativePath;
}

function normalizeRequiredSelector(input: string): RequiredSelector {
  if (input.endsWith("/")) {
    const prefix = normalizeRelativePath(input.slice(0, -1));
    return { kind: "prefix", value: `${prefix}/` };
  }
  return { kind: "exact", value: normalizeRelativePath(input) };
}

function selectorMatches(selector: RequiredSelector, relativePath: string): boolean {
  return selector.kind === "prefix" ? relativePath.startsWith(selector.value) : relativePath === selector.value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => path.normalize(value)))];
}

/** Resolve physical plugin releases only. Packaged execution must use ASAR-unpacked bytes. */
export function sciencePluginRootCandidates(slug: string): string[] {
  validateSlug(slug);
  const resourcesPath = typeof process.resourcesPath === "string" && process.resourcesPath.trim()
    ? process.resourcesPath
    : null;
  const isAsarModule = __dirname.split(path.sep).includes("app.asar");
  if (isAsarModule) {
    return resourcesPath
      ? [path.join(resourcesPath, "app.asar.unpacked", "dist", "plugins", slug)]
      : [];
  }

  const isCompiledModule = __dirname.endsWith(path.join("dist", "electron", "science"));
  const sourceCandidate = isCompiledModule
    ? path.resolve(__dirname, "../../../plugins", slug)
    : path.resolve(__dirname, "../../plugins", slug);
  const compiledCandidate = isCompiledModule
    ? path.resolve(__dirname, "../../plugins", slug)
    : path.resolve(__dirname, "../../dist/plugins", slug);
  const packagedCandidate = resourcesPath
    ? path.join(resourcesPath, "app.asar.unpacked", "dist", "plugins", slug)
    : null;
  return unique([sourceCandidate, compiledCandidate, ...(packagedCandidate ? [packagedCandidate] : [])]);
}

function lstatOrNull(target: string): fs.Stats | null {
  try { return fs.lstatSync(target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || String((error as Error).message).startsWith("Invalid package ")) return null;
    throw error;
  }
}

function captureDirectoryChain(root: string, relativePath: string): DirectoryIdentity[] {
  const parts = normalizeRelativePath(relativePath).split("/");
  const directories = [root];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    directories.push(current);
  }
  return directories.map((directory) => {
    const stat = lstatOrNull(directory);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("science-plugin-runtime-directory-invalid");
    }
    return { path: directory, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  });
}

function assertDirectoryChainUnchanged(identities: DirectoryIdentity[]): void {
  for (const identity of identities) {
    const stat = lstatOrNull(identity.path);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.mtimeMs !== identity.mtimeMs) {
      throw new Error("science-plugin-runtime-directory-changed");
    }
  }
}

function assertRealPathContained(root: string, target: string): void {
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = fs.realpathSync.native(root);
    targetReal = fs.realpathSync.native(target);
  } catch {
    throw new Error("science-plugin-runtime-path-invalid");
  }
  const relative = path.relative(rootReal, targetReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("science-plugin-runtime-path-invalid");
  }
}

function readRegularFileNoFollow(root: string, relativePath: string, maximumBytes: number): Buffer {
  const normalized = normalizeRelativePath(relativePath);
  const identities = captureDirectoryChain(root, normalized);
  const target = path.join(root, ...normalized.split("/"));
  const beforePath = lstatOrNull(target);
  if (!beforePath || !beforePath.isFile() || beforePath.isSymbolicLink()
    || beforePath.size < 1 || beforePath.size > maximumBytes) {
    throw new Error("science-plugin-runtime-file-invalid");
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(target, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== beforePath.size
      || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error("science-plugin-runtime-file-invalid");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error("science-plugin-runtime-file-short-read");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("science-plugin-runtime-file-changed");
    }
    assertRealPathContained(root, target);
    assertDirectoryChainUnchanged(identities);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveSciencePluginRoot(slug: string): string {
  for (const candidate of sciencePluginRootCandidates(slug)) {
    const stat = lstatOrNull(candidate);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("science-plugin-runtime-root-invalid");
    }
    const manifest = lstatOrNull(path.join(candidate, "plugin.json"));
    if (!manifest) continue;
    if (!manifest.isFile() || manifest.isSymbolicLink()) {
      throw new Error("science-plugin-runtime-manifest-invalid");
    }
    return candidate;
  }
  throw new Error("science-plugin-runtime-unavailable");
}

function parseManifest(pluginRoot: string, expectedSlug: string): ParsedManifest {
  const bytes = readRegularFileNoFollow(pluginRoot, "plugin.json", 2 * 1024 * 1024);
  const manifestSha256 = sha256(bytes);
  const pinned = manifestPinForRoot(expectedSlug, pluginRoot);
  if (pinned && pinned !== manifestSha256) throw new Error("science-plugin-runtime-manifest-pin-mismatch");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("science-plugin-runtime-manifest-invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("science-plugin-runtime-manifest-invalid");
  }
  const manifest = value as Record<string, unknown>;
  const integrity = manifest.integrity;
  if (manifest.schema !== "agentlas.plugin/v2" || manifest.slug !== expectedSlug
    || typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)
    || !integrity || typeof integrity !== "object" || Array.isArray(integrity)
    || (integrity as Record<string, unknown>).algo !== "sha256"
    || !Array.isArray((integrity as Record<string, unknown>).files)) {
    throw new Error("science-plugin-runtime-manifest-invalid");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = ((integrity as Record<string, unknown>).files as unknown[]).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("science-plugin-runtime-integrity-invalid");
    }
    const row = item as Record<string, unknown>;
    const relativePath = normalizeRelativePath(String(row.path ?? ""));
    if (relativePath === "plugin.json" || seen.has(relativePath)
      || typeof row.sha256 !== "string" || !SHA256_RE.test(row.sha256)
      || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > DEFAULT_MAX_FILE_BYTES) {
      throw new Error("science-plugin-runtime-integrity-invalid");
    }
    totalBytes += Number(row.bytes);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RELEASE_BYTES) {
      throw new Error("science-plugin-runtime-release-too-large");
    }
    seen.add(relativePath);
    return { path: relativePath, sha256: row.sha256, bytes: Number(row.bytes) };
  });
  if (files.length < 1) throw new Error("science-plugin-runtime-integrity-invalid");
  return {
    bytes,
    sha256: manifestSha256,
    manifest: {
      schema: "agentlas.plugin/v2",
      slug: expectedSlug,
      version: manifest.version,
      integrity: { algo: "sha256", files },
    },
  };
}

export function readSciencePluginRelease(slug: string, requiredInput = "runtime/"): SciencePluginRelease {
  validateSlug(slug);
  const required = normalizeRequiredSelector(requiredInput);
  const pluginRoot = resolveSciencePluginRoot(slug);
  const rootBefore = lstatOrNull(pluginRoot);
  if (!rootBefore || !rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error("science-plugin-runtime-root-invalid");
  }
  const parsed = parseManifest(pluginRoot, slug);
  const verified = new Map<string, SciencePluginFile>();
  const missingFiles: string[] = [];
  const releaseRows: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const expected of [...parsed.manifest.integrity.files].sort((left, right) => left.path.localeCompare(right.path))) {
    const target = path.join(pluginRoot, ...expected.path.split("/"));
    if (!lstatOrNull(target)) {
      if (selectorMatches(required, expected.path)) throw new Error("science-plugin-runtime-integrity-missing");
      missingFiles.push(expected.path);
      continue;
    }
    const bytes = readRegularFileNoFollow(pluginRoot, expected.path, DEFAULT_MAX_FILE_BYTES);
    const digest = sha256(bytes);
    if (bytes.length !== expected.bytes || digest !== expected.sha256) {
      throw new Error("science-plugin-runtime-integrity-mismatch");
    }
    verified.set(expected.path, {
      pluginRoot,
      path: target,
      bytes,
      sha256: digest,
      manifest: parsed.manifest,
    });
    releaseRows.push({ path: expected.path, bytes: expected.bytes, sha256: digest });
  }
  if (![...verified.keys()].some((relativePath) => selectorMatches(required, relativePath))) {
    throw new Error("science-plugin-runtime-integrity-missing");
  }
  const rootAfter = lstatOrNull(pluginRoot);
  if (!rootAfter || !rootAfter.isDirectory() || rootAfter.isSymbolicLink()
    || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino || rootAfter.mtimeMs !== rootBefore.mtimeMs) {
    throw new Error("science-plugin-runtime-root-changed");
  }
  return {
    pluginRoot,
    manifest: parsed.manifest,
    manifestBytes: parsed.bytes,
    manifestSha256: parsed.sha256,
    releaseSha256: sha256(JSON.stringify({
      manifestSha256: parsed.sha256,
      verifiedFiles: releaseRows,
      missingFiles,
    })),
    files: verified,
    missingFiles: Object.freeze([...missingFiles]),
  };
}

export function readSciencePluginFile(
  slug: string,
  relativePathInput: string,
  maximumBytes = DEFAULT_MAX_FILE_BYTES,
): SciencePluginFile {
  const relativePath = normalizeRelativePath(relativePathInput);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DEFAULT_MAX_FILE_BYTES) {
    throw new Error("science-plugin-runtime-file-limit-invalid");
  }
  const release = readSciencePluginRelease(slug, relativePath);
  const file = release.files.get(relativePath);
  if (!file) throw new Error("science-plugin-runtime-integrity-missing");
  if (file.bytes.length > maximumBytes) throw new Error("science-plugin-runtime-file-invalid");
  return file;
}

function resolveMemoryDependency(release: SciencePluginRelease, parentPath: string, request: string): string {
  if (!request.startsWith("./") && !request.startsWith("../")) {
    throw new Error("science-plugin-runtime-external-module-denied");
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(parentPath), request));
  if (!base || base === "." || base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) {
    throw new Error("science-plugin-runtime-dependency-path-invalid");
  }
  const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.json`, `${base}.mjs`, `${base}/index.cjs`, `${base}/index.js`, `${base}/index.json`];
  const resolved = candidates.find((candidate) => release.files.has(candidate));
  if (!resolved) throw new Error("science-plugin-runtime-dependency-missing");
  return resolved;
}

function normalizeBuiltinAllowlist(input: readonly string[] | undefined): ReadonlySet<string> {
  if (input === undefined) return BUILTIN_MODULES;
  if (!Array.isArray(input)) throw new Error("science-plugin-runtime-builtin-policy-invalid");
  const allowed = new Set(input);
  if ([...allowed].some((request) => typeof request !== "string" || !BUILTIN_MODULES.has(request))) {
    throw new Error("science-plugin-runtime-builtin-policy-invalid");
  }
  return allowed;
}

function assertBuiltinAllowed(request: string, allowedBuiltins: ReadonlySet<string>): void {
  if (BUILTIN_MODULES.has(request) && !allowedBuiltins.has(request)) {
    throw new Error("science-plugin-runtime-builtin-denied");
  }
}

function compileVerifiedCommonJs(release: SciencePluginRelease, entryPath: string, allowedBuiltins: ReadonlySet<string>): unknown {
  const cache = new Map<string, MemoryModule>();
  const virtualRoot = path.join(os.tmpdir(), "agentlas-verified-plugin", release.releaseSha256);
  const load = (relativePath: string): unknown => {
    const cached = cache.get(relativePath);
    if (cached) return cached.exports;
    const file = release.files.get(relativePath);
    if (!file) throw new Error("science-plugin-runtime-dependency-missing");
    if (relativePath.endsWith(".json")) {
      let parsed: unknown;
      try { parsed = JSON.parse(file.bytes.toString("utf8")); }
      catch { throw new Error("science-plugin-runtime-json-invalid"); }
      cache.set(relativePath, {
        id: relativePath,
        filename: path.join(virtualRoot, ...relativePath.split("/")),
        exports: parsed,
        loaded: true,
        children: [],
        paths: [],
      });
      return parsed;
    }
    if (relativePath.endsWith(".mjs")) throw new Error("science-plugin-runtime-esm-entry-required");
    if (!relativePath.endsWith(".cjs") && !relativePath.endsWith(".js")) {
      throw new Error("science-plugin-runtime-module-type-denied");
    }
    const filename = path.join(virtualRoot, ...relativePath.split("/"));
    const moduleRecord: MemoryModule = {
      id: relativePath,
      filename,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
    };
    cache.set(relativePath, moduleRecord);
    const localRequire = ((request: string) => {
      if (typeof request !== "string" || !request) throw new Error("science-plugin-runtime-dependency-invalid");
      assertBuiltinAllowed(request, allowedBuiltins);
      if (BUILTIN_MODULES.has(request)) return NATIVE_REQUIRE(request);
      const dependencyPath = resolveMemoryDependency(release, relativePath, request);
      const dependency = load(dependencyPath);
      const child = cache.get(dependencyPath);
      if (child && !moduleRecord.children.includes(child)) moduleRecord.children.push(child);
      return dependency;
    }) as NodeJS.Require;
    localRequire.resolve = ((request: string) => {
      assertBuiltinAllowed(request, allowedBuiltins);
      if (BUILTIN_MODULES.has(request)) return request;
      return path.join(virtualRoot, ...resolveMemoryDependency(release, relativePath, request).split("/"));
    }) as NodeJS.RequireResolve;
    localRequire.cache = Object.create(null) as NodeJS.Dict<NodeModule>;
    localRequire.extensions = Object.create(null) as NodeJS.RequireExtensions;
    localRequire.main = undefined;
    const wrapped = (Module as unknown as { wrap(source: string): string }).wrap(file.bytes.toString("utf8"));
    let compiled: (exports: unknown, require: NodeJS.Require, module: MemoryModule, filename: string, dirname: string) => void;
    try {
      compiled = new vm.Script(wrapped, { filename }).runInThisContext() as typeof compiled;
      compiled.call(moduleRecord.exports, moduleRecord.exports, localRequire, moduleRecord, filename, path.dirname(filename));
    } catch {
      cache.delete(relativePath);
      throw new Error("science-plugin-runtime-load-failed");
    }
    moduleRecord.loaded = true;
    return moduleRecord.exports;
  };
  return load(entryPath);
}

function validateRuntimeExport<T extends object>(runtime: unknown, release: SciencePluginRelease): T {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("science-plugin-runtime-export-invalid");
  }
  const exportedVersion = (runtime as Record<string, unknown>).PLUGIN_VERSION;
  if (exportedVersion !== undefined && exportedVersion !== release.manifest.version) {
    throw new Error("science-plugin-runtime-version-mismatch");
  }
  return runtime as T;
}

export function loadSciencePluginRuntime<T extends object>(
  slug: string,
  relativePathInput: string,
  maximumBytes = DEFAULT_MAX_FILE_BYTES,
  options?: SciencePluginRuntimeLoadOptions,
): SciencePluginRuntime<T> {
  const relativePath = normalizeRelativePath(relativePathInput);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DEFAULT_MAX_FILE_BYTES) {
    throw new Error("science-plugin-runtime-file-limit-invalid");
  }
  if (relativePath.endsWith(".mjs")) throw new Error("science-plugin-runtime-esm-entry-required");
  const release = readSciencePluginRelease(slug, `${relativePath.split("/", 1)[0]}/`);
  const file = release.files.get(relativePath);
  if (!file) throw new Error("science-plugin-runtime-integrity-missing");
  if (file.bytes.length > maximumBytes) throw new Error("science-plugin-runtime-file-invalid");
  const allowedBuiltins = normalizeBuiltinAllowlist(options?.allowedBuiltins);
  const runtime = validateRuntimeExport<T>(compileVerifiedCommonJs(release, relativePath, allowedBuiltins), release);
  return {
    ...file,
    runtime,
    executionPath: `agentlas-verified-cjs:sha256:${release.releaseSha256}/${relativePath}`,
    releaseSha256: release.releaseSha256,
  };
}

const nativeDynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<unknown>;

function assertAuditedEsmEntry(slug: string, relativePath: string, source: string): void {
  const allowed = BUILTIN_ESM_ENTRY_POLICIES[slug]?.[relativePath];
  if (!allowed || SOURCE_MANIFEST_PINS[slug] === undefined) {
    throw new Error("science-plugin-runtime-esm-unpinned-denied");
  }
  if (/\bimport\s*\(/u.test(source)) {
    throw new Error("science-plugin-runtime-esm-dynamic-import-denied");
  }
  const specifiers = [
    ...[...source.matchAll(/\bfrom\s*["']([^"'\r\n]+)["']/gu)].map((match) => match[1]!),
    ...[...source.matchAll(/(?:^|\n)\s*import\s*["']([^"'\r\n]+)["']/gu)].map((match) => match[1]!),
  ];
  const allowedSet = new Set(allowed);
  if (specifiers.some((specifier) => !allowedSet.has(specifier))) {
    throw new Error("science-plugin-runtime-esm-import-denied");
  }
}

export async function loadSciencePluginEsmRuntime<T extends object>(
  slug: string,
  relativePathInput: string,
  maximumBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<SciencePluginRuntime<T>> {
  const relativePath = normalizeRelativePath(relativePathInput);
  if (!relativePath.endsWith(".mjs")) throw new Error("science-plugin-runtime-esm-entry-invalid");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DEFAULT_MAX_FILE_BYTES) {
    throw new Error("science-plugin-runtime-file-limit-invalid");
  }
  const release = readSciencePluginRelease(slug, `${relativePath.split("/", 1)[0]}/`);
  const file = release.files.get(relativePath);
  if (!file) throw new Error("science-plugin-runtime-integrity-missing");
  if (file.bytes.length > maximumBytes) throw new Error("science-plugin-runtime-file-invalid");
  const source = file.bytes.toString("utf8");
  assertAuditedEsmEntry(slug, relativePath, source);
  const dataUrl = `data:text/javascript;base64,${file.bytes.toString("base64")}#sha256=${file.sha256}`;
  let namespace: unknown;
  try { namespace = await nativeDynamicImport(dataUrl); }
  catch { throw new Error("science-plugin-runtime-load-failed"); }
  return {
    ...file,
    runtime: validateRuntimeExport<T>(namespace, release),
    executionPath: `agentlas-verified-esm:sha256:${release.releaseSha256}/${relativePath}`,
    releaseSha256: release.releaseSha256,
  };
}
