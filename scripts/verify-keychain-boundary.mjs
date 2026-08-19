#!/usr/bin/env node
// 키체인 경계 게이트 — "비밀 하나 읽다가 제품이 멈추는" 사고가 다시 나지 않게 지킨다.
//
// 배경(2026-08-19 실측). macOS 키체인 항목에는 그것을 만든 프로그램의 ACL 이 붙는다.
// 다른 실행 파일이 읽으려 하면 OS 가 승인 창을 띄우는데, 띄울 화면이 없는 호스트
// (플러그인 CLI·hep-graph·cron·데몬 없는 터미널)에서는 `keytar.getPassword` 가 영영
// 돌아오지 않는다. 그리고 그건 느린 호출이 아니라 **이벤트 루프 정지**다 —
// 같은 프로세스의 25초 setTimeout 이 2분 넘게 발화하지 않는 것을 측정했다.
// 그래서 `Promise.race([call, timeout])` 같은 자바스크립트 상한으로는 원리적으로 못 막는다.
//
// 실제 피해: 그래프의 에이전트 노드가 도구 자격증명 유무를 확인하다가
// (mcp-tools/auto-select → vault.readEnvVar → keytar) 실행 전체가 멈췄고, 화면에는
// "실행 중"만 남았다. 노드 상한 1시간이 지나야 죽는다.
//
// 지키는 계약:
//  1) `keytar` 를 import 하는 파일은 vault.ts 와 keychain-host.ts 둘뿐이다.
//  2) vault.ts 의 모든 keytar 호출은 keychain-host 의 래퍼를 **통해서만** 나간다.
//  3) keychain-host 는 화면 없는 호스트에서 자식 프로세스 + 하드 상한을 쓴다.
//  4) 저장할 비밀 값은 argv 가 아니라 stdin 으로 넘어간다(argv 는 같은 사용자의 ps 에 보인다).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

const ALLOWED = new Set([
  path.join(root, "electron/secrets/vault.ts"),
  path.join(root, "electron/secrets/keychain-host.ts"),
]);

// 1) keytar 를 아는 파일은 둘뿐이다.
// shared/ 도 훑는다 — 거기 들어간 import 는 renderer 번들까지 따라가므로
// "메인만 비밀을 만진다"는 계약 자체가 깨진다.
const importers = [];
for (const file of [...walk(path.join(root, "electron")), ...walk(path.join(root, "shared"))]) {
  const src = fs.readFileSync(file, "utf8");
  if (/from\s+["']keytar["']|require\(\s*["']keytar["']\s*\)/.test(src)) importers.push(file);
}
const strays = importers.filter((f) => !ALLOWED.has(f)).map((f) => path.relative(root, f));
check(
  "keytar-import-is-confined",
  strays.length === 0,
  `keytar 를 직접 import 하는 파일이 늘었습니다: ${strays.join(", ")}. `
  + "그 한 줄이 화면 없는 호스트에서 제품 전체를 멈춥니다 — electron/secrets/vault.ts 를 지나가세요.",
);

// 2) vault.ts 의 keytar 호출이 전부 래퍼를 통한다.
const vaultPath = path.join(root, "electron/secrets/vault.ts");
const vault = fs.existsSync(vaultPath) ? fs.readFileSync(vaultPath, "utf8") : null;
if (!vault) {
  check("vault-present", false, "electron/secrets/vault.ts 가 없습니다 — 게이트가 검사할 대상을 잃었습니다.");
} else {
  const wrappers = ["keychainGet", "keychainSet", "keychainDelete", "keychainListAccounts"];
  check(
    "vault-imports-the-wrapper",
    wrappers.every((name) => new RegExp(`\\b${name}\\b`).test(vault)),
    `vault.ts 가 ${wrappers.join(", ")} 를 모두 쓰지 않습니다 — 래퍼를 지나지 않는 호출이 남아 있습니다.`,
  );
  // keytar.* 가 나타나는 줄은 전부 래퍼의 fallback 인자(=화면 있는 호스트 전용) 안이어야 한다.
  const bareCalls = vault
    .split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /\bkeytar\.\w+\(/.test(line))
    .filter(({ line }) => !/=>/.test(line));
  check(
    "vault-has-no-unwrapped-keytar-call",
    bareCalls.length === 0,
    `vault.ts 에 래퍼를 안 거치는 keytar 호출이 있습니다(줄 ${bareCalls.map((b) => b.no).join(", ")}). `
    + "화면 없는 호스트에서 그 호출은 돌아오지 않습니다.",
  );
}

// 3) 래퍼가 실제로 자식 프로세스 + 하드 상한을 쓴다.
const hostPath = path.join(root, "electron/secrets/keychain-host.ts");
const host = fs.existsSync(hostPath) ? fs.readFileSync(hostPath, "utf8") : null;
if (!host) {
  check("keychain-host-present", false, "electron/secrets/keychain-host.ts 가 없습니다.");
} else {
  check(
    "bounded-call-runs-in-a-child-process",
    /execFile\(/.test(host) && /process\.execPath/.test(host),
    "래퍼가 자식 프로세스를 쓰지 않습니다. 같은 프로세스에 건 상한은 이벤트 루프와 함께 멈춰서 아무것도 못 막습니다.",
  );
  check(
    "child-is-killed-on-timeout",
    /timeout:\s*keychainCallTimeoutMs\(\)/.test(host) && /killSignal/.test(host),
    "자식에 상한과 killSignal 이 없습니다 — 멈춘 자식이 그대로 남습니다.",
  );
  check(
    "host-without-a-screen-takes-the-bounded-path",
    /\.type === "browser"/.test(host),
    "화면 유무를 `process.type === \"browser\"` 로 가르지 않습니다. `process.versions.electron` 은 "
    + "데몬(ELECTRON_RUN_AS_NODE=1)에서도 참이라, 창이 없는 데몬이 직접 호출 경로로 새어 멈춥니다.",
  );
  check(
    "electron-version-alone-is-not-the-test",
    !/return Boolean\(process\.versions\.electron\)/.test(host),
    "`process.versions.electron` 만으로 판정하는 코드가 돌아왔습니다 — 데몬이 그 판정을 통과하며 멈춥니다.",
  );
  check(
    "secret-value-never-rides-argv",
    /child\.stdin\?\.end\(/.test(host) && !/"set",\s*service,\s*account,\s*value\s*\]/.test(host),
    "저장할 비밀 값이 argv 로 넘어갑니다 — argv 는 같은 사용자의 ps 에 그대로 보입니다. stdin 으로 넘기세요.",
  );
  check(
    "write-failures-are-not-swallowed",
    /throw new KeychainUnavailableError\("write"/.test(host),
    "쓰기가 상한을 넘겼는데 조용히 성공으로 돌아옵니다 — 저장됐다고 착각하는 쪽이 더 나쁩니다.",
  );
}

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\nkeychain-boundary 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
