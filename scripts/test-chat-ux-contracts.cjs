#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const stream = fs.readFileSync(path.join(root, "renderer/components/ChatStream.tsx"), "utf8");
const input = fs.readFileSync(path.join(root, "renderer/components/ChatInput.tsx"), "utf8");
const i18n = fs.readFileSync(path.join(root, "renderer/lib/i18n.tsx"), "utf8");

assert.match(stream, /<EmptyChatState agentName=\{agentName\} directory=\{emptyDirectory\}/,
  "empty chats must render the installed directory starter state");
for (const collection of ["apps", "commands", "agents", "firms", "projects", "envKeys", "plugins"]) {
  assert.match(stream, new RegExp(`directory\\.${collection}`),
    `empty chat state must consume emptyDirectory.${collection}`);
}

assert.match(input, /addEventListener\("pointerdown", onPointerDown\)/,
  "autocomplete must close on mouse and touch outside interaction");
assert.match(input, /closest\('\[data-popover-kind="autocomplete"\]'\)/,
  "autocomplete option clicks must remain inside the outside-click boundary");
assert.match(input, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/,
  "keyboard-active autocomplete options must remain visible");

assert.match(stream, /setHasNewContent\(true\)/,
  "stream updates while scrolled up must mark new content");
assert.match(stream, /className="agentlas-chat-latest-button"/,
  "scrolled-up chats must expose a latest-message button");
for (const takeoverEvent of ["onWheel", "onTouchStart", "onPointerDown"]) {
  assert.match(stream, new RegExp(`${takeoverEvent}=\\{cancelProgrammaticScroll\\}`),
    `${takeoverEvent} must cancel an interrupted smooth scroll before stickiness is recomputed`);
}
assert.match(stream, /aria-live="polite"/,
  "new response state must be announced accessibly");

assert.match(stream, /animation: agentlas-chat-cursor-blink/,
  "streaming cursor must visibly blink");
assert.match(stream, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/,
  "streaming cursor animation must stop for reduced motion");
for (const key of ["chatstream.scroll_to_bottom", "chatstream.new_messages"]) {
  assert.equal((i18n.match(new RegExp(`"${key}"`, "g")) || []).length, 2,
    `${key} must exist in Korean and English`);
}

console.log("Chat UX contracts ok");
