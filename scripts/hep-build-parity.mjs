#!/usr/bin/env node
// Desktop Build ↔ terminal /hep-build parity gate.
//
// Owner rule 2026-08-16: "데스크탑의 빌드 = 터미널에서 hep-build 돌리는데 GUI만
// 붙인 것. 둘이 토씨 하나라도 다르면 안 된다."
//
// Prose promises ("we ship the canonical prompt") drifted for months without
// anyone noticing, because nothing compared bytes. This gate builds the real
// Desktop system prompt and asserts each canonical source appears inside it
// VERBATIM — exact substring, no normalization beyond CRLF. A single edited word
// fails the gate and names the first differing line.
//
// Run: node scripts/hep-build-parity.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REQUEST = "천안상록리조트 중장기 경영전략 기획하는 에이전트";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "Hephaestus");

const { composeBuilderPrompt } = require(path.join(ROOT, "dist/electron/hephaestus/builder.js"));

const read = (rel) => fs.readFileSync(path.join(ENGINE, rel), "utf8").replace(/\r\n/g, "\n");

// The prompt Desktop actually sends, per build mode. All three modes must ship the
// same canonical bundle — a mode that quietly gets less is a mode that builds worse.
const MODES = ["single", "team", "package"];
const MODE_BUILDER = {
  single: "agents/10-single-agent-builder/agent.md",
  team: "agents/20-multi-agent-team-builder/agent.md",
  package: "agents/30-agentlas-packager/agent.md",
};
const promptFor = (mode) => composeBuilderPrompt(
  ENGINE,
  {
    request: REQUEST,
    workspace: path.join(ROOT, "tmp"),
    mode,
    mcpConsent: { planId: null, selectedCandidateIds: [] },
  },
  "ko",
).replace(/\r\n/g, "\n");
const prompts = Object.fromEntries(MODES.map((m) => [m, promptFor(m)]));
const prompt = prompts.single;

const failures = [];

/** Assert `body` appears verbatim inside the prompt; report the first missing line. */
function assertVerbatim(label, body, { dropFrontmatter = false, args = null } = {}) {
  let text = body.trimEnd();
  if (dropFrontmatter && text.startsWith("---\n")) {
    text = text.slice(text.indexOf("\n---\n", 3) + 5).trimStart();
  }
  // `$ARGUMENTS` is the slash-command placeholder the host substitutes. Comparing
  // after the same substitution is still byte-parity; deleting the block is not.
  if (args !== null) text = text.replaceAll("$ARGUMENTS", args);
  if (prompt.includes(text)) {
    console.log(`  PASS  ${label} — ${text.split("\n").length} lines verbatim`);
    return;
  }
  // Locate the first line that is missing, so the failure is actionable.
  const lines = text.split("\n").filter((line) => line.trim().length > 8);
  const missing = lines.find((line) => !prompt.includes(line));
  failures.push(
    `${label}: not shipped verbatim`
    + (missing ? `\n        first missing line: ${JSON.stringify(missing.slice(0, 110))}` : "\n        (present line-by-line but not contiguous — a Desktop edit split it)"),
  );
  console.log(`  FAIL  ${label}`);
}

console.log("\n== Canonical sources must reach the model unedited ==");
assertVerbatim(
  "/hep-build command definition",
  read("claude/plugins/agentlas-core-engine-meta-agent/commands/hep-build.md"),
  { dropFrontmatter: true, args: REQUEST },
);
const gate = read("contracts/builder-interview-research-gate.md");
assertVerbatim("Builder Interview and Research Gate", gate);
assertVerbatim("Canonical AGENTS.md", read("AGENTS.md"));
assertVerbatim("Active builder (single)", read("agents/10-single-agent-builder/agent.md"));

// Every canonical AGENTS.md section must survive. A future "context economy"
// projection is exactly how 84% went missing last time.
console.log("\n== Every canonical section present ==");
const sections = read("AGENTS.md").split("\n").filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
const lostSections = sections.filter((name) => !prompt.includes(`## ${name}`));
if (lostSections.length === 0) console.log(`  PASS  ${sections.length}/${sections.length} sections`);
else failures.push(`AGENTS.md sections dropped: ${lostSections.join(", ")}`);

// Canonical step 5/9/10 name engine commands. Shipping the text but never running
// the commands is the other half of the drift.
console.log("\n== Canonical engine commands have a Desktop caller ==");
const builderSrc = fs.readFileSync(path.join(ROOT, "electron/hephaestus/builder.ts"), "utf8");
for (const [step, call] of [
  ["contract scaffold (step 5)", "contractScaffold("],
  ["contract complete (step 5)", "contractComplete("],
  ["cards migrate (step 9)", "cardsMigrate("],
  ["contract verify (step 10)", "contractVerify("],
]) {
  if (builderSrc.includes(call)) console.log(`  PASS  ${step}`);
  else failures.push(`${step}: no Desktop caller (${call})`);
}

// ── /hep-upload parity ──────────────────────────────────────────────────────
// Upload is not prompt-driven in Desktop (direct IPC), so byte-parity of a prompt
// does not apply. What must match is the BEHAVIOUR the canonical gate defines:
// one explicit publish call, both destinations offered, and never package-then-publish.
console.log("\n== /hep-upload behaviour parity ==");
const uploadDoc = read("claude/plugins/agentlas-core-engine-meta-agent/commands/hep-upload.md");
const binGate = read("bin/hephaestus");
const cmdsSrc = fs.readFileSync(path.join(ROOT, "electron/hephaestus/commands.ts"), "utf8");
const cloudPage = fs.readFileSync(path.join(ROOT, "renderer/app/(shell)/cloud/page.tsx"), "utf8");

// 1) The canonical gate runs exactly `publish <target> --visibility <v>`.
const canonicalRunsPublish = /run_python_module agentlas_cloud publish "\$target" --visibility/.test(binGate);
// 2) Desktop must run the same single command.
const desktopRunsPublish = /const args = \["publish", assertPositional\(folder, "folder"\), "--visibility", visibility\]/.test(cmdsSrc);
// 3) Canonical forbids package-then-publish. Desktop must not call `package` on the upload path.
const packageIsDead = !/agentlas\.hephaestus[\s\S]{0,40}\.package\(/.test(cloudPage) && !/\.package\(/.test(cloudPage);
// 4) Both destinations must be offered before uploading.
const offersBoth = cloudPage.includes('upload("private-link")') && cloudPage.includes('upload("marketplace")');
// 5) Canonical: findings are advisory and must never block the upload.
const advisoryRule = uploadDoc.includes("All security and content findings are advisory");

for (const [label, ok] of [
  ["canonical gate runs `publish --visibility`", canonicalRunsPublish],
  ["Desktop runs the same single `publish --visibility`", desktopRunsPublish],
  ["Desktop never calls `package` on the upload path", packageIsDead],
  ["Desktop offers both Cloud and Hub destinations", offersBoth],
  ["canonical states findings are advisory (never block)", advisoryRule],
]) {
  if (ok) console.log(`  PASS  ${label}`);
  else failures.push(`/hep-upload: ${label}`);
}

// ── no hardcoded interview anywhere ─────────────────────────────────────────
// The interview must be composed by the model from the request. A fixed question
// array in the renderer bypasses the canonical gate entirely and cannot be seen
// by the prompt checks above — that is exactly how a static four-question batch
// shipped and asked the same thing for every agent (measured 2026-08-16).
console.log("\n== No renderer-side fixed interview ==");
const sessionSrc = fs.readFileSync(path.join(ROOT, "renderer/lib/build-session.ts"), "utf8");
const startsWithFixedBatch = /state\.phase = "interview";\s*\n\s*state\.pendingQuestions = mainOwnedBuildBriefQuestions/.test(sessionSrc);
if (!startsWithFixedBatch) console.log("  PASS  build start goes to the engine, not a fixed question array");
else failures.push("build start still opens a hardcoded question batch before the engine");

// ── the prompt must actually be dispatchable ────────────────────────────────
// Shipping the canonical verbatim is worthless if the runtime refuses to send it.
// Measured 2026-08-16: the bundle was 74,807 chars against a 47,232 ceiling, the
// assembly threw, nothing caught it, and every build hung at "Starting the AI
// engine" with no error. Parity must include "it fits".
console.log("\n== Assembled prompt is dispatchable ==");
const runnerJs = fs.readFileSync(path.join(ROOT, "dist/electron/runtime/runner.js"), "utf8");
const cap = Number(/MAX_BUILD_SYSTEM_PROMPT_CHARS = (\d[\d_]*)/.exec(runnerJs)?.[1]?.replace(/_/g, "") ?? 0);
const reserve = Number(/BUILD_MCP_DEGRADED_GUARD_RESERVE_CHARS = (\d[\d_]*)/.exec(runnerJs)?.[1]?.replace(/_/g, "") ?? 0);
const budget = cap - reserve;
// The wrapper adds a header; measure the real wrapped size, not just the body.
const { wrapBuildSystemPrompt } = require(path.join(ROOT, "dist/electron/runtime/runner.js"));
let wrapped = null;
try { wrapped = wrapBuildSystemPrompt(prompt, "ko"); } catch (e) { failures.push(`wrapBuildSystemPrompt threw: ${e.message}`); }
if (wrapped) {
  const headroom = budget - wrapped.length;
  if (headroom > 0) console.log(`  PASS  ${wrapped.length.toLocaleString()} / ${budget.toLocaleString()} chars (headroom ${headroom.toLocaleString()})`);
  else failures.push(`assembled prompt ${wrapped.length} exceeds budget ${budget}`);
}

// ── the interview must be witnessed by the host ─────────────────────────────
// Model-authored records are claims. Three shipped packages carried
// `source: "user"` tags and a full interview document for an interview that
// never happened (measured 2026-08-17). Only a host-written receipt is evidence.
console.log("\n== Interview receipt is host-written ==");
const builderJs = fs.readFileSync(path.join(ROOT, "dist/electron/hephaestus/builder.js"), "utf8");
const { hostObservedInterview } = require(path.join(ROOT, "dist/electron/hephaestus/builder.js"));
const ASK = '<<agentlas-ask>>{"question":"q","options":[{"label":"a"},{"label":"b"}]}<</agentlas-ask>>';
const checks = [
  ["no questions at all", [{ role: "user", text: "r" }, { role: "assistant", text: "BUILD_COMPLETE: x" }], 0],
  ["asked but unanswered", [{ role: "user", text: "r" }, { role: "assistant", text: ASK }], 0],
  ["asked and answered", [{ role: "user", text: "r" }, { role: "assistant", text: ASK }, { role: "user", text: "a" }], 1],
];
for (const [label, history, expected] of checks) {
  const got = hostObservedInterview(history).answersReceived;
  if (got === expected) console.log(`  PASS  ${label} → answersReceived=${got}`);
  else failures.push(`interview receipt: ${label} expected ${expected}, got ${got}`);
}
if (builderJs.includes("interview-receipt.json")) console.log("  PASS  host writes .agentlas/interview-receipt.json");
else failures.push("host never writes .agentlas/interview-receipt.json");
if (gate.includes("Never write, edit, or fabricate this file")) console.log("  PASS  canonical forbids the model authoring the receipt");
else failures.push("canonical gate does not forbid model-authored receipts");

// ── model questions can actually reach the screen ───────────────────────────
// The desktop parsed `<<agentlas-ask>>` fences and then gated rendering on
// `state.turn === 0`, while the build started at `state.turn = 1`. The condition
// could never be true, so no interview ever appeared in the product — the single
// line behind "수십 개 런타임에서 인터뷰를 본 적이 없다" on this surface.
console.log("\n== Model interview can render ==");
const startTurn = /const generation = \+\+buildGeneration;[\s\S]{0,600}?state\.turn = (\d+);/.exec(sessionSrc)?.[1];
const renderTurn = /if \(state\.turn === (\d+) && questions\.length > 0\)/.exec(sessionSrc)?.[1];
if (startTurn === undefined || renderTurn === undefined) {
  failures.push("could not locate the build start turn or the question render guard");
} else if (startTurn === renderTurn) {
  console.log(`  PASS  build starts at turn ${startTurn} and questions render at turn ${renderTurn}`);
} else {
  failures.push(`build starts at turn ${startTurn} but questions only render at turn ${renderTurn} — unreachable`);
}
if (/추가 질문 없이[\s\S]{0,400}/.test(sessionSrc) && !/state\.turn <= 1 && !interviewObserved/.test(sessionSrc)) {
  failures.push("auto-continue tells the model not to ask before any interview happened");
} else {
  console.log("  PASS  auto-continue never suppresses the first interview");
}

// ── the contract scaffold must be reachable ─────────────────────────────────
// The canonical flow scaffolds every required artifact after the interview, so
// the model fills named holes instead of remembering eighteen filenames. The
// desktop guarded that call with `!req.runtimeSessionId`, but the interview only
// ever completes on a turn that already has an engine session — so the two
// conditions could never both hold and the scaffold ran zero times. Measured
// 2026-08-17: a build that finished its interview left an empty folder.
console.log("\n== Contract scaffold is reachable after the interview ==");
const scaffoldGuard = /if \(interviewDone && ([^)]*)\)/.exec(builderSrc)?.[1] ?? "";
if (!scaffoldGuard) {
  failures.push("could not locate the contract scaffold guard");
} else if (/!req\.runtimeSessionId/.test(scaffoldGuard)) {
  failures.push(`scaffold guard is unreachable: interviewDone && ${scaffoldGuard} — the interview always ends inside a runtime session`);
} else {
  console.log(`  PASS  scaffold guard does not depend on the absence of a runtime session (${scaffoldGuard.trim()})`);
}

// The answer the host is carrying this turn is not in `history` yet — the
// renderer appends it only after the turn finishes. Judging the interview from
// `history` alone makes the arriving answer invisible on the exact turn it
// arrives, which delays or cancels the scaffold.
if (/const observedHistory = \[[\s\S]{0,300}?req\.request/.test(builderSrc)) {
  console.log("  PASS  the receipt counts the answer the host is carrying this turn");
} else {
  failures.push("the interview receipt ignores req.request, so an arriving answer is invisible on its own turn");
}

// ── an empty result is reported as empty, not as an integrity failure ───────
// "Package integrity verification did not pass. Generated files were preserved."
// is a false sentence when zero files exist, and it sends the user to look in an
// empty folder for artifacts that were never written.
console.log("\n== Zero files is reported as zero files ==");
if (/countPackageFiles\([^)]*\) === 0/.test(builderSrc)) {
  console.log("  PASS  main detects a completion that wrote no files");
} else {
  failures.push("main never checks whether the finished build actually wrote a file");
}
if (/wroteNothing/.test(builderSrc) && /wroteNothing/.test(sessionSrc)) {
  console.log("  PASS  the empty-result marker travels from main to the screen");
} else {
  failures.push("the empty-result marker does not reach the renderer");
}
if (/파일을 하나도 만들지 않아|created no files/.test(sessionSrc)) {
  console.log("  PASS  the user is told the folder is empty");
} else {
  failures.push("the renderer still reports an empty build as an integrity failure");
}

// ── skill-only plugins survive as capabilities ──────────────────────────────
console.log("\n== Skill-only plugins are not failures ==");
const resolverSrc = fs.readFileSync(path.join(ROOT, "electron/mcp-tools/attachment-resolver.ts"), "utf8");
const planSrc = fs.readFileSync(path.join(ROOT, "electron/mcp-tools/build-plan.ts"), "utf8");
for (const [label, ok] of [
  ["candidate can carry a skillBundle", /skillBundle\?:/.test(resolverSrc)],
  ["skill bundles reach the builder prompt", /compactSkillSummary/.test(resolverSrc)],
  ["no-server is distinguished from install failure", /no_connectable_server/.test(resolverSrc)],
  ["plan reads mcpReference from the manifest", /mcpReference/.test(planSrc)],
  ["canonical states a skill plugin is not a failure", gate.includes("is a skill, not a failure")],
]) {
  if (ok) console.log(`  PASS  ${label}`);
  else failures.push(`skill-only plugins: ${label}`);
}

// ── completion is decided by the contract, not by a sentence ────────────────
console.log("\n== Completion is contract-decided ==");
for (const [label, ok] of [
  ["renderer asks the contract gate before failing", /contractVerify\?\.\(/.test(sessionSrc)],
  ["a passing contract finalizes the build", /blockers\.length === 0[\s\S]{0,300}finalizeBuild/.test(sessionSrc)],
  ["remaining blockers are listed verbatim", /for \(const blocker of verdict\?\.blockers/.test(sessionSrc)],
]) {
  if (ok) console.log(`  PASS  ${label}`);
  else failures.push(`completion: ${label}`);
}

// ── a running build survives a reload ───────────────────────────────────────
console.log("\n== Build survives app restart / reload ==");
const ipcSrc = fs.readFileSync(path.join(ROOT, "electron/ipc.ts"), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, "renderer/app/(shell)/build/page.tsx"), "utf8");
for (const [label, ok] of [
  ["Main keeps a transcript of the running build", /buildTranscripts/.test(ipcSrc)],
  ["Main exposes it over IPC", /hephaestus:activeBuild/.test(ipcSrc)],
  ["renderer can reattach", /export async function reattachRunningBuild/.test(sessionSrc)],
  ["build page calls reattach on mount", /reattachRunningBuild\(\)/.test(pageSrc)],
]) {
  if (ok) console.log(`  PASS  ${label}`);
  else failures.push(`reattach: ${label}`);
}

// ── every mode ships the same canonical bundle ──────────────────────────────
console.log("\n== All three build modes ==");
for (const mode of MODES) {
  const p = prompts[mode];
  const problems = [];
  if (!p.includes(read("AGENTS.md").trimEnd())) problems.push("AGENTS.md not verbatim");
  if (!p.includes(gate.trimEnd())) problems.push("interview gate not verbatim");
  if (!p.includes(read(MODE_BUILDER[mode]).trimEnd())) problems.push(`${MODE_BUILDER[mode]} not verbatim`);
  const cmdBody = (() => {
    let t = read("claude/plugins/agentlas-core-engine-meta-agent/commands/hep-build.md").trimEnd();
    t = t.slice(t.indexOf("\n---\n", 3) + 5).trimStart().replaceAll("$ARGUMENTS", REQUEST);
    return t;
  })();
  if (!p.includes(cmdBody)) problems.push("/hep-build command not verbatim");
  let wrappedLen = null;
  try { wrappedLen = wrapBuildSystemPrompt(p, "ko").length; } catch (e) { problems.push(`does not fit: ${e.message}`); }
  if (problems.length === 0) console.log(`  PASS  ${mode.padEnd(8)} ${wrappedLen.toLocaleString()} chars`);
  else failures.push(`mode ${mode}: ${problems.join("; ")}`);
}

// ── the system prompt must not grow with the conversation ───────────────────
// `$ARGUMENTS` in the canonical command means the user's request. Substituting
// whatever the current turn happens to say put a forty-line repair instruction
// into the SYSTEM prompt on every repair round, and one long round crossed the
// character budget and ended the build with "Build system prompt exceeds the
// 119232-character base budget" — two rounds from passing (measured
// 2026-08-17). The system prompt is the same size on turn one and turn ten.
console.log("\n== System prompt does not grow per turn ==");
if (/stripCommandFrontmatter\(\s*canonicalCommand,\s*\n?\s*req\.request\s*\)/.test(builderSrc)) {
  failures.push("the canonical command substitutes the current turn's text, so every repair round enlarges the system prompt");
} else if (/req\.history\?\.find\(\(entry\) => entry\.role === "user"\)\?\.text \?\? req\.request/.test(builderSrc)) {
  console.log("  PASS  $ARGUMENTS carries the original request, not this turn's instruction");
} else {
  failures.push("could not confirm what the canonical command substitutes for $ARGUMENTS");
}

// ── the interview gate must never become a dead end ─────────────────────────
// The engine now refuses `contract scaffold` without interview evidence. That is
// the right chokepoint, but it means a host that forgets to pass the brief builds
// NOTHING — a quality gate turned into an outage. This block is the tripwire:
// if Desktop stops supplying the brief, the gate fails here, not in a user's build.
console.log("\n== Interview gate cannot become an outage ==");
const builderTs = fs.readFileSync(path.join(ROOT, "electron/hephaestus/builder.ts"), "utf8");
const cmdsTs = fs.readFileSync(path.join(ROOT, "electron/hephaestus/commands.ts"), "utf8");
for (const [label, ok] of [
  // The contract is "no scaffold before a host-observed answer" — not one exact
  // expression. Pinning the old text (`interviewDone && !req.runtimeSessionId`)
  // made this check certify the very bug that kept the scaffold from ever
  // running; the reachability check above is what proves the other half.
  ["scaffold runs only after a host-observed answer", /if \(interviewDone &&/.test(builderTs)],
  ["host writes the work brief from real answers", /schemaVersion: "work-brief\/1\.0"/.test(builderTs)],
  ["scaffold call forwards the brief", /workBrief: workBriefPath/.test(builderTs)],
  ["commands can pass --work-brief", /"--work-brief"/.test(cmdsTs)],
  ["an explicit opt-out path exists", /minimal-private-reason/.test(cmdsTs)],
]) {
  if (ok) console.log(`  PASS  ${label}`);
  else failures.push(`interview gate: ${label}`);
}

// ── the mode map and its contracts must reach the model ────────────────────
// Canonical step 2 is "read `.agentlas/mode-map.json` and the mode contract it
// names". In the terminal the model sits inside the engine folder and just opens
// them; in Desktop the working directory is the target workspace, so a file that
// does not travel in the prompt is a file nobody reads. Measured 2026-08-17:
// mode-map was 0/64 lines and `modes/<mode>.md` 4/54. The base mode is chosen by
// the host, which hid the loss — but OVERLAYS are a layer applied ON TOP of the
// base mode and had no substitute at all, so an ontology-backed build shipped
// with no `bin/ontology`, no `.agentlas/ontology-sources.json`, no
// retrieval-first workflow and no `loop_policy`.
console.log("\n== Mode map and its contracts reach the model ==");
const modeMapText = read(".agentlas/mode-map.json");
const modeMap = JSON.parse(modeMapText);
for (const mode of MODES) {
  const p = prompts[mode];
  const problems = [];
  if (!p.includes(modeMapText.trimEnd())) problems.push("mode-map.json not verbatim");
  // Join on the map's own `agent` field. A second hand-written table from Desktop
  // mode names to mode-map keys is a table the compiler cannot check.
  const key = Object.entries(modeMap.modes).find(([, m]) => m.agent === MODE_BUILDER[mode])?.[0] ?? null;
  if (!key) problems.push(`no mode-map entry names ${MODE_BUILDER[mode]}`);
  else {
    if (!p.includes(read(modeMap.modes[key].contract).trimEnd())) {
      problems.push(`${modeMap.modes[key].contract} not verbatim`);
    }
    // Overlays are conditional BY DESIGN — shipped only where `composesWith`
    // names this mode. Asserting both directions stops a future "just ship
    // everything" patch from silently doubling the prompt.
    for (const [overlayKey, overlay] of Object.entries(modeMap.overlays ?? {})) {
      const shipped = p.includes(read(overlay.contract).trimEnd());
      const expected = (overlay.composesWith ?? []).includes(key);
      if (shipped !== expected) {
        problems.push(`overlay ${overlayKey} ${shipped ? "shipped but does not compose with" : "missing for"} ${key}`);
      }
    }
    // Shipping the map without naming the decider is how it gets ignored: the
    // host decided the base mode, so the model assumes the overlays came with it.
    if (!/OVERLAYS ARE NOT DECIDED/.test(p)) problems.push("prompt never tells the model it owns the overlay decision");
  }
  if (problems.length === 0) console.log(`  PASS  ${mode.padEnd(8)} mode-map + ${key} contract + overlay set`);
  else failures.push(`mode-map (${mode}): ${problems.join("; ")}`);
}

// ── $ENGINE must name the copy whose bytes this prompt quotes ──────────────
// Step 0's shell probe is written for the terminal. Here `CLAUDE_PLUGIN_ROOT` is
// unset and the cwd is the workspace, so the probe lands on
// `~/.agentlas/runtime/current/host_adapters/...` — a DIFFERENT copy from the one
// quoted above. Measured 2026-08-17: `resolveBuilderPromptRoot()` selects the
// bundle (bundled wins an equal-version tie, `root.ts:146-155`) while `engine.ts`
// runs the engine binary from `hephaestusRoot()`. Install a strictly newer OS
// runtime and the procedure text and the binary it calls become different
// releases. Pinning costs one line and removes the coincidence.
console.log("\n== $ENGINE is pinned to the copy the prompt quotes ==");
for (const mode of MODES) {
  if (prompts[mode].includes(`ENGINE=${ENGINE}`)) console.log(`  PASS  ${mode.padEnd(8)} ENGINE pinned`);
  else failures.push(`mode ${mode}: prompt does not pin ENGINE to the root it was assembled from`);
}

// ── headroom, stated as a number ───────────────────────────────────────────
// The budget is a hard throw at run time, and the repair rounds spend what is
// left. Print it so the next person adding canon makes an informed decision
// instead of discovering the ceiling in a user's build.
console.log("\n== System prompt budget headroom ==");
{
  const { MAX_BUILD_SYSTEM_PROMPT_CHARS, BUILD_MCP_DEGRADED_GUARD_RESERVE_CHARS } =
    require(path.join(ROOT, "dist/electron/runtime/runner.js"));
  const budget = MAX_BUILD_SYSTEM_PROMPT_CHARS - BUILD_MCP_DEGRADED_GUARD_RESERVE_CHARS;
  for (const mode of MODES) {
    const used = wrapBuildSystemPrompt(prompts[mode], "ko").length;
    const left = budget - used;
    if (left > 0) console.log(`  PASS  ${mode.padEnd(8)} ${used.toLocaleString()} / ${budget.toLocaleString()} — ${left.toLocaleString()} left`);
    else failures.push(`mode ${mode}: system prompt is over budget by ${(-left).toLocaleString()} chars`);
  }
}

console.log("\n" + "=".repeat(58));
if (failures.length > 0) {
  console.error(`hep-build parity FAILED (${failures.length})\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`hep-build parity PASSED — prompt ${prompt.length.toLocaleString()} chars`);
