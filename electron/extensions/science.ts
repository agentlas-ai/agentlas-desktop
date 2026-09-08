import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { app, net } from "electron";
import { userDataPath } from "../runtime-paths";
import type {
  ProductExtensionInstallReceipt,
  ProductExtensionStatus,
  ProductExtensionUninstallReceipt,
  ScienceSuiteComponentId,
  ScienceSuiteInstallProgress,
  ScienceSuiteInstallReceipt,
  ScienceSuiteStatus,
} from "../../shared/product-extension";
import {
  isProductExtensionManifest,
  isSafeProductExtensionPath,
  productExtensionSignedPayload,
  type ProductExtensionManifest,
} from "../../shared/product-extension";
import { ProductExtensionInstaller } from "./installer";
import { downloadAndInstallSciencePackage, type SciencePackageArchiveSpec } from "./downloader";
import { fetchScienceReleaseCatalog } from "./science-catalog";
import { ScienceRendererRegistry } from "agentlas-science";
import type { ScienceRendererBinding, ScienceRendererExecutorBinding } from "agentlas-science/dist/contracts/science-renderer-runtime";

export const SCIENCE_EXTENSION_ID = "agentlas-science";

const SCIENCE_SUITE_SPECS: ReadonlyArray<{
  id: ScienceSuiteComponentId;
  version: string;
  displayName: string;
  description: string;
  packageBytes: number;
  sourceEnv: string;
}> = [
  {
    id: SCIENCE_EXTENSION_ID,
    version: "0.1.1",
    displayName: "Science Workspace",
    description: "Projects, literature, evidence graphs, statistics, and research writing",
    packageBytes: 11_000_000,
    sourceEnv: "AGENTLAS_SCIENCE_EXTENSION_SOURCE_DIR",
  },
  {
    id: "agentlas-science-renderer-ketcher",
    version: "1.1.1",
    displayName: "Chemistry Tools",
    description: "Ketcher structure editor and Indigo chemistry runtime",
    packageBytes: 46_697_538,
    sourceEnv: "AGENTLAS_SCIENCE_KETCHER_RENDERER_SOURCE_DIR",
  },
  {
    id: "agentlas-science-renderer-molstar",
    version: "1.2.1",
    displayName: "Molecular Visualization",
    description: "Mol* protein and molecular structure viewer",
    packageBytes: 5_144_268,
    sourceEnv: "AGENTLAS_SCIENCE_MOLSTAR_RENDERER_SOURCE_DIR",
  },
] as const;

const SCIENCE_PACKAGE_BASE_URL = "https://agentlas.cloud/desktop/extensions/science/v1/";
const SCIENCE_QA_REMOTE_SOURCE_FLAG = "AGENTLAS_SCIENCE_QA_REMOTE_PACKAGE_SOURCE";
const SCIENCE_QA_PACKAGE_BASE_URL = "AGENTLAS_SCIENCE_QA_PACKAGE_BASE_URL";
const SCIENCE_SUITE_ACTIVATION_SCHEMA = "agentlas.science-suite-activation/v1";
const SCIENCE_SUITE_ACTIVATION_NAME = ".agentlas-science-suite-current.json";
const MAX_REMOTE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_REMOTE_PACKAGE_BYTES = 256 * 1024 * 1024;
const PACKAGE_DOWNLOAD_TIMEOUT_MS = 120_000;
const TAR_BLOCK_BYTES = 512;
const MAX_TAR_METADATA_OVERHEAD = 16 * 1024 * 1024;

class SciencePackageError extends Error {
  readonly code: string;
  readonly componentId: ScienceSuiteComponentId;
  readonly componentIndex: number;

  constructor(code: string, componentId: ScienceSuiteComponentId, componentIndex: number) {
    super(code);
    this.name = "SciencePackageError";
    this.code = code;
    this.componentId = componentId;
    this.componentIndex = componentIndex;
  }
}

function qaRemoteSourceEnabled(): boolean {
  return !app.isPackaged && process.env[SCIENCE_QA_REMOTE_SOURCE_FLAG] === "1";
}

function usesRemotePackageSource(): boolean {
  return qaRemoteSourceEnabled();
}

function remotePackageBaseUrl(): URL {
  if (!qaRemoteSourceEnabled()) return new URL(SCIENCE_PACKAGE_BASE_URL);
  const raw = process.env[SCIENCE_QA_PACKAGE_BASE_URL]?.trim() ?? "";
  const candidate = new URL(raw);
  const host = candidate.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (!loopback || !["http:", "https:"].includes(candidate.protocol)) {
    throw new Error("science-suite-qa-package-base-invalid");
  }
  if (!candidate.pathname.endsWith("/")) candidate.pathname += "/";
  return candidate;
}

function remotePackageUrl(spec: typeof SCIENCE_SUITE_SPECS[number]): URL {
  const relative = `${encodeURIComponent(spec.id)}/${encodeURIComponent(spec.version)}/${encodeURIComponent(spec.id)}-${encodeURIComponent(spec.version)}.tar.gz`;
  return new URL(relative, remotePackageBaseUrl());
}

function exactPackageChild(root: string, relative: string): string {
  if (!isSafeProductExtensionPath(relative)) throw new Error("science-suite-package-path-invalid");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...relative.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("science-suite-package-path-invalid");
  return resolved;
}

function tarString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8").trim();
}

function tarOctal(block: Buffer, start: number, length: number): number {
  const raw = block.subarray(start, start + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error("science-suite-package-tar-number-invalid");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("science-suite-package-tar-number-invalid");
  return value;
}

function assertTarChecksum(block: Buffer): void {
  const expected = tarOctal(block, 148, 8);
  let observed = 0;
  for (let index = 0; index < block.length; index += 1) {
    observed += index >= 148 && index < 156 ? 32 : block[index];
  }
  if (observed !== expected) throw new Error("science-suite-package-tar-checksum-invalid");
}

async function downloadArchive(
  url: URL,
  destination: string,
  onBytes?: (received: number, total: number | null) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PACKAGE_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let fd: number | null = null;
  try {
    const response = await net.fetch(url.toString(), {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/gzip, application/octet-stream" },
    });
    if (!response.ok || !response.body) throw new Error("science-suite-package-download-http-failed");
    const rawLength = response.headers.get("content-length");
    const declaredLength = rawLength === null ? null : Number(rawLength);
    if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_REMOTE_ARCHIVE_BYTES)) {
      throw new Error("science-suite-package-archive-size-invalid");
    }
    fd = fs.openSync(destination, "wx", 0o600);
    const reader = response.body.getReader();
    let received = 0;
    onBytes?.(0, declaredLength);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value);
      received += bytes.length;
      if (received > MAX_REMOTE_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error("science-suite-package-archive-too-large");
      }
      fs.writeSync(fd, bytes);
      onBytes?.(received, declaredLength);
    }
    if (received === 0 || (declaredLength !== null && received !== declaredLength)) {
      throw new Error("science-suite-package-archive-truncated");
    }
  } finally {
    clearTimeout(timer);
    if (fd !== null) fs.closeSync(fd);
  }
}

async function extractTarGzip(archivePath: string, destinationRoot: string, maxPackageBytes: number): Promise<void> {
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const stream = createReadStream(archivePath).pipe(createGunzip());
  let pending = Buffer.alloc(0);
  let current: { fd: number; remaining: number; padding: number } | null = null;
  let inflatedBytes = 0;
  let packageBytes = 0;
  let zeroBlocks = 0;
  const seen = new Set<string>();
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.from(rawChunk as Buffer);
      inflatedBytes += chunk.length;
      if (inflatedBytes > maxPackageBytes + MAX_TAR_METADATA_OVERHEAD) {
        throw new Error("science-suite-package-expanded-too-large");
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        if (current) {
          if (current.remaining > 0) {
            if (pending.length === 0) break;
            const count = Math.min(current.remaining, pending.length);
            fs.writeSync(current.fd, pending.subarray(0, count));
            pending = pending.subarray(count);
            current.remaining -= count;
            if (current.remaining > 0) break;
            fs.closeSync(current.fd);
            current.fd = -1;
          }
          if (pending.length < current.padding) break;
          pending = pending.subarray(current.padding);
          current = null;
          continue;
        }
        if (pending.length < TAR_BLOCK_BYTES) break;
        const header = pending.subarray(0, TAR_BLOCK_BYTES);
        pending = pending.subarray(TAR_BLOCK_BYTES);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          continue;
        }
        if (zeroBlocks > 0) throw new Error("science-suite-package-tar-trailing-entry");
        assertTarChecksum(header);
        const name = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 155);
        const type = String.fromCharCode(header[156] || 48);
        const archived = prefix ? `${prefix}/${name}` : name;
        const normalized = archived.replace(/^(?:\.\/)+/, "");
        const relative = type === "5" ? normalized.replace(/\/+$/, "") : normalized;
        const size = tarOctal(header, 124, 12);
        if (!relative || seen.has(relative) || !isSafeProductExtensionPath(relative)) {
          throw new Error("science-suite-package-tar-path-invalid");
        }
        seen.add(relative);
        const target = exactPackageChild(destinationRoot, relative);
        if (type === "5") {
          if (size !== 0) throw new Error("science-suite-package-tar-directory-invalid");
          fs.mkdirSync(target, { recursive: true, mode: 0o700 });
          continue;
        }
        if (type !== "0" && type !== "\0") throw new Error("science-suite-package-tar-entry-type-forbidden");
        packageBytes += size;
        if (packageBytes > maxPackageBytes) throw new Error("science-suite-package-expanded-too-large");
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(target, "wx", 0o600);
        const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
        if (size === 0) {
          fs.closeSync(fd);
          current = padding > 0 ? { fd: -1, remaining: 0, padding } : null;
        } else {
          current = { fd, remaining: size, padding };
        }
      }
    }
    if (current || pending.some((byte) => byte !== 0) || zeroBlocks < 2) {
      throw new Error("science-suite-package-tar-truncated");
    }
  } finally {
    if (current?.fd !== undefined && current.fd >= 0) {
      try { fs.closeSync(current.fd); } catch {}
    }
    stream.destroy();
  }
}

function packageFiles(root: string, relative = ""): string[] {
  const directory = relative ? exactPackageChild(root, relative) : root;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("science-suite-package-directory-invalid");
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!isSafeProductExtensionPath(child)) throw new Error("science-suite-package-path-invalid");
    const childPath = exactPackageChild(root, child);
    const childStat = fs.lstatSync(childPath);
    if (childStat.isSymbolicLink()) throw new Error("science-suite-package-symlink-forbidden");
    if (childStat.isDirectory()) files.push(...packageFiles(root, child));
    else if (childStat.isFile()) files.push(child);
    else throw new Error("science-suite-package-entry-forbidden");
  }
  return files.sort();
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function verifyRemotePackage(source: string, spec: typeof SCIENCE_SUITE_SPECS[number]): ProductExtensionManifest {
  const manifestPath = path.join(source, "extension.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > 262_144) {
    throw new Error("science-suite-package-manifest-invalid");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!isProductExtensionManifest(manifest) || manifest.id !== spec.id || manifest.version !== spec.version) {
    throw new Error("science-suite-package-manifest-invalid");
  }
  const publicKey = trustedPublicKeys()[manifest.signature.keyId];
  if (!publicKey) throw new Error("science-suite-package-signing-key-untrusted");
  const signature = Buffer.from(manifest.signature.value, "base64");
  if (!crypto.verify(null, Buffer.from(productExtensionSignedPayload(manifest), "utf8"), publicKey, signature)) {
    throw new Error("science-suite-package-signature-invalid");
  }
  const actual = packageFiles(source).filter((file) => file !== "extension.json").sort();
  const expected = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("science-suite-package-file-list-invalid");
  let totalBytes = 0;
  for (const file of manifest.files) {
    const filePath = exactPackageChild(source, file.path);
    const stat = fs.lstatSync(filePath);
    totalBytes += stat.size;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== file.size || totalBytes > MAX_REMOTE_PACKAGE_BYTES) {
      throw new Error("science-suite-package-file-invalid");
    }
    if (sha256File(filePath) !== file.sha256) throw new Error("science-suite-package-file-digest-invalid");
  }
  return manifest;
}

let cachedInstaller: ProductExtensionInstaller | null = null;

type CatalogScienceSuiteSpec = SciencePackageArchiveSpec & {
  displayName: string;
  description: string;
  sourceEnv: string;
};

interface ScienceSuiteActivation {
  schema: typeof SCIENCE_SUITE_ACTIVATION_SCHEMA;
  releaseTag: string;
  suiteVersion: string;
  components: Array<{ id: ScienceSuiteComponentId; version: string }>;
  activatedAt: string;
}

function remoteCatalogInstallEnabled(): boolean {
  if (app.isPackaged) return true;
  const override = process.env.AGENTLAS_SCIENCE_REMOTE_INSTALL_QA;
  if (override === "1") return true;
  if (override === "0") return false;
  // A normal development launch installs the same signed catalog as Desktop.
  // Explicit local packages and loopback fixtures keep their isolated QA path.
  return !qaRemoteSourceEnabled()
    && !SCIENCE_SUITE_SPECS.some((spec) => process.env[spec.sourceEnv]?.trim());
}

async function catalogSuite(): Promise<{
  releaseTag: string;
  suiteVersion: string;
  specs: ReadonlyArray<CatalogScienceSuiteSpec>;
}> {
  const catalog = await fetchScienceReleaseCatalog(app.isPackaged);
  const specs = SCIENCE_SUITE_SPECS.map((fallback) => {
    const component = catalog.components.find((candidate) => candidate.id === fallback.id);
    if (!component) throw new Error("science-catalog-component-missing");
    return {
      ...component,
      sourceEnv: fallback.sourceEnv,
    };
  });
  return { releaseTag: catalog.releaseTag, suiteVersion: catalog.suiteVersion, specs };
}

function scienceExtensionRootDir(): string {
  const qaRoot = !app.isPackaged ? process.env.AGENTLAS_PRODUCT_EXTENSION_ROOT_DIR?.trim() : "";
  if (qaRoot && !path.isAbsolute(qaRoot)) throw new Error("product-extension-qa-root-must-be-absolute");
  return qaRoot || path.join(os.homedir(), ".agentlas", "extensions");
}

function scienceSuiteActivationPath(): string {
  return path.join(scienceExtensionRootDir(), SCIENCE_SUITE_ACTIVATION_NAME);
}

function parseScienceSuiteActivation(value: unknown): ScienceSuiteActivation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-suite-activation-invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "activatedAt,components,releaseTag,schema,suiteVersion"
    || record.schema !== SCIENCE_SUITE_ACTIVATION_SCHEMA
    || typeof record.releaseTag !== "string" || !/^science-v\d+\.\d+\.\d+$/u.test(record.releaseTag)
    || typeof record.suiteVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(record.suiteVersion)
    || typeof record.activatedAt !== "string" || !Number.isFinite(Date.parse(record.activatedAt))
    || !Array.isArray(record.components) || record.components.length !== SCIENCE_SUITE_SPECS.length) {
    throw new Error("science-suite-activation-invalid");
  }
  const components = record.components.map((component) => {
    if (!component || typeof component !== "object" || Array.isArray(component)) throw new Error("science-suite-activation-invalid");
    const item = component as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "id,version"
      || !SCIENCE_SUITE_SPECS.some((spec) => spec.id === item.id)
      || typeof item.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(item.version)) {
      throw new Error("science-suite-activation-invalid");
    }
    return { id: item.id as ScienceSuiteComponentId, version: item.version };
  });
  if (new Set(components.map((component) => component.id)).size !== SCIENCE_SUITE_SPECS.length) {
    throw new Error("science-suite-activation-invalid");
  }
  return {
    schema: SCIENCE_SUITE_ACTIVATION_SCHEMA,
    releaseTag: record.releaseTag,
    suiteVersion: record.suiteVersion,
    components: components.sort((left, right) => left.id.localeCompare(right.id)),
    activatedAt: record.activatedAt,
  };
}

function readScienceSuiteActivation(): ScienceSuiteActivation | null {
  const target = scienceSuiteActivationPath();
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 32 || stat.size > 64 * 1024) {
      throw new Error("science-suite-activation-invalid");
    }
    return parseScienceSuiteActivation(JSON.parse(fs.readFileSync(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeScienceSuiteActivation(value: ScienceSuiteActivation | null): void {
  const target = scienceSuiteActivationPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (value === null) {
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("science-suite-activation-invalid");
      fs.rmSync(target);
    }
    return;
  }
  const normalized = parseScienceSuiteActivation(value);
  const temporary = path.join(path.dirname(target), `.${SCIENCE_SUITE_ACTIVATION_NAME}.${crypto.randomUUID()}.tmp`);
  const backup = path.join(path.dirname(target), `.${SCIENCE_SUITE_ACTIVATION_NAME}.${crypto.randomUUID()}.backup`);
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let movedCurrent = false;
  try {
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("science-suite-activation-invalid");
      fs.renameSync(target, backup);
      movedCurrent = true;
    }
    fs.renameSync(temporary, target);
    if (movedCurrent) fs.rmSync(backup);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary); } catch {}
    try { if (movedCurrent && !fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target); } catch {}
    throw error;
  }
}

function catalogFailure(error: unknown, suite: boolean): ProductExtensionInstallReceipt | ScienceSuiteInstallReceipt {
  const code = error instanceof Error && error.message.startsWith("science-catalog-")
    ? error.message
    : "science-catalog-invalid";
  const message = code === "science-catalog-network-failed"
    ? "Agentlas Science could not reach its signed package catalog."
    : "The signed Agentlas Science package catalog is unavailable or invalid.";
  if (suite) {
    return {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components: [],
      code,
      message,
    };
  }
  return {
    ok: false,
    id: SCIENCE_EXTENSION_ID,
    action: "failed",
    version: null,
    code,
    message,
  };
}

function policyCandidates(): string[] {
  return app.isPackaged
    ? [path.join(process.resourcesPath, "product-extension-signing-policy.json")]
    : [path.join(process.cwd(), "build-resources", "product-extension-signing-policy.json")];
}

const PRODUCT_EXTENSION_SIGNING_POLICY_SCHEMA = "agentlas.product-extension-signing-policy.v1";
const PRODUCT_EXTENSION_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "agentlas-science-release-v1": "agentlas-product-extension-release-v1",
});

function validatedTrustedPublicKeys(value: unknown, allowBare: boolean): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-signing-policy-invalid");
  const record = value as Record<string, unknown>;
  let rawKeys: unknown;
  if ("schemaVersion" in record || "keys" in record) {
    if (record.schemaVersion !== PRODUCT_EXTENSION_SIGNING_POLICY_SCHEMA
      || Object.keys(record).sort().join(",") !== "keys,schemaVersion") {
      throw new Error("science-signing-policy-invalid");
    }
    rawKeys = record.keys;
  } else {
    if (!allowBare) throw new Error("science-signing-policy-invalid");
    rawKeys = record;
  }
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) throw new Error("science-signing-policy-invalid");
  const entries = Object.entries(rawKeys as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 16) throw new Error("science-signing-policy-invalid");
  const keys: Record<string, string> = {};
  for (const [key, pem] of entries) {
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(key) || typeof pem !== "string"
      || pem.includes("PRIVATE KEY") || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error("science-signing-policy-invalid");
    }
    const parsed = crypto.createPublicKey(pem);
    if (parsed.type !== "public" || parsed.asymmetricKeyType !== "ed25519") {
      throw new Error("science-signing-policy-invalid");
    }
    keys[key] = parsed.export({ type: "spki", format: "pem" }).toString();
  }
  for (const [alias, canonical] of Object.entries(PRODUCT_EXTENSION_KEY_ALIASES)) {
    if (keys[alias] && keys[canonical] && keys[alias] !== keys[canonical]) {
      throw new Error("science-signing-policy-alias-conflict");
    }
    if (!keys[alias] && keys[canonical]) keys[alias] = keys[canonical];
  }
  return Object.fromEntries(Object.entries(keys).sort(([left], [right]) => left.localeCompare(right)));
}

function trustedPublicKeys(): Record<string, string> {
  if (!app.isPackaged && process.env.AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON) {
    try {
      const value = JSON.parse(process.env.AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON);
      return validatedTrustedPublicKeys(value, true);
    } catch {
      return {};
    }
  }
  for (const candidate of policyCandidates()) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 262_144) continue;
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const keys = validatedTrustedPublicKeys(value, false);
      if (Object.keys(keys).length > 0) return keys;
    } catch {
      // A missing or malformed policy fails closed. The installer reports an
      // untrusted key and never activates package bytes.
    }
  }
  return {};
}

function installer(): ProductExtensionInstaller {
  if (cachedInstaller) return cachedInstaller;
  cachedInstaller = new ProductExtensionInstaller({
    rootDir: scienceExtensionRootDir(),
    dataRootDir: userDataPath("extensions"),
    desktopVersion: app.getVersion(),
    trustedPublicKeys: trustedPublicKeys(),
  });
  return cachedInstaller;
}

export function scienceExtensionStatus(): ProductExtensionStatus {
  const status = installer().status(SCIENCE_EXTENSION_ID);
  if (remoteCatalogInstallEnabled() && status.installed && !remoteSuiteActivationMatches()) {
    return {
      ...status,
      phase: "repair-required",
      enabled: false,
      errorCode: "science-suite-activation-mismatch",
      errorMessage: "The installed Science components do not match one activated suite release.",
    };
  }
  return status;
}

function remoteSuiteActivationMatches(): boolean {
  if (!remoteCatalogInstallEnabled()) return true;
  try {
    const activation = readScienceSuiteActivation();
    if (!activation) return true;
    return SCIENCE_SUITE_SPECS.every((spec) => {
      const expected = activation.components.find((component) => component.id === spec.id);
      const status = installer().status(spec.id);
      return Boolean(expected) && status.installed && status.version === expected!.version;
    });
  } catch {
    return false;
  }
}

export function scienceSuiteStatus(): ScienceSuiteStatus {
  const components = SCIENCE_SUITE_SPECS.map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    description: spec.description,
    packageBytes: spec.packageBytes,
    status: installer().status(spec.id),
  }));
  const activationMatches = remoteSuiteActivationMatches();
  const installed = activationMatches && components.every((component) => component.status.installed);
  const enabled = installed && components.every((component) => component.status.enabled);
  const phase = !activationMatches || components.some((component) => component.status.phase === "repair-required")
    ? "repair-required"
    : installed && enabled
      ? "installed"
      : installed
        ? "disabled"
        : "not-installed";
  return {
    id: "agentlas-science-suite",
    phase,
    installed,
    enabled,
    totalPackageBytes: components.reduce((sum, component) => sum + component.packageBytes, 0),
    components,
  };
}

export function activeScienceExtension() {
  if (!remoteSuiteActivationMatches()) return null;
  return installer().activeRelease(SCIENCE_EXTENSION_ID);
}

export function scienceRendererPackStatuses() {
  return new ScienceRendererRegistry(installer(), app.getVersion()).listStatuses();
}

export function resolveVerifiedScienceRenderer(rendererId: string, artifactKind: string) {
  if (!remoteSuiteActivationMatches()) return null;
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveVerifiedPackage(rendererId, artifactKind);
}

export function resolveExactVerifiedScienceRenderer(binding: ScienceRendererBinding, artifactKind: string) {
  if (!remoteSuiteActivationMatches()) return null;
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveExactVerifiedPackage(binding, artifactKind);
}

export function resolveVerifiedScienceRendererExecutor(rendererId: string, artifactKind: string, executorId: string) {
  if (!remoteSuiteActivationMatches()) return null;
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveVerifiedExecutor(rendererId, artifactKind, executorId);
}

export function resolveExactVerifiedScienceRendererExecutor(binding: ScienceRendererBinding, artifactKind: string, executorId: string) {
  if (!remoteSuiteActivationMatches()) return null;
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveExactVerifiedExecutor(binding, artifactKind, executorId);
}

export function resolveExactVerifiedScienceRendererExecutorBinding(
  rendererBinding: ScienceRendererBinding,
  executorBinding: ScienceRendererExecutorBinding,
  artifactKind: string,
) {
  if (!remoteSuiteActivationMatches()) return null;
  return new ScienceRendererRegistry(installer(), app.getVersion())
    .resolveExactVerifiedExecutorBinding(rendererBinding, executorBinding, artifactKind);
}

export async function installScienceExtension(): Promise<ProductExtensionInstallReceipt> {
  if (remoteCatalogInstallEnabled()) {
    const suite = await installScienceSuite();
    const component = suite.components.find((receipt) => receipt.id === SCIENCE_EXTENSION_ID);
    if (suite.ok && component?.ok) return component;
    return {
      ok: false,
      id: SCIENCE_EXTENSION_ID,
      action: "failed",
      version: component?.version ?? null,
      code: suite.code ?? component?.code ?? "science-suite-component-install-failed",
      message: suite.message ?? component?.message ?? "Agentlas Science could not activate its complete signed suite.",
    };
  }
  const source = process.env.AGENTLAS_SCIENCE_EXTENSION_SOURCE_DIR?.trim() ?? "";
  if (!source || !path.isAbsolute(source)) {
    const current = installer().status(SCIENCE_EXTENSION_ID);
    if (current.installed && current.phase === "installed") {
      return {
        ok: true,
        id: SCIENCE_EXTENSION_ID,
        action: "unchanged",
        version: current.version,
        code: null,
        message: `Agentlas Science is up to date (v${current.version ?? "0.1.0"}).`,
      };
    }
    return {
      ok: false,
      id: SCIENCE_EXTENSION_ID,
      action: "failed",
      version: null,
      code: "science-extension-package-unavailable",
      message: "This Desktop build uses the built-in Agentlas Science package. Updates are delivered with Desktop application updates.",
    };
  }
  return installer().installFromDirectory(path.resolve(source));
}

async function installScienceSuiteFromCatalog(
  onProgress?: (progress: ScienceSuiteInstallProgress) => void,
): Promise<ScienceSuiteInstallReceipt> {
  let releaseTag: string;
  let suiteVersion: string;
  let specs: ReadonlyArray<CatalogScienceSuiteSpec>;
  try {
    ({ releaseTag, suiteVersion, specs } = await catalogSuite());
  } catch (error) {
    const current = installer().status(SCIENCE_EXTENSION_ID);
    if (current.installed && current.phase === "installed") {
      return {
        ok: true,
        id: "agentlas-science-suite",
        action: "unchanged",
        components: [{
          ok: true,
          id: SCIENCE_EXTENSION_ID,
          action: "unchanged",
          version: current.version,
          code: null,
          message: null,
        }],
        code: null,
        message: `Agentlas Science is up to date for this Desktop build (v${current.version ?? "0.1.0"}).`,
      };
    }
    return catalogFailure(error, true) as ScienceSuiteInstallReceipt;
  }
  const totalBytes = specs.reduce((sum, spec) => sum + spec.archiveBytes, 0);
  const emit = (
    phase: ScienceSuiteInstallProgress["phase"],
    componentId: ScienceSuiteComponentId | null,
    componentIndex: number,
    completedBytes: number,
    message: string,
  ) => {
    try {
      onProgress?.({
        id: "agentlas-science-suite",
        phase,
        componentId,
        componentIndex,
        componentCount: specs.length,
        completedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((completedBytes / totalBytes) * 100))) : 0,
        message,
      });
    } catch {
      // Renderer progress is observational. A closed sender must never abort or
      // strand the Main-owned installation transaction.
    }
  };

  emit("checking", null, 0, 0, "Checking the signed Science package catalog");
  const components: ProductExtensionInstallReceipt[] = [];
  let completedBytes = 0;
  const extensionInstaller = installer();
  let priorActivation: ReturnType<ProductExtensionInstaller["captureActivationState"]>;
  let priorSuiteActivation: ScienceSuiteActivation | null = null;
  try {
    priorActivation = extensionInstaller.captureActivationState(specs.map((spec) => spec.id));
    try { priorSuiteActivation = readScienceSuiteActivation(); } catch { priorSuiteActivation = null; }
  } catch (error) {
    const message = error instanceof Error ? error.message : "science-suite-activation-invalid";
    const failed: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components,
      code: message.split(":", 1)[0],
      message,
    };
    emit("failed", null, 0, 0, message);
    return failed;
  }
  const rollback = (failed: ScienceSuiteInstallReceipt): ScienceSuiteInstallReceipt => {
    try {
      extensionInstaller.restoreActivationState(priorActivation);
      writeScienceSuiteActivation(priorSuiteActivation);
      return failed;
    } catch (error) {
      return {
        ...failed,
        code: "science-suite-rollback-failed",
        message: error instanceof Error ? error.message : "science-suite-rollback-failed",
      };
    }
  };
  try {
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    emit("downloading", spec.id, index, completedBytes, `Downloading ${spec.displayName}`);
    const receipt = await downloadAndInstallSciencePackage(spec, extensionInstaller, (received) => {
      emit(
        "downloading",
        spec.id,
        index,
        completedBytes + Math.min(received, spec.archiveBytes),
        `Downloading ${spec.displayName}`,
      );
    });
    components.push(receipt);
    if (!receipt.ok || receipt.id !== spec.id || receipt.version !== spec.version) {
      const failed: ScienceSuiteInstallReceipt = {
        ok: false,
        id: "agentlas-science-suite",
        action: "failed",
        components,
        code: receipt.code ?? "science-suite-component-install-failed",
        message: receipt.message ?? `${spec.displayName} could not be installed.`,
      };
      emit("failed", spec.id, index, completedBytes, failed.message ?? "Installation failed");
      return rollback(failed);
    }
    completedBytes += spec.archiveBytes;
    emit("verifying", spec.id, index, completedBytes, `Verified ${spec.displayName}`);
  }

  try {
    writeScienceSuiteActivation({
      schema: SCIENCE_SUITE_ACTIVATION_SCHEMA,
      releaseTag,
      suiteVersion,
      components: specs.map((spec) => ({ id: spec.id, version: spec.version })),
      activatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const failed: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components,
      code: "science-suite-activation-write-failed",
      message: error instanceof Error ? error.message : "science-suite-activation-write-failed",
    };
    emit("failed", null, specs.length, completedBytes, failed.message ?? "Installation failed");
    return rollback(failed);
  }

  emit("health-checking", null, specs.length, completedBytes, "Checking the installed Science workspace");
  const status = scienceSuiteStatus();
  if (!status.installed || !status.enabled) {
    const failed: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components,
      code: "science-suite-health-check-failed",
      message: "Agentlas Science did not pass its installation check.",
    };
    emit("failed", null, specs.length, completedBytes, failed.message ?? "Installation failed");
    return rollback(failed);
  }
  const action = components.every((receipt) => receipt.action === "unchanged")
    ? "unchanged"
    : components.some((receipt) => receipt.action === "updated")
      ? "updated"
      : "installed";
  emit("installed", null, specs.length, totalBytes, "Agentlas Science is ready");
  return { ok: true, id: "agentlas-science-suite", action, components, code: null, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "science-suite-install-failed";
    const failed: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components,
      code: message.split(":", 1)[0],
      message,
    };
    emit("failed", null, components.length, completedBytes, message);
    return rollback(failed);
  }
}

async function installScienceSuiteOnce(
  onProgress?: (progress: ScienceSuiteInstallProgress) => void,
): Promise<ScienceSuiteInstallReceipt> {
  if (remoteCatalogInstallEnabled()) return installScienceSuiteFromCatalog(onProgress);
  const totalBytes = SCIENCE_SUITE_SPECS.reduce((sum, spec) => sum + spec.packageBytes, 0);
  const progress = (
    phase: ScienceSuiteInstallProgress["phase"],
    componentId: ScienceSuiteComponentId | null,
    componentIndex: number,
    completedBytes: number,
    message: string,
  ) => {
    try {
      onProgress?.({
        id: "agentlas-science-suite",
        phase,
        componentId,
        componentIndex,
        componentCount: SCIENCE_SUITE_SPECS.length,
        completedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((completedBytes / totalBytes) * 100))) : 0,
        message,
      });
    } catch {
      // Progress delivery cannot participate in installation commit/rollback.
    }
  };

  progress("checking", null, 0, 0, "Checking the signed Science package");
  let completedBytes = 0;
  let remoteRoot = "";
  let sources: Array<{ spec: typeof SCIENCE_SUITE_SPECS[number]; source: string }> = [];
  try {
    if (usesRemotePackageSource()) {
      remoteRoot = fs.mkdtempSync(path.join(app.getPath("temp"), "agentlas-science-suite-"));
      for (let index = 0; index < SCIENCE_SUITE_SPECS.length; index += 1) {
        const spec = SCIENCE_SUITE_SPECS[index];
        const componentRoot = path.join(remoteRoot, `${index}-${spec.id}`);
        const archivePath = path.join(remoteRoot, `${index}.tar.gz`);
        progress("downloading", spec.id, index, completedBytes, `Downloading ${spec.displayName}`);
        try {
          await downloadArchive(remotePackageUrl(spec), archivePath, (received, archiveBytes) => {
            if (!archiveBytes || archiveBytes <= 0) return;
            const fraction = Math.max(0, Math.min(1, received / archiveBytes));
            progress(
              "downloading",
              spec.id,
              index,
              completedBytes + Math.round(spec.packageBytes * fraction),
              `Downloading ${spec.displayName}`,
            );
          });
          progress("verifying", spec.id, index, completedBytes, `Verifying ${spec.displayName}`);
          await extractTarGzip(
            archivePath,
            componentRoot,
            Math.min(MAX_REMOTE_PACKAGE_BYTES, Math.max(spec.packageBytes * 2, spec.packageBytes + 8 * 1024 * 1024)),
          );
          verifyRemotePackage(componentRoot, spec);
        } catch (error) {
          const raw = error instanceof Error ? error.message.split(":", 1)[0] : "science-suite-package-download-failed";
          const code = raw.includes("download") || raw.includes("archive")
            ? "science-suite-package-download-failed"
            : raw.includes("signing-key") || raw.includes("signature")
              ? "science-suite-package-signature-invalid"
              : "science-suite-package-invalid";
          throw new SciencePackageError(code, spec.id, index);
        } finally {
          try { fs.rmSync(archivePath, { force: true }); } catch {}
        }
        sources.push({ spec, source: componentRoot });
        completedBytes += spec.packageBytes;
        progress("verifying", spec.id, index, completedBytes, `Verified ${spec.displayName}`);
      }
      completedBytes = 0;
    } else {
      sources = SCIENCE_SUITE_SPECS.map((spec) => ({
        spec,
        source: process.env[spec.sourceEnv]?.trim() ?? "",
      }));
      const unavailable = sources.find(({ source }) => !source || !path.isAbsolute(source));
      if (unavailable) {
        const current = installer().status(SCIENCE_EXTENSION_ID);
        if (current.installed && current.phase === "installed") {
          return {
            ok: true,
            id: "agentlas-science-suite",
            action: "unchanged",
            components: [{
              ok: true,
              id: SCIENCE_EXTENSION_ID,
              action: "unchanged",
              version: current.version,
              code: null,
              message: null,
            }],
            code: null,
            message: `Agentlas Science is up to date for this Desktop build (v${current.version ?? "0.1.0"}).`,
          };
        }
        throw new SciencePackageError(
          "science-suite-package-unavailable",
          unavailable.spec.id,
          sources.indexOf(unavailable),
        );
      }
      for (let index = 0; index < sources.length; index += 1) {
        const { spec, source } = sources[index];
        try {
          const stat = fs.lstatSync(source);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("science-suite-package-source-invalid");
        } catch {
          throw new SciencePackageError("science-suite-package-source-invalid", spec.id, index);
        }
      }
    }
  } catch (error) {
    const failure = error instanceof SciencePackageError
      ? error
      : new SciencePackageError("science-suite-package-unavailable", SCIENCE_SUITE_SPECS[0].id, 0);
    const spec = SCIENCE_SUITE_SPECS[failure.componentIndex];
    const receipt: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components: [],
      code: failure.code,
      message: failure.code === "science-suite-package-unavailable"
        ? `This Desktop build uses the built-in ${spec.displayName} package. Standalone packages are not available; please update the Desktop application.`
        : failure.code === "science-suite-package-download-failed"
          ? `${spec.displayName} could not be downloaded. Check the network and try again.`
          : failure.code === "science-suite-package-signature-invalid"
            ? `${spec.displayName} was not signed by a trusted Agentlas release key.`
            : `${spec.displayName} did not pass package verification.`,
    };
    progress("failed", failure.componentId, failure.componentIndex, 0, receipt.message ?? receipt.code ?? "Installation failed");
    if (remoteRoot) {
      try { fs.rmSync(remoteRoot, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
    return receipt;
  }

  let rollbackAfterMutation: ((failed: ScienceSuiteInstallReceipt) => ScienceSuiteInstallReceipt) | null = null;
  try {
    const extensionInstaller = installer();
    let priorActivation: ReturnType<ProductExtensionInstaller["captureActivationState"]>;
    try {
      priorActivation = extensionInstaller.captureActivationState(sources.map(({ spec }) => spec.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "science-suite-activation-invalid";
      const receipt: ScienceSuiteInstallReceipt = {
        ok: false,
        id: "agentlas-science-suite",
        action: "failed",
        components: [],
        code: message.split(":", 1)[0],
        message,
      };
      progress("failed", null, 0, completedBytes, message);
      return receipt;
    }
    const rollback = (failed: ScienceSuiteInstallReceipt): ScienceSuiteInstallReceipt => {
      try {
        extensionInstaller.restoreActivationState(priorActivation);
        return failed;
      } catch (error) {
        return {
          ...failed,
          code: "science-suite-rollback-failed",
          message: error instanceof Error ? error.message : "science-suite-rollback-failed",
        };
      }
    };
    rollbackAfterMutation = rollback;
    const componentReceipts: ProductExtensionInstallReceipt[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      const { spec, source } = sources[index];
      progress("installing", spec.id, index, completedBytes, `Installing ${spec.displayName}`);
      const receipt = extensionInstaller.installFromDirectory(path.resolve(source));
      componentReceipts.push(receipt);
      if (!receipt.ok || receipt.id !== spec.id || receipt.version !== spec.version) {
        const failed: ScienceSuiteInstallReceipt = {
          ok: false,
          id: "agentlas-science-suite",
          action: "failed",
          components: componentReceipts,
          code: receipt.code ?? "science-suite-component-install-failed",
          message: receipt.message ?? `${spec.displayName} could not be installed.`,
        };
        progress("failed", spec.id, index, completedBytes, failed.message ?? failed.code ?? "Installation failed");
        return rollback(failed);
      }
      completedBytes += spec.packageBytes;
      progress("verifying", spec.id, index, completedBytes, `Verified ${spec.displayName}`);
    }

    progress("health-checking", null, sources.length, completedBytes, "Checking the installed Science workspace");
    const finalStatus = scienceSuiteStatus();
    if (!finalStatus.installed || !finalStatus.enabled) {
      const receipt: ScienceSuiteInstallReceipt = {
        ok: false,
        id: "agentlas-science-suite",
        action: "failed",
        components: componentReceipts,
        code: "science-suite-health-check-failed",
        message: "Agentlas Science did not pass its installation check.",
      };
      progress("failed", null, sources.length, completedBytes, receipt.message ?? "Agentlas Science did not pass its installation check.");
      return rollback(receipt);
    }
    const action = componentReceipts.every((receipt) => receipt.action === "unchanged")
      ? "unchanged"
      : componentReceipts.some((receipt) => receipt.action === "updated")
        ? "updated"
        : "installed";
    progress("installed", null, sources.length, totalBytes, "Agentlas Science is ready");
    return {
      ok: true,
      id: "agentlas-science-suite",
      action,
      components: componentReceipts,
      code: null,
      message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "science-suite-install-failed";
    const failed: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components: [],
      code: message.split(":", 1)[0],
      message,
    };
    progress("failed", null, 0, completedBytes, message);
    return rollbackAfterMutation ? rollbackAfterMutation(failed) : failed;
  } finally {
    if (remoteRoot) {
      try { fs.rmSync(remoteRoot, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }
}

let activeScienceSuiteInstall: Promise<ScienceSuiteInstallReceipt> | null = null;

export async function installScienceSuite(
  onProgress?: (progress: ScienceSuiteInstallProgress) => void,
): Promise<ScienceSuiteInstallReceipt> {
  if (activeScienceSuiteInstall) return activeScienceSuiteInstall;
  const pending = installScienceSuiteOnce(onProgress);
  activeScienceSuiteInstall = pending;
  try {
    return await pending;
  } finally {
    if (activeScienceSuiteInstall === pending) activeScienceSuiteInstall = null;
  }
}

export function setScienceExtensionEnabled(enabled: boolean): ProductExtensionStatus {
  return installer().setEnabled(SCIENCE_EXTENSION_ID, enabled);
}

export function uninstallScienceExtension(): ProductExtensionUninstallReceipt {
  return installer().uninstall(SCIENCE_EXTENSION_ID);
}

export function resetScienceExtensionInstallerForTests(): void {
  if (app.isPackaged) return;
  cachedInstaller = null;
  activeScienceSuiteInstall = null;
}
