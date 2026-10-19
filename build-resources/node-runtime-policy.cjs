"use strict";
const fs = require("node:fs");
const path = require("node:path");
const NODE_VERSION = "24.21.0";
const OVERLAYS = [
  { name: "npm", version: "11.20.0", sha256: "d1a92f40e6c407b84c3a00c3cf978a10b24fd42f153c527e2016cef7bb34a483" },
  { name: "undici", version: "6.28.1", sha256: "e18191aac9c0ff43dac7fe9b10b7041a22d07addb7b66a6e8ac14a52a5b69b74" },
  { name: "ip-address", version: "10.7.2", sha256: "4301746e43e8a85a6a41e268f02178b27e6ba58e78e6913ab105d3871618083b" },
  { name: "brace-expansion", version: "5.0.12", sha256: "ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4" },
];
const ASSETS = {
  "win32:x64": {
    "name": "node-v24.21.0-win-x64.zip",
    "sha256": "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    "nodeSha256": "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
    "npmCliSha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    "runtimeTreeSha256": "fd00f0cdaccf70d0ac84d566b169ef728b956631866a98dc13a234c9f3a44ba2"
  },
  "win32:arm64": {
    "name": "node-v24.21.0-win-arm64.zip",
    "sha256": "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
    "nodeSha256": "dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7",
    "npmCliSha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    "runtimeTreeSha256": "952590d10c208c785e2979895e9425ca0da57291ad8544087007605c78a3693a"
  },
  "darwin:arm64": {
    "name": "node-v24.21.0-darwin-arm64.tar.gz",
    "sha256": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    "nodeSha256": "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b",
    "npmCliSha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    "runtimeTreeSha256": "189ce36f33edb8bf6926ff74bea3268b7c65a2549355257fcf9ffe0cd792147c"
  },
  "darwin:x64": {
    "name": "node-v24.21.0-darwin-x64.tar.gz",
    "sha256": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    "nodeSha256": "7abcf39bd37ab251015337ff75304d7555f0d8e88c6e0fbf04bce8ce34636f49",
    "npmCliSha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    "runtimeTreeSha256": "22a556b02222ccbff3cc2682e64e74783bd8af08fe8223c6d3557dfb5a5a2929"
  },
  "linux:x64": {
    "name": "node-v24.21.0-linux-x64.tar.gz",
    "sha256": "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    "nodeSha256": "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c",
    "npmCliSha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    "runtimeTreeSha256": "4836378a21b2136b32ac3274b59d5bb1be7e27bfdc7dfd5dc5bcce9cd7e50fe0"
  }
};
const PRIVATE_SEGMENTS = new Set(["test", "tests", "__tests__", "fixture", "fixtures", "example", "examples", "sample", "samples", "samplejson", "man", "benchmark", "benchmarks", ".github", ".tap", "coverage"]);
function isNonruntimePath(relative) {
  const parts = relative.replaceAll("\\", "/").split("/");
  if (/\.map$/i.test(parts.at(-1))) return true;
  if ([".travis.yml", ".release-please-manifest.json"].includes(parts.at(-1))) return true;
  if (parts.at(-1) === ".gitkeep" && relative !== ".gitkeep") return true;
  const npmCommands = /(?:^|\/)(?:lib\/)?node_modules\/npm\/lib\/commands\/(?:test|install-test|install-ci-test)\.js$/;
  if (npmCommands.test(relative)) return false;
  if (parts.some((part) => PRIVATE_SEGMENTS.has(part.toLowerCase()))) return true;
  // Test runners and suites outside test/ directories, including node-gyp.
  if (/(?:^|[_-])test(?:[_.-]|$)/i.test(parts.at(-1))) {
    // OpenSSL's exported self-test API header is part of the native ABI SDK.
    if (!relative.endsWith("include/node/openssl/self_test.h")) return true;
  }
  if (/(?:^|\/)(?:bench|tests?)\.[^/]+$/i.test(relative)) return true;
  if (/\.(?:test|spec)\.[^/]+$/.test(relative)) return true;
  const docs = parts.indexOf("docs");
  // npm help-search reads public command help; unused HTML/man output is excluded.
  if (docs !== -1 && !(parts.slice(0, docs).join("/").match(/(?:^|\/)(?:lib\/)?node_modules\/npm$/) && [undefined, "content"].includes(parts[docs + 1]))) return true;
  return parts.includes("doc") || /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|SECURITY)(?:\.[^/]+)?$/i.test(relative);
}
function pruneNonruntimeFiles(root) {
  const removed = [];
  function walk(relative = "") {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const absolute = path.join(root, child);
      if (isNonruntimePath(child)) {
        fs.rmSync(absolute, { recursive: true, force: true }); removed.push(child);
      } else if (fs.lstatSync(absolute).isDirectory()) walk(child);
    }
  }
  walk(); return removed;
}
function verifyNonruntimeBoundary(root) {
  function walk(relative = "") {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (isNonruntimePath(child)) throw new Error(`Node runtime contains nonruntime path: ${child}`);
      if (fs.lstatSync(path.join(root, child)).isDirectory()) walk(child);
    }
  }
  walk();
}
function verifyRuntimeVersions(root, platform) {
  const npmRoot = path.join(root, platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm");
  for (const overlay of OVERLAYS) {
    const packageRoot = overlay.name === "npm" ? npmRoot : path.join(npmRoot, "node_modules", overlay.name);
    if (JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version !== overlay.version) throw new Error(`Node runtime ${overlay.name} version drift`);
  }
}
module.exports = { NODE_VERSION, OVERLAYS, ASSETS, isNonruntimePath, pruneNonruntimeFiles, verifyRuntimeVersions, verifyNonruntimeBoundary };
