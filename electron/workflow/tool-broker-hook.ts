/**
 * C38 관문 스크립트 — CLI가 도구를 부르기 **직전에** 이 프로세스가 뜬다.
 *
 * 하는 일은 옮기기뿐이다: stdin으로 온 호출을 읽고, 이번 노드 계획을 읽고,
 * `brokerDecision`에게 물어, 결과를 CLI가 아는 모양으로 stdout에 쓴다.
 * 판단을 여기서 다시 쓰지 않는 이유는 하나다 — 두 벌이면 언젠가 갈라지고,
 * 갈라진 쪽은 항상 "막았다고 적혀 있는데 안 막힌 쪽"이다.
 *
 * 못 읽거나 못 판단하면 **통과시키지 않는다**. 관문이 고장 났는데 열어 두면
 * 시뮬레이션이 바깥을 바꾸는 일이 정확히 그 순간에 일어난다.
 */
import fs from "node:fs";
import { brokerDecision, type ToolBrokerPlan } from "../../shared/graph-tool-broker";

function allow(): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  }));
}

/** 거절은 **코드와 사유**를 함께 낸다 — 모델도 사람도 왜 막혔는지 알아야 한다. */
function deny(failure: { code: string; reason: string }): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${failure.code}: ${failure.reason}`,
    },
  }));
}

const chunks: Buffer[] = [];
process.stdin.on("data", (d: Buffer) => chunks.push(d));
process.stdin.on("end", () => {
  const planPath = process.argv[2];
  let plan: ToolBrokerPlan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as ToolBrokerPlan;
  } catch {
    deny({ code: "TOOL_BROKER_PLAN_UNREADABLE", reason: "이 단계의 도구 규칙을 읽지 못해 실행하지 않았습니다." });
    return;
  }
  let toolName = "";
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool_name?: string; toolName?: string };
    toolName = input.tool_name ?? input.toolName ?? "";
  } catch {
    deny({ code: "TOOL_BROKER_CALL_UNREADABLE", reason: "어떤 도구를 부르려는지 읽지 못해 실행하지 않았습니다." });
    return;
  }
  if (!toolName) {
    deny({ code: "TOOL_BROKER_CALL_UNREADABLE", reason: "도구 이름이 없어 실행하지 않았습니다." });
    return;
  }
  const verdict = brokerDecision(plan, toolName);
  if (verdict.allow) allow();
  else deny({ code: verdict.code ?? "TOOL_BROKER_CALL_UNREADABLE", reason: verdict.reason ?? "" });
});
