#!/usr/bin/env node
/**
 * 실행 파일 신원 관찰 계약 — "띄울 때 쓰는 PATH 로 찾는다".
 *
 * 배경(2026-09-11 실측): 패키징된 GUI 앱은 로그인 셸 PATH 를 상속받지 못해
 * PATH 가 `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이다. exec.ts 의 withCliPath 는
 * 실행 직전에 여기에 `~/.local/bin` 등 CLI 설치 자리를 보강한다. 그런데 실행
 * 직전에 추가된 신원 관찰이 **호출자의 원래 env** 로 bare 커맨드를 찾는 바람에,
 * spawnCli 가 정상적으로 띄웠을 CLI 를 "설치되지 않음" 으로 거절했다
 * (Science·Work 의 agy 실행 전멸).
 *
 * 못박는 계약(구현 문장이 아니라 결과):
 *  1. bare 커맨드는 GUI 최소 PATH 에서도, 실행에 쓰일 PATH 에 있으면 찾아진다.
 *  2. 찾은 실행 파일은 spawnCli 가 쓸 PATH 의 첫 후보와 같다(감지≠실행 금지).
 *  3. 어디에도 없으면 여전히 null — 보강이 없는 부재를 가리지 않는다.
 *  4. 회귀 방향 확인: 호출자 원래 PATH 만으로 찾으면 1번이 성립하지 않는다.
 *
 * 실행: node scripts/cli-executable-identity-path-contract.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist/electron/runtime/cli-executable-identity.js");
if (!fs.existsSync(dist)) {
  console.error(`빌드 산출물이 없다: ${dist}\n먼저 'npx tsc -p electron/tsconfig.json' 을 돌릴 것.`);
  process.exit(2);
}

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}\n       ${error.message}`); }
}

/** GUI 로 띄운 앱이 실제로 갖는 PATH. */
const GUI_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-identity-home-"));
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-identity-empty-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-identity-cwd-"));
const installedDir = path.join(home, ".local", "bin");
fs.mkdirSync(installedDir, { recursive: true });
const installed = path.join(installedDir, "agy");
fs.writeFileSync(installed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

process.env.HOME = home;
assert.strictEqual(os.homedir(), home, "테스트 전제 실패: HOME 주입이 os.homedir() 에 반영되지 않는다");

const { observeCliExecutableIdentity } = require(dist);
const { envForCli } = require(path.join(root, "dist/electron/runtime/exec.js"));

/** 주어진 PATH 에서 bare 커맨드를 찾는 참조 구현 — 실행이 고를 후보. */
function resolveOnPath(bin, searchPath) {
  for (const dir of String(searchPath || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(cwd, dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

check("GUI 최소 PATH 에서도 설치된 bare 커맨드를 찾는다", () => {
  const identity = observeCliExecutableIdentity({ bin: "agy", cwd, env: { PATH: GUI_PATH } });
  assert.ok(identity, "설치돼 있는데 찾지 못했다 — 실행 직전 거절이 재발한다");
  assert.strictEqual(fs.realpathSync(identity.executable), fs.realpathSync(installed));
});

check("찾은 실행 파일이 spawnCli 가 쓸 PATH 의 첫 후보와 같다", () => {
  const launchPath = envForCli("agy", { PATH: GUI_PATH }).PATH;
  const expected = resolveOnPath("agy", launchPath);
  assert.ok(expected, "테스트 전제 실패: 실행 PATH 에서도 못 찾는다");
  const identity = observeCliExecutableIdentity({ bin: "agy", cwd, env: { PATH: GUI_PATH } });
  assert.strictEqual(identity && identity.executable, expected);
});

check("회귀 방향 — 호출자 원래 PATH 만으로는 찾지 못한다(옛 동작)", () => {
  assert.strictEqual(resolveOnPath("agy", GUI_PATH), null,
    "이 검사는 보강된 PATH 덕에 통과한 것인지 구분하지 못한다");
});

check("어디에도 없으면 null 이다", () => {
  process.env.HOME = emptyHome;
  try {
    const identity = observeCliExecutableIdentity({ bin: "agy", cwd, env: { PATH: GUI_PATH } });
    assert.strictEqual(identity, null, "부재를 가렸다");
  } finally {
    process.env.HOME = home;
  }
});

for (const dir of [home, emptyHome, cwd]) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
