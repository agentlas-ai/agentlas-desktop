#!/usr/bin/env node
// Release verification is fetched into OS temporary storage, never the public
// source tree or installer. These pins attest to the last immutable predecessor.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const predecessor = "f0050cfd6202d922ff1aeb0d0e4040a88b6ed2c3";
const pins = {
  "verify-packaged-workforce-runtime.cjs": "320d4548374d4419234d68a1e6dcb672313ba065e789eb6864d8f20cc118ee37",
  "smoke-signed-mac-python-cache.cjs": "40a169204e941c34cc5b84e3f9a9d3220e16f5305e1b6cb5063c05933d4b210c",
  "verify-packaged-updater-install-e2e.cjs": "80f7f97658a23c2bb502da3f2d0656dac96d79cf39eba9f12fe3975e1369ed6a",
  "science-release-catalog-archive-gate.mjs": "8d5077b72a6037b7bfff390a3d25d3c793def9ad57ff5aa2dab8f9099855c90c",
  "verify-builtin-plugins-degrade.mjs": "47801c16ef3dd39c0da35d56103f8ba3eca3d179f4ce5ca8b73a8f556324eaaf",
  "verify-updater-withdrawn-release-guard.mjs": "ea0f5e41b36ccee9267057cea4a58469702758dda2eb48edef800f4e8c042e86",
  "verify-unanswerable-questions-hidden.mjs": "eccfdbffa72f0da99e99889541bfe81f65fc0857c2e343581b5c0a9469416379",
  "lib/science-release-archive-validator.cjs": "34c4505e114a405c24dceeef1832afd084db00b9a8176bd397a8021b96520824"
};
let harness;

export function prepareReleaseVerification() {
  if (harness) return harness;
  // Read and authenticate every byte before any verifier is executable.
  const files = Object.entries(pins).map(([name, digest]) => {
    const bytes = execFileSync("git", ["show", `${predecessor}:scripts/${name}`], {
      cwd: root, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error(`Release verification SHA-256 mismatch: ${name}`);
    }
    return [name, bytes];
  });
  const target = mkdtempSync(join(tmpdir(), "agentlas-release-verification-"));
  try {
    for (const name of ["electron", "renderer", "dist", "build-resources", "node_modules"]) {
      const source = join(root, name);
      // dist may be built after the harness is prepared by package-mac.sh.
      symlinkSync(source, join(target, name), process.platform === "win32" ? "junction" : "dir");
    }
    for (const name of ["package.json", "package-lock.json"]) {
      if (existsSync(join(root, name))) copyFileSync(join(root, name), join(target, name));
    }
    for (const [name, bytes] of files) {
      const file = join(target, "scripts", name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    }
    harness = target;
    return target;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function releaseVerificationFile(name) {
  if (!Object.hasOwn(pins, name)) throw new Error(`Release verifier is not allowlisted: ${name}`);
  return join(prepareReleaseVerification(), "scripts", name);
}

export function cleanupReleaseVerification() {
  if (harness) rmSync(harness, { recursive: true, force: true });
  harness = undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--run") {
      const file = releaseVerificationFile(process.argv[3]);
      try {
        const result = spawnSync(process.execPath, [file, ...process.argv.slice(4)], { cwd: root, env: process.env, stdio: "inherit" });
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
      } finally {
        cleanupReleaseVerification();
      }
    } else if (process.argv.length === 2) {
      // Shell callers own cleanup after running an isolated Electron process.
      process.stdout.write(`${prepareReleaseVerification()}\n`);
    } else {
      throw new Error("Usage: fetch-release-verification.mjs [--run <allowlisted-file> ...args]");
    }
  } catch (error) {
    console.error(`[release-verification] ${error.message}`);
    process.exitCode = 1;
  }
}
