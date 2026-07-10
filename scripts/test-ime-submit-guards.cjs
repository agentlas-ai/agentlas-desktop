#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const rel of [
  "renderer/components/ChatQuestionSheet.tsx",
  "renderer/components/ChatRow.tsx",
  "renderer/components/AgentPicker.tsx",
  "renderer/app/(shell)/chat/page.tsx",
]) {
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(
    source,
    /nativeEvent\.isComposing \|\| e\.keyCode === 229/,
    `${rel} must ignore Enter while a CJK IME composition is active`,
  );
}
console.log("IME submit/rename/select guards ok");
