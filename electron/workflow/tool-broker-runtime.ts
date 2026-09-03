/**
 * C38 중개 관문의 **실물** — 계획(shared/graph-tool-broker.ts)을 런타임이 실제로 거는
 * 훅으로 바꾼다.
 *
 * 관문 자체는 우리 프로세스가 아니라 CLI가 도구를 부르기 직전에 돈다. 그래서 필요한 건
 * 두 조각이다: 이번 노드의 계획을 적은 파일 하나, 그리고 그 파일을 읽고 통과/거절을
 * 돌려주는 아주 작은 스크립트 하나. 판단 자체는 shared의 `brokerDecision`이 하고
 * 스크립트는 stdin/stdout만 옮긴다 — 판단을 두 벌 쓰면 반드시 갈라진다.
 */
import fs from "node:fs";
import path from "node:path";
import {
  planToolBrokerage,
  type ToolBrokerInput,
  type ToolBrokerPlan,
} from "../../shared/graph-tool-broker";
import { userDataPath } from "../runtime-paths";

export interface MaterializedToolBroker {
  plan: ToolBrokerPlan;
  /** claude 계열에 `--settings`로 넘길 파일. 관문을 걸 수 없으면 null. */
  settingsPath: string | null;
  /**
   * grok 에 `--plugin-dir` 로 넘길 디렉터리. 관문을 걸 수 없으면 null.
   *
   * ★grok 은 claude 와 **같은 stdout JSON 계약**을 쓴다(바이너리 문서 실측 2026-08-19:
   * "For `PreToolUse`, a `deny` decision in stdout JSON is honored regardless of
   * exit code"). 그래서 훅 스크립트를 새로 쓰지 않고 그대로 재사용한다 — 판단이
   * 두 벌이 되면 갈라지고, 갈라진 쪽은 항상 "막았다고 적혀 있는데 안 막힌 쪽"이다.
   * 다른 것은 설정 형식뿐이라(TOML `[[hooks.PreToolUse]]`), 여기서 그것만 렌더한다.
   * `--plugin-dir` 는 프로세스별 주입점이라 사용자 전역 설정을 건드리지 않는다.
   */
  pluginDirPath: string | null;
  /*
   * ★codex 용 hooks.json 은 여기 없다 — 만들었지만 아무도 읽지 않았다.
   *
   * electron/runtime/codex.ts 는 이 값을 소비하지 않고, 애초에 소비할 수도 없다:
   * codex 의 관문 등급은 `allowlist-only` 다(shared/graph-tool-broker.ts:59-66 —
   * 실행 파일에 PreToolUse 심볼은 있지만 거절이 실제로 먹는지 실측이 무응답으로
   * 끝났다). 그리고 이 함수는 `chokepoint !== "pretooluse-hook"` 이면 파일 자체를
   * 만들지 않으므로, codex 경로에서는 그 값이 언제나 null 이었다. 즉 "쓰이지 않는
   * 출력"이 아니라 **도달 불가능한 출력**이었다. 실측으로 codex 가 pretooluse-hook
   * 으로 올라가는 날, 이 칸과 codex.ts 의 소비를 **함께** 넣는 것이 맞다.
   */
  /** 이번 노드 계획을 적은 파일. 훅 스크립트가 이걸 읽는다. */
  planPath: string | null;
}

function brokerDir(runId: string, nodeId: string): string {
  const base = userDataPath("graph-tool-broker", runId);
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `${nodeId.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}

/** 훅 스크립트의 위치. 개발(dist 미빌드 아님)과 패키지 모두 같은 경로 규칙을 쓴다. */
export function brokerHookScriptPath(): string {
  return path.join(__dirname, "tool-broker-hook.js");
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
    return { plan, settingsPath: null, planPath: null, pluginDirPath: null };
  }

  const prefix = brokerDir(input.runId, input.nodeId);
  const planPath = `${prefix}.plan.json`;
  const settingsPath = `${prefix}.settings.json`;
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
      planPath: null,
      pluginDirPath: null,
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

  /*
   * grok 판: 같은 스크립트, 같은 stdout 계약, 다른 포장.
   * `--plugin-dir <DIR>` 이 가리키는 디렉터리 안의 `hooks.toml` 을 읽는다.
   * matcher 는 claude 쪽과 같은 `.*` — 무엇이 통과할지는 계획이 정하지, 매처가 정하지 않는다.
   */
  const pluginDirPath = `${prefix}.grok-plugin`;
  try {
    fs.mkdirSync(pluginDirPath, { recursive: true });
    const tomlCommand = JSON.stringify(command);
    fs.writeFileSync(
      path.join(pluginDirPath, "hooks.toml"),
      [
        "[[hooks.PreToolUse]]",
        'matcher = ".*"',
        "  [[hooks.PreToolUse.hooks]]",
        '  type = "command"',
        `  command = ${tomlCommand}`,
        "  timeout = 10",
        "",
      ].join("\n"),
      "utf8",
    );
  } catch {
    // 렌더에 실패하면 grok 쪽 관문은 없는 것이다. claude 쪽은 그대로 살아 있으므로
    // 전체를 강등하지 않고 이 칸만 null 로 둔다 — 러너가 플래그를 안 붙인다.
    return { plan, settingsPath, planPath, pluginDirPath: null };
  }
  return { plan, settingsPath, planPath, pluginDirPath };
}

/** 실행이 끝나면 이번 실행의 계획 파일을 치운다. 남겨 둘 이유가 없다. */
export function clearToolBrokerArtifacts(runId: string): void {
  try {
    fs.rmSync(userDataPath("graph-tool-broker", runId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* 정리는 best effort — 실행 결과를 여기서 뒤집지 않는다. */
  }
}
