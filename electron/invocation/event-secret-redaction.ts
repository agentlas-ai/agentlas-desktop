import { redactSecrets } from "../../shared/secret-patterns";
import type { McpInvocationEvent } from "../../shared/types";

const REDACTED = "[redacted-secret]";

// Tool traces are an operational boundary, not ordinary prose. Runtime tools can
// return browser authentication material whose value does not have a recognizable
// provider-token shape (cookies, session ids, Basic/Bearer headers, URL userinfo).
// Keep these stricter rules here instead of widening shared/secret-patterns and
// accidentally dropping harmless user prose that merely discusses a session.
const HEADER_SECRET_RE =
  /\b(?:authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*(?:\\?["'][\s\S]*?\\?["']|[^\r\n,}\]]+)/gi;
const ASSIGNMENT_SECRET_RE =
  /(?:^|[\s{,;])(?:\\?["'])?(?:cookie|cookies|session|session[_-]?id|session[_-]?token)(?:\\?["'])?\s*[:=]\s*(?:\\?["'][\s\S]*?\\?["']|[^\s,;}\]]+)/gi;
const AUTH_SCHEME_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{4,}/gi;
const SECRET_FLAG_RE =
  /(^|[\s"'=:,\[{(])(--(?:cookie|session|session-id|authorization|proxy-authorization))(?:=|\s+)(?:\\?["'][\s\S]*?\\?["']|[^\s,"'}\]]+)/gim;
const URL_USERINFO_RE = /\bhttps?:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi;

export function redactOperationalSecrets(value: string): string {
  return redactSecrets(value, REDACTED)
    .replace(HEADER_SECRET_RE, (match) => {
      const splitAt = match.search(/[:=]/);
      return splitAt < 0 ? REDACTED : `${match.slice(0, splitAt + 1)} ${REDACTED}`;
    })
    .replace(ASSIGNMENT_SECRET_RE, (match) => {
      const splitAt = match.search(/[:=]/);
      return splitAt < 0 ? REDACTED : `${match.slice(0, splitAt + 1)} ${REDACTED}`;
    })
    .replace(AUTH_SCHEME_RE, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTED}`)
    .replace(SECRET_FLAG_RE, (_match, prefix: string, flag: string) => `${prefix}${flag} ${REDACTED}`)
    .replace(URL_USERINFO_RE, (match) => `${match.slice(0, match.indexOf("//") + 2)}${REDACTED}@`);
}

export function redactMcpInvocationEventSecrets(event: McpInvocationEvent): McpInvocationEvent {
  const tool = event.tool;
  const nextArgs = typeof tool?.args === "string" ? redactOperationalSecrets(tool.args) : tool?.args;
  const nextResult = typeof tool?.result === "string" ? redactOperationalSecrets(tool.result) : tool?.result;
  const nextErrorMessage = typeof event.error?.message === "string"
    ? redactOperationalSecrets(event.error.message)
    : event.error?.message;
  const nextNoticeDetails = typeof event.notice?.details === "string"
    ? redactOperationalSecrets(event.notice.details)
    : event.notice?.details;

  if (
    nextArgs === tool?.args
    && nextResult === tool?.result
    && nextErrorMessage === event.error?.message
    && nextNoticeDetails === event.notice?.details
  ) return event;

  return {
    ...event,
    ...(tool ? { tool: { ...tool, args: nextArgs, result: nextResult } } : {}),
    ...(event.error ? { error: { ...event.error, message: nextErrorMessage ?? "" } } : {}),
    ...(event.notice ? { notice: { ...event.notice, details: nextNoticeDetails } } : {}),
  };
}
