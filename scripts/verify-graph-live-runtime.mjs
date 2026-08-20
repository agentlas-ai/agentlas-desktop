#!/usr/bin/env node
// 라이브 런타임 매트릭스 — **진짜 모델**로 남은 노드 종류를 채운다.
//
// verify-graph-matrix.mjs 는 모델 없이 도는 축(상태·연결·값 전달)을 66초에 지킨다.
// 그런데 노드 종류 10 중 다섯 — agent / action / eval / 바깥으로 나가는 output — 은
// 실행하려면 모델이 있어야 한다. 그 다섯을 "잘못 설정됐을 때의 거절"로만 덮어 두면
// **정상 경로가 한 번도 안 밟힌다**. 그러면 매트릭스가 초록인 채로 사용자의 자동화가
// 죽는다 — 이 저장소가 이미 여러 번 당한 모양이다.
//
// 그래서 여기서는 실제 런타임(agy / Antigravity)을 붙여 그 다섯을 끝까지 돌린다.
// 느리다(모델 호출당 수십 초). 매 빌드가 아니라 릴리즈 전에 도는 자리다.
//
// ★기존 시나리오 테스트(test-graph-scenarios.cjs)는 runMcpInvocation 을 스텁으로 갈아
//   끼운다. 그래서 런타임 계층의 결함은 구조적으로 하나도 못 잡는다. 이 파일은 그
//   반대편이다 — 스텁이 없다.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require_ = createRequire(import.meta.url);
try { new (require_("better-sqlite3"))(":memory:").close(); } catch (error) {
  console.log("SKIP graph-live-runtime — better-sqlite3 가 이 런타임의 ABI 로 빌드돼 있지 않습니다:");
  console.log("  " + String(error && error.message).split("\n")[0].slice(0, 160));
  console.log("  고치는 법: npx electron-rebuild --force --only better-sqlite3");
  process.exit(0);
}

/*
 * ★런타임이 없으면 SKIP 한다 — 그러나 **조용히는 아니다**. 이 게이트의 값어치는
 *   "진짜로 돌았다"는 사실 하나뿐이라, 안 돌았으면 그렇게 말해야 한다.
 */
/*
 * ★런타임을 하나로 못박지 않는다. 오늘 나온 결함 셋 중 둘은 "런타임마다 도구 이름이
 *   다르다"에서 나왔다(agy `list_dir` / claude `Read` / grok `read_file`). 그러니 이
 *   시험도 런타임을 갈아 끼울 수 있어야 한다 — 한 런타임에서만 초록인 것은 이 제품이
 *   반복해서 당한 모양이다(고른 런타임과 실제로 돈 런타임이 달랐던 사고 포함).
 *     AGENTLAS_LIVE_RUNTIME=codex npm run test:graph-live
 */
const RUNTIME_TABLE = {
  agy: { bin: "agy", kind: "antigravity" },
  codex: { bin: "codex", kind: "codex" },
  claude: { bin: "claude", kind: "claude-code" },
};
const RUNTIME_NAME = String(process.env.AGENTLAS_LIVE_RUNTIME || "agy").trim();
const RUNTIME = RUNTIME_TABLE[RUNTIME_NAME];
if (!RUNTIME) {
  console.error(`graph-live-runtime: 모르는 런타임 "${RUNTIME_NAME}" — 아는 것: ${Object.keys(RUNTIME_TABLE).join(", ")}`);
  process.exit(1);
}
const RUNTIME_BIN = RUNTIME.bin;
try {
  execFileSync(RUNTIME_BIN, ["--version"], { stdio: "pipe", timeout: 20_000 });
} catch (error) {
  console.log(`SKIP graph-live-runtime — ${RUNTIME_BIN} 를 이 호스트에서 실행할 수 없습니다:`);
  console.log("  " + String(error && error.message).split("\n")[0].slice(0, 160));
  console.log("  (통과로 세지 않습니다. 런타임을 붙인 뒤 다시 돌리세요.)");
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "graph-live-"));
process.env.AGENTLAS_STORE_PATH = path.join(dir, "store.sqlite");

const { setUserDataDir } = await import("../dist/electron/runtime-paths.js");
setUserDataDir(dir);

/*
 * ★모델을 실제로 부르는 경로는 보호 저장소(키체인)를 지난다. 그 앞에 "이 설치가
 *   누구인가"를 못 박는 관문이 있고, 안 박으면 요청이 모델 근처도 못 가고
 *   `Install identity refused` 로 죽는다(실측 2026-08-20, 이 시험의 두 번째 실행).
 *
 *   모델 없이 도는 매트릭스는 이 관문을 안 지나서 이 사실을 배울 수 없었다.
 *   스크래치 폴더를 QA 신원으로 박으면 이 시험은 사용자의 키체인 항목을 한 개도
 *   건드리지 않는다 — QA 신원은 keychainService 자체가 다르다.
 */
const identity = await import("../dist/electron/install-identity.js");
identity.configureInstallIdentity(identity.resolveInstallIdentity({
  packaged: false,
  qaUserDataDir: dir,
  allowQaOverride: true,
}));

const { initStore, getDb } = await import("../dist/electron/store/db.js");
initStore();
const store = await import("../dist/electron/store/automations.js");
const { runGraph: runGraphRaw } = await import("../dist/electron/workflow/run-graph.js");

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
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

// 노드마다 런타임을 못박는다 — 이 호스트의 기본 선택이 무엇이든 이 시험은 고른 것을 쓴다.
// (실측 배경: 터미널과 데스크탑이 런타임 이름을 antigravity/agy 로 갈라 부르며 고른
//  것과 다른 런타임이 돌던 사고가 있었다. 그래서 커널이 아는 이름으로 적는다.)
const RUNTIME_KIND = RUNTIME.kind;
const node = (id, type, config, label) => ({
  id, type, position: { x: 0, y: 0 }, label: label || id,
  config: { runtime: RUNTIME_KIND, ...config },
});
const edge = (source, target, extra = {}) => ({ id: `${source}->${target}`, source, target, ...extra });

const AGENT_ID = "live-agent";
getDb().prepare(
  // ★visibility 는 'private' 로 두면 안 된다 — 제품이 그것을 "웹 전용" 으로 보고
  //   getAgentById 가 null 을 돌려준다. 그러면 이 시험은 모델 근처도 못 가고
  //   "에이전트를 찾을 수 없다" 로 죽는다(실측 2026-08-20, 첫 실행).
  //   허용값은 visible / background / private 셋뿐이다(DB CHECK).
  `INSERT INTO installed_agents (id, slug, name, tagline, system_prompt, mcp_servers_json,
       trust_grade, installed_at, tone, env_requirements_json, name_en, tagline_en, builtin, visibility)
     VALUES (?, 'live-agent', '라이브용', '라이브 런타임 매트릭스 픽스처',
       '너는 지시를 그대로 따르는 도구다. 요청한 형식 밖의 말을 덧붙이지 않는다.', '[]',
       'local', ?, 'plain', '[]', 'Live', 'live runtime fixture', 0, 'visible')`,
).run(AGENT_ID, new Date().toISOString());

let seq = 0;
function saveAutomation(graph, name, permission = "write") {
  seq += 1;
  const id = `live-${seq}`;
  getDb().prepare(
    `INSERT INTO automations (id, name, schedule, target_type, target_id, prompt_template, enabled,
       created_by, created_at, graph_json, execution_permission, runtime_selection_json)
     VALUES (?, ?, 'manual', 'agent', ?, ?, 0, 'live', ?, ?, ?, ?)`,
  ).run(
    id, name ?? id, AGENT_ID, name ?? id, new Date().toISOString(),
    JSON.stringify(graph), permission, JSON.stringify({ kind: RUNTIME_KIND }),
  );
  return store.getAutomation(id);
}

const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

/* ────────────────────────────────────────────────────────────────────────────
 * ① agent 노드 — 진짜로 값을 만들고, 그 값이 다음 단계에 닿는가
 *
 * 모델 없이 도는 매트릭스는 이 칸을 못 밟는다. 그리고 이 칸이 깨지는 방식은 늘 같다:
 * 노드는 초록인데 produces 가 빈손이라 다음 단계가 NODE_INPUT_MISSING 으로 죽는다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const out = path.join(dir, "agent-out.txt");
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "topic" }),
      node("think", "agent", {
        effect: "read", consumes: "topic", produces: "answer",
        prompt: "다음 낱말을 한국어 한 단어로만 바꿔 답해라. 설명 금지. 낱말: {{topic}}",
      }, "한 단어로 바꾼다"),
      node("write", "code", {
        effect: "mutation", consumes: "answer", produces: "written", codeLang: "python",
        code: [
          "import pathlib",
          `pathlib.Path(${JSON.stringify(out)}).write_text(str(vars.get('answer','')), encoding='utf8')`,
          "result = 'ok'",
        ].join("\n"),
      }, "받은 값을 적는다"),
    ],
    edges: [edge("start", "think"), edge("think", "write")],
  };
  const run = await runGraph(saveAutomation(graph, "agent-produces"), graph, { initialVars: { topic: "apple" } });
  const written = existsSync(out) ? readFileSync(out, "utf8").trim() : "";
  check(
    "an-agent-step-really-produces-a-value",
    run.ok && written.length > 0,
    `agent 단계가 값을 못 만들었거나 다음 단계에 안 닿았습니다(적힌 값: ${JSON.stringify(written)}, `
    + `ok=${run.ok}, 사유: ${String(run.error ?? "").slice(0, 200)}).`,
  );
  console.log(`   [${elapsed()}] agent 가 만든 값: ${JSON.stringify(written.slice(0, 40))}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ② eval 노드 — 진짜로 채점하고, 통과와 불합격이 갈리는가
 *
 * 실측 배경: 여러 런타임이 판정을 **실행도 해 보지 않고** 거절해, 그 런타임을 쓰는
 * 사용자는 검증이 붙은 모든 자동화가 죽었다. 그래서 "돌긴 도는가"가 아니라
 * "옳은 것은 통과하고 틀린 것은 떨어지는가"를 본다 — 둘 다 통과하면 채점이 아니다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const evalGraph = (value) => ({
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "draft" }),
      node("judge", "eval", {
        effect: "read", subject: "draft", produces: "verdict",
        criteria: "본문이 한국어로 쓰여 있으면 통과. 한국어가 아니면 불합격.",
      }, "한국어인가"),
    ],
    edges: [edge("start", "judge")],
  });
  const good = evalGraph();
  const passRun = await runGraph(saveAutomation(good, "eval-pass"), good, {
    initialVars: { draft: "오늘 처리한 문의는 모두 열두 건입니다." },
  });
  const bad = evalGraph();
  const failRun = await runGraph(saveAutomation(bad, "eval-fail"), bad, {
    initialVars: { draft: "All twelve inquiries were handled today." },
  });
  const failCodes = Object.values(failRun.nodeFailures ?? {}).map((f) => f.code).join(",");
  check(
    "a-live-eval-actually-grades",
    passRun.ok && !failRun.ok && /EVAL_FAILED|EVAL_STUCK/.test(failCodes),
    "검증 단계가 채점을 하지 않았습니다 — 통과해야 할 것과 떨어져야 할 것이 같은 결과를 "
    + `냈습니다(통과판 ok=${passRun.ok} 사유=${String(passRun.error ?? "").slice(0, 120)} / `
    + `불합격판 ok=${failRun.ok} 사유=${failCodes || String(failRun.error ?? "").slice(0, 120)}).`,
  );
  console.log(`   [${elapsed()}] eval 통과판 ok=${passRun.ok} · 불합격판 사유=${failCodes || "없음"}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ③ action 노드 — "했다"는 말이 증거 없이 통과하지 못하는가
 *
 * 실측 2026-08-19: X 자동화가 두 런타임에서 4/4 로 끝나며 "답글 3건 게시 완료"라고
 * 적었는데 도구는 한 번도 안 불렸고 X 에는 아무것도 안 올라갔다. 산문은 증거가
 * 아니다. 도구 호출 0건이면 부수효과도 0건이므로 그 자리에서 잡아야 한다.
 *
 * ★이 시험의 모양을 두 번 고쳤다. 처음에는 "도구를 하나도 안 붙인 mutation 단계는
 *   거절돼야 한다"로 세웠는데, agy 는 한 번 거절당하자 **자기 내장 셸(run_command)로
 *   갈아타** 다시 "보냈습니다"라고 답했다. 셸은 정말로 메일을 보낼 수 있으므로 이름만
 *   보고는 거짓말인지 알 수 없다 — **제품이 지킬 수 있는 계약이 아니다.**
 *   지킬 수 있는 계약은 이것이다: 런타임이 바깥으로 나갈 수단을 **하나도 못 받은**
 *   실행에서 "했습니다"는 인정되지 않는다. 읽기 권한 자동화가 정확히 그 상태다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "target" }),
      node("send", "action", {
        effect: "mutation", consumes: "target", produces: "sent",
        prompt: "{{target}} 앞으로 안내 메일을 보내라. 보냈으면 '보냈습니다'라고만 답해라.",
      }, "메일을 보낸다"),
    ],
    edges: [edge("start", "send")],
  };
  // 읽기 권한 = 런타임에 도구를 하나도 주지 않는다. 그러면 바깥은 구조적으로 그대로다.
  const saved = saveAutomation(graph, "action-without-any-tool", "read");
  const run = await runGraph(saved, graph, { initialVars: { target: "고객센터" } });
  const codes = Object.values(run.nodeFailures ?? {}).map((f) => f.code).join(",");
  const toolRows = getDb().prepare(
    "SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = 'mcp_tool-use'",
  ).all(saved.id);
  const called = toolRows.map((r) => {
    try { return JSON.parse(r.payload_json).toolName ?? "?"; } catch { return "?"; }
  });
  /*
   * ★이 시험이 물을 수 있는 것과 없는 것을 갈라 둔다.
   *   agy 는 첫 답이 거절당하자 **자기 내장 셸(run_command)로 갈아타** 다시 "보냈습니다"
   *   라고 답했다. 셸은 정말로 메일을 보낼 수 있으므로, 이름만 보고 거짓말인지 아는 것은
   *   이 계층에서 **원리적으로 불가능하다**(제품 규칙 #2 의 "필요 도구 실재 사전 검사"가
   *   붙기 전까지는). 그래서 "끝내 거절됐는가"는 묻지 않는다.
   *
   *   물을 수 있는 것: **보호가 실제로 발화했는가.** 산문만 보고 첫 답을 그대로 성공으로
   *   적으면 안 된다 — X 자동화가 4/4 로 "게시 완료"라고 적고 아무것도 안 올린 그 사고다.
   */
  const caught = getDb().prepare(
    "SELECT COUNT(*) AS n FROM run_events WHERE automation_id = ? AND node_id = 'send'"
      + " AND (kind = 'workflow_node_retry' OR payload_json LIKE '%NODE_CLAIMED_WITHOUT_TOOLS%')",
  ).get(saved.id).n;
  check(
    "a-claim-with-no-real-tool-call-is-caught",
    caught > 0,
    "도구를 하나도 안 부른 mutation 단계의 '보냈습니다'가 **한 번도 걸리지 않고** 그대로 "
    + `성공했습니다 — 산문이 증거로 통과했습니다(ok=${run.ok}, 사유: ${codes || "없음"}).`,
  );
  console.log(`   [${elapsed()}] action 사유: ${codes || "없음"} · 부른 도구: ${called.join(", ") || "없음"}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ③-b 읽기 전용 도구만 부른 것은 증거가 아닌가
 *
 * 실측 2026-08-20 (이 파일의 첫 실행): 도구 없는 "메일 보내기" 단계가 `ok:true` 로
 * 끝났고, 그 실행이 부른 것은 `list_dir` 두 번과 호스트 예비 조회뿐이었다. 읽기만 한
 * 도구가 발송의 증거로 쓰였다 — shared/tool-activity 가 자기만의 10개짜리 손목록을
 * 들고 정본 분류표에 묻지 않았기 때문이다.
 *
 * 여기서는 **관측된 도구 이름**으로 그 규칙을 직접 잰다. 모델이 무엇을 고르든,
 * 읽기·검색·조회로 분류되는 이름은 "일했다"의 근거로 세어지면 안 된다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const { couldHaveChangedTheOutsideWorld } = await import("../dist/shared/tool-activity.js");
  // 이 저장소가 파는 런타임들의 **실제** 읽기 도구 이름이다(분류표 주석의 실측 목록).
  const readOnlyNames = [
    "Read", "Grep", "Glob",                    // claude
    "list_dir", "read_file",                   // grok
    "view_file", "codebase_search",            // agy
    "WebFetch", "WebSearch",                   // 공통
    "Agentlas Plugins · Hub bridge",           // 호스트 예비 조회
  ];
  const leaked = readOnlyNames.filter((name) => couldHaveChangedTheOutsideWorld(name));
  check(
    "read-only-tools-never-prove-that-work-happened",
    leaked.length === 0,
    `읽기 전용 도구가 "일했다"의 증거로 세어집니다: ${leaked.join(", ")} — 읽기만 한 실행이 `
    + "발송·저장을 했다고 보고합니다(런타임마다 이름이 달라 손목록으로는 못 따라갑니다).",
  );
  const realWork = ["write_to_file", "run_command", "Bash", "Edit", "gmail__send_message"];
  const missed = realWork.filter((name) => !couldHaveChangedTheOutsideWorld(name));
  check(
    "real-work-still-counts-as-work",
    missed.length === 0,
    `진짜로 일한 도구가 증거로 안 세어집니다: ${missed.join(", ")} — 규칙을 좁히다 오폭하면 `
    + "정상 자동화가 전부 거짓 실패합니다.",
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ④ 재개가 이미 끝난 agent 단계를 다시 부르지 않는가 — 돈이 걸린 칸
 *
 * 빠른 매트릭스도 재개를 지키지만, 거기서 다시 도는 것은 code 노드라 공짜다.
 * agent 단계를 다시 부르면 사용자는 **같은 호출 값을 두 번 낸다**. 그리고 그
 * 낭비는 모델이 붙은 경로에서만 재현된다 — 토큰을 실제로 써봐야 셀 수 있기 때문이다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "topic" }),
      node("think", "agent", {
        effect: "read", consumes: "topic", produces: "answer",
        prompt: "다음 낱말을 한국어 한 단어로만 바꿔 답해라. 설명 금지. 낱말: {{topic}}",
      }, "한 단어로 바꾼다"),
      node("boom", "code", {
        effect: "read", consumes: "answer", produces: "never", codeLang: "python",
        code: "raise RuntimeError('crash after the model already answered')",
      }, "답을 받은 뒤 죽는다"),
    ],
    edges: [edge("start", "think"), edge("think", "boom")],
  };
  const saved = saveAutomation(graph, "resume-does-not-recall-the-model");
  const first = await runGraph(saved, graph, { initialVars: { topic: "apple" } });
  const callsFor = () => getDb().prepare(
    "SELECT COUNT(*) AS n FROM run_events WHERE automation_id = ? AND node_id = 'think'"
      + " AND kind IN ('mcp_invocation','workflow_node_start','mcp_tool-use')",
  ).get(saved.id).n;
  const afterFirst = callsFor();
  const firstTokens = Number(first.tokensUsed ?? 0);
  check(
    "a-live-agent-step-really-ran-before-the-crash",
    !first.ok && firstTokens > 0,
    `모델이 답한 뒤 죽는 상황을 못 만들었습니다(ok=${first.ok}, 토큰=${firstTokens}) — 이 시험이 재개 낭비를 못 잽니다.`,
  );

  const resumed = await runGraph(store.getAutomation(saved.id), graph, { initialVars: { topic: "apple" } });
  const resumeTokens = Number(resumed.tokensUsed ?? 0);
  check(
    "a-resume-does-not-pay-the-model-twice",
    resumeTokens === 0,
    `재개가 이미 끝난 agent 단계를 다시 불렀습니다(재개 토큰 ${resumeTokens}) — 사용자는 같은 호출 값을 `
    + `두 번 냅니다(첫 실행 ${firstTokens} 토큰, 불린 횟수 ${afterFirst}→${callsFor()}).`,
  );
  console.log(`   [${elapsed()}] 토큰: 첫 실행 ${firstTokens} · 재개 ${resumeTokens}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑤ 발행할 도구가 없는 출력 — 거절은 옳다. 그러나 **잠그면 안 된다**.
 *
 * 출력 노드는 "바깥으로 내보내기"다(레지스트리 선언). 발행 도구가 하나도 없는 실행에서
 * 모델이 "올렸습니다"라고 답하면 그건 거짓이고, 거절이 옳다.
 *
 * ★문제는 그 다음이었다. 실측 2026-08-20 (agy 라이브, 2회 중 1회):
 *     automation_ambiguous_side_effect: out may have committed an external action
 *   도구를 하나도 안 불렀는데 "바깥에 나갔을지도 모른다"로 굳어 자동화가 잠겼다.
 *   통과와 잠김을 가른 것은 그 턴에 모델이 우연히 `list_dir` 을 불렀는지였다 —
 *   읽기 전용 도구가 "나갔을 수도 있다"로 세어졌기 때문이다(shared/tool-activity 수리).
 *
 *   호출 0건은 부수효과 0건이다. 그러면 다시 시도하는 것이 안전하고, 사람이 손대지
 *   않아도 다음 실행이 그대로 돌아야 한다. 거절만 있고 문이 없으면 영구 잠김이다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const graph = {
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("out", "output", { text: "영업 12 / 개발 30 / 지원 8", produces: "published" }, "바깥으로 내보낸다"),
    ],
    edges: [edge("start", "out")],
  };
  const saved = saveAutomation(graph, "publish-without-a-publishing-tool", "read");
  const first = await runGraph(saved, graph, { initialVars: { seed: "go" } });
  const second = await runGraph(store.getAutomation(saved.id), graph, { initialVars: { seed: "go" } });
  const secondWhy = String(second.error ?? "") + JSON.stringify(second.nodeFailures ?? {});
  const publishCaught = getDb().prepare(
    "SELECT COUNT(*) AS n FROM run_events WHERE automation_id = ? AND node_id = 'out'"
      + " AND (kind = 'workflow_node_retry' OR payload_json LIKE '%NODE_CLAIMED_WITHOUT_TOOLS%')",
  ).get(saved.id).n;
  check(
    "publishing-with-no-tool-is-caught-at-least-once",
    publishCaught > 0,
    "발행 도구가 하나도 없는데 출력 단계의 '올렸습니다'가 한 번도 안 걸렸습니다 — "
    + `글은 안 올라가는데 초록불입니다(1회차 ok=${first.ok}).`,
  );
  check(
    "a-refused-publish-does-not-lock-the-automation",
    !/ambiguous_side_effect|reconciliation_pending|partial_graph_changed/.test(secondWhy),
    "도구를 한 번도 안 불러 바깥이 그대로인데 '나갔을지도 모른다'로 굳어 자동화가 잠겼습니다 — "
    + `사람이 재조정하기 전까지 이 자동화는 영영 안 돕니다(2회차 사유: ${secondWhy.slice(0, 200)}).`,
  );
  console.log(`   [${elapsed()}] 발행 1회차 ok=${first.ok} · 2회차 사유=${secondWhy.slice(0, 90)}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑥ 짓다 막혔을 때 **이어갈 길이 나오는가** (오너 지시 2026-08-20)
 *
 * 저장 전에 돌려 봤는데 안 되면, 지금까지는 문장 한 줄로 끝났다. 오너의 말:
 *   *"50% 정도 완성하다 실패를 했을 때도 이어갈 수 있어야지, 대안을 제시한다거나."*
 *
 * 그리고 막히는 이유는 두 갈래다 — **내가 고칠 수 있는 것**과 **사람만 가진 것이
 * 필요한 것**. 그 판단은 하드코딩된 조건문이 아니라 모델이 해야 하므로, 여기서만
 * 잴 수 있다. 둘이 **같은 답을 내면** 그건 판단이 아니라 상수다.
 * ──────────────────────────────────────────────────────────────────────────── */
{
  const { planGraphBuildRecovery, blockedStepFactsFrom } =
    await import("../dist/electron/workflow/build-recovery.js");

  const draft = (label, prompt, code) => ({
    version: 1,
    nodes: [
      node("start", "trigger", { kind: "input", produces: "seed" }),
      node("upstream", "agent", { effect: "read", produces: "payload", prompt }, label),
      node("downstream", "code", {
        effect: "read", consumes: "payload", produces: "rows", codeLang: "python", code,
      }, "그 값을 표로 만든다"),
    ],
    edges: [edge("start", "upstream"), edge("upstream", "downstream")],
  });
  const planFor = async (graph, goal, sample) => planGraphBuildRecovery({
    graph,
    goal,
    blocked: blockedStepFactsFrom({
      graph,
      nodeId: "downstream",
      label: "그 값을 표로 만든다",
      cause: "TypeError: string indices must be integers",
      availableVars: ["seed", "payload"],
      upstreamSample: sample,
    }),
    ranBefore: ["앞 단계"],
  });

  // ㉮ 값의 형식이 안 맞는다 — 호스트가 혼자 고칠 수 있어야 한다.
  const fixable = await planFor(
    draft("메일을 읽고 정리한다", "메일을 읽고 각 요청을 정리해라", "rows = vars.get('payload')['items']\nresult = rows"),
    "매일 메일을 확인해 미팅 요청을 정리한다",
    "## 정리\n\n| 보낸 사람 | 요청 |\n|---|---|\n| lee@haneul.kr | 미팅 |",
  );
  const fixableKinds = fixable.options.map((o) => o.kind);
  check(
    "a-fixable-build-block-is-fixed-not-handed-back",
    !fixable.unavailable && fixableKinds.includes("repair_step"),
    "앞 단계가 넘긴 값의 **형식**이 안 맞는 것은 호스트가 혼자 고칠 수 있는 부류인데 "
    + `그 길을 안 냈습니다 — 사용자가 대신 고쳐야 합니다(고른 것: ${JSON.stringify(fixableKinds)}, `
    + `요약: ${String(fixable.summary).slice(0, 120)}).`,
  );

  // ㉯ 로그인 벽 — 사람만 가진 것이 필요하다. 혼자 고치겠다고 하면 안 된다.
  const needsPerson = await planFor(
    draft("가격 페이지를 연다", "https://competitor.example/pricing 을 열어 가격을 읽어라", "rows = vars.get('payload')['prices']\nresult = rows"),
    "10분마다 경쟁사 가격 페이지를 열어 변경을 기록한다",
    "Sign in to continue. You must be logged in to view pricing for your plan.",
  );
  const personKinds = needsPerson.options.map((o) => o.kind);
  check(
    "a-block-only-a-person-can-clear-asks-the-person",
    !needsPerson.unavailable
      && (needsPerson.question !== null || personKinds.some((k) => k !== "repair_step"))
      && !(personKinds.length === 1 && personKinds[0] === "repair_step"),
    "로그인 벽에 막혔는데 혼자 고치겠다고 합니다 — 사람만 가진 것이 필요한 부류를 "
    + `못 가릅니다(고른 것: ${JSON.stringify(personKinds)}, 질문: ${JSON.stringify(needsPerson.question)}).`,
  );

  // ★두 상황이 같은 답을 내면 그건 판단이 아니라 상수다.
  check(
    "the-two-kinds-of-block-get-different-answers",
    JSON.stringify(fixableKinds) !== JSON.stringify(personKinds),
    `서로 다른 두 막힘에 **같은 조치**를 냈습니다(${JSON.stringify(fixableKinds)}) — `
    + "원인을 안 보고 정해진 답을 내고 있다는 뜻입니다.",
  );

  // ★어떤 경우에도 만든 것이 날아가지 않는다.
  check(
    "the-half-built-graph-can-always-be-kept",
    [...fixable.options, ...needsPerson.options].some((o) => o.kind === "save_switched_off")
      || fixableKinds.includes("repair_step"),
    "막힌 두 경우 어디에도 '지금 상태로 저장(꺼둠)'이 없습니다 — 50% 만든 것이 날아가면 "
    + "사용자는 처음부터 다시 해야 합니다.",
  );

  console.log(`   [${elapsed()}] 고칠 수 있는 막힘 → ${JSON.stringify(fixableKinds)}`);
  console.log(`   [${elapsed()}] 사람이 필요한 막힘 → ${JSON.stringify(personKinds)} · 질문=${needsPerson.question ? "있음" : "없음"}`);
}

try { getDb().close(); } catch { /* noop */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }

if (failures.length > 0) {
  console.error(`\ngraph-live-runtime 실패 (${RUNTIME_BIN}, ${elapsed()}):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed (${RUNTIME_BIN}, ${elapsed()})`);
