#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../node_modules/agentlas-science/ui/app.js", import.meta.url), "utf8");
const start = source.indexOf("// RESULT_ARTIFACT_ROUTE_HELPER_START");
const end = source.indexOf("// RESULT_ARTIFACT_ROUTE_HELPER_END");
assert.ok(start >= 0 && end > start, "production result-artifact route helper markers must exist");

const body = source.slice(start, end).replace(/^\s*\/\/ RESULT_ARTIFACT_ROUTE_HELPER_START\s*/u, "");
const mergePreferredLabContext = new Function(`${body}\nreturn mergePreferredLabContext;`)();

const preferred = {
  artifact: { id: "artifact-avian-table", projectId: "project-dinosaur" },
  linkage: { labId: "comparative-genomics" },
};
const other = {
  artifact: { id: "artifact-other", projectId: "project-dinosaur" },
  linkage: { labId: "comparative-genomics" },
};

assert.deepEqual(
  mergePreferredLabContext([], preferred, "project-dinosaur", "comparative-genomics"),
  [preferred],
  "an exact result context must survive an empty forLab refresh",
);
assert.deepEqual(
  mergePreferredLabContext([other, preferred], preferred, "project-dinosaur", "comparative-genomics"),
  [preferred, other],
  "the exact result context must be first and deduplicated",
);
assert.deepEqual(
  mergePreferredLabContext([other], preferred, "project-other", "comparative-genomics"),
  [other],
  "a context from another project must never be injected",
);
assert.deepEqual(
  mergePreferredLabContext([other], preferred, "project-dinosaur", "statistics-analysis"),
  [other],
  "a context from another Lab must never be injected",
);

assert.match(source, /openLab\(context\.linkage\.labId, artifactId, null, null, artifactVersion, context\)/u);
console.log("result-artifact-route-contract: ok");
