#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const input = fs.readFileSync(path.join(root, "renderer/components/ChatInput.tsx"), "utf8");
const stream = fs.readFileSync(path.join(root, "renderer/components/ChatStream.tsx"), "utf8");
const chatPage = fs.readFileSync(path.join(root, "renderer/app/(shell)/chat/page.tsx"), "utf8");
const i18n = fs.readFileSync(path.join(root, "renderer/lib/i18n.tsx"), "utf8");

assert.doesNotMatch(input, /\balert\s*\(/,
  "attachment validation must not use a blocking native alert");
assert.match(input, /data-chat-attachment-error="true"[\s\S]*role="alert"|role="alert"[\s\S]*data-chat-attachment-error="true"/,
  "attachment errors must be visible and announced without blocking the composer");

assert.match(input, /onDragEnter=/, "the composer must detect file drag entry");
assert.match(input, /onDragLeave=/, "the composer must clear nested drag state safely");
assert.match(input, /data-chat-drop-overlay="true"/, "file drag must render a visible drop overlay");
assert.match(input, /role="status"[\s\S]*aria-live="polite"/,
  "the drop overlay must be announced accessibly");

assert.match(stream, /className="agentlas-chat-copy-button"/, "agent replies must expose the copy control");
assert.match(stream, /data-copy-state=\{copyState\}/, "copy success and failure must have visible states");
assert.match(stream, /aria-label=\{label\}/, "copy feedback must update its accessible label");
assert.match(stream, /aria-live="polite"/, "copy feedback must be announced");
assert.match(stream, /\.agentlas-chat-copy-button:hover/, "copy control must have a hover affordance");

assert.doesNotMatch(input, /#fff(?:fff)?\b/i,
  "chat input sheets and controls must use theme tokens instead of hard-coded white");
for (const surface of ["Stormbreaker", "BottomQuestionSheet", "RecommendationSheet"]) {
  assert.match(input, new RegExp(`${surface}[\\s\\S]*background: "var\\(--paper\\)"`),
    `${surface} must use the themed paper surface`);
}

assert.equal((input.match(/data-chat-stop-button=/g) || []).length, 1,
  "the composer must expose exactly one stop control while running");
const streamInvocation = chatPage.match(/<ChatStream[\s\S]*?\n\s*\/>/)?.[0] ?? "";
assert.ok(streamInvocation, "chat page must render ChatStream");
assert.doesNotMatch(streamInvocation, /onStop=/,
  "run status rows must not duplicate the composer-owned stop control");
assert.match(input, /data-chat-steering-send=\{busy \? "true" : undefined\}/,
  "the round action must remain a steering send control while running");
assert.match(input, /data-chat-steering-send[\s\S]*onClick=\{submit\}/,
  "mouse users must be able to send steering messages");
assert.match(input, /chatinput\.placeholder_steering/,
  "the running composer must explain that additional instructions steer the task");

for (const key of [
  "chatinput.placeholder_steering",
  "chatinput.image_read_failed",
  "chatinput.only_images",
  "chatinput.drop_images",
  "chatinput.send_steering",
  "chatstream.copied",
  "chatstream.copy_failed",
]) {
  assert.equal((i18n.match(new RegExp(`"${key}"`, "g")) || []).length, 2,
    `${key} must exist in Korean and English`);
}

console.log("Chat feedback UX contracts ok");
