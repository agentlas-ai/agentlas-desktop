#!/usr/bin/env node
// 그래프 편성 default-runner 폴백 게이트 (2026-08-09).
//
// 인터뷰로 만든 그래프의 AGENT 노드가 특화 에이전트도 Hub도 못 찾으면 no-runner로
// 멈춰 "만들었는데 안 도는" 그래프가 됐다(실측: HN 요약 그래프 1/7 정지). 자동화가
// 이미 소유한 상주 오케스트레이터를 기본 러너로 채워 그래프가 돌게 한다. 이 게이트는
// ①폴백 채움 ②폴백 없으면 종전 unresolved ③특화 매치가 폴백보다 우선 을 강제한다.
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "graph-staffing-gate-"));
const rel = "../electron/workflow/graph-staffing.ts";
const test = `
import { staffGraph, applyStaffing } from ${JSON.stringify(join(process.cwd(), "electron/workflow/graph-staffing.ts"))};
const graph = { nodes: [
  { id: "trigger", type: "trigger", config: {} },
  { id: "sum", type: "agent", config: { role: "한국어 요약가", roleEn: "korean summarizer" } },
  { id: "save", type: "action", config: { role: "파일 저장", roleEn: "file writer" } },
], edges: [] };
const run = (opts) => staffGraph(graph, { installed: opts.installed || [], searchHub: async () => [], judgeFit: async () => "fail", ...(opts.defaultRunnerRef ? { defaultRunnerRef: opts.defaultRunnerRef, defaultRunnerLabel: opts.defaultRunnerLabel } : {}) });
const A = await run({ defaultRunnerRef: "builtin-agentlas-orchestrator", defaultRunnerLabel: "Orchestrator" });
const a = A.filter(s => ["sum","save"].includes(s.nodeId));
if (!(a.length === 2 && a.every(s => s.ref === "builtin-agentlas-orchestrator" && s.source === "default-runner"))) throw new Error("A: fallback not filled");
if (applyStaffing(graph, A).nodes.find(n=>n.id==="sum").config.ref !== "builtin-agentlas-orchestrator") throw new Error("A: not applied");
const B = await run({});
if (!B.filter(s => ["sum","save"].includes(s.nodeId)).every(s => s.ref === null && s.source === "unresolved")) throw new Error("B: regression");
const C = await run({ installed: [{ id: "korean-agent", name: "korean summarizer pro" }], defaultRunnerRef: "builtin-agentlas-orchestrator" });
const sum = C.find(s=>s.nodeId==="sum");
if (!(sum.ref === "korean-agent" && sum.source === "installed")) throw new Error("C: specialist not preferred");
console.log("PASS verify-graph-staffing-fallback");
`;
const f = join(dir, "t.mjs");
writeFileSync(f, test);
try {
  execSync(`npx tsx ${f}`, { stdio: "inherit", cwd: process.cwd() });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
