/*
 * 사이언스가 이 앱(Main)에게 요구하는 것을 채워 준다.
 *
 * 사이언스는 자기 저장소(agentlas-science)에 산다. 그쪽 코드는 SDK 포트를 지나서만
 * 데스크탑에 닿고, 그 포트는 Main 과 데몬이 같은 설치기 하나로 채운다
 * (`electron/science-host/install.ts` — docs/2026-10-28-science-harness-unify/PLAN.md §4 S1).
 *
 * Main 에만 있는 것은 셋이다: Main 의 실행 울타리(앱 실행 허가), 연구자 질문을 띄우는
 * 창, 그리고 앱 종료 때 정리. electron 을 싣는 것도 이 파일뿐이다 — 데몬에는 electron 이 없다.
 *
 * 부팅 때 한 번 installDesktopScienceHost() 를 부른다. 두 번째 설치는 거절된다.
 */
import { app } from "electron";

import { installScienceHostFor, type ScienceHostHandle } from "./science-host/install";
import { assertDesktopLongRunAdmissionOpen } from "./long-run/app-runtime-coordinator";
import { invocationProcessOwner } from "./store/invocation-run-owners";
import { onHostShutdown } from "./host-lifecycle";
import { notifyScienceResearcherQuestion } from "./extensions/view-host";
import * as workbookIntake from "./science-host/workbook-intake-ipc";

let host: ScienceHostHandle | null = null;

/** Main is the desktop process owner; it never holds the daemon's lease. */
function assertDesktopScienceOwner(): void {
  if (invocationProcessOwner().ownerKind !== "desktop") throw new Error("science_host_owner_changed");
}

/** Called only by Main after the verified Science renderer registers its answer UI. */
export function registerDesktopScienceResearcherQuestionUi(): void {
  if (!host) throw new Error("science-host-not-installed");
  host.registerQuestionUi();
}

/** 부팅에서 한 번만 부른다. */
export function installDesktopScienceHost(): void {
  // The SDK's data-client role remains read-only; this does not promote Main to the execution owner.
  const installed = installScienceHostFor({
    hostKind: "main",
    fence: { assertOwner: assertDesktopScienceOwner, assertExecution: assertDesktopLongRunAdmissionOpen },
    ownerEpoch: () => { const current = invocationProcessOwner(); return current.ownerKind === "desktop" ? current.ownerId : null; },
    presentQuestion: notifyScienceResearcherQuestion,
    workbook: () => workbookIntake,
  });
  host = installed;
  app.once("before-quit", () => installed.stopQuestionPresenter());
  onHostShutdown(() => installed.stop());
}
