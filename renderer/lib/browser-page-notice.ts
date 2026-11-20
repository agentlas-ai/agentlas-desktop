/*
 * What the built-in browser says about the page of the shown tab, in a few words: a page that failed to open says so with the reason Main gave, and one that is
 * still loading after a while says it is slow. A page that loaded but draws nothing (a site that blocks embedded browsers) is not detectable from here: that is an environment fact.
 */
export const BROWSER_SLOW_LOAD_MS = 15_000;

export function browserPageNotice(status: { state?: string; error?: string } | null | undefined, loadingForMs: number, ko: boolean): string | null {
  if (!status) return null;
  if (status.state === "error") {
    const reason = (status.error ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${ko ? "페이지를 열지 못했어요" : "The page did not open"}${reason ? ` · ${reason}` : ""}`;
  }
  if ((status.state === "loading" || status.state === "opening") && loadingForMs >= BROWSER_SLOW_LOAD_MS) return ko ? "아직 불러오는 중이에요 · 사이트가 느리거나 막았을 수 있어요" : "Still loading · the site may be slow or blocking it";
  return null;
}
