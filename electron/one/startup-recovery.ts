import fs from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { judgeRequiredAction, secretValueFloor, type RequiredActionOption } from "../system-agents/judgment";
import type { RuntimeLocale } from "../runtime/status-i18n";
import { userDataDir } from "../runtime-paths";

const DISPOSABLE_DIRS = ["Cache", "Code Cache", "GPUCache"] as const;

function containedDisposableDirs(): string[] {
  const root = path.resolve(userDataDir());
  const prefix = `${root}${path.sep}`;
  const out: string[] = [];
  for (const name of DISPOSABLE_DIRS) {
    const target = path.resolve(root, name);
    if (!target.startsWith(prefix)) continue;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      out.push(target);
    } catch {
      // Missing cache is not a capability.
    }
  }
  return out;
}

function filesystemEvidence(): Record<string, number | null> {
  try {
    const stat = fs.statfsSync(userDataDir());
    return {
      availableBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
    };
  } catch {
    return { availableBytes: null, totalBytes: null };
  }
}

function observation(error: unknown, attempt: number, cacheTargets: string[]): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  const safe = secretValueFloor(raw).redacted;
  return JSON.stringify({
    stage: "desktop-startup",
    operation: "open-operational-store",
    attempt,
    observedFailure: safe.slice(0, 2_000),
    filesystem: filesystemEvidence(),
    disposableCacheLocationsAvailable: cacheTargets.length,
  });
}

function clearDisposableCaches(targets: string[]): void {
  for (const target of targets) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}

export interface StartupRecoveryPresentation {
  summary: string;
  question: string | null;
  options: Array<{ actionId: string; label: string }>;
}

/**
 * 판정 모델 없이 띄우는 복구 화면.
 *
 * 문구는 조치 자체에서 나온다 — 무엇이 잘못됐는지 진단하지 않고, **무엇을 할 수 있는지**만
 * 말한다. 진단은 모델의 몫이고 없으면 생략하면 되지만, 길은 없으면 안 된다.
 */
function plainRecovery(actions: RequiredActionOption[], locale: "ko" | "en"): StartupRecoveryPresentation {
  const label = (id: string): string => {
    if (locale === "ko") {
      if (id === "retry_startup") return "다시 시도";
      if (id === "clear_disposable_app_caches") return "임시 파일 비우고 다시 시도";
      if (id === "open_app_data_folder") return "앱 데이터 폴더 열기";
      return id;
    }
    if (id === "retry_startup") return "Try again";
    if (id === "clear_disposable_app_caches") return "Clear temporary files and try again";
    if (id === "open_app_data_folder") return "Open the app data folder";
    return id;
  };
  return {
    summary: locale === "ko"
      ? "앱을 여는 중에 멈췄습니다. 대화·에이전트·설정은 그대로 있습니다."
      : "Something stopped while opening the app. Your conversations, agents, and settings are untouched.",
    question: locale === "ko" ? "무엇을 해볼까요?" : "What would you like to try?",
    options: actions.map((action) => ({ actionId: action.id, label: label(action.id) })),
  };
}

/**
 * DB-independent One recovery loop. Subsystems expose facts and executable
 * capabilities; One chooses. Code contains no error-case router, dictionary,
 * default action, or customer-facing diagnosis.
 */
export async function recoverDesktopStartup(input: {
  error: unknown;
  retry: () => Promise<void> | void;
  present: (presentation: StartupRecoveryPresentation) => Promise<string | null> | string | null;
  locale?: RuntimeLocale;
}): Promise<boolean> {
  let currentError = input.error;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const cacheTargets = containedDisposableDirs();
    const actions: RequiredActionOption[] = [
      {
        id: "retry_startup",
        evidence: "Retry the same startup operation without changing user data.",
        authority: "local-reversible",
      },
      ...(cacheTargets.length > 0
        ? [{
            id: "clear_disposable_app_caches",
            evidence: `Remove ${cacheTargets.length} app-owned disposable cache directories, then retry. Project files, account state, conversations, agents, and the operational store are excluded.`,
            authority: "local-reversible" as const,
          }]
        : []),
      {
        id: "open_app_data_folder",
        evidence: "Open the app-owned data folder in Finder so the person can inspect or resolve a local file conflict. This does not change any file.",
        authority: "observe",
      },
    ];
    const decision = await judgeRequiredAction({
      kind: "desktop-startup-recovery",
      observation: observation(currentError, attempt, cacheTargets),
      actions,
      ...(input.locale ? { locale: input.locale } : {}),
    });
    /*
     * ★판정이 없다고 화면까지 없애지 않는다 (실측 2026-08-27).
     *
     * 예전에는 `decision.source !== "llm"` 이면 곧바로 false 를 돌려줬다. 그러면 창은 떠
     * 있는데 아무 글도 버튼도 없는 채로 앱이 영영 안 켜진다 — 오너 기기에서 정확히 그랬고,
     * 로그에는 이 함수의 흔적이 한 줄도 없었다. 사람이 35분 뒤 직접 다시 켜서야 살아났다.
     *
     * 판정 모델은 **글을 다듬는 역할**이지 길을 여는 열쇠가 아니다. 할 수 있는 조치는
     * 이미 위에서 코드가 정해 놓았고(다시 시도 · 버릴 수 있는 캐시 비우기 · 폴더 열기)
     * 어느 것도 모델이 필요 없다. 모델이 없으면 그 목록을 그대로 사람에게 보여 주고
     * 고르게 한다. 모델이 답하면 종전대로 그 설명을 쓴다.
     *
     * 모델이 못 오는 상황은 드물지 않다 — 로그인 전, 오프라인, 사용량 한도(이 제품에서
     * 실제로 관측된다). 하필 그때 앱이 안 켜지면 빠져나갈 길이 하나도 없어진다.
     */
    const judged = decision.source === "llm";
    const presentation: StartupRecoveryPresentation = judged
      ? { summary: decision.summary, question: decision.question, options: decision.options }
      : plainRecovery(actions, input.locale === "ko" ? "ko" : "en");
    const selectedByPerson = await input.present(presentation);
    const actionId = (judged ? decision.actionId : null) ?? selectedByPerson;
    if (!actionId || !actions.some((action) => action.id === actionId)) return false;
    if (actionId === "open_app_data_folder") {
      await shell.openPath(userDataDir()).catch(() => undefined);
      continue;
    }
    if (actionId === "clear_disposable_app_caches") clearDisposableCaches(cacheTargets);
    try {
      await input.retry();
      return true;
    } catch (error) {
      currentError = error;
    }
  }
  return false;
}
