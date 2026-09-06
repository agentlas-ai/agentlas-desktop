#!/usr/bin/env node

/**
 * Network-facing promotion gate. It fetches the signed Science catalog and
 * then verifies each catalog archive against its advertised bytes/digest,
 * extension manifest, renderer descriptor, and (for the base component) the
 * current source descriptor + Desktop host compatibility contract.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  fetchScienceReleaseCatalog,
  parseScienceReleaseCatalogBytes,
} = require("../dist/electron/extensions/science-catalog.js");
const {
  verifyScienceReleaseCatalogArchives,
  fetchArchiveFromNetwork,
} = require("./lib/science-release-archive-validator.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATE_URL_ENV = "AGENTLAS_SCIENCE_RELEASE_CATALOG_URL";
const CANDIDATE_SHA_ENV = "AGENTLAS_SCIENCE_RELEASE_CATALOG_SHA256";
const MAX_CATALOG_BYTES = 128 * 1024;
const CATALOG_REQUEST_TIMEOUT_MS = 15_000;
const CANDIDATE_PATH = /^\/agentlas-ai\/agentlas-desktop-releases\/releases\/download\/science-v\d+\.\d+\.\d+\/science-catalog\.json$/u;
const TRUSTED_CATALOG_REDIRECT_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function fail(code, detail) {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function candidateConfig() {
  const urlText = String(process.env[CANDIDATE_URL_ENV] || "").trim();
  const digestText = String(process.env[CANDIDATE_SHA_ENV] || "").trim().toLowerCase();
  if (!urlText && !digestText) return null;
  if (!urlText || !digestText) fail("science-release-candidate-config-incomplete");
  if (!/^[a-f0-9]{64}$/u.test(digestText)) fail("science-release-candidate-digest-invalid");
  let url;
  try { url = new URL(urlText); } catch { fail("science-release-candidate-url-invalid"); }
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !CANDIDATE_PATH.test(url.pathname)
  ) {
    fail("science-release-candidate-url-invalid");
  }
  return { url, sha256: digestText };
}

async function readBoundedResponse(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_CATALOG_BYTES) {
      fail("science-release-candidate-too-large");
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_CATALOG_BYTES) fail("science-release-candidate-too-large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > MAX_CATALOG_BYTES) fail("science-release-candidate-too-large");
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchCandidateCatalog(config) {
  let response;
  try {
    response = await fetch(config.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    fail("science-release-candidate-network-failed");
  }
  let finalUrl;
  try { finalUrl = new URL(response.url || config.url.toString()); } catch { fail("science-release-candidate-redirect-invalid"); }
  if (
    finalUrl.protocol !== "https:"
    || finalUrl.port
    || finalUrl.username
    || finalUrl.password
    || finalUrl.hash
    || !TRUSTED_CATALOG_REDIRECT_HOSTS.has(finalUrl.hostname)
    || (finalUrl.hostname === "github.com" && (finalUrl.search || !CANDIDATE_PATH.test(finalUrl.pathname)))
  ) {
    fail("science-release-candidate-redirect-invalid");
  }
  if (!response.ok) fail(`science-release-candidate-http-${response.status}`);
  const bytes = await readBoundedResponse(response);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== config.sha256) fail("science-release-candidate-digest-mismatch");
  return { bytes, finalUrl };
}

async function candidateCatalog() {
  const config = candidateConfig();
  if (!config) return null;
  const { bytes, finalUrl } = await fetchCandidateCatalog(config);
  const value = parseScienceReleaseCatalogBytes(bytes);
  return {
    value,
    source: {
      mode: "candidate",
      url: config.url.toString(),
      finalUrl: finalUrl.toString(),
      sha256: config.sha256,
    },
  };
}

function trustedKeys() {
  const text = String(process.env.AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON || "").trim();
  const publicRelease = process.env.AGENTLAS_PUBLIC_RELEASE === "1" || process.env.GITHUB_ACTIONS === "true";
  if (!text) {
    if (publicRelease) throw new Error("science-release-signing-policy-missing");
    return undefined;
  }
  try {
    // Accept the same raw-key and {schemaVersion, keys} forms as the release
    // policy gate, but return only normalized public keys to the verifier.
    return require("../build-resources/product-extension-signing-policy.cjs")
      .parsePolicyEnvironment(text, "AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON").keys;
  } catch {
    throw new Error("science-release-signing-policy-invalid");
  }
}

async function main() {
  const candidate = await candidateCatalog();
  const catalog = candidate ? candidate.value : await fetchScienceReleaseCatalog(true);
  const expectedDescriptor = JSON.parse(fs.readFileSync(path.join(root, "science-extension", "service", "descriptor.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const result = await verifyScienceReleaseCatalogArchives({
    catalog,
    expectedDescriptor,
    trustedPublicKeys: trustedKeys(),
    desktopVersion: packageJson.version,
    fetchArchive: (component) => fetchArchiveFromNetwork(component, { releaseTag: catalog.releaseTag }),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    catalogSource: candidate?.source || { mode: "production" },
    ...result,
  })}\n`);
}

main().catch((error) => {
  const code = error && typeof error.code === "string"
    ? error.code
    : error && typeof error.message === "string"
      ? error.message.split(":", 1)[0]
      : "science-release-catalog-verification-failed";
  const message = error && typeof error.message === "string" ? error.message.slice(0, 2_048) : code;
  process.stderr.write(`[science-release-catalog] FAIL ${message}\n`);
  process.exitCode = 1;
});
