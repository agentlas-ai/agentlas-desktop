import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  LocalEngineDevice,
  LocalEngineInstallationReceipt,
  LocalEnginePackageIdentity,
} from "../../shared/local-model-hub";
import {
  LOCAL_MODEL_HUB_SCHEMA_VERSION,
  assertLocalEnginePackageIdentity,
} from "../../shared/local-model-hub";
import { sha256File } from "./download-manager";
import { extractEngineZip } from "./archive";
import { verifyManagedEngineAttestation } from "./attestation";
import { parseEngineDeviceList } from "./acceleration";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/*
 * ★ 윈도우 새 PC 에는 VC++ 런타임(msvcp140.dll 등)이 없을 수 있다 (2026-09-13 실측).
 *
 * llama-server.exe·llama.dll 은 MSVCP140/VCRUNTIME140/VCRUNTIME140_1 을 import 하는데, 그 세
 * DLL 은 윈도우에 기본 포함이 아니고(UCRT 만 포함) Electron 배포본에도 없다(43.4.1 zip 실측:
 * d3dcompiler·libEGL·vulkan-1 뿐). 그래서 방금 산 PC 에서는 엔진이 시작조차 못 한다
 * (STATUS_DLL_NOT_FOUND = 3221225781). Microsoft 의 앱-로컬 배포 방식대로, 재배포 패키지에서
 * 꺼낸 DLL 세 개를 앱 리소스(vc-redist/x64)에 싣고 시스템에 없을 때만 실행파일 옆에 놓는다.
 * 해시는 여기 소스에 잠근다. 14.44.35211 이 b10903 바이너리가 import 하는 심볼 1,126개를 전부
 * 내보내는 것을 PE 테이블로 확인했다.
 */
export const WINDOWS_CRT_FILES: ReadonlyArray<{ fileName: string; sha256: string; byteLength: number }> = [
  { fileName: "msvcp140.dll", sha256: "0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9", byteLength: 557728 },
  { fileName: "vcruntime140.dll", sha256: "d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066", byteLength: 124544 },
  { fileName: "vcruntime140_1.dll", sha256: "1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f", byteLength: 49792 },
];

export interface LocalEngineInstallerOptions {
  attestationVerifier?: typeof verifyManagedEngineAttestation;
  /** Directory holding the pinned CRT DLLs (production: <resources>/vc-redist/x64). Windows only. */
  windowsRuntimeDir?: string;
  /** Injectable for tests; production reads %SystemRoot%. */
  windowsSystemRoot?: string;
  /** Injectable host facts for archive policy tests; production always uses actual process facts. */
  platform?: NodeJS.Platform;
  arch?: string;
  commandRunner?: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<CommandResult>;
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= 1_048_576) return current;
  return `${current}${chunk.toString("utf8")}`.slice(0, 1_048_576);
}

async function runCommand(executable: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  return await new Promise((resolveResult, reject) => {
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
    const child = spawn(executable, [...args], { signal: boundedSignal, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

export async function verifyWindowsPortableExecutable(path: string, arch: string): Promise<void> {
  const file = await open(path,"r");
  try {
    const size = (await file.stat()).size, header = Buffer.alloc(64);
    if ((await file.read(header,0,64,0)).bytesRead !== 64 || header.toString("ascii",0,2) !== "MZ") throw new Error("engine_pe_header_invalid");
    const offset = header.readUInt32LE(60), coff = Buffer.alloc(6);
    if (offset < 64 || offset+6 > size || (await file.read(coff,0,6,offset)).bytesRead !== 6 || coff.readUInt32LE(0) !== 0x00004550) throw new Error("engine_pe_header_invalid");
    const machine = coff.readUInt16LE(4);
    if (machine !== (arch === "x64" ? 0x8664 : arch === "arm64" ? 0xaa64 : -1)) throw new Error("engine_pe_architecture_mismatch");
  } finally { await file.close(); }
}

function safeTarEntry(entry: string): boolean {
  if (entry === "." || entry === "./") return true;
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}

async function walkFiles(root: string, rejectLinks = false): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  const resolvedRoot = resolve(root);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        if (rejectLinks) throw new Error("engine_archive_symlink_rejected");
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
  private readonly commandRunner: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<CommandResult>;
  private readonly attestationVerifier: typeof verifyManagedEngineAttestation;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly windowsRuntimeDir: string | null;
  private readonly windowsSystemRoot: string | null;

  constructor(private readonly installRoot: string, options: LocalEngineInstallerOptions = {}) {
    this.commandRunner = options.commandRunner ?? runCommand;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.attestationVerifier = options.attestationVerifier ?? verifyManagedEngineAttestation;
    this.windowsRuntimeDir = options.windowsRuntimeDir ?? null;
    this.windowsSystemRoot = options.windowsSystemRoot ?? process.env.SystemRoot ?? null;
  }

  /**
   * App-local CRT: copy each pinned DLL next to llama-server.exe only when
   * System32 lacks it, so a machine with a (possibly newer) system runtime keeps
   * using that. Returns the file names placed. A hash mismatch refuses the copy —
   * an unpinned DLL never enters an attested engine directory.
   */
  async placeWindowsRuntime(executableDir: string): Promise<string[]> {
    if (this.platform !== "win32" || this.arch !== "x64" || !this.windowsRuntimeDir) return [];
    const placed: string[] = [];
    for (const item of WINDOWS_CRT_FILES) {
      const system = this.windowsSystemRoot ? join(this.windowsSystemRoot, "System32", item.fileName) : null;
      if (system && await regularFile(system)) continue;
      const source = join(this.windowsRuntimeDir, item.fileName);
      if (!await regularFile(source)) throw new Error("engine_windows_runtime_missing");
      const bytes = await readFile(source);
      if (bytes.byteLength !== item.byteLength || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error("engine_windows_runtime_sha256_mismatch");
      await copyFile(source, join(executableDir, item.fileName));
      placed.push(item.fileName);
    }
    return placed;
  }

  async install(
    identity: LocalEnginePackageIdentity,
    verifiedArchivePath: string,
    signal?: AbortSignal,
  ): Promise<LocalEngineInstallationReceipt> {
    signal?.throwIfAborted();
    assertLocalEnginePackageIdentity(identity);
    if (identity.platform !== this.platform || identity.arch !== this.arch) {
      throw new Error("engine_package_host_mismatch");
    }
    if (identity.archiveFormat !== (this.platform === "win32" ? "zip" : "tar.gz")) throw new Error("engine_archive_format_unsupported");
    if (basename(verifiedArchivePath) !== identity.fileName) throw new Error("engine_archive_name_mismatch");
    if (!await regularFile(verifiedArchivePath)) throw new Error("engine_archive_missing");
    if ((await stat(verifiedArchivePath)).size !== identity.byteLength) throw new Error("engine_archive_size_mismatch");
    if (await sha256File(verifiedArchivePath) !== identity.sha256) throw new Error("engine_archive_sha256_mismatch");

    const provenanceVerification = await this.attestationVerifier(identity, verifiedArchivePath, join(this.installRoot, ".verification"), signal);
    signal?.throwIfAborted();

    // macOS keeps tar in /usr/bin; Linux distributions without merged /usr only have /bin/tar.
    const tar = await regularFile("/usr/bin/tar") ? "/usr/bin/tar" : "/bin/tar";
    if (identity.archiveFormat === "tar.gz") {
      if (!await regularFile(tar)) throw new Error("engine_archive_reader_unavailable");
      const listing = await this.commandRunner(tar, ["-tzf", verifiedArchivePath], signal);
      signal?.throwIfAborted();
      if (listing.exitCode !== 0) throw new Error("engine_archive_listing_failed");
      const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
      if (entries.length === 0 || entries.some((entry) => !safeTarEntry(entry))) throw new Error("engine_archive_path_rejected");
    }

    await mkdir(this.installRoot, { recursive: true, mode: 0o700 });
    const temp = join(this.installRoot, `.install-${randomUUID()}`);
    const finalRoot = join(this.installRoot, identity.sha256);
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      if (identity.archiveFormat === "zip") await extractEngineZip(verifiedArchivePath, temp, signal);
      else {
        const extraction = await this.commandRunner(tar, ["-xzf", verifiedArchivePath, "-C", temp], signal);
        if (extraction.exitCode !== 0) throw new Error("engine_archive_extraction_failed");
      }
      signal?.throwIfAborted();
      const extracted = await walkFiles(temp, this.platform === "win32");
      const serverName = this.platform === "win32" ? "llama-server.exe" : "llama-server";
      const extractedExecutables = extracted.filter((file) => basename(file) === serverName);
      if (extractedExecutables.length !== 1) throw new Error("engine_executable_ambiguous");
      await this.placeWindowsRuntime(dirname(extractedExecutables[0]!));
      const files = await walkFiles(temp, this.platform === "win32");
      if (this.platform === "win32") for (const file of files) {
        if (/\.(?:exe|dll)$/i.test(file)) await verifyWindowsPortableExecutable(file,identity.arch);
      }
      const executables = files.filter((file) => basename(file) === (this.platform === "win32" ? "llama-server.exe" : "llama-server"));
      if (executables.length !== 1) throw new Error("engine_executable_ambiguous");
      const executable = executables[0]!;
      const executableRelativePath = relative(temp, executable);
      if (executableRelativePath.startsWith("..") || resolve(temp, executableRelativePath) !== executable) {
        throw new Error("engine_executable_path_rejected");
      }
      if (this.platform !== "win32") await chmod(executable, 0o700);
      const executableSha256 = await sha256File(executable);
      const runtimeFiles = await Promise.all(files.map(async file => ({ relativePath: relative(temp,file).split(sep).join("/"), sha256: await sha256File(file), byteLength: (await stat(file)).size })));
      signal?.throwIfAborted();
      await rm(finalRoot, { recursive: true, force: true });
      await rename(temp, finalRoot);
      const devices = await this.probeDevices(resolve(finalRoot, executableRelativePath), signal);
      return {
        schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
        receiptId: randomUUID(),
        enginePackageId: identity.packageId,
        enginePackageSha256: identity.sha256,
        provenanceVerified: true,
        provenanceVerification,
        executableSha256,
        executableRelativePath: executableRelativePath.split(sep).join("/"),
        runtimeFiles,
        ...(devices ? { devices } : {}),
        installedAt: new Date().toISOString(),
      };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Asks the installed executable which compute devices it can see. This is the
   * only honest source for "is there a GPU" on Windows and Intel Macs; the host
   * cannot tell whether a Vulkan/Metal backend will actually load. A probe
   * failure leaves `devices` absent — never an empty "no GPU" claim.
   */
  async probeDevices(executable: string, signal?: AbortSignal): Promise<LocalEngineDevice[] | undefined> {
    try {
      const result = await this.commandRunner(executable, ["--list-devices"], signal);
      if (result.exitCode !== 0) return undefined;
      return parseEngineDeviceList(`${result.stdout}\n${result.stderr}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  async verifyRuntimeFiles(identity: LocalEnginePackageIdentity, receipt: LocalEngineInstallationReceipt): Promise<void> {
    const executable = this.executablePath(identity, receipt);
    if (!receipt.runtimeFiles) {
      if (identity.platform === "win32") throw new Error("engine_runtime_manifest_missing");
      if (await sha256File(executable) !== receipt.executableSha256) throw new Error("engine_executable_sha256_mismatch");
      return;
    }
    if (!receipt.runtimeFiles.length || receipt.runtimeFiles.length > 4096) throw new Error("engine_runtime_manifest_invalid");
    const root = join(this.installRoot, identity.sha256), files = await walkFiles(root, identity.platform === "win32");
    const actual = new Map(files.map(file => [relative(root,file).split(sep).join("/"), file]));
    if (actual.size !== receipt.runtimeFiles.length) throw new Error("engine_runtime_files_changed");
    for (const expected of receipt.runtimeFiles) {
      const file = actual.get(expected.relativePath);
      if (!file || !/^[a-f0-9]{64}$/.test(expected.sha256) || (await stat(file)).size !== expected.byteLength
        || await sha256File(file) !== expected.sha256) throw new Error("engine_runtime_files_changed");
      actual.delete(expected.relativePath);
    }
    if (actual.size || await sha256File(executable) !== receipt.executableSha256) throw new Error("engine_runtime_files_changed");
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
