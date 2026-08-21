#!/usr/bin/env node
"use strict";
/*
 * copy-builtin-plugins — 저장소 plugins/ 를 dist/plugins/ 로 복사한다.
 *
 * tsc 는 import 된 plugin.json 만 emit 한다. 플러그인 패키지의 본체는 SKILL.md 와
 * references/ 이므로, 그것들이 함께 가지 않으면 매니페스트만 있고 절차가 없는
 * 패키지가 배포된다 — 정확히 이 저장소가 겪었던 "이름만 있고 내용 없는 행" 이다.
 */
const fs = require("node:fs");
const path = require("node:path");
const from = path.resolve(__dirname, "..", "plugins");
const to = path.resolve(__dirname, "..", "dist", "plugins");

function copyTree(src, dest) {
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // 호스트 소유 항목은 배포본에 없다
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else if (e.isFile()) { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

if (!fs.existsSync(from)) {
  console.error(`[copy-builtin-plugins] no plugins/ at ${from}`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
const count = copyTree(from, to);
const slugs = fs.readdirSync(to, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
console.log(`[copy-builtin-plugins] ${slugs.length} package(s), ${count} file(s): ${slugs.join(", ")}`);
