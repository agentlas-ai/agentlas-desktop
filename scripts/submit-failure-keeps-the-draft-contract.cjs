#!/usr/bin/env node
"use strict";
/*
 * 실행이 시작되지 않았으면 사용자가 쓴 것을 돌려준다 — One·Work 양쪽.
 *
 * ★왜 있나 (오너 실사용 2026-09-07): "One이나 Work나 둘다 내가 보낸 메세지가 자꾸
 *   없어진다 사진도 없어지고".
 *
 *   전송 실패는 실행 전에 던지는 길이 여러 갈래인데(팀 preflight, 워크스페이스 영수증,
 *   IPC, 그리고 Main 이 저장 전에 던지는 모든 것) 그때 사용자의 턴은 **어디에도 없다**:
 *     · Main 은 실행에 들어가야 그 턴을 저장한다(mcp/client.ts persistUserMessage).
 *     · 화면의 낙관적 줄은 메모리에만 있어 다음 기록 새로고침에 사라진다.
 *
 *   실측한 옛 상태:
 *     One  — 되돌리는 갈래가 둘뿐(새 대화 실패·첨부 준비 실패)이고 **그 외 전부**는
 *            글도 사진도 되돌리지 않았다.
 *     Work — 화면에 "입력 내용은 보존되었습니다" 라고 **적어 두고** 되돌리는 코드가
 *            없었다. setComposerPrefill 은 다른 자리에서만 쓰였다.
 *
 * 이 게이트는 실패 처리 블록만 잘라서 본다. 파일 전체 스캔이 아니다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: 시작 표식을 못 찾았습니다 (${startMarker})`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: 끝 표식을 못 찾았습니다 (${endMarker})`);
  return source.slice(start, end);
}
const codeLines = (block) => block.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
const callsIn = (block, needle) => codeLines(block).filter((line) => line.includes(needle));

const oneSource = fs.readFileSync(path.join(root, "renderer/components/one/OneShell.tsx"), "utf8");
const workSource = fs.readFileSync(path.join(root, "renderer/components/TaskCockpit.tsx"), "utf8");

check("★One — 실행이 시작되지 않은 실패는 글과 첨부를 되돌린다", () => {
  const block = sliceBetween(
    oneSource,
    'requestOneOperationalRecovery("one-submit", cause);',
    "}, [activeTaskforceAgentIds",
    "One 제출 실패",
  );
  // 되돌림은 recovery 호출 **앞**에 있어야 한다 — 그 앞 구간을 함께 본다.
  const wider = sliceBetween(oneSource, "} catch (cause) {\n      freshChatSubmissionPendingRef.current = false;", "}, [activeTaskforceAgentIds", "One catch");
  assert.ok(
    callsIn(wider, "setComposer(").length > 0,
    "제출이 실패했는데 사용자가 쓴 글을 작성창에 되돌리지 않습니다 — 그 글은 어디에도 남지 않습니다",
  );
  assert.ok(
    callsIn(wider, "setAttachmentDrafts(").length > 0,
    "첨부를 되돌리지 않습니다 — 사진이 통째로 사라집니다",
  );
  // 기록에 없는 낙관적 줄을 화면에 남기면 "보냈다"로 읽히고 새로고침 때 또 사라진다.
  assert.ok(
    callsIn(wider, "item.id !== preflightId").length > 0,
    "기록에 없는 낙관적 사용자 줄을 화면에 남깁니다",
  );
  assert.ok(block.length >= 0);
});

check("★Work — '보존되었습니다'라고 말하면 실제로 되돌려야 한다", () => {
  const block = sliceBetween(
    workSource,
    "        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.",
    "        setBusy(false);\n        setCancelPending(false);\n        setLiveAgents(",
    "Work 제출 실패",
  );
  assert.ok(
    callsIn(block, "setComposerPrefill(").length > 0,
    "입력을 되돌리지 않습니다 — 화면 문구만 '보존되었습니다'였고 되돌리는 코드는 없었습니다",
  );
  assert.ok(
    callsIn(block, "msg.id !== userMessageId").length > 0,
    "기록에 없는 낙관적 사용자 줄을 화면에 남깁니다",
  );
});

check("Work — 사진이 있었으면 다시 첨부해야 한다고 말한다(되돌릴 수 없는 것을 되돌렸다고 하지 않는다)", () => {
  const block = sliceBetween(
    workSource,
    "        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.",
    "        setBusy(false);\n        setCancelPending(false);\n        setLiveAgents(",
    "Work 제출 실패",
  );
  assert.match(block, /hadImages/, "사진 유무를 구분하지 않습니다");
  // The sentence moved into startFailureText(cause, locale, hadImages); the block passes
  // hadImages to it. Check the helper's words, not the block's text.
  const said = /다시 첨부/.test(block) || (
    /startFailureText\([^)]*hadImages\)/.test(block)
    && /function startFailureText[\s\S]*?hadImages[^\n]*다시 첨부/.test(workSource)
  );
  assert.ok(said, "사진을 되돌릴 수 없다는 사실을 사용자에게 말하지 않습니다");
});

check("어떤 표면도 '보존했다'고만 말하고 끝내지 않는다", () => {
  // 옛 문구가 그대로 남아 있으면 되돌림 없이 약속만 하는 상태로 되돌아간 것이다.
  assert.equal(
    callsIn(workSource, "입력 내용은 보존되었습니다").length,
    0,
    "되돌리지 않으면서 보존했다고 말하는 문구가 남아 있습니다",
  );
});

check("★고장 주입 — 위 검사들이 실제로 빨간불이 된다", () => {
  const brokenWork = [
    "        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.",
    "        setMessages((m) => m.map((msg) => msg.id === placeholderId ? { role: 'system' } : msg));",
    "        setBusy(false);",
    "        setCancelPending(false);",
    "        setLiveAgents(",
  ].join("\n");
  const block = sliceBetween(
    brokenWork,
    "        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.",
    "        setBusy(false);\n        setCancelPending(false);\n        setLiveAgents(",
    "주입",
  );
  assert.equal(callsIn(block, "setComposerPrefill(").length, 0, "옛 고장에서도 되돌림이 보인다 — 이 검사는 헛돈다");
  assert.equal(callsIn(block, "msg.id !== userMessageId").length, 0, "옛 고장에서도 줄 제거가 보인다");
  // 주석 안의 언급은 결함이 아니다.
  const commented = "        // invoke 실패 — 미리 건 구독을 정리해 유령 리스너가 남지 않게 한다.\n        // setComposerPrefill(x) 를 예전엔 안 불렀다\n        setBusy(false);\n        setCancelPending(false);\n        setLiveAgents(";
  const commentBlock = sliceBetween(commented, "        // invoke 실패", "        setBusy(false);\n        setCancelPending(false);\n        setLiveAgents(", "주입2");
  assert.equal(callsIn(commentBlock, "setComposerPrefill(").length, 0, "주석을 코드로 셌다");
});

process.stdout.write(`\nsubmit-failure-keeps-the-draft-contract: ${checks} checks passed\n`);
