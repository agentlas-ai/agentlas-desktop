#!/usr/bin/env node
/**
 * 사용자 본문 보존 계약 — "렌더는 프로토콜을 벗기지, 답을 편집하지 않는다".
 *
 * 배경(사용자 제보 + 전수 조사, 2026-08-15):
 * 최종 표시 정제기가 모델이 사용자에게 준 본문을 지우고 있었다.
 *  - 모든 셸 코드블록(```bash|sh|shell|zsh|powershell|cmd)을 문맥 없이 삭제
 *    → 실행하라고 받은 명령이 화면에서 사라짐(DB 원문에는 남아 있어 화면만 거짓)
 *  - localhost/127.0.0.1 URL을 "local preview"로 치환 → 열어야 할 주소가 없어짐
 *  - "완료했습니다"가 600자 뒤에 나오면 그 앞을 통째로 잘라냄
 *
 * 그리고 그 코드가 **어떤 grep에도 안 잡히던** 이유가 따로 있었다: 소스에 리터럴
 * NUL 바이트가 들어 있어 file(1)이 binary로 판정, 텍스트 기반 검사가 전부 그 파일을
 * 건너뛰었다. 5개 파일이 같은 상태였다.
 *
 * 이 게이트가 못박는 것:
 *  1. 소스에 리터럴 NUL이 없다 — 있으면 그 파일은 모든 검색·게이트의 사각지대가 된다
 *  2. 최종 표시 정제기가 셸 코드블록/로컬 URL을 삭제하지 않는다
 *  3. 계정명이 드러나는 절대경로와 U+FFFD는 계속 가린다(이건 사용자가 쓸 수 없는 정보)
 *
 * 실행: node scripts/user-content-preservation-contract.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];
let passed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}\n       ${error.message}`); }
}

/** 소스 트리를 순회하며 리터럴 NUL을 가진 파일을 찾는다. */
function filesWithLiteralNul() {
  const roots = ["renderer", "electron", "shared", "scripts"];
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".md"]);
  const skip = new Set(["node_modules", ".next", ".next-build", "dist", "release", "release-local", ".git", "Hephaestus"]);
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(full); continue; }
      if (!exts.has(path.extname(entry.name))) continue;
      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }
      if (buf.includes(0)) hits.push(path.relative(root, full));
    }
  };
  for (const r of roots) walk(path.join(root, r));
  return hits;
}

console.log("user-content-preservation-contract");

// 1. 사각지대를 만드는 리터럴 NUL
check("★소스에 리터럴 NUL이 없다(있으면 grep·보안스캔이 그 파일을 건너뛴다)", () => {
  const hits = filesWithLiteralNul();
  assert.deepEqual(
    hits, [],
    `리터럴 NUL이 남아 있다 — U+0000이 필요하면 "\\u0000" 이스케이프로 쓸 것:\n  ${hits.join("\n  ")}`,
  );
});

// 2. 최종 표시 정제기가 사용자 본문을 지우지 않는다
const chatStream = fs.readFileSync(path.join(root, "renderer/components/ChatStream.tsx"), "utf8");
const cleaner = (() => {
  const start = chatStream.indexOf("function userFacingAssistantText");
  assert.ok(start >= 0, "userFacingAssistantText를 찾지 못했다");
  const end = chatStream.indexOf("\nfunction ", start + 1);
  return chatStream.slice(start, end > 0 ? end : undefined);
})();
/** 주석을 뺀 실제 코드만 본다 — 설명 주석에 옛 패턴을 적어둘 수 있어야 한다. */
const cleanerCode = cleaner
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

check("★셸 코드블록을 삭제하지 않는다", () => {
  assert.ok(
    !/```\(\?:bash|\(\?:bash\|sh\|shell\|zsh/.test(cleanerCode),
    "셸 fence를 통째로 지우는 정규식이 살아 있다 — 사용자가 받은 명령이 화면에서 사라진다",
  );
});

check("★로컬 미리보기 URL을 지우거나 치환하지 않는다", () => {
  assert.ok(
    !/local preview/.test(cleanerCode),
    "localhost URL을 치환하고 있다 — 사용자가 열어야 할 주소가 없어진다",
  );
  assert.ok(
    !/127\\\.0\\\.0\\\.1\|localhost/.test(cleanerCode),
    "로컬 URL 매칭 정규식이 정제기에 남아 있다",
  );
});

check("★긴 답의 앞부분을 낱말 판정으로 잘라내지 않는다", () => {
  assert.ok(
    !/outcomeStart|legacyProgress/.test(cleanerCode),
    "본문 앞부분을 잘라내는 legacy guard가 살아 있다 — 낱말로는 설명과 로그를 가를 수 없다",
  );
});

// 3. 계속 가려야 하는 것은 그대로 가린다
check("계정명이 드러나는 절대경로는 계속 가린다", () => {
  assert.ok(/\/Users\\\//.test(cleanerCode), "절대경로 마스킹이 사라졌다");
});

check("이미 깨진 바이트(U+FFFD)는 계속 가린다", () => {
  assert.ok(/\\uFFFD|�/.test(cleanerCode), "U+FFFD 처리가 사라졌다");
});

// 4. 승인이 없어 막힌 도구 호출은 조용히 넘어가지 않는다
const distRefusal = path.join(root, "dist/electron/runtime/runtime-refusal.js");
if (fs.existsSync(distRefusal)) {
  const { detectApprovalRequired } = require(distRefusal);

  check("★승인 대기로 막힌 tool_result를 감지한다(실측 문구)", () => {
    const bash = detectApprovalRequired(
      "This Bash command contains multiple operations.\nThe following part requires approval: npm run verify 2>&1",
    );
    assert.ok(bash, "Bash 승인 요구를 놓쳤다");
    assert.equal(bash.blocked, "npm run verify 2>&1", "막힌 명령을 뽑지 못했다");

    const write = detectApprovalRequired(
      "Claude requested permissions to write to /p/.claude/settings.local.json, but you haven't granted it yet.",
    );
    assert.ok(write, "파일 쓰기 승인 요구를 놓쳤다");
  });

  check("승인 감지가 평범한 도구 실패를 물지 않는다", () => {
    for (const benign of [
      "npm ERR! code ENOENT",
      "Error: connect ECONNREFUSED 127.0.0.1:5432",
      "TypeError: cannot read property of undefined",
      "The file was written successfully.",
    ]) {
      assert.equal(detectApprovalRequired(benign), null, `오탐: ${benign}`);
    }
  });
} else {
  console.log("  --  승인 감지 검사는 건너뜀 (dist 빌드 필요)");
}

check("★claude 런타임이 승인 차단을 사용자에게 고지한다", () => {
  const src = fs.readFileSync(path.join(root, "electron/runtime/claude-code.ts"), "utf8");
  assert.match(src, /detectApprovalRequired/, "승인 감지를 부르지 않는다");
  assert.match(src, /approval-required/, "고지에 식별 코드가 없다");
  // tool_result 처리 지점 둘 다에 붙어야 한다 — 한쪽만 붙으면 이벤트 모양에 따라 샌다.
  const hooks = (src.match(/announceApprovalBlock\(result\)/g) ?? []).length;
  assert.ok(hooks >= 2, `tool_result 처리 ${hooks}곳에만 붙었다(2곳 필요)`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
