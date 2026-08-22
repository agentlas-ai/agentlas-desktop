#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const modules = path.join(root, "node_modules");
const publicRoot = path.join(root, "renderer", "public", "file-viewer");

function source(...parts) {
  return path.join(modules, ...parts);
}

function assertFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`File Viewer runtime asset is missing: ${file}`);
  }
}

function assertDirectory(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`File Viewer runtime asset directory is missing: ${directory}`);
  }
}

const files = [
  [source("pdfjs-dist", "build", "pdf.worker.mjs"), "vendor/pdf/pdf.worker.mjs"],
  [source("@fontsource-variable", "noto-sans-sc", "wght.css"), "vendor/pdf/fonts/noto-sans-sc.css"],
  [source("@fontsource-variable", "noto-sans-sc", "LICENSE"), "vendor/pdf/fonts/LICENSE"],
  [source("@file-viewer", "docx", "dist", "docx-preview.worker.js"), "vendor/docx/docx.worker.js"],
  [source("@file-viewer", "docx", "dist", "jszip.min.js"), "vendor/docx/jszip.min.js"],
  [source("@file-viewer", "pptx", "dist", "worker", "pptx.worker.js"), "vendor/pptx/pptx.worker.js"],
  [source("@file-viewer", "renderer-spreadsheet", "dist", "worker", "sheet.worker.js"), "vendor/xlsx/sheet.worker.js"],
  [source("@file-viewer", "renderer-hangul", "dist", "hangul.worker.js"), "vendor/hangul/hangul.worker.js"],
  [source("@file-viewer", "renderer-iwork", "dist", "iwork.worker.js"), "vendor/iwork/iwork.worker.js"],
  [source("@file-viewer", "renderer-wordperfect", "dist", "wordperfect.worker.js"), "vendor/wordperfect/wordperfect.worker.js"],
  [source("@file-viewer", "renderer-wordperfect", "dist", "libwpd.mjs"), "vendor/wordperfect/libwpd.mjs"],
  [source("@file-viewer", "renderer-wordperfect", "dist", "libwpd.wasm"), "vendor/wordperfect/libwpd.wasm"],
  [source("libarchive.js", "dist", "worker-bundle.js"), "vendor/libarchive/worker-bundle.js"],
  [source("libarchive.js", "dist", "libarchive.wasm"), "vendor/libarchive/libarchive.wasm"],
  [source("libarchive.js", "LICENSE"), "vendor/libarchive/LICENSE"],
  ...["index.mjs", "worker.mjs", "frame-cache.mjs", "ppt-native.wasm", "ppt-font-cjk.otf", "LICENSE", "NOTICE", "manifest.json"]
    .map((filename) => [source("@file-viewer", "ppt", filename), `vendor/ppt/${filename}`]),
];

const directories = [
  [source("pdfjs-dist", "cmaps"), "vendor/pdf/cmaps"],
  [source("pdfjs-dist", "wasm"), "vendor/pdf/wasm"],
  [source("pdfjs-dist", "standard_fonts"), "vendor/pdf/standard_fonts"],
  [source("@fontsource-variable", "noto-sans-sc", "files"), "vendor/pdf/fonts/files"],
];

for (const [input] of files) assertFile(input);
for (const [input] of directories) assertDirectory(input);

// This directory is generated exclusively by this script. Replacing it avoids
// shipping stale workers after a dependency update.
fs.rmSync(publicRoot, { recursive: true, force: true });
for (const [input, relativeOutput] of directories) {
  const output = path.join(publicRoot, relativeOutput);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.cpSync(input, output, { recursive: true });
}
for (const [input, relativeOutput] of files) {
  const output = path.join(publicRoot, relativeOutput);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output);
}

const copiedBytes = files.reduce((total, [input]) => total + fs.statSync(input).size, 0);
console.log(`File Viewer runtime assets synced (${files.length} files plus ${directories.length} directories, ${copiedBytes} direct bytes)`);
