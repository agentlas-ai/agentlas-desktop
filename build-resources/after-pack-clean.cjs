const { access, readFile, readdir, rm } = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function removeAppleDoubleFiles(root) {
  let removed = 0;
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.pop();
    let entries;

    try {
      entries = await require("node:fs/promises").readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.name.startsWith("._")) {
        await rm(fullPath, { force: true, recursive: true });
        removed += 1;
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }

  return removed;
}

function isForbiddenRuntimePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const base = lowerParts.at(-1) ?? "";

  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/\.(?:pem|key|p12|p8|mobileprovision|jks|keystore|log|pyc|pyo)$/.test(base)) return true;
  if (base.startsWith("._")) return true;
  if ([".git", "signing", "credentials", ".memory.local", ".ontology-runtime", ".codex", "__pycache__"]
    .some((segment) => lowerParts.includes(segment))) return true;
  if (lowerParts[0] === ".agentlas") {
    const mutablePath = lowerParts.slice(1).join("/");
    if (/^(?:ontology-runtime\.sqlite|career-graph\.sqlite|experience-relations\.jsonl)/.test(mutablePath)) return true;
    if (/^\.experience-relations\.jsonl\./.test(mutablePath)) return true;
    if (/^field-test-report\./.test(mutablePath)) return true;
    if (mutablePath === "field-test" || mutablePath.startsWith("field-test/")) return true;
    if (mutablePath === "agent-ontology" || mutablePath.startsWith("agent-ontology/")) return true;
  }
  const claudeIndex = lowerParts.lastIndexOf(".claude");
  return claudeIndex >= 0 && /^settings(?:\..+)?\.local\.json$/.test(base);
}

async function findForbiddenRuntimePaths(root) {
  const found = [];
  const queue = [{ absolute: root, relative: "" }];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (isForbiddenRuntimePath(relative)) {
        found.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        queue.push({ absolute: path.join(current.absolute, entry.name), relative });
      }
    }
  }
  return found.sort();
}

async function verifyEmbeddedAgentlasOs(context) {
  const projectDir = context.packager?.projectDir || process.cwd();
  const productFilename = context.packager?.appInfo?.productFilename || "Agentlas";
  const resourcesDir = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const sourceManifestPath = path.join(projectDir, "Hephaestus", "manifest.json");
  const packagePath = path.join(projectDir, "package.json");
  const packagedRoot = path.join(resourcesDir, "Hephaestus");
  const packagedManifestPath = path.join(packagedRoot, "manifest.json");

  const [sourceManifest, packagedManifest, pkg] = await Promise.all([
    readFile(sourceManifestPath, "utf8").then(JSON.parse),
    readFile(packagedManifestPath, "utf8").then(JSON.parse),
    readFile(packagePath, "utf8").then(JSON.parse),
    access(path.join(packagedRoot, "agentlas_cloud", "__main__.py")),
  ]);
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semver.test(String(sourceManifest.version || ""))) {
    throw new Error(`[afterPack] invalid source Agentlas OS version: ${sourceManifest.version || "missing"}`);
  }
  if (packagedManifest.version !== sourceManifest.version) {
    throw new Error(
      `[afterPack] embedded Agentlas OS version mismatch: expected ${sourceManifest.version}, got ${packagedManifest.version || "missing"}`,
    );
  }
  const compatibilityVersion = pkg.agentlasUpdateCompatibility?.bundledRuntimeVersion;
  if (compatibilityVersion !== sourceManifest.version) {
    throw new Error(
      `[afterPack] update compatibility runtime mismatch: expected ${sourceManifest.version}, got ${compatibilityVersion || "missing"}`,
    );
  }
  if (process.env.HEPHAESTUS_REF) {
    const refMatch = process.env.HEPHAESTUS_REF.trim().match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    if (!refMatch || refMatch[1] !== sourceManifest.version) {
      throw new Error(
        `[afterPack] HEPHAESTUS_REF mismatch: expected v${sourceManifest.version}, got ${process.env.HEPHAESTUS_REF}`,
      );
    }
  }
  const forbiddenPaths = await findForbiddenRuntimePaths(packagedRoot);
  if (forbiddenPaths.length > 0) {
    const preview = forbiddenPaths.slice(0, 8).join(", ");
    const remainder = forbiddenPaths.length > 8 ? ` (+${forbiddenPaths.length - 8} more)` : "";
    throw new Error(`[afterPack] forbidden mutable Agentlas OS resources reached the package: ${preview}${remainder}`);
  }
  console.log(`[afterPack] verified embedded Agentlas OS v${packagedManifest.version} (${context.electronPlatformName})`);
}

exports.default = async function afterPackClean(context) {
  if (process.platform === "darwin" && context.electronPlatformName === "darwin") {
    try {
      await execFileAsync("/usr/bin/dot_clean", ["-m", context.appOutDir]);
    } catch {
      // dot_clean is best effort; recursive unlink below is the release gate.
    }

    const removed = await removeAppleDoubleFiles(context.appOutDir);
    if (removed > 0) {
      console.log(`[afterPack] removed ${removed} AppleDouble metadata files before code signing`);
    }
  }

  await verifyEmbeddedAgentlasOs(context);
};
