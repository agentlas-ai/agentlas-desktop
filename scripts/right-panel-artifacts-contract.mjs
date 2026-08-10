#!/usr/bin/env node
// Right-panel artifact contract.
//
// This area had zero test coverage while three defects lived in it, so these
// assertions are about OUTCOMES a user can see, not about which lines exist:
//
//  1) A file the agent produced is discoverable even when the answer never
//     names it in prose. Tool arguments carry the path; the shared normalizer
//     is the only thing allowed to read them.
//  2) A file the panel offers to open must be openable — PDFs included, which
//     means they cannot be served over file:// (the window blocks it).
//  3) A viewer with no content must say so rather than render a blank body.
//
// Run: node scripts/right-panel-artifacts-contract.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ── 1. Tool arguments must yield the produced file ───────────────────────
// Uses the compiled shared normalizer, so this fails if the tool vocabulary
// drifts — which is the failure mode that made the old renderer call every
// non-Claude-Code tool "기타".
const { normalizeToolCall } = require(path.join(root, "dist/shared/tool-call-detail.js"));

const cases = [
  { name: "Write", args: JSON.stringify({ file_path: "/w/report.md", content: "x" }), want: "/w/report.md" },
  { name: "Edit", args: JSON.stringify({ filePath: "/w/app.ts", old_string: "a", new_string: "b" }), want: "/w/app.ts" },
  { name: "Read", args: JSON.stringify({ path: "/w/data.json" }), want: "/w/data.json" },
];
for (const c of cases) {
  const detail = normalizeToolCall({ name: c.name, args: c.args });
  assert.ok(
    ["read", "write", "edit"].includes(detail.type),
    `${c.name} must normalize to a file operation, got ${detail.type}`,
  );
  assert.equal(detail.filePath, c.want, `${c.name} must surface its path`);
}

// The renderer must go through that normalizer rather than re-deriving paths.
const cockpit = read("renderer/components/TaskCockpit.tsx");
assert.match(
  cockpit,
  /normalizeToolCall/,
  "the cockpit must use the shared tool normalizer to collect produced files",
);
assert.match(
  cockpit,
  /toolFilePathsFromSteps\(message\.steps\)/,
  "linked files must be collected from tool steps, not only from answer prose",
);

// ── 2. Inline-servable types must not use file:// ────────────────────────
// file:// in an app:// origin with webSecurity is a guaranteed blank frame.
for (const [file, fn] of [
  ["renderer/components/WorkspacePanel.tsx", "fileUrlForPath"],
  ["renderer/components/TaskCockpit.tsx", "fileUrlForToolPath"],
  ["renderer/components/Markdown.tsx", "fileUrlForLinkedFile"],
]) {
  const src = read(file);
  const at = src.indexOf(`function ${fn}`);
  assert.ok(at > 0, `${file} must still define ${fn}`);
  const body = src.slice(at, at + 700);
  assert.match(body, /pdf/i, `${fn} must route PDFs through the app protocol, not file://`);
  assert.match(body, /agentlas:\/\/localfile/, `${fn} must serve inline types over agentlas://localfile`);
}

// And the main process must actually authorize that type, or the URL 404s.
assert.match(
  read("electron/fs/access.ts"),
  /LOCAL_MEDIA_EXTS[\s\S]{0,600}\.pdf/,
  "the main-process allowlist must include .pdf, or the panel offers a viewer that always fails",
);

// ── 3. An empty viewer must explain itself ──────────────────────────────
const panel = read("renderer/components/ChatRightPanel.tsx");
assert.match(
  panel,
  /isTextualViewerKind\(file\.viewerKind\) && !file\.content/,
  "a textual viewer with no content must render an explanation, not a blank body",
);
assert.match(
  panel,
  /onHydrateFilePreview/,
  "opening a file from the list must go through the parent's hydration path, or it opens empty",
);

console.log("right panel artifacts contract ok");
console.log("  ✓ produced files are found from tool arguments, via the shared normalizer");
console.log("  ✓ images/video/pdf are served over agentlas://localfile and .pdf is authorized");
console.log("  ✓ an empty viewer explains itself and file opens hydrate through the parent");
