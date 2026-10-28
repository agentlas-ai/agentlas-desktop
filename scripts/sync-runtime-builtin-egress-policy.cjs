"use strict";
// One declaration of the CLI built-in tools that leave the Agentlas approval boundary, for Desktop Main, daemon and
// standalone Terminal. `--check` fails when the Terminal copy is stale.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("typescript");
const source = path.resolve(__dirname, "../electron/runtime/runtime-builtin-egress-policy.ts");
const destination = path.resolve(__dirname, "../../agentlas_terminal/engine/runtime-builtin-egress-policy.cjs");
const text = fs.readFileSync(source, "utf8");
const hash = crypto.createHash("sha256").update(text).digest("hex");
const compiled = ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}, fileName: source }).outputText;
const output = `// Generated from agentlas_desktop/electron/runtime/runtime-builtin-egress-policy.ts; sha256 ${hash}.\n// Run node scripts/sync-runtime-builtin-egress-policy.cjs in Desktop; do not hand-edit.\n${compiled}`;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== output) {
    console.error("Terminal runtime built-in egress policy copy is stale"); process.exitCode = 1;
  }
} else fs.writeFileSync(destination, output);
