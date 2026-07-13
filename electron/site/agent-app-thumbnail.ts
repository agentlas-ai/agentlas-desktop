import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { SiteAgentAppThumbnailResult } from "../../shared/site-studio";
import { getSiteProject, siteAgentAppsRoot } from "./store";

const CAPTURE_WIDTH = 1_280;
const CAPTURE_HEIGHT = 720;
const COMMAND_TIMEOUT_MS = 5 * 60_000;

function sanitizeBuildOutput(raw: string, cwd: string): string {
  return raw
    .replaceAll(cwd, "[isolated-build]")
    .replace(/(?:\/Users|\/home)\/[^/\s]+/g, (value) => `${value.split("/").slice(0, -1).join("/")}/[user]`)
    .replace(/\b(?:sk|rk|pk|xox[baprs]|gh[pousr])-[A-Za-z0-9_=-]{12,}\b/g, "[redacted-secret]")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s]+/gi, "[redacted-secret]")
    .slice(-4_000);
}

function isolatedBuildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.CI = "1";
  env.NO_COLOR = "1";
  env.NPM_CONFIG_CACHE = path.join(home, ".npm-cache");
  env.NPM_CONFIG_USERCONFIG = path.join(home, ".npmrc-empty");
  env.NPM_CONFIG_AUDIT = "false";
  env.NPM_CONFIG_FUND = "false";
  env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  return env;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    const collect = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-12_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Astryx build timed out: ${command} ${args.join(" ")}`));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Astryx build failed (${code ?? signal ?? "unknown"}): ${sanitizeBuildOutput(output, cwd).trim()}`));
    });
  });
}

const BUILD_OUTPUT_ROOTS = new Set(["node_modules", "dist"]);

async function sourceDigests(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const first = relative.split(path.sep)[0];
      if (BUILD_OUTPUT_ROOTS.has(first) || entry.name.endsWith(".tsbuildinfo")) continue;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Astryx source contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Astryx source contains an unsupported entry: ${relative}`);
      if (stat.size > 2 * 1024 * 1024) throw new Error(`Astryx source file is unexpectedly large: ${relative}`);
      out.set(relative, createHash("sha256").update(await fs.readFile(absolute)).digest("hex"));
    }
  };
  await walk(root);
  return out;
}

function assertSameSources(before: Map<string, string>, after: Map<string, string>): void {
  const unchanged = before.size === after.size && [...before].every(
    ([file, digest]) => after.get(file) === digest,
  );
  if (!unchanged) {
    throw new Error("Astryx build changed generated source or configuration; refusing the artifact.");
  }
}

async function assertSafeDist(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Astryx dist contains a symbolic link.");
      if (stat.isDirectory()) await walk(absolute);
      else if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("Astryx dist contains an invalid file.");
    }
  };
  await walk(root);
}

export async function buildSiteAgentApp(rootPath: string): Promise<string> {
  const appRoot = path.join(path.resolve(rootPath), "astryx-app");
  const packagePath = path.join(appRoot, "package.json");
  const lockPath = path.join(appRoot, "package-lock.json");
  const packageStat = await fs.lstat(packagePath);
  const lockStat = await fs.lstat(lockPath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || !lockStat.isFile() || lockStat.isSymbolicLink()) {
    throw new Error("Astryx package manifest or lockfile is missing or unsafe.");
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-astryx-build-"));
  const isolatedRoot = path.join(temporaryRoot, "app");
  const buildHome = path.join(temporaryRoot, "home");
  await fs.mkdir(buildHome, { recursive: true, mode: 0o700 });
  try {
    await sourceDigests(appRoot); // Reject source symlinks before copying.
    await fs.cp(appRoot, isolatedRoot, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(appRoot, source);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return !BUILD_OUTPUT_ROOTS.has(first) && !source.endsWith(".tsbuildinfo");
      },
    });
    const before = await sourceDigests(isolatedRoot);
    const env = isolatedBuildEnv(buildHome);
    await runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], isolatedRoot, env);
    await runCommand("npm", ["run", "build"], isolatedRoot, env);
    const after = await sourceDigests(isolatedRoot);
    assertSameSources(before, after);
    const isolatedDist = path.join(isolatedRoot, "dist");
    await assertSafeDist(isolatedDist);
    const indexStat = await fs.lstat(path.join(isolatedDist, "index.html"));
    if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
      throw new Error("Astryx production build did not produce dist/index.html.");
    }
    const distRoot = path.join(appRoot, "dist");
    await fs.rm(distRoot, { recursive: true, force: true });
    await fs.cp(isolatedDist, distRoot, { recursive: true, errorOnExist: true });
    return distRoot;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function startStaticServer(distRoot: string): Promise<{ url: string; close: () => Promise<void> }> {
  const canonicalRoot = await fs.realpath(distRoot);
  const server = http.createServer(async (request, response) => {
    try {
      const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(parsed.pathname);
      const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      const candidate = path.resolve(canonicalRoot, relative);
      const containment = path.relative(canonicalRoot, candidate);
      if (!containment || containment.startsWith("..") || path.isAbsolute(containment)) {
        response.writeHead(404).end();
        return;
      }
      const canonicalFile = await fs.realpath(candidate);
      const realContainment = path.relative(canonicalRoot, canonicalFile);
      if (!realContainment || realContainment.startsWith("..") || path.isAbsolute(realContainment)) {
        response.writeHead(404).end();
        return;
      }
      const stat = await fs.lstat(canonicalFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType(canonicalFile),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(await fs.readFile(canonicalFile));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port for Astryx capture.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function captureSiteAgentAppThumbnail(rootPath: string, distRoot: string): Promise<string> {
  const server = await startStaticServer(distRoot);
  const window = new BrowserWindow({
    show: false,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  try {
    await window.loadURL(server.url);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const marker = await window.webContents.executeJavaScript(
      `Boolean(document.body?.dataset?.agentlasAgentApp && document.querySelector("#root")?.childElementCount)`,
      true,
    );
    if (!marker) throw new Error("Astryx app did not render its production root.");
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
    if (image.isEmpty()) throw new Error("Astryx app thumbnail capture was empty.");
    const artifactsRoot = path.join(path.resolve(rootPath), "artifacts");
    await fs.mkdir(artifactsRoot, { recursive: true });
    const thumbnailPath = path.join(artifactsRoot, "thumbnail.png");
    const temporaryPath = `${thumbnailPath}.tmp`;
    await fs.writeFile(temporaryPath, image.toPNG(), { mode: 0o600 });
    await fs.rename(temporaryPath, thumbnailPath);
    return thumbnailPath;
  } finally {
    if (!window.isDestroyed()) window.destroy();
    await server.close();
  }
}

export async function readSiteAgentAppThumbnail(projectId: string): Promise<SiteAgentAppThumbnailResult> {
  try {
    const project = getSiteProject(projectId);
    const thumbnail = project.agentAppArtifact?.thumbnail;
    if (project.surface !== "agent-app" || !thumbnail) throw new Error("Agent App thumbnail is not ready.");
    const allowedRoot = await fs.realpath(siteAgentAppsRoot());
    const appRoot = await fs.realpath(project.agentAppArtifact!.rootPath);
    const appRelative = path.relative(allowedRoot, appRoot);
    if (!appRelative || appRelative.startsWith("..") || path.isAbsolute(appRelative)) throw new Error("Agent App path is unsafe.");
    const thumbnailPath = await fs.realpath(thumbnail.path);
    const thumbnailRelative = path.relative(appRoot, thumbnailPath);
    if (!thumbnailRelative || thumbnailRelative.startsWith("..") || path.isAbsolute(thumbnailRelative)) throw new Error("Thumbnail path is unsafe.");
    const stat = await fs.lstat(thumbnailPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error("Thumbnail file is invalid.");
    const bytes = await fs.readFile(thumbnailPath);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Thumbnail is not a PNG.");
    }
    return {
      ok: true,
      projectId,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      updatedAt: thumbnail.updatedAt,
    };
  } catch (error) {
    return { ok: false, projectId, reason: error instanceof Error ? error.message : String(error) };
  }
}
