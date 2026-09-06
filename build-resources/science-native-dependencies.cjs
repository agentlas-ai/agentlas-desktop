"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const tar = require("tar");

// npm ci installs optional dependencies for its host CPU. A second architecture
// packaged from the same checkout needs its own Sharp binary and libvips too.
// Fetch only the exact lockfile artifacts; never resolve or rewrite dependencies.
async function prepareScienceNativeDependencies(projectDir, platform, arch) {
  if (!["darwin:arm64", "darwin:x64", "linux:x64", "win32:x64", "win32:arm64"].includes(`${platform}:${arch}`)) {
    throw new Error(`science-native-target-unsupported:${platform}:${arch}`);
  }
  const lock = JSON.parse(await fs.readFile(path.join(projectDir, "package-lock.json"), "utf8"));
  const names = [`@img/sharp-${platform}-${arch}`];
  if (platform !== "win32") names.push(`@img/sharp-libvips-${platform}-${arch}`);
  const prepared = [];
  for (const name of names) {
    const record = lock.packages?.[`node_modules/${name}`];
    if (!record?.version || !/^sha512-[A-Za-z0-9+/]+=*$/.test(record.integrity ?? "")) {
      throw new Error(`science-native-lock-missing:${name}`);
    }
    const url = new URL(record.resolved);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password) {
      throw new Error(`science-native-registry-invalid:${name}`);
    }
    const target = path.join(projectDir, "node_modules", name);
    let installed;
    try { installed = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (installed) {
      if (installed.name !== name || installed.version !== record.version) {
        throw new Error(`science-native-installed-version-mismatch:${name}`);
      }
      prepared.push({ name, version: record.version, downloaded: false });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const stage = await fs.mkdtemp(path.join(path.dirname(target), ".agentlas-sharp-"));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (!response.ok) throw new Error(`science-native-download-failed:${name}:${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      if (actual !== record.integrity) throw new Error(`science-native-integrity-mismatch:${name}`);
      const archive = path.join(stage, "package.tgz");
      const extracted = path.join(stage, "extracted");
      await fs.writeFile(archive, bytes);
      await fs.mkdir(extracted);
      await tar.x({ file: archive, cwd: extracted, strip: 1, filter(file, entry) {
        if (!file.startsWith("package/") || file.split("/").includes("..") || /[\\\0]/.test(file)
          || entry.type === "SymbolicLink" || entry.type === "Link") {
          throw new Error(`science-native-archive-entry-invalid:${name}`);
        }
        return true;
      } });
      const manifest = JSON.parse(await fs.readFile(path.join(extracted, "package.json"), "utf8"));
      if (manifest.name !== name || manifest.version !== record.version) {
        throw new Error(`science-native-archive-identity-mismatch:${name}`);
      }
      await fs.rename(extracted, target);
      prepared.push({ name, version: record.version, downloaded: true });
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  return prepared;
}

module.exports = { prepareScienceNativeDependencies };
