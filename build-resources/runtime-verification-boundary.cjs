"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Test suites and package-scoped exclusions: Iconify's emoji/test and
// Playwright's mcp/test directories contain executable product features.
const ASAR_VERIFICATION_RULES = [
  ["**/node_modules/tinycolor2/deno_asserts*.mjs", /(?:^|\/)node_modules\/tinycolor2\/deno_asserts[^/]*\.mjs$/],
  ["**/node_modules/better-sqlite3/{build/Release/test_extension.node,deps/test_extension.c}", /(?:^|\/)node_modules\/better-sqlite3\/(?:build\/Release\/test_extension\.node|deps\/test_extension\.c)$/],
  ["**/node_modules/node-domexception/.history/**", /(?:^|\/)node_modules\/node-domexception\/\.history(?:\/|$)/],
  ["**/node_modules/object-inspect/test-core-js.js", /(?:^|\/)node_modules\/object-inspect\/test-core-js\.js$/],
  ["**/node_modules/pump/test-{browser,node}.js", /(?:^|\/)node_modules\/pump\/test-(?:browser|node)\.js$/],
  ["**/node_modules/tinycolor2/{cjs,esm}/test{,_template}.js", /(?:^|\/)node_modules\/tinycolor2\/(?:cjs|esm)\/test(?:_template)?\.js$/],
  ["**/node_modules/@types/benchmark/**", /(?:^|\/)node_modules\/@types\/benchmark(?:\/|$)/],
  ["**/node_modules/@braintree/sanitize-url/vitest.config.ts", /(?:^|\/)node_modules\/@braintree\/sanitize-url\/vitest\.config\.ts$/],
  ["**/node_modules/@maplibre/maplibre-gl-style-spec/src/**/*.test-d.ts", /(?:^|\/)node_modules\/@maplibre\/maplibre-gl-style-spec\/src\/.*\.test-d\.ts$/],
  ["**/node_modules/gaxios/build/{cjs,esm}/{browser-test,system-test}/**", /(?:^|\/)node_modules\/gaxios\/build\/(?:cjs|esm)\/(?:browser-test|system-test)(?:\/|$)/],
  ["**/node_modules/{buffer-equal-constant-time,expand-template,isarray}/test.js", /(?:^|\/)node_modules\/(?:buffer-equal-constant-time|expand-template|isarray)\/test\.js$/],
  ["**/node_modules/molstar/lib/{examples/domain-annotation-server,servers/model}/test.js", /(?:^|\/)node_modules\/molstar\/lib\/(?:commonjs\/)?(?:examples\/domain-annotation-server|servers\/model)\/test\.js$/],
  ["**/node_modules/molstar/lib/commonjs/{examples/domain-annotation-server,servers/model}/test.js", /(?:^|\/)node_modules\/molstar\/lib\/(?:commonjs\/)?(?:examples\/domain-annotation-server|servers\/model)\/test\.js$/],
  ["**/node_modules/protobufjs/ext/descriptor/test.js", /(?:^|\/)node_modules\/protobufjs\/ext\/descriptor\/test\.js$/],
  ["**/node_modules/safer-buffer/tests.js", /(?:^|\/)node_modules\/safer-buffer\/tests\.js$/],
  ["**/node_modules/**/__tests__/**", /(?:^|\/)node_modules\/(?:[^/]+\/)*__tests__(?:\/|$)/],
  ["**/node_modules/**/*.{test,spec}.*", /(?:^|\/)node_modules\/.*\.(?:test|spec)\.[^/]+$/],
  ["**/node_modules/cytoscape/{playwright-tests,tests-examples,test-results}/**", /(?:^|\/)node_modules\/cytoscape\/(?:playwright-tests|tests-examples|test-results)(?:\/|$)/],
  ["**/node_modules/cytoscape/src/test.mjs", /(?:^|\/)node_modules\/cytoscape\/src\/test\.mjs$/],
  ["**/node_modules/khroma/tasks/benchmark.js", /(?:^|\/)node_modules\/khroma\/tasks\/benchmark\.js$/],
  ["**/node_modules/node-pty/deps/winpty/misc/color-test.sh", /(?:^|\/)node_modules\/node-pty\/deps\/winpty\/misc\/color-test\.sh$/],
  ["**/node_modules/zod/src/**/{tests,benchmarks}/**", /(?:^|\/)node_modules\/zod\/src\/(?:[^/]+\/)*(?:tests|benchmarks)(?:\/|$)/],
  ["**/node_modules/fast-uri/benchmark/**", /(?:^|\/)node_modules\/fast-uri\/benchmark(?:\/|$)/],
  ["**/node_modules/gaxios/build/{cjs,esm}/test/**", /(?:^|\/)node_modules\/gaxios\/build\/(?:cjs|esm)\/test(?:\/|$)/],
  ["**/node_modules/json-schema-traverse/spec/**", /(?:^|\/)node_modules\/json-schema-traverse\/spec(?:\/|$)/],
  ["**/node_modules/katex/contrib/**/test/**", /(?:^|\/)node_modules\/katex\/contrib\/(?:[^/]+\/)*test(?:\/|$)/],
  ["**/node_modules/maplibre-gl/src/util/test/**", /(?:^|\/)node_modules\/maplibre-gl\/src\/util\/test(?:\/|$)/],
  ["**/node_modules/cytoscape/AGENTS.md", /(?:^|\/)node_modules\/cytoscape\/AGENTS\.md$/],
];
const PYTHON_PACKAGES = ["jsonschema", "jsonschema_specifications", "referencing", "mpmath", "sympy"];
const PYTHON_VERIFICATION_DIRECTORIES = new Set(["test", "tests", "benchmark", "benchmarks", "fixture", "fixtures"]);

function findPythonVerificationDirectories(sitePackages) {
  const found = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (PYTHON_VERIFICATION_DIRECTORIES.has(entry.name)) found.push(child);
      else walk(child);
    }
  }
  for (const name of PYTHON_PACKAGES) {
    const directory = path.join(sitePackages, name);
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isSymbolicLink()) walk(directory);
  }
  return found.sort();
}

function prunePythonVerificationDirectories(sitePackages) {
  if (path.basename(sitePackages) !== "site-packages") {
    throw new Error("Python verification pruning requires a site-packages directory");
  }
  const directories = findPythonVerificationDirectories(sitePackages);
  for (const directory of directories) fs.rmSync(directory, { recursive: true });
  return directories.map((directory) => path.relative(sitePackages, directory));
}

function isAsarVerificationPath(relativePath) {
  return ASAR_VERIFICATION_RULES.some(([, pattern]) => pattern.test(relativePath.replaceAll("\\", "/")));
}

function verifyPackagedVerificationBoundary(resourcesDir) {
  const asar = require("@electron/asar");
  const archive = path.join(resourcesDir, "app.asar");
  const excluded = asar.listPackage(archive)
    .filter((entry) => isAsarVerificationPath(entry) && !asar.statFile(archive, entry.replace(/^\//, "")).files);
  const pythonRoot = path.join(resourcesDir, "python-runtime");
  const pythonLibraries = [path.join(pythonRoot, "Lib")];
  const posixLib = path.join(pythonRoot, "lib");
  if (fs.existsSync(posixLib)) {
    for (const entry of fs.readdirSync(posixLib, { withFileTypes: true })) {
      if (entry.isDirectory() && /^python\d+\.\d+$/.test(entry.name)) pythonLibraries.push(path.join(posixLib, entry.name));
    }
  }
  for (const library of pythonLibraries) {
    const sitePackages = path.join(library, "site-packages");
    if (fs.existsSync(sitePackages)) excluded.push(...findPythonVerificationDirectories(sitePackages).map((entry) => path.relative(resourcesDir, entry)));
  }
  if (excluded.length) throw new Error(`Packaged nonruntime verification files: ${excluded.join(", ")}`);
  return { asarRules: ASAR_VERIFICATION_RULES.length, pythonPackages: PYTHON_PACKAGES.length };
}

module.exports = { ASAR_VERIFICATION_RULES, isAsarVerificationPath, findPythonVerificationDirectories, prunePythonVerificationDirectories, verifyPackagedVerificationBoundary };
