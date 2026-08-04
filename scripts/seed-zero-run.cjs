/*
 * 시드 0호 도그푸딩 — 「Agentlas 일일 요약 (시드)」를 격리 DB 사본에서 완주시킨다.
 *
 * 이 시드는 바깥으로 나가는 단계가 없다(전부 effect: read). 그래서 실전 실행도 안전하고,
 * SEED_LIVE=1 없이 돌리면 시뮬레이션으로 한 번 더 확인한다.
 * 실 DB는 읽기만 한다 — 제품 DB를 쓰기로 열면 고아 -wal이 남아 앱 업데이트를 막은 전례가 있다.
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { app } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed0-"));
// WAL 모드라 최근 쓰기는 -wal에 있다. 본 파일만 복사하면 방금 만든 행이 안 보인다.
// 제품 DB를 쓰기로 열어 체크포인트하는 것은 금지(고아 -wal이 앱 업데이트를 막은 전례) —
// 동반 파일을 함께 복사한다.
const realBase = path.join(os.homedir(), "Library/Application Support/Agentlas/agentlas.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  const src = `${realBase}${suffix}`;
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, `agentlas.sqlite${suffix}`));
}
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));
const { initStore, getDb } = require("../dist/electron/store/db.js");
const { getAutomation } = require("../dist/electron/store/automations.js");
const { runGraph } = require("../dist/electron/workflow/run-graph.js");
(async () => {
  let code = 0;
  try {
    initStore();
    const row = getDb().prepare("SELECT id, name FROM automations WHERE name = ?").get("Agentlas 일일 요약 (시드)");
    if (!row) throw new Error("시드를 찾지 못했습니다.");
    const a = getAutomation(row.id);
    console.log("SEED:", a.name, "|", a.graph.nodes.map((n) => n.label || n.id).join(" → "));
    const started = Date.now();
    const res = await runGraph(a, a.graph, {
      runId: `seed0-${Date.now()}`,
      ...(process.env.SEED_LIVE === '1' ? {} : { dryRun: true }),
      sink: (ev) => { if (ev.nodeState) console.log(`  · ${ev.nodeId}: ${ev.nodeState}`); },
    });
    console.log("---- RECEIPT ----");
    console.log("ok:", res.ok, "| dryRun:", res.dryRun, `| ${Math.round((Date.now() - started) / 1000)}s | tokens:`, res.tokensUsed);
    console.log("blocked:", JSON.stringify(res.dryRunBlocks ?? []));
    for (const [id, f] of Object.entries(res.nodeFailures ?? {})) console.log(`FAIL ${id}: [${f.code}] ${f.reason}`);
    const summary = res.vars?.summary;
    if (summary) console.log("SUMMARY:", String(summary).replace(/\s+/g, " ").slice(0, 300));
  } catch (err) {
    code = 1;
    console.error("SEED RUN FAILED:", err instanceof Error ? err.message : err);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    app.exit(code);
  }
})();
