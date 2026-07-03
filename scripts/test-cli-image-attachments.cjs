#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { stageCliImageAttachments } = require("../dist/electron/runtime/image-attachments.js");

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cli-image-test-"));
  try {
    const result = await stageCliImageAttachments({
      userPrompt: "이 사진 확인해줘",
      images: [{ mediaType: "image/png", data: TINY_PNG.toString("base64"), name: "qa paste.png" }],
      cwd: tmp,
      locale: "ko",
      chatId: "chat-test",
    });

    assert.equal(result.images.length, 1);
    assert.ok(result.directory.startsWith(path.join(tmp, ".agentlas", "chat-attachments")));
    assert.ok(result.images[0].path.startsWith(result.directory));
    assert.ok(fs.existsSync(result.images[0].path));
    assert.deepEqual(fs.readFileSync(result.images[0].path), TINY_PNG);
    assert.match(result.userPrompt, /이 사진 확인해줘/);
    assert.match(result.userPrompt, /\[첨부 이미지\]/);
    assert.match(result.userPrompt, /qa paste\.png/);
    assert.match(result.userPrompt, /다운로드 폴더/);
    assert.ok(result.userPrompt.includes(result.images[0].path));

    const englishResult = await stageCliImageAttachments({
      userPrompt: "Please inspect this image",
      images: [{ mediaType: "image/png", data: TINY_PNG.toString("base64"), name: "qa-en.png" }],
      cwd: tmp,
      locale: "ko",
      chatId: "chat-test",
    });
    assert.match(englishResult.userPrompt, /\[Attached images\]/);
    assert.match(englishResult.userPrompt, /Do not guess by searching Downloads/);
    assert.doesNotMatch(englishResult.userPrompt, /\[첨부 이미지\]/);

    const empty = await stageCliImageAttachments({ userPrompt: "hello", locale: "en" });
    assert.equal(empty.userPrompt, "hello");
    assert.deepEqual(empty.images, []);

    console.log("cli image attachment staging passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
