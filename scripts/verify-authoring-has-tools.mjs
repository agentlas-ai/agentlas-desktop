#!/usr/bin/env node
// **짓는 일에는 도구를, 판정에는 잠금을.** 이 둘이 섞이면 각각 다른 사고가 난다.
//
// 배경(2026-08-20 실측). 그래프 빌더가 판정기용 통로를 그대로 쓰고 있었다. 그 통로는
// "순수 분류"를 위해 `untrustedNoTools: true` 로 **도구를 0개로 못 박은** 설정이다.
// 그래서 빌더는:
//   · 브라우저를 못 썼다 (제품에 있는데)
//   · 이미 동의된 MCP 를 못 봤다 (제품에 있는데)
//   · 자기가 쓴 스크립트가 도는지 확인할 수 없었다
// 그 결과 자료원에서 403 을 받는 스크립트를 그대로 저장했고, 사람은 며칠 뒤 예약 실행에서
// 그것을 알게 됐다.
//
// 반대 방향도 위험하다: **판정이 도구를 얻으면 자기가 판정할 대상을 스스로 만들어 낼 수
// 있다.** 그래서 잠금을 통째로 걷어내는 것이 아니라, 짓는 호출만 여는 깃발을 뒀다.
//
// 이 게이트가 지키는 것:
//  1) 저작 통로가 존재한다(authoring 깃발).
//  2) 잠금이 그 깃발에 매여 있다 — 무조건 true 로 되돌아가지 않았다.
//  3) 그래프를 짓는 호출부가 실제로 그 깃발을 켠다(존재만으로는 아무도 구제되지 않는다).
//  4) 판정 호출부는 그 깃발을 켜지 않는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

const judgmentRaw = fs.readFileSync(path.join(root, "electron/system-agents/judgment.ts"), "utf8");
const ipc = fs.readFileSync(path.join(root, "electron/ipc.ts"), "utf8");

/*
 * ★주석을 코드로 세지 않는다. 실측 2026-08-20: 이 게이트의 첫 판이 "왜 이렇게 고쳤는지"를
 *   적어 둔 **주석 문장**(`untrustedNoTools: true` 를 인용한 설명)을 코드로 읽고 FAIL 했다.
 *   배경 설명을 성실히 쓸수록 게이트가 틀리는 구조는 그 자체가 결함이다.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}
const judgment = withoutComments(judgmentRaw);

check(
  "an-authoring-path-exists",
  /authoring\?: boolean/.test(judgment),
  "저작 통로가 없습니다 — 빌더가 판정기용 무도구 설정으로 그래프를 짓게 됩니다.",
);

check(
  "the-tool-lock-follows-the-flag",
  /untrustedNoTools: !opts\.authoring/.test(judgment)
  && !/untrustedNoTools: true/.test(judgment),
  "도구 잠금이 다시 무조건 켜졌습니다 — 빌더는 눈 감고 그래프를 씁니다.",
);

check(
  "graph-authoring-turns-it-on",
  (ipc.match(/authoring: true/g) || []).length >= 2,
  "그래프를 짓는 호출부가 저작 깃발을 켜지 않습니다 — 통로가 있어도 아무도 안 지나갑니다."
  + " (아키텍트 패치와 인터뷰 청사진 둘 다여야 합니다.)",
);

/*
 * ★판정이 도구를 얻으면 안 된다. 판정 호출부(judge/prejudge 계열)는 이 깃발을 켜지 않는다 —
 *   judgment.ts 안에서 authoring 을 참으로 넘기는 곳이 있으면 그 경계가 무너진 것이다.
 */
check(
  "judging-never-gets-tools",
  !/authoring: true/.test(judgment),
  "판정 모듈 안에서 저작 깃발을 켭니다 — 판정이 자기가 판정할 대상을 만들어 낼 수 있습니다.",
);

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\nauthoring-tools 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
