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
// 인자가 있어야 자기검사로 도는 게이트는 파일 머리에 `// gate-args: --self-test` 를 적는다.
// (verify-mac-install-boundary.mjs 는 인자 없이 부르면 사용법 오류로 죽어 "실패"로 오보됐다.)
function gateArgs(gate) {
  const head = fs.readFileSync(path.join(root, gate), "utf8").slice(0, 2048);
  const m = head.match(/^\/\/\s*gate-args:\s*(.+)$/m);
  return m ? m[1].trim().split(/\s+/) : [];
}

for (const gate of selected) {
  const result = spawnSync(process.execPath, [gate, ...gateArgs(gate)], { cwd: root, encoding: "utf8" });
  if (result.status === 0) {
    console.log(`ok   ${gate}`);
    continue;
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  // 이 게이트는 Electron 호스트를 요구한다. 여기서 돌릴 수 없다는 사실은 실패가 아니지만,
  // 통과로 세지도 않는다 — 무엇을 확인하지 못했는지 남긴다.
  // 호스트 판별의 신호는 두 갈래다: electron API 부재, 그리고 **네이티브 모듈 ABI**
  // (better-sqlite3 는 이 체크아웃에서 electron ABI 로 빌드돼 node 로는 못 연다 — 실측).
  if (/Cannot read properties of undefined \(reading '(?:setPath|whenReady|getPath|quit|exit|on)'\)|require\(['"]electron['"]\)|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(output)) {
    skipped.push(gate);
    console.log(`skip ${gate} — needs the Electron host; run it with \`npx electron ${gate}\``);
    continue;
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
    const viaLoader = spawnSync("npx", ["--no-install", "tsx", gate, ...gateArgs(gate)], {
      cwd: root,
      encoding: "utf8",
    });
    if (viaLoader.status === 0) {
      console.log(`ok   ${gate} (TS 로더)`);
      continue;
    }
    if (viaLoader.error || viaLoader.status === null) {
      skipped.push(gate);
      console.log(`skip ${gate} — TypeScript 로더가 필요합니다; \`npx tsx ${gate}\` 로 돌리세요`);
      continue;
    }
    failed += 1;
    console.error(`FAIL ${gate}`);
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
  if (/npx canceled due to missing packages|command not found: (?:esbuild|tsc)|Cannot find package '(?:esbuild)'/.test(output)) {
    const missing = /esbuild/.test(output) ? "esbuild" : "빌드 도구";
    skipped.push(gate);
    console.log(`skip ${gate} — ${missing} 가 없어 확인하지 못했습니다; 이 저장소에 의존으로 선언되어 있지 않습니다`);
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
  console.warn(`run-bound-gates: ${skipped.length} gate(s) were not verified here (host or build tooling missing) — 위 skip 줄에 각각의 사유가 있습니다.`);
}
console.log(`run-bound-gates: ${selected.length - failed - skipped.length} passed, ${failed} failed, ${skipped.length} skipped (of ${gates.length} bound).`);
process.exit(failed ? 1 : 0);
