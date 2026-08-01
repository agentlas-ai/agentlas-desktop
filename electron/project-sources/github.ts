import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import type { ProjectSourceConnectResult } from "../../shared/types";
import { grantPath } from "../fs/access";

const execFileAsync = promisify(execFile);

function canonicalRepositoryUrl(raw: string): { url: string; name: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const leaf = segments[1].endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  if (!leaf || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\\")) return null;
  return { url: `https://github.com/${segments[0]}/${leaf}`, name: leaf };
}

async function gh(args: string[], timeout: number): Promise<boolean> {
  try {
    await execFileAsync("gh", args, { timeout, maxBuffer: 2 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Main-owned OAuth + clone boundary. gh stores OAuth credentials in the system credential store. */
export async function connectGithubProject(parent: BrowserWindow | null, repositoryUrl: string): Promise<ProjectSourceConnectResult> {
  const repository = canonicalRepositoryUrl(repositoryUrl);
  if (!repository) return { status: "action_required", capability: "repository" };
  if (!await gh(["--version"], 10_000)) return { status: "action_required", capability: "github_client" };
  if (!await gh(["auth", "status", "--hostname", "github.com"], 15_000)) {
    const signedIn = await gh([
      "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard",
    ], 10 * 60_000);
    if (!signedIn) return { status: "action_required", capability: "github_auth" };
  }

  const choice = await dialog.showOpenDialog(parent ?? undefined!, {
    title: "Choose where to clone the project",
    properties: ["openDirectory", "createDirectory"],
  });
  if (choice.canceled || choice.filePaths.length !== 1) return { status: "cancelled", capability: "destination" };
  const destination = path.join(choice.filePaths[0], repository.name);
  if (fs.existsSync(destination)) return { status: "action_required", capability: "destination" };
  if (!await gh(["repo", "clone", repository.url, destination], 10 * 60_000)) {
    return { status: "action_required", capability: "clone" };
  }
  return {
    status: "connected",
    capability: "ready",
    repositoryUrl: repository.url,
    folderGrant: grantPath(destination, { durable: true }),
  };
}
