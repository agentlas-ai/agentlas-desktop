/**
 * Linux code-step sandbox (bubblewrap) — the same boundary the macOS Seatbelt profile draws in code-runner.ts:
 * writes only inside the given folders, secret folders hidden, network cut only when the step declares it denied.
 *
 * bwrap is found and probed once. A host without it, or one that blocks unprivileged user namespaces (some distro
 * AppArmor policies, unprivileged containers), gets null: the runner then reports process-isolated, never a sandbox
 * it did not set up. Dependency-free so the Linux container gate can load this file alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface LinuxSandboxOptions {
  writable: string[];
  home?: string;
  network?: "allowed" | "denied";
  /** false = writes are not confined (a mutation step that only asked for network denial). */
  confineWrites?: boolean;
}

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

/** Folders whose contents the code must not read (stdout would carry them to the model). */
export function linuxSecretFolders(home: string = os.homedir()): string[] {
  return [".ssh", ".aws", path.join(".config", "gh"), ".gnupg", path.join(".local", "share", "keyrings"), ".password-store"]
    .map((rel) => path.join(home, rel));
}

function realExisting(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    try { out.add(fs.realpathSync(p)); } catch { /* absent folders need no mount */ }
  }
  return [...out];
}

/** argv for `bwrap`: options, then the command. Mount order matters — later mounts cover earlier ones. */
export function buildBwrapArgs(opts: LinuxSandboxOptions, command: string, commandArgs: string[]): string[] {
  const args = ["--die-with-parent"];
  if (opts.confineWrites === false) args.push("--bind", "/", "/");
  else {
    args.push("--ro-bind", "/", "/");
    for (const dir of realExisting(opts.writable)) args.push("--bind", dir, dir);
  }
  args.push("--dev", "/dev", "--proc", "/proc");
  for (const dir of realExisting(linuxSecretFolders(opts.home))) args.push("--tmpfs", dir);
  if (opts.network === "denied") args.push("--unshare-net");
  args.push(command, ...commandArgs);
  return args;
}

let probed: { path: string } | null | undefined;

/** The usable bwrap binary, or null. Probed with the strictest form used (read-only root + no network). */
export function linuxSandbox(probe: (bin: string) => boolean = defaultProbe): { path: string } | null {
  if (probed !== undefined) return probed;
  probed = null;
  if (process.platform !== "linux") return probed;
  for (const bin of BWRAP_CANDIDATES) {
    if (!fs.existsSync(bin)) continue;
    if (probe(bin)) probed = { path: bin };
    break;
  }
  return probed;
}

function defaultProbe(bin: string): boolean {
  try {
    const result = spawnSync(bin, buildBwrapArgs({ writable: [], network: "denied" }, "true", []), { timeout: 5000, stdio: "ignore" });
    return result.status === 0;
  } catch { return false; }
}

/** Test seam: forget the cached probe. */
export function resetLinuxSandboxProbe(): void { probed = undefined; }
