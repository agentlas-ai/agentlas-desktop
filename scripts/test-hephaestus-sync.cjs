#!/usr/bin/env node
// hephaestus-sync 계약 테스트 (hermetic) — 임시 DB + 합성 networking 홈.
//
// 검증하는 계약(엔진 agentlas_cloud/networking/desktop_sync.py와 쌍):
//   0) 고정 Agentlas OS의 card_store.save_card가 실제 pending 항목을 생산한다
//   1) trusted local/* + 유효 절대경로 ref 카드만 임포트된다
//      (routing_ready 포지 카드·상대경로 ref는 절대 임포트 금지 — 라이브러리 홍수 방지).
//   2) pending 큐 항목은 임포트 후 done/으로 이동하고 content_hash를 보존한다
//      (엔진이 done 해시로 같은 카드 재큐잉을 멈춘다).
//   3) 재드레인은 전부 skip — 중복 행이 생기지 않는다(경로 멱등).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

function resolvePython() {
  const candidates = [
    process.env.HEPHAESTUS_PYTHON,
    ...(process.platform === "win32" ? ["python", "py"] : ["python3", "python"]),
  ].filter(Boolean);
  for (const command of candidates) {
    const prefix = command === "py" ? ["-3"] : [];
    const probe = spawnSync(command, [...prefix, "-c", "import sys; print(sys.version_info[:2])"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (probe.status === 0) return { command, prefix };
  }
  throw new Error("Python 3 is required for the Agentlas OS desktop-sync producer contract");
}

function enqueueWithPinnedAgentlasOs(home, packageRef) {
  const engineRoot = path.resolve(
    process.env.HEPHAESTUS_DIR || path.join(__dirname, "..", "Hephaestus"),
  );
  const producer = path.join(engineRoot, "agentlas_cloud", "networking", "desktop_sync.py");
  assert.ok(fs.existsSync(producer), `pinned Agentlas OS desktop-sync producer is missing: ${producer}`);
  const { command, prefix } = resolvePython();
  const source = [
    "import sys",
    "from pathlib import Path",
    "from agentlas_cloud.networking.card_store import save_card",
    "home = Path(sys.argv[1])",
    "ref = Path(sys.argv[2])",
    "card = {",
    "  'id': 'local/sync-proof-queued',",
    "  'type': 'agent',",
    "  'name': 'Sync Proof Queued',",
    "  'routing_status': 'trusted',",
    "  'source': {'kind': 'local_path', 'ref': str(ref)},",
    "}",
    "print(save_card(home, card))",
  ].join("\n");
  const result = spawnSync(command, [...prefix, "-c", source, home, packageRef], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: [engineRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  });
  assert.equal(
    result.status,
    0,
    `Agentlas OS card_store.save_card producer failed:\n${result.stderr || result.stdout}`,
  );
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
    // 실제 고정 Agentlas OS producer 경로: card_store.save_card가 desktop_sync.py를
    // 호출해 pending 항목과 canonical content_hash를 만든다.
    enqueueWithPinnedAgentlasOs(home, queuedPkg);
    const pendingPath = path.join(home, "desktop-sync/pending/local-sync-proof-queued.json");
    const produced = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    assert.equal(produced.origin, "hephaestus/card-store");
    assert.equal(path.resolve(produced.ref), path.resolve(queuedPkg));
    assert.match(produced.content_hash, /^[a-f0-9]{64}$/, "producer must emit a canonical content hash");
    assert.ok(
      fs.existsSync(path.join(home, "cards/agents/local-sync-proof-queued.json")),
      "card_store.save_card must persist the source card before enqueueing",
    );

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
    assert.equal(done.content_hash, produced.content_hash, "done entry keeps the exact Agentlas OS content_hash");
    assert.equal(done.status, "imported");

    // 재드레인 = 전부 skip, 행 수 불변
    const second = await sync.drainHephaestusSync();
    assert.equal(second.imported.length, 0, "second drain imports nothing");
    // 드레인된 큐 항목은 done/으로 사라지지만, 실제 producer가 저장한 source card와
    // 수동 fixture card 두 건은 모두 남는다. 둘 다 기존 route로 멱등 skip되어야 한다.
    assert.equal(second.skipped, 2, "all card-discovered packages skip as already routed");
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
