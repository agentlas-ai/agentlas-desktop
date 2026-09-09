// Private snapshot-only, demand-driven TypeScript emit. Never consult live dist.
// This is transpilation for runtime gates, not a substitute for type checking.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const childProcess = require("node:child_process");
const { fileURLToPath } = require("node:url");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".agentlas-index-gates.json"), "utf8"));
if (fs.realpathSync(root) !== receipt.root || fs.existsSync(path.join(root, ".git"))) throw new Error("COMPILE_REQUIRES_INDEX_SNAPSHOT");
// Reject accidental absolute-path fallbacks into the live checkout. Dependencies
// are the sole declared exception and may only be read, never installed/rebuilt.
// These guards catch common synchronous mistakes; this is not an OS sandbox.
// Only trusted, hash-pinned verifiers may run here.
const realpath = fs.realpathSync;
const exists = fs.existsSync;
function guard(filename, write = false) {
  if (filename instanceof URL) filename = fileURLToPath(filename);
  if (typeof filename !== "string" && !Buffer.isBuffer(filename)) return;
  const requested = path.resolve(String(filename));
  let parent = requested;
  while (!exists(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
  // Resolve the nearest existing parent too: a new file beneath node_modules
  // must not bypass the check merely because the leaf does not exist yet.
  const absolute = path.resolve(realpath(parent), path.relative(parent, requested));
  const live = absolute === receipt.sourceRoot || absolute.startsWith(`${receipt.sourceRoot}${path.sep}`);
  const dependency = receipt.dependencies.some((item) => [item.source, path.join(root, item.path)]
    .some((base) => absolute === base || absolute.startsWith(`${base}${path.sep}`)));
  if ((live && !dependency) || (write && dependency)) throw new Error(`LIVE_REPOSITORY_ACCESS_FORBIDDEN: ${absolute}`);
}
const open = fs.openSync;
fs.openSync = function (filename, flags, ...args) {
  const writes = typeof flags === "string" ? /[wa+]/.test(flags)
    : Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
  guard(filename, writes);
  return open.call(this, filename, flags, ...args);
};
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync"]) {
  const original = fs[name];
  const wrapped = function (filename, ...args) { guard(filename); return original.call(this, filename, ...args); };
  Object.assign(wrapped, original);
  fs[name] = wrapped;
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "chmodSync", "truncateSync"]) {
  const original = fs[name];
  fs[name] = function (filename, ...args) { guard(filename, true); return original.call(this, filename, ...args); };
}
const indexed = new Map(receipt.files.map((file) => [file.name, file]));
const dist = path.join(root, "dist");
// The builtin-plugin degradation gate intentionally removes dist/plugins to
// prove that the host tolerates missing manifests. Re-emitting an indexed
// manifest while its probe runs would both defeat that assertion and make the
// gate's parked-directory restore collide with the recreated directory.
const disablePluginCompile = process.env.AGENTLAS_INDEX_GATE_DISABLE_PLUGIN_COMPILE === "1";
const artifacts = [];
let ts;
let options;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function readIndexed(name) {
  const file = indexed.get(name);
  if (!file) throw new Error(`COMPILE_SOURCE_NOT_INDEXED: ${name}`);
  const data = fs.readFileSync(path.join(root, name));
  if (blob(data) !== file.oid) throw new Error(`COMPILE_SOURCE_CHANGED: ${name}`);
  return data;
}
function compile(target) {
  if (!target.startsWith(`${dist}${path.sep}`)) return false;
  const relative = path.relative(dist, target).split(path.sep).join("/");
  if (disablePluginCompile && relative.startsWith("plugins/")) return false;
  if (!/^(electron|shared|plugins)\//.test(relative)) return false;
  const candidates = /\.(?:js|json|cjs|mjs)$/.test(relative)
    ? [relative.replace(/\.js$/, ".ts"), relative] : [`${relative}.ts`, `${relative}/index.ts`, `${relative}.json`];
  const source = candidates.find((name) => indexed.has(name));
  if (!source) return false;
  const bytes = readIndexed(source);
  let output = bytes;
  const destination = path.join(dist, source.replace(/\.ts$/, ".js"));
  if (source.endsWith(".ts")) {
    ts ||= require("typescript");
    if (!options) {
      const config = ts.parseConfigFileTextToJson("electron/tsconfig.json", readIndexed("electron/tsconfig.json").toString());
      if (config.error || config.config.extends || config.config.references) throw new Error("UNSUPPORTED_INDEXED_TSCONFIG");
      const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, path.join(root, "electron"));
      if (converted.errors.length || converted.options.module !== ts.ModuleKind.CommonJS) throw new Error("UNSUPPORTED_INDEXED_TSCONFIG");
      options = { ...converted.options, sourceMap: false, declaration: false, incremental: false };
    }
    const result = ts.transpileModule(bytes.toString(), { compilerOptions: options, fileName: path.join(root, source), reportDiagnostics: true });
    const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) || [];
    if (errors.length) throw new Error(`INDEXED_TS_EMIT_FAILED: ${source} (${errors.map((item) => `TS${item.code}`).join(",")})`);
    output = Buffer.from(result.outputText);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, output);
  artifacts.push({ source, sourceBlob: indexed.get(source).oid, sourceSha256: hash(bytes), output: path.relative(root, destination), outputSha256: hash(output) });
  return true;
}

// Gate contracts frequently fork a fresh Node/Electron worker.  The preload
// hook is process-local, so without propagation those workers fall back to the
// live checkout or see an empty snapshot dist.  Carry the same adapter only to
// Node-like children whose cwd remains inside this private snapshot; external
// tools and dependencies keep their original environment.
function childOptions(options, command, args = []) {
  const cwd = path.resolve(options?.cwd || process.cwd());
  if (!(cwd === root || cwd.startsWith(`${root}${path.sep}`))) return options;
  const executable = typeof command === "string" ? path.basename(command).toLowerCase() : "";
  const nodeLike = command === process.execPath || executable === "node" || executable.startsWith("node-")
    || executable === "electron" || executable.startsWith("electron-");
  if (!nodeLike) return options;
  const firstArg = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "";
  const childScript = firstArg && !firstArg.startsWith("-") ? path.resolve(cwd, firstArg) : null;
  // Gate workers are often created in os.tmpdir() and point at an external
  // Terminal shim.  They already use compiled snapshot paths; injecting this
  // resolver into them would make their own relative imports look like index
  // misses.  Propagate only to workers whose entrypoint is in this snapshot
  // (or eval workers, which have no file path to classify).
  if (childScript && !(childScript === root || childScript.startsWith(`${root}${path.sep}`))) return options;
  const env = { ...process.env, ...(options?.env || {}) };
  const flag = `--require=${__filename}`;
  const existing = typeof env.NODE_OPTIONS === "string" ? env.NODE_OPTIONS : "";
  if (!existing.split(/\s+/).includes(flag) && !existing.includes(__filename)) {
    env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;
  }
  return { ...(options || {}), env };
}

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function stagedSnapshotSpawnSync(command, args, options) {
  return originalSpawnSync.call(this, command, args, childOptions(options, command, args));
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = function stagedSnapshotSpawn(command, args, options) {
  return originalSpawn.call(this, command, args, childOptions(options, command, args));
};
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function stagedSnapshotExecFileSync(command, args, options) {
  return originalExecFileSync.call(this, command, args, childOptions(options, command, args));
};
const originalExecFile = childProcess.execFile;
childProcess.execFile = function stagedSnapshotExecFile(command, args, options, callback) {
  if (typeof args === "function") return originalExecFile.call(this, command, args);
  if (typeof options === "function") return originalExecFile.call(this, command, args, options);
  return originalExecFile.call(this, command, args, childOptions(options, command, args), callback);
};
const originalFork = childProcess.fork;
childProcess.fork = function stagedSnapshotFork(modulePath, args, options) {
  return originalFork.call(this, modulePath, args, childOptions(options, process.execPath, [modulePath]));
};
const originalExecSync = childProcess.execSync;
childProcess.execSync = function stagedSnapshotExecSync(command, options) {
  return originalExecSync.call(this, command, childOptions(options, process.execPath));
};
// Gates that test existsSync before require need their explicit roots up front.
// Unknown/dynamic roots are not silently skipped: unresolved dependencies fail.
const earlyRoots = {
  "scripts/test-core-call-liveness-and-auth.cjs": ["electron/hephaestus/commands.js"],
  "scripts/test-refusal-not-output-contract.cjs": ["electron/mcp/client.js", "electron/mcp/final-display-backstop.js", "electron/runtime/runtime-refusal.js"],
  "scripts/test-final-display-hygiene.cjs": ["electron/mcp/final-display-backstop.js", "electron/runtime/runtime-refusal.js"],
};
// Eval/print workers have no script argv; stdin uses "-". They still need the
// resolver and integrity guards below, but have no named gate's early roots.
const entry = process.argv[1];
const gate = typeof entry === "string" && entry !== "-"
  ? path.relative(root, path.resolve(entry)).split(path.sep).join("/") : "";
for (const name of earlyRoots[gate] || []) {
  if (!compile(path.join(dist, name))) throw new Error(`INDEX_BUILD_ROOT_MISSING: ${name}`);
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith(".") || path.isAbsolute(request)) guard(path.resolve(parent?.filename ? path.dirname(parent.filename) : root, request));
  try {
    const resolved = originalResolve.call(this, request, parent, ...rest);
    if (path.isAbsolute(resolved)) guard(resolved);
    return resolved;
  }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || !(request.startsWith(".") || path.isAbsolute(request))) throw error;
    const candidate = path.resolve(parent?.filename ? path.dirname(parent.filename) : root, request);
    if (compile(candidate)) return originalResolve.call(this, request, parent, ...rest);
    // Some trusted CJS gates transpile their entry with a source .ts filename.
    // Its relative runtime imports still need indexed emission, not an npx
    // cache loader or a fallback into live source/dist.
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    if (/^(electron|shared|plugins)\//.test(relative)) {
      const emitted = path.join(dist, relative);
      if (compile(emitted)) return originalResolve.call(this, emitted, parent, ...rest);
    }
    throw error;
  }
};
process.on("exit", () => {
  fs.writeFileSync(path.join(root, `.agentlas-index-build-${process.pid}.json`), JSON.stringify({
    tree: receipt.tree, gate, command: process.argv, compiler: ts?.version ?? null,
    operation: "TypeScript.transpileModule; indexed CommonJS options; demand-driven dist only", artifacts,
  }));
});
