const { access, lstat, readFile, readdir, rm } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MODEL2VEC_ASSET_PARTS = ["assets", "model2vec", "potion-base-8M-int8"];
const MODEL2VEC_REQUIRED_FILES = [
  "embeddings.i8",
  "scales.f32le",
  "tokenizer.json",
  "LICENSE.model.txt",
];
const MODEL2VEC_ASSET_FORMAT = "agentlas-model2vec-int8-v1";

function model2VecContentIdentity(files) {
  const digest = createHash("sha256");
  for (const name of [...MODEL2VEC_REQUIRED_FILES].sort()) {
    const record = files[name];
    digest.update(name).update("\0").update(record.sha256).update("\0")
      .update(String(record.size)).update("\n");
  }
  return digest.digest("hex");
}

async function verifyModel2VecAsset(assetRoot, label) {
  try {
    const rootStat = await lstat(assetRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("not a regular directory");
  } catch (error) {
    throw new Error(`[afterPack] ${label} Model2Vec asset directory missing or invalid: ${assetRoot}`, { cause: error });
  }
  const manifestPath = path.join(assetRoot, "manifest.json");
  let manifest;
  let manifestSha256;
  try {
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("not a regular file");
    const manifestText = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(manifestText);
    manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
  } catch (error) {
    throw new Error(`[afterPack] ${label} Model2Vec manifest missing or invalid: ${manifestPath}`, { cause: error });
  }
  if (manifest.format !== MODEL2VEC_ASSET_FORMAT) {
    throw new Error(`[afterPack] ${label} Model2Vec format mismatch: ${manifest.format || "missing"}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(manifest.contentSha256 || ""))) {
    throw new Error(`[afterPack] ${label} Model2Vec contentSha256 missing or invalid`);
  }
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error(`[afterPack] ${label} Model2Vec manifest files missing or invalid`);
  }

  for (const name of MODEL2VEC_REQUIRED_FILES) {
    const record = manifest.files[name];
    const filePath = path.join(assetRoot, name);
    if (!record || !/^[0-9a-f]{64}$/.test(String(record.sha256 || ""))
      || !Number.isInteger(record.size) || record.size < 0) {
      throw new Error(`[afterPack] ${label} Model2Vec manifest record missing or invalid: ${name}`);
    }
    let payload;
    try {
      const payloadStat = await lstat(filePath);
      if (!payloadStat.isFile() || payloadStat.isSymbolicLink()) throw new Error("not a regular file");
      payload = await readFile(filePath);
    } catch (error) {
      throw new Error(`[afterPack] ${label} Model2Vec asset missing: ${name}`, { cause: error });
    }
    if (payload.length !== record.size) {
      throw new Error(`[afterPack] ${label} Model2Vec asset size mismatch: ${name}`);
    }
    const actualSha256 = createHash("sha256").update(payload).digest("hex");
    if (actualSha256 !== record.sha256) {
      throw new Error(`[afterPack] ${label} Model2Vec asset checksum mismatch: ${name}`);
    }
  }

  const contentSha256 = model2VecContentIdentity(manifest.files);
  if (contentSha256 !== manifest.contentSha256) {
    throw new Error(`[afterPack] ${label} Model2Vec contentSha256 mismatch`);
  }
  return { contentSha256, manifestPath, manifestSha256 };
}

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
  const sourceModel = await verifyModel2VecAsset(
    path.join(projectDir, "Hephaestus", ...MODEL2VEC_ASSET_PARTS),
    "source",
  );
  const packagedModel = await verifyModel2VecAsset(
    path.join(packagedRoot, ...MODEL2VEC_ASSET_PARTS),
    "packaged",
  );
  if (packagedModel.contentSha256 !== sourceModel.contentSha256) {
    throw new Error(
      `[afterPack] packaged Model2Vec content drift: expected ${sourceModel.contentSha256}, got ${packagedModel.contentSha256}`,
    );
  }
  if (packagedModel.manifestSha256 !== sourceModel.manifestSha256) {
    throw new Error(
      `[afterPack] packaged Model2Vec manifest drift: expected ${sourceModel.manifestSha256}, got ${packagedModel.manifestSha256}`,
    );
  }
  const forbiddenPaths = await findForbiddenRuntimePaths(packagedRoot);
  if (forbiddenPaths.length > 0) {
    const preview = forbiddenPaths.slice(0, 8).join(", ");
    const remainder = forbiddenPaths.length > 8 ? ` (+${forbiddenPaths.length - 8} more)` : "";
    throw new Error(`[afterPack] forbidden mutable Agentlas OS resources reached the package: ${preview}${remainder}`);
  }
  console.log(
    `[afterPack] verified embedded Agentlas OS v${packagedManifest.version} `
      + `with Model2Vec ${packagedModel.contentSha256} (${context.electronPlatformName})`,
  );
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
