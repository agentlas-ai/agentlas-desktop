// 스웜 엔진 결정적 유닛테스트 — GUI/DB/LLM 없이 가짜 훅으로 루프 로직만 검증.
// 실행: npm run build:electron && node scripts/test-swarm-engine.cjs
const assert = require("node:assert/strict");
const { runSwarm } = require("../dist/electron/mcp/swarm-engine.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function idGen() {
  let n = 0;
  return () => `t${++n}`;
}
const LIMITS = { concurrency: 4, maxTasks: 200, maxRounds: 100000 };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log("  ✅", name);
}

(async () => {
  // 1) 기본 수렴: 시드 2개, 스폰 없음 → 둘 다 done → synthesize 호출
  await test("기본 수렴", async () => {
    const done = [];
    const { board, final } = await runSwarm(
      "goal",
      [{ title: "A", brief: "" }, { title: "B", brief: "" }],
      LIMITS,
      {
        nextId: idGen(),
        runTask: async (t) => { done.push(t.title); return { result: `${t.title} 완료` }; },
        synthesize: async (b) => `종합: ${b.tasks.filter((x) => x.status === "done").length}개`,
      },
    );
    assert.equal(board.tasks.filter((t) => t.status === "done").length, 2);
    assert.deepEqual(done.sort(), ["A", "B"]);
    assert.equal(final, "종합: 2개");
  });

  // 2) 스폰(emergent 성장): 시드 1개가 하위 2개 스폰 → 다 실행 → 수렴
  await test("스폰으로 그래프 성장", async () => {
    let spawnedOnce = false;
    const { board } = await runSwarm(
      "goal",
      [{ title: "root", brief: "" }],
      LIMITS,
      {
        nextId: idGen(),
        runTask: async (t) => {
          if (t.title === "root" && !spawnedOnce) {
            spawnedOnce = true;
            return { result: "root done", spawn: [{ title: "child1", brief: "" }, { title: "child2", brief: "" }] };
          }
          return { result: `${t.title} done` };
        },
        synthesize: async () => "ok",
      },
    );
    assert.equal(board.tasks.length, 3, "root + 2 children");
    assert.equal(board.tasks.filter((t) => t.status === "done").length, 3);
  });

  // 3) 의존성 순서: T2가 T1에 의존 → T1이 끝난 뒤에만 T2 시작
  await test("의존성 순서 보장", async () => {
    const nid = idGen();
    // 시드 id를 알아야 dep을 걸 수 있으므로 nextId 순서를 안다: t1, t2
    const startOrder = [];
    let t1Done = false;
    await runSwarm(
      "goal",
      [
        { title: "T1", brief: "" },
        { title: "T2", brief: "", deps: ["t1"] },
      ],
      LIMITS,
      {
        nextId: nid,
        runTask: async (t) => {
          startOrder.push(t.title);
          if (t.title === "T2") assert.ok(t1Done, "T2는 T1 done 후에만 시작해야 함");
          await delay(5);
          if (t.title === "T1") t1Done = true;
          return { result: "" };
        },
        synthesize: async () => "ok",
      },
    );
    assert.deepEqual(startOrder, ["T1", "T2"]);
  });

  // 4) 동시성 캡: 독립 5개, concurrency=2 → 동시에 2개 초과 실행 안 됨
  await test("동시성 캡(2) 준수", async () => {
    let cur = 0;
    let peak = 0;
    const seeds = Array.from({ length: 5 }, (_, i) => ({ title: `X${i}`, brief: "" }));
    await runSwarm("goal", seeds, { ...LIMITS, concurrency: 2 }, {
      nextId: idGen(),
      runTask: async () => {
        cur += 1;
        peak = Math.max(peak, cur);
        await delay(5);
        cur -= 1;
        return { result: "" };
      },
      synthesize: async () => "ok",
    });
    assert.equal(peak, 2, `동시 실행 peak=${peak} (2여야)`);
  });

  // 5) 연쇄 실패(데드락 방지): T1 실패 → T2(dep T1)는 연쇄 실패, 무한대기 없음
  await test("실패 의존성 → 연쇄실패(무한대기 없음)", async () => {
    const { board } = await runSwarm(
      "goal",
      [
        { title: "T1", brief: "" },
        { title: "T2", brief: "", deps: ["t1"] },
      ],
      LIMITS,
      {
        nextId: idGen(),
        runTask: async (t) => (t.title === "T1" ? { result: "", failed: true } : { result: "" }),
        synthesize: async () => "ok",
      },
    );
    const t2 = board.tasks.find((t) => t.title === "T2");
    assert.equal(t2.status, "failed", "T2는 연쇄 실패해야 함");
  });

  // 6) 무한 스폰 캡(livelock 방지): 매번 1개 더 스폰 → maxTasks에서 멈춤
  await test("무한 스폰 → maxTasks 캡", async () => {
    let capped = false;
    const { board } = await runSwarm(
      "goal",
      [{ title: "seed", brief: "" }],
      { concurrency: 3, maxTasks: 12, maxRounds: 100000 },
      {
        nextId: idGen(),
        runTask: async () => ({ result: "", spawn: [{ title: "more", brief: "" }] }),
        synthesize: async () => "ok",
        onEvent: (e) => { if (e.kind === "capped" && e.reason === "maxTasks") capped = true; },
      },
    );
    assert.ok(board.tasks.length <= 12, `총 작업 ${board.tasks.length} ≤ 12`);
    assert.ok(capped, "maxTasks 캡 이벤트가 떠야 함");
  });

  // 7) abort: 중간 취소 → 즉시 종료 + synthesize(추가 LLM비용)는 스킵 + aborted 플래그
  await test("abort → 즉시 종료 + 종합 스킵(비용 절약)", async () => {
    const ctrl = new AbortController();
    let synthesized = false;
    const seeds = Array.from({ length: 20 }, (_, i) => ({ title: `A${i}`, brief: "" }));
    setTimeout(() => ctrl.abort(), 8);
    const { board, aborted } = await runSwarm("goal", seeds, { ...LIMITS, concurrency: 2 }, {
      nextId: idGen(),
      runTask: async () => { await delay(6); return { result: "" }; },
      synthesize: async () => { synthesized = true; return "부분종합"; },
    }, ctrl.signal);
    assert.equal(aborted, true, "aborted 플래그가 true여야");
    assert.ok(!synthesized, "abort 시 synthesize(추가 LLM)는 스킵해야");
    assert.ok(board.tasks.some((t) => t.status !== "done"), "일부는 미완(취소로 안 돎)");
  });

  // 8) 실패한 작업은 스폰 안 됨(성공 작업만 그래프 성장)
  await test("실패 작업은 스폰 안 함", async () => {
    const { board } = await runSwarm(
      "goal",
      [{ title: "boom", brief: "" }],
      LIMITS,
      {
        nextId: idGen(),
        runTask: async () => ({ result: "", failed: true, spawn: [{ title: "should-not-exist", brief: "" }] }),
        synthesize: async () => "ok",
      },
    );
    assert.equal(board.tasks.length, 1, "실패 작업의 스폰은 무시 → 그래프 안 자람");
    assert.equal(board.tasks[0].status, "failed");
  });

  // 9) 최종 게이트: 부분 종합은 허용해도 실패 패킷이 있으면 성공으로 보고할 수 없다.
  await test("실패 패킷은 최종 성공 주장 차단", async () => {
    const { final, finalGate } = await runSwarm(
      "goal",
      [{ title: "passing", brief: "" }, { title: "blocked", brief: "" }],
      LIMITS,
      {
        nextId: idGen(),
        runTask: async (task) => task.title === "blocked"
          ? { result: "runtime failed", failed: true }
          : { result: "verified result" },
        synthesize: async () => "partial synthesis is still useful",
      },
    );
    assert.equal(final, "partial synthesis is still useful", "partial synthesis may be returned for diagnosis");
    assert.equal(finalGate.canReportSuccess, false, "a failed required packet must block the final success claim");
    assert.equal(finalGate.status, "blocked");
    assert.equal(finalGate.passing.length, 1);
    assert.equal(finalGate.blocked.length, 1);
  });

  console.log(`\n스웜 엔진 유닛테스트 ${passed}/9 통과 ✅`);
})().catch((err) => {
  console.error("\n❌ 테스트 실패:", err.message);
  process.exit(1);
});
