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

// 5. 승인 프로토콜 — 런타임이 말하는 승인을 화면이 받는가
check("★승인 계약이 live 와 post-denial 을 구분한다", () => {
  const src = fs.readFileSync(path.join(root, "electron/runtime/tool-approval.ts"), "utf8");
  assert.match(src, /mode === "live"|mode: "live"/, "live 모드가 없다");
  assert.match(src, /post-denial/, "post-denial 모드가 없다");
  // live 는 답을 기다리되 영원히 기다리지 않는다 — 이 제품에서 무한 대기는 이미 겪은 실패다.
  assert.match(src, /timeoutMs/, "live 요청에 만료가 없다");
  assert.match(src, /deniedBy/, "자동 거부와 사람의 거절을 구분하는 칸이 없다");
});

check("★거부를 감지한 런타임이 승인 계약으로 올린다", () => {
  for (const rel of ["electron/runtime/antigravity.ts", "electron/runtime/claude-code.ts"]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(src, /announceToolDenied\(/, `${rel}가 거부를 승인 계약으로 올리지 않는다`);
    assert.match(src, /deniedBy: "runtime-headless"/, `${rel}가 자동 거부임을 표시하지 않는다`);
  }
});

check("★화면까지 배선되어 있다(IPC · preload · 시트 · 마운트)", () => {
  const ipcSrc = fs.readFileSync(path.join(root, "electron/ipc.ts"), "utf8");
  assert.match(ipcSrc, /runtime:toolApprovalRequest/, "승인 요청이 렌더러로 방송되지 않는다");
  assert.match(ipcSrc, /runtime:resolveToolApproval/, "승인 결정 핸들러가 없다");

  const preloadSrc = fs.readFileSync(path.join(root, "electron/preload.ts"), "utf8");
  assert.match(preloadSrc, /onToolApproval/, "preload가 승인 구독을 노출하지 않는다");
  assert.match(preloadSrc, /resolveToolApproval/, "preload가 승인 결정을 노출하지 않는다");

  /*
   * ★오너 결정(2026-08-15): 승인 카드는 "묻는 순간, 그 실행이 있는 대화 안에서만".
   *  - 대화 화면(One/Work)이 자기 chatId 의 live 요청을 인라인으로 그린다.
   *  - 전역(AppShell)은 모달이 아니라 배지 — 지금 화면에 없는 대화의 요청만 세고 그 대화로 보낸다.
   *  - post-denial 은 카드가 아니다(큐가 live 만 담는다). 러너의 알림 한 줄이 전부다.
   */
  const store = fs.readFileSync(path.join(root, "renderer/lib/tool-approvals.ts"), "utf8");
  assert.match(store, /mode !== "live"\) return/, "승인 큐가 post-denial 을 카드로 받는다");
  assert.match(store, /listToolApprovals/, "화면이 늦게 떠도 대기 중 요청을 따라잡지 않는다");
  assert.match(store, /markChatVisible/, "대화 가시성 등록이 없어 배지가 인라인과 겹친다");

  const inline = fs.readFileSync(path.join(root, "renderer/components/ToolApprovalInline.tsx"), "utf8");
  assert.match(inline, /allow_once/, "live 승인 버튼이 없다");
  assert.match(inline, /allow_session/, "세션 허용 버튼이 없다");
  assert.match(inline, /item\.chatId === chatId/, "인라인 카드가 자기 대화의 요청만 고르지 않는다");
  assert.ok(!/다음부터 허용|Allow from next run/.test(inline), "post-denial 문구가 카드에 남아 있다 — 사후 고지는 카드가 아니다");

  const sheet = fs.readFileSync(path.join(root, "renderer/components/ToolApprovalSheet.tsx"), "utf8");
  assert.ok(!/OneBottomSheet|alertdialog/.test(sheet), "전역 표면이 여전히 모달이다 — 배지여야 한다");
  assert.match(sheet, /needsBadge/, "전역 배지가 '지금 화면에 없는 대화'만 세지 않는다");
  assert.match(sheet, /openConversation/, "배지가 그 대화로 보내지 않는다");

  const shell = fs.readFileSync(path.join(root, "renderer/components/AppShell.tsx"), "utf8");
  assert.match(shell, /<ToolApprovalSheet \/>/, "전역 배지가 마운트되지 않았다");
  for (const rel of ["renderer/components/one/OneShell.tsx", "renderer/components/TaskCockpit.tsx"]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(src, /<ToolApprovalInline chatId=/, `${rel} 이 대화 안에 승인 카드를 그리지 않는다`);
  }
});

check("★승인은 경계를 넘을 때만 묻는다 — 권한 범위 안은 처음부터 허용", () => {
  const ipcSrc = fs.readFileSync(path.join(root, "electron/ipc.ts"), "utf8");
  const arb = ipcSrc.slice(ipcSrc.indexOf("setAcpPermissionArbiter(async"), ipcSrc.indexOf("onToolApprovalRequested((request)"));
  assert.match(arb, /ask\.permission === "full"\) return "allow_session"/, "full 이 묻는다");
  assert.match(arb, /!ask\.mutating\) return/, "비변이 도구가 묻는다");
  assert.match(arb, /ask\.permission === "write"\) return "allow_session"/, "write 범위 안 변이가 묻는다");
  assert.match(arb, /!ask\.chatId \|\| ask\.unattended/, "답할 사람 없는 실행이 매달린다(즉시 거부+고지여야 함)");
  assert.match(arb, /announceToolDenied\(/, "무인 실행 거부가 기록되지 않는다");
  assert.match(arb, /chatId: ask\.chatId/, "요청이 대화 id 를 싣지 않아 인라인으로 갈 수 없다");

  // 묻는 순간이 없는 헤드리스는 spawn 플래그로 같은 규칙을 미리 준다.
  const claude = fs.readFileSync(path.join(root, "electron/runtime/claude-code.ts"), "utf8");
  assert.match(claude, /WRITE_MODE_PRE_ALLOWED_TOOLS = \["Bash"/, "claude write 모드가 Bash 를 여전히 묻게 둔다(헤드리스 자동거부)");
  const grok = fs.readFileSync(path.join(root, "electron/runtime/grok.ts"), "utf8");
  assert.match(grok, /"acceptEdits", "--allow", "Bash"/, "grok write 모드가 Bash 를 여전히 묻게 둔다");
  const acp = fs.readFileSync(path.join(root, "electron/runtime/acp.ts"), "utf8");
  assert.match(acp, /chatId: req\.chatId/, "acp 러너가 요청에 대화 id 를 싣지 않는다");
  assert.match(acp, /unattended: req\.unattended === true/, "acp 러너가 무인 여부를 싣지 않는다");
});

check("★실행 전에 묻는 런타임(ACP)은 사용자에게 묻는다", () => {
  const acp = path.join(root, "electron/runtime/acp.ts");
  if (!fs.existsSync(acp)) { console.log("       (acp.ts 없음 — 건너뜀)"); return; }
  const src = fs.readFileSync(acp, "utf8");
  // 결합은 주입이다 — acp 는 승인 계약 파일을 import 하지 않는다(커밋 순서 독립).
  assert.ok(!/from "\.\/tool-approval"/.test(src), "acp 가 승인 계약을 직접 import 한다(주입이어야 함)");
  assert.match(src, /setAcpPermissionArbiter/, "arbiter 주입 지점이 없다");
  assert.match(src, /async answerPermission/, "승인 응답이 동기라 사용자에게 물을 수 없다");

  const ipcSrc = fs.readFileSync(path.join(root, "electron/ipc.ts"), "utf8");
  assert.match(ipcSrc, /setAcpPermissionArbiter\(/, "arbiter 가 등록되지 않아 ACP 는 여전히 대신 답한다");
  assert.match(ipcSrc, /requestToolApproval\(/, "ACP arbiter 가 live 승인 계약을 쓰지 않는다");
});

check("권한을 강제할 수 없는 런타임은 그 사실을 말한다", () => {
  const kimi = fs.readFileSync(path.join(root, "electron/runtime/kimi.ts"), "utf8");
  assert.match(kimi, /permission-not-enforceable/, "kimi가 권한 미전달 사실을 숨긴다");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
