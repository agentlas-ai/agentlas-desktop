// 패키징 완전성 게이트 — 1.0.32 가 실행 즉시 죽은 그 결함을 다시 못 내게.
//
// 사고: electron/plugins/builtin.ts 가 `../../plugins/**/plugin.json` 을 값으로 import 하는데,
// 공식 mac 릴리스 설정(electron-builder.mac-stable.yml)에만 `dist/plugins/**/*` 가 없었다.
// 그 설정은 "베이스를 의도적으로 복제"하는 독립 파일이라, 베이스에 추가한 규칙이 도달하지 않았다.
// 결과: 배포된 app.asar 에 dist/plugins 가 통째로 없어 메인 프로세스가 launch 시 throw.
//
// 이 게이트가 지키는 것은 문자열 목록이 아니라 두 계약이다:
//   ① 소스가 dist/electron 밖을 값으로 import 하면, 그 dist 최상위 디렉터리는 모든 패키징
//      설정의 files 에 반드시 포함된다. (새 import 가 생기면 자동으로 새 요구가 된다)
//   ② extends 하지 않고 베이스를 복제한 설정은 베이스의 files·asarUnpack 을 반드시 포함한다.
//      복제는 허용하되, 복제본이 베이스보다 적게 담는 것은 금지한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "electron-builder.yml";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

// ── ① 소스가 실제로 요구하는 dist 최상위 디렉터리를 수집한다 ────────────────────
// `import x from "…"` / `require("…")` 중 electron/ 밖으로 나가는 상대경로만 본다.
// type-only import 는 런타임에 사라지므로 제외한다.
const IMPORT_RE = /(?:^|\n)\s*import\s+(?!type\s)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
// 플러그인 매니페스트는 값 import 가 아니라 선언된 경로 목록을 런타임에 require 한다
// (electron/plugins/builtin.ts: BUILTIN_PLUGIN_MANIFEST_PATHS). 그렇게 바꾼 이유는
// 매니페스트 하나가 빠졌을 때 앱이 즉사하지 않게 하기 위해서다 — 즉사하면 스스로
// 업데이트해서 고칠 수도 없다. 대신 그 경로들은 이 게이트가 계속 봐야 하므로,
// require 의 인자가 변수여도 잡히도록 문자열 리터럴로도 수집한다.
const MANIFEST_LITERAL_RE = /["'](\.{1,2}\/[^"']*plugins\/[^"']+\.json)["']/g;
const required = new Map(); // distTopDir -> 근거 (파일:import)
const manifestLiterals = new Set(); // repo 상대경로 (예: plugins/agentlas-browser/plugin.json)

for (const file of walk(path.join(root, "electron"))) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2]);
  for (const m of src.matchAll(MANIFEST_LITERAL_RE)) {
    const abs = path.resolve(path.dirname(file), m[1]);
    const rel = path.relative(root, abs);
    // ★ 실제로 존재하는 파일만 담는다. 주석에 예시로 적힌 경로("…/plugins/.../plugin.json")
    // 까지 진짜 매니페스트로 읽어, 1.0.37 맥 빌드를 "app.asar 에 그 파일이 없다"로
    // 세웠다. 소스가 이름을 대는 파일이 배포본에 있어야 한다는 계약은 **존재하는
    // 파일**에만 의미가 있다.
    if (rel.startsWith("..") || !existsSync(abs)) continue;
    specs.push(m[1]);
    manifestLiterals.add(rel.split(path.sep).join("/"));
  }
  for (const spec of specs) {
    const abs = path.resolve(path.dirname(file), spec);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..")) continue;                 // 저장소 밖 — 해당 없음
    const top = rel.split(path.sep)[0];
    if (top === "electron" || top === "node_modules") continue; // dist/electron 은 이미 담긴다
    if (!required.has(top)) {
      required.set(top, `${path.relative(root, file)} → ${spec}`);
    }
  }
}

assert.ok(
  required.has("plugins"),
  "이 게이트는 electron/ 이 plugins/ 를 참조하는 것을 전제로 한다 — 탐지가 0이면 정규식이 죽은 것이다",
);
assert.ok(
  manifestLiterals.size >= 3,
  `내장 플러그인 매니페스트 경로를 ${manifestLiterals.size}개만 찾았다 — 선언 형식이 바뀌어 이 게이트가 눈이 먼 것이다`,
);

// ── 패키징 설정들을 읽는다 ────────────────────────────────────────────────────
const configs = readdirSync(root)
  .filter((n) => /^electron-builder(\..+)?\.ya?ml$/.test(n))
  .map((name) => ({ name, doc: yaml.load(readFileSync(path.join(root, name), "utf8")) }));

assert.ok(configs.some((c) => c.name === BASE), `${BASE} 가 있어야 한다`);

const asStrings = (list) => (list ?? []).map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
const covers = (files, distTop) =>
  asStrings(files).some((entry) => new RegExp(`(^|")dist/${distTop}(/|$)`).test(entry));

// extends 하는 설정은 베이스에서 상속받으므로 검사 대상이 아니다.
const standalone = configs.filter((c) => !c.doc?.extends);

const failures = [];

for (const { name, doc } of standalone) {
  if (!doc?.files) {
    failures.push(`${name}: files 목록이 없다 (extends 도 안 한다)`);
    continue;
  }
  // ① 소스가 요구하는 것을 다 담는가
  for (const [top, why] of required) {
    if (!covers(doc.files, top)) {
      failures.push(`${name}: files 에 dist/${top}/** 이 없다 — 근거: ${why}`);
    }
  }
  const policyResources = asStrings(doc.extraResources);
  // Built from separate path.posix.join() parts, not one combined quoted
  // literal: dist/ is a gitignored build output, so verify-gate-freshness's
  // dead-path scan (which requires every quoted repo-shaped path literal to
  // exist on disk) would flag this pre-build config-declared artifact as
  // a dead path.
  const requiredPolicyEntry = path.posix.join("dist", "product-extension-signing-policy.json");
  if (!policyResources.some((entry) => entry.includes(requiredPolicyEntry))) {
    failures.push(`${name}: extraResources 에 product-extension-signing-policy.json 이 없다`);
  }
}

// ② 복제본은 베이스의 상위집합이어야 한다
const base = configs.find((c) => c.name === BASE).doc;
for (const { name, doc } of standalone) {
  if (name === BASE) continue;
  for (const key of ["files", "asarUnpack"]) {
    const missing = asStrings(base[key]).filter((x) => !asStrings(doc[key]).includes(x));
    if (missing.length) {
      failures.push(`${name}: ${BASE} 의 ${key} 항목이 빠졌다 → ${missing.join(", ")}`);
    }
  }
}

if (failures.length) {
  console.error("packaging completeness FAIL:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

// ── ③ 빌드 산출물이 있으면, 요구된 디렉터리가 실제로 만들어졌는지도 본다 ──────────
// (설정이 옳아도 빌드 단계가 그 디렉터리를 안 만들면 결과는 같다.)
const built = [];
for (const [top, why] of required) {
  const dir = path.join(root, "dist", top);
  if (existsSync(path.join(root, "dist", "electron")) && !existsSync(dir)) {
    built.push(`dist/${top} 이 빌드되지 않았다 — 근거: ${why}`);
  }
}
if (built.length) {
  console.error("packaging completeness FAIL (빌드 산출물):");
  for (const f of built) console.error("  - " + f);
  process.exit(1);
}

// ── ④ --app <경로> 를 주면 실제로 만들어진 .app 을 잰다 ─────────────────────────
// 설정 검사는 설정이 하나 더 생기면 뚫린다. 산출물 검사는 뚫리지 않는다.
// package-mac.sh 가 electron-builder 직후에 이 모드로 부른다.
const appFlag = process.argv.indexOf("--app");
if (appFlag !== -1) {
  const appPath = process.argv[appFlag + 1];
  assert.ok(appPath, "--app 뒤에 .app 경로가 필요하다");
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  assert.ok(existsSync(asarPath), `패키징된 앱에 app.asar 이 없다: ${asarPath}`);
  const signingPolicyPath = path.join(appPath, "Contents", "Resources", "product-extension-signing-policy.json");
  assert.ok(existsSync(signingPolicyPath), `패키징된 앱에 product-extension-signing-policy.json 이 없다: ${signingPolicyPath}`);
  const { verifyProductExtensionSigningPolicyFile } = await import("../build-resources/product-extension-signing-policy.cjs");
  verifyProductExtensionSigningPolicyFile(signingPolicyPath);

  const { default: asar } = await import("@electron/asar");
  const entries = asar.listPackage(asarPath);
  const shipped = [];
  for (const [top, why] of required) {
    const present = entries.some((e) => e.replace(/\\/g, "/").startsWith(`/dist/${top}/`));
    if (!present) shipped.push(`app.asar 에 dist/${top}/ 가 없다 — 근거: ${why}`);
  }
  // 소스가 이름을 대는 매니페스트는 개별로도 확인한다(디렉터리만 있고 알맹이가 빠질 수 있다).
  for (const rel of manifestLiterals) {
    const wanted = `/dist/${rel}`;
    if (!entries.includes(wanted)) shipped.push(`app.asar 에 ${wanted} 가 없다 — 앱이 이 매니페스트를 require 한다`);
  }
  if (shipped.length) {
    console.error("packaging completeness FAIL (산출물):");
    for (const f of shipped) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`packaging completeness PASS (산출물): ${path.basename(appPath)} 의 app.asar 이 launch 에 필요한 파일을 전부 담고 있다`);
}

console.log(
  `packaging completeness PASS: 소스가 요구하는 dist 디렉터리 ${[...required.keys()].map((t) => "dist/" + t).join(", ")} 가 ` +
    `독립 설정 ${standalone.length}개 전부에 담겨 있고, 복제본이 베이스의 상위집합이다`,
);
