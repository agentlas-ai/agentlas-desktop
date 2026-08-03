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
  const usesComputerUse = getAutomation(automationId)?.toolMode === "computer-use";
  const permissions = usesComputerUse && app.isPackaged ? checkComputerUsePermissions() : null;
  if (permissions && !permissions.ok) {
    list.push({
      kind: "open_mac_permissions",
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
  if (!reconciliationPending) {
    list.push({
      kind: "retry_run",
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
    option: {
      id: "ask_in_session",
      evidence:
        "Continue in this automation's own conversation, where the agent can inspect the failure and keep working with its tools.",
      authority: "local-reversible",
    },
  });

  void automationId;
  return list;
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
      navigate: "/connect",
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

  if (cap.kind === "retry_run") {
    const { runAutomationNow } = await import("./automation-scheduler");
    void runAutomationNow(automationId).catch(() => undefined);
    return {
      ok: true,
      message: ko ? "다시 실행을 시작했습니다." : "Started another run.",
      navigate: null,
      plan: null,
    };
  }

  // ask_in_session은 렌더러가 세션 대화로 이어받는다(Main이 할 일 없음).
  return { ok: true, message: "", navigate: null, plan: null };
}
