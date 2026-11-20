/**
 * What the Science host page tells the person while its native interface is not on screen.
 *
 * The interface is a native view laid over this page, so the page is only ever seen while that view is missing, loading or retired.
 * Every one of those moments has a sentence and a way back; a blank page with no sidebar is never one of them.
 */
export type ScienceHostNotice = "loading" | "not-installed" | "open-failed" | "stopped" | "unresponsive";

export interface ScienceHostFacts {
  /** The extension is known to be missing, disabled or in need of repair. */
  unavailable: boolean;
  view: { state?: string; errorCode?: string | null } | null;
}

/** null = the native interface is ready and covers the page. */
export function scienceHostNotice(facts: ScienceHostFacts): ScienceHostNotice | null {
  if (facts.unavailable) return "not-installed";
  const view = facts.view;
  if (view?.state === "error") {
    if (view.errorCode === "science-extension-not-active") return "not-installed";
    if (view.errorCode === "science-renderer-stopped") return "stopped";
    if (view.errorCode === "science-renderer-unresponsive") return "unresponsive";
    return "open-failed";
  }
  return view?.state === "ready" ? null : "loading";
}

export interface ScienceHostCopy {
  title: string;
  body: string | null;
  /** A retry only helps when opening can be tried again. */
  retry: boolean;
  settings: boolean;
}

export function scienceHostCopy(notice: ScienceHostNotice, ko: boolean): ScienceHostCopy {
  switch (notice) {
    case "loading":
      return { title: ko ? "Science를 여는 중…" : "Opening Science…", body: null, retry: false, settings: false };
    case "not-installed":
      return {
        title: ko ? "Science가 설치되어 있지 않아요" : "Science is not installed",
        body: ko ? "설정에서 Science 확장을 설치하거나 다시 켜 주세요." : "Install or turn on the Science extension in Settings.",
        retry: false, settings: true,
      };
    case "stopped":
      return {
        title: ko ? "Science 화면이 멈췄어요" : "The Science screen stopped",
        body: ko ? "다시 열어 보세요." : "Try opening it again.",
        retry: true, settings: false,
      };
    case "unresponsive":
      return {
        title: ko ? "Science가 응답하지 않아요" : "Science is not responding",
        body: ko ? "잠시 기다리거나 다시 열어 보세요." : "Wait a moment or open it again.",
        retry: true, settings: false,
      };
    default:
      return {
        title: ko ? "Science를 열지 못했어요" : "Science could not be opened",
        body: ko ? "다시 열어 보세요. 계속되면 설정에서 Science 확장을 확인해 주세요." : "Try again. If it keeps failing, check the Science extension in Settings.",
        retry: true, settings: true,
      };
  }
}
