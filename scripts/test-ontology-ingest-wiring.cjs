#!/usr/bin/env node
// Guards the wiring that keeps the folder ontology from staying empty.
//
// Every chat turn queries the folder ontology read-only so a slow ingest never
// blocks the answer — but the read-only path (existingWorkingFolderOntology)
// never ingests, and no renderer path calls the ingesting sync, so the DB stayed
// provisioned-but-empty (0 rows across projects) even though the Python ingest
// itself works. The fix is a background ingest kicked off from a write-authority
// turn. These are source assertions: they fail if the query stops being
// read-only, or if the background ingest call is dropped or its guard widened.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const client = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp", "client.ts"), "utf8");
const runtime = fs.readFileSync(
  path.join(__dirname, "..", "electron", "ontology", "project-runtime.ts"),
  "utf8",
);

// The query must stay read-only — that is what keeps a slow ingest off the
// answer's critical path.
assert.match(
  client,
  /queryWorkingFolderOntologyContext\(memoryReadPath, effectiveUserPrompt, \{\s*readOnly: projectReadOnlyBoundary,/,
  "the folder ontology query must remain read-only on the turn's critical path",
);

// The background ingest must be called, and only when the turn has real write
// authority over an activated folder — never on a read-only or restricted turn,
// which would either do nothing or cross the mobile/automation boundary.
assert.match(
  client,
  /if \(activePath && canWrite && !restrictedReadBoundary\) \{\s*ingestWorkingFolderOntologyInBackground\(memoryReadPath\);/,
  "background ingest must run only on a write-authority, non-restricted turn with an active folder",
);

// It must be genuinely fire-and-forget (not awaited), or a slow ingest would
// block the turn it was designed to stay out of.
assert.match(
  runtime,
  /export function ingestWorkingFolderOntologyInBackground\(projectFolder: string\): void \{\s*void ensureWorkingFolderOntologyReady\(projectFolder\)\.catch\(/,
  "the background ingest must be void/fire-and-forget with its own catch",
);

// The ingest must go through ensureWorkingFolderOntologyReady, which is the
// idempotent path (dedupes concurrent runs, skips when the index is unchanged) —
// not a raw re-ingest that would run the Python CLI on every eligible turn.
assert.match(
  runtime,
  /async function ensureWorkingFolderOntologyReady[\s\S]*?const existing = workingFolderQueues\.get\(projectPath\);\s*if \(existing\) return existing;/,
  "ensureWorkingFolderOntologyReady must dedupe concurrent runs via workingFolderQueues",
);
assert.match(
  runtime,
  /const shouldSync =[\s\S]*?if \(!shouldSync\) return \{ projectPath, dbPath, indexPath, synced: false \};/,
  "ensureWorkingFolderOntologyReady must skip the ingest when nothing changed",
);

console.log("ontology ingest wiring: PASS (read-only query, guarded fire-and-forget ingest, idempotent sync)");
