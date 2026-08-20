#!/usr/bin/env node
// 커널 매트릭스 — **모델 없이** 그래프를 직접 조립해 돌린다.
//
// 왜 이 모양인가 (오너 지적 2026-08-20):
//   "사례는 무한하지만 그건 노드와 툴의 **조합**이 무한한 것이지, 노드·툴·모듈은 유한하다."
//
// 맞다. 그래서 이야기(사례)를 늘리지 않는다. 제품의 알파벳을 센다:
//   · 노드 종류 10 (trigger/agent/tool/action/condition/eval/transform/output/subgraph/code)
//   · 효과 3 (read/pure/mutation)
//   · 연결 — 앞으로 / 되돌이(상한 유무) / 갈림길(양쪽·한쪽) / 자기루프
//   · 값 전달 — consumes / {{이름}} / vars.get() / produces→consumes 사슬
//   · **상태** — 새 실행 / 실패 후 재개 / 입력 바꿔 재실행 / 그래프 고친 뒤
//
// 오늘(2026-08-20) 나온 결함은 거의 전부 **상태 축**과 **연결 축**에 있었고, 둘 다
// 모델 없이 재현된다. 그래서 이 파일은 빠르다 — 매 빌드에 돌려도 된다.
// 말로 시켜서 짓는 경로(빌더)는 모델이 필요하므로 여기 넣지 않는다.
//
// ★"모델이 없어도 재현되는 결함"과 "모델이 있어야 나오는 결함"을 섞지 않는다.
//   섞으면 느려서 아무도 안 돌리고, 안 돌리면 없는 것과 같다.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
/*
 * ★`require("better-sqlite3")`는 ABI 가 어긋나도 **성공한다** — 실제 .node 적재는
 *   첫 Database 를 만들 때 bindings() 안에서 일어난다. 그래서 require 만 보는 가드는
 *   아무것도 못 막고, 스크립트는 한참 뒤 raw 스택으로 죽는다(실측 2026-08-20).
 *   재려면 진짜로 하나 열어 봐야 한다.
 *
 *   이 매트릭스는 커널 게이트들과 같은 방식으로 electron 의 Node 에서 돈다
 *   (package.json: ELECTRON_RUN_AS_NODE=1 electron). 저장소의 better-sqlite3 는
 *   postinstall 의 electron-rebuild 로 그 ABI 에 맞춰져 있다.
 */
try { new (require_("better-sqlite3"))(":memory:").close(); } catch (error) {
  console.log("SKIP graph-matrix — better-sqlite3 가 이 런타임의 ABI 로 빌드돼 있지 않습니다:");
  console.log("  " + String(error && error.message).split("\n")[0].slice(0, 160));
  console.log("  고치는 법: npx electron-rebuild --force --only better-sqlite3");
  console.log("  (통과로 세지 않습니다.)");
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "graph-matrix-"));
process.env.AGENTLAS_STORE_PATH = path.join(dir, "store.sqlite");

/*
 * Electron 밖에서 커널을 돌리는 호스트는 사용자 폴더를 **직접 알려 줘야** 한다
 * (runtime-paths 의 계약: setUserDataDir 를 안 부르면 저장소를 건드리는 순간 던진다).
 * 스크래치 폴더를 주면 이 매트릭스는 사용자 데이터를 한 바이트도 안 건드린다.
 */
const { setUserDataDir } = await import("../dist/electron/runtime-paths.js");
setUserDataDir(dir);

const { initStore, getDb } = await import("../dist/electron/store/db.js");
initStore();
const store = await import("../dist/electron/store/automations.js");
const { runGraph: runGraphRaw } = await import("../dist/electron/workflow/run-graph.js");

// 커널의 거절은 두 모양으로 온다: 반환된 {ok:false}, 그리고 throw. 제품의 실행 경로도
// 둘 다 실패로 기록한다. 시험이 한 모양만 보면 다른 모양은 시험 자체를 죽여서
// "고장을 못 잡은" 게 아니라 "시험이 안 끝난" 상태가 된다 — 두 모양을 같은 결과로 받는다.
const runGraph = async (...args) => {
  try {
    return await runGraphRaw(...args);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), threw: true };
  }
};

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

const node = (id, type, config, label) => ({ id, type, position: { x: 0, y: 0 }, config, label: label || id });
const edge = (source, target, extra = {}) => ({ id: `${source}->${target}`, source, target, ...extra });

/*
 * 실행은 세션을 만들고, 세션은 실재하는 에이전트를 요구한다(chats.createChat).
 * 픽스처가 그 사실을 건너뛰면 매트릭스가 커널이 아니라 준비 부족으로 죽는다.
 */
const AGENT_ID = 'matrix-agent';
getDb().prepare(
  `INSERT INTO installed_agents (id, slug, name, tagline, system_prompt, mcp_servers_json,
       trust_grade, installed_at, tone, env_requirements_json, name_en, tagline_en, builtin, visibility)
     VALUES (?, 'matrix-agent', '매트릭스용', '커널 매트릭스 픽스처', '', '[]',
       'local', ?, 'plain', '[]', 'Matrix', 'kernel matrix fixture', 0, 'private')`,
).run(AGENT_ID, new Date().toISOString());

let seq = 0;
function saveAutomation(graph, name) {
  seq += 1;
  const id = `matrix-${seq}`;
  getDb().prepare(
    `INSERT INTO automations (id, name, schedule, target_type, target_id, prompt_template, enabled,
       created_by, created_at, graph_json, execution_permission)
     VALUES (?, ?, 'manual', 'agent', ?, ?, 0, 'matrix', ?, ?, 'write')`,
  ).run(id, name ?? id, AGENT_ID, name ?? id, new Date().toISOString(), JSON.stringify(graph));
  return store.getAutomation(id);
}

/**
 * 값이 실제로 흐르는지 보는 최소 그래프.
 *   입력 → 코드(그 값을 vars.get 으로 읽어 파일에 씀) → 코드(다시 읽어 확인)
 * 오늘 결함 중 "consumes 는 선언인데 값이 안 감", "재개가 새 입력을 버림",
 * "되돌린 단계의 하류가 옛 값을 씀" 이 전부 이 뼈대 위에서 재현된다.
 */
function valueFlowGraph(outPath) {
  return {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "message", promptLabel: "무슨 말을 적을까요?" }),
      node("write", "code", {
        effect: "mutation",
        consumes: "message",
        produces: "written",
        codeLang: "python",
        code: [
          "import json, pathlib",
          "msg = str(vars.get('message', ''))",
          `p = pathlib.Path(${JSON.stringify(outPath)})`,
          "p.write_text(msg, encoding='utf8')",
          "result = {'path': str(p), 'wrote': msg}",
        ].join("\n"),
      }, "파일에 적는다"),
      node("read", "code", {
        effect: "read",
        consumes: "written",
        produces: "readback",
        codeLang: "python",
        code: [
          "import pathlib",
          `result = pathlib.Path(${JSON.stringify(outPath)}).read_text(encoding='utf8')`,
        ].join("\n"),
      }, "다시 읽는다"),
    ],
    edges: [edge("start", "write"), edge("write", "read")],
  };
}

const outPath = path.join(dir, "written.txt");

// ── ① 값 전달: vars.get 으로 읽는 코드에 consumes 값이 실제로 간다 ─────────────
{
  const automation = saveAutomation(valueFlowGraph(outPath), "value-flow");
  const first = await runGraph(automation, automation.graph, { initialVars: { message: "첫 번째" } });
  check(
    "a-declared-input-reaches-the-script",
    first.ok && existsSync(outPath) && readFileSync(outPath, "utf8") === "첫 번째",
    `consumes 로 선언한 값이 스크립트에 도달하지 않았습니다(파일: ${existsSync(outPath) ? readFileSync(outPath, "utf8") : "없음"}).`,
  );

  // ── ② 상태 축: **입력을 바꿔 다시 돌리면 새 값이 이긴다** ────────────────────
  //     실측 2026-08-20: 여기서 옛 값이 이겨, 사람이 값을 고쳐도 결과가 안 바뀌었다.
  /*
   * ★두 번째 실행이 **정말 재개 경로를 밟는지** 먼저 확정한다.
   *   재개 후보는 "가장 최근 실행이 error" 일 때만 생긴다. 첫 실행이 성공하면 두 번째는
   *   새 실행이고, 그러면 이 시험은 재개 결함을 **하나도 못 잡는다**.
   *   실측 2026-08-20: 첫 판이 정확히 그랬다 — 수리를 되돌려도 통과하는 공짜 초록이었다.
   *   그래서 첫 실행을 일부러 실패로 만들어 재개 후보를 세운 뒤에 잰다.
   */
  getDb().prepare("UPDATE automation_runs SET status = 'error' WHERE automation_id = ?").run(automation.id);
  const resumeCandidate = store.getLatestFailedGraphCheckpoint(automation.id);
  check(
    "the-resume-path-is-actually-exercised",
    Boolean(resumeCandidate),
    "재개 후보가 없어 이 시험이 재개 경로를 밟지 못했습니다 — 통과해도 아무것도 지키지 못합니다.",
  );
  const second = await runGraph(automation, automation.graph, { initialVars: { message: "두 번째" } });
  const after = existsSync(outPath) ? readFileSync(outPath, "utf8") : "(없음)";
  check(
    "a-changed-input-wins-over-the-earlier-run",
    second.ok && after === "두 번째",
    `입력을 바꿨는데 결과가 안 바뀌었습니다(파일: ${after}). `
    + "새 요청을 읽는 단계는 완료에서 되돌려야 하고, 그 단계가 만든 값을 읽는 단계까지 번져야 합니다.",
  );
  check(
    "the-downstream-of-a-changed-input-is-redone",
    String(second.outputs?.read ?? "") === "두 번째",
    `하류 단계가 옛 결과를 재사용했습니다(다시 읽은 값: ${JSON.stringify(second.outputs?.read ?? null)}).`,
  );
}

// ── ③ 상태 축: crash-after-success — 바깥을 바꾼 **뒤** 죽으면, 재개가 그것을 두 번 하나 ──
//
// Durable Execution 연구가 이름 붙인 첫 번째 실패 유형이다(Zylos 2026-04):
//   "A process can crash after an external API succeeds but before local state is written."
// 그리고 두 번째가 retry duplication — 이미 끝난 것을 감지 못해 같은 발송을 반복하는 것.
// 권고된 시험 방법이 **경계마다 일부러 죽여 보기**라서 그대로 한다.
//
// 여기서는 "메일 발송" 대신 **파일에 한 줄 덧붙이기**로 부수효과를 만든다. 두 번 돌면
// 두 줄이 되므로, 중복 실행이 눈에 보이는 사실로 남는다(모델 주장이 아니라 관측).
{
  const ledger = path.join(dir, "ledger.txt");
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "note" }),
      node("send", "code", {
        effect: "mutation",
        consumes: "note",
        produces: "sent",
        codeLang: "python",
        code: [
          "import pathlib",
          `p = pathlib.Path(${JSON.stringify(ledger)})`,
          "with p.open('a', encoding='utf8') as fh:",
          "    fh.write(str(vars.get('note','')) + '\\n')",
          "result = 'sent'",
        ].join("\n"),
      }, "바깥으로 보낸다(덧붙이기)"),
      node("boom", "code", {
        effect: "read",
        consumes: "sent",
        produces: "never",
        codeLang: "python",
        // 발송 **직후** 죽는다 — 이게 crash-after-success 의 경계다.
        code: "raise RuntimeError('boundary crash')",
      }, "보낸 직후 죽는다"),
    ],
    edges: [edge("start", "send"), edge("send", "boom")],
  };
  const automation = saveAutomation(graph, "crash-after-success");
  const first = await runGraph(automation, automation.graph, { initialVars: { note: "한 번만" } });
  const linesAfterFirst = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").length : 0;
  check(
    "the-side-effect-happened-once-before-the-crash",
    !first.ok && linesAfterFirst === 1,
    `경계 크래시를 만들지 못했습니다(ok=${first.ok}, 줄 수=${linesAfterFirst}) — 이 시험이 아무것도 재지 못합니다.`,
  );

  const again = await runGraph(automation, automation.graph, { initialVars: { note: "한 번만" } });
  const linesAfterSecond = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").length : 0;
  check(
    "a-resume-does-not-repeat-a-committed-side-effect",
    linesAfterSecond === 1,
    `재개가 이미 끝난 부수효과를 다시 했습니다(줄 수 ${linesAfterFirst} → ${linesAfterSecond}). `
    + "바깥으로 나간 일은 두 번 나가면 안 됩니다 — 발송·결제였다면 되돌릴 수 없습니다. "
    + `(두 번째 실행 ok=${again.ok})`,
  );
}

// ── ④ 되돌이 축 — 오늘 결함이 제일 많이 나온 자리 ────────────────────────────────
//
// 되돌이는 상태를 곱셈으로 늘린다: 몇 바퀴 돌았는지, 그 안에서 바깥을 바꿨는지,
// 빠져나갈 판단이 있는지. 그래서 여기만 따로 센다.
{
  // ④-1 상한이 있는 정상 되돌이는 **끝난다**. 안 끝나면 사람이 안 보는 새 토큰이 샌다.
  {
    const graph = {
      version: 1,
      nodes: [
        node("start", "trigger", { kind: "input", produces: "seed" }),
        node("work", "code", {
          effect: "read", produces: "tries", codeLang: "python",
          produces: 'keepgoing', code: "result = 'yes'",
        }, "한 바퀴"),
        node("gate", "condition", { var: "keepgoing", op: "falsy" }, "끝났나?"),
        node("done", "code", { effect: "read", produces: "final", codeLang: "python", code: "result = 'done'" }),
      ],
      edges: [
        edge("start", "work"), edge("work", "gate"),
        edge("gate", "done", { sourceHandle: "true" }),
        // 거짓이면 되돌아간다 — 상한 2바퀴.
        { id: "gate->work", source: "gate", target: "work", sourceHandle: "false", maxIterations: 2 },
      ],
    };
    const automation = saveAutomation(graph, "bounded-loop");
    const started = Date.now();
    const run = await runGraph(automation, automation.graph, { initialVars: { seed: "go" } });
    check(
      "a-bounded-loop-terminates",
      Date.now() - started < 120_000 && typeof run.ok === "boolean",
      "상한이 있는 되돌이가 끝나지 않았습니다 — 사람이 안 보는 동안 계속 돕니다.",
    );
  }

  // ④-2 상한이 없는 되돌이는 **실행 전에 거부**된다. 돌기 시작하면 멈출 사람이 없다.
  {
    const graph = {
      version: 1,
      nodes: [
        node("start", "trigger", { kind: "input", produces: "seed" }),
        node("work", "code", { effect: "read", produces: "w", codeLang: "python", code: "result = 'w'" }),
        node("gate", "condition", { var: "keepgoing", op: "falsy" }, "끝났나?"),
        node("done", "code", { effect: "read", produces: "d", codeLang: "python", code: "result = 'd'" }),
      ],
      edges: [
        edge("start", "work"), edge("work", "gate"),
        edge("gate", "done", { sourceHandle: "true" }),
        // 상한 없음 — 커널이 실행 자체를 막아야 한다.
        edge("gate", "work", { sourceHandle: "false" }),
      ],
    };
    const automation = saveAutomation(graph, "unbounded-loop");
    const run = await runGraph(automation, automation.graph, { initialVars: { seed: "go" } });
    /*
     * ★"실패했다"가 아니라 **"그 이유로 실패했다"** 를 잰다.
     *
     *   실측 2026-08-20: 첫 판은 `!run.ok` 만 봤다. 그런데 이 그래프는 조건이 읽는 값이
     *   없어 되돌이 검사에 **닿기도 전에** 다른 이유로 죽었고, 그래서 상한 방어를 통째로
     *   제거해도 통과하는 공짜 초록이었다. 실패의 이유를 안 보면 시험은 아무것도 안 지킨다.
     */
    const why = String(run.error ?? "") + JSON.stringify(run.nodeFailures ?? {});
    check(
      "an-unbounded-loop-is-refused-before-it-starts",
      !run.ok && /LOOP_BOUND_UNDECLARED|LOOP_BOUND_INVALID|LOOP_WITHOUT_EXIT/.test(why),
      "상한 없는 되돌이가 **그 이유로** 거부되지 않았습니다 — 자동화는 사람이 안 볼 때 도는 것이라 "
      + `멈출 사람이 없습니다. 실제 사유: ${why.slice(0, 200)}`,
    );
  }

  // ④-3 ★되돌이 **안에 바깥을 바꾸는 단계**가 있으면, 바퀴 수만큼 나간다.
  //      발송·결제였다면 그 횟수가 그대로 피해다. 상한이 지켜지는지 줄 수로 잰다.
  {
    const ledger = path.join(dir, "loop-ledger.txt");
    const graph = {
      version: 1,
      nodes: [
        node("start", "trigger", { kind: "input", produces: "seed" }),
        node("send", "code", {
          effect: "mutation", produces: "sent", codeLang: "python",
          code: [
            "import pathlib",
            `p = pathlib.Path(${JSON.stringify(ledger)})`,
            "with p.open('a', encoding='utf8') as fh:",
            "    fh.write('x\\n')",
            "result = 'sent'",
          ].join("\n"),
        }, "바깥으로 보낸다"),
        node("gate", "condition", { var: "keepgoing", op: "falsy" }, "그만할까?"),
        node("done", "code", { effect: "read", produces: "d", codeLang: "python", code: "result = 'd'" }),
      ],
      edges: [
        edge("start", "send"), edge("send", "gate"),
        edge("gate", "done", { sourceHandle: "true" }),
        { id: "gate->send", source: "gate", target: "send", sourceHandle: "false", maxIterations: 2 },
      ],
    };
    const automation = saveAutomation(graph, "mutation-inside-loop");
    await runGraph(automation, automation.graph, { initialVars: { seed: "go" } });
    const sends = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).length : 0;
    check(
      "a-loop-cannot-send-more-times-than-its-cap",
      sends > 0 && sends <= 3,
      `되돌이 안의 발송이 상한을 넘었습니다(${sends}회, 상한 2바퀴 → 최대 3회). `
      + "이 숫자가 메일·결제였다면 그대로 피해입니다.",
    );
  }
}

// ── ⑤ 연결 축: 갈림길 한쪽만 이어져 있으면 실행이 죽는다(수리가 만들면 안 되는 모양) ──
{
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("gate", "condition", { var: "seed", op: "truthy" }, "값이 있나?"),
      node("yes", "code", { effect: "read", produces: "yesout", codeLang: "python", code: "result = 'yes'" }),
    ],
    edges: [edge("start", "gate"), edge("gate", "yes", { sourceHandle: "true" })],
  };
  const automation = saveAutomation(graph, "one-sided-branch");
  const run = await runGraph(automation, automation.graph, { initialVars: { seed: "" } });
  // 실패를 기대하는 단언은 **사유까지** 본다 — 아무 이유로든 실패하면 통과하는 시험은
  // 아무것도 지키지 않는다(오늘 세 번 당했다).
  const whyBranch = String(run.error ?? "") + JSON.stringify(run.nodeFailures ?? {});
  check(
    "a-one-sided-branch-fails-loudly-not-silently",
    !run.ok && /NO_MATCHING_EDGE/.test(whyBranch),
    "한쪽만 이어진 갈림길에서 판정이 반대로 나왔는데 그 사유로 멈추지 않았습니다 — "
    + `그 실행은 아무것도 안 한 것입니다. 실제 사유: ${whyBranch.slice(0, 180)}`,
  );
}

// ── ⑥ 상태 축: 그래프를 고친 뒤 — 실행도 재조정도 안 되는 잠김이 없어야 한다 ──────
//
// 실측 2026-08-20: 부수효과를 남기고 실패한 실행이 있는 상태에서 그래프를 고치면
//   · 실행   → automation_partial_graph_changed
//   · 재조정 → automation_graph_reconciliation_graph_drift
// 둘 다 옳은 거절인데 합치면 그 자동화는 **영구히 잠긴다**. 그래프를 편집한 사람은
// 누구나 이 상태에 빠질 수 있으므로, 나갈 문이 실재하는지 여기서 지킨다.
{
  const ledger = path.join(dir, "edited-ledger.txt");
  const makeGraph = (marker) => ({
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("send", "code", {
        effect: "mutation", produces: "sent", codeLang: "python",
        code: [
          "import pathlib",
          `p = pathlib.Path(${JSON.stringify(ledger)})`,
          `p.write_text(${JSON.stringify(marker)}, encoding='utf8')`,
          "result = 'sent'",
        ].join("\n"),
      }, "바깥으로 보낸다"),
      node("boom", "code", {
        effect: "read", consumes: "sent", produces: "never", codeLang: "python",
        code: "raise RuntimeError('boundary crash')",
      }, "보낸 직후 죽는다"),
    ],
    edges: [edge("start", "send"), edge("send", "boom")],
  });

  const automation = saveAutomation(makeGraph("v1"), "edited-after-effects");
  const crashed = await runGraph(automation, automation.graph, { initialVars: { seed: "go" } });
  check(
    "an-edited-graph-starts-from-a-real-partial-failure",
    !crashed.ok && existsSync(ledger),
    "부수효과를 남긴 실패를 만들지 못했습니다 — 이 시험이 잠김 상황에 닿지 못합니다.",
  );

  // 사람이 그래프를 고친다(라벨 한 글자만 바꿔도 digest 가 달라진다).
  const edited = makeGraph("v2");
  const { updateAutomationGraph } = store;
  updateAutomationGraph(automation.id, edited, { note: "matrix: 사람이 고쳤다" });
  const afterEdit = store.getAutomation(automation.id);

  const blocked = await runGraph(afterEdit, afterEdit.graph, { initialVars: { seed: "go" } });
  const whyBlocked = String(blocked.error ?? "");
  check(
    "an-edited-graph-refuses-to-replay-committed-effects",
    !blocked.ok && /partial_graph_changed|reconciliation_required|ambiguous_side_effect/.test(whyBlocked),
    `그래프를 고쳤는데 이미 나간 부수효과를 그대로 재생했습니다 — 두 번 나갑니다. 사유: ${whyBlocked.slice(0, 180)}`,
  );

  /*
   * ★그리고 거기서 **나갈 문이 있어야 한다.** 거절만 있고 문이 없으면 영구 잠김이다.
   *   사람이 "이전 실행은 잊고 처음부터"라고 말하는 것 — 그래프가 실제로 바뀐 경우에만 응한다.
   */
  const gr = await import("../dist/electron/store/graph-reconciliation.js");
  const { graphExecutionDigest } = await import("../dist/shared/graph-execution-digest.js");
  const forgot = gr.forgetStaleGraphCheckpoint(automation.id, graphExecutionDigest(afterEdit, afterEdit.graph));
  check(
    "an-edited-graph-has-a-way-out",
    forgot.forgot === true,
    `그래프를 고친 뒤 잠긴 자동화를 사람이 풀 수단이 없습니다(사유: ${forgot.reason}) — 실행도 재조정도 `
    + "거절되는 상태가 영구히 남습니다.",
  );

  const unlocked = await runGraph(store.getAutomation(automation.id), afterEdit.graph, { initialVars: { seed: "go" } });
  check(
    "after-forgetting-the-automation-runs-again",
    existsSync(ledger) && readFileSync(ledger, "utf8") === "v2",
    `문을 지났는데도 자동화가 새 그래프로 돌지 않았습니다(파일: ${existsSync(ledger) ? readFileSync(ledger, "utf8") : "없음"}, ok=${unlocked.ok}).`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑦ 값 가공 축 — transform
 *
 * transform 은 모델 없이 도는 유일한 "값을 만드는" 노드다. 이 저장소가 이미 두 번
 * 고친 병이 여기 산다: **초록불인데 값은 안 생긴다.** 그러면 다음 단계가
 * NODE_INPUT_MISSING 으로 죽고, 사람 화면에서는 성공한 단계 **다음**이 실패한다 —
 * 원인을 의심할 곳이 없다. 그래서 두 가지를 지킨다: 가공한 값이 실제로 다음 단계에
 * 닿는가, 그리고 가공이 불가능하면 그 단계 자신이 실패하는가.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const out = path.join(dir, "transform-out.txt");
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "raw" }),
      node("shape", "transform", {
        effect: "pure", mode: "format", from: "raw", to: "shaped",
        template: "받은 값은 [{{raw}}] 입니다",
      }, "값을 다듬는다"),
      node("write", "code", {
        effect: "mutation", consumes: "shaped", produces: "written", codeLang: "python",
        code: [
          "import pathlib",
          `pathlib.Path(${JSON.stringify(out)}).write_text(str(vars.get('shaped','')), encoding='utf8')`,
          "result = 'ok'",
        ].join("\n"),
      }, "다듬은 값을 쓴다"),
    ],
    edges: [edge("start", "shape"), edge("shape", "write")],
  };
  const run = await runGraph(saveAutomation(graph, "transform-flows"), graph, { initialVars: { raw: "안녕" } });
  check(
    "a-transformed-value-reaches-the-next-step",
    run.ok && existsSync(out) && readFileSync(out, "utf8") === "받은 값은 [안녕] 입니다",
    `가공한 값이 다음 단계에 닿지 않았습니다(파일: ${existsSync(out) ? readFileSync(out, "utf8") : "없음"}, `
    + `ok=${run.ok}, 사유: ${String(run.error ?? "").slice(0, 140)}).`,
  );

  // 가공할 대상이 없는 transform. 조용히 지나가면 안 된다.
  const broken = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "raw" }),
      node("shape", "transform", { effect: "pure", mode: "format", to: "shaped" }, "무엇을 다듬을지가 없다"),
      node("after", "code", { effect: "read", consumes: "shaped", produces: "done", codeLang: "python", code: "result = 1" }),
    ],
    edges: [edge("start", "shape"), edge("shape", "after")],
  };
  const brokenRun = await runGraph(saveAutomation(broken, "transform-silent"), broken, { initialVars: { raw: "x" } });
  const failedNode = Object.keys(brokenRun.nodeFailures ?? {}).join(",");
  check(
    "a-transform-that-cannot-produce-fails-on-itself",
    !brokenRun.ok && failedNode === "shape",
    "값을 못 만드는 가공 단계가 초록불로 지나갔습니다 — 사람 화면에서는 **성공한 단계 다음**이 "
    + `실패해 원인을 의심할 곳이 없습니다(실패한 단계: ${failedNode || "없음"}, ok=${brokenRun.ok}).`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑧ 자동화가 자동화를 부르는 축 — subgraph
 *
 * 안쪽 그래프가 바깥으로 나가는 일(파일 쓰기·발송)을 하면, 그 효과는 **바깥 그래프의
 * 체크포인트에도 이미 나간 것으로** 잡혀야 한다. 안 그러면 바깥이 재개될 때 안쪽이
 * 통째로 다시 돌아 두 번 나간다 — 오늘 code 노드에서 고친 것과 같은 계열이다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const tally = path.join(dir, "subgraph-tally.txt");
  const innerGraph = {
    version: 1,
    nodes: [
      node("in", "trigger", { kind: "input", produces: "payload" }),
      node("send", "code", {
        effect: "mutation", produces: "sent", codeLang: "python",
        code: [
          "import pathlib",
          `p = pathlib.Path(${JSON.stringify(tally)})`,
          "p.write_text(('x' * 0) + (p.read_text(encoding='utf8') if p.exists() else '') + 'x', encoding='utf8')",
          "result = 'sent'",
        ].join("\n"),
      }, "안쪽에서 바깥으로 보낸다"),
    ],
    edges: [edge("in", "send")],
  };
  const inner = saveAutomation(innerGraph, "subgraph-inner");

  const outerGraph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("call", "subgraph", { graphRef: inner.id, input: "{{seed}}", produces: "innerResult" }, "안쪽 자동화를 부른다"),
      node("boom", "code", {
        effect: "read", consumes: "innerResult", produces: "never", codeLang: "python",
        code: "raise RuntimeError('outer crash after inner sent')",
      }, "부른 직후 죽는다"),
    ],
    edges: [edge("start", "call"), edge("call", "boom")],
  };
  const outer = saveAutomation(outerGraph, "subgraph-outer");
  const first = await runGraph(outer, outerGraph, { initialVars: { seed: "go" } });
  const afterFirst = existsSync(tally) ? readFileSync(tally, "utf8").length : 0;
  check(
    "an-inner-graph-really-sent-once-before-the-outer-crash",
    !first.ok && afterFirst === 1,
    `안쪽 자동화가 한 번 나가고 바깥이 죽는 상황을 못 만들었습니다(보낸 횟수: ${afterFirst}, ok=${first.ok}).`,
  );

  const resumed = await runGraph(store.getAutomation(outer.id), outerGraph, { initialVars: { seed: "go" } });
  const afterResume = existsSync(tally) ? readFileSync(tally, "utf8").length : 0;
  check(
    "a-resume-does-not-re-send-through-a-subgraph",
    afterResume === 1,
    `바깥 그래프를 재개하자 안쪽 자동화가 **다시 보냈습니다**(보낸 횟수 ${afterFirst}→${afterResume}). `
    + `자동화가 자동화를 부르면 중복 발송 보호가 사라집니다(ok=${resumed.ok}).`,
  );

  // 자기 자신을 부르는 것은 깊이 상한이 아니라 **이유가 있는 거절**로 막혀야 한다.
  const selfGraph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("call", "subgraph", { graphRef: "SELF", input: "{{seed}}", produces: "r" }, "자기를 부른다"),
    ],
    edges: [edge("start", "call")],
  };
  const selfAuto = saveAutomation(selfGraph, "subgraph-self");
  selfGraph.nodes[1].config.graphRef = selfAuto.id;
  store.updateAutomationGraph(selfAuto.id, selfGraph, { note: "matrix: self ref" });
  const selfRun = await runGraph(store.getAutomation(selfAuto.id), selfGraph, { initialVars: { seed: "go" } });
  check(
    "an-automation-that-calls-itself-is-refused-with-a-reason",
    !selfRun.ok && /SUBGRAPH_SELF_CALL/.test(JSON.stringify(selfRun)),
    `자기를 부르는 자동화가 이유 없이 돌거나 다른 사유로 죽었습니다: ${JSON.stringify(selfRun).slice(0, 200)}`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑨ 연결 축의 남은 칸 — 자기루프와 중첩 되돌이
 *
 * 되돌이는 커널의 planGraphLoops 하나가 판정한다(게이트
 * the-kernel-is-the-single-authority-on-loops). 상한 있는 단순 되돌이는 이미
 * 지켰다. 남은 두 모양 — 노드가 자기에게 돌아오는 것, 되돌이 안의 되돌이 — 도
 * **시작 전에** 판정돼야 한다. 돌다가 죽으면 이미 나간 것이 남는다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const selfLoop = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("spin", "code", {
        effect: "pure", produces: "keepgoing", codeLang: "python",
        code: "result = True",
      }, "자기에게 돌아온다"),
    ],
    edges: [edge("start", "spin"), edge("spin", "spin", { condition: "keepgoing" })],
  };
  const selfLoopRun = await runGraph(saveAutomation(selfLoop, "self-loop"), selfLoop, { initialVars: { seed: "go" } });
  check(
    "a-self-loop-without-a-cap-is-refused-before-it-starts",
    !selfLoopRun.ok,
    "상한 없이 자기에게 돌아오는 단계가 그냥 시작했습니다 — 끝나지 않거나, 끝날 때까지 "
    + `바깥으로 계속 나갑니다(ok=${selfLoopRun.ok}).`,
  );

  const capped = path.join(dir, "nested-loop.txt");
  const nested = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("outer", "code", { effect: "pure", produces: "again", codeLang: "python", code: "result = True" }, "바깥 되돌이"),
      node("innerStep", "code", {
        effect: "mutation", produces: "tick", codeLang: "python", maxIterations: 2,
        code: [
          "import pathlib",
          `p = pathlib.Path(${JSON.stringify(capped)})`,
          "p.write_text((p.read_text(encoding='utf8') if p.exists() else '') + 'x', encoding='utf8')",
          "result = True",
        ].join("\n"),
      }, "안쪽 되돌이 — 돌 때마다 바깥으로 나간다"),
    ],
    edges: [
      edge("start", "outer"),
      edge("outer", "innerStep"),
      edge("innerStep", "innerStep", { condition: "tick", maxIterations: 2 }),
      edge("innerStep", "outer", { condition: "again", maxIterations: 2 }),
    ],
  };
  const nestedRun = await runGraph(saveAutomation(nested, "nested-loops"), nested, { initialVars: { seed: "go" } });
  const sends = existsSync(capped) ? readFileSync(capped, "utf8").length : 0;
  check(
    "nested-loops-cannot-send-more-than-their-caps-allow",
    sends <= 4,
    `되돌이 안의 되돌이가 상한(2×2=4)을 넘어 ${sends}번 바깥으로 나갔습니다 — 상한이 안쪽에 `
    + `안 걸립니다(ok=${nestedRun.ok}, 사유: ${String(nestedRun.error ?? "").slice(0, 140)}).`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑪ 연결 축의 마지막 칸 — 양쪽이 이어진 갈림길
 *
 * 한쪽만 이어진 갈림길은 이미 지켰다(⑤). 양쪽이 이어진 갈림길에서 지켜야 할 것은
 * 두 가지고, 둘 다 사람을 다치게 한 적이 있다:
 *   1. 안 고른 쪽이 **돌면 안 된다** — 돌면 두 갈래가 다 실행돼 바깥으로 두 번 나간다.
 *   2. 안 고른 쪽의 하류가 "닿지 못했다"로 **실패하면 안 된다** — 갈림길은 원래
 *      한쪽을 안 가는 것이고, 그걸 실패로 적으면 정상 실행이 매번 빨간불이 된다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const taken = path.join(dir, "branch-taken.txt");
  const notTaken = path.join(dir, "branch-not-taken.txt");
  const writer = (id, file, label) => node(id, "code", {
    effect: "mutation", produces: `${id}out`, codeLang: "python",
    code: [
      "import pathlib",
      `pathlib.Path(${JSON.stringify(file)}).write_text('ran', encoding='utf8')`,
      `result = ${JSON.stringify(id)}`,
    ].join("\n"),
  }, label);

  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("gate", "condition", { var: "seed", op: "truthy" }, "값이 있나?"),
      writer("yes", taken, "있으면 이쪽"),
      writer("no", notTaken, "없으면 저쪽"),
      node("after", "code", {
        effect: "read", produces: "summary", codeLang: "python",
        code: "result = 'done'",
      }, "고른 쪽 다음"),
    ],
    edges: [
      edge("start", "gate"),
      edge("gate", "yes", { sourceHandle: "true" }),
      edge("gate", "no", { sourceHandle: "false" }),
      edge("yes", "after"),
    ],
  };
  const run = await runGraph(saveAutomation(graph, "two-sided-branch"), graph, { initialVars: { seed: "있다" } });
  check(
    "only-the-chosen-side-of-a-branch-runs",
    existsSync(taken) && !existsSync(notTaken),
    "갈림길에서 안 고른 쪽도 돌았습니다 — 두 갈래가 다 실행되면 바깥으로 두 번 나갑니다"
    + `(고른 쪽 ${existsSync(taken) ? "돎" : "안 돎"}, 안 고른 쪽 ${existsSync(notTaken) ? "돎" : "안 돎"}).`,
  );
  check(
    "the-road-not-taken-is-not-reported-as-a-failure",
    run.ok,
    "갈림길이 정상으로 한쪽을 안 갔는데 실행이 실패로 끝났습니다 — 갈림길을 쓴 자동화가 "
    + `매번 빨간불이 됩니다(사유: ${String(run.error ?? "").slice(0, 160)}).`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑩ 남은 노드 종류 — agent / tool / action / output / eval
 *
 * 이 다섯은 **실행하려면** 모델이나 런타임이 필요하다. 그래서 여기 넣지 않는다.
 * 그러나 이들이 **잘못 설정됐을 때의 거절**은 모델을 부르기 전에 일어나고, 그래서
 * 모델 없이 재현된다. 그리고 그게 이 종류들에서 가장 사람을 다치게 하는 결함이다:
 *   초록불인데 아무 일도 안 일어난다 — 도구를 붙였다고 믿는데 어디에도 안 붙었고,
 *   내보냈다고 믿는데 내용이 비었다.
 * 그래서 이 축은 "실행"이 아니라 "**거절이 실재하는가**"를 지킨다.
 * ──────────────────────────────────────────────────────────────────────────── */
const guardCases = [
  {
    name: "an-output-with-nothing-to-say-is-refused",
    expect: "OUTPUT_NODE_EMPTY",
    // ★자동화에 프롬프트가 남아 있으면 출력 노드는 **그것**을 내용으로 삼는다(설계된 되돌아보기).
    //   그래서 "정말 아무 데도 적힌 게 없는" 상태를 만들려면 프롬프트까지 비워야 한다.
    emptyPrompt: true,
    nodes: [node("out", "output", { effect: "read" }, "무엇을 내보낼지가 없다")],
    hurt: "내보낼 내용이 없는 출력 단계가 초록불로 끝납니다 — 사람은 결과가 나갔다고 믿습니다.",
  },
  {
    name: "an-output-whose-value-nobody-made-is-refused",
    expect: "NODE_INPUT_MISSING",
    nodes: [node("out", "output", { effect: "read", text: "결과는 {{nobodyMakesThis}} 입니다" }, "빈 구멍이 있는 출력")],
    hurt: "앞 단계가 안 만든 값을 빈칸으로 내보내고 성공으로 남습니다 — 빈 보고서가 나갑니다.",
  },
  {
    name: "a-tool-nobody-chose-is-refused",
    expect: "TOOL_NODE_UNCONFIGURED",
    nodes: [node("t", "tool", {}, "어떤 도구인지가 없다")],
    hurt: "무엇을 쓸지 안 고른 도구 단계가 지나갑니다.",
  },
  {
    name: "a-tool-attached-to-nothing-is-refused",
    expect: "TOOL_NODE_UNATTACHED",
    nodes: [node("t", "tool", { catalog: "gmail" }, "아무 에이전트에도 안 붙었다")],
    hurt: "도구를 붙였다고 믿는데 어느 에이전트에도 안 이어져, 실제로는 아무 데도 안 쓰입니다.",
  },
  {
    name: "an-eval-with-no-criteria-is-refused",
    expect: "EVAL_INCOMPLETE",
    nodes: [node("v", "eval", { subject: "seed" }, "무엇을 기준으로 볼지가 없다")],
    hurt: "기준 없는 검증 단계가 통과합니다 — 검증했다는 표시만 남습니다.",
  },
];
for (const c of guardCases) {
  const graph = {
    version: 1,
    nodes: [node("start", "trigger", { kind: "input", produces: "seed" }), ...c.nodes],
    edges: c.nodes.map((n) => edge("start", n.id)),
  };
  const saved = saveAutomation(graph, c.name);
  if (c.emptyPrompt) {
    getDb().prepare("UPDATE automations SET prompt_template = '' WHERE id = ?").run(saved.id);
  }
  const run = await runGraph(store.getAutomation(saved.id), graph, { initialVars: { seed: "go" } });
  const codes = Object.values(run.nodeFailures ?? {}).map((f) => f.code).join(",");
  check(
    c.name,
    !run.ok && codes.includes(c.expect),
    `${c.hurt} (기대한 사유 ${c.expect}, 실제 ok=${run.ok} 사유=${codes || String(run.error ?? "없음").slice(0, 120)})`,
  );
}

// 거절만 있고 도는 길이 없으면 그 노드 종류는 쓸모가 없다 — output 은 모델 없이도
// 끝까지 돌아야 한다(내용이 선언돼 있고 바깥으로 안 나가는 경우).
{
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "count" }),
      node("out", "output", { effect: "read", text: "오늘 처리한 건수: {{count}}", produces: "report" }, "결과로 남긴다"),
    ],
    edges: [edge("start", "out")],
  };
  const run = await runGraph(saveAutomation(graph, "output-declared"), graph, { initialVars: { count: 12 } });
  check(
    "a-declared-output-passes-its-content-through-untouched",
    run.ok && String(run.outputs?.out ?? "") === "오늘 처리한 건수: 12",
    "사람이 적어 둔 결과 문장이 그대로 안 나갔습니다 — 내용이 지시문으로 오해되면 모델이 "
    + `다시 써 버립니다(실제: ${JSON.stringify(run.outputs?.out ?? null)}, ok=${run.ok}).`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑫ 저작 축 — 에이전트가 코드에 넘기는 값의 **형식이 못 박히는가**
 *
 * 실측 2026-08-20 (캠페인 E4 vs E5): 같은 빌더가 한 그래프에는 "Return a JSON list of
 * objects"를 적고(완주), 다른 그래프에는 "write down:"만 적었다(다음 코드가 빈손).
 * 차이는 형식 한 줄이었고, 그 한 줄을 쓸지 말지가 **그날 모델 기분**에 달려 있었다.
 * 사람에게 보이는 결과가 그렇게 정해지면 안 된다 — 그래프 모양으로 정한다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const { buildGraphFromBlueprint } = await import("../dist/shared/graph-blueprint.js");
  const built = buildGraphFromBlueprint({
    name: "형식 계약", goal: "메일을 정리한다",
    trigger: { kind: "input", label: "시작", varName: "seed" },
    steps: [
      { kind: "agent", title: "메일을 분류한다", instruction: "각 메일을 분류하고 발신자와 종류를 적어라",
        effect: "read", produces: "requests", consumes: [] },
      { kind: "code", title: "표로 만든다", instruction: "요청을 표로", code: "result = 1",
        codeLang: "python", effect: "read", produces: "rows", consumes: ["requests"] },
      { kind: "agent", title: "사람에게 요약한다", instruction: "요약을 한 문단으로 써라",
        effect: "read", produces: "summary", consumes: ["rows"] },
    ],
  });
  const promptOf = (label) => String(
    (built.graph?.nodes ?? []).find((n) => n.label === label)?.config?.prompt ?? "",
  );
  check(
    "the-blueprint-compiles-at-all",
    built.ok === true,
    `청사진이 그래프가 되지 않았습니다 — 이 시험이 아무것도 못 잽니다(${JSON.stringify(built.problems ?? null).slice(0, 200)}).`,
  );
  check(
    "a-value-a-code-step-reads-gets-a-format-contract",
    /ONLY JSON/.test(promptOf("메일을 분류한다")),
    "코드 단계가 읽는 값인데 에이전트 프롬프트에 형식이 안 박혔습니다 — 모델이 글로 "
    + `답하면 다음 코드가 빈손을 냅니다(프롬프트: ${promptOf("메일을 분류한다").slice(0, 120)}).`,
  );
  /*
   * ★검증이 읽는 값도 기계가 읽는 값이다. 실측 2026-08-20 (캠페인 E3): "옮겼다고 보고한
   *   파일이 실제로 그 자리에 있는가"를 판정하려면 목록이 있어야 하는데, 그 값을 만드는
   *   단계가 산문으로 답해 판정이 값을 못 찾았다. 자동화는 파일을 정확히 정리하고
   *   대화에서 정확히 보고했는데 그래프는 "값이 안 넘어왔다"로 멈췄다.
   */
  const withCheck = buildGraphFromBlueprint({
    name: "검증이 읽는 값", goal: "파일을 옮기고 확인한다",
    trigger: { kind: "input", label: "시작", varName: "seed" },
    steps: [
      { kind: "agent", title: "파일을 옮긴다", instruction: "파일을 옮겨라",
        effect: "mutation", produces: "filed", consumes: [] },
      // ★코드는 이 값을 **안 읽는다** — 읽으면 "코드가 읽으면 계약" 규칙에 걸려
      //   "검증이 읽으면 계약" 규칙을 시험하지 못한다.
      { kind: "code", title: "폴더를 다시 본다", instruction: "재확인",
        code: "import os\nresult = os.listdir('.')",
        codeLang: "python", effect: "read", produces: "ondisk", consumes: [] },
    ],
    checks: [
      // 빌더는 바깥을 바꾼 결과를 **독립적으로 다시 관측한** 증거를 요구한다(옳다).
      { afterStep: 1, subject: "filed", criteria: "filed이(가) 바깥에 실제로 반영됐다",
        evidence: "ondisk", produces: "filed_ok",
        items: [{ text: "보고한 파일이 관측에도 있다", kind: "must" }] },
    ],
  });
  const movedPrompt = String(
    (withCheck.graph?.nodes ?? []).find((n) => n.label === "파일을 옮긴다")?.config?.prompt ?? "",
  );
  check(
    "a-value-a-check-reads-gets-a-format-contract",
    withCheck.ok === true && /ONLY JSON/.test(movedPrompt),
    "검증이 보는 값인데 형식이 안 박혔습니다 — 판정이 목록을 못 찾아, 일은 다 해 놓고 "
    + `"값이 안 넘어왔다"로 멈춥니다(ok=${withCheck.ok}, 프롬프트: ${movedPrompt.slice(0, 90)}).`,
  );
  check(
    "a-value-only-a-person-reads-stays-prose",
    !/ONLY JSON/.test(promptOf("사람에게 요약한다")),
    "사람이 읽는 요약까지 JSON 으로 강제했습니다 — 읽으라고 만든 글이 기계 형식이 됩니다.",
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑬ 모델이 JSON 을 코드 펜스로 감싸 내도 다음 단계가 읽는가
 *
 * 실측 2026-08-20 (캠페인 E5): 저작 계약을 넣어 에이전트가 JSON 을 내게 만들었더니
 * 이번엔 ```json 으로 감싸서 냈고, 다음 코드가 못 읽어 빈 배열을 냈다 — 같은 자리에서
 * 두 번째로 막혔다. 프롬프트로 "펜스 쓰지 마라"는 부탁이고, 벗기는 것이 보장이다.
 *
 * ★여기서는 **판정 함수만** 잰다. 펜스를 내는 것은 모델이고, 이 매트릭스에는 모델이
 *   없다(코드 노드가 낸 문자열은 코드의 의도이므로 벗기면 안 된다 — 그건 다른 규칙이다).
 *   실제 에이전트 경로는 라이브 스위트가 잰다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const { unwrapFencedJson } = await import("../dist/electron/workflow/run-graph.js");
  const cases = [
    { why: "펜스로 감싼 JSON 객체", input: "```json\n{\"a\":1}\n```", want: '{"a":1}' },
    { why: "언어 표기 없는 펜스", input: "```\n[1,2]\n```", want: "[1,2]" },
    { why: "펜스 안이 JSON 이 아니면 그대로", input: "```\n안녕하세요\n```", want: "```\n안녕하세요\n```" },
    { why: "글 안의 예시 블록은 그대로", input: "설정은:\n```json\n{}\n```\n끝.", want: "설정은:\n```json\n{}\n```\n끝." },
    { why: "펜스 없는 JSON 은 그대로", input: '{"a":1}', want: '{"a":1}' },
  ];
  const wrong = cases.filter((c) => unwrapFencedJson(c.input) !== c.want);
  check(
    "a-fenced-json-value-is-unwrapped-and-prose-is-not",
    typeof unwrapFencedJson === "function" && wrong.length === 0,
    typeof unwrapFencedJson !== "function"
      ? "펜스 벗기기 함수가 없습니다 — 모델이 감싸 내면 다음 단계가 못 읽습니다."
      : `펜스 판정이 틀립니다: ${wrong.map((c) => `${c.why} → ${JSON.stringify(unwrapFencedJson(c.input)).slice(0, 60)}`).join(" / ")}`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑭ 저작 축 — **정직한 빈 결과**를 실패로 부르지 않는가
 *
 * 실측 2026-08-20 (캠페인 E3): "이미 처리한 건 다시 하지 마"라고 지은 자동화가 첫
 * 실행에서 첨부 3건을 정확히 정리했고, **두 번째 실행에서 실패했다** — 할 일이 없어
 * 0건이었는데 자동 생성된 검증이 "비었으니 실패"라고 했다. E5 도 같았다: 사람이
 * "아무것도 자동 반영하지 마라"를 골랐더니 apply 가 비었고 그게 설계대로인데 실패였다.
 *
 * 빈 결과에는 두 종류가 있다 — 일을 안 해서 빈손(실패)과, 일을 했는데 대상이 0건인
 * 것(정상). 그 둘을 가르는 것은 **왜 비었는지 함께 보고했는가**이지 단어가 아니다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const { autofillOutputChecks } = await import("../dist/shared/graph-blueprint.js");
  const filled = autofillOutputChecks({
    name: "빈 결과", goal: "이미 처리한 건 건너뛴다",
    trigger: { kind: "input", label: "시작", varName: "seed" },
    steps: [
      { kind: "code", title: "새 것만 고른다", instruction: "이미 처리한 건 뺀다",
        code: "result = []", codeLang: "python", effect: "read", produces: "picked", consumes: [] },
      { kind: "code", title: "파일을 옮긴다", instruction: "옮긴다", code: "result = 1",
        codeLang: "python", effect: "mutation", produces: "moved", consumes: ["picked"] },
    ],
  });
  const auto = (filled.checks ?? []).find((c) => c.subject === "picked");
  const criteria = String(auto?.criteria ?? "");
  const must = String(auto?.items?.find((i) => i.kind === "must")?.text ?? "");
  check(
    "an-empty-value-check-is-added-at-all",
    Boolean(auto),
    "바깥으로 나가는 단계가 쓰는 값에 확인이 안 붙었습니다 — 값을 넘기기로 해놓고 빈손이면 "
    + "초록인데 결과만 빈 실행이 됩니다.",
  );
  check(
    "an-honest-empty-result-is-not-called-a-failure",
    /0건|정직한 결과/.test(criteria) && /0건인 이유/.test(must),
    "\"비면 실패\"만 적혀 있습니다 — 이미 처리했거나 조용한 날이라 0건인 자동화가 매번 "
    + `실패로 찍힙니다(criteria: ${criteria.slice(0, 100)}).`,
  );
  check(
    "an-unexplained-empty-result-is-still-a-failure",
    /이유 없이 비어/.test(String(auto?.items?.find((i) => i.kind === "mustNot")?.text ?? "")),
    "이유 없이 빈 것까지 통과시키면 \"일을 안 하고 빈손\"이 성공이 됩니다 — 그건 이 "
    + "저장소가 이미 이름 붙인 거짓 성공입니다.",
  );
}

// ── 축: 갈림길에서 나가는 선은 화면이 아는 핸들을 달고 나가야 한다 ──────────────
// 실측 2026-08-20(E3): 데이터는 8노드 7엣지로 멀쩡한데 캔버스가 두 덩어리로 끊겼다.
// 분기 노드가 내주는 핸들은 `true`/`false` 둘뿐이라, 핸들 없는 엣지는 붙을 자리가
// 없어 **선이 통째로 사라진다.** 사용자에게는 "연결이 다 안 된 그래프"로 보인다.
{
  const { buildGraphFromBlueprint, autofillOutputChecks } =
    await import("../dist/shared/graph-blueprint.js");
  const bp = autofillOutputChecks({
    name: "분기 핸들", goal: "갈림길에서 나가는 선",
    trigger: { kind: "input", label: "시작", varName: "seed" },
    steps: [
      { kind: "agent", title: "본다", instruction: "본다", effect: "read",
        produces: "seen", consumes: ["seed"] },
      { kind: "code", title: "적는다", instruction: "적는다",
        code: "result = 1", codeLang: "python", effect: "read",
        produces: "wrote", consumes: ["seen"] },
      // 검증이 근거(wrote) 뒤로 옮겨 앉아도 **그 뒤에 갈 곳이 있어야** 이 축이 무언가를
      // 잰다. 마지막 칸에 놓인 검증은 나가는 선이 아예 없다.
      { kind: "code", title: "마무리", instruction: "마무리",
        code: "result = 2", codeLang: "python", effect: "read",
        produces: "done", consumes: ["wrote"] },
    ],
    checks: [{ afterStep: 0, subject: "seen", criteria: "본 것이 있다", evidence: "wrote" }],
  });
  const built = buildGraphFromBlueprint(bp);
  const typeOf = built.ok
    ? Object.fromEntries(built.graph.nodes.map((n) => [n.id, String(n.type)]))
    : {};
  const branchy = built.ok
    ? built.graph.edges.filter((e) => typeOf[e.source] === "eval" || typeOf[e.source] === "branch")
    : [];
  const handleless = branchy.filter((e) => e.sourceHandle !== "true" && e.sourceHandle !== "false");
  check(
    "every-edge-out-of-a-fork-carries-a-handle-the-canvas-knows",
    built.ok && branchy.length > 0 && handleless.length === 0,
    branchy.length === 0
      ? "이 픽스처는 갈림길을 만들지 못했습니다 — 축이 아무것도 재지 못합니다."
      : `갈림길에서 나가는 선 ${branchy.length}개 중 ${handleless.length}개가 화면이 모르는 `
        + "핸들로 나갑니다. 데이터는 이어져 있어도 사용자 눈에는 끊어져 보입니다.",
  );
}

// ── 축: 기계가 읽는 값에서는 산문에 싸인 JSON 을 꺼낸다 ────────────────────────
// 실측 2026-08-20(E3): 형식 계약을 붙였더니 모델이 `I'll read the three files.` 한 줄을
// JSON 앞에 붙여 냈다. 다음 코드가 json.loads 에 실패했고 그 실패를 삼켜 빈 목록을 냈다 —
// 첨부 3개가 그대로인데 실행은 9/9 초록에 "완료"였다.
{
  const { machineReadableValue } = await import("../dist/electron/workflow/run-graph.js");
  const { valueIsReadAsData } = await import("../dist/shared/graph-node-protocol.js");
  const dirty = "I'll read the three attachment files.\n[{\"mailId\":\"m-1\",\"note\":\"has ] and { inside\"}]";
  check(
    "prose-wrapped-json-is-recovered-for-a-machine-read-value",
    (() => { try { return JSON.parse(machineReadableValue(dirty, true))[0].mailId === "m-1"; }
             catch { return false; } })(),
    "산문 한 줄이 앞에 붙었다고 값이 통째로 못 읽는 값이 되면, 다음 코드는 빈손을 내고 "
    + "그 빈손이 초록으로 끝납니다.",
  );
  check(
    "a-value-only-people-read-is-left-as-prose",
    machineReadableValue(dirty, false) === dirty
      && machineReadableValue("3건 처리했습니다.", true) === "3건 처리했습니다.",
    "사람이 읽는 값에서 문장을 잘라내면, 보고서가 답 대신 조각이 됩니다 — 이 저장소가 "
    + "이미 겪은 \"최종 표시 정제기가 답을 편집\"과 같은 병입니다.",
  );
  check(
    "the-same-question-decides-contract-and-extraction",
    valueIsReadAsData([{ kind: "code", reads: ["x"] }], "x")
      && valueIsReadAsData([{ kind: "judgment", reads: ["y"] }], "y")
      && !valueIsReadAsData([{ kind: "prose", reads: ["z"] }], "z"),
    "저작이 계약을 붙이는 기준과 실행이 값을 꺼내는 기준이 갈리면, 한쪽은 형식을 요구하고 "
    + "다른 쪽은 그 형식을 모르는 채 값을 넘깁니다.",
  );
}

// ── 축: 검증은 자기 근거를 만드는 단계 뒤에 놓인다 ────────────────────────────
// 실측 2026-08-20(E3): "옮겼다고 한 파일이 정말 있는가"를 판정하는 검증이 근거로 삼는
// 폴더 재확인 단계보다 앞에 놓였다. 파일 3건은 정확히 정리됐는데 실행은
// NODE_INPUT_MISSING("근거로 선언된 observed 를 앞 단계가 만들어 주지 않았습니다")로
// 멈췄다 — 일은 다 하고 "했다고 말하지 못하는" 모양이고, 순서는 사용자가 정한 것이 아니라
// 컴파일러가 정한 것이라 사용자에게는 고칠 길도 없다.
{
  const { buildGraphFromBlueprint } = await import("../dist/shared/graph-blueprint.js");
  const built = buildGraphFromBlueprint({
    name: "근거 순서", goal: "판정은 근거 뒤에",
    trigger: { kind: "input", label: "시작", varName: "seed" },
    steps: [
      { kind: "code", title: "고른다", instruction: "고른다", code: "result = 1",
        codeLang: "python", effect: "read", produces: "picked", consumes: ["seed"] },
      { kind: "code", title: "옮긴다", instruction: "옮긴다", code: "result = 2",
        codeLang: "python", effect: "mutation", produces: "filed", consumes: ["picked"] },
      { kind: "code", title: "폴더를 다시 본다", instruction: "재확인", code: "result = 3",
        codeLang: "python", effect: "read", produces: "observed", consumes: [] },
      { kind: "agent", title: "요약", instruction: "요약한다", effect: "read",
        produces: "summary", consumes: ["filed"] },
    ],
    // afterStep 은 "무엇을 검증하는가"(filed), 근거는 "무엇으로"(observed) — 근거가 뒤에 있다.
    checks: [
      // 바깥으로 나가기 전에 입력을 확인하라는 규칙을 지킨다(이 축의 대상이 아니다).
      { afterStep: 0, subject: "picked", criteria: "고른 것이 있다", produces: "picked_ok" },
      { afterStep: 1, subject: "filed", criteria: "옮겼다고 한 파일이 실제로 있다",
        evidence: "observed", produces: "filecheck" },
    ],
  });
  // ★배열 순서가 아니라 **사슬**로 잰다. 노드 배열은 선언 순서라 어디에 놓든 그대로다 —
  //   실측: 배열로 재는 첫 판은 수리를 되돌려도 초록이었다(축이 아무것도 재지 못했다).
  const reaches = (from, to) => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const at = queue.shift();
      if (at === to) return true;
      for (const e of built.graph.edges) {
        if (e.source !== at || seen.has(e.target)) continue;
        seen.add(e.target);
        queue.push(e.target);
      }
    }
    return false;
  };
  const evidenceStep = built.ok
    ? built.graph.nodes.find((n) => String(n.config?.produces ?? "") === "observed")?.id
    : null;
  const filedCheck = built.ok
    ? built.graph.nodes.find((n) => String(n.config?.subject ?? "") === "filed")?.id
    : null;
  check(
    "a-check-is-placed-after-the-step-that-makes-its-evidence",
    built.ok && !!evidenceStep && !!filedCheck && reaches(evidenceStep, filedCheck),
    built.ok
      ? `근거를 만드는 ${evidenceStep} 에서 판정 ${filedCheck} 로 가는 길이 없습니다 — `
        + "판정이 근거보다 먼저 서면, 일을 다 해 놓고도 NODE_INPUT_MISSING 으로 멈춥니다."
      : "그래프가 만들어지지 않아 순서를 잴 수 없습니다.",
  );
}

try { getDb().close(); } catch { /* noop */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\ngraph-matrix 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
