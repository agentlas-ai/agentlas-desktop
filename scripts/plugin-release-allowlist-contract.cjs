#!/usr/bin/env node
"use strict";

/*
 * 새 번들 플러그인은 릴리스 허용목록에 등록되어야 한다.
 *
 * 2026-09-14: `plugins/agentlas-science-skills/` 를 커밋했는데 `copy-builtin-plugins.cjs` 의
 * `RELEASE_TOP_LEVEL` 에 넣지 않았다. 로컬 타입검사·계약·커밋 관문은 전부 초록이었다 —
 * 그 표를 읽는 것은 릴리스 빌드뿐이기 때문이다. 그래서 1.2.10 빌드가 세 러너(mac preflight,
 * windows, linux)에서 동시에 죽었다:
 *
 *   Error: [copy-builtin-plugins] release allowlist missing for agentlas-science-skills
 *
 * 한 시간 반짜리 서명 빌드를 기동한 뒤 8분 52초 만에 알게 되는 것은 너무 늦다. 이 계약은
 * 그 표와 디스크를 대조해 **커밋 전에** 같은 답을 낸다.
 *
 * 문장 대조가 아니다 — 실제 모듈을 읽어 표를 꺼내고 실제 폴더 목록과 맞춘다.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/** 표는 모듈 안에 있고 export 되지 않는다. 소스에서 그 객체 리터럴만 꺼내 평가한다. */
function releaseTopLevel() {
  const source = fs.readFileSync(path.join(ROOT, "scripts/copy-builtin-plugins.cjs"), "utf8");
  const start = source.indexOf("const RELEASE_TOP_LEVEL = Object.freeze({");
  if (start < 0) throw new Error("copy-builtin-plugins.cjs 에서 RELEASE_TOP_LEVEL 을 못 찾았다 — 이름이 바뀌었으면 이 계약도 같이 고쳐라");
  const open = source.indexOf("{", source.indexOf("Object.freeze(", start));
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") { depth -= 1; if (depth === 0) break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${source.slice(open, end + 1)};`)();
}

const table = releaseTopLevel();
const onDisk = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();

check(onDisk.length > 0, "plugins/ 가 비어 있다 — 이 계약이 아무것도 안 보고 있다");

for (const name of onDisk) {
  const allowed = table[name];
  check(
    Array.isArray(allowed) && allowed.length > 0,
    `plugins/${name} 이 RELEASE_TOP_LEVEL 에 없다 — 릴리스 빌드가 "release allowlist missing for ${name}" 로 죽는다`,
  );
  if (!Array.isArray(allowed)) continue;

  // 허용목록이 실재하지 않는 항목을 가리키면, 그 조각은 조용히 안 실린다.
  for (const top of allowed) {
    check(fs.existsSync(path.join(PLUGINS_DIR, name, top)), `plugins/${name} 허용목록의 "${top}" 이 디스크에 없다`);
  }

  // 런타임이 실제로 읽는 것이 빠지면 설치본에서만 깨진다. plugin.json 은 언제나 필요하다.
  check(allowed.includes("plugin.json"), `plugins/${name} 허용목록에 plugin.json 이 없다 — 플러그인이 로드되지 않는다`);
}

// 디스크에 없는 플러그인이 표에 남아 있으면, 지운 뒤에도 표가 그것을 가르친다.
for (const name of Object.keys(table)) {
  check(onDisk.includes(name), `RELEASE_TOP_LEVEL 의 "${name}" 이 plugins/ 에 없다 — 지워진 플러그인이면 표에서도 빼라`);
}

if (failures.length) {
  console.error(`plugin-release-allowlist-contract FAIL (${failures.length})`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, plugins: onDisk.length }));
