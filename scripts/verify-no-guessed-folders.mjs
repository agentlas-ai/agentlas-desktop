#!/usr/bin/env node
// 추측한 경로로 폴더를 만들지 않는다.
//
// 실측 2026-08-20 (E2E 캠페인 E1 — 데스크탑 × agy, "다운로드 폴더 정리" 자동화).
// 자동화가 파일 8개를 전부 정확히 분류·개명했는데, 그와 함께 사용자 폴더에
// **없던 폴더 `IMG_9931/` 이 생기고 그 안에 `.agentlas` 프로젝트 뼈대 516KB**
// (.env.example · .gitignore · credentials/ · signing/)가 깔렸다.
//
// 경로: 노드 프롬프트 → inferWorkingFolderFromPrompt 가 경로를 추측 →
//       `mkdirSync(candidate, {recursive:true})` 로 **만들고** → 작업 폴더로 잡혀
//       프로젝트 부트스트랩과 온톨로지 인제스트가 그 안에서 돌았다(그 인제스트도
//       `Cannot read properties of undefined (reading 'replace')` 로 죽었다).
//
// ★가장 뾰족한 사실: **사용자가 쓴 원문은 이 정규식에 안 걸렸다.** 걸린 것은 제품이
//   스스로 조립한 노드 프롬프트다("target folder …/IMG_9931"). 즉 사용자가 말한 적
//   없는 폴더가 사용자 폴더에 생긴다. 파일을 다루는 자동화라면 어느 것이든 그렇다.
//
// 그래서 두 계약을 지킨다:
//   ① 추측한 경로는 **만들지 않는다** — 이미 있는 디렉터리만 잡는다.
//   ② 기계가 조립한 프롬프트에서는 **추측하지 않는다**.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require_ = createRequire(import.meta.url);

const checks = [];
const failures = [];
const check = (name, ok, detail) => {
  checks.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures.push(`${name}: ${detail}`);
};

const source = readFileSync(path.join(root, "electron/mcp/client.ts"), "utf8");
const fnStart = source.indexOf("export function inferWorkingFolderFromPrompt");
const fnBody = fnStart < 0 ? "" : source.slice(fnStart, source.indexOf("\n}", fnStart));

check(
  "the-folder-guesser-still-exists",
  fnStart >= 0,
  "inferWorkingFolderFromPrompt 를 못 찾았습니다 — 이 게이트가 아무것도 못 지킵니다(이름이 바뀌었으면 여기도 고치세요).",
);

check(
  "a-guessed-path-is-never-created",
  !/mkdirSync/.test(fnBody),
  "추측한 경로를 만들고 있습니다 — 추측이 틀리면 사용자 폴더에 없던 폴더와 "
  + "프로젝트 뼈대가 남습니다(실측: IMG_9931/ 516KB).",
);

check(
  "the-guess-is-skipped-for-machine-written-prompts",
  /authored/.test(fnBody)
    && /inferWorkingFolderFromPrompt\(\s*req\.userPrompt\s*,[\s\S]{0,240}?isUnattendedExecution/.test(source),
  "자동화 실행에서도 프롬프트로 폴더를 추측합니다 — 노드 프롬프트의 경로는 작업 폴더 "
  + "선언이 아니라 처리 대상입니다. 사용자가 말한 적 없는 폴더가 생깁니다.",
);

/*
 * ★그리고 **실제로 돌려서** 잰다. 소스 문자열 단언만으로는 규칙이 옳은지 모른다 —
 *   이 저장소는 오늘 게이트가 구현 문장을 못박아 옳은 수리를 막은 사고를 세 번 겪었다.
 */
let infer;
try {
  ({ inferWorkingFolderFromPrompt: infer } = require_(path.join(root, "dist/electron/mcp/client.js")));
} catch (error) {
  console.log("SKIP 동작 시험 — dist 를 읽지 못했습니다:", String(error && error.message).split("\n")[0].slice(0, 120));
  console.log("  고치는 법: npm run build:electron  (통과로 세지 않습니다.)");
  process.exit(failures.length > 0 ? 1 : 0);
}

if (typeof infer === "function") {
  const missing = "/tmp/agentlas-gate-does-not-exist-" + process.pid;
  check(
    "a-path-that-does-not-exist-is-not-adopted",
    infer(`working folder ${missing}`) === null,
    `없는 경로를 작업 폴더로 잡았습니다(${missing}) — 그러면 그 폴더가 만들어집니다.`,
  );
  check(
    "a-machine-written-prompt-yields-nothing",
    infer(`group key IMG_9931 · target folder ${root}`, { authored: "machine" }) === null,
    "기계가 쓴 프롬프트에서 폴더를 잡았습니다 — 자동화가 다루는 파일 경로가 "
    + "작업 폴더로 오인됩니다.",
  );
  check(
    "a-human-prompt-with-a-real-folder-still-works",
    infer(`working folder ${root}`) === root,
    "사람이 실재하는 폴더를 지정했는데 못 잡습니다 — 좁히다 기능을 죽였습니다.",
  );
}

if (failures.length > 0) {
  console.error("\nno-guessed-folders 실패:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
