// 설치 비콘 게이트 — "누가 어떤 버전을 쓰나"를 서버가 다시 못 보게 되는 일을 막는다.
//
// 배경: 1.0.31·1.0.32 가 실행 즉시 죽는 채로 나갔을 때 영향 범위를 셀 근거가 GitHub 다운로드
// 횟수뿐이었다. 이 게이트가 지키는 것은 구현 문장이 아니라 세 가지 계약이다:
//   ① 창이 뜬 뒤(startup boundary 통과 후) 비콘이 시작된다 — 그 전이면 깨진 설치와 구분이 안 된다.
//   ② 비콘은 버전·OS·아키텍처·채널·installId 만 싣는다. 경로·메모리·대화는 절대 싣지 않는다.
//   ③ 실패는 조용히 넘긴다 — 비콘이 제품을 흔들면 안 된다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const main = read("electron/main.ts");
const beacon = read("electron/install-beacon.ts");

// ① 순서: window-loaded 흔적 뒤에서 시작한다.
const loadedAt = main.indexOf('traceStartup("window-loaded")');
const startAt = main.indexOf("startInstallBeacon(");
assert.ok(loadedAt > 0, "main.ts must still mark window-loaded");
assert.ok(startAt > loadedAt, "the install beacon must start after the window is loaded, not before");
assert.match(main, /import \{ startInstallBeacon \} from "\.\/install-beacon"/, "main.ts must wire the beacon module");

// ② 페이로드 계약: 허용 키만, 금지 단어는 없음.
const payloadBlock = beacon.slice(beacon.indexOf("export type InstallBeaconPayload"), beacon.indexOf("};", beacon.indexOf("export type InstallBeaconPayload")));
const keys = [...payloadBlock.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
assert.deepEqual(keys, ["arch", "channel", "installId", "launchedAt", "platform", "version"], "beacon payload keys drifted — widen only with an explicit privacy review");
for (const forbidden of ["homedir", "process.env", "memory", "chat", "readFileSync"]) {
  assert.ok(!beacon.includes(forbidden), `install-beacon.ts must not touch ${forbidden}`);
}

// ③ 실패 삼킴 + 단일 타이머.
assert.match(beacon, /catch \{\s*return false;\s*\}/, "a failed beacon must return false, never throw into boot");
assert.match(beacon, /if \(_timer\) return;/, "starting the beacon twice must not create a second timer");
assert.match(beacon, /\.unref\?\.\(\)/, "the beacon timer must not keep the process alive");

console.log("install beacon PASS: starts after window-loaded, carries only version/platform/arch/channel/installId, never throws");
