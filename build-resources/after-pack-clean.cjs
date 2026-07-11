const { access, readFile, rm } = require("node:fs/promises");
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

async function verifyEmbeddedAgentlasOs(context) {
  const projectDir = context.packager?.projectDir || process.cwd();
  const productFilename = context.packager?.appInfo?.productFilename || "Agentlas";
  const resourcesDir = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const sourceManifestPath = path.join(projectDir, "Hephaestus", "manifest.json");
  const packagedRoot = path.join(resourcesDir, "Hephaestus");
  const packagedManifestPath = path.join(packagedRoot, "manifest.json");

  const [sourceManifest, packagedManifest] = await Promise.all([
    readFile(sourceManifestPath, "utf8").then(JSON.parse),
    readFile(packagedManifestPath, "utf8").then(JSON.parse),
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
