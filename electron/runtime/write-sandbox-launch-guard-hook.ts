/**
 * 쓰기 샌드박스 런처 관문 — CLI가 Bash 도구를 부르기 직전에 이 프로세스가 뜬다(PreToolUse).
 * 판단은 shared/write-sandbox-launch-guard.ts 한 곳. 막을 때만 deny 를 쓰고, 아니면 아무 결정도 내지 않는다
 * (빈 출력 = 평소 권한 흐름). 입력을 못 읽으면 통과시키지 않는다 — 관문이 고장 났는데 열어 두면 그 순간이 탈출이다.
 */
import { classifyLaunchEscape, launchEscapeDenialReason } from "../../shared/write-sandbox-launch-guard";
import { PERMISSION_ESCALATION_MARKER } from "../../shared/permission-escalation";

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
}

const chunks: Buffer[] = [];
process.stdin.on("data", (d: Buffer) => chunks.push(d));
process.stdin.on("end", () => {
  let input: { tool_name?: string; tool_input?: { command?: unknown } };
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof input;
  } catch {
    deny("WRITE_SANDBOX_GUARD_UNREADABLE: the launch guard could not read this tool call, so it did not run.");
    return;
  }
  if (input.tool_name !== "Bash") return;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const escape = classifyLaunchEscape(command);
  if (escape) deny(launchEscapeDenialReason(escape, PERMISSION_ESCALATION_MARKER));
});
