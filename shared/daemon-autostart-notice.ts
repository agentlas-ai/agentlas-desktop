/**
 * What Settings says when the "start automatically at login" switch could not be applied.
 *
 * The reason Main returns is a machine code (daemon_autostart_*, electron/daemon/autostart.ts, app-launcher.ts) or, for an OS
 * failure, a thrown message. It used to be printed after "Saved, but the login item could not be updated: " (production reading
 * about 26 codes reach that line). The code stays in the log (ipc.ts daemon:setAutostart); the screen gets one plain
 * sentence that says what to do. An unrecognised reason, or none, gets the general sentence: never the raw text.
 */
export type DaemonAutostartNoticeLocale = "ko" | "en";

type Sentence = { ko: string; en: string };

const WHERE_IT_CANNOT_START: Readonly<Record<string, Sentence>> = {
  daemon_autostart_unavailable_windows_portable: {
    ko: "이 앱은 포터블 실행 파일이라 로그인할 때 스스로 시작할 수 없습니다. 일반 설치 버전을 설치한 뒤 다시 켜 주세요.",
    en: "This copy of Agentlas is the portable version, which cannot start itself at login. Install the regular version, then turn this on.",
  },
  daemon_autostart_unavailable_linux_appimage: {
    ko: "AppImage로 실행 중이라 로그인할 때 스스로 시작할 수 없습니다. .deb 패키지로 설치한 뒤 다시 켜 주세요.",
    en: "Agentlas is running from an AppImage, which cannot start itself at login. Install the .deb package, then turn this on.",
  },
  daemon_autostart_unavailable_macos_translocated: {
    ko: "Agentlas를 응용 프로그램 폴더로 옮긴 뒤 거기서 다시 열고, 이 설정을 켜 주세요. 지금 위치에서는 로그인 시 시작이 되지 않습니다.",
    en: "Move Agentlas to the Applications folder, open it from there, then turn this on. From where it runs now it cannot start at login.",
  },
};

const WINDOWS_STARTUP_LIST: Sentence = {
  ko: "Windows가 시작 프로그램 목록에 Agentlas를 넣지 못했습니다. 잠시 뒤 다시 켜 보고, 계속 안 되면 Agentlas를 다시 시작해 주세요.",
  en: "Windows did not let Agentlas into its startup list. Turn this on again in a moment; if it keeps failing, restart Agentlas.",
};

const GENERAL: Sentence = {
  ko: "로그인 시 자동 시작을 지금 바꾸지 못했습니다. 잠시 뒤 다시 켜 보고, 계속 안 되면 Agentlas를 다시 시작해 주세요.",
  en: "Agentlas could not change the start-at-login setting just now. Turn this on again in a moment; if it keeps failing, restart Agentlas.",
};

export function daemonAutostartSentence(reason: unknown, locale: DaemonAutostartNoticeLocale): string {
  const code = typeof reason === "string" ? reason.trim() : "";
  const known = WHERE_IT_CANNOT_START[code];
  if (known) return known[locale];
  if (code.startsWith("daemon_autostart_windows_")) return WINDOWS_STARTUP_LIST[locale];
  return GENERAL[locale];
}
