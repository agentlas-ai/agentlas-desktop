import { getDb } from '../store/db';
import { getOneProfile } from '../store/one-profile';
import { getCanonicalTask } from '../store/tasks';
import { getInvocationRunReceipt } from '../store/run-events';
import { getDurableOneSurfaceResult } from '../store/one-surface-results';
import { getProject } from '../store/projects';
import { readInvocationEffectBoundary } from '../invocation/effect-boundary-reader';
import { oneSupervisor } from './supervisor';
import { supervisorExactResult } from './supervisor-presentation';
import { OneHarnessService, type HarnessArtifactBinding, type HarnessActionRecord } from './harness-service';
import type { OneEffectReceipt, OneHarnessAPI } from '../../shared/one-harness';
import type { SupervisorCommandReceipt } from '../../shared/one-supervisor';

let instance: OneHarnessService | null = null;
let runtimeClient: Pick<OneHarnessAPI, 'getResult' | 'action'> | null = null;
/** Main uses the authenticated owner lane; disconnect never falls back to a second writer. */
export function configureOneHarnessRuntimeClient(client: Pick<OneHarnessAPI, 'getResult' | 'action'>): void {
  runtimeClient = client;
}
export function oneHarness(): Pick<OneHarnessAPI, 'getResult' | 'action'> {
  return runtimeClient ?? localOneHarness();
}
function actionStore() {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS one_harness_actions (one_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(one_id,command_id))');
  return db;
}

/** Adapts authoritative existing stores; there is no second task/artifact store. */
export function localOneHarness(): OneHarnessService {
  if (instance) return instance;
  instance = new OneHarnessService({
    identity: () => getOneProfile().oneId,
    read: async input => {
      const snapshot = await oneSupervisor().snapshot();
      if (snapshot.oneId !== input.oneId || getOneProfile().oneId !== input.oneId) throw new Error('one_harness_identity_changed');
      const current = snapshot.tasks.find(task => task.taskId === input.taskId);
      const task = getCanonicalTask(input.taskId);
      if (!current || !task?.originChatId || current.chatId !== task.originChatId) throw new Error('one_harness_task_not_visible');
      const receipt = getInvocationRunReceipt(input.runId);
      if (receipt && receipt.chatId !== task.originChatId) throw new Error('one_harness_run_mismatch');
      if (!receipt && current.runId !== input.runId) throw new Error('one_harness_run_missing');
      const durable = getDurableOneSurfaceResult({ taskId: task.id, chatId: task.originChatId, runId: input.runId });
      const text = supervisorExactResult(getDb(), task.originChatId, input.runId)?.text ?? null;
      let bindings: HarnessArtifactBinding[] = [];
      if (durable && getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='one_artifact_bindings'").get()) {
        bindings = getDb().prepare('SELECT artifact_ref AS artifactRef, sha256, size_bytes AS sizeBytes FROM one_artifact_bindings WHERE task_id=? AND chat_id=? AND run_id=? AND manifest_id=? ORDER BY artifact_ref')
          .all(task.id, task.originChatId, input.runId, durable.manifest.manifestId) as HarnessArtifactBinding[];
      }
      let effect: OneEffectReceipt = { state: !receipt || ['running', 'cancelling'].includes(receipt.status) ? 'pending' : 'uncertain',
        receiptEventId: null, terminalEventId: null, observedBy: null, sourceRefs: [], pendingEffectRefs: [] };
      try {
        const boundary = readInvocationEffectBoundary({ invocationRunId: input.runId, expectedChatId: task.originChatId });
        effect = { state: boundary.terminal ? boundary.effects : 'pending', receiptEventId: boundary.receiptEventId,
          terminalEventId: boundary.terminalEventId, observedBy: boundary.settledByObservation ?? null,
          sourceRefs: boundary.sourceRefs, pendingEffectRefs: boundary.pendingEffectRefs };
      } catch { effect.pendingEffectRefs = ['one_effect_receipt_unavailable']; }
      const project = task.projectId ? getProject(task.projectId) : null;
      const kind = task.projectId ? 'project' as const : 'personal' as const;
      return { oneId: snapshot.oneId, current, task, receipt, surface: durable?.manifest ?? null, text, bindings, effect,
        scope: { oneIdentityRef: snapshot.oneId, taskId: task.id, runId: input.runId, surface: current.surface,
          kind, projectId: task.projectId, organizationId: null, legacyFirmId: task.firmId, label: project?.name ?? 'Personal',
          authorityRef: 'desktop-local', authorization: 'local-owner' as const,
          dataClass: kind, payer: 'personal' as const } };
    },
    getAction: (oneId, commandId) => {
      const db = getDb();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_harness_actions'").get()) return null;
      const row = db.prepare('SELECT digest,receipt_json FROM one_harness_actions WHERE one_id=? AND command_id=?').get(oneId, commandId) as { digest: string; receipt_json: string | null } | undefined;
      return row ? { digest: row.digest, receipt: row.receipt_json ? JSON.parse(row.receipt_json) as SupervisorCommandReceipt : null } satisfies HarnessActionRecord : null;
    },
    claimAction: (oneId, commandId, digest) => {
      oneSupervisor().assertHostWriteAuthority(oneId);
      const db = actionStore();
      return db.prepare('INSERT OR IGNORE INTO one_harness_actions(one_id,command_id,digest,created_at) VALUES (?,?,?,?)').run(oneId, commandId, digest, new Date().toISOString()).changes === 1;
    },
    saveAction: (oneId, commandId, receipt) => {
      oneSupervisor().assertHostWriteAuthority(oneId);
      getDb().prepare('UPDATE one_harness_actions SET receipt_json=? WHERE one_id=? AND command_id=?').run(JSON.stringify(receipt), oneId, commandId);
    },
    commandReceipt: (oneId, commandId) => oneSupervisor().receipt({ oneId, commandId }),
    followUp: input => oneSupervisor().followUp(input),
  });
  return instance;
}
