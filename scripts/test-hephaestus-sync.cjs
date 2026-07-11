#!/usr/bin/env node
// hephaestus-sync 계약 테스트 (hermetic) — 임시 DB + 합성 networking 홈.
//
// 검증하는 계약(엔진 agentlas_cloud/networking/desktop_sync.py와 쌍):
//   1) trusted local/* + 유효 절대경로 ref 카드만 임포트된다
//      (routing_ready 포지 카드·상대경로 ref는 절대 임포트 금지 — 라이브러리 홍수 방지).
//   2) pending 큐 항목은 임포트 후 done/으로 이동하고 content_hash를 보존한다
//      (엔진이 done 해시로 같은 카드 재큐잉을 멈춘다).
//   3) 재드레인은 전부 skip — 중복 행이 생기지 않는다(경로 멱등).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-heph-sync-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

function writeFile(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
}
function writeJson(p, obj) {
  writeFile(p, JSON.stringify(obj, null, 2));
}
function makePackage(name, title) {
  const dir = path.join(tempDir, "packages", name);
  writeFile(path.join(dir, "AGENT.md"), `# ${title}\n\nSynthetic package for hephaestus-sync test.\n`);
  writeJson(path.join(dir, "agentlas.json"), { slug: name, name: title });
  return dir;
}

(async () => {
  let exitCode = 0;
  try {
    const { initStore, getDb } = require("../dist/electron/store/db.js");
    initStore();

    const home = path.join(tempDir, "networking");
    process.env.AGENTLAS_NETWORKING_HOME = home;

    const trustedPkg = makePackage("sync-proof-agent", "Sync Proof Agent");
    const queuedPkg = makePackage("sync-proof-queued", "Sync Proof Queued");
    const noisePkg = makePackage("sync-proof-noise", "Sync Proof Noise");

    // 자격: trusted local/* + 절대경로 ref
    writeJson(path.join(home, "cards/agents/local-sync-proof-agent.json"), {
      id: "local/sync-proof-agent", type: "agent", routing_status: "trusted",
      source: { kind: "local_path", ref: trustedPkg },
    });
    // 미자격: routing_ready(포지 실험) — 임포트 금지
    writeJson(path.join(home, "cards/agents/free-sync-proof-noise.json"), {
      id: "free/sync-proof-noise", type: "agent", routing_status: "routing_ready",
      source: { kind: "local_path", ref: noisePkg },
    });
    // 미자격: 상대경로 ref
    writeJson(path.join(home, "cards/teams/local-dot.json"), {
      id: "local/dot", type: "team", routing_status: "trusted",
      source: { kind: "local_path", ref: "." },
    });
    // 엔진 pending 큐 항목
    writeJson(path.join(home, "desktop-sync/pending/local-sync-proof-queued.json"), {
      id: "local/sync-proof-queued", type: "agent", ref: queuedPkg,
      content_hash: "deadbeef", enqueued_at: "2026-01-01T00:00:00+00:00",
    });

    const sync = require("../dist/electron/agents/hephaestus-sync.js");
    const first = await sync.drainHephaestusSync();
    assert.deepEqual(first.failed, [], "no failures expected");
    assert.ok(first.imported.includes(path.resolve(trustedPkg)), "trusted card imported via cards scan");
    assert.ok(first.imported.includes(path.resolve(queuedPkg)), "queue entry imported");
    assert.equal(first.imported.length, 2, "noise/relative-ref cards must NOT import");

    const slugs = getDb().prepare("SELECT slug FROM installed_agents ORDER BY slug").all().map((r) => r.slug);
    assert.equal(slugs.length, 2, `expected 2 rows, got: ${slugs.join(", ")}`);

    // pending → done 이동 + content_hash 보존
    assert.ok(!fs.existsSync(path.join(home, "desktop-sync/pending/local-sync-proof-queued.json")));
    const done = JSON.parse(
      fs.readFileSync(path.join(home, "desktop-sync/done/local-sync-proof-queued.json"), "utf8"),
    );
    assert.equal(done.content_hash, "deadbeef", "done entry keeps engine content_hash");
    assert.equal(done.status, "imported");

    // 재드레인 = 전부 skip, 행 수 불변
    const second = await sync.drainHephaestusSync();
    assert.equal(second.imported.length, 0, "second drain imports nothing");
    // 드레인된 큐 항목은 done/으로 사라졌으므로 재드레인에서 보이는 건 카드 기반 1건뿐.
    assert.equal(second.skipped, 1, "card-discovered package skipped as already routed");
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM installed_agents").get().n;
    assert.equal(count, 2, "no duplicate rows on re-drain");

    console.log("test-hephaestus-sync: PASS");
  } catch (err) {
    exitCode = 1;
    console.error("test-hephaestus-sync: FAIL", err);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  }
})();
