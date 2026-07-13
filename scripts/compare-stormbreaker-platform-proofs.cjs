#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith(".json") ? [full] : [];
  });
}

const root = path.resolve(process.argv[2] || "proofs");
const proofs = filesUnder(root).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
assert.ok(proofs.length >= 3, "macOS, Linux, and Windows proofs are required");
assert.deepEqual(new Set(proofs.map((proof) => proof.platform)), new Set(["darwin", "linux", "win32"]));
for (const field of ["harness_id", "mode", "prompt_sha256", "system_prompt_utf8_base64"]) {
  assert.equal(new Set(proofs.map((proof) => proof[field])).size, 1, `cross-platform drift in ${field}`);
}
for (const proof of proofs) {
  const prompt = Buffer.from(proof.system_prompt_utf8_base64, "base64");
  assert.equal(crypto.createHash("sha256").update(prompt).digest("hex"), proof.prompt_sha256);
}
console.log(JSON.stringify({ status: "pass", proofs: proofs.length, prompt_sha256: proofs[0].prompt_sha256 }));
