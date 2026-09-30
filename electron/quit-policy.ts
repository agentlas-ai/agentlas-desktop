// GUI quit policy — what "Quit Agentlas" does to the background service.
//
// Owner question 2026-09-30: "종료시 알아서 꺼지겠지? 좀비 없이?" Before this, every
// ordinary quit only detached agentlasd, and nothing ever stopped a detached
// service (seven QA daemons from the previous night were still alive).
//
//   login continuity OFF (default) ─ no work running  → quit, stop the service
//                                  └ work running     → ask: [작업 멈추고 종료] [백그라운드에서 계속]
//   login continuity ON                               → keep running in the menu bar / tray
//                                                       ("완전히 종료" there stops everything)
//
// "백그라운드에서 계속" also lives in the tray and quits by itself once the work is done.
// Pure logic: no Electron import, so a plain-Node gate covers every branch on
// every OS (scripts/test-quit-policy.cjs, including the Windows tray/tree-kill contract).

export type QuitPlan =
  | { kind: "quit"; daemon: "stop" | "detach" }
  | { kind: "ask"; activeWork: number }
  | { kind: "background"; activeWork: number; autoQuitWhenIdle: boolean };

export interface QuitPolicyInput {
  /** Owner opted into login continuity (Settings / Full Autonomy). */
  continuity: boolean;
  /** Running work items (GUI chats, Goals, automations, Alive, Science, service-owned work). */
  activeWork: number;
  /** A person already chose how to quit (dialog choice or tray "완전히 종료"). */
  fullQuitConfirmed: boolean;
  /** The OS is shutting down / logging out: never block or hide into the tray. */
  systemShutdown: boolean;
  /** This quit relaunches the app (update handoff refused, restart): the next GUI reattaches. */
  relaunching: boolean;
  /** No product window/shell (headless surfaces, startup failures): no prompt, no tray. */
  headless: boolean;
  /**
   * The person quit from inside the app (Cmd-Q / menu, last window closed on
   * Windows/Linux). An unattributed request (Dock menu, osascript, the logout
   * AppleEvent — macOS does not tell them apart) must not be cancelled into the
   * tray: that would abort the owner's logout.
   */
  userQuit: boolean;
}

export function planGuiQuit(input: QuitPolicyInput): QuitPlan {
  if (input.relaunching) return { kind: "quit", daemon: "detach" };
  if (input.systemShutdown) return { kind: "quit", daemon: input.continuity ? "detach" : "stop" };
  if (input.fullQuitConfirmed || input.headless) return { kind: "quit", daemon: "stop" };
  if (input.continuity) {
    return input.userQuit
      ? { kind: "background", activeWork: input.activeWork, autoQuitWhenIdle: false }
      : { kind: "quit", daemon: "detach" };
  }
  if (input.activeWork > 0) return { kind: "ask", activeWork: input.activeWork };
  return { kind: "quit", daemon: "stop" };
}

/**
 * One number for "work that quitting would stop": GUI census kinds (update-resume
 * census) plus service-owned work agentlasd reports (daemon.ping activeWork).
 * A Science turn appears on both sides; count it once. Run children belong to
 * some run already counted, so they only count when nothing else explains them.
 */
export function quitWorkCount(guiKinds: readonly string[], serviceReasons: readonly string[]): number {
  let count = guiKinds.length;
  const service = new Set(serviceReasons);
  if (service.has("science") && !guiKinds.includes("science")) count += 1;
  if (service.has("graph-run")) count += 1;
  if (service.has("local-model")) count += 1;
  if (count === 0 && service.has("run-children")) count = 1;
  return count;
}

export type QuitPromptChoice = "stop" | "background" | "cancel";

/** Button order of the quit prompt; index 0 is the default, the last one cancels. */
export const QUIT_PROMPT_CHOICES: readonly QuitPromptChoice[] = ["stop", "background", "cancel"];

export function planAfterQuitPrompt(choice: QuitPromptChoice, activeWork: number): Exclude<QuitPlan, { kind: "ask" }> | null {
  if (choice === "stop") return { kind: "quit", daemon: "stop" };
  if (choice === "background") return { kind: "background", activeWork, autoQuitWhenIdle: true };
  return null;
}

/** Tray tick: a background hold chosen for running work ends by itself when the work ends. */
export function backgroundHoldShouldQuit(hold: { autoQuitWhenIdle: boolean; continuity: boolean }, activeWork: number): boolean {
  return hold.autoQuitWhenIdle && !hold.continuity && activeWork === 0;
}

export function quitPromptText(locale: "ko" | "en", activeWork: number) {
  return locale === "ko"
    ? {
        message: `작업 ${activeWork}개가 실행 중이에요`,
        detail: "종료하면 실행 중인 작업이 멈춥니다. 백그라운드에서 계속하면 작업이 끝난 뒤 Agentlas가 스스로 종료돼요.",
        buttons: ["작업 멈추고 종료", "백그라운드에서 계속", "취소"],
      }
    : {
        message: `${activeWork} task${activeWork === 1 ? " is" : "s are"} running`,
        detail: "Quitting stops the running work. If you keep it running in the background, Agentlas quits by itself when the work is done.",
        buttons: ["Stop work and quit", "Keep running in background", "Cancel"],
      };
}

export function backgroundTrayText(locale: "ko" | "en", activeWork: number) {
  return locale === "ko"
    ? {
        status: activeWork > 0 ? `Agentlas가 백그라운드에서 실행 중 · ${activeWork}개 작업` : "Agentlas가 백그라운드에서 실행 중",
        open: "Agentlas 열기",
        quit: "완전히 종료",
      }
    : {
        status: activeWork > 0 ? `Agentlas is running in the background · ${activeWork} task${activeWork === 1 ? "" : "s"}` : "Agentlas is running in the background",
        open: "Open Agentlas",
        quit: "Quit completely",
      };
}
