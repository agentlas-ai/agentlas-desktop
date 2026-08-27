// 자동화가 멈췄을 때 "무엇을 해야 하는지"까지 책임지는 복구 서비스.
//
// 계약(전 제품 공통, hephaestus-recovery.ts와 같은 형태):
//   1) 코드는 **사실**만 모은다(마지막 실패 기록, 브라우저 세션 상태, macOS 권한, 로그인,
//      런타임 준비 상태). 키워드·정규식·에러 사전으로 원인을 분류하지 않는다.
//   2) 코드는 지금 이 상황에서 **실제로 실행 가능한 조치의 유한 목록**을 만든다.
//   3) 모델이 그중 하나를 고르고 사용자 문구를 쓴다. 목록 밖의 값은 실행되지 않는다.
//   4) 되돌릴 수 있는 조치는 Main이 스스로 실행하고, 외부 효과가 있는 조치(다시 실행 등)는
//      반드시 사용자가 먼저 누르게 한다.
//
// 판정 런타임이 없으면 조치를 지어내지 않는다 — unavailable로 정직하게 내려간다.
import { app, shell } from "electron";
import type {
  AutomationFixKind,
  AutomationFixOption,
  AutomationFixPlan,
  AutomationFixResult,
} from "../shared/types";
import { findGraphContradictions, requiredPermissionFor } from "../shared/graph-contradictions";
import { judgeRequiredAction, secretValueFloor, type RequiredActionOption } from "./system-agents/judgment";
import { checkComputerUsePermissions } from "./mac-permissions";
import { getBrowserStatus, browserListSites, browserOpenLogin } from "./browser/connect";
import type { BrowserSiteRow } from "./store/browser-vault";
import { getAutomation, listRunHistory } from "./store/automations";
import { listTriggerEventAttention } from "./store/trigger-events";
import { getAutomationGraphReconciliation } from "./store/graph-reconciliation";
import { getAuthSession, signInWithBrowser } from "./auth";
import { currentUiLocale } from "./ui-locale";

/** macOS 개인정보 보호 및 보안 > 손쉬운 사용. */
const MAC_ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

interface Capability {
  option: RequiredActionOption;
  kind: AutomationFixKind;
  /** browser_login 전용 — 어느 사이트의 로그인 창을 열지. */
  site?: string;
  /**
   * ★이 조치가 **무엇에 관한 것인가** — 필수다. 예전에는 조치 7개가 각자 알아서 관련성을
   * 판단했다: 하나(open_mac_permissions)는 제대로 좁혔고, 하나(browser_login)는 아예 안
   * 좁혀서 브라우저를 안 쓰는 자동화에도 "로그인하세요"가 떴고, 나머지는 그 질문 자체가
   * 없었다. 관련성 판단을 조치에서 빼내 한 곳(아래 필터)으로 모으고, 이 필드를 필수로 만들어
   * 8번째 조치가 생겨도 선언 없이는 컴파일되지 않게 한다. 오류는 무한하지만 행동은 유한하다.
   */
  relevantTo: "browser" | "screen" | "always";
}

function siteActionId(site: string): string {
  return `browser_login:${site}`;
}

/**
 * 지금 이 순간 실제로 실행할 수 있는 조치만 만든다. 없는 능력을 목록에 넣으면 모델이
 * 고르고 사용자는 눌러도 아무 일이 없는 버튼을 만나게 된다.
 */
async function capabilities(automationId: string): Promise<Capability[]> {
  const list: Capability[] = [];
  // 이 자동화가 실제로 무엇을 쓰는가 — **선언된 사실**로만 계산한다(사람이 고른 toolMode).
  // 이름·키워드로 추측하지 않는다. 모르면 좁히지 않는다(false가 아니라 보수적으로 둘 다 false:
  // toolMode가 없으면 브라우저도 화면도 "쓴다고 선언된 적 없음"이다).
  const automation = getAutomation(automationId);
  const uses: Record<"browser" | "screen", boolean> = {
    browser: automation?.toolMode === "browser",
    screen: automation?.toolMode === "computer-use",
  };

  let sites: BrowserSiteRow[] = [];
  try {
    sites = await browserListSites();
  } catch {
    sites = [];
  }
  const browser = (() => {
    try {
      return getBrowserStatus();
    } catch {
      return null;
    }
  })();

  if (browser?.chromeFound) {
    for (const site of sites) {
      if (site.session.status === "valid") continue;
      list.push({
        kind: "browser_login",
        relevantTo: "browser",
        site: site.site,
        option: {
          id: siteActionId(site.site),
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
      relevantTo: "browser",
      option: {
        id: "open_browser_setup",
        evidence:
          "No usable Chrome/Edge was found for browser automation. Open the in-app Connect screen where the person sets the browser up. Nothing is changed by opening it.",
        authority: "local-reversible",
      },
    });
  }

  // 화면 제어 권한은 **이 자동화가 실제로 화면을 조작할 때만** 관련 있는 사실이다.
  // 브라우저/셸로 도는 자동화에 이 사실을 끼워 넣으면, 모델은 틀린 전제 위에서
  // 그럴듯하지만 엉뚱한 조치("손쉬운 사용을 켜세요")를 고른다.
  // 또한 macOS 권한은 앱 번들 단위라, 소스로 띄운 개발 실행의 상태는 설치본과 다르다.
  // 미패키지 실행에서 읽은 값은 사용자의 실제 설정에 대한 근거가 아니므로 아예 넣지 않는다.
  const permissions = uses.screen && app.isPackaged ? checkComputerUsePermissions() : null;
  if (permissions && !permissions.ok) {
    list.push({
      kind: "open_mac_permissions",
      relevantTo: "screen",
      option: {
        id: "open_mac_permissions",
        evidence:
          `This automation drives the screen, and macOS is withholding ${permissions.missing.join(" and ")}, so it cannot run. `
          + "Open the exact macOS privacy settings page. The person grants it themselves.",
        authority: "local-reversible",
      },
    });
  }

  const session = (() => {
    try {
      return getAuthSession();
    } catch {
      return null;
    }
  })();
  if (!session?.signedIn) {
    list.push({
      kind: "agentlas_sign_in",
      relevantTo: "always",
      option: {
        id: "agentlas_sign_in",
        evidence:
          "The Agentlas account session is not signed in, so account-backed steps cannot be authorized. Start the normal sign-in in the person's browser.",
        authority: "local-reversible",
      },
    });
  }

  list.push({
    kind: "repair_runtime",
    relevantTo: "always",
    option: {
      id: "repair_runtime",
      evidence:
        "Run the digest-verified Agentlas OS runtime updater and self-check. This does not touch the person's data and is safe to repeat.",
      authority: "local-reversible",
    },
  });

  // 미확정 부작용이 남아 있으면 재실행은 백엔드가 즉시 거부한다. 그런 상태에서 이 조치를
  // 목록에 넣으면 모델이 "다시 실행해 볼까요?"라고 권하고, 사용자는 눌러도 아무 일이 없다.
  const reconciliationPending = (() => {
    try {
      return Boolean(getAutomationGraphReconciliation(automationId));
    } catch {
      return false;
    }
  })();
  /*
   * ★"평상시마다 실패하는 모양"은 다시 실행해도 낫지 않는 유일한 부류다.
   *   실측 2026-08-20: 임계값 감시 자동화가 조용한 날(=대부분의 날)마다 죽었는데,
   *   계산은 매번 정확했다. 갈림길이 "비어 있을 수 있다"고 말한 값에 그 앞의 검증이
   *   "비어 있으면 안 된다"고 하고 있었다. 이 상태에서 재실행을 권하면 사람은
   *   같은 실패를 계속 다시 만들 뿐이다 — 그래서 사실로 모아 조치로 낸다.
   */
  const shapeIssues = (() => {
    try {
      // ★되돌이 판정은 커널의 것을 그대로 쓴다 — 규칙 사본을 두지 않는다.
      const { planGraphLoops } = require("./workflow/run-graph") as typeof import("./workflow/run-graph");
      return findGraphContradictions(getAutomation(automationId)?.graph ?? null, planGraphLoops);
    } catch {
      return [];
    }
  })();
  /*
   * ★읽기 전용으로 저장된 자동화가 "바깥을 바꾸는" 단계를 갖고 있으면, 그 단계는 부를 수
   *   있는 도구가 하나도 없는 상태로 매번 실행된다. 실측 2026-08-20: 저장된 10개 중 3개가
   *   이 상태였고, 실패 문구는 모델을 탓하고 있었다("도구를 한 번도 호출하지 않았습니다").
   *   실행 중에 사람을 세워 물을 일이 아니라, 여기서 한 번 받아 저장할 일이다.
   */
  const permissionGap = (() => {
    try {
      const row = getAutomation(automationId);
      return requiredPermissionFor(row?.graph ?? null, row?.executionPermission ?? null);
    } catch {
      return null;
    }
  })();
  if (permissionGap) {
    list.push({
      kind: "grant_execution_permission",
      relevantTo: "always",
      option: {
        id: "grant_execution_permission",
        evidence:
          `This automation is saved as read-only, but ${permissionGap.because.length} step(s) declare that they change `
          + `things outside (${permissionGap.because.slice(0, 3).join(", ")}). Those steps run with no tool they are allowed `
          + "to call, so the run fails every time. Granting write once, here, settles it — the run is never interrupted to ask.",
        authority: "local-reversible",
      },
    });
  }

  if (shapeIssues.length > 0) {
    list.push({
      kind: "repair_graph_shape",
      relevantTo: "always",
      option: {
        id: "repair_graph_shape",
        evidence:
          `This automation fails on ordinary days by construction: ${shapeIssues[0].reason} `
          + "Re-running cannot help. The repair moves that verification inside the branch that has a value.",
        authority: "local-reversible",
      },
    });
  }

  if (!reconciliationPending) {
    list.push({
      kind: "retry_run",
      relevantTo: "always",
      option: {
        id: "retry_run",
        evidence:
          "Run this automation again right now. It can act outside the app (post, send, write), so the person must choose it deliberately.",
        authority: "external-or-destructive",
      },
    });
  }

  list.push({
    kind: "ask_in_session",
    relevantTo: "always",
    option: {
      id: "ask_in_session",
      evidence:
        "Continue in this automation's own conversation, where the agent can inspect the failure and keep working with its tools.",
      authority: "local-reversible",
    },
  });

  // ★관련성 필터 — 한 곳에서. 이 자동화가 안 쓰는 것에 대한 조치는 후보에 아예 안 올린다.
  //   "브라우저 안 쓰는데 로그인하세요"는 틀린 전제를 모델에게 주는 것이고, 모델은 그 위에서
  //   그럴듯하지만 엉뚱한 조치를 고른다(open_mac_permissions 주석의 실측과 같은 병).
  return list.filter((cap) => cap.relevantTo === "always" || uses[cap.relevantTo]);
}

/** 모델에게 넘기는 비공개 관찰. 비밀값은 바닥선에서 제거한다. */
function observation(input: {
  automationName: string;
  scheduleHuman: string;
  /** 이 자동화가 무엇을 하는지. 없으면 모델은 어떤 사이트·계정이 관련 있는지 알 수 없다. */
  whatItDoes: string;
  runTool: string;
  steps: string[];
  recentRuns: Array<{ status: string; error: string | null; ranAt: string }>;
  parkedEvents: Array<{ lastError: string; attemptCount: number }>;
  browserSites: Array<{ site: string; session: string }>;
  browserFound: boolean;
  /** null이면 "이 자동화와 무관하거나 판단 근거 없음" — 권한이 있다는 뜻이 아니다. */
  screenPermissionsMissing: string[] | null;
  signedIn: boolean;
  /** true면 사람이 각 단계의 실제 실행 여부를 확정하기 전까지 어떤 재실행도 거부된다. */
  awaitingHumanConfirmation: boolean;
}): string {
  return secretValueFloor(JSON.stringify({
    surface: "automation-recovery",
    // 관찰에 없는 것은 "모름"이다. 이 문장이 없으면 모델이 빈칸을 그럴듯한 추측으로 메운다.
    note: "These are the only known facts. Anything not listed is unknown — never assert it, and never propose an action whose premise is not in this observation.",
    ...input,
  })).redacted.slice(0, 8_000);
}

function toOptions(caps: Capability[], picked: Array<{ actionId: string; label: string }>): AutomationFixOption[] {
  return picked.flatMap((choice) => {
    const cap = caps.find((c) => c.option.id === choice.actionId);
    if (!cap) return [];
    return [{
      actionId: cap.option.id,
      kind: cap.kind,
      label: choice.label,
      requiresConfirmation: cap.option.authority === "external-or-destructive",
    }];
  });
}

/**
 * 이 자동화가 왜 멈췄고 지금 무엇을 누르면 되는지 계산한다. 실행은 하지 않는다
 * (실행은 applyAutomationFix — 사용자가 눌렀을 때만).
 */
export async function planAutomationFix(automationId: string): Promise<AutomationFixPlan> {
  const automation = getAutomation(automationId);
  const empty: AutomationFixPlan = {
    automationId,
    summary: "",
    question: null,
    options: [],
    applied: null,
    unavailable: true,
  };
  if (!automation) return empty;

  const caps = await capabilities(automationId);
  const runs = listRunHistory(automationId, 6);
  const attentions = (() => {
    try {
      return listTriggerEventAttention(automationId);
    } catch {
      return [];
    }
  })();
  const sites = await browserListSites().catch(() => [] as BrowserSiteRow[]);
  const usesComputerUse = automation.toolMode === "computer-use";
  const permissions = usesComputerUse && app.isPackaged ? checkComputerUsePermissions() : null;
  const signedIn = (() => {
    try {
      return getAuthSession().signedIn === true;
    } catch {
      return false;
    }
  })();

  const decision = await judgeRequiredAction({
    kind: "automation-recovery",
    observation: observation({
      automationName: automation.name,
      scheduleHuman: automation.scheduleHuman,
      whatItDoes: automation.promptTemplate.slice(0, 1_500),
      runTool: automation.toolMode ?? "auto",
      steps: (automation.graph?.nodes ?? []).map((node) => `${node.type}: ${node.label ?? ""}`.trim()).slice(0, 20),
      recentRuns: runs.map((run) => ({ status: run.status, error: run.error, ranAt: run.ranAt })),
      parkedEvents: attentions.map((event) => ({ lastError: event.lastError, attemptCount: event.attemptCount })),
      browserSites: sites.map((site) => ({ site: site.site, session: site.session.status })),
      browserFound: (() => {
        try {
          return getBrowserStatus().chromeFound;
        } catch {
          return false;
        }
      })(),
      screenPermissionsMissing: permissions ? permissions.missing : null,
      signedIn,
      awaitingHumanConfirmation: (() => {
        try {
          return Boolean(getAutomationGraphReconciliation(automationId));
        } catch {
          return false;
        }
      })(),
    }),
    actions: caps.map((cap) => cap.option),
    locale: currentUiLocale(),
    runtimeSelection: automation.runtimeSelection,
  });

  if (decision.source !== "llm") return empty;

  // 단일 조치를 고른 경우에도 사용자가 누를 버튼으로 제시한다. 이 화면의 조치는 전부
  // 사람이 자기 손으로 하는 것(로그인 창, 시스템 설정, 재실행)이라 대신 눌러주지 않는다.
  const picked = decision.actionId
    ? [{ actionId: decision.actionId, label: decision.summary.slice(0, 120) }]
    : decision.options;

  return {
    automationId,
    summary: decision.summary,
    question: decision.question,
    options: toOptions(caps, picked),
    applied: null,
    unavailable: false,
  };
}

/** 사용자가 고른 조치를 실행한다. 목록에 없는 id는 아무것도 하지 않는다. */
export async function applyAutomationFix(
  automationId: string,
  actionId: string,
): Promise<AutomationFixResult> {
  const ko = currentUiLocale() === "ko";
  const caps = await capabilities(automationId);
  const cap = caps.find((c) => c.option.id === actionId);
  if (!cap) {
    return {
      ok: false,
      message: ko ? "이 조치는 지금 실행할 수 없습니다." : "That action is not available right now.",
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "browser_login" && cap.site) {
    const result = await browserOpenLogin(cap.site);
    return {
      ok: result.ok,
      message: result.ok
        ? ko
          ? `${cap.site} 로그인 창을 열었습니다. 로그인만 마치면 다음 예약부터 이어서 실행됩니다.`
          : `Opened the sign-in window for ${cap.site}. Finish signing in and the next run continues on its own.`
        : ko
          ? "로그인 창을 열지 못했습니다."
          : "The sign-in window could not be opened.",
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "open_browser_setup") {
    return {
      ok: true,
      message: ko ? "브라우저 설정 화면을 엽니다." : "Opening the browser setup screen.",
      // 예전엔 /connect(텔레그램 화면)를 열고 있었다 — 브라우저 설정은 /browser 다.
      navigate: "/browser",
      plan: null,
    };
  }

  if (cap.kind === "open_mac_permissions") {
    await shell.openExternal(MAC_ACCESSIBILITY_PANE).catch(() => undefined);
    return {
      ok: true,
      message: ko
        ? "macOS 설정을 열었습니다. Agentlas를 켜 주시면 다음 예약부터 다시 시도합니다."
        : "Opened macOS settings. Turn Agentlas on and the next run retries automatically.",
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "agentlas_sign_in") {
    const session = await signInWithBrowser().catch(() => null);
    return {
      ok: session?.signedIn === true,
      message: session?.signedIn
        ? ko ? "로그인했습니다." : "Signed in."
        : ko ? "로그인이 완료되지 않았습니다." : "Sign-in did not complete.",
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "repair_runtime") {
    const { recoverHephaestusRuntime } = await import("./one/hephaestus-recovery");
    const recovery = await recoverHephaestusRuntime({ locale: currentUiLocale() });
    return {
      ok: recovery.verified,
      message: recovery.verified
        ? ko ? "실행 환경을 복구했습니다." : "The runtime is repaired."
        : recovery.presentation?.summary
          || (ko ? "실행 환경을 자동으로 고치지 못했습니다." : "The runtime could not be repaired automatically."),
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "grant_execution_permission") {
    const row = getAutomation(automationId);
    const gap = requiredPermissionFor(row?.graph ?? null, row?.executionPermission ?? null);
    if (!gap) {
      return {
        ok: false,
        message: ko
          ? "권한을 올릴 이유를 찾지 못했습니다 — 이미 충분하거나, 바깥을 바꾸는 단계가 없습니다."
          : "No permission gap found — it is already sufficient, or no step changes anything outside.",
        navigate: null,
        plan: null,
      };
    }
    const { updateAutomation } = await import("./store/automations");
    const updated = updateAutomation(automationId, { executionPermission: gap.needs });
    /*
     * ★권한은 실행 digest 에 들어 있다(graph-execution-digest.ts:45). 그래서 허용만 해도
     *   digest 가 바뀌고, 이미 부수효과를 낸 실행이 있으면 다음 실행이 곧바로
     *   `automation_partial_graph_changed` 로 막힌다 — 방금 고친 사람이 한 발도 못 나간다
     *   (실측 2026-08-20: 이 조치를 만든 직후 그대로 재현됐다).
     *
     *   권한을 올리는 것은 **일이 바뀐 것이 아니라 사람이 허락한 것**이다. 단계도,
     *   하는 일도 그대로다. 그러니 그 사실을 재개 좌표에 반영해 준다 — 사람의 결정이
     *   그래프를 바꾼 것처럼 취급되지 않게(같은 교훈: 승인은 실행 밖 기록에 남긴다).
     */
    if (updated?.graph) {
      const { graphExecutionDigest } = await import("../shared/graph-execution-digest");
      const { rebaseGraphDigestAfterAuthorization } = await import("./store/automations");
      rebaseGraphDigestAfterAuthorization(automationId, graphExecutionDigest(updated, updated.graph));
    }
    return {
      ok: true,
      message: ko
        ? `이 자동화에 쓰기를 허용했습니다. ${gap.because.length}개 단계가 이제 도구를 부를 수 있고, 다음부터는 실행 중에 묻지 않습니다.`
        : `Write is granted for this automation. ${gap.because.length} step(s) can now call tools, and runs are no longer interrupted to ask.`,
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "repair_graph_shape") {
    const { repairGraphContradictions } = await import("../shared/graph-contradictions");
    const repair = repairGraphContradictions(getAutomation(automationId)?.graph ?? null);
    if (!repair.changed || !repair.graph) {
      return {
        ok: false,
        message: ko
          ? "고칠 모양을 찾지 못했습니다 — 이미 고쳐졌거나, 자동으로 옮길 수 없는 형태입니다."
          : "Nothing to repair — it is already fixed, or the shape cannot be moved automatically.",
        navigate: null,
        plan: null,
      };
    }
    const { updateAutomationGraph } = await import("./store/automations");
    updateAutomationGraph(automationId, repair.graph, { note: "평상시 실패로 이어지던 검증 위치를 고쳤습니다." });
    return {
      ok: true,
      message: ko
        ? `검증 ${repair.movedNodeIds.length}개를 값이 있는 쪽 가지 안으로 옮겼습니다. 이제 알릴 것이 없는 날에도 정상으로 끝납니다.`
        : `Moved ${repair.movedNodeIds.length} verification step(s) inside the branch that has a value. Quiet days now finish normally.`,
      navigate: null,
      plan: null,
    };
  }

  if (cap.kind === "retry_run") {
    const { runAutomationNow } = await import("./automation-scheduler");
    const result = await runAutomationNow(automationId);
    return {
      ok: result.accepted && result.status === "ok",
      message: result.accepted
        ? result.status === "ok"
          ? ko ? "다시 실행을 완료했습니다." : "The run completed."
          : result.error || (ko ? "다시 실행했지만 완료되지 않았습니다." : "The retry did not complete.")
        : ko ? "다른 실행이 진행 중이라 다시 실행하지 않았습니다." : "Another run is active, so the retry was not accepted.",
      navigate: null,
      plan: null,
    };
  }

  // ask_in_session은 렌더러가 세션 대화로 이어받는다(Main이 할 일 없음).
  return { ok: true, message: "", navigate: null, plan: null };
}
