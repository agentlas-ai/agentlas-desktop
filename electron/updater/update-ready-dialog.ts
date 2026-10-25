/**
 * The "Update ready" answer of Help/Agentlas ▸ Check for Updates.
 *
 * Measured 2026-10-24 (real Windows 1.3.88 -> 1.3.89, before sign-in): the dialog said "Press the download icon at the
 * bottom of the sidebar", but the sign-in screen has no sidebar, and the only way left — quitting — was never said.
 * The dialog now carries the action itself (it works on every screen, signed in or not) and names the quit path.
 * Windows also gets the honest expectation that the silent NSIS install runs for a few minutes after the window
 * closes (measured ~2.5 min, during which only the NSIS "verifying installer" window is visible).
 *
 * Pure: no Electron import, so the wording and the button contract are tested directly.
 */
export type UpdateDialogLocale = "ko" | "en";

export interface UpdateReadyDialog {
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: 0;
  cancelId: 1;
  /** `response` value that means "install now". */
  installResponse: 0;
}

export function updateReadyDialog(version: string | undefined, locale: UpdateDialogLocale, platform: NodeJS.Platform | string): UpdateReadyDialog {
  const ko = locale === "ko";
  const v = version ? `v${version}` : ko ? "새 버전" : "The new version";
  const windowsWait = platform === "win32"
    ? (ko ? " Windows 에서는 창이 닫힌 뒤 설치가 끝나 다시 열리기까지 몇 분 걸릴 수 있어요." : " On Windows the install runs for a few minutes after the window closes, then Agentlas opens again.")
    : "";
  return {
    message: ko ? "업데이트 준비됨" : "Update ready",
    detail: ko
      ? `${v} 설치 준비가 끝났어요. [다시 시작하고 설치]를 누르면 Agentlas 가 닫히고 설치한 뒤 다시 열립니다. 나중에 Agentlas 를 끝낼 때도 설치됩니다.${windowsWait}`
      : `${v} is ready. Choose Restart and Install: Agentlas closes, installs it, and opens again. It also installs the next time you quit Agentlas.${windowsWait}`,
    buttons: ko ? ["다시 시작하고 설치", "나중에"] : ["Restart and Install", "Later"],
    defaultId: 0,
    cancelId: 1,
    installResponse: 0,
  };
}

/** Shown only when the install press was refused (the updater state says why). */
export function updateInstallRefusedDialog(locale: UpdateDialogLocale, reason: string | undefined): { message: string; detail: string } {
  const ko = locale === "ko";
  return {
    message: ko ? "지금은 설치를 시작하지 못했어요" : "The install did not start",
    detail: reason?.trim()
      || (ko ? "지금 앱은 그대로입니다. 잠시 뒤 다시 시도하거나 Agentlas 를 끝내면 설치됩니다." : "The installed app is unchanged. Try again shortly, or quit Agentlas to install it."),
  };
}
