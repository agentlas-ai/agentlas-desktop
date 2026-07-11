#!/usr/bin/env node
// T-rex 화면의 팔레트 칩은 표시 언어와 같은 이름을 써야 한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer/app/(shell)/trex/page.tsx"), "utf8");
assert.match(
  source,
  /\{p\[ko \? "nameKo" : "nameEn"\]\}/,
  "palette chip labels must follow the active locale",
);
assert.match(
  source,
  /title=\{p\[ko \? "nameKo" : "nameEn"\]\}/,
  "palette tooltip must not leak the opposite locale",
);
assert.match(source, /\$\{ko \? "자" : " chars"\}/, "source character-count tooltip must follow the active locale");
assert.match(source, /ko \? "Antigravity 나노바나나" : "Antigravity nano-banana"/, "Gemini image option must not leak Korean into English mode");

console.log("T-rex palette locale contract ok");
