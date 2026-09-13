import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import type { ProjectSourceConnectResult } from "../../shared/types";
import { grantPath } from "../fs/access";

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const STAGING_PREFIX = ".agentlas-clone-";

interface GithubConnectOptions {
  /** Main-only verification seams. Renderer IPC never supplies these values. */
  ghExecutable?: string;
  timeoutMs?: Partial<Record<"version" | "authStatus" | "authLogin" | "clone", number>>;
  selectDestination?: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  issueGrant?: typeof grantPath;
}

function canonicalRepositoryUrl(raw: string): { url: string; name: string } | null {
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port
    || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = segments[0];
  const leaf = segments[1].endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  // Reject percent-encoding and every character outside GitHub's path-name
  // alphabet. Besides making the saved URL canonical, this keeps URL parsing
  // from becoming a second command-line grammar at the gh boundary.
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPOSITORY_RE.test(leaf) || leaf === "." || leaf === "..") return null;
  return { url: `https://github.com/${owner}/${leaf}`, name: leaf };
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 50 ? Math.min(Number(value), 10 * 60_000) : fallback;
}

async function gh(executable: string, args: string[], timeoutMs: number, interactive = false): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let forceKill: NodeJS.Timeout | null = null;
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      detached,
      env: {
        ...process.env,
        GH_NO_UPDATE_NOTIFIER: "1",
        ...(interactive ? {} : { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }),
      },
      stdio: "ignore",
      windowsHide: true,
    });

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve(ok);
    };
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // ESRCH means the process already exited between the timer and kill.
      }
    };
    const timeout = setTimeout(() => {
      killTree("SIGTERM");
      forceKill = setTimeout(() => {
        killTree("SIGKILL");
        finish(false);
      }, 1_000);
      forceKill.unref();
    }, timeoutMs);
    timeout.unref();

    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function canonicalDirectory(rawPath: string): string | null {
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) return null;
  try {
    const real = fs.realpathSync.native(path.resolve(rawPath));
    const stat = fs.lstatSync(real);
    return stat.isDirectory() && !stat.isSymbolicLink() ? real : null;
  } catch {
    return null;
  }
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeOwnedStagingRoot(stagingRoot: string | null, parent: string): void {
  if (!stagingRoot || path.dirname(stagingRoot) !== parent || !path.basename(stagingRoot).startsWith(STAGING_PREFIX)) return;
  try {
    fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    // Best effort only. Never widen cleanup beyond the exact root mkdtemp made.
  }
}

/** Main-owned OAuth + clone boundary. gh stores OAuth credentials in the system credential store. */
export async function connectGithubProject(
  parent: BrowserWindow | null,
  repositoryUrl: string,
  options: GithubConnectOptions = {},
): Promise<ProjectSourceConnectResult> {
  const repository = canonicalRepositoryUrl(repositoryUrl);
  if (!repository) return { status: "action_required", capability: "repository" };

  const executable = options.ghExecutable || "gh";
  const timeout = {
    version: boundedTimeout(options.timeoutMs?.version, 10_000),
    authStatus: boundedTimeout(options.timeoutMs?.authStatus, 15_000),
    authLogin: boundedTimeout(options.timeoutMs?.authLogin, 10 * 60_000),
    clone: boundedTimeout(options.timeoutMs?.clone, 10 * 60_000),
  };
  if (!await gh(executable, ["--version"], timeout.version)) {
    return { status: "action_required", capability: "github_client" };
  }
  if (!await gh(executable, ["auth", "status", "--hostname", "github.com"], timeout.authStatus)) {
    const signedIn = await gh(executable, [
      "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard",
    ], timeout.authLogin, true);
    if (!signedIn || !await gh(
      executable,
      ["auth", "status", "--hostname", "github.com"],
      timeout.authStatus,
    )) return { status: "action_required", capability: "github_auth" };
  }

  const choice = options.selectDestination
    ? await options.selectDestination()
    : await dialog.showOpenDialog(parent ?? undefined!, {
      title: "Choose where to clone the project",
      properties: ["openDirectory", "createDirectory"],
    });
  if (choice.canceled || choice.filePaths.length !== 1) return { status: "cancelled", capability: "destination" };

  const cloneParent = canonicalDirectory(choice.filePaths[0]);
  if (!cloneParent) return { status: "action_required", capability: "destination" };
  const destination = path.join(cloneParent, repository.name);
  try {
    if (pathEntryExists(destination)) return { status: "action_required", capability: "destination" };
  } catch {
    return { status: "action_required", capability: "destination" };
  }

  // Clone out of sight first. A failed/timed-out gh process can freely leave a
  // partial checkout here; cleanup never touches a path that existed before
  // this call, and retry sees the final destination as available.
  let stagingRoot: string | null = null;
  try {
    stagingRoot = fs.mkdtempSync(path.join(cloneParent, STAGING_PREFIX));
    const stagedDestination = path.join(stagingRoot, repository.name);
    if (!await gh(executable, ["repo", "clone", repository.url, stagedDestination], timeout.clone)) {
      return { status: "action_required", capability: "clone" };
    }
    const stagedReal = canonicalDirectory(stagedDestination);
    if (!stagedReal || path.dirname(stagedReal) !== stagingRoot) {
      return { status: "action_required", capability: "clone" };
    }
    if (pathEntryExists(destination)) return { status: "action_required", capability: "destination" };
    fs.renameSync(stagedDestination, destination);
    const folderGrant = (options.issueGrant ?? grantPath)(destination, { durable: true });
    return {
      status: "connected",
      capability: "ready",
      repositoryUrl: repository.url,
      folderGrant,
    };
  } catch {
    return { status: "action_required", capability: "destination" };
  } finally {
    removeOwnedStagingRoot(stagingRoot, cloneParent);
  }
}
