#!/usr/bin/env node
// 전역 실행 슬롯(run-slots) 회귀 테스트 — 큐잉/해제/abort/한도 반영.
// 실행: npm run build:electron && electron scripts/test-run-slots.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-run-slots-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

const { initStore } = require("../dist/electron/store/db.js");
const { setAgentConcurrency } = require("../dist/electron/store/concurrency.js");
const { acquireRunSlot, runSlotStats } = require("../dist/electron/runtime/run-slots.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  initStore();

  // 1) 한도 1 — 첫 획득 즉시, 두 번째는 큐잉, 해제 시 승계
  setAgentConcurrency(1);
  const r1 = await acquireRunSlot();
  assert.deepEqual(runSlotStats(), { inUse: 1, queued: 0, limit: 1 });
  let secondResolved = false;
  const p2 = acquireRunSlot().then((rel) => {
    secondResolved = true;
    return rel;
  });
  await sleep(50);
  assert.equal(secondResolved, false, "한도 초과 획득은 대기해야 함");
  assert.equal(runSlotStats().queued, 1);
  r1(); // 해제 → 승계
  const r2 = await p2;
  assert.equal(secondResolved, true);
  assert.deepEqual(runSlotStats(), { inUse: 1, queued: 0, limit: 1 });

  // 2) 해제 멱등 — 중복 호출해도 inUse가 음수로 안 감
  r2();
  r2();
  assert.equal(runSlotStats().inUse, 0);

  // 3) abort — 대기 중 이탈
  setAgentConcurrency(1);
  const rA = await acquireRunSlot();
  const ctrl = new AbortController();
  const pAbort = acquireRunSlot(ctrl.signal);
  await sleep(20);
  ctrl.abort();
  await assert.rejects(pAbort, (e) => e.name === "AbortError");
  assert.equal(runSlotStats().queued, 0, "abort된 대기자는 큐에서 제거");
  rA();

  // 4) 한도 상향 즉시 반영 — 대기자들이 새 한도만큼 동시 승계
  setAgentConcurrency(1);
  const rB = await acquireRunSlot();
  let c = 0;
  const waiters = [acquireRunSlot().then((r) => (c++, r)), acquireRunSlot().then((r) => (c++, r))];
  await sleep(30);
  assert.equal(c, 0);
  setAgentConcurrency(3); // 슬라이더 상향 — 다음 pump에서 반영
  rB(); // 해제가 pump 유발 → 남은 2명 모두 승계(한도 3)
  const rels = await Promise.all(waiters);
  assert.equal(c, 2);
  assert.equal(runSlotStats().inUse, 2);
  rels.forEach((r) => r());
  assert.equal(runSlotStats().inUse, 0);

  // 5) onQueued 콜백 — 대기 진입 시 1회 호출
  setAgentConcurrency(1);
  const rC = await acquireRunSlot();
  let queuedPos = -1;
  const pQ = acquireRunSlot(undefined, (pos) => (queuedPos = pos));
  await sleep(20);
  assert.equal(queuedPos, 1);
  rC();
  (await pQ)();

  console.log("test-run-slots: 5/5 PASS");
  app.exit(0);
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
