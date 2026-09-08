// index-snapshot-protocol: 1
/*
 * 변경한 파일을 물고 있는 게이트만 골라 실제로 돌린다 — PRD 게이트 §7.2.
 *
 * 문제: One 게이트 59종(전체 435종)이 **자동으로 도는 자리가 한 곳도 없었다.** package.json
 * 에 없고 pre-push 에도 없다. 그래서 "같은 커밋에서 검사기도 갱신하기"가 사람과 모델의
 * 선의에 맡겨져 있었고, 오늘 하루에만 그 선의가 여러 번 실패했다.
 *
 * 전부 돌리는 것은 답이 아니다(435종 · 수십 분 · 상당수는 Electron 호스트가 필요하다).
 * `gates-watching` 이 이미 "이 파일을 언급하는 게이트"를 안다. 그 목록만 돌린다.
 *
 * 사용:
 *   node scripts/run-bound-gates.mjs --staged     # 스테이지된 파일 기준(커밋 관문)
 *   node scripts/run-bound-gates.mjs <path> ...   # 명시한 파일 기준
 *   AGENTLAS_BOUND_GATES_MAX=12                   # 명시 실행 기본12; INDEX 기본 전부, cap 누락은 실패
 *   AGENTLAS_PRIVATE_GATE_ALLOWLIST=/private/.../gates.json # [{path,sha256}] 고정 비공개 검사기
 *   AGENTLAS_PRIVATE_EXTERNAL_ALLOWLIST=/private/.../deps.json # protocol 1 hash-frozen sibling deps
 *   AGENTLAS_GATE_EVIDENCE_DIR=/private/.../receipts        # tree/검사/최소 TS emit 해시 영수증
 *
 * 원칙
 * - 호스트를 추측하지 않는다: node 로 먼저 돌리고, 그 게이트가 Electron 을 요구하면
 *   (electron 심볼로 실패하면) **건너뛴 사실을 말한다.** 부재를 성공으로 위장하지 않는다.
 * - 상한을 넘으면 무엇을 안 돌렸는지 반드시 출력한다(조용한 절단 금지).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSnapshot, runIndexGates, verifySnapshot } from "./lib/staged-gate-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--staged")) {
  try { process.exit(runIndexGates(root)); }
  catch (error) { console.error(`run-bound-gates: ${error.message}`); process.exit(1); }
}
const snapshotAt = args.indexOf("--snapshot");
const snapshot = snapshotAt >= 0 ? readSnapshot(root, args[snapshotAt + 1]) : null;
const outcomes = [];
let discovered = [];
function finish(code) {
  if (snapshot) fs.writeFileSync(path.join(root, ".agentlas-index-gate-results.json"), JSON.stringify({
    protocol: 1, tree: snapshot.tree, gates: discovered, results: outcomes,
    complete: outcomes.length === discovered.length, exitStatus: code,
  }));
  process.exit(code);
}
const { gatesWatching } = await import("./gates-watching.mjs");
// A staged commit must not succeed with silently unexecuted overflow gates.
const MAX_GATES = process.env.AGENTLAS_BOUND_GATES_MAX === undefined && snapshot
  ? Infinity : Number(process.env.AGENTLAS_BOUND_GATES_MAX || 12);
if (!(MAX_GATES > 0) || (Number.isFinite(MAX_GATES) && !Number.isInteger(MAX_GATES))) {
  throw new Error("INVALID_BOUND_GATES_MAX");
}
const changed = snapshot ? snapshot.changed : args.filter((value) => !value.startsWith("--"));

if (changed.length === 0) {
  console.log("run-bound-gates: nothing changed; no gate is bound to this commit.");
  finish(0);
}

// 거의 모든 게이트가 언급하는 파일(package.json, tsconfig …)은 바인딩 신호가 아니다.
// 이런 파일로 바인딩하면 "변경이 물린 게이트"가 사실상 전체가 되어, 이 관문이 다시
// "전부 돌리기"가 된다 — 그러면 아무도 쓰지 않게 되고, 관문은 없는 것과 같아진다.
const GENERIC_FILES = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "README.md", "CHANGELOG.md",
]);

const bound = new Set();
for (const file of changed) {
  if (GENERIC_FILES.has(file)) continue;
  // 게이트 자신을 고친 경우 그 게이트도 돌린다(고쳐 놓고 안 돌려 보는 것을 막는다).
  if (/^scripts\/(test|verify)-.*\.(cjs|mjs)$/.test(file) && fs.existsSync(path.join(root, file))) bound.add(file);
  for (const gate of gatesWatching(file)) bound.add(gate);
}

const gates = [...bound].sort();
discovered = gates;
if (snapshot && JSON.stringify(gates) !== JSON.stringify(snapshot.expectedGates)) throw new Error("INDEX_GATE_DISCOVERY_MISMATCH");
for (const gate of gates) {
  if (!fs.existsSync(path.join(root, gate))) throw new Error(`BOUND_GATE_MISSING: ${gate}`);
}
if (gates.length === 0) {
  console.log(`run-bound-gates: no gate mentions the ${changed.length} changed file(s).`);
  finish(0);
}

const selected = gates.slice(0, MAX_GATES);
const dropped = gates.slice(MAX_GATES);

let failed = 0;
let selftested = 0;
const skipped = [];
// Precommit validates this verifier's deterministic contract only. The release
// invocation still requires native Windows/Linux hosts and built artifacts.
const localExecutionContracts = new Map([
  ["scripts/verify-packaged-updater-install-e2e.cjs", {
    mode: "SELFTEST",
    args: ["--selftest"],
  }],
]);
// 인자가 있어야 자기검사로 도는 게이트는 파일 머리에 `// gate-args: --self-test` 를 적는다.
// (verify-mac-install-boundary.mjs 는 인자 없이 부르면 사용법 오류로 죽어 "실패"로 오보됐다.)
function gateArgs(gate) {
  const head = fs.readFileSync(path.join(root, gate), "utf8").slice(0, 2048);
  const m = head.match(/^\/\/\s*gate-args:\s*(.+)$/m);
  return m ? m[1].trim().split(/\s+/) : [];
}

for (const gate of selected) {
  if (snapshot) verifySnapshot(root, snapshot);
  const localContract = localExecutionContracts.get(gate);
  const args = localContract?.args ?? gateArgs(gate);
  if (localContract) {
    console.log(`run  ${localContract.mode} ${JSON.stringify([process.execPath, gate, ...args])}`);
    console.log("native updater E2E: NOT VERIFIED — release requires native Windows/Linux hosts and built artifacts.");
  }
  const preload = snapshot ? ["--require", path.join(root, "scripts/lib/staged-gate-compile.cjs")] : [];
  const result = spawnSync(process.execPath, [...preload, gate, ...args], { cwd: root, encoding: "utf8" });
  if (result.status === 0) {
    if (localContract) {
      selftested += 1;
      outcomes.push({ gate, status: "SELFTEST" });
      console.log(`ok   ${localContract.mode} ${gate}`);
    } else {
      outcomes.push({ gate, status: "PASS" });
      console.log(`ok   ${gate}`);
    }
    continue;
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (snapshot && /(?:COMPILE_SOURCE_|INDEXED_TS_|INDEX_BUILD_|INVALID_INDEXED_|UNSUPPORTED_INDEXED_|LIVE_REPOSITORY_ACCESS_)/.test(output)) {
    failed += 1;
    outcomes.push({ gate, status: "FAIL" });
    console.error(`FAIL ${gate}`);
    console.error(output.trim().split("\n").slice(0, 8).join("\n"));
    continue;
  }
  // A failed deterministic selftest is a failure, never a native-host skip.
  if (localContract) {
    failed += 1;
    outcomes.push({ gate, status: "FAIL" });
    console.error(`FAIL ${localContract.mode} ${gate}`);
    console.error(output.trim().split("\n").slice(-6).join("\n"));
    continue;
  }
  // 이 게이트는 Electron 호스트를 요구한다. 여기서 돌릴 수 없다는 사실은 실패가 아니지만,
  // 통과로 세지도 않는다 — 무엇을 확인하지 못했는지 남긴다.
  // 호스트 판별의 신호는 두 갈래다: electron API 부재, 그리고 **네이티브 모듈 ABI**
  // (better-sqlite3 는 이 체크아웃에서 electron ABI 로 빌드돼 node 로는 못 연다 — 실측).
  if (/Cannot read properties of undefined \(reading '(?:setPath|whenReady|getPath|quit|exit|on)'\)|require\(['"]electron['"]\)|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(output)) {
    skipped.push(gate);
    outcomes.push({ gate, status: "SKIP", reason: "Electron host" });
    console.log(`skip ${gate} — needs the Electron host; run it with \`npx electron ${gate}\``);
    continue;
  }
  /*
   * 스냅샷은 git 트리만 풀고 node_modules 를 넣지 않는다. 그래서 3자 패키지를 그대로
   * require 하는 게이트는 커밋 관문 안에서 `Cannot find module 'typescript'` 로 죽는데,
   * 같은 게이트를 직접 돌리면 초록이다(2026-09-08 실측: verify-one-artifact-preview-ui).
   * 계약이 깨진 것이 아니라 **전제가 없는 것**이므로, 위 Electron·TS 로더 갈래와 같은
   * 규칙으로 통과에 세지 않고 무엇을 확인하지 못했는지 남긴다.
   *
   * 도피구가 되지 않도록 세 가지를 모두 만족할 때만 해당한다: 스냅샷일 것, 상대경로가
   * 아닌 **패키지 이름**일 것, 그리고 그 패키지가 진짜 저장소 의존으로 실재할 것. 오타나
   * 없는 패키지는 그대로 실패한다.
   */
  const bareMissing = snapshot && output.match(/Cannot find module '([^'./@][^']*|@[^/']+\/[^']+)'/);
  if (bareMissing) {
    const pkg = bareMissing[1].split("/").slice(0, bareMissing[1].startsWith("@") ? 2 : 1).join("/");
    if (fs.existsSync(path.join(root, "node_modules", pkg))) {
      skipped.push(gate);
      outcomes.push({ gate, status: "SKIP", reason: `snapshot lacks node_modules/${pkg}` });
      console.log(`skip ${gate} — 스냅샷에는 node_modules 가 없어 '${pkg}' 를 못 읽었습니다; \`node ${gate}\` 로 직접 돌려 확인하세요`);
      continue;
    }
  }
  /*
   * TypeScript 모듈을 직접 읽는 게이트는 node 만으로는 못 돈다. 그 실패는 계약이 깨진
   * 것이 아니라 **호스트가 안 맞는 것**이다(2026-08-24 실측: 통과하는 게이트가 node 에서
   * `Cannot find module '../plugins/builtin'` 으로 죽어 남의 커밋을 막았다. 같은 게이트를
   * TS 로더로 돌리니 전 항목 통과).
   *
   * 로더가 있으면 그것으로 한 번 더 돌려 **실제로 확인한다**. 없으면 통과로 세지 않고
   * 무엇을 확인하지 못했는지 남긴다 — 위 Electron 갈래와 같은 규칙이다. 로더를 이 저장소의
   * 필수 의존성으로 만들지 않는 이유는, 없는 환경에서 또 다른 거짓 실패가 나기 때문이다.
   */
  if (/Cannot find module .*(?:\.\.?\/|@\/)/.test(output) || /Unknown file extension "\.tsx?"/.test(output)) {
    const viaLoader = snapshot
      ? spawnSync(process.execPath, [...preload, "node_modules/tsx/dist/cli.mjs", gate, ...gateArgs(gate)], {
        cwd: root, encoding: "utf8",
      })
      : spawnSync("npx", ["--no-install", "tsx", gate, ...gateArgs(gate)], {
      cwd: root,
      encoding: "utf8",
    });
    if (viaLoader.status === 0) {
      outcomes.push({ gate, status: "PASS", mode: "TS loader" });
      console.log(`ok   ${gate} (TS 로더)`);
      continue;
    }
    if (!snapshot && (viaLoader.error || viaLoader.status === null)) {
      skipped.push(gate);
      outcomes.push({ gate, status: "SKIP", reason: "TS loader missing" });
      console.log(`skip ${gate} — TypeScript 로더가 필요합니다; \`npx tsx ${gate}\` 로 돌리세요`);
      continue;
    }
    failed += 1;
    outcomes.push({ gate, status: "FAIL" });
    console.error(`FAIL ${gate}`);
    console.error(output.trim().split("\n").slice(0, 8).join("\n"));
    console.error(`${viaLoader.stdout || ""}${viaLoader.stderr || ""}`.trim().split("\n").slice(-6).join("\n"));
    continue;
  }
  /*
   * 빌드 도구가 아예 없어서 못 돈 것도 계약이 깨진 것이 아니라 **전제가 없는 것**이다
   * (위 Electron·TS 로더 갈래와 같은 규칙). 2026-08-25 실측: esbuild 는 이 저장소의
   * 의존으로 선언조차 안 돼 있어 `npx --no-install esbuild` 가 깨끗한 체크아웃에서
   * 항상 실패했고, 그래서 그 게이트는 **한 번도 통과한 적이 없다**. 영원히 FAIL 하는
   * 게이트가 하나 있으면 모두가 SKIP 을 습관으로 쓰게 되고, 그날 진짜 신호였던 신선도
   * 게이트까지 함께 넘어간다 — 실제로 그렇게 스키마 판올림이 짝 없이 나갈 뻔했다.
   * 통과로 세지 않고 무엇을 확인하지 못했는지 남긴다.
   */
  if (!snapshot && /npx canceled due to missing packages|command not found: (?:esbuild|tsc)|Cannot find package '(?:esbuild)'/.test(output)) {
    const missing = /esbuild/.test(output) ? "esbuild" : "빌드 도구";
    skipped.push(gate);
    outcomes.push({ gate, status: "SKIP", reason: "build tooling missing" });
    console.log(`skip ${gate} — ${missing} 가 없어 확인하지 못했습니다; 이 저장소에 의존으로 선언되어 있지 않습니다`);
    continue;
  }
  failed += 1;
  outcomes.push({ gate, status: "FAIL" });
  console.error(`FAIL ${gate}`);
  console.error(output.trim().split("\n").slice(-6).join("\n"));
}

if (dropped.length) {
  console.warn(`run-bound-gates: ${dropped.length} more gate(s) are bound but were not run (cap ${MAX_GATES}): ${dropped.join(", ")}`);
}
if (skipped.length) {
  console.warn(`run-bound-gates: ${skipped.length} gate(s) were not verified here (host or build tooling missing) — 위 skip 줄에 각각의 사유가 있습니다.`);
}
console.log(`run-bound-gates: ${selected.length - failed - skipped.length - selftested} passed, ${selftested} SELFTEST passed, ${failed} failed, ${skipped.length} skipped (of ${gates.length} bound).`);
console.log("native updater E2E: NOT VERIFIED by this precommit runner.");
finish(failed || (snapshot && dropped.length) ? 1 : 0);
