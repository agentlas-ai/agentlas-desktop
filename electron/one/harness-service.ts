import { createHash } from 'node:crypto';
import {
  ONE_HARNESS_SCHEMA, ONE_HARNESS_ACTION_REJECTION_CODES, type OneHarnessActionRequest, type OneHarnessResultRequest,
  type OneHarnessResult, type OneArtifactSelection, type OneEffectReceipt, type OneTaskScope,
} from '../../shared/one-harness';
import type { CanonicalTask, InvocationRunReceipt } from '../../shared/types';
import type { OneSurfaceManifestV1 } from '../../shared/one-surface';
import { oneResultCharts } from '../../shared/one-result-charts';
import { supervisorIdentifier, supervisorObject, supervisorText, supervisorError, type SupervisorTask, type SupervisorCommandReceipt } from '../../shared/one-supervisor';

export interface HarnessArtifactBinding {
  artifactRef: string; sha256: string; sizeBytes: number;
}
export interface HarnessResultSource {
  oneId: string;
  current: SupervisorTask;
  task: CanonicalTask;
  receipt: InvocationRunReceipt | null;
  surface: OneSurfaceManifestV1 | null;
  text: string | null;
  scope: OneTaskScope;
  bindings: HarnessArtifactBinding[];
  effect: OneEffectReceipt;
}
export interface HarnessActionRecord {
  digest: string;
  receipt: SupervisorCommandReceipt | null;
}
export interface OneHarnessPorts {
  identity(): string;
  read(input: OneHarnessResultRequest): Promise<HarnessResultSource>;
  getAction(oneId: string, commandId: string): HarnessActionRecord | null;
  claimAction(oneId: string, commandId: string, digest: string): boolean;
  saveAction(oneId: string, commandId: string, receipt: SupervisorCommandReceipt): void;
  commandReceipt(oneId: string, commandId: string): SupervisorCommandReceipt | null;
  followUp(input: { oneId: string; commandId: string; taskId: string; text: string }): SupervisorCommandReceipt;
  now?(): Date;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const ACTION_REJECTION_CODES: ReadonlySet<string> = new Set(ONE_HARNESS_ACTION_REJECTION_CODES);
function resultInput(raw: OneHarnessResultRequest): OneHarnessResultRequest {
  const row = supervisorObject(raw, ['oneId', 'taskId', 'runId', 'expectedVersion']);
  return {
    oneId: supervisorIdentifier(row.oneId), taskId: supervisorIdentifier(row.taskId), runId: supervisorIdentifier(row.runId),
    ...(row.expectedVersion === undefined ? {} : { expectedVersion: supervisorIdentifier(row.expectedVersion) }),
  };
}
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw supervisorError('one_selection_ids_invalid');
  const ids = value.map(supervisorIdentifier);
  if (new Set(ids).size !== ids.length) throw supervisorError('one_selection_ids_duplicate');
  return ids;
}
export function validateOneArtifactSelection(value: unknown): OneArtifactSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw supervisorError('one_selection_invalid');
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'text') {
    const row = supervisorObject(value, ['kind', 'text', 'blockId']);
    return { kind, text: supervisorText(row.text), ...(row.blockId === undefined ? {} : { blockId: supervisorIdentifier(row.blockId) }) };
  }
  if (kind === 'table') {
    const row = supervisorObject(value, ['kind', 'blockId', 'rowIds', 'columnIds']);
    return { kind, blockId: supervisorIdentifier(row.blockId), rowIds: identifiers(row.rowIds), columnIds: identifiers(row.columnIds) };
  }
  if (kind === 'chart') {
    const row = supervisorObject(value, ['kind', 'blockId', 'seriesId', 'pointIndex']);
    if (row.pointIndex !== undefined && (!Number.isSafeInteger(row.pointIndex) || Number(row.pointIndex) < 0)) throw supervisorError('one_selection_point_invalid');
    return { kind, blockId: supervisorIdentifier(row.blockId), ...(row.seriesId === undefined ? {} : { seriesId: supervisorIdentifier(row.seriesId) }),
      ...(row.pointIndex === undefined ? {} : { pointIndex: Number(row.pointIndex) }) };
  }
  if (kind === 'media') {
    const row = supervisorObject(value, ['kind', 'artifactRef', 'timeSeconds', 'endSeconds']);
    if (typeof row.timeSeconds !== 'number' || !Number.isFinite(row.timeSeconds) || row.timeSeconds < 0
      || (row.endSeconds !== undefined && (typeof row.endSeconds !== 'number' || !Number.isFinite(row.endSeconds) || row.endSeconds < row.timeSeconds))) {
      throw supervisorError('one_selection_time_invalid');
    }
    return { kind, artifactRef: supervisorIdentifier(row.artifactRef), timeSeconds: row.timeSeconds,
      ...(row.endSeconds === undefined ? {} : { endSeconds: row.endSeconds as number }) };
  }
  throw supervisorError('one_selection_kind_unsupported');
}

function validateSelectionTarget(selection: OneArtifactSelection, result: OneHarnessResult): void {
  if (selection.kind === 'media') {
    const artifact = result.artifacts.find(item => item.artifactRef === selection.artifactRef);
    if (!artifact || !['video', 'audio'].includes(artifact.kind)) throw supervisorError('one_selection_artifact_mismatch');
    const media = result.surface?.blocks.find(block => block.type === 'Media' && block.outputs.some(output => output.artifactRef === selection.artifactRef));
    if (media?.type === 'Media' && media.durationSeconds !== undefined
      && Math.max(selection.timeSeconds, selection.endSeconds ?? 0) > media.durationSeconds) throw supervisorError('one_selection_time_outside_media');
    return;
  }
  const block = selection.blockId ? result.surface?.blocks.find(item => item.blockId === selection.blockId) : undefined;
  if (selection.kind === 'text') {
    const text = selection.blockId ? block?.type === 'Narrative' ? block.paragraphs.join('\n') : null : result.text ?? result.surface?.fallback.markdown;
    if (!text || !text.includes(selection.text)) throw supervisorError('one_selection_text_changed');
  } else if (selection.kind === 'table') {
    if (block?.type !== 'Table' || selection.rowIds.some(id => !block.rows.some(row => row.rowId === id))
      || selection.columnIds.some(id => !block.columns.some(column => column.columnId === id))) throw supervisorError('one_selection_table_changed');
  } else {
    const chart = result.charts.find(item => item.blockId === selection.blockId);
    if (!chart) throw supervisorError('one_selection_chart_changed');
    const series = selection.seriesId ? chart.series.find(item => item.seriesId === selection.seriesId) : undefined;
    if ((selection.seriesId && !series) || (selection.pointIndex !== undefined && (!series || selection.pointIndex >= series.pointCount))) {
      throw supervisorError('one_selection_chart_point_changed');
    }
  }
}

/** Read projections and action dispatch share the same exact host binding. */
export class OneHarnessService {
  constructor(private readonly ports: OneHarnessPorts) {}
  async getResult(raw: OneHarnessResultRequest): Promise<OneHarnessResult> {
    const input = resultInput(raw);
    if (this.ports.identity() !== input.oneId) throw supervisorError('one_harness_identity_changed');
    const source = await this.ports.read(input);
    if (this.ports.identity() !== input.oneId || source.oneId !== input.oneId) throw supervisorError('one_harness_identity_changed');
    if (source.task.id !== input.taskId || source.current.taskId !== input.taskId || source.scope.taskId !== input.taskId
      || source.scope.runId !== input.runId || source.scope.oneIdentityRef !== input.oneId
      || (source.receipt && (source.receipt.runId !== input.runId || source.receipt.chatId !== source.task.originChatId))
      || (source.surface && source.surface.taskId !== input.taskId)) throw supervisorError('one_harness_binding_changed');
    const stale = source.current.runId !== input.runId || Boolean(input.expectedVersion && input.expectedVersion !== source.current.controlVersion);
    const revision = hash({ taskId: input.taskId, runId: input.runId, taskVersion: source.task.version,
      surface: source.surface, text: source.text, bindings: source.bindings });
    const artifacts = (source.surface?.fallback.artifacts ?? []).map(artifact => {
      const binding = source.bindings.find(item => item.artifactRef === artifact.artifactRef);
      return { artifactRef: artifact.artifactRef, manifestId: source.surface!.manifestId, taskId: input.taskId,
        taskVersion: source.task.version, chatId: source.task.originChatId!, runId: input.runId, revision,
        kind: artifact.type, label: artifact.label, verificationStatus: artifact.verificationStatus,
        sizeBytes: binding?.sizeBytes ?? artifact.sizeBytes ?? null, sha256: binding?.sha256 ?? null,
        previewAvailable: Boolean(binding && artifact.verificationStatus === 'verified') };
    });
    const state = source.receipt?.status;
    const surfaceState = source.surface?.surfaceState.value;
    const hasResult = Boolean(source.surface || source.text);
    return { schema: ONE_HARNESS_SCHEMA, oneId: input.oneId, taskId: input.taskId, runId: input.runId,
      controlVersion: source.current.controlVersion, revision, observedAt: (this.ports.now?.() ?? new Date()).toISOString(),
      task: source.task, receipt: source.receipt, scope: source.scope, text: source.text, surface: source.surface, artifacts,
      charts: oneResultCharts(source.text ?? source.surface?.fallback.markdown ?? ''), effect: source.effect,
      state: { lifecycle: source.current.state, process: state === 'running' ? 'running' : state === 'cancelling' ? 'stopping' : state ? 'settled' : 'unknown',
        effect: source.effect.state, result: stale ? 'stale' : surfaceState === 'partial' ? 'partial' : surfaceState === 'error' ? 'error' : hasResult ? 'ready' : 'missing',
        freshness: stale ? 'stale' : 'current' },
      fallbackReason: source.surface ? null : source.text ? 'one_surface_unavailable' : 'one_exact_result_unavailable' };
  }

  async action(raw: OneHarnessActionRequest): Promise<SupervisorCommandReceipt> {
    const row = supervisorObject(raw, ['oneId', 'taskId', 'runId', 'expectedVersion', 'commandId', 'revision', 'intent', 'text', 'manifestId', 'artifactRef', 'selection']);
    const input = resultInput({ oneId: row.oneId as string, taskId: row.taskId as string, runId: row.runId as string, expectedVersion: row.expectedVersion as string });
    const commandId = supervisorIdentifier(row.commandId);
    const text = supervisorText(row.text);
    if (row.intent !== 'follow-up' || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)) throw supervisorError('one_harness_action_invalid');
    const manifestId = row.manifestId === undefined ? undefined : supervisorIdentifier(row.manifestId);
    const artifactRef = row.artifactRef === undefined ? undefined : supervisorIdentifier(row.artifactRef);
    const selection = row.selection === undefined ? undefined : validateOneArtifactSelection(row.selection);
    const digest = hash({ ...input, commandId, revision: row.revision, text, manifestId, artifactRef, selection });
    if (this.ports.identity() !== input.oneId) throw supervisorError('one_harness_identity_changed');
    const prior = this.ports.getAction(input.oneId, commandId);
    if (prior) {
      if (prior.digest !== digest) throw supervisorError('one_harness_command_conflict');
      const receipt = prior.receipt ?? this.ports.commandReceipt(input.oneId, commandId);
      if (receipt) { this.ports.saveAction(input.oneId, commandId, receipt); return receipt; }
      // An interrupted dispatch must be observed, never guessed and replayed.
      return { commandId, kind: 'follow-up', taskId: input.taskId, runId: null, state: 'held', acknowledgement: 'unknown', reason: 'one_harness_dispatch_unconfirmed' };
    }
    let result: OneHarnessResult;
    try {
      result = await this.getResult(input);
      if (!input.expectedVersion || result.controlVersion !== input.expectedVersion || result.revision !== row.revision
        || result.state.freshness !== 'current' || result.task.archivedAt) throw supervisorError('one_harness_result_stale');
      if (result.scope.authorization !== 'local-owner') throw supervisorError('one_harness_organization_policy_required');
      if (result.state.effect === 'uncertain') throw supervisorError('one_harness_effect_observation_required');
      if (manifestId && result.surface?.manifestId !== manifestId) throw supervisorError('one_harness_manifest_changed');
      if (artifactRef && !result.artifacts.some(item => item.artifactRef === artifactRef)) throw supervisorError('one_harness_artifact_changed');
      if (selection) validateSelectionTarget(selection, result);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (typeof code !== 'string' || !ACTION_REJECTION_CODES.has(code)) throw error;
      // A proven pre-dispatch rejection is durable data. Electron may discard
      // custom Error fields, and the owner must be able to refresh the result
      // and submit a new direction without retrying a rejected ID forever.
      if (!this.ports.claimAction(input.oneId, commandId, digest)) return this.action(raw);
      const rejected: SupervisorCommandReceipt = { commandId, kind: 'follow-up', taskId: input.taskId,
        runId: null, state: 'failed', acknowledgement: 'settled', reason: code };
      this.ports.saveAction(input.oneId, commandId, rejected);
      return rejected;
    }
    if (!this.ports.claimAction(input.oneId, commandId, digest)) return this.action(raw);
    const anchor = { taskId: result.taskId, runId: result.runId, revision: result.revision, manifestId: manifestId ?? result.surface?.manifestId,
      ...(artifactRef ? { artifactRef } : {}), ...(selection ? { selection } : {}) };
    const receipt = this.ports.followUp({ oneId: input.oneId, commandId, taskId: input.taskId,
      text: text + '\n\nExact result to revise (preserve the original and create a new revision):\n' + JSON.stringify(anchor) });
    this.ports.saveAction(input.oneId, commandId, receipt);
    return receipt;
  }
}
