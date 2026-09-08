#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = require("../node_modules/agentlas-science/src/contracts/science-jbrowse-runtime.json");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function buildScienceJBrowseRuntime(outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-jbrowse-core-"))) {
  const { build } = await import("vite");
  await build({
    configFile: false,
    logLevel: "error",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      outDir: outputRoot,
      emptyOutDir: true,
      minify: "oxc",
      cssCodeSplit: false,
      sourcemap: false,
      lib: {
        entry: path.join(root, "science-renderer-packs", "jbrowse-core", "entry.jsx"),
        name: "AgentlasJBrowseRuntime",
        formats: ["iife"],
        fileName: () => "jbrowse-runtime.js",
      },
    },
  });
  const entries = fs.readdirSync(outputRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error("science-jbrowse-bundle-nested-output-forbidden");
  const files = entries.map((entry) => entry.name).sort();
  if (!files.includes("jbrowse-runtime.js") || files.some((name) => !/^jbrowse-runtime(?:\.css|\.js)$/.test(name))) {
    throw new Error(`science-jbrowse-bundle-shape-invalid:${JSON.stringify(files)}`);
  }
  const assets = files.map((name) => {
    const bytes = fs.readFileSync(path.join(outputRoot, name));
    return { name, bytes, size: bytes.length, sha256: sha256(bytes) };
  });
  const runtime = assets.find((asset) => asset.name === "jbrowse-runtime.js");
  if (!runtime || runtime.size < 1_000_000 || /\bprocess\.env\.NODE_ENV\b/.test(runtime.bytes.toString("utf8"))) {
    throw new Error(`science-jbrowse-browser-runtime-invalid:${JSON.stringify({
      present: Boolean(runtime),
      size: runtime?.size ?? null,
      processEnvNodeEnvReference: runtime ? /\bprocess\.env\.NODE_ENV\b/.test(runtime.bytes.toString("utf8")) : null,
    })}`);
  }
  if (manifest.schema !== "agentlas.science-jbrowse-runtime-manifest/v1"
    || manifest.rendererId !== "agentlas.jbrowse"
    || manifest.entry !== "vendor/jbrowse-runtime.js"
    || manifest.entryBytes !== runtime.size
    || manifest.entrySha256 !== runtime.sha256) {
    throw new Error(`science-jbrowse-runtime-manifest-mismatch:${JSON.stringify({
      expectedBytes: manifest.entryBytes,
      actualBytes: runtime.size,
      expectedSha256: manifest.entrySha256,
      actualSha256: runtime.sha256,
    })}`);
  }
  return { outputRoot, assets };
}

module.exports = { buildScienceJBrowseRuntime };

if (require.main === module) {
  buildScienceJBrowseRuntime().then((result) => {
    process.stdout.write(`${JSON.stringify({
      outputRoot: result.outputRoot,
      assets: result.assets.map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest })),
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
