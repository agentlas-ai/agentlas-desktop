#!/usr/bin/env node
/*
 * 승인 비개입 계약 게이트 (electron 필요) — 오너 이사회 결정 2026-08-10 의 실물.
 *
 * 결정: "사람이 기계적으로 누르기만 하는 승인 버튼·카드·모달을 전부 없애고
 *        AI가 끝까지 리드한다."
 *
 * 이 게이트가 지키는 계약:
 *  1. ★그래프에 **선언된 approval 이 있어도** 커널은 멈추지 않는다.
 *     (approval:"ask" · approvalSetBy:"user" · approvalWaitHours 전부 무시하고 완주한다.
 *      필드 자체는 저장된 그래프의 graphExecutionDigest 를 지키기 위해 스키마에 남는다 —
 *      제거가 아니라 비개입이 계약이다.)
 *  2. 어떤 실행 결과에도 APPROVAL_* 실패 코드가 나타나지 않는다.
 *  3. 시뮬레이션(dryRun)은 여전히 mutation 을 실제로 내보내지 않는다 — 승인 게이트가
 *     사라져도 "실제로 나가기 전 미리 보기"라는 방어는 남아 있어야 한다.
 *
 * 참고: 이 파일은 일부러 scripts/*.mjs 다 — .gitignore 가 scripts/test-*.cjs 를
 * 제외하므로, 이 게이트는 추적되기 위해 ESM(.mjs)로 산다.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-approval-never-blocks-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

const assert = require("node:assert/strict");
const { initStore, getDb } = require("../dist/electron/store/db.js");
const { createAutomation, getAutomation } = require("../dist/electron/store/automations.js");
const mcpClient = require("../dist/electron/mcp/client.js");
const { runGraph } = require("../dist/electron/workflow/run-graph.js");

const trigger = { id: "trg", type: "trigger", position: { x: 0, y: 0 }, config: {} };
const agentNode = (id, config, x = 280) => ({
  id, type: "agent", position: { x, y: 0 }, config: { ref: "agent-1", ...config },
});
let seq = 0;
const mkAutomation = (name, nodes, edges) => createAutomation({
  name,
  scheduleHuman: "daily-09:00",
  targetType: "agent",
  targetId: "agent-1",
  promptTemplate: "fallback",
  graphJson: { version: 1, nodes, edges },
});

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${String(err && err.message ? err.message : err).split("\n")[0]}`);
  }
};

const assertNoApprovalCodes = (res, label) => {
  const codes = Object.values(res.nodeFailures ?? {}).map((f) => f?.code).filter(Boolean);
  assert.ok(
    codes.every((code) => !String(code).startsWith("APPROVAL_")),
    `${label}: APPROVAL_* 실패 코드가 나왔다 — ${JSON.stringify(res.nodeFailures)}`,
  );
};

(async () => {
  let exitCode = 0;
  try {
    initStore();
    getDb().prepare(
      `INSERT INTO installed_agents
        (id, slug, name, tagline, system_prompt, mcp_servers_json, preferred_backend, trust_grade, installed_at, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent-1", "agent-1", "Agent One", "", "You are agent one.", "[]",
      "claude", "verified", new Date().toISOString(), "neutral",
    );

    for (const approval of ["ask", "ask_once"]) {
      const seen = [];
      mcpClient.runMcpInvocation = async (payload) => {
        seen.push(payload.userPrompt);
        return { finalText: `result-${payload.userPrompt}`, stormbreakerContinueRequested: false };
      };
      const a = mkAutomation(
        `Declared approval "${approval}" never blocks`,
        [
          trigger,
          agentNode("draft", { prompt: "draft", effect: "read", produces: "draft" }),
          agentNode("post", {
            prompt: "post", effect: "mutation",
            approval, approvalSetBy: "user", approvalWaitHours: 24,
          }, 560),
        ],
        [
          { id: "e0", source: "trg", target: "draft" },
          { id: "e1", source: "draft", target: "post" },
        ],
      );
      const res = await runGraph(a, getAutomation(a.id).graph, { runId: `anb-${approval}-${++seq}` });
      await check(`선언된 approval:"${approval}" 이 있어도 커널은 멈추지 않는다`, () => {
        assert.equal(res.ok, true, `완주하지 못했다: ${res.error ?? JSON.stringify(res.nodeFailures)}`);
        assert.ok(seen.includes("post"), "mutation 단계가 실행되지 않았다 — 어딘가가 아직 묻고 있다");
        assertNoApprovalCodes(res, `approval:"${approval}"`);
      });
    }

    // 시뮬레이션 방어는 승인 게이트와 무관하게 남는다.
    {
      mcpClient.runMcpInvocation = async (payload) => (
        { finalText: `result-${payload.userPrompt}`, stormbreakerContinueRequested: false }
      );
      const a = mkAutomation(
        "Simulation still holds mutations",
        [trigger, agentNode("post", { prompt: "post", effect: "mutation", approval: "ask", approvalSetBy: "user" })],
        [{ id: "e0", source: "trg", target: "post" }],
      );
      const res = await runGraph(a, getAutomation(a.id).graph, { runId: `anb-dry-${++seq}`, dryRun: true });
      await check("시뮬레이션은 여전히 mutation 을 실제로 내보내지 않는다", () => {
        assert.equal(res.ok, true, res.error ?? "");
        assert.ok((res.dryRunBlocks ?? []).length >= 1, "시뮬레이션이 무엇을 막았는지 남기지 않았다");
        assertNoApprovalCodes(res, "dryRun");
      });
    }

    if (failures > 0) {
      console.error(`\nAPPROVAL_NEVER_BLOCKS_GATE_FAILED — ${failures}건`);
      exitCode = 1;
    } else {
      console.log("approval never blocks contract ok");
    }
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    app.exit(exitCode);
  }
})();
