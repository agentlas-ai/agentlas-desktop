#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const page = fs.readFileSync(
  path.join(__dirname, "../renderer/app/(shell)/chat/page.tsx"),
  "utf8",
);

assert.match(
  page,
  /api\.appFactory\.listApps\(chatId\)[\s\S]{0,220}setAllGeneratedApps\(generatedApps\)/,
  "chat entry must load the persisted generated apps for that chat",
);
assert.match(
  page,
  /parseGeneratedAppChatRoute\(routeInput, allGeneratedApps\)/,
  "generated-app edit/archive routing must use the loaded app inventory",
);
assert.doesNotMatch(
  page,
  /parseGeneratedAppChatRoute\(routeInput,\s*\[\]\)/,
  "generated-app routing must never be hard-coded to an empty inventory",
);
assert.match(
  page,
  /generatedApps: allGeneratedApps/,
  "the composer must expose generated apps in its slash and mention directory",
);
assert.match(
  page,
  /setAllGeneratedApps\(\(apps\) => \[persisted,/,
  "restored app scaffolds must update the live generated-app inventory",
);
assert.match(
  page,
  /const record = result\.record;[\s\S]{0,160}setAllGeneratedApps\(\(apps\) => \[record,/,
  "new app scaffolds must update the live generated-app inventory",
);

// Execute the actual action detector from the page so app-name substrings cannot
// silently turn ordinary chat into a generated-app edit invocation.
const sourceFile = ts.createSourceFile("chat-page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
for (const statement of sourceFile.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(sourceFile);
      if (name === "GENERATED_APP_EDIT_TERMS" || name === "GENERATED_APP_ARCHIVE_TERMS") {
        declarations.set(name, statement.getText(sourceFile));
      }
    }
  } else if (ts.isFunctionDeclaration(statement) && statement.name) {
    const name = statement.name.text;
    if (name === "normalizeGeneratedAppText" || name === "detectGeneratedAppAction") {
      declarations.set(name, statement.getText(sourceFile));
    }
  }
}
for (const name of [
  "GENERATED_APP_EDIT_TERMS",
  "GENERATED_APP_ARCHIVE_TERMS",
  "normalizeGeneratedAppText",
  "detectGeneratedAppAction",
]) {
  assert.ok(declarations.has(name), `missing generated-app routing declaration: ${name}`);
}
const detectorSource = [
  declarations.get("GENERATED_APP_EDIT_TERMS"),
  declarations.get("GENERATED_APP_ARCHIVE_TERMS"),
  declarations.get("normalizeGeneratedAppText"),
  declarations.get("detectGeneratedAppAction"),
  "module.exports = { detectGeneratedAppAction };",
].join("\n");
const detectorModule = { exports: {} };
const detectorJs = ts.transpileModule(detectorSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("module", "exports", detectorJs)(detectorModule, detectorModule.exports);
const { detectGeneratedAppAction } = detectorModule.exports;
assert.equal(detectGeneratedAppAction("Open Credit Dashboard"), null, "Credit must not imply the edit verb");
assert.equal(detectGeneratedAppAction("Show Prefix Tool"), null, "Prefix must not imply the fix verb");
assert.equal(detectGeneratedAppAction("Fix Credit Dashboard"), "edit");
assert.equal(detectGeneratedAppAction("크레딧 앱을 수정해줘"), "edit");
assert.equal(detectGeneratedAppAction("Archive Credit Dashboard"), "archive");

console.log("generated app chat routing contracts ok");
