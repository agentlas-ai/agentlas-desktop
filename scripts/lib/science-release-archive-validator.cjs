"use strict";

/**
 * Release-time verifier for the immutable Agentlas Science extension archives.
 *
 * The installer validates an archive immediately before activation, but that
 * is too late for a public catalog: a catalog can advertise an older archive
 * while the source checkout has already gained labs or a new host contract.
 * This module is intentionally usable by both the local promotion gate and a
 * deterministic contract test. It never mutates an installed extension and
 * never opens an Electron window.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { unzipSync } = require("fflate");

const {
  isProductExtensionManifest,
  isSafeProductExtensionPath,
  compareProductExtensionVersions,
  productExtensionSignedPayload,
} = require("../../dist/shared/product-extension.js");
const {
  isScienceRendererPackManifest,
  validateScienceRendererPackRelease,
} = require("../../dist/shared/science-renderer-pack.js");
const { parseScienceServiceDescriptor } = require("../../dist/shared/science-lab-capability.js");
const {
  assertScienceExtensionReleaseHostCompatibility,
} = require("../../dist/electron/science/tool-control-server.js");

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const SCIENCE_EXTENSION_ID = "agentlas-science";
const SCIENCE_COMPONENT_IDS = new Set([
  SCIENCE_EXTENSION_ID,
  "agentlas-science-renderer-ketcher",
  "agentlas-science-renderer-molstar",
]);
const SCIENCE_RENDERER_COMPONENT_IDS = new Set([
  "agentlas-science-renderer-ketcher",
  "agentlas-science-renderer-molstar",
]);
const TRUSTED_ARCHIVE_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function fail(code, detail) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes, code) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function labHostContract(lab) {
  return {
    id: lab.id,
    artifactKinds: lab.artifactKinds,
    rendererIds: lab.rendererIds,
    supportedOperations: lab.supportedOperations,
    aiCallableOperations: lab.aiCallableOperations,
  };
}

function toolHostContract(tool) {
  return {
    id: tool.id,
    version: tool.version,
    runtime: tool.runtime,
    capability: tool.capability,
    network: tool.network,
    labId: tool.labId,
    operation: tool.operation,
    primaryArtifact: tool.primaryArtifact,
    mcp: {
      name: tool.mcp.name,
      route: tool.mcp.route,
      inputSchema: tool.mcp.inputSchema,
    },
  };
}

function assertDeclaredDescriptorResources(actual, expected) {
  const expectedLabById = new Map(expected.labs.map((lab) => [lab.id, lab]));
  const expectedToolById = new Map(expected.tools.map((tool) => [tool.id, tool]));
  for (const lab of actual.labs) {
    const sourceLab = expectedLabById.get(lab.id);
    if (!sourceLab) fail("science-release-descriptor-lab-unsupported", lab.id);
    if (canonicalJson(labHostContract(lab)) !== canonicalJson(labHostContract(sourceLab))) {
      fail("science-release-descriptor-lab-resource-mismatch", lab.id);
    }
  }
  for (const tool of actual.tools) {
    const sourceTool = expectedToolById.get(tool.id);
    if (!sourceTool) fail("science-release-descriptor-tool-unsupported", tool.id);
    if (canonicalJson(toolHostContract(tool)) !== canonicalJson(toolHostContract(sourceTool))) {
      fail("science-release-descriptor-tool-resource-mismatch", tool.id);
    }
  }
}

function assertComponent(component) {
  if (!component || typeof component !== "object" || Array.isArray(component)) fail("science-release-component-invalid");
  if (typeof component.id !== "string" || typeof component.version !== "string") fail("science-release-component-invalid");
  if (!SCIENCE_COMPONENT_IDS.has(component.id)) fail("science-release-component-unknown", component.id);
  if (!Number.isSafeInteger(component.archiveBytes) || component.archiveBytes <= 0 || component.archiveBytes > MAX_ARCHIVE_BYTES) {
    fail("science-release-component-size-invalid", component.id);
  }
  if (typeof component.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(component.archiveSha256)) {
    fail("science-release-component-digest-invalid", component.id);
  }
  if (typeof component.archiveUrl !== "string") fail("science-release-component-url-invalid", component.id);
}

function archiveEntries(archiveBytes) {
  if (!(archiveBytes instanceof Uint8Array) && !Buffer.isBuffer(archiveBytes)) fail("science-release-archive-bytes-invalid");
  if (archiveBytes.byteLength < 1 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) fail("science-release-archive-size-invalid");
  let entries;
  try {
    entries = unzipSync(archiveBytes);
  } catch {
    fail("science-release-archive-invalid");
  }
  const names = Object.keys(entries);
  if (names.length < 1 || names.length > MAX_ENTRIES) fail("science-release-archive-entry-count-invalid");
  let extractedBytes = 0;
  for (const name of names) {
    if (!isSafeProductExtensionPath(name) || name.endsWith("/")) fail("science-release-archive-path-invalid", name);
    const bytes = entries[name];
    if (!(bytes instanceof Uint8Array)) fail("science-release-archive-entry-invalid", name);
    extractedBytes += bytes.byteLength;
    if (extractedBytes > MAX_EXTRACTED_BYTES) fail("science-release-archive-extracted-size-invalid");
  }
  return entries;
}

function assertArchiveManifestIntegrity(entries, manifest) {
  const declared = new Map(manifest.files.map((file) => [file.path, file]));
  const actual = Object.keys(entries).filter((name) => name !== "extension.json").sort();
  const expected = [...declared.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("science-release-archive-file-list-mismatch", `actual=${JSON.stringify(actual)},expected=${JSON.stringify(expected)}`);
  }
  for (const [relative, file] of declared) {
    const bytes = entries[relative];
    if (!bytes || bytes.byteLength !== file.size) fail("science-release-archive-file-size-mismatch", relative);
    if (sha256(bytes) !== file.sha256) fail("science-release-archive-file-digest-mismatch", relative);
  }
}

function assertManifestSignature(manifest, trustedPublicKeys) {
  if (trustedPublicKeys === undefined || trustedPublicKeys === null) return;
  if (!trustedPublicKeys || typeof trustedPublicKeys !== "object" || Array.isArray(trustedPublicKeys)) {
    fail("science-release-signing-policy-invalid");
  }
  const publicKey = trustedPublicKeys[manifest.signature.keyId];
  if (typeof publicKey !== "string" || !publicKey.trim()) fail("science-release-signing-key-untrusted", manifest.signature.keyId);
  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(productExtensionSignedPayload(manifest), "utf8"),
      publicKey,
      Buffer.from(manifest.signature.value, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail("science-release-signature-invalid", manifest.signature.keyId);
}

function writeHostProbeFiles(entries, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-release-host-probe-"));
  const serviceEntry = manifest.serviceEntry;
  const compatibilityPath = path.posix.join(path.posix.dirname(serviceEntry), "host-compatibility.json");
  for (const relative of [serviceEntry, compatibilityPath]) {
    const bytes = entries[relative];
    if (!bytes) {
      fs.rmSync(root, { recursive: true, force: true });
      fail("science-release-host-compatibility-missing", relative);
    }
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o600, flag: "wx" });
  }
  return { root, compatibilityPath };
}

function assertHostCompatibility(entries, manifest) {
  if (manifest.id !== SCIENCE_EXTENSION_ID) return false;
  if (!manifest.serviceEntry) fail("science-release-service-entry-missing");
  const compatibilityPath = path.posix.join(path.posix.dirname(manifest.serviceEntry), "host-compatibility.json");
  const compatibilityFile = manifest.files.find((file) => file.path === compatibilityPath);
  if (!compatibilityFile || !entries[compatibilityPath]) {
    fail("science-release-host-compatibility-missing");
  }
  const probe = writeHostProbeFiles(entries, manifest);
  try {
    assertScienceExtensionReleaseHostCompatibility({
      releaseDir: probe.root,
      manifest,
    });
  } catch (error) {
    const code = error && typeof error.message === "string" ? error.message.split(":", 1)[0] : "science-release-host-compatibility-invalid";
    fail(code);
  } finally {
    fs.rmSync(probe.root, { recursive: true, force: true });
  }
  return true;
}

function assertScienceDescriptor(entries, manifest, expectedDescriptor) {
  if (manifest.id !== SCIENCE_EXTENSION_ID) return null;
  if (!manifest.serviceEntry) fail("science-release-service-entry-missing");
  const descriptorBytes = entries[manifest.serviceEntry];
  if (!descriptorBytes) fail("science-release-service-descriptor-missing");
  const descriptorValue = parseJsonBytes(descriptorBytes, "science-release-service-descriptor-invalid");
  let descriptor;
  try {
    descriptor = parseScienceServiceDescriptor(descriptorValue);
  } catch (error) {
    const code = error && typeof error.message === "string" ? error.message.split(":", 1)[0] : "science-release-service-descriptor-invalid";
    fail(code);
  }
  if (expectedDescriptor !== undefined) {
    let expected;
    try {
      expected = parseScienceServiceDescriptor(expectedDescriptor);
    } catch {
      fail("science-release-expected-service-descriptor-invalid");
    }
    // A separately shipped Science extension may intentionally expose a bounded
    // subset of the current host catalogue. Every declared resource must still
    // be an exact, hash-equivalent host resource; the package must not claim a
    // lab or tool that this Desktop source does not define.
    assertDeclaredDescriptorResources(descriptor, expected);
  }
  return descriptor;
}

function assertRendererPack(entries, manifest, desktopVersion) {
  if (!SCIENCE_RENDERER_COMPONENT_IDS.has(manifest.id)) return null;
  const bytes = entries["renderer-pack.json"];
  if (!bytes) fail("science-release-renderer-pack-descriptor-missing", manifest.id);
  const raw = parseJsonBytes(bytes, "science-release-renderer-pack-descriptor-invalid");
  if (!isScienceRendererPackManifest(raw)) fail("science-release-renderer-pack-descriptor-invalid", manifest.id);
  try {
    validateScienceRendererPackRelease(raw, manifest, desktopVersion);
  } catch (error) {
    const code = error && typeof error.message === "string" ? error.message.split(":", 1)[0] : "science-release-renderer-pack-invalid";
    fail(code, manifest.id);
  }
  return raw;
}

/**
 * Verify one downloaded archive. `expectedDescriptor` is the descriptor from
 * the source commit being promoted, not a descriptor copied from the archive.
 */
function verifyScienceReleaseArchive({ archiveBytes, component, expectedDescriptor, trustedPublicKeys, desktopVersion = "0.0.0" }) {
  assertComponent(component);
  if (archiveBytes.byteLength !== component.archiveBytes) {
    fail("science-release-archive-size-mismatch", component.id);
  }
  if (sha256(archiveBytes) !== component.archiveSha256) fail("science-release-archive-digest-mismatch", component.id);
  const entries = archiveEntries(archiveBytes);
  const manifestBytes = entries["extension.json"];
  if (!manifestBytes) fail("science-release-extension-manifest-missing", component.id);
  const manifestValue = parseJsonBytes(manifestBytes, "science-release-extension-manifest-invalid");
  if (!isProductExtensionManifest(manifestValue)) fail("science-release-extension-manifest-invalid", component.id);
  const manifest = manifestValue;
  if (manifest.id !== component.id || manifest.version !== component.version) {
    fail("science-release-package-identity-mismatch", `${component.id}@${component.version}`);
  }
  if (desktopVersion !== "0.0.0" && compareProductExtensionVersions(desktopVersion, manifest.minimumDesktopVersion) < 0) {
    fail("science-release-desktop-version-incompatible", `${component.id}@${manifest.minimumDesktopVersion}`);
  }
  assertManifestSignature(manifest, trustedPublicKeys);
  assertArchiveManifestIntegrity(entries, manifest);
  const descriptor = assertScienceDescriptor(entries, manifest, expectedDescriptor);
  const rendererPack = assertRendererPack(entries, manifest, desktopVersion);
  const hostCompatibility = assertHostCompatibility(entries, manifest);
  return {
    id: manifest.id,
    version: manifest.version,
    archiveBytes: archiveBytes.byteLength,
    archiveSha256: sha256(archiveBytes),
    manifestFileCount: manifest.files.length,
    serviceDescriptor: descriptor
      ? { labIds: descriptor.labs.map((lab) => lab.id), toolCount: descriptor.tools.length }
      : null,
    rendererPack: rendererPack
      ? { id: rendererPack.id, version: rendererPack.version, rendererCount: rendererPack.renderers.length }
      : null,
    hostCompatibility,
  };
}

/**
 * Verify every component advertised by a parsed Science release catalog.
 * `fetchArchive` is injected so deterministic tests do not need a network.
 */
async function verifyScienceReleaseCatalogArchives({ catalog, expectedDescriptor, fetchArchive, trustedPublicKeys, desktopVersion = "0.0.0", requireCompleteCatalog = true }) {
  if (!catalog || !Array.isArray(catalog.components) || catalog.components.length < 1) fail("science-release-catalog-components-invalid");
  if (typeof fetchArchive !== "function") fail("science-release-catalog-fetcher-invalid");
  const componentIds = catalog.components.map((component) => component && component.id);
  if (new Set(componentIds).size !== componentIds.length || componentIds.some((id) => !SCIENCE_COMPONENT_IDS.has(id))) {
    fail("science-release-catalog-component-set-invalid");
  }
  if (requireCompleteCatalog && (componentIds.length !== SCIENCE_COMPONENT_IDS.size || [...SCIENCE_COMPONENT_IDS].some((id) => !componentIds.includes(id)))) {
    fail("science-release-catalog-component-set-incomplete");
  }
  const results = [];
  for (const component of catalog.components) {
    assertComponent(component);
    const bytes = await fetchArchive(component);
    results.push(verifyScienceReleaseArchive({
      archiveBytes: bytes,
      component,
      expectedDescriptor,
      trustedPublicKeys,
      desktopVersion,
    }));
  }
  return {
    schema: "agentlas.science-release-archive-verification/v1",
    releaseTag: catalog.releaseTag ?? null,
    suiteVersion: catalog.suiteVersion ?? null,
    components: results,
  };
}

function assertArchiveUrl(value, releaseTag) {
  if (typeof releaseTag !== "string" || !releaseTag) fail("science-release-archive-url-invalid");
  let parsed;
  try { parsed = new URL(value); } catch { fail("science-release-archive-url-invalid"); }
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { fail("science-release-archive-url-invalid", value); }
  const prefix = `/agentlas-ai/agentlas-desktop-releases/releases/download/${releaseTag}/`;
  const fileName = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !fileName
    || fileName.includes("/")
    || !/^[^/]+\.zip$/u.test(fileName)
  ) {
    fail("science-release-archive-url-invalid", value);
  }
  return parsed;
}

async function fetchArchiveFromNetwork(component, options = {}) {
  const releaseTag = options.releaseTag || "";
  const url = assertArchiveUrl(component.archiveUrl, releaseTag);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5 * 60_000);
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { accept: "application/zip,application/octet-stream" },
      });
    } catch {
      fail("science-release-archive-network-failed", component.id);
    }
    let finalUrl;
    try { finalUrl = new URL(response.url || url.toString()); } catch { fail("science-release-archive-redirect-invalid", component.id); }
    if (finalUrl.protocol !== "https:" || !TRUSTED_ARCHIVE_HOSTS.has(finalUrl.hostname)) {
      fail("science-release-archive-redirect-invalid", component.id);
    }
    if (!response.ok) fail(`science-release-archive-http-${response.status}`, component.id);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const declared = Number(contentLength);
      if (!Number.isSafeInteger(declared) || declared !== component.archiveBytes || declared > MAX_ARCHIVE_BYTES) {
        fail("science-release-archive-size-mismatch", component.id);
      }
    }
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== component.archiveBytes) fail("science-release-archive-size-mismatch", component.id);
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = new Uint8Array(next.value);
          total += chunk.byteLength;
          if (total > MAX_ARCHIVE_BYTES || total > component.archiveBytes) fail("science-release-archive-size-mismatch", component.id);
          chunks.push(chunk);
        }
      } catch (error) {
        if (error && typeof error.code === "string" && error.code.startsWith("science-release-")) throw error;
        fail("science-release-archive-network-failed", component.id);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    if (total !== component.archiveBytes) fail("science-release-archive-size-mismatch", component.id);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  SCIENCE_EXTENSION_ID,
  SCIENCE_COMPONENT_IDS,
  SCIENCE_RENDERER_COMPONENT_IDS,
  verifyScienceReleaseArchive,
  verifyScienceReleaseCatalogArchives,
  fetchArchiveFromNetwork,
  assertArchiveUrl,
};
