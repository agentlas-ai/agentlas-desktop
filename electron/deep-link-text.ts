/*
 * What the person is told when an agentlas:// link reaches the running app but is not one this app opens. Only
 * agentlas://plugin/<family>/<slug> is a link the app acts on; any other shape is refused on purpose (an outside link may not open an arbitrary
 * screen). Before, the refusal was silent: the window came forward, nothing changed and nothing was logged, so the link looked dead.
 */
export function deepLinkRefusedText(locale: "ko" | "en"): { title: string; body: string } {
  return locale === "ko"
    ? { title: "열 수 없는 링크예요", body: "이 Agentlas 링크는 이 앱이 여는 모양이 아니에요. 허브의 설치 버튼 링크만 열 수 있어요." }
    : { title: "This link cannot be opened", body: "This Agentlas link is not a kind the app opens. Only the install-button links from the Hub open here." };
}

/** The log line for a link that was refused: the shape only (scheme and first path word), never the rest of an outside address. */
export function deepLinkRefusedLogShape(rawUrl: string): string {
  const match = /^agentlas:\/\/([^/?#\s]{0,32})/i.exec(rawUrl.trim());
  return match ? `agentlas://${match[1]}/…` : "unrecognized";
}
