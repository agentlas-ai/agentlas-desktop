#!/usr/bin/env node
"use strict";
/*
 * 하네스를 잘못 짜도 무한 루프가 기계를 태우지 못한다(오너 2026-09-14: "gemini <-> 다른 폴백, 둘 다 사용량 없는데
 * 넘기기 분당 수만 회 -> 터짐"). 판정은 문장 대조가 아니라 브레이커를 실제로 부르고, pickRunner 가 실제로 감싼
 * 러너를 불러 확인한다. 시계는 가짜로 돌려 1분·10분을 즉시 잰다.
 *   npm run test:runtime-invocation-breaker   (tsc 로 dist 를 먼저 만든다)
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// AGENTLAS_DIST_ROOT: 촬영·사용 중인 dist 를 건드리지 않고 임시 빌드로 잴 때.
const root = process.env.AGENTLAS_DIST_ROOT ? path.resolve(process.env.AGENTLAS_DIST_ROOT) : path.resolve(__dirname, "..");
const breakerModule = require(path.join(root, "dist/electron/runtime/invocation-breaker.js"));
const { InvocationBreaker, INVOCATION_BREAKER_FAILURE_THRESHOLD: THRESHOLD, INVOCATION_BREAKER_WINDOW_MS: WINDOW } = breakerModule;

let checks = 0;
const check = (ok, label) => { assert.equal(Boolean(ok), true, label); checks += 1; console.log("PASS", label); };

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; }, advance: (ms) => { now += ms; } };
}
const failing = (counter, label) => async () => { counter[label] = (counter[label] ?? 0) + 1; return { text: "", failure: { kind: "exit", source: "exit", runtime: label, message: "no quota" } }; };

(async () => {
  // ── 1. 두 런타임이 서로 넘기는 무한 루프: 10만 번 돌려도 실제 실행은 문턱만큼만, 나머지는 기다렸다 거절 ─────
  {
    const clock = fakeClock();
    const breaker = new InvocationBreaker(clock);
    const spawned = {};
    const gemini = breaker.wrap(failing(spawned, "gemini"), "gemini", "Gemini");
    const luna = breaker.wrap(failing(spawned, "luna"), "luna", "Luna");
    const iterations = 100_000;
    let refusals = 0;
    const startedAt = clock.now();
    for (let i = 0; i < iterations; i += 1) {
      const result = await (i % 2 === 0 ? gemini : luna)({ locale: "en" }, {});
      if (result.failure?.providerCode === "runtime_invocation_storm") refusals += 1;
      clock.advance(1); // 버그 난 하네스는 1ms 마다 다시 부른다
    }
    const minutes = (clock.now() - startedAt) / 60_000;
    const perMinute = (spawned.gemini + spawned.luna) / minutes;
    check(refusals > 0, `a ping-pong between two failing runtimes trips the breaker (${refusals} refusals)`);
    check(perMinute <= 2 * THRESHOLD * 1.5, `real launches stay near ${THRESHOLD} per runtime per minute, not tens of thousands (${perMinute.toFixed(1)}/min over ${minutes.toFixed(0)} min)`);
    check(iterations / minutes <= 2 * 60 / 2 + 2 * THRESHOLD, `the refusing loop itself is throttled by the refusal wait (${(iterations / minutes).toFixed(1)} calls/min)`);
  }

  // ── 2. 건강한 대량 실행은 건드리지 않는다 ────────────────────────────────────────────
  {
    const clock = fakeClock();
    const breaker = new InvocationBreaker(clock);
    let ran = 0;
    const healthy = breaker.wrap(async () => { ran += 1; return { text: "ok" }; }, "claude", "Claude");
    for (let i = 0; i < 1_000; i += 1) await healthy({ locale: "en" }, {});
    check(ran === 1_000 && !breaker.isOpen("claude"), "a thousand successful runs in a minute never trip the breaker");
  }

  // ── 3. 스스로 풀린다 · 던지는 러너도 센다 · 취소는 안 센다 ─────────────────────────
  {
    const clock = fakeClock();
    const breaker = new InvocationBreaker(clock);
    const thrower = breaker.wrap(async () => { throw new Error("spawn failed"); }, "grok", "Grok");
    for (let i = 0; i < THRESHOLD; i += 1) await thrower({ locale: "en" }, {}).catch(() => {});
    check(breaker.isOpen("grok"), "a runner that throws counts as a failed launch");
    clock.advance(WINDOW + 1);
    check(!breaker.isOpen("grok"), "the breaker closes by itself once a minute passes without a storm");

    const aborted = new AbortController(); aborted.abort();
    const cancelled = breaker.wrap(async () => ({ text: "", failure: { kind: "exit", source: "exit", runtime: "codex", message: "cancelled" } }), "codex", "Codex");
    for (let i = 0; i < THRESHOLD * 2; i += 1) await cancelled({ locale: "en", signal: aborted.signal }, {});
    check(!breaker.isOpen("codex"), "runs the person cancelled are not a storm");
  }

  // ── 4. 배선: 제품이 쓰는 pickRunner 가 돌려주는 러너가 브레이커를 지난다 ─────────────────
  {
    const { pickRunner } = require(path.join(root, "dist/electron/runtime/selection.js"));
    const runtime = { kind: "byok", backend: "contract-provider", source: "contract", model: "m", credentialAccess: { status: "unavailable" } };
    const picked = pickRunner(runtime);
    assert.ok(picked, "pickRunner resolves the fixture runtime");
    let last = null;
    for (let i = 0; i <= THRESHOLD; i += 1) last = await picked.runner({ locale: "en" }, {});
    check(last?.failure?.providerCode === "runtime_invocation_storm", `the runner pickRunner hands out is wrapped by the breaker (last: ${last?.failure?.providerCode ?? last?.failure?.kind})`);
    check(pickRunner(runtime).runner !== picked.runner && (await pickRunner(runtime).runner({ locale: "ko" }, {})).failure.providerCode === "runtime_invocation_storm",
      "the breaker state is shared across pickRunner calls, so a loop that re-picks every time is still caught");
  }

  console.log(JSON.stringify({ ok: true, checks }));
})().catch((error) => { console.error(error); process.exit(1); });
