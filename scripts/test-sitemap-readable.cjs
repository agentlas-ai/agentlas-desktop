#!/usr/bin/env node
// Keeps the project sitemap injectable.
//
// The generator's default entry cap was 25_000, which on a real workspace
// produced a 13MB sitemap.json. Injection reads it through the 2MB memory text
// cap, so the file read as null and the sitemap silently stopped being injected
// — the same shape as the dead code map. Two guards keep it readable: a coarser
// default node cap so the file stays small, and a dedicated larger read cap so
// an already-large file is still readable rather than dropped.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const artifacts = fs.readFileSync(
  path.join(__dirname, "..", "electron", "memory", "project-artifacts.ts"),
  "utf8",
);
const safeRead = fs.readFileSync(
  path.join(__dirname, "..", "electron", "memory", "safe-project-read.ts"),
  "utf8",
);
const context = fs.readFileSync(
  path.join(__dirname, "..", "electron", "memory", "context.ts"),
  "utf8",
);

// The default entry cap must stay small enough that a normal repo's sitemap
// fits well under any read cap. 25_000 produced 13MB; the cap must be far below
// that.
const defaultCap = Number(
  (artifacts.match(/SITEMAP_DEFAULT_MAX_ENTRIES\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ""),
);
assert.ok(Number.isInteger(defaultCap), "SITEMAP_DEFAULT_MAX_ENTRIES must be a number");
assert.ok(
  defaultCap <= 5_000,
  `sitemap default entry cap must stay small (was ${defaultCap}); 25_000 produced a 13MB unreadable file`,
);

// A dedicated read cap must exist and be large enough to read a big existing
// sitemap, and summarizeSitemap must actually pass it (not fall back to the 2MB
// text default that dropped the file).
assert.match(safeRead, /export const PROJECT_SITEMAP_MAX_BYTES = \d+ \* 1024 \* 1024;/);
const sitemapCap = Number((safeRead.match(/PROJECT_SITEMAP_MAX_BYTES = (\d+) \* 1024 \* 1024/) || [])[1]);
assert.ok(sitemapCap >= 16, `sitemap read cap must be generous (was ${sitemapCap}MB)`);
assert.match(
  context,
  /readActivatedProjectMemoryJson<\{ nodes\?: unknown\[\] \}>\(\s*projectPath,\s*SITEMAP_FILE,\s*PROJECT_SITEMAP_MAX_BYTES,/,
  "summarizeSitemap must read with the dedicated sitemap cap, not the default text cap",
);

// The generator actually honors the default cap: generate against this repo and
// confirm the node count and serialized size stay bounded.
async function main() {
  process.env.AGENTLAS_E2E = "1";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-sitemap-"));
  app.setPath("userData", path.join(tmp, "user-data"));
  // A stable fixture tree, wider than the default cap, so the generator runs
  // against something that cannot mutate mid-traversal (scanning the live repo
  // races the build) and the cap is actually exercised.
  const fixture = path.join(tmp, "repo");
  for (let d = 0; d < 60; d += 1) {
    const dir = path.join(fixture, `pkg-${d}`, "src");
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 20; f += 1) fs.writeFileSync(path.join(dir, `mod-${f}.ts`), "export const x = 1;\n");
  }
  const { generateProjectSitemap } = require("../dist/electron/memory/project-artifacts.js");
  const sitemap = generateProjectSitemap(fixture);
  const bytes = Buffer.byteLength(JSON.stringify(sitemap), "utf8");
  assert.ok(sitemap.nodes.length >= 1, "sitemap must have at least the root node");
  assert.ok(
    sitemap.nodes.length <= defaultCap,
    `generated sitemap must honor the default cap (${sitemap.nodes.length} > ${defaultCap})`,
  );
  assert.ok(
    bytes <= sitemapCap * 1024 * 1024,
    `generated sitemap must be readable under its cap (${(bytes / 1048576).toFixed(1)}MB)`,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    `sitemap readable: PASS (default cap ${defaultCap}, generated ${sitemap.nodes.length} nodes / ${(bytes / 1048576).toFixed(1)}MB, read cap ${sitemapCap}MB)`,
  );
}

const { app } = require("electron");
app.whenReady().then(main).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
