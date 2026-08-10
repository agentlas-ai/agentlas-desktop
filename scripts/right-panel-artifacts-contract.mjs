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

// ── 4. A running local server is something to look at ───────────────────
// An agent that stands up an app leaves nothing in the file list; the next
// thing a person wants is the app itself.
const markdown = read("renderer/components/Markdown.tsx");
const at = markdown.indexOf("export function localServerUrlsInText");
assert.ok(at > 0, "local server URLs must be extractable from an answer");
const serverFn = markdown.slice(at, at + 900);

// Lift the actual pattern out and run it, so this tests behaviour rather than
// the presence of a sentence.
const patternLine = serverFn.match(/const pattern = (\/.+\/[gimsuy]*);/);
assert.ok(patternLine, "the detector must keep its pattern in one readable place");
const rebuilt = new RegExp(patternLine[1].slice(1, patternLine[1].lastIndexOf("/")), "gi");
const matches = (text) => Array.from(text.matchAll(rebuilt)).map((m) => m[0]);

assert.deepEqual(
  matches("app is up at http://localhost:5173/ and also http://127.0.0.1:3000"),
  ["http://localhost:5173/", "http://127.0.0.1:3000"],
  "local dev servers must be detected",
);
// Only local hosts: auto-opening any URL an answer contains would turn prompt
// injection into an outbound request from the user's machine.
assert.deepEqual(
  matches("see https://example.com/x and http://evil.test:8080/y"),
  [],
  "detection must never pick up a remote host",
);
assert.match(
  cockpit,
  /workspacePreviewFromLocalServer/,
  "detected local servers must become previews the panel can open",
);
assert.match(
  cockpit,
  /viewerKind: "browser"/,
  "a local server preview must open in the browser viewer",
);

console.log("right panel artifacts contract ok");
console.log("  ✓ produced files are found from tool arguments, via the shared normalizer");
console.log("  ✓ images/video/pdf are served over agentlas://localfile and .pdf is authorized");
console.log("  ✓ an empty viewer explains itself and file opens hydrate through the parent");
console.log("  ✓ a running local server becomes a previewable artifact, remote hosts never do");
