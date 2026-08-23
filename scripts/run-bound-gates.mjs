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
 *   AGENTLAS_BOUND_GATES_MAX=12                   # 한 번에 돌릴 최대 개수(기본 12)
 *
 * 원칙
 * - 호스트를 추측하지 않는다: node 로 먼저 돌리고, 그 게이트가 Electron 을 요구하면
 *   (electron 심볼로 실패하면) **건너뛴 사실을 말한다.** 부재를 성공으로 위장하지 않는다.
 * - 상한을 넘으면 무엇을 안 돌렸는지 반드시 출력한다(조용한 절단 금지).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatesWatching } from "./gates-watching.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_GATES = Math.max(1, Number(process.env.AGENTLAS_BOUND_GATES_MAX || 12));

function stagedFiles() {
  try {
    return execFileSync("git", ["-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const changed = args.includes("--staged")
  ? stagedFiles()
  : args.filter((value) => !value.startsWith("--"));

if (changed.length === 0) {
  console.log("run-bound-gates: nothing changed; no gate is bound to this commit.");
  process.exit(0);
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

const gates = [...bound].filter((gate) => fs.existsSync(path.join(root, gate))).sort();
if (gates.length === 0) {
  console.log(`run-bound-gates: no gate mentions the ${changed.length} changed file(s).`);
  process.exit(0);
}

const selected = gates.slice(0, MAX_GATES);
const dropped = gates.slice(MAX_GATES);

let failed = 0;
const skipped = [];
for (const gate of selected) {
  const result = spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8" });
  if (result.status === 0) {
    console.log(`ok   ${gate}`);
    continue;
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  // 이 게이트는 Electron 호스트를 요구한다. 여기서 돌릴 수 없다는 사실은 실패가 아니지만,
  // 통과로 세지도 않는다 — 무엇을 확인하지 못했는지 남긴다.
  // 호스트 판별의 신호는 두 갈래다: electron API 부재, 그리고 **네이티브 모듈 ABI**
  // (better-sqlite3 는 이 체크아웃에서 electron ABI 로 빌드돼 node 로는 못 연다 — 실측).
  if (/Cannot read properties of undefined \(reading '(?:setPath|whenReady|getPath)'\)|require\(['"]electron['"]\)|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(output)) {
    skipped.push(gate);
    console.log(`skip ${gate} — needs the Electron host; run it with \`npx electron ${gate}\``);
    continue;
  }
  failed += 1;
  console.error(`FAIL ${gate}`);
  console.error(output.trim().split("\n").slice(-6).join("\n"));
}

if (dropped.length) {
  console.warn(`run-bound-gates: ${dropped.length} more gate(s) are bound but were not run (cap ${MAX_GATES}): ${dropped.join(", ")}`);
}
if (skipped.length) {
  console.warn(`run-bound-gates: ${skipped.length} gate(s) need the Electron host and were not verified here.`);
}
console.log(`run-bound-gates: ${selected.length - failed - skipped.length} passed, ${failed} failed, ${skipped.length} skipped (of ${gates.length} bound).`);
process.exit(failed ? 1 : 0);
