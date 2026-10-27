/**
 * Linux code-step sandbox (bubblewrap) — the same boundary the macOS Seatbelt profile draws in code-runner.ts:
 * writes only inside the given folders, secret folders hidden, network cut only when the step declares it denied.
 *
 * bwrap is found and probed once. A host without it, or one that blocks unprivileged user namespaces (some distro
 * AppArmor policies, unprivileged containers), gets null: the runner then reports process-isolated, never a sandbox
 * it did not set up. Uses only Node APIs and the shared declarative local sandbox policy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { localSandboxProtectedRelativePaths, localSandboxSecretRelativePaths } from "../../shared/local-sandbox-policy";

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
  return localSandboxSecretRelativePaths("linux").map((rel) => path.join(home, rel));
}

function realExisting(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    try { out.add(fs.realpathSync(p)); } catch { /* absent folders need no mount */ }
  }
  return [...out];
}

/** Existing authority targets, including their replaceable link ancestors. Never materializes missing paths. */
function protectedAuthorityTargets(writable: string[]): string[] {
  const targets = new Set<string>();
  for (const suppliedRoot of writable) {
    let root: string;
    try {
      root = fs.realpathSync(suppliedRoot);
      if (!fs.statSync(root).isDirectory()) continue;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    // Linked Git checkouts store execution/config authority in a .git pointer file too.
    try { if (fs.lstatSync(path.join(root, ".git")).isFile()) targets.add(path.join(root, ".git")); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    for (const relative of localSandboxProtectedRelativePaths()) {
      let cursor = root;
      for (const part of relative.split("/")) {
        const next = path.join(cursor, part);
        let stat: fs.Stats;
        try { stat = fs.lstatSync(next); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) break;
          throw error;
        }
        if (stat.isSymbolicLink()) {
          // Binding its resolved target does not stop replacing the link. Keep the containing directory read-only.
          // If that would cover the entire project, refuse rather than quietly changing its write grant.
          if (cursor === root) {
            const error = new Error("LOCAL_SANDBOX_AUTHORITY_SYMLINK: protected authority is a replaceable project-root symlink");
            Object.assign(error, { code: "LOCAL_SANDBOX_AUTHORITY_SYMLINK", path: next });
            throw error;
          }
          targets.add(cursor);
          break;
        }
        cursor = next;
        if (cursor === path.join(root, relative)) targets.add(cursor);
      }
    }
  }
  return [...targets];
}

/** argv for `bwrap`: options, then the command. Mount order matters — later mounts cover earlier ones. */
export function buildBwrapArgs(opts: LinuxSandboxOptions, command: string, commandArgs: string[]): string[] {
  // A private /proc without a PID namespace still exposes host processes. A nested user namespace can undo
  // read-only bind mounts; require bubblewrap's userns lock rather than claiming confinement without it.
  // bubblewrap itself sets PR_SET_NO_NEW_PRIVS before launching the workload.
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc",
    "--disable-userns", "--cap-drop", "ALL"];
  if (opts.confineWrites === false) args.push("--bind", "/", "/");
  else {
    args.push("--ro-bind", "/", "/");
    for (const dir of realExisting(opts.writable)) args.push("--bind", dir, dir);
  }
  args.push("--dev", "/dev", "--proc", "/proc");
  if (opts.confineWrites !== false) {
    // Bind existing authority targets read-only, after the writable roots. Mount points cannot be renamed
    // away from their denies. Missing authority targets are not created on the host as placeholders.
    for (const target of protectedAuthorityTargets(opts.writable)) args.push("--ro-bind", target, target);
  }
  for (const dir of realExisting(linuxSecretFolders(opts.home))) args.push("--tmpfs", dir, "--remount-ro", dir);
  if (opts.network === "denied") {
    args.push("--unshare-net");
    // Network namespaces do not hide pathname Unix sockets (Docker, D-Bus, host launchers).
    // Hide standard host IPC roots too. Sockets deliberately placed in a writable project are not filtered here.
    for (const dir of realExisting(["/run", "/var/run"])) args.push("--tmpfs", dir, "--remount-ro", dir);
  }
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
    if (probe(bin)) { probed = { path: bin }; break; }
  }
  return probed;
}

function defaultProbe(bin: string): boolean {
  try {
    // Probe the already-selected absolute executable; PATH may begin with a writable project's shim directory.
    const result = spawnSync(bin, buildBwrapArgs({ writable: [], network: "denied" }, bin, ["--version"]), { timeout: 5000, stdio: "ignore" });
    return result.status === 0;
  } catch { return false; }
}

/** Test seam: forget the cached probe. */
export function resetLinuxSandboxProbe(): void { probed = undefined; }
