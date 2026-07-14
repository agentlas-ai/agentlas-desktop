import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

const PYTHON_CACHE_RELATIVE = ["cache", "python-bytecode"];

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function applicationRoots(): string[] {
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(process.resourcesPath);
  try {
    roots.push(app.getAppPath());
  } catch {
    // Electron's app path is unavailable in isolated source-contract tests.
  }
  return roots;
}

/**
 * Resolve a per-user Python cache root that can never point inside the signed
 * application bundle. PYTHONDONTWRITEBYTECODE is the primary boundary; the
 * external prefix is defense in depth for child Python processes that clear
 * `sys.dont_write_bytecode` themselves.
 */
export function pythonCachePrefix(): string {
  let preferred: string | null = null;
  try {
    preferred = path.join(app.getPath("userData"), ...PYTHON_CACHE_RELATIVE);
  } catch {
    // Fall through to the process-scoped temp cache below.
  }

  const unsafe = preferred ? applicationRoots().some((root) => isInside(root, preferred!)) : true;
  const cacheRoot = !unsafe && preferred
    ? preferred
    : path.join(os.tmpdir(), "agentlas", `python-bytecode-${process.getuid?.() ?? "user"}`);

  try {
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  } catch {
    // Python is also forced not to write bytecode, so cache-directory creation
    // failure must not prevent the runtime itself from starting.
  }
  return cacheRoot;
}

/** Apply after every caller-provided env merge so local dotenv cannot weaken it. */
export function withPythonCacheBoundary(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: pythonCachePrefix(),
  };
}
