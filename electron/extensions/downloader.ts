import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  isProductExtensionManifest,
  isSafeProductExtensionPath,
  type ProductExtensionInstallReceipt,
  type ScienceSuiteComponentId,
} from "../../shared/product-extension";
import { ProductExtensionInstaller } from "./installer";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export interface SciencePackageArchiveSpec {
  id: ScienceSuiteComponentId;
  version: string;
  archiveUrl: string;
  archiveBytes: number;
  archiveSha256: string;
}

function failure(spec: SciencePackageArchiveSpec, code: string, message: string): ProductExtensionInstallReceipt {
  return {
    ok: false,
    id: spec.id,
    action: "failed",
    version: null,
    code,
    message,
  };
}

function assertDownloadUrl(spec: SciencePackageArchiveSpec): URL {
  let parsed: URL;
  try {
    parsed = new URL(spec.archiveUrl);
  } catch {
    throw new Error("science-download-url-invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.hostname !== "github.com"
    || !/^\/agentlas-ai\/(?:agentlas-science-releases|agentlas-desktop-releases)\/releases\/download\/science-v\d+\.\d+\.\d+\/[^/]+\.zip$/u.test(parsed.pathname)
    || decodeURIComponent(path.basename(parsed.pathname)) !== path.basename(decodeURIComponent(parsed.pathname))
  ) {
    throw new Error("science-download-url-invalid");
  }
  return parsed;
}

function assertResponseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("science-download-redirect-invalid");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error("science-download-redirect-invalid");
  }
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function readResponseBytes(
  response: Response,
  expectedBytes: number,
  onProgress?: (downloadedBytes: number) => void,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ARCHIVE_BYTES || declared !== expectedBytes) {
      throw new Error("science-download-size-mismatch");
    }
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expectedBytes || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("science-download-size-mismatch");
    onProgress?.(bytes.length);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES || total > expectedBytes) throw new Error("science-download-size-mismatch");
      chunks.push(chunk);
      onProgress?.(total);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (total !== expectedBytes) throw new Error("science-download-size-mismatch");
  return Buffer.concat(chunks, total);
}

function extractArchive(bytes: Uint8Array, targetDir: string): void {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("science-download-archive-invalid");
  }
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > 20_000 || !names.includes("extension.json")) {
    throw new Error("science-download-archive-invalid");
  }
  let extractedBytes = 0;
  for (const relative of names) {
    if (relative.endsWith("/") || !isSafeProductExtensionPath(relative)) {
      throw new Error("science-download-archive-path-invalid");
    }
    const contents = entries[relative];
    extractedBytes += contents.byteLength;
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("science-download-archive-too-large");
    const destination = path.resolve(targetDir, ...relative.split("/"));
    const resolvedRoot = path.resolve(targetDir);
    if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("science-download-archive-path-invalid");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, Buffer.from(contents), { mode: 0o600, flag: "wx" });
  }
}

export async function downloadAndInstallSciencePackage(
  spec: SciencePackageArchiveSpec,
  installer: ProductExtensionInstaller,
  onProgress?: (downloadedBytes: number) => void,
): Promise<ProductExtensionInstallReceipt> {
  let archiveUrl: URL;
  try {
    if (!Number.isSafeInteger(spec.archiveBytes) || spec.archiveBytes <= 0 || spec.archiveBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("science-download-size-mismatch");
    }
    if (!/^[a-f0-9]{64}$/.test(spec.archiveSha256)) throw new Error("science-download-digest-invalid");
    archiveUrl = assertDownloadUrl(spec);
  } catch (error) {
    const code = error instanceof Error ? error.message : "science-download-url-invalid";
    return failure(spec, code, "The signed Agentlas Science download address is invalid.");
  }

  let temporaryRoot = "";
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(archiveUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { accept: "application/zip,application/octet-stream" },
      });
    } catch {
      throw new Error("science-download-network-failed");
    }
    if (!response.ok) throw new Error(`science-download-http-${response.status}`);
    assertResponseUrl(response.url || archiveUrl.toString());
    const bytes = await readResponseBytes(response, spec.archiveBytes, onProgress);
    if (sha256(bytes) !== spec.archiveSha256) throw new Error("science-download-digest-mismatch");

    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-download-"));
    const packageDir = path.join(temporaryRoot, "package");
    fs.mkdirSync(packageDir, { recursive: true, mode: 0o700 });
    extractArchive(bytes, packageDir);
    let manifest: unknown;
    try {
      const manifestPath = path.join(packageDir, "extension.json");
      const stat = fs.lstatSync(manifestPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) throw new Error();
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error("science-download-package-identity-mismatch");
    }
    if (!isProductExtensionManifest(manifest) || manifest.id !== spec.id || manifest.version !== spec.version) {
      throw new Error("science-download-package-identity-mismatch");
    }
    const activation = installer.captureActivationState([spec.id]);
    const receipt = installer.installFromDirectory(packageDir);
    if (receipt.id !== spec.id || receipt.version !== spec.version) {
      installer.restoreActivationState(activation);
      throw new Error("science-download-package-identity-mismatch");
    }
    return receipt;
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "science-download-failed";
    const messages: Record<string, string> = {
      "science-download-http-404": "The signed Agentlas Science package is not published.",
      "science-download-digest-mismatch": "The Agentlas Science package failed its integrity check.",
      "science-download-size-mismatch": "The Agentlas Science package size did not match its release manifest.",
      "science-download-archive-invalid": "The Agentlas Science package archive is invalid.",
      "science-download-archive-path-invalid": "The Agentlas Science package contains an unsafe path.",
      "science-download-archive-too-large": "The Agentlas Science package is too large to install safely.",
      "science-download-network-failed": "Agentlas Science could not reach its signed download.",
      "science-download-redirect-invalid": "Agentlas Science was redirected to an untrusted download host.",
      "science-download-package-identity-mismatch": "The signed Agentlas Science package did not match the requested catalog component.",
    };
    return failure(spec, code, messages[code] ?? "Agentlas Science could not be installed from its signed download.");
  } finally {
    if (timeout) clearTimeout(timeout);
    if (temporaryRoot) {
      try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
    }
  }
}
