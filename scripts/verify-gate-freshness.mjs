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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateFiles = fs.readdirSync(path.join(root, "scripts"))
  .filter((name) => /^(test|verify)-.*\.(cjs|mjs)$/.test(name))
  .map((name) => path.join(root, "scripts", name));

/*
 * 기준선은 "이번 변경 전"의 낡음이어야 한다. AGENTLAS_GATE_BASE=HEAD 를 주면 소스 파일을
 * 작업 트리가 아니라 그 커밋에서 읽는다 — 미커밋 편집이 만든 낡음이 기준선에 섞여 면제되는
 * 것을 막는다. 게이트 스크립트 자체는 상당수가 로컬 전용(gitignore)이라 항상 디스크에서 읽는다.
 */
const BASE_REF = process.env.AGENTLAS_GATE_BASE || "";
let trackedSet = null;
function isTracked(relative) {
  if (!trackedSet) {
    try {
      trackedSet = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n"));
    } catch { trackedSet = new Set(); }
  }
  return trackedSet.has(relative);
}
function readSource(relative) {
  if (BASE_REF) {
    // INDEX = 스테이지된 내용(`git show :path`). 공유 체크아웃에서 남의 미스테이지 편집이
    // 내 커밋을 막지 않게, 관문은 작업 트리가 아니라 이번 커밋의 내용만 본다.
    const spec = BASE_REF === "INDEX" ? `:${relative}` : `${BASE_REF}:${relative}`;
    try {
      return execFileSync("git", ["show", spec], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // git 이 못 주는 이유는 둘이다. (1) 그 커밋/인덱스에 없던 파일 → 빈 본문이 정확하다.
      // (2) 애초에 이 저장소가 추적하지 않는 파일(형제 저장소의 모바일 앱, 로컬 전용 파일)
      //     → 빈 본문으로 세면 살아 있는 앵커가 전부 죽었다고 보고된다(실측: 모바일 계약 5건).
      if (!isTracked(relative) && fs.existsSync(path.resolve(root, relative))) {
        return fs.readFileSync(path.resolve(root, relative), "utf8");
      }
      return "";
    }
  }
  return fs.readFileSync(path.resolve(root, relative), "utf8");
}

/*
 * 게이트 스크립트 본문. 게이트의 절대다수(440 중 415)는 로컬 전용(gitignore)이라 그 커밋에
 * 존재하지 않는다 — 없으면 디스크로 되돌아간다. 추적되는 게이트는 소스와 같은 기준으로 읽어야
 * "게이트는 새 것, 소스는 옛 것" 같은 섞인 판정을 내지 않는다.
 */
/*
 * "이 경로가 있는가"도 소스와 같은 기준으로 물어야 한다. 관문이 인덱스를 볼 때 디스크를 보면,
 * 옆 세션이 아직 커밋하지 않은 삭제가 내 커밋의 "새 낡음"으로 잡힌다(실측: 다른 세션이 One
 * 화면 몇 개를 지우는 중이었고, 그 미커밋 삭제가 게이트 4개를 낡음으로 만들었다).
 */
function sourceExists(relative) {
  if (BASE_REF) {
    const spec = BASE_REF === "INDEX" ? `:${relative}` : `${BASE_REF}:${relative}`;
    try {
      execFileSync("git", ["cat-file", "-e", spec], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch {
      // 추적하지 않는 파일(형제 저장소·로컬 전용)은 디스크가 유일한 사실이다.
      return !isTracked(relative) && fs.existsSync(path.resolve(root, relative));
    }
  }
  return fs.existsSync(path.resolve(root, relative));
}

function readGate(relative) {
  if (BASE_REF) {
    const spec = BASE_REF === "INDEX" ? `:${relative}` : `${BASE_REF}:${relative}`;
    try {
      return execFileSync("git", ["show", spec], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // 이 커밋에 없는 게이트(로컬 전용). 디스크 본문이 유일한 사실이다.
    }
  }
  return fs.readFileSync(path.join(root, relative), "utf8");
}

const PATH_RE = /(["'])((?:renderer|electron|shared|dist|docs)\/[^"'\n]+?\.(?:tsx?|cjs|mjs|css|json|md))\1/g;
// 코퍼스용은 더 넓다: 게이트가 언급하는 모든 저장소 텍스트 파일(모바일·문서·설정 포함).
// 죽은 경로 판정은 위의 좁은 PATH_RE 로만 한다 — 넓히면 저장소 파일이 아닌 문자열까지 물어 오탐이 된다.
const CORPUS_PATH_RE = /(["'])([\w.@-]+(?:\/[^"'\n]+)+?\.(?:tsx?|jsx?|cjs|mjs|css|json|md|txt|html|sh|py|toml|ya?ml|dart|kt|swift|rs|go))\1/g;
const JOIN_RE = /(?:path\.)?join\(\s*(?:root|__dirname|repoRoot|REPO_ROOT)\s*,\s*((?:["'][^"']*["']\s*,\s*)*["'][^"']*["'])\s*\)/g;
const READ_RE = /readFileSync\([^)]*?(["'])((?:renderer|electron|shared)\/[^"'\n]+?)\1/g;
// assert.match(subject, /.../) 한 줄 안의 정규식 리터럴만 앵커로 본다(doesNotMatch는 제외).
// 주어(subject)까지 함께 잡는다 — 파일 본문이 아닌 값(런타임 객체·함수 반환)에 건 단언을
// 소스 앵커로 오해하면, 멀쩡히 통과하는 게이트가 낡았다고 보고된다(실측 오탐 13개 게이트).
const MATCH_LINE_RE = /assert\.match\(\s*([^,]+?)\s*,\s*\/((?:\\.|\[[^\]]*\]|[^/\\\n])+)\/([a-z]*)/g;

/*
 * 이 게이트 안에서 "파일 본문을 담은 이름"들. readFileSync 로 직접 만든 것, 그것을 읽는
 * 도우미로 만든 것, 그리고 그것들을 이어 붙인 것까지 고정점까지 넓힌다.
 */
function fileTextNames(text) {
  const names = new Set();
  const direct = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:String\()?\s*(?:fs\.)?readFileSync\(/g;
  for (const m of text.matchAll(direct)) names.add(m[1]);
  // readFileSync 를 감싼 지역 도우미
  const helpers = new Set();
  const helperRe = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)[\s\S]{0,240}?readFileSync\(/g;
  for (const m of text.matchAll(helperRe)) helpers.add(m[1] || m[2]);
  for (let round = 0; round < 4; round += 1) {
    const before = names.size;
    const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
    for (const m of text.matchAll(assign)) {
      if (names.has(m[1])) continue;
      const rhs = m[2];
      const usesHelper = [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(rhs));
      const usesSource = [...names].some((n) => new RegExp(`\\b${n}\\b`).test(rhs));
      // 파생은 "이어 붙이기"까지만 파일 본문으로 본다. 함수에 통과시킨 값(요약·파싱 결과)은
      // 더 이상 소스가 아니며, 그것에 건 단언을 소스 앵커로 세면 오탐이 된다.
      const concatOnly = !/[A-Za-z_$][\w$]*\s*\(/.test(rhs);
      if (usesHelper || (usesSource && concatOnly)) names.add(m[1]);
    }
    if (names.size === before) break;
  }
  return names;
}

/** 주어가 파일 본문인가. 템플릿/연결식이면 그 안에 파일 본문 이름이 있으면 된다. */
function subjectIsFileText(subject, names) {
  const clean = subject.trim();
  if (!clean) return false;
  const identifiers = clean.match(/[A-Za-z_$][\w$]*/g) || [];
  // `detail.command` 처럼 프로퍼티 접근이면 그 뿌리 이름이 파일 본문이어야 한다.
  const root0 = identifiers[0];
  if (/^[A-Za-z_$][\w$]*\s*\./.test(clean)) return names.has(root0) && false;
  if (/^[`("']/.test(clean)) return identifiers.some((id) => names.has(id));
  return names.has(root0);
}

let deadPaths = 0;
let deadAnchors = 0;
const report = [];
// 기계 지문(기준선 비교용). 표시 문자열이 아니라 이 값으로만 비교한다.
const entries = [];

for (const gate of gateFiles) {
  const name = path.relative(root, gate);
  const text = readGate(name);
  const missing = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    if (sourceExists(m[2])) continue;
    // "이 파일은 삭제된 채로 있어야 한다"를 지키는 게이트가 있다. 그런 존재 검사에 쓰인 경로는
    // 죽은 경로가 아니라 그 게이트의 요점이다(실측: test-automation-setup-request).
    const before = text.slice(Math.max(0, m.index - 140), m.index);
    // 존재 검사(삭제 유지 계약)와 게이트가 **직접 만드는** 픽스처 경로는 죽은 경로가 아니다.
    if (/existsSync\s*\(|writeFileSync\s*\(|mkdirSync\s*\(|cpSync\s*\(|\bpath:\s*$/.test(before)) continue;
    // 같은 계약을 **목록으로** 쓰는 흔한 모양도 있다:
    //   for (const retired of ["a.tsx", "b.tsx"]) assert.ok(!existsSync(join(root, retired)))
    // 이때 경로 리터럴 앞에는 existsSync 가 없고 뒤에 온다. 뒤도 보지 않으면 "지워진 채로
    // 있어야 한다"는 계약을 매번 죽은 경로로 오탐한다(2026-08-23 실측: 9건이 전부 이 모양).
    const after = text.slice(m.index, Math.min(text.length, m.index + 600));
    // 목록이 길면 140자 창에는 `of [` 가 안 들어온다(항목 4번째부터 오탐이 되살아난다).
    // 목록 머리를 찾기 위한 창은 넉넉히 잡는다.
    const beforeWide = text.slice(Math.max(0, m.index - 900), m.index);
    const listHead = beforeWide.lastIndexOf("of [");
    const inAbsenceLoop = listHead >= 0
      && !beforeWide.slice(listHead).includes("]")
      && /!\s*(?:fs\.)?existsSync\s*\(/.test(after);
    if (inAbsenceLoop) continue;
    missing.add(m[2]);
  }
  if (missing.size) {
    deadPaths += missing.size;
    for (const miss of missing) entries.push(`STALE-PATH|${name}|${miss}`);
    report.push(`STALE-PATH   ${name}: ${[...missing].join(", ")}`);
  }
  // 이 게이트가 명시적으로 읽는 소스들의 합본에 대해 앵커 정규식을 시험한다.
  // 소스 집합은 "이 게이트가 인라인으로 읽는 파일"이 아니라 "이 게이트가 언급하는 저장소
  // 파일 전부"다. 경로를 변수에 담아 읽는 게이트(path.join(root, "…") → readFileSync(변수))가
  // 흔해서, 인라인 readFileSync 만 보면 앵커가 살아 있는데도 죽었다고 보고한다(오탐).
  // 상위집합을 쓰면 오탐 대신 미탐 쪽으로 기운다 — 관문으로 쓰려면 그쪽이 안전하다.
  const sources = [...new Set([
    ...[...text.matchAll(READ_RE)].map((m) => m[2]),
    ...[...text.matchAll(CORPUS_PATH_RE)].map((m) => m[2]),
    // path.join(root, "renderer", "components", "X.tsx") 처럼 조각으로 만든 경로. 한 덩이
    // 문자열이 없어서 위 두 패턴에 안 잡히고, 그러면 살아 있는 앵커가 죽었다고 보고된다.
    ...[...text.matchAll(JOIN_RE)].map((m) => m[1]
      .split(",")
      .map((piece) => piece.trim().replace(/^["'`]|["'`]$/g, ""))
      .filter((piece) => piece && piece !== "..")
      .join("/")),
  ])].filter((p) => {
    // 코퍼스는 게이트가 언급하는 **모든** 저장소 텍스트 파일이다. renderer/electron/shared 로
    // 좁히면 모바일·문서·설정 파일에 건 앵커가 "죽었다"로 잘못 보고된다(실측 오탐 6건).
    if (!/\.(?:tsx?|jsx?|cjs|mjs|css|json|md|txt|html|sh|py|toml|ya?ml|dart|kt|swift|rs|go)$/.test(p)) return false;
    if (p.startsWith("node_modules/") || p.includes("/node_modules/")) return false;
    try {
      const stat = fs.statSync(path.resolve(root, p));
      return stat.isFile() && stat.size <= 4 * 1024 * 1024;
    } catch { return false; }
  });
  if (sources.length === 0) continue;
  const corpus = sources.map((p) => readSource(p)).join("\n \n");
  const textNames = fileTextNames(text);
  for (const m of text.matchAll(MATCH_LINE_RE)) {
    if (!subjectIsFileText(m[1], textNames)) continue; // 파일 본문이 아닌 값에 건 단언
    let re;
    try {
      re = new RegExp(m[2], m[3].replace(/g/, ""));
    } catch {
      continue; // 동적 조립·비호환 플래그는 판단하지 않는다(오탐 금지).
    }
    if (!re.test(corpus)) {
      deadAnchors += 1;
      entries.push(`STALE-ANCHOR|${name}|${m[2]}`);
      report.push(`STALE-ANCHOR ${name}: /${m[2].slice(0, 90)}/ matches none of [${sources.join(", ")}]`);
    }
  }
}

const BASELINE = path.join(root, "scripts", "gate-staleness-baseline.json");
const mode = process.argv.includes("--update-baseline")
  ? "update"
  : process.argv.includes("--baseline") ? "baseline" : "report";

if (mode === "update") {
  fs.writeFileSync(BASELINE, `${JSON.stringify({
    note: "이미 낡아 있던 게이트 원장. 새 항목이 생기면 커밋이 거부된다 — 코드를 바꿨으면 그 게이트도 같은 커밋에서 고쳐라. 줄이는 것만 환영.",
    generatedFrom: "node scripts/verify-gate-freshness.mjs --update-baseline",
    entries: [...new Set(entries)].sort(),
  }, null, 2)}\n`, "utf8");
  console.log(`gate freshness: baseline written — ${new Set(entries).size} known stale entries`);
  process.exit(0);
}

if (mode === "baseline") {
  // 커밋 관문. 기존 낡음(원장에 있는 것)으로는 아무도 막지 않는다. 이번 변경이 **새로**
  // 만든 낡음만 막는다 — 그것이 "화면을 바꿨으면 그 게이트도 같은 커밋에서 갱신"의 기계 표현이다.
  let known = [];
  try {
    known = JSON.parse(fs.readFileSync(BASELINE, "utf8")).entries ?? [];
  } catch (cause) {
    // 원장이 있어야 할 자리에 없으면 통과시키지 않는다(부재를 성공으로 위장 금지).
    console.error(`gate freshness: baseline missing or unreadable at scripts/gate-staleness-baseline.json (${cause.message})`);
    console.error("run: node scripts/verify-gate-freshness.mjs --update-baseline");
    process.exit(1);
  }
  const knownSet = new Set(known);
  const fresh = entries.filter((entry) => !knownSet.has(entry));
  const fixed = known.filter((entry) => !entries.includes(entry));
  if (fresh.length) {
    console.error("gate freshness: 이번 변경이 게이트를 낡게 만들었습니다 —");
    for (const entry of fresh) {
      const [kind, gate, detail] = entry.split("|");
      console.error(`  ${kind} ${gate}`);
      console.error(`    ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}`);
    }
    console.error("");
    console.error("같은 커밋에서 둘 중 하나를 하세요:");
    console.error("  (a) 그 게이트를 새 계약으로 갱신한다 (구현 문자열이 아니라 계약을 단언할 것)");
    console.error("  (b) 게이트가 지키던 계약을 되돌린다");
    console.error("의도한 낡음이면: node scripts/verify-gate-freshness.mjs --update-baseline 후 원장을 같은 커밋에 포함하세요.");
    process.exit(1);
  }
  if (fixed.length) {
    console.log(`gate freshness: 원장의 낡음 ${fixed.length}건이 사라졌습니다 — --update-baseline 로 원장을 줄여 주세요.`);
  }
  console.log(`gate freshness: ok — 새 낡음 0건 (기존 ${knownSet.size}건은 원장에 있음)`);
  process.exit(0);
}

for (const line of report) console.log(line);
console.log(`gate freshness: ${gateFiles.length} gates scanned — dead paths ${deadPaths}, dead anchors ${deadAnchors}`);
// 탐지기는 보고가 임무다: 낡음이 있어도 exit 0으로 두면 아무도 안 본다. 단, 전면 빨강으로
// 개발을 막지 않게 "확실한 것"만 실패시킨다 — dead path는 확실, dead anchor는 SUSPECT 경고.
process.exit(deadPaths > 0 ? 1 : 0);
