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
try { require_("better-sqlite3"); } catch (error) {
  console.log("SKIP graph-matrix — better-sqlite3 가 이 Node 의 ABI 로 빌드돼 있지 않습니다:");
  console.log("  " + String(error && error.message).split("\n")[0].slice(0, 160));
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

try { getDb().close(); } catch { /* noop */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\ngraph-matrix 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
