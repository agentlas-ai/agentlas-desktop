/**
 * C38 중개 관문의 **실물** — 계획(shared/graph-tool-broker.ts)을 런타임이 실제로 거는
 * 훅으로 바꾼다.
 *
 * 관문 자체는 우리 프로세스가 아니라 CLI가 도구를 부르기 직전에 돈다. 그래서 필요한 건
 * 두 조각이다: 이번 노드의 계획을 적은 파일 하나, 그리고 그 파일을 읽고 통과/거절을
 * 돌려주는 아주 작은 스크립트 하나. 판단 자체는 shared의 `brokerDecision`이 하고
 * 스크립트는 stdin/stdout만 옮긴다 — 판단을 두 벌 쓰면 반드시 갈라진다.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  planToolBrokerage,
  type ToolBrokerInput,
  type ToolBrokerPlan,
} from "../../shared/graph-tool-broker";

export interface MaterializedToolBroker {
  plan: ToolBrokerPlan;
  /** claude 계열에 `--settings`로 넘길 파일. 관문을 걸 수 없으면 null. */
  settingsPath: string | null;
  /** codex 계열에 넘길 hooks.json. 관문을 걸 수 없으면 null. */
  codexHooksPath: string | null;
  /** 이번 노드 계획을 적은 파일. 훅 스크립트가 이걸 읽는다. */
  planPath: string | null;
}

function brokerDir(runId: string, nodeId: string): string {
  const base = path.join(app.getPath("userData"), "graph-tool-broker", runId);
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `${nodeId.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}

/** 훅 스크립트의 위치. 개발(dist 미빌드 아님)과 패키지 모두 같은 경로 규칙을 쓴다. */
export function brokerHookScriptPath(): string {
  return path.join(app.getAppPath(), "dist", "electron", "workflow", "tool-broker-hook.js");
}

/**
 * 이번 노드의 중개를 준비한다. **관문을 걸 수 없으면 파일을 만들지 않는다** — 빈 설정
 * 파일을 넘겨 놓고 "중개했다"고 기록하는 게 이 커넥터가 막으려는 바로 그 거짓이다.
 */
export function materializeToolBroker(
  input: ToolBrokerInput & { runId: string; nodeId: string },
): MaterializedToolBroker {
  const plan = planToolBrokerage(input);
  if (plan.chokepoint !== "pretooluse-hook") {
    return { plan, settingsPath: null, codexHooksPath: null, planPath: null };
  }

  const prefix = brokerDir(input.runId, input.nodeId);
  const planPath = `${prefix}.plan.json`;
  const settingsPath = `${prefix}.settings.json`;
  const codexHooksPath = `${prefix}.hooks.json`;
  const script = brokerHookScriptPath();
  if (!fs.existsSync(script)) {
    // 스크립트가 없으면 관문이 없는 것이다. 등급을 내려서 정직하게 돌려준다.
    return {
      plan: {
        ...plan,
        level: "observed",
        chokepoint: "none",
        reason: "도구 중개 관문 스크립트를 찾지 못해 막지 못했습니다 — 기록만 남습니다.",
      },
      settingsPath: null,
      codexHooksPath: null,
      planPath: null,
    };
  }

  fs.writeFileSync(planPath, JSON.stringify(plan), "utf8");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(planPath)}`;
  const hookBlock = {
    hooks: {
      PreToolUse: [
        { matcher: ".*", hooks: [{ type: "command", command, timeout: 10 }] },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(hookBlock), "utf8");
  fs.writeFileSync(codexHooksPath, JSON.stringify(hookBlock), "utf8");
  return { plan, settingsPath, codexHooksPath, planPath };
}

/** 실행이 끝나면 이번 실행의 계획 파일을 치운다. 남겨 둘 이유가 없다. */
export function clearToolBrokerArtifacts(runId: string): void {
  try {
    fs.rmSync(path.join(app.getPath("userData"), "graph-tool-broker", runId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* 정리는 best effort — 실행 결과를 여기서 뒤집지 않는다. */
  }
}
