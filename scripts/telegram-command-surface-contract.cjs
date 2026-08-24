#!/usr/bin/env node
// 텔레그램 명령 표면 계약.
//
// 명령은 세 곳에서 동시에 소비된다: setMyCommands 등록 목록, 디스패치 스위치, /help.
// 손으로 관리하는 목록이 여러 개면 반드시 표류한다(터미널 쪽에서 실제로 4개가 어긋났다).
// 여기서 그 셋이 한 카탈로그에서 나온다는 사실 자체를 잠근다.
//
// 순수 노드로 돈다 — electron/better-sqlite3 없이 빌드 산출물만 읽는다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const catalog = require(path.join(root, "dist/electron/telegram/commands-catalog.js"));
const sync = require(path.join(root, "dist/electron/telegram/commands-sync.js"));
const inlineSelect = require(path.join(root, "dist/electron/telegram/inline-select.js"));

const { TELEGRAM_COMMANDS, TELEGRAM_COMMAND_NAME_RE, registrableTelegramCommands, findTelegramCommand } = catalog;

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

// 1. 텔레그램 BotCommand 규격 — 하이픈은 등록 불가다.
check("every command name matches Telegram's [a-z0-9_]{1,32}", () => {
  for (const entry of TELEGRAM_COMMANDS) {
    assert.match(entry.name, TELEGRAM_COMMAND_NAME_RE, `invalid command name: ${entry.name}`);
    assert.match(entry.name, /^[a-z0-9_]{1,32}$/, `invalid command name: ${entry.name}`);
  }
});

// 2. 별칭은 절대 등록 목록에 들어가면 안 된다(텔레그램이 400으로 거절한다).
check("aliases are never registered, and hyphenated aliases exist where promised", () => {
  const registeredNames = new Set(TELEGRAM_COMMANDS.filter((e) => e.registered).map((e) => e.name));
  for (const entry of TELEGRAM_COMMANDS) {
    for (const alias of entry.aliases ?? []) {
      assert.equal(registeredNames.has(alias), false, `alias must not be a registered name: ${alias}`);
    }
  }
  const mustHaveHyphenAlias = [
    "hep_search",
    "hep_network",
    "hep_status",
    "project_search",
    "graph_search",
    "graph_run",
  ];
  for (const name of mustHaveHyphenAlias) {
    const entry = TELEGRAM_COMMANDS.find((e) => e.name === name);
    assert.ok(entry, `missing command: ${name}`);
    const hyphen = name.replace(/_/g, "-");
    assert.ok(
      (entry.aliases ?? []).includes(hyphen),
      `${name} must accept the typed hyphen form ${hyphen}`,
    );
    assert.equal(findTelegramCommand(hyphen)?.name, name, `alias lookup broken for ${hyphen}`);
  }
});

// 3. 등록 목록 ↔ setMyCommands 로 실제 나가는 배열이 1:1.
check("registered entries match the setMyCommands payload 1:1", () => {
  for (const targetKind of ["agent", "firm", "one"]) {
    const expected = registrableTelegramCommands(targetKind).map((e) => e.name).sort();
    const payload = sync.registrationPayloadForTest({ id: "row", target_kind: targetKind });
    const ko = payload.ko.map((c) => c.command).sort();
    const en = payload.en.map((c) => c.command).sort();
    assert.deepEqual(ko, expected, `ko payload drifted for ${targetKind}`);
    assert.deepEqual(en, expected, `en payload drifted for ${targetKind}`);
    for (const command of payload.ko) {
      assert.match(command.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(command.description.length >= 3 && command.description.length <= 256);
    }
  }
});

// 4. 카탈로그 handler ↔ 디스패치 case 가 1:1. 고아 case 도, 고아 handler 도 없다.
check("every handler has exactly one dispatch case and vice versa", () => {
  const source = fs.readFileSync(
    path.join(root, "electron/telegram/command-dispatch.ts"),
    "utf8",
  );
  const cases = [...source.matchAll(/^\s*case "([A-Za-z]+)":/gm)].map((m) => m[1]);
  const handlers = TELEGRAM_COMMANDS.map((e) => e.handler);
  const uniqueHandlers = [...new Set(handlers)].sort();
  const uniqueCases = [...new Set(cases)].sort();
  assert.deepEqual(uniqueCases, uniqueHandlers, "dispatch cases and catalog handlers drifted");
  assert.equal(cases.length, uniqueCases.length, "a dispatch case is duplicated");
});

// 5. 두 언어 설명이 모두 있고 서로 다르다(같으면 번역을 빠뜨린 것이다).
check("ko/en descriptions exist, are bounded, and differ", () => {
  for (const entry of TELEGRAM_COMMANDS) {
    assert.ok(entry.ko.length >= 3 && entry.ko.length <= 256, `ko out of range: ${entry.name}`);
    assert.ok(entry.en.length >= 3 && entry.en.length <= 256, `en out of range: ${entry.name}`);
    assert.notEqual(entry.ko, entry.en, `ko and en are identical for ${entry.name}`);
    assert.ok(!/[가-힣]/.test(entry.args), `args must stay ASCII canonical: ${entry.name}`);
  }
});

// 6. /start 는 처리하되 메뉴에 노출하지 않는다(페어링 토큰은 사용자가 칠 것이 아니다).
check("start is handled but never advertised", () => {
  const start = TELEGRAM_COMMANDS.find((e) => e.name === "start");
  assert.ok(start, "start entry missing");
  assert.equal(start.registered, false, "start must not be registered");
  for (const targetKind of ["agent", "firm", "one"]) {
    const names = registrableTelegramCommands(targetKind).map((e) => e.name);
    assert.equal(names.includes("start"), false, `start leaked into ${targetKind} menu`);
  }
});

// 7. 정직성 — graph_run 은 실행이 아니라 접수다. 문구가 "실행했다"로 바뀌면 실패한다.
check("graph_run copy says requested, never ran", () => {
  const source = fs.readFileSync(path.join(root, "electron/telegram/connect.ts"), "utf8");
  const requested = [...source.matchAll(/"cmd\.graph_run\.requested":\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(requested.length, 2, "cmd.graph_run.requested must exist in both ko and en");
  const [ko, en] = requested;
  assert.match(ko, /요청/, "ko copy must say the run was requested");
  assert.ok(!/실행했|실행됨|실행 완료/.test(ko), `ko copy claims execution: ${ko}`);
  assert.match(en, /request/i, "en copy must say the run was requested");
  assert.ok(!/\bran\b|executed|completed/i.test(en), `en copy claims execution: ${en}`);
});

// 8. callback_data 64바이트 한도 — 넘으면 sendMessage 자체가 400이다.
check("callback_data stays within Telegram's 64-byte limit", () => {
  const worst = inlineSelect.buildCallbackData("n", "ffffffff", 4096);
  assert.ok(
    Buffer.byteLength(worst, "utf8") <= inlineSelect.CALLBACK_DATA_MAX_BYTES,
    `callback_data too long: ${worst}`,
  );
  assert.equal(inlineSelect.CALLBACK_DATA_MAX_BYTES, 64);
});

// 9. 카피 대칭성. ko 에만 있는 키는 타입이 못 잡고 영어 사용자에게 원시 키가 나간다.
check("TELEGRAM_COPY ko/en key sets are exactly equal", () => {
  const source = fs.readFileSync(path.join(root, "electron/telegram/connect.ts"), "utf8");
  const start = source.indexOf("const TELEGRAM_COPY = {");
  assert.ok(start > 0, "TELEGRAM_COPY not found");
  const koStart = source.indexOf("ko: {", start);
  const enStart = source.indexOf("en: {", koStart);
  const end = source.indexOf("\n} as const;", enStart);
  assert.ok(koStart > 0 && enStart > koStart && end > enStart, "TELEGRAM_COPY block not parseable");
  const keysIn = (text) => new Set([...text.matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]));
  const koKeys = keysIn(source.slice(koStart, enStart));
  const enKeys = keysIn(source.slice(enStart, end));
  const koOnly = [...koKeys].filter((k) => !enKeys.has(k));
  const enOnly = [...enKeys].filter((k) => !koKeys.has(k));
  assert.deepEqual(koOnly, [], `keys missing from en: ${koOnly.join(", ")}`);
  assert.deepEqual(enOnly, [], `keys missing from ko: ${enOnly.join(", ")}`);
  assert.ok(koKeys.size > 50, "TELEGRAM_COPY parse looks wrong (too few keys)");
});

// 10. 렌더러 사전도 같은 함정을 갖는다: DictKey = keyof dict.ko 라서
//     ko 에만 있는 키는 컴파일이 통과하고 영어 사용자에게 원시 키가 렌더된다.
check("renderer dict ko/en key sets are exactly equal", () => {
  const source = fs.readFileSync(path.join(root, "renderer/lib/i18n.tsx"), "utf8");
  const koStart = source.indexOf("  ko: {");
  const enStart = source.indexOf("\n  en: {", koStart);
  const end = source.indexOf("\n} as const;", enStart);
  assert.ok(koStart > 0 && enStart > koStart && end > enStart, "dict block not parseable");
  const keysIn = (text) => new Set([...text.matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]));
  const koKeys = keysIn(source.slice(koStart, enStart));
  const enKeys = keysIn(source.slice(enStart, end));
  const koOnly = [...koKeys].filter((k) => !enKeys.has(k));
  const enOnly = [...enKeys].filter((k) => !koKeys.has(k));
  assert.deepEqual(koOnly, [], `keys missing from en: ${koOnly.slice(0, 12).join(", ")}`);
  assert.deepEqual(enOnly, [], `keys missing from ko: ${enOnly.slice(0, 12).join(", ")}`);
});

// 11. allowed_updates 에 callback_query 가 있어야 인라인 선택이 도착한다.
check("polling asks for callback_query updates", () => {
  const source = fs.readFileSync(path.join(root, "electron/telegram/connect.ts"), "utf8");
  assert.match(
    source,
    /allowed_updates:\s*\["message",\s*"callback_query"\]/,
    "callback_query must be in allowed_updates or inline buttons never arrive",
  );
  assert.match(source, /answerCallbackQuery/, "answerCallbackQuery must be called");
});

// 12. 인라인 버튼 라벨은 사용자가 정한 이름이라 한도가 없다 — 잘라야 한다.
check("inline button labels are bounded", () => {
  const long = inlineSelect.openInlineSelect("gate-label", {
    kind: "project",
    command: "projects",
    options: [{ id: "x", label: "프".repeat(300) }],
    labels: { prev: "<", next: ">", close: "x" },
  });
  const text = long.markup.inline_keyboard[0][0].text;
  assert.ok(
    [...text].length <= inlineSelect.INLINE_BUTTON_LABEL_MAX,
    `inline button label is ${[...text].length} chars — a long project name must be truncated`,
  );
  inlineSelect.clearInlineSelect("gate-label");
});

// 13. 긴 답변 분할이 이모지 한 글자를 반토막 내면 텔레그램에 깨진 문자가 나간다.
check("long replies never split a surrogate pair", () => {
  const source = fs.readFileSync(path.join(root, "electron/telegram/connect.ts"), "utf8");
  const cutFn = /function chunkCutIndex[\s\S]*?\n}/.exec(source);
  const chunkFn = /function chunkText[\s\S]*?\n}/.exec(source);
  assert.ok(cutFn && chunkFn, "chunkText/chunkCutIndex not found");
  const strip = (code) => code.replace(/: string\[\]|: string|: number/g, "");
  // eslint-disable-next-line no-eval
  const chunkText = eval(`(() => { ${strip(cutFn[0])}\n${strip(chunkFn[0])}\n return chunkText; })()`);
  for (let prefix = 0; prefix <= 8; prefix += 1) {
    const text = "가".repeat(prefix) + "🤖".repeat(3000);
    const chunks = chunkText(text, 3800);
    for (const piece of chunks) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(piece), `chunk ends on a lone high surrogate (prefix=${prefix})`);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(piece), `chunk starts on a lone low surrogate (prefix=${prefix})`);
    }
    assert.equal(chunks.join(""), text, `chunking lost or duplicated text (prefix=${prefix})`);
  }
  // 경계가 전혀 없는 입력에서도 진행해야 한다(무한 루프 방지).
  assert.equal(chunkText("x".repeat(9000), 3800).length, 3);
});

// 14. 언어 신호가 없는 응답은 텔레그램 클라이언트 언어를 따라야 한다.
//     (실사용: /help 가 한국어 사용자에게 영어로, 인라인 버튼 응답도 영어로 나갔다.)
check("command and inline-button replies follow the Telegram client language", () => {
  const source = fs.readFileSync(path.join(root, "electron/telegram/connect.ts"), "utf8");
  const pick = (name) => {
    const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n}`).exec(source);
    assert.ok(m, `${name} not found`);
    return m[0]
      .replace(/: TelegramMessage|: TelegramCallbackQuery|: string \| undefined|: string|: "ko" \| "en" \| null|: "ko" \| "en"/g, "")
      .replace(/isPrimarilyKorean\(text\)/, "/[가-힣]/.test(text)")
      .replace(/detectReplyLocale\(text\)/, '(/[가-힣]/.test(text) ? "ko" : "en")')
      .replace(/currentUiLocale\(\)/, '"en"');
  };
  const bundle = `${pick("clientLocale")}\n${pick("telegramHostLocale")}\n${pick("commandReplyLocale")}\n${pick("callbackReplyLocale")}`;
  // eslint-disable-next-line no-eval
  const api = eval(`(() => { ${bundle}\n return { commandReplyLocale, callbackReplyLocale }; })()`);
  const from = (lang) => (lang ? { from: { language_code: lang } } : { from: {} });

  assert.equal(api.commandReplyLocale(from("ko"), "/help"), "ko", "a Korean client must get Korean");
  assert.equal(api.commandReplyLocale(from("ko-KR"), "/status"), "ko", "ko-KR must count as Korean");
  assert.equal(api.commandReplyLocale(from("en"), "/help"), "en", "an English client must get English");
  assert.equal(api.commandReplyLocale(from("en"), "/write 리포트"), "ko", "explicit Korean text still wins");
  assert.equal(api.commandReplyLocale(from(null), "/help"), "en", "no client language falls back to text detection");

  // 버튼에는 본문이 없다 — 앱 UI 로케일로 답하면 명령은 한국어인데 버튼만 영어가 된다.
  assert.equal(api.callbackReplyLocale(from("ko")), "ko", "a Korean client must get Korean button replies");
  assert.equal(api.callbackReplyLocale(from("en")), "en", "an English client must get English button replies");
  assert.equal(api.callbackReplyLocale(from(null)), "en", "unknown client language falls back to the app locale");

  // ★비율 판정은 이 도메인에서 틀린다 — 파일명·영어 용어가 라틴 글자 수를 넘긴다.
  //   실사용에서 "note3.txt 파일 만들고…" 가 영어 확인 문구를 받았다.
  for (const korean of [
    "note3.txt 파일 만들고 안에 third 라고 써줘",
    "hello.txt 만들어줘",
    "README.md 파일에 introduction 섹션 추가해줘",
  ]) {
    assert.equal(
      api.commandReplyLocale(from("en"), korean),
      "ko",
      `a Korean request with filenames must stay Korean: ${korean}`,
    );
  }
  assert.equal(api.commandReplyLocale(from("en"), "create hello.txt"), "en", "a pure English request stays English");
});

// 15. 카드를 못 그리는 채널(텔레그램)에 "아래에서 확인하세요"를 보내면 가리킬 곳이 없고
//     정작 결과(경로·내용)가 사라진다. 실사용에서 파일을 만들고도 안내만 갔다.
//
//     예전엔 이 계약을 `isCardlessTextSurface(executionContext)` 라는 **채널 분기**로 지켰다.
//     2026-08-15 오너 결정으로 "모델이 쓴 본문이 답"이 모든 채널의 규칙이 되면서 그 분기는
//     사라졌고, 이 게이트는 없어진 함수 이름을 찾다가 영구 실패하고 있었다(구현 문장을
//     못박은 게이트의 전형). 지금 재는 것은 이름이 아니라 **우선순위**다:
//     모델 본문이 먼저고, 완료 안내문은 본문이 비었을 때만 나온다.
check("the model's own result text wins over a UI-pointing completion blurb", () => {
  const source = fs.readFileSync(path.join(root, "electron/mcp/client.ts"), "utf8");
  const branch = /} else if \(usedDeterministicOneSurface && deterministicOneSurface\) \{[\s\S]*?\n        } else if/.exec(source);
  assert.ok(branch, "the One completion-copy branch was not found");
  assert.match(
    branch[0],
    /displayText\s*=\s*modelText\s*\n?\s*\|\|\s*deterministicOneCompletionCopy/,
    "model text must be the answer; the completion copy is only the empty-body fallback",
  );
  assert.match(
    branch[0],
    /const modelText = surfaceParse\.cleanedText\.trim\(\);/,
    "the model body must come from the parsed surface text",
  );
});

console.log(`\ntelegram command surface: ${checks} checks passed`);
