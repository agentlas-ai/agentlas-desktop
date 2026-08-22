#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const maplibreDist = path.join(root, "node_modules", "maplibre-gl", "dist");
const publicDist = path.join(root, "renderer", "public", "vendor", "maplibre-gl");
const runtimeFiles = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

for (const filename of runtimeFiles) {
  const source = path.join(maplibreDist, filename);
  if (!fs.existsSync(source)) {
    throw new Error(`MapLibre runtime asset is missing: ${source}`);
  }
}

fs.mkdirSync(publicDist, { recursive: true });
for (const filename of runtimeFiles) {
  fs.copyFileSync(path.join(maplibreDist, filename), path.join(publicDist, filename));
}

console.log(`MapLibre worker runtime synced (${runtimeFiles.join(", ")})`);
