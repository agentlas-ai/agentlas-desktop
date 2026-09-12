#!/usr/bin/env node
/**
 * agy 공용 MCP 설정의 잔여 브라우저 항목 계약 — "남은 설정이 길을 영영 막지 않는다".
 *
 * 배경(2026-09-12 실측): agy 는 공용 설정에 적힌 서버를 전부 띄운다. 그래서 브라우저를
 * 요청하지 않은 실행도 남아 있는 항목 때문에 다른 실행의 승인 통로를 물려받을 수 있다.
 * 예전 코드는 그 위험을 **실행 거절**로 막았는데, 브라우저를 한 번이라도 쓴 기계에서는
 * 그 항목이 계속 남아 Science 의 agy 실행이 영영 시작되지 못했다(agy_mcp_browser_binding_missing).
 *
 * 못박는 계약(구현 문장이 아니라 결과):
 *  1. 브라우저를 요청하지 않은 실행은 **거절되지 않는다** — 실행 동안만 격리한다.
 *  2. 격리는 위험을 남기지 않는다 — 남의 항목을 물려받지 않는다.
 *  3. 이 프로세스의 다른 실행이 그 키를 들고 있으면 건드리지 않는다.
 *  4. 브라우저를 요청한 실행은 예전처럼 조정 경로를 그대로 탄다.
 *  5. 우리 것이 아닌(사용자가 직접 등록한) 항목은 손대지 않는다.
 *
 * 실행: node scripts/agy-browser-entry-disposition-contract.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist/electron/runtime/antigravity.js");
if (!fs.existsSync(dist)) {
  console.error(`빌드 산출물이 없다: ${dist}\n먼저 'npx tsc -p electron/tsconfig.json' 을 돌릴 것.`);
  process.exit(2);
}
const { agyBrowserEntryDisposition, isAgentlasWrittenMcpEntry } = require(dist);

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}\n       ${error.message}`); }
}

check("남은 우리 항목 + 브라우저 미요청 = 격리(거절 아님)", () => {
  assert.strictEqual(
    agyBrowserEntryDisposition({ owned: true, requested: false, heldByThisProcess: false }),
    "quarantine",
    "브라우저를 쓰지 않는 실행이 남은 설정 때문에 막힌다",
  );
});

check("어떤 조합에서도 실행을 거절하지 않는다", () => {
  for (const owned of [true, false]) {
    for (const requested of [true, false]) {
      for (const heldByThisProcess of [true, false]) {
        const verdict = agyBrowserEntryDisposition({ owned, requested, heldByThisProcess });
        assert.ok(
          ["ignore", "quarantine", "reconcile"].includes(verdict),
          `알 수 없는 판정 ${verdict} (owned=${owned} requested=${requested} held=${heldByThisProcess})`,
        );
        assert.notStrictEqual(verdict, "refuse", "거절은 더 이상 이 판정의 선택지가 아니다");
      }
    }
  }
});

check("이 프로세스의 다른 실행이 들고 있으면 건드리지 않는다", () => {
  assert.strictEqual(
    agyBrowserEntryDisposition({ owned: true, requested: false, heldByThisProcess: true }),
    "ignore",
    "도는 실행의 도구 통로를 빼앗는다",
  );
});

check("브라우저를 요청한 실행은 조정 경로로 간다", () => {
  assert.strictEqual(agyBrowserEntryDisposition({ owned: true, requested: true, heldByThisProcess: false }), "reconcile");
  assert.strictEqual(agyBrowserEntryDisposition({ owned: true, requested: true, heldByThisProcess: true }), "reconcile");
});

check("우리 것이 아닌 항목은 어떤 경우에도 손대지 않는다", () => {
  for (const requested of [true, false]) {
    for (const heldByThisProcess of [true, false]) {
      assert.strictEqual(
        agyBrowserEntryDisposition({ owned: false, requested, heldByThisProcess }),
        "ignore",
        "사용자가 직접 등록한 서버를 건드린다",
      );
    }
  }
});

// ── 우리 항목인지 알아보는 판정 — 모양이 여러 가지다(실측 2026-09-12) ──
check("브라우저 승인 프록시는 우리 것이다", () => {
  assert.strictEqual(isAgentlasWrittenMcpEntry({
    command: "/Applications/Agentlas.app/Contents/MacOS/Agentlas",
    args: ["/x/dist/electron/mcp-tools/proxy-child.cjs"],
    env: { ELECTRON_RUN_AS_NODE: "1", AGENTLAS_MCP_PROXY_CONTROL: "/tmp/c", AGENTLAS_MCP_PROXY_TARGET: "{}", AGENTLAS_MCP_PROXY_SERVER_KEY: "k", AGENTLAS_MCP_PROXY_SESSION: "s" },
  }), true);
});

check("인라인 스크립트로 띄우는 내장 서버(Science·Time)도 우리 것이다", () => {
  assert.strictEqual(isAgentlasWrittenMcpEntry({
    command: "/Applications/Agentlas.app/Contents/MacOS/Agentlas",
    args: ["-e", "/* inline */"],
    env: { ELECTRON_RUN_AS_NODE: "1", AGENTLAS_AGY_MCP_GENERATION: "gen-1", AGENTLAS_AGY_MCP_SERVER_KEY: "agentlas-science" },
  }), true, "지난 실행에 우리가 남긴 항목을 남의 것으로 오인하면 스스로를 거절한다");
});

check("사용자가 직접 등록한 서버는 우리 것이 아니다", () => {
  for (const entry of [
    { command: "npx", args: ["-y", "mongodb-mcp-server"], env: { MDB_MCP_CONNECTION_STRING: "x" } },
    { command: "hephaestus", args: ["mcp", "serve"] },
    { command: "npx", args: ["-y", "some-tool"], env: {} },
    {},
  ]) {
    assert.strictEqual(isAgentlasWrittenMcpEntry(entry), false, `남의 항목을 우리 것으로 봤다: ${JSON.stringify(entry)}`);
  }
});

check("우리 것이면 거절하지 않고 갈아 끼우는 경로로 간다", () => {
  const source = fs.readFileSync(path.join(root, "electron/runtime/antigravity.ts"), "utf8");
  assert.match(
    source,
    /if \(isAgentlasWrittenMcpEntry\(parsed\.mcpServers\[key\] \?\? \{\}\)\) continue;/,
    "우리가 남긴 항목에서 scope-conflict 로 거절하는 길이 되살아났다",
  );
  assert.doesNotMatch(
    source,
    /key === "agentlas-browser"\s*&& !AGY_MCP_REFCOUNT\.has\(key\)/,
    "교체 경로가 브라우저 키에만 열려 있으면 Science·Time 잔여 항목은 그대로 막힌다",
  );
});

check("격리한 항목을 되돌리는 코드가 정리 경로에 있다", () => {
  const source = fs.readFileSync(path.join(root, "electron/runtime/antigravity.ts"), "utf8");
  assert.match(
    source,
    /quarantinedBrowser && current && !current\.mcpServers!\[BROWSER_KEY\]/,
    "실행이 끝나도 격리한 설정이 돌아오지 않으면 사용자의 브라우저 도구가 사라진다",
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
