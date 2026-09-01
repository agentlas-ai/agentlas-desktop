"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const POLICY_SCHEMA_VERSION = "agentlas.product-extension-signing-policy.v1";
const POLICY_ENV = "AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON";
const KEY_ID_RE = /^[a-zA-Z0-9._-]{1,96}$/;

function validateTrustedKeys(value, label = POLICY_ENV) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[product-extension-policy] ${label} must be a JSON object keyed by signing key id`);
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error(`[product-extension-policy] ${label} must contain between 1 and 16 public keys`);
  }
  const keys = {};
  for (const [keyId, pem] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!KEY_ID_RE.test(keyId)) {
      throw new Error(`[product-extension-policy] invalid signing key id: ${keyId}`);
    }
    if (typeof pem !== "string" || pem.includes("PRIVATE KEY") || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`[product-extension-policy] ${keyId} must be a public key PEM, never private key material`);
    }
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(pem);
    } catch (error) {
      throw new Error(`[product-extension-policy] ${keyId} is not a valid public key PEM`, { cause: error });
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`[product-extension-policy] ${keyId} must be an Ed25519 public key`);
    }
    keys[keyId] = publicKey.export({ type: "spki", format: "pem" });
  }
  return keys;
}

function parsePolicyText(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`[product-extension-policy] ${label} is not valid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== POLICY_SCHEMA_VERSION
    || Object.keys(value).sort().join(",") !== "keys,schemaVersion") {
    throw new Error(`[product-extension-policy] ${label} has an unsupported or non-exact policy shape`);
  }
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    keys: validateTrustedKeys(value.keys, `${label}.keys`),
  };
}

function canonicalPolicy(policy) {
  return `${JSON.stringify({
    schemaVersion: POLICY_SCHEMA_VERSION,
    keys: policy.keys,
  }, null, 2)}\n`;
}

function materializeProductExtensionSigningPolicy(projectDir, env = process.env) {
  const raw = String(env[POLICY_ENV] || "").trim();
  if (!raw) {
    throw new Error(
      `[product-extension-policy] ${POLICY_ENV} is required for packaging; `
      + "provide the release-owned Ed25519 public keys and never a private key",
    );
  }
  let source;
  try {
    source = JSON.parse(raw);
  } catch (error) {
    throw new Error(`[product-extension-policy] ${POLICY_ENV} is not valid JSON`, { cause: error });
  }
  const policy = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    keys: validateTrustedKeys(source),
  };
  const text = canonicalPolicy(policy);
  const outputPath = path.join(projectDir, "dist", "product-extension-signing-policy.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, { encoding: "utf8", mode: 0o644 });
  return {
    outputPath,
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    keyIds: Object.keys(policy.keys),
  };
}

function verifyProductExtensionSigningPolicyFile(filePath, expectedPath = null) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 262_144) {
    throw new Error(`[product-extension-policy] policy is missing, mutable, or oversized: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, "utf8");
  const policy = parsePolicyText(text, filePath);
  const canonical = canonicalPolicy(policy);
  if (text !== canonical) {
    throw new Error(`[product-extension-policy] policy is not canonical: ${filePath}`);
  }
  if (expectedPath) {
    const expectedStat = fs.lstatSync(expectedPath);
    if (!expectedStat.isFile() || expectedStat.isSymbolicLink()) {
      throw new Error(`[product-extension-policy] prepared policy is missing or mutable: ${expectedPath}`);
    }
    const expected = fs.readFileSync(expectedPath);
    if (!crypto.timingSafeEqual(crypto.createHash("sha256").update(expected).digest(), crypto.createHash("sha256").update(text).digest())) {
      throw new Error("[product-extension-policy] packaged policy differs from the prepared release policy");
    }
  }
  return {
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    keyIds: Object.keys(policy.keys),
  };
}

module.exports = {
  POLICY_ENV,
  POLICY_SCHEMA_VERSION,
  materializeProductExtensionSigningPolicy,
  parsePolicyText,
  validateTrustedKeys,
  verifyProductExtensionSigningPolicyFile,
};
