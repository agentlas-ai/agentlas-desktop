// 게이트 신선도(죽은 앵커) 탐지기 — 게이트를 자동으로 "고치지" 않는다. 낡음을 크게 만들 뿐이다.
//
// 배경: 구현 문장을 못박은 게이트는 소스가 진화하면 (a) 영원히 빨간 채 방치되거나
// (b) 통과를 위해 소스를 되돌리게 만든다(실측 2회: gates-must-assert-contracts-not-code).
// 자동 재작성은 반대 사고 — 현재 동작(버그 포함)을 정답으로 못박는다 — 라서 금지.
// 여기서는 두 가지 "확실히 낡은" 신호만 기계로 잡는다:
//   1. 게이트가 읽는 저장소 경로가 더 이상 존재하지 않음 (dead path)
//   2. assert.match 용 정규식 리터럴이, 그 게이트가 읽는 어떤 소스에도 매치되지 않음 (dead anchor)
// 판정은 STALE-SUSPECT 보고까지다. 고치는 건 사람이(또는 그 게이트 소유 세션이) 계약 단위로.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateFiles = fs.readdirSync(path.join(root, "scripts"))
  .filter((name) => /^(test|verify)-.*\.(cjs|mjs)$/.test(name))
  .map((name) => path.join(root, "scripts", name));

const PATH_RE = /(["'])((?:renderer|electron|shared|dist|docs)\/[^"'\n]+?\.(?:tsx?|cjs|mjs|css|json|md))\1/g;
const READ_RE = /readFileSync\([^)]*?(["'])((?:renderer|electron|shared)\/[^"'\n]+?)\1/g;
// assert.match(subject, /.../) 한 줄 안의 정규식 리터럴만 앵커로 본다(doesNotMatch는 제외).
const MATCH_LINE_RE = /assert\.match\([^,]+,\s*\/((?:\\.|\[[^\]]*\]|[^/\\\n])+)\/([a-z]*)/g;

let deadPaths = 0;
let deadAnchors = 0;
const report = [];

for (const gate of gateFiles) {
  const text = fs.readFileSync(gate, "utf8");
  const name = path.relative(root, gate);
  const missing = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    if (!fs.existsSync(path.join(root, m[2]))) missing.add(m[2]);
  }
  if (missing.size) {
    deadPaths += missing.size;
    report.push(`STALE-PATH   ${name}: ${[...missing].join(", ")}`);
  }
  // 이 게이트가 명시적으로 읽는 소스들의 합본에 대해 앵커 정규식을 시험한다.
  const sources = [...new Set([...text.matchAll(READ_RE)].map((m) => m[2]))]
    .filter((p) => fs.existsSync(path.join(root, p)));
  if (sources.length === 0) continue;
  const corpus = sources.map((p) => fs.readFileSync(path.join(root, p), "utf8")).join("\n \n");
  for (const m of text.matchAll(MATCH_LINE_RE)) {
    let re;
    try {
      re = new RegExp(m[1], m[2].replace(/g/, ""));
    } catch {
      continue; // 동적 조립·비호환 플래그는 판단하지 않는다(오탐 금지).
    }
    if (!re.test(corpus)) {
      deadAnchors += 1;
      report.push(`STALE-ANCHOR ${name}: /${m[1].slice(0, 90)}/ matches none of [${sources.join(", ")}]`);
    }
  }
}

for (const line of report) console.log(line);
console.log(`gate freshness: ${gateFiles.length} gates scanned — dead paths ${deadPaths}, dead anchors ${deadAnchors}`);
// 탐지기는 보고가 임무다: 낡음이 있어도 exit 0으로 두면 아무도 안 본다. 단, 전면 빨강으로
// 개발을 막지 않게 "확실한 것"만 실패시킨다 — dead path는 확실, dead anchor는 SUSPECT 경고.
process.exit(deadPaths > 0 ? 1 : 0);
