const { access, chmod, lstat, readFile, readdir, readlink, realpath, rm, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const embeddedCoreContract = require("./embedded-core-contract.cjs");
const { verifyStudioRuntime } = require("./studio-runtime-contract.cjs");
const {
  verifyProductExtensionSigningPolicyFile,
} = require("./product-extension-signing-policy.cjs");

const execFileAsync = promisify(execFile);
const MODEL2VEC_ASSET_PARTS = ["assets", "model2vec", "potion-multilingual-128M-int8"];
const MODEL2VEC_REQUIRED_FILES = [
  "scales.f32le",
  "tokenizer.json",
  "LICENSE.model.txt",
];
const MODEL2VEC_ASSET_FORMAT = "agentlas-model2vec-int8-v1";
const MODEL2VEC_CONTENT_SHA256 = "aa806dbd4c6025f47b0242f8b92eb789109a0c612524980eb905fda3b5b73bde";
const MODEL2VEC_ORDERED_PARTS = [
  {
    name: "embeddings.i8.part-000",
    sha256: "e41c2cd2bf7f77925d5f6162242f22d31e731c4daec44adc4d71fbe27d51ac36",
    size: 67_108_864,
  },
  {
    name: "embeddings.i8.part-001",
    sha256: "2720f905f4959b0067e875b38cbb70b72ab2107ec5026899294c700146439f3f",
    size: 60_981_504,
  },
];
const MODEL2VEC_ORDERED_PARTS_SHA256 = "4d0382e963f7fd099b4f7be64c004c5772c4962662ce9af2cf76b7a19a114e91";
const PYTHON_RUNTIME_VERSION = "3.12.13";
const PYTHON_RUNTIME_RELEASE = "20260510";
const PYTHON_RUNTIME_ASSETS = {
  "aarch64-apple-darwin": {
    archiveName: "cpython-3.12.13+20260510-aarch64-apple-darwin-install_only.tar.gz",
    archiveSha256: "5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17",
    executableRelativePath: "bin/python3",
  },
  "x86_64-apple-darwin": {
    archiveName: "cpython-3.12.13+20260510-x86_64-apple-darwin-install_only.tar.gz",
    archiveSha256: "cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894",
    executableRelativePath: "bin/python3",
  },
  "x86_64-pc-windows-msvc": {
    archiveName: "cpython-3.12.13+20260510-x86_64-pc-windows-msvc-install_only.tar.gz",
    archiveSha256: "346dfbcb95171dd6d1275e6f8cb2e656cc15cb054c399ae54db57bfad4b1a60f",
    executableRelativePath: "python.exe",
  },
  "x86_64-unknown-linux-gnu": {
    archiveName: "cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only.tar.gz",
    archiveSha256: "e7332b4b4bb85006deb48d251c786a04c14de104c9b3a006b33457a4a604b8bc",
    executableRelativePath: "bin/python3",
  },
};
const NODE_RUNTIME_VERSION = "24.18.0";
const NODE_RUNTIME_ASSETS = {
  "win32:x64": {
    archiveName: "node-v24.18.0-win-x64.zip",
    archiveSha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    nodeSha256: "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
    npmCliSha256: "3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e",
    runtimeTreeSha256: "ced095085eece2e24bb5fe957ab94253b6983729f66df9e112b79d5144116eb6",
  },
  "win32:arm64": {
    archiveName: "node-v24.18.0-win-arm64.zip",
    archiveSha256: "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
    nodeSha256: "c7225670c3f477778e18c43a55867f7a0d76468221245e5981ab80eb953c8102",
    npmCliSha256: "3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e",
    runtimeTreeSha256: "893e18bdab084c0af59c27eb8573f2bd3d2917b76919336efe97f9440039fb97",
  },
  "darwin:arm64": {
    archiveName: "node-v24.18.0-darwin-arm64.tar.gz",
    archiveSha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    nodeSha256: "ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a",
    npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    runtimeTreeSha256: "26d8a5de52cfe628bb3763366380991f417137967bcc211098552026f6dfe92b",
  },
  "darwin:x64": {
    archiveName: "node-v24.18.0-darwin-x64.tar.gz",
    archiveSha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    nodeSha256: "c5afe80c9fd47c0e1ba3a7221173d061dae04577acc67e21e945d16e34c696c8",
    npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    runtimeTreeSha256: "1e6949b832796ae46e994760086155fd3e7ee73ab7c03616c02748a5f17209c8",
  },
};

/** 플랫폼별 실행 파일 위치. 윈도우는 루트에, 맥은 bin/·lib/ 밑에 있다. */
function nodeRuntimeLayout(platform) {
  return platform === "win32"
    ? { node: "node.exe", npmCli: "node_modules/npm/bin/npm-cli.js" }
    : { node: "bin/node", npmCli: "lib/node_modules/npm/bin/npm-cli.js" };
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function model2VecContentIdentity(files, names) {
  const digest = createHash("sha256");
  for (const name of [...names].sort()) {
    const record = files[name];
    digest.update(name).update("\0").update(record.sha256).update("\0")
      .update(String(record.size)).update("\n");
  }
  return digest.digest("hex");
}

function model2VecOrderedPartsIdentity(files, names) {
  const digest = createHash("sha256");
  for (const [index, name] of names.entries()) {
    const record = files[name];
    if (!record) return "";
    digest.update(String(index)).update("\0").update(name).update("\0")
      .update(record.sha256).update("\0").update(String(record.size)).update("\n");
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
  const embeddingParts = Array.isArray(manifest.embeddingParts)
    ? manifest.embeddingParts.filter((name) => typeof name === "string" && /^embeddings\.i8\.part-\d{3}$/.test(name))
    : [];
  if (!embeddingParts.length || embeddingParts.length !== manifest.embeddingParts.length
    || new Set(embeddingParts).size !== embeddingParts.length
    || JSON.stringify(embeddingParts) !== JSON.stringify(MODEL2VEC_ORDERED_PARTS.map((part) => part.name))) {
    throw new Error(`[afterPack] ${label} Model2Vec embeddingParts missing or invalid`);
  }
  if (!MODEL2VEC_ORDERED_PARTS.every((part) => (
    manifest.files[part.name]?.sha256 === part.sha256 && manifest.files[part.name]?.size === part.size
  ))) {
    throw new Error(`[afterPack] ${label} Model2Vec ordered embedding part record mismatch`);
  }
  const orderedPartsSha256 = model2VecOrderedPartsIdentity(manifest.files, embeddingParts);
  if (orderedPartsSha256 !== MODEL2VEC_ORDERED_PARTS_SHA256) {
    throw new Error(`[afterPack] ${label} Model2Vec ordered embedding part identity mismatch`);
  }
  const requiredFiles = [...embeddingParts, ...MODEL2VEC_REQUIRED_FILES];

  for (const name of requiredFiles) {
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
  const dimensions = Number(manifest.dimensions);
  const vocabSize = Number(manifest.vocabSize);
  const embeddingBytes = embeddingParts.reduce((sum, name) => sum + manifest.files[name].size, 0);
  if (!Number.isInteger(dimensions) || dimensions !== 256 || !Number.isInteger(vocabSize)
    || vocabSize <= 0 || embeddingBytes !== dimensions * vocabSize) {
    throw new Error(`[afterPack] ${label} Model2Vec split embedding shape mismatch`);
  }

  const contentSha256 = model2VecContentIdentity(manifest.files, requiredFiles);
  if (contentSha256 !== manifest.contentSha256 || contentSha256 !== MODEL2VEC_CONTENT_SHA256) {
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
  if (["tests", "test", "benchmarks", "benchmark", "fixtures", "fixture", "docs", "findings", "evidence", "artifacts", "output"]
    .some((segment) => lowerParts.includes(segment))) return true;
  if (lowerParts[0] === "research") return true;
  if (/^(?:test[-_]|.*[-_.]test\.|.*benchmark|.*fixture)/.test(base)) return true;
  if (lowerParts[0] === ".agentlas") {
    // The directory itself must remain traversable so the one immutable,
    // public runtime contract below can be inspected. Every sibling or nested
    // mutable Agentlas state remains forbidden.
    if (lowerParts.length === 1) return false;
    const mutablePath = lowerParts.slice(1).join("/");
    return mutablePath !== "product-runtime-contract.json";
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

async function pythonRuntimeTreeSha256(root) {
  const records = [];
  const walk = async (relative) => {
    const absolute = path.join(root, ...relative.split("/").filter(Boolean));
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (childRelative === ".gitkeep" || childRelative === "agentlas-python-runtime.json") continue;
      // Bytecode caches are not part of the runtime contract: any interpreter
      // start writes them into the source tree, and packaging filters them out
      // (!**/__pycache__/**, !**/*.pyc). Hash the same domain on both sides.
      if (entry.name === "__pycache__" || /\.py[co]$/.test(entry.name)) continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = await lstat(childAbsolute);
      if (stat.isDirectory()) await walk(childRelative);
      else if (stat.isSymbolicLink()) records.push({ kind: "L", relative: childRelative, target: await readlink(childAbsolute) });
      else if (stat.isFile()) records.push({ kind: "F", relative: childRelative, size: stat.size, absolute: childAbsolute });
      else throw new Error(`[afterPack] unsupported Python runtime entry: ${childRelative}`);
    }
  };
  await walk("");
  const digest = createHash("sha256");
  for (const record of records.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    if (record.kind === "L") {
      digest.update("L\0").update(record.relative).update("\0").update(record.target).update("\n");
    } else {
      const contentSha256 = createHash("sha256").update(await readFile(record.absolute)).digest("hex");
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(record.size)).update("\0").update(contentSha256).update("\n");
    }
  }
  return digest.digest("hex");
}

async function nodeRuntimeTreeSha256(root) {
  const records = [];
  const walk = async (relative) => {
    const absolute = path.join(root, ...relative.split("/").filter(Boolean));
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (childRelative === ".gitkeep" || childRelative === "agentlas-node-runtime.json") continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = await lstat(childAbsolute);
      if (stat.isDirectory()) await walk(childRelative);
      else if (stat.isSymbolicLink()) records.push({ kind: "L", relative: childRelative, target: await readlink(childAbsolute) });
      else if (stat.isFile()) records.push({ kind: "F", relative: childRelative, size: stat.size, absolute: childAbsolute });
      else throw new Error(`[afterPack] unsupported Node runtime entry: ${childRelative}`);
    }
  };
  await walk("");
  const digest = createHash("sha256");
  for (const record of records.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    if (record.kind === "L") {
      digest.update("L\0").update(record.relative).update("\0").update(record.target).update("\n");
    } else {
      const contentSha256 = createHash("sha256").update(await readFile(record.absolute)).digest("hex");
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(record.size)).update("\0").update(contentSha256).update("\n");
    }
  }
  return digest.digest("hex");
}

async function browserRuntimeTreeSha256(root) {
  const records = [];
  const walk = async (relative) => {
    const absolute = path.join(root, ...relative.split("/").filter(Boolean));
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (childRelative === ".gitkeep" || childRelative === "agentlas-browser-runtime.json") continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = await lstat(childAbsolute);
      if (stat.isDirectory()) await walk(childRelative);
      else if (stat.isSymbolicLink()) records.push({ kind: "L", relative: childRelative, target: await readlink(childAbsolute) });
      else if (stat.isFile()) records.push({ kind: "F", relative: childRelative, size: stat.size, absolute: childAbsolute });
      else throw new Error(`[afterPack] unsupported browser runtime entry: ${childRelative}`);
    }
  };
  await walk("");
  const digest = createHash("sha256");
  for (const record of records.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    if (record.kind === "L") {
      digest.update("L\0").update(record.relative).update("\0").update(record.target).update("\n");
    } else {
      const contentSha256 = createHash("sha256").update(await readFile(record.absolute)).digest("hex");
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(record.size)).update("\0").update(contentSha256).update("\n");
    }
  }
  return digest.digest("hex");
}

async function verifyBundledPython(projectDir, resourcesDir, platform, builderArch) {
  const sourceRoot = path.join(projectDir, "build-resources", "python-runtime");
  const packagedRoot = path.join(resourcesDir, "python-runtime");
  const manifestName = "agentlas-python-runtime.json";
  const [sourceManifestText, packagedManifestText] = await Promise.all([
    readFile(path.join(sourceRoot, manifestName), "utf8"),
    readFile(path.join(packagedRoot, manifestName), "utf8"),
  ]);
  if (sourceManifestText !== packagedManifestText) {
    throw new Error("[afterPack] packaged Python runtime manifest drift");
  }
  let manifest;
  try {
    manifest = JSON.parse(sourceManifestText);
  } catch (error) {
    throw new Error("[afterPack] Python runtime manifest is invalid JSON", { cause: error });
  }
  const exactKeys = [
    "schemaVersion", "pythonVersion", "releaseTag", "triple", "archiveName",
    "archiveSha256", "executableRelativePath", "executableSha256", "runtimeTreeSha256",
  ].sort();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join("\0") !== exactKeys.join("\0")) {
    throw new Error("[afterPack] Python runtime manifest shape is invalid");
  }
  const normalizedArch = builderArch === 3 || String(builderArch).toLowerCase() === "arm64"
    ? "arm64"
    : builderArch === 1 || String(builderArch).toLowerCase() === "x64"
      ? "x64"
      : null;
  const expectedTriple = platform === "darwin"
    ? normalizedArch === "arm64" ? "aarch64-apple-darwin" : normalizedArch === "x64" ? "x86_64-apple-darwin" : null
    : platform === "win32"
      ? normalizedArch === "x64" ? "x86_64-pc-windows-msvc" : null
      : normalizedArch === "x64" ? "x86_64-unknown-linux-gnu" : null;
  const locked = expectedTriple ? PYTHON_RUNTIME_ASSETS[expectedTriple] : null;
  if (
    manifest.schemaVersion !== "agentlas.python-runtime.v1" ||
    manifest.pythonVersion !== PYTHON_RUNTIME_VERSION ||
    manifest.releaseTag !== PYTHON_RUNTIME_RELEASE ||
    manifest.triple !== expectedTriple || !locked ||
    manifest.archiveName !== locked.archiveName ||
    manifest.archiveSha256 !== locked.archiveSha256 ||
    manifest.executableRelativePath !== locked.executableRelativePath ||
    typeof manifest.executableSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.executableSha256) ||
    typeof manifest.runtimeTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.runtimeTreeSha256)
  ) {
    throw new Error("[afterPack] Python runtime does not match the pinned platform asset");
  }
  const sourceExecutable = path.join(sourceRoot, ...manifest.executableRelativePath.split("/"));
  const packagedExecutable = path.join(packagedRoot, ...manifest.executableRelativePath.split("/"));
  const [sourceReal, packagedReal] = await Promise.all([
    realpath(sourceExecutable),
    realpath(packagedExecutable),
  ]);
  const sourceBoundary = `${await realpath(sourceRoot)}${path.sep}`;
  const packagedBoundary = `${await realpath(packagedRoot)}${path.sep}`;
  if (!`${sourceReal}${path.sep}`.startsWith(sourceBoundary) ||
      !`${packagedReal}${path.sep}`.startsWith(packagedBoundary)) {
    throw new Error("[afterPack] Python executable symlink escapes its runtime root");
  }
  const [sourceBytes, packagedBytes] = await Promise.all([
    readFile(sourceExecutable),
    readFile(packagedExecutable),
  ]);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const packagedSha256 = createHash("sha256").update(packagedBytes).digest("hex");
  if (sourceSha256 !== manifest.executableSha256 || packagedSha256 !== manifest.executableSha256) {
    throw new Error("[afterPack] packaged Python executable checksum mismatch");
  }
  const [sourceTreeSha256, packagedTreeSha256] = await Promise.all([
    pythonRuntimeTreeSha256(sourceRoot),
    pythonRuntimeTreeSha256(packagedRoot),
  ]);
  if (sourceTreeSha256 !== manifest.runtimeTreeSha256 || packagedTreeSha256 !== manifest.runtimeTreeSha256) {
    throw new Error("[afterPack] packaged Python runtime tree checksum mismatch");
  }
  await access(packagedExecutable);
  return manifest;
}

async function verifyBundledNode(projectDir, resourcesDir, platform, builderArch) {
  /*
   * ★ 2026-08-24 이전에는 이 줄이 `platform !== "win32"` 였다. 그래서 **맥 배포에서는
   *   번들 Node 를 아무도 검사하지 않았다** — 빠져도, 깨져도 초록불이었다. Node 가 없는
   *   맥 사용자에게 CLI 설치 버튼이 막다른 길이던 것과 같은 뿌리다.
   */
  if (platform !== "win32" && platform !== "darwin") return null;
  const layout = nodeRuntimeLayout(platform);
  const sourceRoot = path.join(projectDir, "build-resources", "node-runtime");
  const packagedRoot = path.join(resourcesDir, "node-runtime");
  const manifestName = "agentlas-node-runtime.json";
  const [sourceManifestText, packagedManifestText] = await Promise.all([
    readFile(path.join(sourceRoot, manifestName), "utf8"),
    readFile(path.join(packagedRoot, manifestName), "utf8"),
  ]);
  if (sourceManifestText !== packagedManifestText) {
    throw new Error("[afterPack] packaged Node runtime manifest drift");
  }
  let manifest;
  try {
    manifest = JSON.parse(sourceManifestText);
  } catch (error) {
    throw new Error("[afterPack] Node runtime manifest is invalid JSON", { cause: error });
  }
  const exactKeys = [
    "schemaVersion", "nodeVersion", "platform", "arch", "archiveName", "archiveSha256",
    "nodeRelativePath", "nodeSha256", "npmCliRelativePath", "npmCliSha256", "runtimeTreeSha256",
  ].sort();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join("\0") !== exactKeys.join("\0")) {
    throw new Error("[afterPack] Node runtime manifest shape is invalid");
  }
  const normalizedArch = builderArch === 3 || String(builderArch).toLowerCase() === "arm64"
    ? "arm64"
    : builderArch === 1 || String(builderArch).toLowerCase() === "x64"
      ? "x64"
      : null;
  const locked = normalizedArch ? NODE_RUNTIME_ASSETS[`${platform}:${normalizedArch}`] : null;
  if (
    manifest.schemaVersion !== "agentlas.node-runtime.v1" ||
    manifest.nodeVersion !== NODE_RUNTIME_VERSION ||
    manifest.platform !== platform ||
    manifest.arch !== normalizedArch || !locked ||
    manifest.archiveName !== locked.archiveName ||
    manifest.archiveSha256 !== locked.archiveSha256 ||
    manifest.nodeRelativePath !== layout.node ||
    manifest.nodeSha256 !== locked.nodeSha256 ||
    manifest.npmCliRelativePath !== layout.npmCli ||
    manifest.npmCliSha256 !== locked.npmCliSha256 ||
    manifest.runtimeTreeSha256 !== locked.runtimeTreeSha256
  ) {
    throw new Error(`[afterPack] Node runtime does not match the pinned ${platform} asset`);
  }

  for (const [relative, expectedSha256, label] of [
    [manifest.nodeRelativePath, manifest.nodeSha256, "Node executable"],
    [manifest.npmCliRelativePath, manifest.npmCliSha256, "npm CLI"],
  ]) {
    const [sourceRootReal, packagedRootReal] = await Promise.all([realpath(sourceRoot), realpath(packagedRoot)]);
    const sourcePath = path.join(sourceRoot, ...relative.split("/"));
    const packagedPath = path.join(packagedRoot, ...relative.split("/"));
    const [sourceStat, packagedStat, sourceReal, packagedReal] = await Promise.all([
      lstat(sourcePath),
      lstat(packagedPath),
      realpath(sourcePath),
      realpath(packagedPath),
    ]);
    if (
      !sourceStat.isFile() || sourceStat.isSymbolicLink() ||
      !packagedStat.isFile() || packagedStat.isSymbolicLink() ||
      !`${sourceReal}${path.sep}`.startsWith(`${sourceRootReal}${path.sep}`) ||
      !`${packagedReal}${path.sep}`.startsWith(`${packagedRootReal}${path.sep}`)
    ) {
      throw new Error(`[afterPack] ${label} is missing, mutable, or escapes its runtime root`);
    }
    const [sourceBytes, packagedBytes] = await Promise.all([readFile(sourcePath), readFile(packagedPath)]);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const packagedSha256 = createHash("sha256").update(packagedBytes).digest("hex");
    if (sourceSha256 !== expectedSha256 || packagedSha256 !== expectedSha256) {
      throw new Error(`[afterPack] packaged ${label} checksum mismatch`);
    }
  }
  const [sourceTreeSha256, packagedTreeSha256] = await Promise.all([
    nodeRuntimeTreeSha256(sourceRoot),
    nodeRuntimeTreeSha256(packagedRoot),
  ]);
  if (
    sourceTreeSha256 !== locked.runtimeTreeSha256 ||
    packagedTreeSha256 !== locked.runtimeTreeSha256
  ) {
    throw new Error("[afterPack] packaged Node runtime tree checksum mismatch");
  }
  return manifest;
}

async function verifyBundledBrowser(projectDir, resourcesDir, platform, builderArch) {
  const sourceRoot = path.join(projectDir, "build-resources", "browser-runtime");
  const packagedRoot = path.join(resourcesDir, "browser-runtime");
  const manifestName = "agentlas-browser-runtime.json";
  const [sourceText, packagedText] = await Promise.all([
    readFile(path.join(sourceRoot, manifestName), "utf8"),
    readFile(path.join(packagedRoot, manifestName), "utf8"),
  ]);
  if (sourceText !== packagedText) throw new Error("[afterPack] packaged browser runtime manifest drift");
  let manifest;
  try { manifest = JSON.parse(sourceText); }
  catch (error) { throw new Error("[afterPack] browser runtime manifest is invalid JSON", { cause: error }); }
  const expectedKeys = [
    "schemaVersion", "runtime", "playwrightVersion", "browserRevision", "browserVersion",
    "platform", "arch", "executableRelativePath", "executableSha256", "runtimeTreeSha256",
    ...(platform === "darwin" ? ["macBundleId"] : []),
  ].sort();
  const normalizedArch = builderArch === 3 || String(builderArch).toLowerCase() === "arm64"
    ? "arm64"
    : builderArch === 1 || String(builderArch).toLowerCase() === "x64" ? "x64" : null;
  if (
    !manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).sort().join("\0") !== expectedKeys.join("\0")
    || manifest.schemaVersion !== "agentlas.browser-runtime.v1"
    || manifest.runtime !== "playwright-chrome-for-testing"
    || manifest.platform !== platform
    || manifest.arch !== normalizedArch
    || !/^[0-9a-f]{64}$/.test(String(manifest.executableSha256 || ""))
    || !/^[0-9a-f]{64}$/.test(String(manifest.runtimeTreeSha256 || ""))
    || (platform === "darwin" && manifest.macBundleId !== "com.google.chrome.for.testing")
  ) throw new Error("[afterPack] browser runtime manifest shape or target is invalid");

  const sourceExecutable = path.resolve(sourceRoot, ...String(manifest.executableRelativePath).split("/"));
  const packagedExecutable = path.resolve(packagedRoot, ...String(manifest.executableRelativePath).split("/"));
  const [sourceRootReal, packagedRootReal, sourceReal, packagedReal, sourceStat, packagedStat] = await Promise.all([
    realpath(sourceRoot), realpath(packagedRoot), realpath(sourceExecutable), realpath(packagedExecutable),
    lstat(sourceExecutable), lstat(packagedExecutable),
  ]);
  if (
    !sourceStat.isFile() || sourceStat.isSymbolicLink() || !packagedStat.isFile() || packagedStat.isSymbolicLink()
    || !isPathInside(sourceRootReal, sourceReal) || !isPathInside(packagedRootReal, packagedReal)
  ) throw new Error("[afterPack] browser executable is missing, linked, or escapes its runtime root");
  const [sourceDigest, packagedDigest, sourceTree, packagedTree] = await Promise.all([
    readFile(sourceExecutable).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
    readFile(packagedExecutable).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
    browserRuntimeTreeSha256(sourceRoot), browserRuntimeTreeSha256(packagedRoot),
  ]);
  if (sourceDigest !== manifest.executableSha256 || packagedDigest !== manifest.executableSha256) {
    throw new Error("[afterPack] packaged browser executable checksum mismatch");
  }
  if (sourceTree !== manifest.runtimeTreeSha256 || packagedTree !== manifest.runtimeTreeSha256) {
    throw new Error("[afterPack] packaged browser runtime tree checksum mismatch");
  }
  if (platform === "darwin") {
    const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
    const appRoot = packagedExecutable.slice(0, packagedExecutable.lastIndexOf(marker));
    const plist = await readFile(path.join(appRoot, "Contents", "Info.plist"), "utf8");
    if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.google\.chrome\.for\.testing<\/string>/.test(plist)) {
      throw new Error("[afterPack] packaged browser has the wrong macOS bundle identity");
    }
    const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", packagedExecutable]);
    const expected = normalizedArch === "arm64" ? "arm64" : "x86_64";
    if (!String(stdout).trim().split(/\s+/).includes(expected)) {
      throw new Error(`[afterPack] packaged browser architecture mismatch: expected ${expected}`);
    }
  }
  return manifest;
}

async function verifyEmbeddedAgentlasOs(context) {
  const projectDir = context.packager?.projectDir || process.cwd();
  const productFilename = context.packager?.appInfo?.productFilename || "Agentlas";
  const resourcesDir = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  // Keep afterPack on the exact source selected by beforePack/ensure-engine.
  // Local candidates and release-preflight may intentionally point at an
  // isolated, verified checkout; comparing that staged tree with the default
  // ignored checkout would certify the wrong runtime (or reject a valid one).
  const pinnedSourceRoot = path.resolve(process.env.HEPHAESTUS_DIR || path.join(projectDir, "Hephaestus"));
  const preparedRoot = path.join(projectDir, embeddedCoreContract.EMBEDDED_CORE_STAGE_RELATIVE);
  const sourceManifestPath = path.join(preparedRoot, "manifest.json");
  const packagePath = path.join(projectDir, "package.json");
  const packagedRoot = path.join(resourcesDir, "Hephaestus");
  const packagedManifestPath = path.join(packagedRoot, "manifest.json");

  const [sourceManifest, packagedManifest, pkg] = await Promise.all([
    readFile(sourceManifestPath, "utf8").then(JSON.parse),
    readFile(packagedManifestPath, "utf8").then(JSON.parse),
    readFile(packagePath, "utf8").then(JSON.parse),
    access(path.join(packagedRoot, "agentlas_cloud", "__main__.py")),
  ]);
  embeddedCoreContract.verifyPinnedSource(pinnedSourceRoot, pkg);
  const preparationReceipt = embeddedCoreContract.verifyReceipt(preparedRoot, pkg);
  const packagedReceipt = JSON.parse(await readFile(
    path.join(packagedRoot, embeddedCoreContract.EMBEDDED_CORE_RECEIPT),
    "utf8",
  ));
  if (JSON.stringify(packagedReceipt) !== JSON.stringify(preparationReceipt)) {
    throw new Error("[afterPack] embedded Core preparation receipt drift");
  }
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
    const requestedRef = process.env.HEPHAESTUS_REF.trim();
    const refMatch = requestedRef.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    const commitMatch = /^[0-9a-f]{40}$/i.test(requestedRef);
    const refMatchesVersion = refMatch && refMatch[1] === sourceManifest.version;
    const refMatchesCommit = commitMatch
      && String(preparationReceipt.sourceCommit || "").toLowerCase() === requestedRef.toLowerCase();
    if (!refMatchesVersion && !refMatchesCommit) {
      throw new Error(
        `[afterPack] HEPHAESTUS_REF mismatch: expected v${sourceManifest.version}, got ${process.env.HEPHAESTUS_REF}`,
      );
    }
  }
  const sourceModel = await verifyModel2VecAsset(
    path.join(preparedRoot, ...MODEL2VEC_ASSET_PARTS),
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
  embeddedCoreContract.verifyPackagedSubset(packagedRoot, preparedRoot);
  const pythonRuntime = await verifyBundledPython(
    projectDir,
    resourcesDir,
    context.electronPlatformName,
    context.arch,
  );
  const nodeRuntime = await verifyBundledNode(
    projectDir,
    resourcesDir,
    context.electronPlatformName,
    context.arch,
  );
  const browserRuntime = await verifyBundledBrowser(
    projectDir,
    resourcesDir,
    context.electronPlatformName,
    context.arch,
  );
  console.log(
    `[afterPack] verified embedded Agentlas OS v${packagedManifest.version} `
      + `from ${preparationReceipt.sourceCommit.slice(0, 12)} with retirement transform `
      + `${preparationReceipt.transformId}, `
      + `with Model2Vec ${packagedModel.contentSha256} and Python ${pythonRuntime.pythonVersion} `
      + `(${pythonRuntime.triple})`
      + (nodeRuntime ? ` and private Node ${nodeRuntime.nodeVersion} (${nodeRuntime.arch})` : "")
      + ` and Chrome for Testing ${browserRuntime.browserVersion} (${browserRuntime.arch})`,
  );
}

async function verifyMacComputerUseDriver(context) {
  if (context.electronPlatformName !== "darwin") return;
  const projectDir = context.packager?.projectDir || process.cwd();
  const productFilename = context.packager?.appInfo?.productFilename || "Agentlas";
  const sourcePath = path.join(projectDir, "build-resources", "native", "macos", "agentlas-input-driver");
  const packagedPath = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    "Contents",
    "Resources",
    "native",
    "macos",
    "agentlas-input-driver",
  );
  const [sourceStat, packagedStat, sourceBytes, packagedBytes] = await Promise.all([
    lstat(sourcePath),
    lstat(packagedPath),
    readFile(sourcePath),
    readFile(packagedPath),
  ]);
  if (
    !sourceStat.isFile() || sourceStat.isSymbolicLink() ||
    !packagedStat.isFile() || packagedStat.isSymbolicLink() ||
    (packagedStat.mode & 0o111) === 0
  ) {
    throw new Error("[afterPack] Agentlas Computer Use driver is missing, mutable, or non-executable");
  }
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  const packagedDigest = createHash("sha256").update(packagedBytes).digest("hex");
  if (sourceDigest !== packagedDigest) {
    throw new Error("[afterPack] packaged Agentlas Computer Use driver differs from the built source artifact");
  }
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", packagedPath]);
  const architectures = String(stdout).trim().split(/\s+/);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`[afterPack] Agentlas Computer Use driver is not universal: ${architectures.join(" ")}`);
  }
  console.log(`[afterPack] verified Agentlas Computer Use driver ${sourceDigest} (${architectures.join("+")})`);
}

/**
 * AppImageUpdater starts the replacement image with a copy of the old
 * process environment. The AppImage runtime normally refreshes APPDIR before
 * it calls AppRun, but an inherited directory can win in extract-and-run
 * mode. That makes the new image execute the old extracted payload forever:
 * the replacement file is present, yet the target app never reaches its own
 * JavaScript bootstrap. The current AppRun path is authoritative, so clear
 * the inherited value before electron-builder's generated path discovery.
 */
const LINUX_APPIMAGE_ENTRYPOINT_MARKER = "# Agentlas: recompute APPDIR for an inherited AppImage relaunch";
const LINUX_APPIMAGE_ENTRYPOINT_NEEDLE = 'args=("$@")\nNUMBER_OF_ARGS="$#"\n';

function patchLinuxAppImageEntrypointContent(content, appRun) {
  if (content.includes(LINUX_APPIMAGE_ENTRYPOINT_MARKER)) {
    return { content, changed: false };
  }
  if (!content.includes(LINUX_APPIMAGE_ENTRYPOINT_NEEDLE)) {
    throw new Error(`[afterPack] generated Linux AppRun has an unexpected shape: ${appRun}`);
  }
  const replacement = `${LINUX_APPIMAGE_ENTRYPOINT_NEEDLE}\n${LINUX_APPIMAGE_ENTRYPOINT_MARKER}\n# Native updater relaunches may inherit the previous image's extraction root.\nif [ -n "\${APPIMAGE:-}" ]; then\n  unset APPDIR\nfi\n`;
  return {
    content: content.replace(LINUX_APPIMAGE_ENTRYPOINT_NEEDLE, replacement),
    changed: true,
  };
}

function isLinuxAppImageTarget(target) {
  return String(target?.name || "").replaceAll("-", "").replaceAll("_", "").toLowerCase() === "appimage";
}

function armLinuxAppImageEntrypointStageRepair(context) {
  const appImageTargets = Array.isArray(context.targets) ? context.targets.filter(isLinuxAppImageTarget) : [];
  if (appImageTargets.length === 0) {
    console.log("[afterPack] no AppImage target is present; Linux AppRun stage repair is not armed");
    return;
  }

  for (const target of appImageTargets) {
    if (typeof target.build !== "function") {
      throw new Error("[afterPack] AppImage target does not expose a build hook");
    }
    if (target.build.__agentlasEntrypointGuard === true) continue;
    const originalBuild = target.build;
    const guardedBuild = async function guardedAppImageBuild(...args) {
      const appImageFs = require("fs-extra");
      const originalWriteFile = appImageFs.writeFile;
      let appRunWritten = false;
      let active = true;
      let guardedWriteFile;
      const restore = () => {
        if (active && appImageFs.writeFile === guardedWriteFile) {
          appImageFs.writeFile = originalWriteFile;
          active = false;
        }
      };
      guardedWriteFile = async function guardedAppImageWrite(file, data, options) {
        if (!appRunWritten && path.basename(String(file)) === "AppRun") {
          appRunWritten = true;
          const content = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          const patched = patchLinuxAppImageEntrypointContent(content, String(file));
          restore();
          const result = await originalWriteFile.call(this, file, patched.content, options);
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
            throw new Error(`[afterPack] Linux AppImage entrypoint guard made AppRun invalid: ${file}`);
          }
          console.log(`[afterPack] ${patched.changed ? "repaired" : "verified"} Linux AppImage entrypoint guard ${file}`);
          return result;
        }
        return originalWriteFile.call(this, file, data, options);
      };
      appImageFs.writeFile = guardedWriteFile;
      let buildSucceeded = false;
      try {
        const result = await originalBuild.apply(this, args);
        buildSucceeded = true;
        return result;
      } finally {
        restore();
        if (buildSucceeded && !appRunWritten) {
          throw new Error("[afterPack] AppImage target completed without generating AppRun");
        }
      }
    };
    Object.defineProperty(guardedBuild, "__agentlasEntrypointGuard", { value: true });
    target.build = guardedBuild;
  }
  console.log(`[afterPack] armed Linux AppImage entrypoint guard for ${appImageTargets.length} target(s)`);
}

async function repairLinuxAppImageEntrypoint(context) {
  if (context.electronPlatformName !== "linux") return;
  armLinuxAppImageEntrypointStageRepair(context);
  const appRun = path.join(context.appOutDir, "AppRun");
  let content;
  try {
    content = await readFile(appRun, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const patched = patchLinuxAppImageEntrypointContent(content, appRun);
  if (!patched.changed) {
    console.log(`[afterPack] verified Linux AppImage entrypoint guard ${appRun}`);
    return;
  }
  await writeFile(appRun, patched.content, "utf8");
  const stat = await lstat(appRun);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`[afterPack] Linux AppImage entrypoint guard made AppRun invalid: ${appRun}`);
  }
  console.log(`[afterPack] repaired Linux AppImage entrypoint guard ${appRun}`);
}

async function prepareSquirrelInstallableTree(root) {
  // Squirrel.Mac recursively clears quarantine xattrs before it takes ownership
  // of the candidate bundle. Every entry therefore needs owner-write permission
  // in the updater ZIP. Strip inherited ACLs, preserve executable files, and
  // keep group/other write disabled. Every production Python launch separately
  // forces bytecode caches outside signed Resources.
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`[afterPack] signed runtime root is not a regular directory: ${root}`);
  }
  const resolvedRoot = await realpath(root);
  await execFileAsync("/bin/chmod", ["-RN", root]);
  const directories = [root];
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const linkTarget = await readlink(absolute);
        if (path.isAbsolute(linkTarget)) {
          throw new Error(`[afterPack] signed runtime symlink must be relative: ${absolute}`);
        }
        const lexicalTarget = path.resolve(path.dirname(absolute), linkTarget);
        if (!isPathInside(root, lexicalTarget)) {
          throw new Error(`[afterPack] signed runtime symlink escapes its root: ${absolute}`);
        }
        const resolvedTarget = await realpath(absolute);
        if (!isPathInside(resolvedRoot, resolvedTarget)) {
          throw new Error(`[afterPack] signed runtime symlink resolves outside its root: ${absolute}`);
        }
        continue;
      }
      if (stat.isDirectory()) {
        directories.push(absolute);
        queue.push(absolute);
      } else if (stat.isFile()) {
        files.push({ absolute, executable: (stat.mode & 0o111) !== 0 });
      } else {
        throw new Error(`[afterPack] unsupported signed runtime entry: ${absolute}`);
      }
    }
  }

  for (const file of files) {
    await chmod(file.absolute, file.executable ? 0o755 : 0o644);
  }
  // Normalize children before parents so a previously sealed tree remains
  // traversable throughout the conversion.
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    await chmod(directory, 0o755);
  }

  for (const file of files) {
    const stat = await lstat(file.absolute);
    if ((stat.mode & 0o200) === 0 || (stat.mode & 0o022) !== 0 || (file.executable && (stat.mode & 0o111) === 0)) {
      throw new Error(`[afterPack] signed runtime file is not Squirrel-installable: ${file.absolute}`);
    }
  }
  for (const directory of directories) {
    const stat = await lstat(directory);
    if ((stat.mode & 0o200) === 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) {
      throw new Error(`[afterPack] signed runtime directory is not Squirrel-installable: ${directory}`);
    }
  }
  return { directories: directories.length, files: files.length };
}

async function prepareMacRuntimeResourcesForInstall(context, phase = "afterSign") {
  if (context.electronPlatformName !== "darwin") return;
  const productFilename = context.packager?.appInfo?.productFilename || "Agentlas";
  const resourcesDir = path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources");
  const roots = [
    path.join(resourcesDir, "Hephaestus"),
    path.join(resourcesDir, "python-runtime"),
  ];
  let directoryCount = 0;
  let fileCount = 0;
  for (const root of roots) {
    const prepared = await prepareSquirrelInstallableTree(root);
    directoryCount += prepared.directories;
    fileCount += prepared.files;
  }
  console.log(
    `[${phase}] prepared signed Python/runtime resources for Squirrel install `
      + `(${directoryCount} directories, ${fileCount} files)`,
  );
}

exports.prepareMacRuntimeResourcesForInstall = prepareMacRuntimeResourcesForInstall;
// 만들어진 .app 을 따로 재는 게이트가 이 검사를 그대로 쓸 수 있어야 한다 — 검사를 베껴
// 쓰면 그 사본이 낡아 조용히 눈이 먼다.
exports.verifyBundledNode = verifyBundledNode;

function verifyBundledProductExtensionSigningPolicy(context) {
  const resourcesDir = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const packagedPath = path.join(resourcesDir, "product-extension-signing-policy.json");
  const preparedPath = path.join(context.packager.projectDir, "dist", "product-extension-signing-policy.json");
  const verified = verifyProductExtensionSigningPolicyFile(packagedPath, preparedPath);
  console.log(
    `[afterPack] verified product-extension signing policy ${verified.sha256} `
      + `(${verified.keyIds.length} trusted key id(s))`,
  );
  return verified;
}

exports.verifyBundledProductExtensionSigningPolicy = verifyBundledProductExtensionSigningPolicy;

exports.default = async function afterPackClean(context) {
  const studioResources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  await verifyStudioRuntime(path.join(studioResources, "studio-pack"));
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

  await repairLinuxAppImageEntrypoint(context);
  await verifyEmbeddedAgentlasOs(context);
  await verifyMacComputerUseDriver(context);
  verifyBundledProductExtensionSigningPolicy(context);
  // electron-builder skips afterSign when identity=null. Normalize the
  // explicitly isolated local candidate here; the official app is normalized
  // only after its pinned signing identity has been verified by afterSign.
  if (
    context.electronPlatformName === "darwin" &&
    context.packager?.appInfo?.productFilename === "Agentlas-Local-Candidate"
  ) {
    await prepareMacRuntimeResourcesForInstall(context, "afterPack-local");
  }
};
