/*
 * 게이트 — 자동화 편집기는 **그 자동화가 이미 쓰고 있는 대상**을 후보에서 빼지 않는다.
 *
 * 실측 2026-08-21 (캠페인 E3 4단계): 말로 만든 그래프 자동화의 대상은 빌더가 붙인
 * builtin-agentlas-orchestrator 이고 visibility=background 라 목록에서 걸러졌다.
 * 그래서 자기 편집기가 "No valid target is selected" 로 저장을 막았고, 빌더가 만든
 * 자동화 전부가 이름·일정을 못 고쳤다 — 10분 주기로 켜는 데까지 도달할 수 없었다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, "renderer/lib/agent-visibility.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const checks = [];
const failures = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

const hidden = { id: "builtin-agentlas-orchestrator", name: "Orchestrator", visibility: "background" };
const normal = { id: "agent-1", name: "Writer", visibility: "public" };
const visible = mod.visibleAgents([hidden, normal]);

check(
  "a-background-agent-is-still-hidden-when-choosing-fresh",
  !visible.some((a) => a.id === hidden.id) && visible.some((a) => a.id === normal.id),
  "새로 고를 때의 숨김 규칙이 사라지면 시스템 에이전트가 선택지에 쏟아집니다.",
);
check(
  "an-automation-can-always-see-the-target-it-already-uses",
  mod.withCurrentTarget(visible, [hidden, normal], "agent", hidden.id)
    .some((a) => a.id === hidden.id),
  "자기 대상이 후보에 없으면 편집기가 자기 자신을 \"유효한 대상 없음\"으로 막습니다 — "
  + "일정 하나 바꾸려고 실행 주체를 바꿔야 합니다.",
);
check(
  "it-does-not-duplicate-a-target-that-is-already-listed",
  mod.withCurrentTarget(visible, [hidden, normal], "agent", normal.id).length === visible.length,
  "이미 보이는 대상을 또 넣으면 같은 항목이 두 번 나옵니다.",
);
check(
  "a-firm-or-hub-target-is-left-alone",
  mod.withCurrentTarget(visible, [hidden, normal], "firm", "some-firm").length === visible.length
    && mod.withCurrentTarget(visible, [hidden, normal], "hub", "slug").length === visible.length,
  "에이전트 목록에 회사·허브 대상을 끼워 넣으면 안 됩니다.",
);

const page = readFileSync(path.join(root, "renderer/app/(shell)/automation/new/page.tsx"), "utf8");
check(
  "the-editor-actually-calls-it",
  /withCurrentTarget\(\s*visible/.test(page),
  "규칙을 만들어 놓고 화면이 안 쓰면 사용자에게는 아무것도 바뀌지 않습니다 — "
  + "이 저장소가 이미 이름 붙인 \"마지막 칸까지 연결\" 규칙입니다.",
);

if (failures.length > 0) {
  console.error("\neditor-keeps-its-target 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
