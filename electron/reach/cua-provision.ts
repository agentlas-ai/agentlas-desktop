import { renameWithRetry } from "../fs/retry";
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CUA_DRIVER_PIN, cuaArtifactUrl, cuaPlatformKey, type CuaArtifact } from "./cua-pin";

// Overridable only so a test can pin a fake artifact; production always passes nothing.
export type CuaPin = { version: string; tag: string; repository: string; macTeamId: string; artifacts: Record<string, CuaArtifact> };
import type { ExecFn } from "./types";

// Gets the pinned Cua Driver onto this machine and proves it is the pinned one. Nothing here runs the driver until every check
// has passed, and nothing is fetched except the single pinned URL. The caller decides WHEN (the user's switch), this decides HOW.
//
// Layout (one writer, this module):  <reachHome>/drivers/cua-driver/<version>/{cua-driver, READY.json}

export type CuaProvisionCode =
  | "cua_platform_unsupported"
  | "cua_download_failed"
  | "cua_size_mismatch"
  | "cua_hash_mismatch"
  | "cua_unsafe_archive"
  | "cua_extract_failed"
  | "cua_signature_invalid"
  | "cua_executable_missing";

export class CuaProvisionError extends Error {
  constructor(public readonly code: CuaProvisionCode, message: string) {
    super(message);
    this.name = "CuaProvisionError";
  }
}

export interface CuaProvisionPorts {
  platform: string;
  arch: string;
  reachHome: string;
  exec: ExecFn;
  // Streams the response body. Returns the bytes in chunks so the hash and the size ceiling are applied as they arrive.
  download(url: string, signal?: AbortSignal): Promise<{ status: number; chunks: AsyncIterable<Uint8Array> }>;
  onProgress?(received: number, total: number): void;
  signal?: AbortSignal;
  pin?: CuaPin;
}

export interface CuaInstall {
  executable: string;
  directory: string;
  version: string;
  reused: boolean;
}

interface ReadyRecord {
  version: string;
  sha256: string;
  artifact: string;
  executable: string;
  installedAt: string;
}

export function cuaInstallDirectory(reachHome: string, version: string = CUA_DRIVER_PIN.version): string {
  return path.join(reachHome, "drivers", "cua-driver", version);
}

async function exists(file: string): Promise<boolean> {
  try { await fsp.access(file); return true; } catch { return false; }
}

// An archive entry may not leave its folder, may not be absolute, and may only be regular names. Checked on the listing BEFORE extraction.
export function assertSafeArchiveListing(listing: string, executable: string): void {
  const entries = listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 64) throw new CuaProvisionError("cua_unsafe_archive", "the archive listing is empty or unreasonably long");
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new CuaProvisionError("cua_unsafe_archive", `the archive holds an unsafe path: ${entry.slice(0, 80)}`);
    }
  }
  if (!entries.some((entry) => entry.replace(/^\.\//, "") === executable)) {
    throw new CuaProvisionError("cua_executable_missing", `the archive has no ${executable}`);
  }
}

export function parseCodesignTeam(output: string): string | null {
  const match = /^TeamIdentifier=(\S+)/m.exec(output);
  return match ? match[1] : null;
}

async function verifySignature(ports: CuaProvisionPorts, executable: string, team: string): Promise<void> {
  if (ports.platform === "darwin") {
    const verify = await ports.exec("/usr/bin/codesign", ["--verify", "--strict", executable], { timeoutMs: 60_000 });
    if (verify.code !== 0) throw new CuaProvisionError("cua_signature_invalid", "codesign rejected the driver binary");
    const detail = await ports.exec("/usr/bin/codesign", ["-dv", "--verbose=2", executable], { timeoutMs: 30_000 });
    const found = parseCodesignTeam(`${detail.stdout}\n${detail.stderr}`);
    if (found !== team) throw new CuaProvisionError("cua_signature_invalid", `unexpected signing team ${found ?? "none"}`);
  }
  // Windows (Authenticode subject) and Linux (no platform signature; the pinned SHA-256 is the proof) are checked by the pinned hash.
}

export async function ensureCuaDriver(ports: CuaProvisionPorts): Promise<CuaInstall> {
  const pin: CuaPin = ports.pin ?? (CUA_DRIVER_PIN as unknown as CuaPin);
  const key = cuaPlatformKey(ports.platform, ports.arch);
  const artifact: CuaArtifact | undefined = key ? pin.artifacts[key] : undefined;
  if (!key || !artifact) throw new CuaProvisionError("cua_platform_unsupported", `no pinned Cua Driver for ${ports.platform}/${ports.arch}`);
  const directory = cuaInstallDirectory(ports.reachHome, pin.version);
  const executable = path.join(directory, artifact.executable);

  // Reuse only what this module itself recorded as complete, for this exact pinned artifact.
  try {
    const ready = JSON.parse(await fsp.readFile(path.join(directory, "READY.json"), "utf8")) as ReadyRecord;
    if (ready.sha256 === artifact.sha256 && ready.version === pin.version && await exists(executable)) {
      await verifySignature(ports, executable, pin.macTeamId);
      return { executable, directory, version: pin.version, reused: true };
    }
  } catch (error) {
    if (error instanceof CuaProvisionError) throw error;
  }

  const parent = path.dirname(directory);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const work = `${directory}.partial-${randomBytes(4).toString("hex")}`;
  await fsp.mkdir(work, { mode: 0o700 });
  const archivePath = path.join(work, artifact.name);
  const unpacked = path.join(work, "unpacked");
  try {
    const response = await ports.download(cuaArtifactUrl(artifact, pin), ports.signal).catch((error: unknown) => {
      throw new CuaProvisionError("cua_download_failed", error instanceof Error ? error.message : "download failed");
    });
    if (response.status !== 200) throw new CuaProvisionError("cua_download_failed", `HTTP ${response.status}`);
    const hash = createHash("sha256");
    const handle = await fsp.open(archivePath, "w", 0o600);
    let received = 0;
    try {
      for await (const chunk of response.chunks) {
        received += chunk.byteLength;
        // The pinned size is a ceiling: a response that keeps going is refused before it fills the disk.
        if (received > artifact.bytes) throw new CuaProvisionError("cua_size_mismatch", "the download is larger than the pinned artifact");
        hash.update(chunk);
        await handle.write(chunk);
        ports.onProgress?.(received, artifact.bytes);
      }
    } finally {
      await handle.close();
    }
    if (received !== artifact.bytes) throw new CuaProvisionError("cua_size_mismatch", `received ${received} bytes, expected ${artifact.bytes}`);
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) throw new CuaProvisionError("cua_hash_mismatch", "the download does not match the pinned SHA-256");

    await fsp.mkdir(unpacked, { mode: 0o700 });
    const list = await ports.exec("tar", ["-tf", archivePath], { timeoutMs: 60_000 });
    if (list.code !== 0) throw new CuaProvisionError("cua_extract_failed", "the archive could not be listed");
    assertSafeArchiveListing(list.stdout, artifact.executable);
    const extract = await ports.exec("tar", ["-xf", archivePath, "-C", unpacked], { timeoutMs: 180_000 });
    if (extract.code !== 0) throw new CuaProvisionError("cua_extract_failed", "the archive could not be extracted");
    const staged = path.join(unpacked, artifact.executable);
    if (!(await exists(staged))) throw new CuaProvisionError("cua_executable_missing", "the executable is missing after extraction");
    if (ports.platform !== "win32") await fsp.chmod(staged, 0o755);
    await verifySignature(ports, staged, pin.macTeamId);

    const ready: ReadyRecord = {
      version: pin.version,
      sha256: artifact.sha256,
      artifact: artifact.name,
      executable: artifact.executable,
      installedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(unpacked, "READY.json"), JSON.stringify(ready), { mode: 0o600 });
    await fsp.rm(archivePath, { force: true });
    await fsp.rm(directory, { recursive: true, force: true });
    await renameWithRetry(unpacked, directory);
    return { executable, directory, version: pin.version, reused: false };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
