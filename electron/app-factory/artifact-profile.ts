import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactBuildProfile } from "../../shared/artifact-build";
import { resolveManagedNodeRuntimeAsync, type ManagedNodeRuntime } from "../runtime/managed-node";
import { userDataPath } from "../runtime-paths";
import lock from "./astryx-lock/package-lock.json";
import { artifactBytesDigest, pathInsideArtifact } from "./artifact-files";

// This fixed compiler never loads artifact-authored Vite/Babel/PostCSS config or npm scripts.
const COMPILER = String.raw`import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
const [declaredRoot, outDir] = process.argv.slice(2);
const root = fs.realpathSync(declaredRoot);
const deps = fs.realpathSync(new URL('./node_modules', import.meta.url));
const inside = (base, file) => { const rel = path.relative(base, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
await build({ root, configFile: false, envFile: false, base: './', publicDir: 'public',
  server:{fs:{allow:[root,deps]}},
  plugins: [{name:'agentlas-import-boundary',enforce:'pre',
    load(id) {
      const file = id.split('?')[0];
      if (file.startsWith('\0')) return null;
      if (file.startsWith('node:') || file.startsWith('__vite-browser-external')) throw Error('artifact_node_import_refused');
      if (path.isAbsolute(file)) {
        const real = fs.realpathSync(file);
        if (!inside(root, real) && !inside(deps, real)) throw Error('artifact_import_outside_snapshot');
      }
      return null;
    }
  },react({babel:{babelrc:false,configFile:false}})],
  css: {postcss:{plugins:[]}},
  build:{outDir,emptyOutDir:true,sourcemap:false,reportCompressedSize:false,chunkSizeWarningLimit:2000},
  logLevel:'warn'
});
`;
const COMPILER_POLICY = "node-permission:read-source-cache-output:write-output:trusted-esbuild-child:trusted-rollup-addon:v1";
const TYPESCRIPT_CONFIG = {compilerOptions:{target:"ES2022",module:"ESNext",moduleResolution:"Bundler",jsx:"react-jsx",isolatedModules:true,skipLibCheck:true},include:["**/*.ts","**/*.tsx"]};

export function artifactBuildProfile(kind: ArtifactBuildProfile["id"], nodeVersion = "none"): ArtifactBuildProfile {
  const fields = {
    schemaVersion: "agentlas.artifact-build-profile.v1" as const, id: kind,
    dependencyLockDigest: kind === "html-static-v1" ? null : artifactBytesDigest(JSON.stringify(lock)),
    compilerDigest: artifactBytesDigest(kind === "html-static-v1" ? "agentlas-copy-immutable-v1" : `${COMPILER}\n${JSON.stringify(TYPESCRIPT_CONFIG)}\n${COMPILER_POLICY}\nnode=${nodeVersion}`),
    platform: process.platform, arch: process.arch,
  };
  return { ...fields, profileDigest: artifactBytesDigest(JSON.stringify(fields)) };
}

async function treeDigest(root: string): Promise<string> {
  root = await fs.realpath(root);
  const records: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (dir === root && name === "profile-receipt.json") continue;
      const file = path.join(dir, name), stat = await fs.lstat(file), rel = path.relative(root, file);
      if (stat.isSymbolicLink()) {
        if (!pathInsideArtifact(root, await fs.realpath(file))) throw new Error("artifact_profile_link_escape");
        records.push(`L\0${rel}\0${await fs.readlink(file)}`);
      } else if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) records.push(`F\0${rel}\0${artifactBytesDigest(await fs.readFile(file))}`);
      else throw new Error("artifact_profile_file_invalid");
    }
  };
  await walk(root);
  return artifactBytesDigest(records.join("\n"));
}

async function freezeTree(root: string): Promise<void> {
  for (const name of await fs.readdir(root)) {
    const file = path.join(root, name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await freezeTree(file);
    else await fs.chmod(file, stat.mode & 0o111 ? 0o500 : 0o400);
  }
  await fs.chmod(root, 0o500);
}

/** The child receives only build-specific paths; no account tokens, NODE_OPTIONS or user npm config. */
export async function runArtifactCompilerChild(runtime: ManagedNodeRuntime, args: string[], cwd: string,
  signal?: AbortSignal, timeoutMs = 90_000): Promise<void> {
  signal?.throwIfAborted();
  const temporary = userDataPath("artifact-build", "temporary");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(temporary, "empty-npmrc"), "", { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.node, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: path.dirname(runtime.node), TMPDIR: temporary, TEMP: temporary, TMP: temporary,
        ...(process.platform === "win32" && process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
        NODE_ENV: "production", NPM_CONFIG_USERCONFIG: path.join(temporary, "empty-npmrc"),
        NPM_CONFIG_CACHE: userDataPath("artifact-build", "npm-cache"),
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
    });
    let output = "", cause: Error | undefined;
    const collect = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-8_000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const stop = () => {
      if (process.platform !== "win32" && child.pid) {try {process.kill(-child.pid,"SIGKILL");return;}catch{}}
      child.kill("SIGKILL");
    };
    const abort = () => { cause = new Error("artifact_build_cancelled"); stop(); };
    const timer = setTimeout(() => { cause = new Error("artifact_build_timeout"); stop(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (cause) reject(cause);
      else if (code !== 0) reject(new Error(`artifact_build_failed: ${output.trim() || code}`));
      else resolve();
    });
  });
}

const preparations = new Map<string, Promise<string>>();
async function prepareProfile(runtime: ManagedNodeRuntime, profile: ArtifactBuildProfile, signal?: AbortSignal): Promise<string> {
  const cache = userDataPath("artifact-build", "profiles", profile.profileDigest);
  const inFlight = preparations.get(cache);
  if (inFlight) return inFlight.catch((error) => {
    if (!signal?.aborted && error instanceof Error && error.message === "artifact_build_cancelled") return prepareProfile(runtime,profile,signal);
    throw error;
  });
  const work = (async () => {
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(cache, "profile-receipt.json"), "utf8"));
      if (receipt.profileDigest !== profile.profileDigest || receipt.treeDigest !== await treeDigest(cache)) {
        throw new Error("artifact_profile_cache_changed");
      }
      return cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An incomplete directory is preserved for diagnosis; it cannot become a trusted cache.
      try { await fs.lstat(cache); throw new Error("artifact_profile_cache_incomplete"); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
    }
    const staging = `${cache}.${randomUUID()}.pending`;
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const base = lock.packages[""];
      await fs.writeFile(path.join(staging, "package.json"), JSON.stringify({ ...base, private: true, type: "module" }));
      await fs.writeFile(path.join(staging, "package-lock.json"), JSON.stringify(lock));
      await fs.writeFile(path.join(staging, "compile.mjs"), COMPILER);
      await runArtifactCompilerChild(runtime, [runtime.npmCli, "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], staging, signal, 180_000);
      await fs.writeFile(path.join(staging, "profile-receipt.json"), JSON.stringify({profileDigest: profile.profileDigest, treeDigest: await treeDigest(staging)}));
      signal?.throwIfAborted();
      await fs.rename(staging, cache);
      await freezeTree(cache);
      return cache;
    } catch (error) { await fs.rm(staging, {recursive:true,force:true}).catch(() => {}); throw error; }
  })().finally(() => preparations.delete(cache));
  preparations.set(cache, work);
  return work;
}

export async function compileReactArtifact(source: string, output: string, signal?: AbortSignal): Promise<ArtifactBuildProfile> {
  const resolution = await resolveManagedNodeRuntimeAsync({ signal });
  if (!resolution.ok) throw new Error(`artifact_node_unavailable: ${resolution.reason}`);
  const profile = artifactBuildProfile("astryx-react-19-v1", resolution.runtime.version);
  const cache = await prepareProfile(resolution.runtime, profile, signal);
  signal?.throwIfAborted();
  const canonicalCache = await fs.realpath(cache), canonicalSource = await fs.realpath(source);
  await fs.symlink(path.join(canonicalCache, "node_modules"), path.join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  // Avoid the host project's package scope and compiler settings.
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({private:true,type:"module"}), {flag:"wx"});
  await fs.writeFile(path.join(source, "tsconfig.json"), JSON.stringify(TYPESCRIPT_CONFIG), {flag:"wx"});
  await fs.mkdir(output,{recursive:true,mode:0o700});
  const canonicalOutput = await fs.realpath(output);
  const reads = [canonicalSource,canonicalCache,canonicalOutput];
  const writes = [canonicalOutput];
  const permissionArgs = ["--permission",...reads.map(file=>`--allow-fs-read=${file}`),...writes.map(file=>`--allow-fs-write=${file}`),"--allow-child-process","--allow-addons"];
  try { await runArtifactCompilerChild(resolution.runtime, [...permissionArgs,path.join(canonicalCache, "compile.mjs"), canonicalSource, canonicalOutput], canonicalCache, signal); }
  finally { await fs.unlink(path.join(source, "node_modules")).catch(() => {}); }
  return profile;
}
