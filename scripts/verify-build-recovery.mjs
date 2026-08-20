#!/usr/bin/env node
// 짓다 막혔을 때 **이어갈 길이 실재하는가**.
//
// 오너 지시 2026-08-20:
//   *"50% 정도 완성하다 실패를 했을 때도 이어갈 수 있어야지, 대안을 제시한다거나.
//     이게 LLM 아닌가."*
//   그리고: 안 되는 이유가 내 코드 문제인지, 로그인·권한처럼 사람만 가진 게 필요한
//   문제인지를 **LLM이 추론해서 칩으로 요청**해야 한다. 사람마다 다른 칩이어야 하므로
//   하드코딩된 조건문으로 갈라서는 안 된다.
//
// 이 게이트가 지키는 계약은 셋이다:
//   ① 막혔을 때 **사실**이 남는다 — 무슨 값을 읽으려 했고 그때 무엇이 있었는가.
//      이게 없으면 다음 층이 원인을 추측하게 된다(실측 E5: 에이전트가 표로 답했고
//      다음 코드가 구조화된 값을 기대해 빈손을 냈다 — 그 사실이 어디에도 안 남았다).
//   ② **가능한 행동은 유한하고 실재한다** — 모델이 지어낸 id 는 옵션이 되지 못한다.
//      없는 능력을 목록에 넣으면 사용자는 눌러도 아무 일이 없는 버튼을 만난다.
//   ③ **만든 것을 버리지 않는다** — 어떤 경우에도 "지금 상태로 저장(꺼둠)"이 있다.
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

/* ── ① 막히면 사실이 남는가 — 실제로 돌려서 잰다 ──────────────────────────── */
let verify;
try {
  verify = require_(path.join(root, "dist/electron/workflow/verify-before-save.js"));
} catch (error) {
  console.log("SKIP build-recovery — dist 를 읽지 못했습니다:", String(error && error.message).split("\n")[0].slice(0, 120));
  console.log("  고치는 법: npm run build:electron  (통과로 세지 않습니다.)");
  process.exit(0);
}

const graph = {
  version: 1,
  nodes: [
    { id: "start", type: "trigger", position: { x: 0, y: 0 }, config: { kind: "input", produces: "seed" } },
    {
      id: "make", type: "code", position: { x: 0, y: 0 }, label: "값을 만든다",
      config: { effect: "read", produces: "report", codeLang: "python", code: "result = '# 표\\n| a | b |'" },
    },
    {
      id: "use", type: "code", position: { x: 0, y: 0 }, label: "그 값을 쓴다",
      config: {
        effect: "read", consumes: "report", produces: "rows", codeLang: "python",
        code: "rows = vars.get('report')['items']\nresult = rows",
      },
    },
  ],
  edges: [
    { id: "e1", source: "start", target: "make" },
    { id: "e2", source: "make", target: "use" },
  ],
};

const v = await verify.verifyGraphBeforeSave(graph, {
  runCode: async ({ code, vars }) => {
    // 앞 단계는 문자열을 내고, 뒤 단계는 그것을 dict 처럼 읽으려다 막힌다 — E5 와 같은 모양.
    if (code.includes("'# 표")) return { ok: true, result: "# 표\n| a | b |" };
    return { ok: false, reason: "Traceback (most recent call last):\n  File \"<step>\", line 1\nTypeError: string indices must be integers" };
  },
});

const blocked = v.steps.find((s) => s.state === "blocked");
check(
  "a-blocked-step-is-reported",
  !v.ok && blocked?.nodeId === "use",
  `막힌 단계를 못 세웠습니다(ok=${v.ok}, 단계=${JSON.stringify(v.steps.map((s) => [s.nodeId, s.state]))}).`,
);
check(
  "a-blocked-step-carries-what-was-available",
  Array.isArray(blocked?.facts?.availableVars) && blocked.facts.availableVars.includes("report"),
  "막힌 시점에 무슨 값이 있었는지가 안 남습니다 — 다음 층이 원인을 추측하게 됩니다"
  + `(facts=${JSON.stringify(blocked?.facts ?? null)}).`,
);
check(
  "a-blocked-step-carries-what-the-previous-step-produced",
  typeof blocked?.facts?.upstreamSample === "string" && blocked.facts.upstreamSample.includes("표"),
  "바로 앞 단계가 낸 값의 생김새가 안 남습니다 — 형식 불일치가 가장 흔한 원인인데 "
  + `그 사실을 아무도 모릅니다(sample=${JSON.stringify(blocked?.facts?.upstreamSample ?? null)}).`,
);

/* ── 사실 뽑기 — 무슨 값을 읽으려 했는가 ─────────────────────────────────── */
let recovery;
try {
  recovery = require_(path.join(root, "dist/electron/workflow/build-recovery.js"));
} catch (error) {
  console.error("build-recovery: 모듈을 읽지 못했습니다 —", String(error && error.message).slice(0, 160));
  process.exit(1);
}

const facts = recovery.blockedStepFactsFrom({
  graph,
  nodeId: "use",
  label: "그 값을 쓴다",
  cause: blocked?.cause ?? "",
  availableVars: blocked?.facts?.availableVars ?? [],
  upstreamSample: blocked?.facts?.upstreamSample ?? null,
});
check(
  "the-facts-say-which-value-the-step-wanted",
  facts.wantedVars.includes("report"),
  `그 단계가 무슨 값을 읽으려 했는지가 안 나옵니다(wanted=${JSON.stringify(facts.wantedVars)}).`,
);

/* ── ②③ 가능한 행동은 유한하고 실재한다 ─────────────────────────────────── */
const source = readFileSync(path.join(root, "electron/workflow/build-recovery.ts"), "utf8");
check(
  "an-invented-action-id-cannot-become-an-option",
  /caps\.find\(\(c\) => c\.option\.id === choice\.actionId\)/.test(source)
    && /if \(!cap\) return \[\];/.test(source),
  "모델이 지어낸 조치 id 가 그대로 옵션이 됩니다 — 사용자는 눌러도 아무 일이 없는 버튼을 만납니다.",
);
check(
  "keeping-the-work-is-always-offered",
  /kind: "save_switched_off"/.test(source)
    && source.indexOf('kind: "save_switched_off"') > source.indexOf("언제나 있는 두 가지"),
  "어떤 경우에도 '지금 상태로 저장(꺼둠)'이 있어야 합니다 — 50% 만든 것이 날아가면 "
  + "사용자는 처음부터 다시 해야 합니다.",
);
check(
  "the-model-is-told-that-an-unsaved-draft-has-no-history",
  /has not been saved yet[\s\S]{0,120}not a failure/.test(source),
  "저장 전 초안에는 실행 기록이 없는 것이 정상인데 그 사실을 관찰에 안 넣으면, 모델이 "
  + "'기록이 없다'를 결함으로 취급하거나 없는 기록을 지어냅니다(실측: 수리 카드가 실행 "
  + "기록 옆에서 '기록이 없다'고 말한 사고).",
);
check(
  "the-cause-is-not-classified-by-a-keyword-table",
  !/switch\s*\(\s*cause|includes\("Traceback"\)|test\(cause\)/.test(source),
  "오류를 단어장·정규식으로 분류하고 있습니다 — 오류의 모양은 무한하고 그 방식은 "
  + "새 모양마다 구멍이 나며 다국어에서 전멸합니다(오너 결정 2026-08-12).",
);

/* ── 데스크탑이 실제로 이 문을 갖고 있는가 ───────────────────────────────── */
const ipc = readFileSync(path.join(root, "electron/ipc.ts"), "utf8");
check(
  "the-desktop-checks-before-saving",
  /automations:checkBlueprintBeforeSave/.test(ipc)
    && /verifyGraphBeforeSaveWithKernel/.test(ipc)
    && /planGraphBuildRecovery/.test(ipc),
  "데스크탑 저장 경로에 저장 전 확인과 복구 계획이 없습니다 — 사람이 가장 많이 쓰는 "
  + "표면에서 그 안전장치가 통째로 빠집니다(실측: 터미널에만 붙어 있었다).",
);

if (failures.length > 0) {
  console.error("\nbuild-recovery 실패:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
