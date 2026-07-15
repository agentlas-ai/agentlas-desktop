const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..", "..");

function resolveAgentlasCoreRoot() {
  const candidates = [
    process.env.HEPHAESTUS_RUNTIME_ROOT
      ? path.resolve(process.env.HEPHAESTUS_RUNTIME_ROOT)
      : null,
    path.join(desktopRoot, "Hephaestus"),
    path.resolve(desktopRoot, "..", "Agentlas-OS"),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "ontology", "__main__.py")),
  );
  if (!resolved) {
    throw new Error(`Agentlas Core checkout is required; checked: ${candidates.join(", ")}`);
  }
  return resolved;
}

function resolveModel2VecAsset() {
  const candidates = [
    process.env.AGENTLAS_MODEL2VEC_PATH
      ? path.resolve(process.env.AGENTLAS_MODEL2VEC_PATH)
      : null,
    path.join(resolveAgentlasCoreRoot(), "assets", "model2vec", "potion-base-8M-int8"),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "manifest.json")),
  );
  if (!resolved) {
    throw new Error(`Verified local Model2Vec asset is required; checked: ${candidates.join(", ")}`);
  }
  return resolved;
}

module.exports = { resolveAgentlasCoreRoot, resolveModel2VecAsset };
