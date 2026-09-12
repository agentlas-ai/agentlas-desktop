import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  LocalEngineInstallationReceipt,
  LocalEnginePackageIdentity,
} from "../../shared/local-model-hub";
import {
  LOCAL_MODEL_HUB_SCHEMA_VERSION,
  assertLocalEnginePackageIdentity,
} from "../../shared/local-model-hub";
import { sha256File } from "./download-manager";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface LocalEngineInstallerOptions {
  ghCandidates?: readonly string[];
  commandRunner?: (executable: string, args: readonly string[]) => Promise<CommandResult>;
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= 1_048_576) return current;
  return `${current}${chunk.toString("utf8")}`.slice(0, 1_048_576);
}

async function runCommand(executable: string, args: readonly string[]): Promise<CommandResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findGh(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await regularFile(candidate)) return candidate;
  }
  return null;
}

function safeTarEntry(entry: string): boolean {
  if (entry === "." || entry === "./") return true;
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  const resolvedRoot = resolve(root);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path));
        if (!target.startsWith(`${resolvedRoot}${sep}`)) throw new Error("engine_archive_symlink_rejected");
        continue;
      }
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile()) result.push(path);
      else throw new Error("engine_archive_special_file_rejected");
    }
  }
  return result;
}

export class LocalEngineInstaller {
  private readonly commandRunner: (executable: string, args: readonly string[]) => Promise<CommandResult>;
  private readonly ghCandidates: readonly string[];

  constructor(private readonly installRoot: string, options: LocalEngineInstallerOptions = {}) {
    this.commandRunner = options.commandRunner ?? runCommand;
    this.ghCandidates = options.ghCandidates ?? ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
  }

  async install(
    identity: LocalEnginePackageIdentity,
    verifiedArchivePath: string,
  ): Promise<LocalEngineInstallationReceipt> {
    assertLocalEnginePackageIdentity(identity);
    if (identity.platform !== process.platform || identity.arch !== process.arch) {
      throw new Error("engine_package_host_mismatch");
    }
    if (identity.archiveFormat !== "tar.gz") throw new Error("engine_archive_format_unsupported");
    if (basename(verifiedArchivePath) !== identity.fileName) throw new Error("engine_archive_name_mismatch");
    if (!await regularFile(verifiedArchivePath)) throw new Error("engine_archive_missing");
    if (await sha256File(verifiedArchivePath) !== identity.sha256) throw new Error("engine_archive_sha256_mismatch");

    const gh = await findGh(this.ghCandidates);
    if (!gh) throw new Error("engine_attestation_verifier_unavailable");
    const attestation = await this.commandRunner(gh, [
      "attestation",
      "verify",
      verifiedArchivePath,
      "--repo",
      identity.provenance.repository,
      "--signer-repo",
      identity.provenance.signerWorkflowRepository,
    ]);
    if (attestation.exitCode !== 0) throw new Error("engine_artifact_attestation_failed");

    const tar = "/usr/bin/tar";
    if (!await regularFile(tar)) throw new Error("engine_archive_reader_unavailable");
    const listing = await this.commandRunner(tar, ["-tzf", verifiedArchivePath]);
    if (listing.exitCode !== 0) throw new Error("engine_archive_listing_failed");
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (entries.length === 0 || entries.some((entry) => !safeTarEntry(entry))) {
      throw new Error("engine_archive_path_rejected");
    }

    await mkdir(this.installRoot, { recursive: true, mode: 0o700 });
    const temp = join(this.installRoot, `.install-${randomUUID()}`);
    const finalRoot = join(this.installRoot, identity.sha256);
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      const extraction = await this.commandRunner(tar, ["-xzf", verifiedArchivePath, "-C", temp]);
      if (extraction.exitCode !== 0) throw new Error("engine_archive_extraction_failed");
      const files = await walkFiles(temp);
      const executables = files.filter((file) => basename(file) === "llama-server");
      if (executables.length !== 1) throw new Error("engine_executable_ambiguous");
      const executable = executables[0]!;
      const executableRelativePath = relative(temp, executable);
      if (executableRelativePath.startsWith("..") || resolve(temp, executableRelativePath) !== executable) {
        throw new Error("engine_executable_path_rejected");
      }
      await chmod(executable, 0o700);
      const executableSha256 = await sha256File(executable);
      await rm(finalRoot, { recursive: true, force: true });
      await rename(temp, finalRoot);
      return {
        schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
        receiptId: randomUUID(),
        enginePackageId: identity.packageId,
        enginePackageSha256: identity.sha256,
        provenanceVerified: true,
        executableSha256,
        executableRelativePath: executableRelativePath.split(sep).join("/"),
        installedAt: new Date().toISOString(),
      };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  executablePath(
    identity: LocalEnginePackageIdentity,
    receipt: LocalEngineInstallationReceipt,
  ): string {
    if (
      receipt.enginePackageId !== identity.packageId
      || receipt.enginePackageSha256 !== identity.sha256
      || receipt.provenanceVerified !== true
    ) throw new Error("engine_installation_receipt_mismatch");
    const root = join(this.installRoot, identity.sha256);
    const path = resolve(root, receipt.executableRelativePath);
    if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error("engine_executable_path_rejected");
    return path;
  }
}
