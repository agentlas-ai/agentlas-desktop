#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const shared = read("shared/types.ts");
assert.match(shared, /openCrabOntology\?: "use" \| "skip"/);
assert.match(shared, /useOpenCrab\?: boolean/);
assert.match(shared, /openCrab\?: OpenCrabEnrichment/);
assert.match(shared, /openCrab:\s*\{\s*readiness:/s);
const registry = read("electron/mcp-tools/registry.ts");
const mcpClient = read("electron/mcp-tools/client.ts");
const mcpConfig = read("electron/mcp-tools/mcp-config.ts");
const mcpPage = read("renderer/app/(shell)/library/mcps/page.tsx");
assert.match(registry, /isOpenCrabCredentialUrl\(def\.url \?\? ""\)/);
assert.match(registry, /Use the \$\{OPENCRAB_CATALOG_ID\} catalog connection/);
assert.match(registry, /scrubLegacyOpenCrabCredentialUrls/);
assert.match(registry, /secure_delete = ON/);
assert.match(registry, /residualBytesBefore/);
assert.match(registry, /assertLiveCheckpointComplete/);
assert.match(mcpConfig, /scrubLegacyOpenCrabMcpConfig/);
assert.match(mcpConfig, /overwriteAndRemovePrivateFile/);
assert.match(mcpConfig, /s\.catalogId === OPENCRAB_CATALOG_ID/);
assert.match(mcpConfig, /isOpenCrabCredentialUrl\(s\.url\)/);
// vault:// sentinel URL은 keychain에서 해석해 불투명 alias 참조로만 직렬화하고,
// Codex(argv 노출)에는 절대 싣지 않는다.
assert.match(mcpConfig, /vaultUrlKey\(s\.url\)/);
assert.match(mcpConfig, /!isVaultBackedRemoteUrl\(s\.url\) && isOpenCrabCredentialUrl\(s\.url\)/);
assert.match(mcpConfig, /if \(vaultKey\) codexRemoteSupported = false;/);
assert.match(mcpConfig, /serializedUrl = envReference\(alias\)/);
assert.match(mcpConfig, /agentlas-mcp\\\.json\\\.\\d\+/);
assert.match(mcpClient, /openCrabNoRedirectFetch/);
assert.match(mcpClient, /redirect: "error"/);
assert.match(mcpClient, /!secureOpenCrab && \(isOpenCrabCredentialUrl\(server\.url\)/);
assert.match(mcpPage, /customOpenCrabUrl/);
assert.match(mcpPage, /URL이 키체인에만 남도록 아래 OpenCrab 카탈로그 카드에서 연결하세요/);

const preload = read("electron/preload.ts");
const ipc = read("electron/ipc.ts");
assert.match(preload, /openCrab:\s*\{\s*readiness: \(\) => ipcRenderer\.invoke\("openCrab:readiness"\)/s);
assert.match(ipc, /ipcMain\.handle\("openCrab:readiness"/);
assert.match(ipc, /case "missing_endpoint":[\s\S]{0,220}state: "needs-credential"/);
assert.match(ipc, /case "disabled":[\s\S]{0,180}state: "disabled"/);

const builder = read("electron/hephaestus/builder.ts");
const buildAccess = read("electron/hephaestus/build-access.ts");
const buildSession = read("renderer/lib/build-session.ts");
const buildPage = read("renderer/app/(shell)/build/page.tsx");
assert.match(builder, /kind: "opencrab-ontology"/);
assert.match(builder, /hasConfiguredOpenCrab\(\)/, "Build pre-consent check must stay local-only");
assert.match(builder, /hasValidBuilderInterviewQuestion\(resultText\)/, "OpenCrab must never create a lone interview question");
assert.match(builder, /supplementalQuestion = openCrabInterviewQuestion\(locale\)/);
assert.match(builder, /satisfies HephaestusBuildResult/);
assert.match(builder, /req\.history\?\.find\(\(entry\) => entry\.role === "user"\)\?\.text \?\? req\.request/);
assert.match(builder, /queryOpenCrabContext\(originalRequest/);
assert.doesNotMatch(
  builder.match(/queryOpenCrabContext\(originalRequest[\s\S]*?\);/)?.[0] ?? "",
  /attachments|workspace/,
  "Build must not send attachments or workspace paths to OpenCrab",
);
assert.match(builder, /deriveOpenCrabMatchSignal\(originalRequest, enrichment\.context\)/);
assert.match(builder, /JSON\.stringify\(matchSignal\)/);
assert.doesNotMatch(builder, /userPrompt \+= [\s\S]{0,400}enrichment\.context/, "full-permission Build must never receive raw ontology text");
assert.doesNotMatch(builder, /validatedExternalFacts|facts: validatedFacts/);
assert.match(buildAccess, /openCrabOntology: request\.openCrabOntology === "use"/);
assert.match(buildSession, /openCrabOntology: openCrabOntologyForTurn/);
assert.match(buildSession, /openCrabOntologyChoice === openCrabOntologyForTurn[\s\S]{0,100}openCrabOntologyChoice = undefined/);
assert.match(buildSession, /openCrabOntologyChoice = undefined/g);
assert.match(buildSession, /mainOwnedOpenCrabQuestion\(result\?\.supplementalQuestion\)/);
assert.match(buildSession, /\[\.\.\.parsed\.questions, supplementalQuestion\]/);
assert.match(buildPage, /question\?\.multiSelect[\s\S]{0,260}: \[label\]/, "single-select questions must be mutually exclusive");
assert.match(buildPage, /openCrabSelection === openCrabQuestion\.options\[0\]\?\.label/);
assert.match(buildPage, /\? "use"[\s\S]{0,40}: "skip"/, "missing/negative consent must fail closed to skip");

// A model-authored reserved key must stay message-scoped and can never become
// product consent. The stable ID arrives only through the typed main result.
const askSource = read("renderer/lib/ask-question.ts");
const askCompiled = ts.transpileModule(askSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const askModule = { exports: {} };
new Function("exports", "module", "require", askCompiled)(askModule.exports, askModule, require);
const parsedQuestion = askModule.exports.extractQuestions(
  'before<<agentlas-ask>>\n{"key":"opencrab-ontology","question":"Use it?","multiSelect":false,"options":[{"label":"Use"},{"label":"Skip"}]}\n<</agentlas-ask>>after',
  "turn-1",
);
assert.equal(parsedQuestion.questions.length, 1);
assert.equal(parsedQuestion.questions[0].id, "turn-1-q0");
assert.equal(parsedQuestion.questions[0].multiSelect, false);
assert.equal(parsedQuestion.text, "beforeafter");

const trex = read("electron/trex/content.ts");
const trexPage = read("renderer/app/(shell)/trex/page.tsx");
assert.match(trex, /queryOpenCrabContext\(clean,/);
assert.doesNotMatch(
  trex.match(/queryOpenCrabContext\(clean,[\s\S]*?\);/)?.[0] ?? "",
  /src|sourcesText/,
  "T-rex may send only the topic, never attached source bodies",
);
assert.match(trex, /OPTIONAL OPENCRAB MATCH SIGNAL \(main-owned metadata only; no ontology text is included/);
assert.match(trex, /deriveOpenCrabMatchSignal\(clean, enrichment\.context\)/);
assert.doesNotMatch(trex, /OPENCRAB ONTOLOGY REFERENCE|\$\{ontologyContext\}/);
assert.match(trex, /openCrabOptIn \? "trex-opencrab" : "trex"/);
assert.match(trex, /finish\(\{ ok: false, reason: "no-llm-runtime" \}\)/, "OpenCrab metadata must survive the standard fallback");
assert.match(trexPage, /openCrabReadiness\?\.state === "ready"/);
assert.match(trexPage, /aiContent && openCrabReadiness\?\.state === "ready"/);
assert.match(trexPage, /useOpenCrab: openCrabEnabled/);
assert.match(trexPage, /OpenCrab 보강 건너뜀 — 기본 생성 계속/);

const planner = read("electron/oberon/planner.ts");
const oberonPage = read("renderer/app/(shell)/oberon/page.tsx");
const briefWizard = read("renderer/components/oberon/BriefWizard.tsx");
const planStep = read("renderer/components/oberon/PlanStep.tsx");
assert.match(planner, /queryOpenCrabContext\(openCrabQuery,/);
assert.match(planner, /deriveOpenCrabMatchSignal\(openCrabQuery, enrichment\.context\)/);
assert.match(planner, /openCrabMatchSignalPolicy:[\s\S]{0,220}no ontology text is included/);
assert.doesNotMatch(planner, /ontologyContext[,\n]|ontologyContextPolicy/);
const queryBuilder = planner.match(/function buildOpenCrabQuery[\s\S]*?\n\}/)?.[0] ?? "";
assert.ok(queryBuilder, "Oberon needs a bounded query projection");
assert.doesNotMatch(queryBuilder, /logoSource|visualReferences|characters/, "local assets and character identity details stay out of the OpenCrab query");
assert.match(queryBuilder, /slice\(0, max\)/);
assert.match(oberonPage, /useOpenCrab: useOpenCrab && openCrabReadiness\?\.state === "ready"/);
assert.match(oberonPage, /setUseOpenCrab\(false\)/);
assert.match(briefWizard, /OpenCrab 근거/);
assert.match(briefWizard, /로컬 경로가 포함된 값과 로고 필드는 보내지 않습니다/);
assert.match(planStep, /OpenCrab 보강은 건너뛰고 기존 기획 흐름으로 계속했습니다/);
assert.match(planStep, /planningRun\?\.ok === true && planningRun\.openCrab\?\.used === true/);

// A path-credential-shaped token must never be committed as a concrete value.
const repositoryFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
).toString("utf8").split("\0").filter(Boolean);
for (const relative of repositoryFiles) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const bytes = fs.readFileSync(absolute);
  if (bytes.subarray(0, 8_192).includes(0)) continue;
  assert.doesNotMatch(bytes.toString("utf8"), /ocm_[A-Za-z0-9_-]{20,}/, `${relative} contains a credential-shaped value`);
}

console.log(JSON.stringify({ ok: true, checks: 62 }, null, 2));
