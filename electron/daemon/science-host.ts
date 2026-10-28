/*
 * 데몬이 사이언스 SDK 포트를 채운다. Main 과 같은 설치기 하나를 부른다
 * (`electron/science-host/install.ts` — docs/2026-10-28-science-harness-unify/PLAN.md §4 S1).
 *
 * 데몬에만 있는 것: 서비스 임대(ownerEpoch·assertOwner), 실행 허가(assertExecution),
 * 질문을 GUI 로 보내는 이벤트, 그리고 실제로 읽을 때만 싣는 워크북 모듈.
 * No Electron window, notification, or file-picker is constructed by this host.
 */
import { installScienceHostFor } from "../science-host/install";

export function installDaemonScienceHost(input: {
  ownerEpoch: string;
  assertOwner(): void;
  assertExecution(): void;
  presentQuestion(question: unknown): void;
}) {
  const host = installScienceHostFor({
    hostKind: "daemon",
    fence: { assertOwner: input.assertOwner, assertExecution: input.assertExecution },
    ownerEpoch: () => input.ownerEpoch,
    presentQuestion: input.presentQuestion,
    // These existing persisted-read functions never call a picker. Resolve them
    // only for an actual workbook read, not when loading the headless runtime.
    workbook: () => require("../science-host/workbook-intake-ipc") as typeof import("../science-host/workbook-intake-ipc"),
  });
  return { project: host.project, registerQuestionUi: host.registerQuestionUi, stopClock: host.stop };
}
