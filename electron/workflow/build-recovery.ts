// 그래프를 짓다가 막혔을 때, **끝내지 않고 이어간다**.
//
// ─ 왜 필요한가 (오너 2026-08-20) ────────────────────────────────────────────
// 저장 전에 한 번 돌려 보는 것까지는 있었다(verify-before-save). 그런데 안 되면
// `"X 단계는 아직 안 됩니다 — <원인>"` 문장 한 줄을 내고 끝났다. 사용자가 볼 때 이건
// "만들다 실패했습니다"이고, 그 다음에 뭘 해야 하는지가 없다. 오너의 말 그대로:
//
//   *"50% 정도 완성하다 실패를 했을 때도 이어갈 수 있어야지, 대안을 제시한다거나.
//     이게 LLM 아닌가."*
//
// 그리고 막히는 이유는 한 가지가 아니다. 크게 둘이다:
//   · 내가 고칠 수 있는 것 — 코드가 앞 단계의 값을 잘못 읽는다 (실측 E5: 에이전트가
//     표로 답했는데 다음 코드가 구조화된 값을 기대해 빈손을 냈다)
//   · 사람만 가진 것이 필요한 것 — 로그인, 화면 권한, 계정
// 이 둘을 **하드코딩된 조건문으로** 가르면 안 된다. 오류의 모양은 무한하고, 단어장·
// 정규식 판정은 새 모양마다 구멍이 나며 다국어에서 전멸한다(오너 결정 2026-08-12).
//
// ─ 그래서 이 파일의 규칙 ────────────────────────────────────────────────────
// automation-fix.ts 가 **실행 실패**에 대해 이미 세운 계약을 그대로 쓴다:
//   R1. 코드는 **사실만** 모은다. 관찰에 없는 것은 "모름"이고, 모델은 그것을 주장하지
//       않는다. 확인할 수 있는 것(브라우저 세션 상태·로그인 여부)은 호스트가 확인해
//       사실로 붙인다 — 모델이 "로그인이 안 돼 있습니다"라고 지어내면 안 된다.
//   R2. **가능한 행동은 유한**하고, 지금 이 순간 실제로 실행할 수 있는 것만 만든다.
//       없는 능력을 목록에 넣으면 모델이 고르고 사용자는 눌러도 아무 일이 없다.
//   R3. **어느 것을 언제 어떤 말로** 는 모델이 정한다. 그래서 사람마다 다른 칩이
//       나오되, 호스트가 실제로 실행할 수 있는 것만 나온다.
//
// ★실행 실패용(planAutomationFix)과 합치지 않는 이유: 그쪽은 저장된 자동화 id 와
//   실행 기록을 전제한다. 여기는 아직 저장되지 않은 그래프다 — 기록이 없는 게 정상이고,
//   그것을 "기록이 없다"는 사실로 넘겨야지 결함으로 취급하면 안 된다.
import type { WorkflowGraph, WorkflowNode } from "../../shared/types";
import { judgeRequiredAction, secretValueFloor, type RequiredActionOption } from "../system-agents/judgment";
import { getBrowserStatus, browserListSites } from "../browser/connect";
import type { BrowserSiteRow } from "../store/browser-vault";
import { getAuthSession } from "../auth";
import { checkComputerUsePermissions } from "../mac-permissions";
import { currentUiLocale } from "../ui-locale";
import { codeReferencedVars } from "../../shared/graph-code-vars";
import { nodeDeclaresOutwardEffect } from "../../shared/graph-node-protocol";

/**
 * 짓는 중에 할 수 있는 일. **유한하고, 각각 호스트가 실제로 실행할 수 있다.**
 * 새 항목을 더하려면 그 항목을 실행하는 코드가 먼저 있어야 한다.
 */
export type GraphBuildFixKind =
  /** 막힌 단계의 스크립트를 다시 써서 재검증한다. 호스트가 혼자 할 수 있다. */
  | "repair_step"
  /** 이 그래프가 쓰겠다고 선언한 사이트의 로그인 창을 연다. 사람만 할 수 있다. */
  | "browser_login"
  /** 브라우저 자체가 없거나 설정이 안 됐다 — 커넥트 화면을 연다. */
  | "open_browser_setup"
  /** 화면을 조작하는 그래프인데 macOS 권한이 없다. */
  | "open_mac_permissions"
  /** Agentlas 계정 로그인이 필요하다. */
  | "agentlas_sign_in"
  /** 지금 상태 그대로 저장하되 꺼 둔다 — **만든 것을 버리지 않는다**. */
  | "save_switched_off"
  /** 대화에서 이어서 푼다. */
  | "ask_in_session";

export interface GraphBuildFixOption {
  actionId: string;
  kind: GraphBuildFixKind;
  /** 모델이 쓴 사용자 문구. 내부 코드·경로·스택은 들어가지 않는다. */
  label: string;
  /** browser_login 전용. */
  site?: string;
}

export interface GraphBuildRecoveryPlan {
  /** 지금 상황을 사람 말로(모델 작성). */
  summary: string;
  /** 사람에게 물어야 할 때만 채워진다. */
  question: string | null;
  options: GraphBuildFixOption[];
  /** 판정 런타임이 없어 고르지 못했다. 이때만 화면이 일반 안내로 내려간다. */
  unavailable: boolean;
}

/** 막힌 단계에 대해 **관측된** 사실. 추측은 담지 않는다. */
export interface BlockedStepFacts {
  nodeId: string;
  label: string;
  /** 실행기가 낸 그대로의 사유(사람 말로 옮기는 것은 모델의 일이다). */
  cause: string;
  /** 그 단계가 읽으려 한 값 이름 — 코드에서 실제로 뽑는다. */
  wantedVars: string[];
  /** 그 시점에 실제로 있던 값 이름. */
  availableVars: string[];
  /** 앞 단계가 낸 값의 생김새(앞부분만). 형식이 안 맞는 경우가 가장 흔하다. */
  upstreamSample: string | null;
}

interface Capability { option: RequiredActionOption; kind: GraphBuildFixKind; site?: string }

function str(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 이 그래프가 **선언한** 것으로만 판단한다. 선언 없는 것을 필요하다고 하면 틀린 전제다. */
function declaredUse(graph: WorkflowGraph | null | undefined): { browser: boolean; screen: boolean; outward: boolean } {
  const nodes = graph?.nodes ?? [];
  const text = JSON.stringify(nodes).toLowerCase();
  return {
    browser: /"catalog":"[^"]*browser|https?:\/\//.test(text),
    screen: /computer-use|computeruse|screenshot/.test(text),
    outward: nodes.some((n) => nodeDeclaresOutwardEffect(n as { type?: string; config?: Record<string, unknown> })),
  };
}

/**
 * 지금 이 순간 실제로 할 수 있는 것만 만든다(R2). 각 항목은 **호스트가 확인한 사실**을
 * evidence 로 달고 나간다 — 모델은 그 사실 위에서만 고른다.
 */
async function capabilities(input: {
  graph: WorkflowGraph | null | undefined;
  blocked: BlockedStepFacts;
  blockedNode: WorkflowNode | null;
}): Promise<Capability[]> {
  const list: Capability[] = [];
  const uses = declaredUse(input.graph);

  // ① 호스트가 혼자 할 수 있는 것 — 막힌 단계에 스크립트가 있을 때만.
  if (input.blockedNode && str(input.blockedNode.config, "code")) {
    list.push({
      kind: "repair_step",
      option: {
        id: `repair_step:${input.blocked.nodeId}`,
        evidence:
          `Rewrite the script of step "${input.blocked.label}" and run it again before saving. `
          + `The step reads ${JSON.stringify(input.blocked.wantedVars)} and the values available at that point `
          + `were ${JSON.stringify(input.blocked.availableVars)}. Nothing outside this draft is touched.`,
        authority: "local-reversible",
      },
    });
  }

  // ② 사람만 가진 것 — **선언된 쓰임**이 있을 때만 묻는다.
  if (uses.browser) {
    const browser = (() => { try { return getBrowserStatus(); } catch { return null; } })();
    if (browser?.chromeFound) {
      const sites = await browserListSites().catch(() => [] as BrowserSiteRow[]);
      for (const site of sites) {
        if (site.session.status === "valid") continue;
        list.push({
          kind: "browser_login",
          site: site.site,
          option: {
            id: `browser_login:${site.site}`,
            evidence:
              `Open a sign-in window for ${site.site} on the automation's own browser profile. `
              + `The person signs in themselves; no credential is read or stored by the app. `
              + `Saved session state for this site is currently "${site.session.status}".`,
            authority: "local-reversible",
          },
        });
      }
    } else {
      list.push({
        kind: "open_browser_setup",
        option: {
          id: "open_browser_setup",
          evidence: "This draft uses a browser but no browser is set up on this machine yet. Open the Connect screen.",
          authority: "local-reversible",
        },
      });
    }
  }

  if (uses.screen) {
    const missing = (() => { try { return checkComputerUsePermissions(); } catch { return null; } })();
    if (missing) {
      list.push({
        kind: "open_mac_permissions",
        option: {
          id: "open_mac_permissions",
          evidence: `This draft drives the screen and macOS permission is not granted: ${JSON.stringify(missing)}.`,
          authority: "local-reversible",
        },
      });
    }
  }

  const signedIn = (() => { try { return getAuthSession().signedIn === true; } catch { return false; } })();
  if (!signedIn) {
    list.push({
      kind: "agentlas_sign_in",
      option: {
        id: "agentlas_sign_in",
        evidence: "This Desktop is not signed in to Agentlas. Some steps need the account.",
        authority: "local-reversible",
      },
    });
  }

  // ③ 언제나 있는 두 가지 — **만든 것을 버리지 않는다**가 그중 하나다.
  list.push({
    kind: "save_switched_off",
    option: {
      id: "save_switched_off",
      evidence:
        "Save the draft exactly as it is, switched off, so the work is not lost. "
        + "It will not run until the person turns it on.",
      authority: "local-reversible",
    },
  });
  list.push({
    kind: "ask_in_session",
    option: {
      id: "ask_in_session",
      evidence: "Continue solving this in the automation's chat, where the person can answer questions.",
      authority: "local-reversible",
    },
  });
  return list;
}

/** 모델에게 넘기는 비공개 관찰(R1). 비밀값은 바닥선에서 제거한다. */
function observation(input: {
  goal: string;
  stepLabels: string[];
  blocked: BlockedStepFacts;
  ranBefore: string[];
  declared: { browser: boolean; screen: boolean; outward: boolean };
}): string {
  return secretValueFloor(JSON.stringify({
    surface: "graph-build-recovery",
    note:
      "These are the only known facts. Anything not listed is unknown — never assert it, and never "
      + "propose an action whose premise is not in this observation. This draft has not been saved yet, "
      + "so there is no run history; that is normal and not a failure.",
    ...input,
  })).redacted.slice(0, 8_000);
}

/**
 * 짓다 막힌 그래프에 대해 **무엇을 하면 이어갈 수 있는지** 계산한다. 실행하지 않는다.
 */
export async function planGraphBuildRecovery(input: {
  graph: WorkflowGraph | null | undefined;
  goal: string;
  blocked: BlockedStepFacts;
  /** 막히기 전까지 실제로 돌아간 단계 라벨. */
  ranBefore: string[];
  signal?: AbortSignal;
}): Promise<GraphBuildRecoveryPlan> {
  const blockedNode = (input.graph?.nodes ?? []).find((n) => n.id === input.blocked.nodeId) ?? null;
  const caps = await capabilities({ graph: input.graph, blocked: input.blocked, blockedNode });
  const decision = await judgeRequiredAction({
    kind: "graph-build-recovery",
    observation: observation({
      goal: input.goal.slice(0, 1_500),
      stepLabels: (input.graph?.nodes ?? []).map((n) => n.label || n.id).slice(0, 40),
      blocked: input.blocked,
      ranBefore: input.ranBefore,
      declared: declaredUse(input.graph),
    }),
    actions: caps.map((c) => c.option),
    locale: currentUiLocale(),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (decision.source === "unavailable") {
    return { summary: "", question: null, options: [], unavailable: true };
  }

  // 모델이 고른 것 중 **실제 능력에 매핑되는 것만** 남긴다(R2). 지어낸 id 는 사라진다.
  const chosen = decision.options.length > 0
    ? decision.options
    : (decision.actionId ? [{ actionId: decision.actionId, label: decision.summary }] : []);
  const options = chosen.flatMap((choice) => {
    const cap = caps.find((c) => c.option.id === choice.actionId);
    if (!cap) return [];
    return [{
      actionId: cap.option.id,
      kind: cap.kind,
      label: choice.label,
      ...(cap.site ? { site: cap.site } : {}),
    } satisfies GraphBuildFixOption];
  });

  return {
    summary: decision.summary,
    question: decision.question,
    options,
    unavailable: false,
  };
}

/**
 * 저장 전 검증 결과에서 **관측된 사실**을 뽑는다. 여기서 원인을 해석하지 않는다 —
 * 해석은 모델의 일이고, 이 함수의 일은 모델이 지어내지 않도록 사실을 갖춰 주는 것이다.
 */
export function blockedStepFactsFrom(input: {
  graph: WorkflowGraph | null | undefined;
  nodeId: string;
  label: string;
  cause: string;
  availableVars: string[];
  upstreamSample?: string | null;
}): BlockedStepFacts {
  const node = (input.graph?.nodes ?? []).find((n) => n.id === input.nodeId) ?? null;
  const code = str(node?.config, "code");
  const consumes = str(node?.config, "consumes");
  const wanted = new Set<string>(codeReferencedVars(code));
  if (consumes) wanted.add(consumes);
  for (const m of code.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) wanted.add(m[1]);
  return {
    nodeId: input.nodeId,
    label: input.label,
    cause: input.cause,
    wantedVars: [...wanted].sort(),
    availableVars: [...input.availableVars].sort(),
    upstreamSample: input.upstreamSample ?? null,
  };
}
