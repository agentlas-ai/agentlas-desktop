#!/usr/bin/env node
/**
 * 회귀: 2026-08-22 1.0.31/1.0.32 실행 즉시 크래시.
 *
 * 사고: 공식 mac 릴리스 설정에 dist/plugins 가 빠져 app.asar 에 내장 플러그인
 * 매니페스트가 하나도 없었다. electron/plugins/builtin.ts 가 그 매니페스트들을
 * 모듈 최상단에서 값 import 하고 있었으므로 메인 프로세스가 창이 뜨기도 전에
 * throw 했다. 앱이 안 켜지니 스스로 업데이트해서 고칠 수도 없었고, 받은 사람은
 * 전원 손으로 지우고 다시 깔아야 했다.
 *
 * 계약: 매니페스트가 통째로 없어도
 *  1) builtin/catalog 모듈은 throw 하지 않고 로드된다 (= 앱이 켜져서 업데이트로 자가수리한다),
 *  2) 카탈로그는 나머지 항목을 그대로 들고 있다 (한 개 빠졌다고 전부 잃지 않는다),
 *  3) 못 읽은 매니페스트는 조용히 넘어가지 않고 목록으로 남는다.
 *
 * 이 게이트는 "그 실수를 다시 하지 않는다"가 아니라 "그 실수가 나도 치명적이지
 * 않다"를 잰다. 실수 자체를 막는 것은 verify-packaging-completeness.mjs 다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const live = path.join(dist, "plugins");
const parked = path.join(dist, "plugins.degrade-test-parked");

assert.ok(
  fs.existsSync(path.join(dist, "electron", "plugins", "builtin.js")),
  "dist 가 없다 — 먼저 npm run build:electron",
);
assert.ok(fs.existsSync(live), `dist/plugins 가 없다: ${live}`);

// 매니페스트 선언이 데이터로 남아 있어야 패키징 게이트가 그 경로들을 볼 수 있다.
const src = fs.readFileSync(path.join(root, "electron", "plugins", "builtin.ts"), "utf8");
assert.ok(
  /export const BUILTIN_PLUGIN_MANIFEST_PATHS\s*=\s*\[/.test(src),
  "매니페스트 경로는 선언된 목록으로 남아 있어야 한다 — 패키징 게이트가 이 목록을 읽는다",
);
assert.ok(
  !/^\s*import\s+\w+\s+from\s+["']\.\.\/\.\.\/plugins\/[^"']+\.json["']/m.test(src),
  "매니페스트를 다시 값 import 하면 매니페스트 하나가 빠질 때 앱이 즉사한다",
);

const probe = `
const b = require(${JSON.stringify(path.join(dist, "electron", "plugins", "builtin.js"))});
const c = require(${JSON.stringify(path.join(dist, "electron", "mcp-tools", "catalog.js"))});
process.stdout.write(JSON.stringify({
  entries: c.MCP_TOOL_CATALOG.length,
  failures: b.builtinPluginLoadFailures().length,
  builtinIds: b.builtinPluginToolIds(),
}));
`;

function probeOnce(label) {
  const out = execFileSync(process.execPath, ["-e", probe], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  console.log(`  ${label}: 카탈로그 ${parsed.entries}개, 못 읽은 매니페스트 ${parsed.failures}개`);
  return parsed;
}

const healthy = probeOnce("정상 설치본");
assert.equal(healthy.failures, 0, "정상 빌드인데 매니페스트를 못 읽었다");
assert.ok(healthy.builtinIds.length >= 4, "정상 빌드의 내장 도구가 사라졌다");

fs.renameSync(live, parked);
let broken;
try {
  // execFileSync 는 자식이 throw 하면(exit 1) 던진다 — 즉사하면 여기서 잡힌다.
  broken = probeOnce("매니페스트 없는 설치본");
} catch (error) {
  assert.fail(
    "매니페스트가 없다고 메인 프로세스 모듈이 죽었다 — 이러면 앱이 안 켜져서 자가수리도 못 한다:\n" +
      String(error.stderr || error.message),
  );
} finally {
  fs.renameSync(parked, live);
}

assert.equal(broken.builtinIds.length, 0, "매니페스트가 없는데 내장 도구가 남아 있다");
assert.equal(
  broken.failures,
  healthy.builtinIds.length > 0 ? broken.failures : 0,
  "실패 목록이 비어 있으면 부재가 조용히 넘어간 것이다",
);
assert.ok(broken.failures >= 3, `못 읽은 매니페스트가 ${broken.failures}개로 보고됐다 — 전부 보고돼야 한다`);
assert.ok(
  broken.entries > 0 && broken.entries === healthy.entries - healthy.builtinIds.length,
  `카탈로그가 ${healthy.entries} → ${broken.entries}. 빠진 내장 도구 ${healthy.builtinIds.length}개만 줄어야 한다`,
);

console.log("builtin plugins degrade PASS: 매니페스트가 통째로 없어도 앱은 켜지고, 손실은 그 도구들뿐이며, 부재는 보고된다");
