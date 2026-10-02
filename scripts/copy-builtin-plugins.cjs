#!/usr/bin/env node
"use strict";
/*
 * copy-builtin-plugins — 저장소 plugins/ 를 dist/plugins/ 로 복사한다.
 *
 * tsc 는 import 된 plugin.json 만 emit 한다. 플러그인 패키지의 본체는 SKILL.md 와
 * references/ 이므로, 그것들이 함께 가지 않으면 매니페스트만 있고 절차가 없는
 * 패키지가 배포된다 — 정확히 이 저장소가 겪었던 "이름만 있고 내용 없는 행" 이다.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const from = path.resolve(__dirname, "..", "plugins");
const to = path.resolve(__dirname, "..", "dist", "plugins");

// Public packages are an explicit runtime allowlist. Tests, fixtures, oracle
// cross-checks, and benchmarks stay in the private/local verification surface;
// they are never copied into the signed application payload.
const RELEASE_TOP_LEVEL = Object.freeze({
  "agentlas-academic-search": ["README.md", "plugin.json", "skills"],
  "agentlas-astronomy": ["README.md", "assets", "capabilities.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-comparative-genomics": ["README.md", "assets", "capabilities.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-browser": ["plugin.json"],
  "agentlas-computer-use": ["README.md", "plugin.json"],
  "agentlas-earth-science": ["README.md", "assets", "capabilities.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-economic-data": ["README.md", "bin", "capabilities.json", "package.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-materials-science": ["README.md", "assets", "capabilities.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-paleontology": ["README.md", "assets", "capabilities.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-physics": ["README.md", "assets", "capabilities.json", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-science-research-director": ["README.md", "agent", "contracts", "plugin.json", "skills"],
  "agentlas-science-skills": ["README.md", "assets", "plugin.json", "runtime", "schemas", "skills"],
  "agentlas-science-statistics": ["README.md", "bin", "coverage-manifest.json", "figure-catalog.json", "matlab-parity-manifest.json", "plugin.json", "runtime", "skills"],
  "agentlas-time": ["plugin.json"],
  "agentlas-workspace-preview": ["plugin.json"],
  "agentlas-agent-mail": ["plugin.json"],
  "agentlas-one-team": ["plugin.json"],
  design: ["README.md", "assets", "plugin.json", "references", "skills"],
  "flint-chart": ["plugin.json", "skills"],
  "plugin-make": ["README.md", "assets", "plugin.json", "skills"],
});

const PRIVATE_TOP_LEVEL = Object.freeze({
  "agentlas-astronomy": ["tests"],
  "agentlas-comparative-genomics": ["tests"],
  "agentlas-earth-science": ["tests"],
  "agentlas-economic-data": ["tests"],
  "agentlas-materials-science": ["tests"],
  "agentlas-paleontology": ["tests"],
  "agentlas-physics": ["tests"],
  "agentlas-science-research-director": ["tests"],
  "agentlas-science-statistics": ["contracts"],
});
const RUNTIME_PINNED_PLUGINS = Object.freeze([
  "agentlas-astronomy",
  "agentlas-comparative-genomics",
  "agentlas-earth-science",
  "agentlas-economic-data",
  "agentlas-materials-science",
  "agentlas-paleontology",
  "agentlas-physics",
  "agentlas-science-statistics",
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function allFiles(root, base = root, output = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) allFiles(target, base, output);
    else if (entry.isFile()) output.push(path.relative(base, target).split(path.sep).join("/"));
    else throw new Error(`[copy-builtin-plugins] linked or unsupported entry: ${target}`);
  }
  return output;
}

function privateVerificationRefs(pluginName) {
  const pluginRoot = path.join(from, pluginName);
  const refsByPath = new Map();
  const privateTops = new Set(PRIVATE_TOP_LEVEL[pluginName] || []);
  const manifestPath = path.join(pluginRoot, "plugin.json");
  const sourceManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const entry of sourceManifest.integrity?.files || []) {
    if (!entry || typeof entry.path !== "string" || !privateTops.has(entry.path.split("/", 1)[0])
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) continue;
    const leaf = path.basename(entry.path).replace(/[^a-zA-Z0-9._-]/g, "-");
    refsByPath.set(entry.path, {
      relative: entry.path,
      repositoryRelative: `plugins/${pluginName}/${entry.path}`,
      urn: `urn:agentlas:private-verification:${pluginName}:${leaf}:sha256:${entry.sha256}`,
    });
  }
  for (const privateTop of PRIVATE_TOP_LEVEL[pluginName] || []) {
    const privateRoot = path.join(pluginRoot, privateTop);
    if (!fs.existsSync(privateRoot)) continue;
    for (const relativeToPrivate of allFiles(privateRoot)) {
      const relative = `${privateTop}/${relativeToPrivate}`;
      const file = path.join(pluginRoot, ...relative.split("/"));
      const bytes = fs.readFileSync(file);
      const leaf = path.basename(relative).replace(/[^a-zA-Z0-9._-]/g, "-");
      refsByPath.set(relative, {
        relative,
        repositoryRelative: `plugins/${pluginName}/${relative}`,
        urn: `urn:agentlas:private-verification:${pluginName}:${leaf}:sha256:${sha256(bytes)}`,
      });
    }
  }
  for (const allowedTop of RELEASE_TOP_LEVEL[pluginName] || []) {
    const target = path.join(pluginRoot, allowedTop);
    if (!fs.existsSync(target)) continue;
    const candidates = fs.lstatSync(target).isDirectory() ? allFiles(target).map((relative) => path.join(target, relative)) : [target];
    for (const candidate of candidates) {
      if (!fs.lstatSync(candidate).isFile() || !/\.(?:cjs|js|mjs|json|md|txt)$/u.test(candidate)) continue;
      const text = fs.readFileSync(candidate, "utf8");
      for (const match of text.matchAll(/(?:^|[^a-zA-Z0-9._-])((?:tests?|fixtures?|benchmarks?|contracts)\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)/gu)) {
        const relative = match[1];
        if (!privateTops.has(relative.split("/", 1)[0]) || refsByPath.has(relative)) continue;
        const leaf = path.basename(relative).replace(/[^a-zA-Z0-9._-]/g, "-");
        refsByPath.set(relative, {
          relative,
          repositoryRelative: `plugins/${pluginName}/${relative}`,
          urn: `urn:agentlas:unavailable-private-verification:${pluginName}:${leaf}:reference-sha256:${sha256(relative)}`,
        });
      }
    }
  }
  return [...refsByPath.values()].sort((left, right) => right.repositoryRelative.length - left.repositoryRelative.length);
}

function rewritePrivateVerificationReferences(pluginName, destination) {
  // The compiled RD bundle authenticates every content asset, including README.
  // Rewriting one reference invalidates its fixed manifest/bundle pins.
  if (pluginName === "agentlas-science-research-director") return;
  const refs = privateVerificationRefs(pluginName);
  if (!refs.length) return;
  for (const relative of allFiles(destination)) {
    if (relative === "plugin.json" || !/\.(?:cjs|js|mjs|json|md|txt)$/u.test(relative)) continue;
    const target = path.join(destination, ...relative.split("/"));
    let text = fs.readFileSync(target, "utf8");
    const before = text;
    for (const ref of refs) {
      for (const candidate of [ref.repositoryRelative, ref.relative]) {
        text = text.split(`node ${candidate}`).join(`Verification receipt: ${ref.urn}`);
        text = text.split(candidate).join(ref.urn);
      }
    }
    text = text
      .replace(/(?:tests?|fixtures?|benchmarks?|contracts)\/<[^>]+>(?:-[a-zA-Z0-9._-]+)?/gu, "private verification material (not distributed)")
      .replace(/(?:tests?|fixtures?|benchmarks?|contracts)\/[a-zA-Z0-9._-]*<[^>]+>[a-zA-Z0-9._-]*/gu, "private verification material (not distributed)");
    if (text !== before) fs.writeFileSync(target, text, { encoding: "utf8", mode: 0o644 });
  }
  if (pluginName === "agentlas-economic-data") {
    const packagePath = path.join(destination, "package.json");
    const descriptor = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (descriptor.scripts && typeof descriptor.scripts === "object") delete descriptor.scripts.test;
    fs.writeFileSync(packagePath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  }
  if (pluginName === "agentlas-science-statistics") {
    const coveragePath = path.join(destination, "coverage-manifest.json");
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
    delete require.cache[require.resolve(path.join(destination, "runtime", "coverage.cjs"))];
    const runtime = require(path.join(destination, "runtime", "coverage.cjs"));
    coverage.manifestSha256 = runtime.digestManifest(coverage);
    fs.writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  }
}

function projectScienceSkillRuntime(pluginName, destination) {
  if (pluginName !== "agentlas-science-skills") return 0;
  const root = path.join(destination, "skills");
  const omitted = [
    "timesfm-forecasting/examples",
    "relsa-severity-assessment/assets/example_cohort.csv",
    "markdown-mermaid-writing/assets/examples",
    "venue-templates/assets/examples",
  ];
  let removed = 0;
  for (const relative of omitted) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) continue; // Already excluded from the public source projection.
    removed += fs.statSync(target).isDirectory() ? countFiles(target) : 1;
    fs.rmSync(target, { recursive: true, force: true });
  }
  const edit = (relative, transform) => {
    const target = path.join(root, relative);
    const before = fs.readFileSync(target, "utf8");
    const after = transform(before);
    if (after === before) {
      // A public source checkout already contains the same cleaned procedures.
      const markers = {
        "timesfm-forecasting/SKILL.md": "input requirements, output checks, and common forecasting mistakes.",
        "timesfm-forecasting/references/examples_and_validation.md": "# Forecast Input and Output Checks",
        "relsa-severity-assessment/SKILL.md": "Supply your collected cohort as `input/cohort.csv`.",
      };
      const projected = relative === "markdown-mermaid-writing/SKILL.md"
        ? !/^### Examples$/m.test(before) && !before.includes("assets/examples/")
        : typeof markers[relative] === "string" && before.includes(markers[relative]);
      if (!projected) throw new Error(`[copy-builtin-plugins] Science procedure projection did not apply: ${relative}`);
      return;
    }
    fs.writeFileSync(target, after, { encoding: "utf8", mode: 0o644 });
  };
  edit("timesfm-forecasting/SKILL.md", (text) => text
    .replace(/See the `examples\/anomaly-detection\/` directory for a full example\./g, "Use the prediction-interval procedure below with your observed series.")
    .replace(/^> See `examples\/covariates-forecasting\/`[^\n]*$/gm, "> Use your observed series and matching covariate arrays with the API below.")
    .replace(/^> See `examples\/anomaly-detection\/`[^\n]*$/gm, "> Compare prediction intervals with your held-out observations and plot the resulting flags.")
    .replace("runnable examples, the quality checklist, common mistakes, and regression checks.", "input requirements, output checks, and common forecasting mistakes."));
  edit("timesfm-forecasting/references/examples_and_validation.md", () => `# Forecast Input and Output Checks

Run scripts/check_system.py before loading the model. Use scripts/forecast_csv.py with a CSV supplied by the user; select its value column and a horizon appropriate to the task.

## Input checks

- Confirm the observations are ordered in time and represent the same frequency.
- Report missing values, the observed context length, units, and any transformation.
- Use matched covariate arrays when calling forecast_with_covariates.

## Output checks

- Confirm the point forecast contains the requested horizon and the quantile array matches the model version.
- Check for nonfinite values and use named quantile indices from references/output_and_config.md.
- Keep historical observations separate from forecasts in every exported table and plot.
- Compute accuracy and interval coverage only against held-out observations supplied for this task.
- Record the model version and configuration with the user's output.

For API configuration, plotting, and multi-series input, read references/output_and_config.md and references/workflows.md.
`);
  edit("relsa-severity-assessment/SKILL.md", (text) => text
    .replace(/\| id \| treatment \| condition \| day \| temp \| weight \| score \| il6 \|\n(?:\|[^\n]*\|\n)+/g, "Required CSV columns: id, a time column, and the outcome variables being assessed. Optional treatment and condition columns can identify groups.\n")
    .replace(/`assets\/example_cohort\.csv` is a small synthetic cohort[\s\S]*?each one is runnable as written\./, "Supply your collected cohort as `input/cohort.csv`. Replace the variable names, group labels, animal IDs, and endpoint times below with values from your study. Set RELSA_REFERENCE_GROUP and RELSA_GROUP to COLUMN=VALUE selectors, RELSA_ANIMAL_IDS to your chosen IDs, and RELSA_ENDPOINT to one ID=TIME pair; repeat --endpoints for additional animals.")
    .replace(/### Assets[\s\S]*?(?=### Related skills)/, "")
    .replace(/assets\/example_cohort\.csv/g, "input/cohort.csv")
    .replace(/^```([^\n]*)\n([\s\S]*?)^```$/gm, (block, language) => language.trim() ? block : "The command reports values computed from your supplied cohort; retain those outputs with the reference model and methods.")
    .replace(/score explainable — here[\s\S]*?recovering:/, "score explainable for each animal in the supplied cohort:")
    .replace(/--animals [A-Za-z0-9,]+(?:\s+--endpoints [A-Za-z0-9=.,-]+)+/g, '--animals "$RELSA_ANIMAL_IDS" --endpoints "$RELSA_ENDPOINT"')
    .replace(/--animals [A-Za-z0-9,]+/g, '--animals "$RELSA_ANIMAL_IDS"')
    .replace("--reference-group condition=endpoint", '--reference-group "$RELSA_REFERENCE_GROUP"')
    .replace("--group treatment=treated", '--group "$RELSA_GROUP"'));
  edit("markdown-mermaid-writing/SKILL.md", (text) => text.replace(/### Examples\n[\s\S]*?(?=\n---)/, ""));
  const excludedReference = /example_cohort\.csv|temperature_anomaly\.csv|examples\/(?:global-temperature|anomaly-detection|covariates-forecasting)|example-research-report\.md|cell_summary_example\.md|medical_structured_abstract\.md|nature_abstract_examples\.md|neurips_introduction_example\.md/;
  for (const relative of allFiles(destination)) {
    if (relative === "plugin.json" || !/\.(?:md|json|txt|py|cjs|js|mjs)$/.test(relative)) continue;
    if (excludedReference.test(fs.readFileSync(path.join(destination, relative), "utf8"))) {
      throw new Error(`[copy-builtin-plugins] excluded Science demonstration reference survived: ${relative}`);
    }
  }
  return removed;
}

function rewritePublicIntegrity(destination) {
  const manifestPath = path.join(destination, "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.integrity) return;
  const files = allFiles(destination)
    .filter((relative) => relative !== "plugin.json")
    .sort((left, right) => left.localeCompare(right))
    .map((relative) => {
      const bytes = fs.readFileSync(path.join(destination, ...relative.split("/")));
      return { path: relative, sha256: sha256(bytes), bytes: bytes.length };
    });
  if (!files.length) throw new Error(`[copy-builtin-plugins] public integrity cannot be empty: ${manifest.slug}`);
  manifest.integrity = { algo: "sha256", files };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

function copyTree(src, dest) {
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // 호스트 소유 항목은 배포본에 없다
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else if (e.isFile()) { fs.copyFileSync(s, d); n += 1; }
    else throw new Error(`[copy-builtin-plugins] unsupported or linked public entry: ${s}`);
  }
  return n;
}

function countFiles(src) {
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = path.join(src, entry.name);
    if (entry.isDirectory()) n += countFiles(child);
    else if (entry.isFile()) n += 1;
    else throw new Error(`[copy-builtin-plugins] unsupported private verification entry: ${child}`);
  }
  return n;
}

if (!fs.existsSync(from)) {
  console.error(`[copy-builtin-plugins] no plugins/ at ${from}`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
let count = 0;
let excluded = 0;
const sourcePlugins = fs.readdirSync(from, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .sort((left, right) => left.name.localeCompare(right.name));
for (const plugin of sourcePlugins) {
  const allowed = RELEASE_TOP_LEVEL[plugin.name];
  if (!allowed) throw new Error(`[copy-builtin-plugins] release allowlist missing for ${plugin.name}`);
  const privateEntries = new Set(PRIVATE_TOP_LEVEL[plugin.name] || []);
  const entries = fs.readdirSync(path.join(from, plugin.name), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."));
  const classified = new Set([...allowed, ...privateEntries]);
  const unknown = entries.map((entry) => entry.name).filter((name) => !classified.has(name));
  if (unknown.length) {
    throw new Error(`[copy-builtin-plugins] unclassified public payload in ${plugin.name}: ${unknown.join(", ")}`);
  }
  const destination = path.join(to, plugin.name);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of allowed) {
    const source = path.join(from, plugin.name, name);
    if (!fs.existsSync(source)) throw new Error(`[copy-builtin-plugins] allowlisted entry missing: ${plugin.name}/${name}`);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`[copy-builtin-plugins] symlink forbidden: ${plugin.name}/${name}`);
    const target = path.join(destination, name);
    if (stat.isDirectory()) count += copyTree(source, target);
    else if (stat.isFile()) { fs.copyFileSync(source, target); count += 1; }
    else throw new Error(`[copy-builtin-plugins] unsupported entry: ${plugin.name}/${name}`);
  }
  for (const name of privateEntries) {
    const source = path.join(from, plugin.name, name);
    if (fs.existsSync(source)) excluded += countFiles(source);
  }
  rewritePrivateVerificationReferences(plugin.name, destination);
  const projectedOut = projectScienceSkillRuntime(plugin.name, destination);
  count -= projectedOut;
  excluded += projectedOut;
  rewritePublicIntegrity(destination);
}
// The packaged desktop runs the same canonical gate inside the builder flow.
// Keep the executable beside the compiled plugin builder so a distributed app
// does not silently fall back to a source-tree-only check.
const gateSource = path.resolve(__dirname, "plugin-spec-gate.cjs");
const gateTarget = path.resolve(__dirname, "..", "dist", "electron", "plugins", "plugin-spec-gate.cjs");
fs.mkdirSync(path.dirname(gateTarget), { recursive: true });
fs.copyFileSync(gateSource, gateTarget);
const publicPins = Object.fromEntries(RUNTIME_PINNED_PLUGINS.map((slug) => {
  const manifestPath = path.join(to, slug, "plugin.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`[copy-builtin-plugins] runtime-pinned public manifest missing: ${slug}`);
  return [slug, sha256(fs.readFileSync(manifestPath))];
}));
// 사이언스가 자기 저장소로 나가면서, 이 핀 파일은 사이언스 옆이 아니라 앱 산출물에 둔다.
// 사이언스는 호스트에게 위치를 물어본다 (electron/science-host.ts).
const pinsTarget = path.resolve(__dirname, "..", "dist", "electron", "public-plugin-manifest-pins.json");
fs.mkdirSync(path.dirname(pinsTarget), { recursive: true });
fs.writeFileSync(pinsTarget, `${JSON.stringify({
  schemaVersion: "agentlas.science-public-plugin-manifest-pins/v1",
  pins: publicPins,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
const slugs = fs.readdirSync(to, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
console.log(`[copy-builtin-plugins] ${slugs.length} package(s), ${count} public file(s), ${excluded} private verification file(s) excluded, ${Object.keys(publicPins).length} public manifest pin(s): ${slugs.join(", ")}`);
