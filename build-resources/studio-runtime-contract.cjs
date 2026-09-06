const { lstat, readdir, readFile } = require("node:fs/promises");
const path = require("node:path");
const manifest = require("./studio-runtime-manifest.json");

const requiredFiles = Object.freeze([
  "manifest.json",
  manifest.ui_surface.launcher,
  manifest.initial_data,
  ...manifest.templates,
  manifest.ui_surface.path,
  "web/dist/favicon.svg",
  "web/dist/manifest.webmanifest",
]);

// Only Vite's flat, content-hashed executable assets may vary between builds.
// New resource kinds need an explicit contract and builder filter update.
function isAllowedStudioFile(relative) {
  return requiredFiles.includes(relative)
    || /^web\/dist\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(relative);
}

async function verifyStudioRuntime(root) {
  const files = [];
  const walk = async (relative) => {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`[afterPack] studio symlink forbidden: ${relative}`);
    if (stat.isDirectory()) {
      if (relative && !requiredFiles.some((file) => file.startsWith(`${relative}/`))
        && relative !== "web/dist/assets") {
        throw new Error(`[afterPack] studio directory outside allowlist: ${relative}`);
      }
      for (const child of await readdir(absolute)) await walk(relative ? `${relative}/${child}` : child);
    } else if (stat.isFile() && isAllowedStudioFile(relative)) {
      files.push(relative);
    } else {
      throw new Error(`[afterPack] studio file outside allowlist: ${relative}`);
    }
  };
  await walk("");
  for (const required of requiredFiles) {
    if (!files.includes(required)) throw new Error(`[afterPack] studio runtime missing: ${required}`);
  }
  const actualManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (JSON.stringify(actualManifest) !== JSON.stringify(manifest)) {
    throw new Error("[afterPack] studio runtime manifest differs from the Desktop contract");
  }
  // Check emitted HTML/CSS/JS imports against the copied tree without starting
  // Electron, a browser, the launcher, or a model provider.
  const dependencies = new Map();
  for (const file of files.filter((name) => /\.(?:html|css|js)$/.test(name))) {
    const text = await readFile(path.join(root, file), "utf8");
    const referenced = new Set();
    dependencies.set(file, referenced);
    const patterns = file.endsWith(".html")
      ? [/\b(?:src|href)=["']([^"']+)["']/g]
      : file.endsWith(".css")
        ? [/url\(\s*["']?([^"')\s]+)["']?\s*\)/g]
        : [/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g,
          /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g,
          /["'](assets\/[^"']+)["']/g];
    for (const reference of patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]))) {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) continue;
      if (file.endsWith(".js") && !reference.startsWith(".") && !reference.startsWith("/") && !reference.startsWith("assets/")) continue;
      const clean = reference.split(/[?#]/)[0];
      const target = clean.startsWith("assets/")
        ? path.posix.join("web/dist", clean)
        : clean.startsWith("/")
        ? path.posix.join("web/dist", clean.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
      referenced.add(target);
      if (!files.includes(target)) throw new Error(`[afterPack] studio asset reference missing: ${file} -> ${reference}`);
    }
  }
  const reachable = new Set(requiredFiles);
  const pending = [...requiredFiles];
  while (pending.length) {
    for (const dependency of dependencies.get(pending.pop()) || []) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }
  for (const file of files) {
    if (!reachable.has(file)) throw new Error(`[afterPack] studio asset is not referenced by the SPA: ${file}`);
  }
  return { files: files.sort() };
}

exports.requiredFiles = requiredFiles;
exports.isAllowedStudioFile = isAllowedStudioFile;
exports.verifyStudioRuntime = verifyStudioRuntime;
