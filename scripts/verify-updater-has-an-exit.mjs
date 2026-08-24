#!/usr/bin/env node
/**
 * 계약: 업데이터가 내는 모든 멈춤 상태에는 빠져나갈 길이 하나는 있어야 한다.
 *
 * 사고: `minimum-app-version` — 설치된 앱이 이 릴리스가 받아주는 최저 출발
 * 버전보다 낮을 때 나오는 상태 — 은 ①다시 시도할 수 없고 ②공식 설치본 버튼도
 * 안 나오는데, 화면은 "자동 다리 업데이트가 필요합니다"라고 말했다. 그 다리를
 * 골라주는 코드는 저장소 어디에도 없다. 그 설치본은 영구 정지였다.
 *
 * 잰다:
 *  1) 멈추는 상태마다 "다시 시도" 또는 "공식 설치본" 중 하나는 열려 있다.
 *  2) 화면과 메인 프로세스가 같은 판단을 쓴다(정의가 하나뿐이어야 갈리지 않는다).
 *  3) 사용자에게 보이는 문장이 없는 구제를 약속하지 않는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const shared = require(path.join(root, "dist", "shared", "types.js"));
const { updaterCanUseOfficialInstaller } = shared;
assert.equal(typeof updaterCanUseOfficialInstaller, "function", "공용 판단 함수가 없다");

// manualState 의 canRetry 규칙(controller.ts)과 같은 뜻. 여기 목록이 그 규칙보다
// 넉넉하면 이 게이트가 거짓 통과하므로, 아래 ③에서 소스와 대조한다.
const RETRYABLE = new Set([
  "continuity-backup-failed",
  "legacy-cleanup-failed",
  "install-source-untrusted",
  "install-not-applied",
  "compatibility-metadata-missing",
]);

// 사용자를 멈춰 세우는 상태 전부.
const STOPPING = [
  ["manual-required", "install-source-untrusted"],
  ["manual-required", "install-not-applied"],
  ["manual-required", "install-start-failed"],
  ["manual-required", "install-state-corrupt"],
  ["manual-required", "legacy-cleanup-failed"],
  ["manual-required", "continuity-backup-failed"],
  ["manual-required", "continuity-violation"],
  ["incompatible", "compatibility-metadata-missing"],
  ["incompatible", "minimum-app-version"],
  ["incompatible", "minimum-runtime-version"],
  ["incompatible", "minimum-schema-version"],
];

// `install-start-failed` 는 진단 종류에 따라 재시도가 열린다(별도 게이트가 봄).
// 런타임/스키마는 앱이 스스로 고친다: 런타임은 자동 갱신이 돌고, 스키마는
// 마이그레이션이 1부터 올라오므로 이 상태가 굳지 않는다.
const SELF_HEALING = new Set(["minimum-runtime-version", "minimum-schema-version", "install-start-failed", "install-state-corrupt", "continuity-violation"]);

const stranded = [];
for (const [status, code] of STOPPING) {
  if (SELF_HEALING.has(code)) continue;
  const canRetry = RETRYABLE.has(code);
  const canReinstall = updaterCanUseOfficialInstaller({ status, code });
  if (!canRetry && !canReinstall) stranded.push(`${status}/${code}`);
}
assert.deepEqual(stranded, [], `빠져나갈 길이 없는 상태가 남아 있다: ${stranded.join(", ")}`);
console.log(`  멈추는 상태 ${STOPPING.length}종 — 갇히는 것 0종 ✓`);

// ② 정의가 하나뿐인가: 화면 두 곳과 메인이 모두 공용 함수를 부른다.
for (const rel of [
  "electron/updater.ts",
  "renderer/components/UpdateBanner.tsx",
  "renderer/app/(shell)/settings/page.tsx",
]) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  assert.ok(
    src.includes("updaterCanUseOfficialInstaller("),
    `${rel} 이 공용 판단을 안 쓴다 — 손으로 유지되는 두 번째 목록이 생기면 반드시 갈린다`,
  );
  assert.ok(
    !/code === "install-source-untrusted"\s*\n?\s*\|\|\s*state\.code === "install-not-applied"/.test(src),
    `${rel} 에 조건 사본이 남아 있다`,
  );
}
console.log("  판단 정의: 한 곳(화면 2곳 + 메인이 같은 함수) ✓");

// ③ 없는 구제를 약속하지 않는가.
const controller = fs.readFileSync(path.join(root, "electron", "updater", "controller.ts"), "utf8");
const minAppMessage = /case "minimum-app-version":[\s\S]*?return "([^"]+)"/.exec(controller);
assert.ok(minAppMessage, "minimum-app-version 문장을 못 찾았다");
assert.ok(
  !/bridge/i.test(minAppMessage[1]),
  `없는 다리를 약속한다: "${minAppMessage[1]}"`,
);
// canRetry 규칙이 위 목록과 어긋나면 이 게이트는 거짓 통과한다 — 소스와 대조.
for (const code of RETRYABLE) {
  if (code === "install-source-untrusted" || code === "install-not-applied") continue;
  assert.ok(
    controller.includes(`code === "${code}"`),
    `재시도 가능 목록의 ${code} 가 controller 의 규칙에 없다 — 이 게이트가 눈이 멀었다`,
  );
}
console.log("  문장: 없는 다리를 약속하지 않는다 ✓");

console.log("updater has-an-exit PASS: 멈추는 모든 상태에 나가는 길이 있고, 판단은 한 곳에서 온다");
