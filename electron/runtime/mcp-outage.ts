/**
 * 도구 결과에서 "MCP 서버가 끊겼다"를 읽는다 — 페르소나 루프 라운드 3(2026-09-14) 실측.
 *
 * 벤더 CLI 는 프록시 자식이 죽으면 그 뒤 모든 호출에 `MCP server "cua-driver" is not connected` 를 돌려준다(한 앱 세션 안에서
 * 35건, 전부 같은 턴들의 반복 호출). 같은 턴 안에서는 호스트가 되살릴 수 없고(MCP 클라이언트는 CLI 소유), 다음 턴은 새 프록시로
 * 다시 붙는다. 그래서 할 일은 둘 — 사람에게 끊김을 한 번 말하고, 모델에게는 '변화 없음'이 아니라 도구 장애라고 알린다.
 */
const NOT_CONNECTED_RE = /MCP server "([^"\n]{1,80})" is not connected/;

export function detectMcpServerDisconnected(toolResultText: string): { serverKey: string } | null {
  const match = NOT_CONNECTED_RE.exec(String(toolResultText || ""));
  return match ? { serverKey: match[1] } : null;
}

const SERVER_LABEL: Record<string, { ko: string; en: string }> = {
  "cua-driver": { ko: "컴퓨터 유즈", en: "Computer Use" },
  "agentlas-browser": { ko: "Agentlas 브라우저", en: "Agentlas Browser" },
};

export function mcpOutageNotice(serverKey: string, locale: "ko" | "en" | undefined): { ko: string; en: string; message: string } {
  const label = SERVER_LABEL[serverKey] ?? { ko: serverKey, en: serverKey };
  const ko = `${label.ko} 도구 연결이 이 실행 중에 끊겼습니다(${serverKey}). 이 턴에서는 되살릴 수 없고, 다음 메시지부터 새로 연결합니다. 같은 도구를 반복해 부르는 대신 여기서 정리합니다.`;
  const en = `The ${label.en} tool disconnected during this run (${serverKey}). It cannot be revived inside this turn; the next message reconnects it. Instead of calling the same tool again, this turn wraps up here.`;
  return { ko, en, message: locale === "ko" ? ko : en };
}

/** 모델용 한 줄 — 시스템 프롬프트 꼬리에 붙는다. */
export function toolOutageGuidance(locale: "ko" | "en" | undefined): string {
  return locale === "ko"
    ? `\n\n[도구 장애] 도구 결과가 'MCP server "…" is not connected' 이면 그 도구는 이 턴 내내 죽은 것이다 — 같은 도구를 다시 부르거나 "변화 없음"을 반복하지 마라. 어떤 도구가 끊겨 무엇을 못 했는지 한 번 적고 이 턴을 끝내라. 다음 메시지에서 호스트가 다시 연결한다.`
    : `\n\n[Tool outage] If a tool result says 'MCP server "…" is not connected', that tool is down for the rest of this turn — do not call it again or repeat "no change". State once which tool is down and what could not be done, then end the turn. The host reconnects it on the next message.`;
}
