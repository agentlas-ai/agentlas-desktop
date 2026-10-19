import type { OrganizationMailTransport } from '../../shared/agent-mail';
import { businessOnlyKeys, isBusinessSession, type BusinessSession } from '../../shared/business/context';

type MailRequest = Parameters<OrganizationMailTransport['request']>[0];
export const ORGANIZATION_MAIL_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_BYTES = 256 * 1024;
const BASE = 'https://organization-mail.invalid';
const ID = '[A-Za-z0-9_-]{1,64}';
const ROUTES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^mailboxes$/, ['GET', 'POST', 'PATCH']],
  [/^addresses\/(check|suggest)$/, ['GET']],
  [/^(changes|usage|unread|colleagues)$/, ['GET']],
  [/^messages$/, ['GET', 'POST']],
  [new RegExp(`^messages/${ID}$`), ['GET', 'DELETE']],
  [new RegExp(`^messages/${ID}/read$`), ['POST']],
  [/^threads$/, ['GET']],
  [new RegExp(`^threads/${ID}$`), ['GET', 'DELETE']],
  [new RegExp(`^threads/${ID}/(read|archive|status|wait)$`), ['POST']],
  [/^drafts$/, ['GET', 'POST']],
  [new RegExp(`^drafts/${ID}$`), ['GET', 'PATCH', 'DELETE']],
  [new RegExp(`^drafts/${ID}/send$`), ['POST']],
  [/^contacts$/, ['GET', 'POST']],
  [new RegExp(`^contacts/${ID}$`), ['GET', 'PATCH', 'DELETE']],
];
const QUERY_KEYS = new Set(['q', 'view', 'direction', 'limit', 'cursor', 'actor', 'since', 'mailboxId', 'localPart', 'name']);

/** This is a private Main transport, not a general browser fetch facility.
 * The server separately checks every body, current admission and recipient. */
export function organizationMailBrowserRequest(raw: unknown): Readonly<MailRequest> | null {
  if (!businessOnlyKeys(raw, ['method', 'path', 'body', 'timeoutMs', 'idempotencyKey'])
    || typeof raw.method !== 'string' || typeof raw.path !== 'string' || raw.path.length > 4096
    || !raw.path.startsWith('/api/organization-mail/') || /[\\\u0000-\u0020#]/.test(raw.path)
    || typeof raw.timeoutMs !== 'number' || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120_000
    || raw.idempotencyKey !== undefined && (typeof raw.idempotencyKey !== 'string' || !/^[A-Za-z0-9._-]{8,128}$/.test(raw.idempotencyKey))) return null;
  try {
    const url = new URL(raw.path, BASE);
    const path = raw.path.split('?', 1)[0];
    if (url.origin !== BASE || url.pathname !== path || path.includes('%')
      || !ROUTES.some(([pattern, methods]) => pattern.test(path.slice('/api/organization-mail/'.length)) && methods.includes(raw.method as string))) return null;
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (!QUERY_KEYS.has(key) || seen.has(key) || value.length > 1024 || /[\u0000-\u001f]/.test(value)) return null;
      seen.add(key);
    }
    const writeBody = raw.method === 'POST' || raw.method === 'PATCH' || raw.method === 'PUT';
    if (writeBody ? !raw.body || typeof raw.body !== 'object' || Array.isArray(raw.body) : raw.body !== undefined) return null;
    const encoded = JSON.stringify(raw);
    if (Buffer.byteLength(encoded, 'utf8') > REQUEST_BYTES) return null;
    // Snapshot before any await. Only plain JSON ever enters the owned page.
    return Object.freeze(JSON.parse(encoded) as MailRequest);
  } catch { return null; }
}

/** Cookie/Origin/Sec-Fetch stay inside the owned unprivileged HTTPS browser.
 * The expected session is an anti-confusion selector, never authentication. */
export function organizationMailBrowserScript(origin: string, session: BusinessSession, request: Readonly<MailRequest>): string {
  if (!isBusinessSession(session) || !organizationMailBrowserRequest(request)) throw Error('organization_mail_request_invalid');
  const input = JSON.stringify({ origin, session, request, cap: ORGANIZATION_MAIL_RESPONSE_BYTES });
  return `(async () => {
    const input = ${input};
    const exactPage = () => location.origin === input.origin && location.pathname === '/business';
    if (!exactPage()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.request.timeoutMs);
    try {
      const headers = { Accept: 'application/json', 'x-agentlas-mail-scope': 'organization', 'x-agentlas-mail-context': JSON.stringify(input.session) };
      if (input.request.idempotencyKey) headers['Idempotency-Key'] = input.request.idempotencyKey;
      const init = { method: input.request.method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, signal: controller.signal };
      if (input.request.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(input.request.body); }
      const response = await fetch(input.request.path, init);
      if (!response.body || !exactPage()) return null;
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > input.cap) { await reader.cancel(); return null; }
        chunks.push(chunk.value);
      }
      if (!exactPage()) return null;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    } catch { return null; } finally { clearTimeout(timer); }
  })()`;
}

export function organizationMailBrowserResponse(raw: unknown): raw is { status: number; body: unknown } {
  if (!businessOnlyKeys(raw, ['status', 'body']) || typeof raw.status !== 'number'
    || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599 || !Object.hasOwn(raw, 'body')) return false;
  try { return Buffer.byteLength(JSON.stringify(raw), 'utf8') <= ORGANIZATION_MAIL_RESPONSE_BYTES + 128; }
  catch { return false; }
}
