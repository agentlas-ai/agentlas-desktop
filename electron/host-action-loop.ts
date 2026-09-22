import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type HostJson = null | boolean | number | string | readonly HostJson[] | { readonly [key: string]: HostJson };

/** Deliberately closed schema dialect. Unsupported schema keywords fail at construction. */
export type HostInputSchema =
  | { readonly type: 'null' | 'boolean' | 'number' | 'string' }
  | { readonly type: 'array'; readonly items: HostInputSchema }
  | { readonly type: 'object'; readonly properties: Readonly<Record<string, HostInputSchema>>; readonly required: readonly string[] };

export interface HostCapability {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: HostInputSchema;
  /** Default call-id permits fresh reads/polls; side-effect adapters may also dedupe input. */
  readonly replayPolicy?: 'call-id' | 'call-id-and-input';
}

export type HostActionProposal =
  | { readonly kind: 'call'; readonly callId: string; readonly capabilityId: string; readonly input: HostJson }
  | { readonly kind: 'finish'; readonly output: HostJson }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface HostScopeState {
  /** Identity allocated by the host; never supplied to the model. */
  readonly token: symbol;
  /** Must increase for every scope/authorization change, including change-and-restore. */
  readonly epoch: number;
  readonly revoked: boolean;
}

export type HostLoopReason = 'aborted' | 'scope_changed' | 'deadline' | 'step_limit' | 'replay'
  | 'invalid_proposal' | 'unsupported_capability' | 'invalid_input' | 'model_failed' | 'provider_failed'
  | 'invalid_result' | 'already_started';

export interface HostActionReceipt {
  readonly step: number;
  readonly callId: string;
  readonly capabilityId: string;
  readonly input: HostJson;
  /** Invalidated/error means effects may have happened; it is never a retry permission. */
  readonly status: 'completed' | 'invalidated' | 'error';
  readonly output?: HostJson;
  readonly reason?: HostLoopReason;
}

export interface HostModelSnapshot {
  readonly input: HostJson;
  readonly capabilities: readonly HostCapability[];
  readonly receipts: readonly HostActionReceipt[];
  readonly step: number;
}

export interface HostActionLoopOptions {
  readonly input: HostJson;
  readonly capabilities: readonly HostCapability[];
  readonly signal: AbortSignal;
  readonly readScope: () => HostScopeState;
  /** Adapter must be a proposal-only model invocation with no ambient tools. */
  readonly modelStep: (snapshot: HostModelSnapshot, signal: AbortSignal) => Promise<HostActionProposal>;
  /**
   * Only this trusted host adapter holds dispatch authority; it must honor cancellation.
   * The loop cannot roll back effects or stop a provider that ignores the signal.
   */
  readonly dispatch: (request: Readonly<{
    callId: string; capabilityId: string; input: HostJson; scopeToken: symbol; epoch: number;
  }>, signal: AbortSignal) => Promise<HostJson>;
  readonly limits?: Readonly<{ maxSteps?: number; maxDurationMs?: number; maxBytes?: number }>;
}

export type HostActionLoopResult = Readonly<{
  status: 'finished' | 'blocked';
  reason?: HostLoopReason | 'model_blocked';
  detail?: string;
  output?: HostJson;
  receipts: readonly HostActionReceipt[];
}>;

class LoopFailure extends Error {
  constructor(readonly reason: HostLoopReason) { super(reason); }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Copy data without invoking toJSON/getters, with bounded depth/nodes/UTF-8 bytes. */
function snapshot<T>(value: T, maxBytes: number): T {
  let budget = maxBytes;
  const debit = (amount: number) => { budget -= amount; if (budget < 0) throw new Error('data_limit'); };
  const copy = (item: unknown, depth: number): HostJson => {
    if (depth > 32) throw new Error('data_depth');
    debit(1);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') { debit(Buffer.byteLength(item, 'utf8')); return item; }
    if (typeof item !== 'object' || !item) throw new Error('not_json');
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item)) throw new Error('not_plain');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) throw new Error('symbol_key');
    const target: Record<string, HostJson> | HostJson[] = Array.isArray(item) ? [] : Object.create(null);
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('not_data');
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw new Error('array_key');
      debit(Buffer.byteLength(key, 'utf8'));
      Object.defineProperty(target, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    if (Array.isArray(item) && Object.keys(descriptors).length !== item.length + 1) throw new Error('sparse_array');
    return Object.freeze(target);
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) throw new Error('data_limit');
  return result as T;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateSchema(schema: unknown): asserts schema is HostInputSchema {
  if (!record(schema)) throw new Error('invalid_schema');
  if (['null', 'boolean', 'number', 'string'].includes(String(schema.type)) && exactKeys(schema, ['type'])) return;
  if (schema.type === 'array' && exactKeys(schema, ['type', 'items'])) { validateSchema(schema.items); return; }
  if (schema.type === 'object' && exactKeys(schema, ['type', 'properties', 'required']) && record(schema.properties)
    && Array.isArray(schema.required) && schema.required.every((key) => typeof key === 'string' && Object.hasOwn(schema.properties as object, key))
    && new Set(schema.required).size === schema.required.length) {
    Object.values(schema.properties).forEach(validateSchema);
    return;
  }
  throw new Error('unsupported_schema');
}

function matches(schema: HostInputSchema, value: HostJson): boolean {
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value) && value.every((entry) => matches(schema.items, entry));
  if (schema.type === 'object') {
    return record(value) && schema.required.every((key) => Object.hasOwn(value, key))
      && Object.entries(value).every(([key, entry]) => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], entry as HostJson));
  }
  return typeof value === schema.type;
}

function canonical(value: HostJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] as HostJson)}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * In-memory, single-use host primitive, intentionally not wired to any runtime/provider.
 * A fresh instance is a new host-authorized run; persisted/cross-run idempotency belongs
 * to the integrating host/provider. No receipt asserts rollback after cancellation.
 */
export function createHostActionLoop(options: HostActionLoopOptions): Readonly<{ run: () => Promise<HostActionLoopResult> }> {
  const { modelStep, dispatch, readScope, signal } = options;
  const maxSteps = options.limits?.maxSteps ?? 12;
  const maxDurationMs = options.limits?.maxDurationMs ?? 60_000;
  const maxBytes = options.limits?.maxBytes ?? 65_536;
  for (const [value, ceiling] of [[maxSteps, 256], [maxDurationMs, 300_000], [maxBytes, 1_048_576]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error('invalid_limits');
  }
  const input = snapshot(options.input, maxBytes);
  const capabilities = snapshot(options.capabilities, maxBytes);
  const catalogue = new Map<string, HostCapability>();
  for (const capability of capabilities) {
    if (!record(capability) || !exactKeys(capability, Object.hasOwn(capability, 'replayPolicy')
      ? ['id', 'description', 'inputSchema', 'replayPolicy'] : ['id', 'description', 'inputSchema'])
      || typeof capability.id !== 'string' || !capability.id || capability.id.length > 256
      || typeof capability.description !== 'string' || catalogue.has(capability.id)
      || (Object.hasOwn(capability, 'replayPolicy') && capability.replayPolicy !== 'call-id' && capability.replayPolicy !== 'call-id-and-input')) throw new Error('invalid_capability');
    validateSchema(capability.inputSchema);
    catalogue.set(capability.id, capability);
  }
  const initialScope = readScope();
  const token = initialScope.token;
  const epoch = initialScope.epoch;
  if (typeof token !== 'symbol' || !Number.isSafeInteger(epoch) || epoch < 0 || initialScope.revoked !== false) throw new Error('invalid_scope');
  let started = false;

  return Object.freeze({ run: async (): Promise<HostActionLoopResult> => {
    if (started) return Object.freeze({ status: 'blocked', reason: 'already_started', receipts: Object.freeze([]) });
    started = true;
    const receipts: HostActionReceipt[] = [];
    const seenIds = new Set<string>();
    const seenInputs = new Set<string>();
    const controller = new AbortController();
    const deadline = performance.now() + maxDurationMs;
    let deadlineExpired = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => { deadlineExpired = true; abort(); }, maxDurationMs);
    const guard = () => {
      if (signal.aborted) throw new LoopFailure('aborted');
      let current: HostScopeState;
      try { current = readScope(); } catch { throw new LoopFailure('scope_changed'); }
      if (!current || current.token !== token || current.epoch !== epoch || current.revoked !== false) throw new LoopFailure('scope_changed');
      if (signal.aborted) throw new LoopFailure('aborted');
      if (deadlineExpired || performance.now() >= deadline) throw new LoopFailure('deadline');
    };
    const guardedAwait = async <T>(operation: () => Promise<T>, failure: HostLoopReason): Promise<T> => {
      guard();
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new LoopFailure(signal.aborted ? 'aborted' : 'deadline'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([operation(), cancelled]);
        guard();
        return result;
      } catch (error) {
        guard();
        throw error instanceof LoopFailure ? error : new LoopFailure(failure);
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    };
    const finish = (result: Omit<HostActionLoopResult, 'receipts'>): HostActionLoopResult => Object.freeze({ ...result, receipts: Object.freeze([...receipts]) });
    try {
      for (let step = 1; step <= maxSteps; step++) {
        guard();
        const modelInput = Object.freeze({ input, capabilities, receipts: Object.freeze([...receipts]), step });
        const raw = await guardedAwait(() => modelStep(modelInput, controller.signal), 'model_failed');
        let proposal: unknown;
        try { proposal = snapshot(raw, maxBytes); } catch { throw new LoopFailure('invalid_proposal'); }
        if (!record(proposal)) throw new LoopFailure('invalid_proposal');
        if (proposal.kind === 'finish' && exactKeys(proposal, ['kind', 'output'])) {
          guard();
          return finish({ status: 'finished', output: proposal.output as HostJson });
        }
        if (proposal.kind === 'blocked' && exactKeys(proposal, ['kind', 'reason']) && typeof proposal.reason === 'string') {
          guard();
          return finish({ status: 'blocked', reason: 'model_blocked', detail: proposal.reason });
        }
        if (proposal.kind !== 'call' || !exactKeys(proposal, ['kind', 'callId', 'capabilityId', 'input'])
          || typeof proposal.callId !== 'string' || !proposal.callId || proposal.callId.length > 256
          || typeof proposal.capabilityId !== 'string') throw new LoopFailure('invalid_proposal');
        const capability = catalogue.get(proposal.capabilityId);
        if (!capability) throw new LoopFailure('unsupported_capability');
        const callInput = proposal.input as HostJson;
        if (!matches(capability.inputSchema, callInput)) throw new LoopFailure('invalid_input');
        const fingerprint = createHash('sha256').update(canonical([capability.id, callInput])).digest('hex');
        if (seenIds.has(proposal.callId) || (capability.replayPolicy === 'call-id-and-input' && seenInputs.has(fingerprint))) throw new LoopFailure('replay');
        seenIds.add(proposal.callId);
        seenInputs.add(fingerprint);
        const base = { step, callId: proposal.callId, capabilityId: capability.id, input: callInput };
        // Check immediately before dispatch, with no intervening await or untrusted callback.
        guard();
        let dispatched = false;
        try {
          const rawOutput = await guardedAwait(() => {
            dispatched = true;
            return dispatch(Object.freeze({
              callId: base.callId, capabilityId: base.capabilityId, input: callInput, scopeToken: token, epoch,
            }), controller.signal);
          }, 'provider_failed');
          let output: HostJson;
          try { output = snapshot(rawOutput, maxBytes); } catch { throw new LoopFailure('invalid_result'); }
          guard();
          receipts.push(Object.freeze({ ...base, status: 'completed', output }));
        } catch (error) {
          const reason = error instanceof LoopFailure ? error.reason : 'provider_failed';
          const invalidated = ['scope_changed', 'aborted', 'deadline'].includes(reason);
          if (dispatched) receipts.push(Object.freeze({ ...base, status: invalidated ? 'invalidated' : 'error', reason }));
          throw error;
        }
      }
      guard();
      return finish({ status: 'blocked', reason: 'step_limit' });
    } catch (error) {
      return finish({ status: 'blocked', reason: error instanceof LoopFailure ? error.reason : 'invalid_proposal' });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  } });
}
