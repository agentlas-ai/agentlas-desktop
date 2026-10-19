import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { isBusinessSession, businessOnlyKeys, type BusinessSession } from '../../shared/business/context';
import { businessEmployeeAgentNativeDigest as digest } from './employee-agent-report-adapter';
import type { CompanyNativeBrowserPort } from './company-native-browser';
import { currentOrganizationMailSelection, withAgentMailExecutionScope, agentMailStatus, agentMailIssue, agentMailThreads, agentMailThread, agentMailSend, agentMailColleagues } from '../agent-mail/client';
import { agentMailDelegate } from '../agent-mail/sync';
import type { AgentMailSendInput, AgentMailThreadsInput } from '../../shared/agent-mail';
import type { CompanyNativeOriginal } from './company-native-owner';
import { isAppControlEvent } from '../app-control/ipc-registry';

/** The displayed session is only an expected-context fence. The owned browser,
 * current selected transport and the original server issue every authority. */
export function registerCompanyMailMain(input: { ipc: Pick<IpcMain, 'handle'>; browser: CompanyNativeBrowserPort;
  companyOriginal(): CompanyNativeOriginal | null;
  assertTrustedSender(event: IpcMainInvokeEvent): BrowserWindow; isOwnerWindow(window: BrowserWindow): boolean }) {
  const references = [input.ipc, input.browser, input.browser.currentSession, input.assertTrustedSender, input.isOwnerWindow, input.companyOriginal];
  const fail = (): never => { throw Error('company_mail_context_changed'); };
  const refs = () => { if ([input.ipc, input.browser, input.browser.currentSession, input.assertTrustedSender, input.isOwnerWindow, input.companyOriginal].some((v, i) => v !== references[i])) fail(); };
  async function run(event: IpcMainInvokeEvent, session: unknown, operation: string, value: unknown) {
    let dispatched = false;
    let outbox: { owner: CompanyNativeOriginal; id: string; body: string; bodyDigest: string } | null = null;
    try {
      refs(); if (!isBusinessSession(session)) fail(); const expected = structuredClone(session as BusinessSession);
      const window = input.assertTrustedSender(event), sender = event.sender, frame = event.senderFrame, frameUrl = frame?.url;
      const focused = () => { refs(); if (isAppControlEvent(event) || window.isDestroyed() || !window.isFocused() || !input.isOwnerWindow(window) || sender.isDestroyed() || window.webContents !== sender || input.assertTrustedSender(event) !== window
        || event.senderFrame !== frame || frame !== sender.mainFrame || frame?.url !== frameUrl || (require('electron') as typeof import('electron')).BrowserWindow.fromWebContents(sender) !== window) fail(); };
      focused();
      const checkBrowser = async () => { const current = await input.browser.currentSession(); focused(); if (!current || digest(current) !== digest(expected)) fail(); };
      await checkBrowser(); const selection = currentOrganizationMailSelection();
      if (!selection || selection.organizationId !== expected.organizationId || selection.principalId !== expected.principalId || selection.expiresAt !== expected.expiresAt) fail();
      const selected = selection!;
      const checkSelection = () => { const current = currentOrganizationMailSelection(); focused(); if (!current || digest(current) !== digest(selected)) fail(); };
      checkSelection();
      const scopeDigest = digest([expected.deploymentId, expected.identityAuthorityId, expected.organizationId, expected.principalId]);
      const company = () => { const owner = input.companyOriginal(); if (!owner) fail(); owner!.assertCurrent();
        const a = owner!.connection.current(); if (!a || digest(a.orgSession) !== digest(expected)) fail();
        return owner!; };
      if (operation === 'send' || operation === 'pending') { const owner = company(); await owner.connection.refresh();
        if (company().identityOwner !== owner.identityOwner) fail(); checkSelection(); }
      const schema = (owner: CompanyNativeOriginal) => owner.db.exec(`CREATE TABLE IF NOT EXISTS company_mail_pending(
        request_id TEXT PRIMARY KEY,scope_digest TEXT NOT NULL,request_key TEXT NOT NULL,body_json TEXT NOT NULL,body_digest TEXT NOT NULL,state TEXT NOT NULL);`);
      const originalSend = (raw: unknown): AgentMailSendInput => {
        const owner = company(); schema(owner);
        const value = JSON.parse(JSON.stringify(raw)) as AgentMailSendInput;
        if (typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value.idempotencyKey)) fail();
        const body = JSON.stringify(value), bodyDigest = digest(value), id = digest([scopeDigest, value.idempotencyKey]); if (Buffer.byteLength(body) > 196608) fail();
        owner.db.transaction(() => { if (company().identityOwner !== owner.identityOwner) fail();
          const active = owner.db.prepare("SELECT request_id,body_digest FROM company_mail_pending WHERE scope_digest=? AND state='pending' LIMIT 2").all(scopeDigest) as Array<{ request_id: string; body_digest: string }>;
          if (active.length > 1 || active.some(row => row.request_id !== id || row.body_digest !== bodyDigest)) fail();
          const old = owner.db.prepare('SELECT scope_digest,request_key,body_json,body_digest FROM company_mail_pending WHERE request_id=?').get(id) as { scope_digest: string; request_key: string; body_json: string; body_digest: string } | undefined;
          if (old) { if (old.scope_digest !== scopeDigest || old.request_key !== value.idempotencyKey || old.body_json !== body || old.body_digest !== bodyDigest) fail(); }
          else owner.db.prepare("INSERT INTO company_mail_pending VALUES(?,?,?,?,?,'pending')").run(id, scopeDigest, value.idempotencyKey, body, bodyDigest);
        }).immediate();
        outbox = { owner, id, body, bodyDigest }; return value;
      };
      const result = await withAgentMailExecutionScope({ kind: 'organization', key: selected.key }, async () => {
        checkSelection();
        switch (operation) {
          case 'status': return agentMailStatus();
          case 'colleagues': return agentMailColleagues();
          case 'pending': { const owner = company(); schema(owner); const rows = owner.db.prepare("SELECT body_json,body_digest FROM company_mail_pending WHERE scope_digest=? AND state='pending' LIMIT 2").all(scopeDigest) as Array<{ body_json: string; body_digest: string }>;
            if (rows.length > 1) fail(); const pending = rows[0] ? JSON.parse(rows[0].body_json) as AgentMailSendInput : null;
            if (pending && digest(pending) !== rows[0].body_digest) fail(); return { ok: true, pending }; }
          case 'issue': if (!businessOnlyKeys(value, ['localPart', 'displayName']) || typeof value.localPart !== 'string' || value.localPart.length > 64 || value.displayName !== undefined && (typeof value.displayName !== 'string' || value.displayName.length > 120)) fail(); return agentMailIssue(value as { localPart: string; displayName?: string });
          case 'threads': if (!businessOnlyKeys(value, ['view', 'q', 'cursor', 'limit'])) fail(); return agentMailThreads(value as AgentMailThreadsInput);
          case 'thread': if (!businessOnlyKeys(value, ['threadId']) || typeof value.threadId !== 'string') fail(); return agentMailThread((value as { threadId: string }).threadId);
          case 'send': { if (!businessOnlyKeys(value, ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo', 'idempotencyKey', 'replyToMessageId', 'basedOnMessageId', 'attachments', 'expectsReply', 'final'])) fail(); const original = originalSend(value); checkSelection(); dispatched = true; return agentMailSend(original, { origin: 'owner' }); }
          case 'delegate': if (!businessOnlyKeys(value, ['threadId', 'instruction', 'locale']) || typeof value.threadId !== 'string' || value.instruction !== undefined && (typeof value.instruction !== 'string' || value.instruction.length > 4000) || value.locale !== undefined && !['ko', 'en'].includes(value.locale as string)) fail(); return agentMailDelegate(value as { threadId: string; instruction?: string; locale?: 'ko' | 'en' });
          default: return fail();
        }
      });
      checkSelection(); await checkBrowser(); checkSelection();
      if (outbox) { const pending = outbox as { owner: CompanyNativeOriginal; id: string; body: string; bodyDigest: string };
        pending.owner.assertCurrent(); if (company().identityOwner !== pending.owner.identityOwner) fail();
        if (result.ok && 'send' in result && result.send.status === 'delivered') {
          if (Number(pending.owner.db.prepare("UPDATE company_mail_pending SET state='confirmed' WHERE request_id=? AND scope_digest=? AND body_json=? AND body_digest=? AND state='pending'")
            .run(pending.id, scopeDigest, pending.body, pending.bodyDigest).changes) !== 1) {
            const old = pending.owner.db.prepare("SELECT state,body_digest FROM company_mail_pending WHERE request_id=?").get(pending.id) as { state: string; body_digest: string } | undefined;
            if (old?.state !== 'confirmed' || old.body_digest !== pending.bodyDigest) fail();
          }
        }
      }
      return result;
    } catch {
      if (operation === 'send' && dispatched && value && typeof value === 'object') {
        const key = (value as { idempotencyKey?: unknown }).idempotencyKey;
        return { ok: false, code: 'send_outcome_unknown', message: 'Check the original company send request.', status: null,
          detail: { ...(typeof key === 'string' ? { idempotencyKey: key } : {}) } };
      }
      return { ok: false, code: 'company_mail_context_changed', message: 'Reconnect the displayed company account.', status: 409 };
    }
  }
  for (const operation of ['status', 'issue', 'threads', 'thread', 'colleagues', 'pending', 'send', 'delegate'] as const) input.ipc.handle(`companyMail:${operation}`, (event, raw: unknown) => {
    if (operation === 'status' || operation === 'colleagues' || operation === 'pending') return run(event, raw, operation, null);
    if (!businessOnlyKeys(raw, ['session', 'input'])) return { ok: false, code: 'invalid_request', message: 'Invalid company mail request.', status: 400 };
    return run(event, raw.session, operation, raw.input);
  });
}
