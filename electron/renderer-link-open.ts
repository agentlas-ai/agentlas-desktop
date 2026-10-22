import { externalOpenSuppressedForTest, noteSuppressedExternalOpen } from "./external-open-test-guard";

/**
 * A link a person clicks in one of the app's own windows (a filing, a news headline, an original post) is handed to their default browser. An automated
 * run on that person's desktop must not open a window there, so a rig's AGENTLAS_E2E_NO_OPEN_EXTERNAL=1 turns the hand-off off and the click is only noted
 * (origin and path, never the query). The window's own development policy is checked by the caller; the switch can only turn the effect off.
 * Returns whether the page was handed to the browser.
 */
export function openRendererLink(url: string, open: (url: string) => unknown): boolean {
  if (!/^https?:\/\//.test(url)) return false;
  if (externalOpenSuppressedForTest()) { noteSuppressedExternalOpen(url); return false; }
  void open(url);
  return true;
}
