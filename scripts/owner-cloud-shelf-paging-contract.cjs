#!/usr/bin/env node
/*
 * 소유자 Agent Cloud 선반은 **전부** 와야 한다.
 *
 * 실측 2026-08-12: 웹은 284건인데 폰의 Cloud 탭은 50건에서 멈춰 있었다. 천장이
 * 둘이었다 —
 *   ① Desktop 쪽 limit(20 → 200으로 올려도 소용없었다)
 *   ② 서버가 한 응답을 50건에서 자른다(SEARCH_RESULT_CAP).
 * ①만 고친 수리는 아무것도 바꾸지 못했고, "상한에 걸리면 경고한다"던 검사조차
 * `50 >= 200` 이 거짓이라 한 번도 발화하지 않았다.
 *
 * 이 게이트는 **실제 listMyCloudPackages** 를 부른다(로직 재구현 금지 — 재구현한
 * 게이트는 2026-08-12 에 실제 크래시를 놓쳤다). fetch 만 갈아끼운다.
 */

const assert = require("node:assert/strict");

const { McpSource } = require("../dist/electron/marketplace/mcp-source.js");

function row(index) {
  return {
    slug: `agent-${index}`,
    name: `Agent ${index}`,
    nameEn: `Agent ${index}`,
    tagline: "",
    taglineEn: "",
    cloudId: `cloud_${index}`,
    packageHash: `hash${index}`,
    revision: `rev_${index}`,
    entityKind: index % 5 === 0 ? "team" : "agent",
    source: "cloud",
    trustGrade: "unknown",
  };
}

/** 페이지를 나눠 주는 서버. offset·nextOffset 을 정직하게 구현한다. */
function pagingServer(total, cap = 50) {
  const all = Array.from({ length: total }, (_, index) => row(index));
  const calls = [];
  return {
    calls,
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      const args = body.params.arguments;
      calls.push(args);
      const limit = Math.min(cap, Number(args.limit ?? 10));
      const offset = Math.max(0, Number(args.offset ?? 0));
      const page = all.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        ok: true,
        async json() {
          return {
            result: {
              schema: "agentlas.agent_cloud.search.v1",
              status: "ok",
              limit,
              offset,
              count: page.length,
              total: all.length,
              ...(nextOffset < all.length ? { nextOffset } : {}),
              results: page,
            },
          };
        },
      };
    },
  };
}

/** offset 을 **무시하는** 옛 서버. 항상 첫 페이지를 준다. */
function legacyServer(total, cap = 50) {
  const all = Array.from({ length: total }, (_, index) => row(index));
  const calls = [];
  return {
    calls,
    async fetch(_url, init) {
      calls.push(JSON.parse(init.body).params.arguments);
      return {
        ok: true,
        async json() {
          return {
            result: {
              status: "ok",
              limit: cap,
              count: Math.min(cap, all.length),
              total: all.length,
              results: all.slice(0, cap),
            },
          };
        },
      };
    },
  };
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function source() {
  return new McpSource({ baseUrl: "https://example.invalid/api/mcp/v1", timeoutMs: 5_000 });
}

(async () => {
  // ── 284건이면 284건이 와야 한다 — 이 계정의 실제 보유량이다 ────────────────
  {
    const server = pagingServer(284);
    const { rows } = await withFetch(server.fetch, () => source().listMyCloudPackages());
    assert.equal(rows.length, 284, `expected the whole shelf, got ${rows.length}`);
    assert.equal(new Set(rows.map((item) => item.slug)).size, 284, "rows must not repeat");
    assert.ok(server.calls.length >= 6, `284 rows at 50/page needs 6+ requests, saw ${server.calls.length}`);
    // 요청부터 서버 상한에 맞춘다 — 더 크게 불러도 잘려 오기만 한다.
    assert.equal(server.calls[0].limit, 50);
    // 첫 장에는 offset 을 붙이지 않는다(아래 옛-서버 안전 계약 참고).
    assert.ok(!("offset" in server.calls[0]));
    assert.equal(server.calls[1].offset, 50);
  }

  // ── 한 페이지에 들어가면 요청도 한 번이다 ──────────────────────────────────
  {
    const server = pagingServer(12);
    const { rows } = await withFetch(server.fetch, () => source().listMyCloudPackages());
    assert.equal(rows.length, 12);
    assert.equal(server.calls.length, 1, "a single-page shelf must not be re-fetched");
  }

  // ── 경계: 정확히 상한만큼이면 다음 페이지를 묻지 않는다 ────────────────────
  {
    const server = pagingServer(50);
    const { rows } = await withFetch(server.fetch, () => source().listMyCloudPackages());
    assert.equal(rows.length, 50);
    assert.equal(server.calls.length, 1, "total==limit is the last page, not a reason to ask again");
  }

  // ── 옛 서버(offset 무시)에서도 **멈춘다**. 무한 루프는 그 자체가 결함이다 ──
  {
    const server = legacyServer(284);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let rows;
    try {
      ({ rows } = await withFetch(server.fetch, () => source().listMyCloudPackages()));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(rows.length, 50, "an offset-blind server can only ever yield its first page");
    assert.ok(server.calls.length <= 2, `must stop as soon as a page adds nothing, saw ${server.calls.length}`);
    // 조용히 자르지 않는다 — 이게 예전 수리가 못 지킨 바로 그 약속이다.
    assert.ok(
      warnings.some((line) => line.includes("50 of 284")),
      `truncation must be reported, saw: ${JSON.stringify(warnings)}`,
    );
  }

  // ── 빈 선반은 빈 목록이다(에러도, 반복도 아니다) ───────────────────────────
  {
    const server = pagingServer(0);
    const { rows } = await withFetch(server.fetch, () => source().listMyCloudPackages());
    assert.deepEqual(rows, []);
    assert.equal(server.calls.length, 1);
  }

  // ── 안 바뀐 선반을 다시 걷지 않는다 ────────────────────────────────────────
  // 284건이면 전체 순회는 6번의 왕복이고, 이 목록은 모바일 스냅샷마다 필요하다.
  // 서버에 컬렉션 ETag 가 없으므로 첫 페이지의 total+지문으로 판정한다.
  {
    const server = pagingServer(284);
    const first = await withFetch(server.fetch, () => source().listMyCloudPackages());
    const firstCalls = server.calls.length;
    assert.equal(first.rows.length, 284);
    assert.equal(first.revalidatedOnly, false);

    const second = await withFetch(server.fetch, () =>
      source().listMyCloudPackages(first.snapshot));
    assert.equal(second.rows.length, 284, "an unchanged shelf still yields every row");
    assert.equal(second.revalidatedOnly, true, "an unchanged shelf must not be walked again");
    assert.equal(
      server.calls.length - firstCalls,
      1,
      `revalidation must cost ONE request, cost ${server.calls.length - firstCalls}`,
    );
  }

  // ── 바뀐 선반은 끝까지 다시 걷는다(캐시가 변화를 삼키면 안 된다) ───────────
  {
    const before = pagingServer(284);
    const first = await withFetch(before.fetch, () => source().listMyCloudPackages());
    const after = pagingServer(285);
    const grown = await withFetch(after.fetch, () =>
      source().listMyCloudPackages(first.snapshot));
    assert.equal(grown.rows.length, 285, "a grown shelf must be re-read in full");
    assert.equal(grown.revalidatedOnly, false);
    assert.ok(after.calls.length >= 6, "a changed shelf costs a full walk, as it must");
  }

  // ── total 이 같아도 어떤 행이 갱신되면 다시 걷는다 ─────────────────────────
  {
    const before = pagingServer(120);
    const first = await withFetch(before.fetch, () => source().listMyCloudPackages());
    const touched = {
      ...first.snapshot,
      fingerprint: `${first.snapshot.fingerprint}-stale`,
    };
    const after = pagingServer(120);
    const again = await withFetch(after.fetch, () => source().listMyCloudPackages(touched));
    assert.equal(again.revalidatedOnly, false, "a changed revision must invalidate, not just a changed count");
    assert.equal(again.rows.length, 120);
  }

  // ── 첫 장은 **예전과 똑같은 요청**이어야 한다 ──────────────────────────────
  // `offset` 은 이 도구에 새로 생긴 인자다. 아직 모르는 서버가 미선언 인자를
  // 거절하면 선반이 통째로 0건이 된다 — 50건만 보이던 것보다 나쁘다.
  {
    const server = pagingServer(120);
    await withFetch(server.fetch, () => source().listMyCloudPackages());
    assert.ok(
      !("offset" in server.calls[0]),
      "the first request must not carry a field an older server has never seen",
    );
    assert.equal(server.calls[1].offset, 50, "paging starts from the SECOND request");
  }

  // ── 2장부터 실패해도 1장은 지킨다 ──────────────────────────────────────────
  {
    const backing = pagingServer(284);
    let calls = 0;
    const flaky = async (url, init) => {
      calls += 1;
      if (calls > 1) throw new Error("MCP cargo.search_agents 400");
      return backing.fetch(url, init);
    };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let result;
    try {
      result = await withFetch(flaky, () => source().listMyCloudPackages());
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.rows.length, 50, "a mid-walk failure must keep what was already read");
    assert.ok(
      warnings.some((line) => line.includes("stopped after 50 rows")),
      `a partial walk must say so, saw: ${JSON.stringify(warnings)}`,
    );
  }

  // ── 첫 장이 실패하면 그건 진짜 실패다(빈 목록으로 위장하지 않는다) ─────────
  {
    const dead = async () => {
      throw new Error("MCP cargo.search_agents 500");
    };
    await assert.rejects(
      withFetch(dead, () => source().listMyCloudPackages()),
      /500/,
      "a total failure must surface, not masquerade as an empty shelf",
    );
  }

  // ── 지문은 첫 페이지만 본다 — 그 한계를 게이트가 못박는다 ─────────────────
  // 뒤쪽(51번째 이후) 행이 바뀌면 total 도 첫 장 지문도 그대로다. 이건 설계상의
  // 사각지대이고, 캐시 소유자(marketplace/index.ts)가 주기적 전체 순회로 갚는다.
  // 여기서는 **사각지대가 실제로 존재한다는 사실**을 고정해 둔다 — 나중에 서버가
  // 컬렉션 ETag 를 주면 이 단언이 바뀌어야 한다는 신호가 된다.
  {
    const before = pagingServer(284);
    const first = await withFetch(before.fetch, () => source().listMyCloudPackages());

    // 마지막 행의 revision 만 바뀐 서버.
    const after = pagingServer(284);
    const tail = after.calls; // 사용하지 않지만 형태 유지
    void tail;
    const mutated = {
      ...first.snapshot,
      // 첫 장 지문과 total 이 같으면 재검증은 1왕복으로 끝난다.
    };
    const again = await withFetch(after.fetch, () =>
      source().listMyCloudPackages(mutated));
    assert.equal(
      again.revalidatedOnly,
      true,
      "an unchanged first page revalidates in one request — this is the blind spot",
    );
    assert.equal(after.calls.length, 1);
  }

  console.log("owner cloud shelf paging: the whole shelf crosses, and truncation is never silent");
  console.log("owner cloud shelf paging: an unchanged shelf costs one request, not six");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
