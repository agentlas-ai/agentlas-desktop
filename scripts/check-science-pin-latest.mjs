#!/usr/bin/env node
// Release gate: the Science SDK pinned by this Desktop must be the current tip
// of agentlas-science main, and Desktop and Science ship together.
//
// Why: in 2026-10 the SDK line diverged (remote main vs a local main) while the
// Desktop pin sat on one branch. That SDK never called the shared host ports
// Desktop had published (goalWait, hostGoalWake, recordArtifactOutputs,
// decisions, bindCodexProductSessionStore). A Desktop release must not go out
// on a stale or off-branch Science pin.
//
// Checks, in order:
//   1. package.json pins agentlas-science to an exact 40-hex commit, and
//      package-lock.json resolves the same commit (npm ci installs the lock).
//   2. `git ls-remote <remote> refs/heads/main` — pin must equal remote main.
//   3. When it does not, the remote main history is fetched into a private
//      temporary repository to say why: behind by N commits, or not on main.
//
// Offline or no SSH access is a failure, never a silent pass. Setting
// SCIENCE_PIN_CHECK_OFFLINE_OK=1 skips only the remote part for one run and
// prints that the check was skipped. A pin that does not match the lock still
// fails while offline.
//
// The remote is fixed. Tests and CI route it with git's own url.<x>.insteadOf
// configuration (GIT_CONFIG_GLOBAL), the same mechanism npm ci uses in CI.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCIENCE = "agentlas-science";
const REMOTE = "git@github.com:agentlas-ai/agentlas-science.git";
const MAIN = "refs/heads/main";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "[science-pin]";

function fail(message) {
  console.error(`${label} FAIL: ${message}`);
  process.exit(1);
}

function pinOf(spec, where) {
  const commit = /#([0-9a-f]{40})$/.exec(String(spec ?? ""))?.[1];
  if (!commit) fail(`${where} does not pin ${SCIENCE} to an exact commit (got ${JSON.stringify(spec ?? null)})`);
  return commit;
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pin = pinOf(pkg.dependencies?.[SCIENCE] ?? pkg.optionalDependencies?.[SCIENCE], "package.json");
const lockFile = join(root, "package-lock.json");
if (!existsSync(lockFile)) fail("package-lock.json is missing");
const lock = JSON.parse(readFileSync(lockFile, "utf8"));
const lockPin = pinOf(lock.packages?.[`node_modules/${SCIENCE}`]?.resolved, "package-lock.json");
if (lockPin !== pin) fail(`package.json pins ${pin} but package-lock.json resolves ${lockPin}`);

// Never prompt, never hang on an unreachable host.
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=15",
};
// The first diagnostic line, not ssh's trailing "and the repository exists." fragment.
const why = (stderr, fallback) => stderr.split("\n").map((line) => line.trim()).find((line) => /^(fatal|error|ssh|remote):/i.test(line))
  || stderr.split("\n")[0]?.trim() || fallback;
function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", env: gitEnv, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  return { ok: result.status === 0 && !result.error, stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? result.error?.message ?? "").trim() };
}

const listed = git(["ls-remote", REMOTE, MAIN]);
const main = listed.ok ? /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(listed.stdout)?.[1] : null;
if (!main) {
  const reason = listed.ok ? "remote has no main branch" : why(listed.stderr, "git ls-remote failed");
  if (process.env.SCIENCE_PIN_CHECK_OFFLINE_OK === "1") {
    console.warn(`${label} SKIPPED (SCIENCE_PIN_CHECK_OFFLINE_OK=1): could not read ${SCIENCE} main (${reason}). `
      + `Pin ${pin} was NOT compared with SDK main; this release is not verified to ship the latest Science.`);
    process.exit(0);
  }
  fail(`could not read ${SCIENCE} main from ${REMOTE} (${reason}). The pin cannot be verified offline; `
    + "connect, or set SCIENCE_PIN_CHECK_OFFLINE_OK=1 to skip this check once.");
}

if (pin === main) {
  console.log(`${label} PASS: ${SCIENCE} pin ${pin} is the current SDK main.`);
  process.exit(0);
}

// Not the tip: find out whether it is behind or off the main line.
const scratch = mkdtempSync(join(tmpdir(), "agentlas-science-pin-"));
let verdict;
try {
  if (!git(["init", "--quiet", "--bare", scratch]).ok) throw new Error("could not create a scratch repository");
  const fetched = git(["-C", scratch, "fetch", "--quiet", "--no-tags", "--filter=blob:none", REMOTE, `${MAIN}:refs/remotes/science/main`]);
  if (!fetched.ok) throw new Error(`could not fetch ${SCIENCE} main history (${why(fetched.stderr, "git fetch failed")})`);
  const fetchedMain = git(["-C", scratch, "rev-parse", "refs/remotes/science/main"]).stdout;
  if (fetchedMain !== main) throw new Error(`${SCIENCE} main moved during the check (${main} -> ${fetchedMain}); run again`);
  // Only the fetched main history counts: no lazy fetch of the pin from other branches.
  const local = { env: { ...gitEnv, GIT_NO_LAZY_FETCH: "1" } };
  const known = git(["-C", scratch, "cat-file", "-e", `${pin}^{commit}`], local).ok;
  const ancestor = known && git(["-C", scratch, "merge-base", "--is-ancestor", pin, main], local).ok;
  if (ancestor) {
    const behind = git(["-C", scratch, "rev-list", "--count", `${pin}..${main}`]).stdout;
    verdict = `최신 아님: 핀 ${pin}, main ${main}, 뒤처진 커밋 ${behind}개. `
      + `Repin agentlas-science to ${main} (package.json and package-lock.json) so Desktop ships with the current Science.`;
  } else {
    verdict = `가지 밖 핀: 핀 ${pin} 은 ${SCIENCE} main ${main} 의 조상이 아니다`
      + `${known ? "" : " (main 의 이력에 없는 커밋)"}. Publish the pinned work to SDK main first, then repin to main.`;
  }
} catch (error) {
  verdict = `핀 ${pin} != main ${main}, and ${error instanceof Error ? error.message : String(error)}`;
} finally {
  rmSync(scratch, { recursive: true, force: true });
  if (existsSync(scratch)) console.error(`${label} scratch repository was not removed: ${scratch}`);
}
fail(verdict);
