import fs from "node:fs";
import path from "node:path";

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Bind npm children to the selected installation, never the bundled Node. */
export function cliSelfUpdateEnv(binary: string, packageName: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const realBinary = fs.realpathSync(binary);
  const resources = process.resourcesPath ? fs.realpathSync(process.resourcesPath) : null;
  const forbidden = (value: string) => /(?:^|[\\/])[^\\/]+\.app(?:[\\/]|$)/i.test(value)
    || (resources !== null && within(value, resources));
  if (forbidden(binary) || forbidden(realBinary)) throw new Error("CLI update cannot modify a signed app bundle");
  let prefix: string | null = null;
  let directory = path.dirname(realBinary);
  for (let depth = 0; depth < 12 && path.dirname(directory) !== directory; depth++) {
    let name: unknown;
    try { name = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).name; }
    catch { /* This ancestor is not an npm package. */ }
    if (name === packageName) {
      const modules = packageName.startsWith("@") ? path.dirname(path.dirname(directory)) : path.dirname(directory);
      if (path.basename(modules) !== "node_modules") break;
      const parent = path.dirname(modules);
      prefix = process.platform === "win32" ? parent : path.basename(parent) === "lib" ? path.dirname(parent) : null;
      break;
    }
    directory = path.dirname(directory);
  }
  // Native installations use their own updater. Constrain any npm child to
  // their existing bin prefix without changing which executable is selected.
  if (!prefix) {
    const descriptor = fs.openSync(realBinary, "r");
    const header = Buffer.alloc(4);
    try { fs.readSync(descriptor, header, 0, 4, 0); } finally { fs.closeSync(descriptor); }
    const magic = header.toString("hex");
    const native = ["cffaedfe", "cefaedfe", "feedface", "feedfacf", "cafebabe", "bebafeca", "7f454c46"].includes(magic)
      || header.subarray(0, 2).toString() === "MZ";
    const binDir = path.dirname(binary);
    if (native) prefix = process.platform === "win32" ? binDir : path.basename(binDir) === "bin" ? path.dirname(binDir) : null;
  }
  if (!prefix) throw new Error("Selected CLI update location is unknown; use this CLI's own installer");
  const realPrefix = fs.realpathSync(prefix);
  if (forbidden(prefix) || forbidden(realPrefix)) throw new Error("CLI update prefix cannot be inside a signed app bundle");
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "npm_config_prefix") delete env[key];
  }
  return { ...env, NPM_CONFIG_PREFIX: prefix, npm_config_prefix: prefix };
}
