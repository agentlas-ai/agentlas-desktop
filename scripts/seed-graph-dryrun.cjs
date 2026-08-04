#!/usr/bin/env node
/*
 * M4 시드 0호 도그푸딩 — 실제 Threads 자동화를 **시뮬레이션**으로 돌린다.
 * 외부로 나가는 변경은 커널이 막고, 무엇이 막혔는지 영수증으로 남긴다.
 * 사용자 실DB는 건드리지 않는다(격리 사본에서 실행).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m4-seed-"));
const real = path.join(os.homedir(), "Library/Application Support/Agentlas/agentlas.sqlite");
const copy = path.join(tmp, "agentlas.sqlite");
fs.copyFileSync(real, copy);
process.env.AGENTLAS_STORE_PATH = copy;
app.setPath("userData", path.join(tmp, "user-data"));

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { getAutomation } = require("../dist/electron/store/automations.js");
const { runGraph } = require("../dist/electron/workflow/run-graph.js");

(async () => {
  let code = 0;
  try {
    initStore();
    const row = getDb().prepare(
      "SELECT id, name FROM automations WHERE name LIKE '%Threads%' ORDER BY name LIMIT 1",
    ).get();
    if (!row) throw new Error("Threads 자동화를 찾지 못했습니다.");
    console.log(`SEED: ${row.name}`);
    const automation = getAutomation(row.id);
    const graph = automation.graph;
    console.log(`NODES: ${graph.nodes.map((n) => `${n.type}:${n.label || n.id}`).join(" → ")}`);

    // 폭주 방지 — 노드마다 상한을 걸어 둔다(시뮬레이션이라도 실제 조회는 돈다).
    const bounded = {
      ...graph,
      nodes: graph.nodes.map((n) => ({
        ...n,
        config: { ...(n.config || {}), timeoutSeconds: Number(process.env.M4_NODE_TIMEOUT || 240) },
      })),
    };

    const started = Date.now();
    const result = await runGraph(automation, bounded, {
      runId: `m4-seed-dryrun-${Date.now()}`,
      dryRun: true,
      sink: (ev) => {
        if (ev.nodeState) console.log(`  · ${ev.nodeId}: ${ev.nodeState}`);
      },
    });
    console.log("---- DRY-RUN RECEIPT ----");
    console.log("ok:", result.ok, "| dryRun:", result.dryRun, `| ${Math.round((Date.now() - started) / 1000)}s`);
    console.log("tokensUsed:", result.tokensUsed);
    console.log("blocked (실전이었으면 나갔을 것):", JSON.stringify(result.dryRunBlocks ?? [], null, 2));
    if (result.nodeFailures) {
      for (const [nodeId, f] of Object.entries(result.nodeFailures)) {
        console.log(`FAILURE ${nodeId}: [${f.code}] ${f.reason}`);
        console.log(`  → ${f.nextAction}`);
      }
    }
    for (const [nodeId, text] of Object.entries(result.outputs ?? {})) {
      console.log(`OUTPUT ${nodeId}: ${String(text).replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } catch (err) {
    code = 1;
    console.error("SEED FAILED:", err instanceof Error ? err.message : err);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    app.exit(code);
  }
})();
