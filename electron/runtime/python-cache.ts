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

/**
 * Whether this interpreter is the one we ship, and therefore brings its own
 * libraries.
 *
 * Only a bundled interpreter may ignore the user's site-packages. A system
 * Python resolved from PATH is the user's, and its `jsonschema` almost certainly
 * lives in exactly the `~/.local` directory we would be hiding — cutting it off
 * would break the very check we are trying to make work.
 */
function isBundledInterpreter(pythonPath: string): boolean {
  const resolved = path.resolve(pythonPath);
  return applicationRoots().some((root) => isInside(root, resolved))
    || resolved.includes(`${path.sep}build-resources${path.sep}python-runtime${path.sep}`);
}

/**
 * Env for spawning a specific interpreter: the cache boundary, plus user-site
 * isolation when the interpreter is ours.
 *
 * Measured 2026-08-17: the bundled 3.12 runtime shipped no `jsonschema` of its
 * own and silently borrowed the user's `~/.local` copy. On this machine that
 * copy carried an x86_64 `rpds`, so `import jsonschema` died on an architecture
 * mismatch and every package build reported "schema validation unavailable"
 * blockers the user had no way to act on. The runtime now ships the dependency
 * and stops reading someone else's.
 */
export function withPythonRuntimeBoundary(
  pythonPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base = withPythonCacheBoundary(env);
  return isBundledInterpreter(pythonPath) ? { ...base, PYTHONNOUSERSITE: "1" } : base;
}
