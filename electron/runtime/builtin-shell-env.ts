import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isPackagedRuntime, optionalElectronAppPath, runtimeResourcesPath } from "../runtime-paths";
import { MAC_RELEASE_NODE_REQUIREMENT, resolveManagedNodeRuntime } from "./managed-node";
import { withPythonCacheBoundary } from "./python-cache";

const PYTHON_ASSETS: Record<string, { triple: string; archiveSha256: string }> = {
  "darwin:arm64": { triple: "aarch64-apple-darwin", archiveSha256: "5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17" },
  "darwin:x64": { triple: "x86_64-apple-darwin", archiveSha256: "cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894" },
  "win32:x64": { triple: "x86_64-pc-windows-msvc", archiveSha256: "346dfbcb95171dd6d1275e6f8cb2e656cc15cb054c399ae54db57bfad4b1a60f" },
  "linux:x64": { triple: "x86_64-unknown-linux-gnu", archiveSha256: "e7332b4b4bb85006deb48d251c786a04c14de104c9b3a006b33457a4a604b8bc" },
};

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Only the product's pinned runtime layout is eligible; no environment-selected interpreter. */
export function validateBuiltinPythonRoot(root: string, platform = process.platform, arch = process.arch,
  signedMac = false): string {
  const asset = PYTHON_ASSETS[`${platform}:${arch}`];
  if (!asset) throw new Error("builtin_python_platform_unsupported");
  const manifestPath = path.join(root, "agentlas-python-runtime.json");
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()
    || !fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error("builtin_python_resource_invalid");
  }
  const realRoot = fs.realpathSync(root);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const relative = platform === "win32" ? "python.exe" : "bin/python3";
  if (manifest.schemaVersion !== "agentlas.python-runtime.v1" || manifest.pythonVersion !== "3.12.13"
    || manifest.releaseTag !== "20260510" || manifest.triple !== asset.triple
    || manifest.archiveSha256 !== asset.archiveSha256
    || manifest.archiveName !== `cpython-3.12.13+20260510-${asset.triple}-install_only.tar.gz`
    || manifest.executableRelativePath !== relative || !/^[a-f0-9]{64}$/.test(manifest.executableSha256)) {
    throw new Error("builtin_python_manifest_mismatch");
  }
  const executable = fs.realpathSync(path.join(realRoot, relative));
  const bin = path.dirname(path.join(realRoot, relative));
  if (!inside(realRoot, executable) || fs.realpathSync(bin) !== bin || !fs.statSync(executable).isFile()) {
    throw new Error("builtin_python_path_escape");
  }
  // PATH also exposes python. Its alias must resolve to this exact executable.
  if (platform !== "win32" && fs.realpathSync(path.join(bin, "python")) !== executable) {
    throw new Error("builtin_python_alias_mismatch");
  }
  const digest = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  if (digest !== manifest.executableSha256) {
    // The official macOS bundle seal verifies the whole app before runtime admission.
    // Re-signing changes Mach-O bytes; require the same pinned release signer here too.
    const requirement = MAC_RELEASE_NODE_REQUIREMENT.replace('identifier "node" and ', "");
    if (!(signedMac && platform === "darwin" && spawnSync("/usr/bin/codesign",
      ["--verify", "--strict", "-R", requirement, executable], { stdio: "ignore", timeout: 30_000 }).status === 0)) {
      throw new Error("builtin_python_checksum_mismatch");
    }
  }
  return bin;
}

/** Child-local PATH: retain the caller environment; add only verified product runtimes. */
export function builtinShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const packaged = isPackagedRuntime();
  const resources = runtimeResourcesPath();
  const appPath = optionalElectronAppPath();
  const root = packaged ? resources && path.join(resources, "python-runtime")
    : appPath && path.join(appPath, "build-resources", "python-runtime");
  const bins: string[] = [];
  if (root && fs.existsSync(root)) bins.push(validateBuiltinPythonRoot(root, process.platform, process.arch, packaged));
  const node = resolveManagedNodeRuntime();
  if (node.ok) bins.push(path.dirname(node.runtime.node));
  if (!bins.length) return withPythonCacheBoundary(base);
  const key = Object.keys(base).find(name => name.toLowerCase() === "path") ?? "PATH";
  return withPythonCacheBoundary({ ...base, [key]: [...new Set([...(base[key] ?? "").split(path.delimiter).filter(Boolean), ...bins])].join(path.delimiter) });
}
