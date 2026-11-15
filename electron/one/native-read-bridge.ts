import type { OneTeamCapabilityBinding } from './team-control-server';

type Relay = (name: string, input: Record<string, unknown>) => Promise<unknown>;
type Binding = Pick<OneTeamCapabilityBinding, 'chatId' | 'turnRunId' | 'supervisorReplyRunId' | 'permission'>;
type Policy = { operationId: string; admissionName: string; area: string };

/** The domain port declares exactly which read may cross the personal native relay. */
export async function personalNativeReadRelay(binding: Binding, relay: Relay, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name !== 'one_app_operations' && name !== 'one_app_call' && !name.startsWith('__one_')) return relay(name, input);
  const { oneNativeReadPolicies } = await import('../harness/capability-ports');
  const policies = oneNativeReadPolicies();
  if (policies.some(policy => policy.admissionName === name)) throw new Error('one-team-unknown-operation');
  const admit = async (policy: Policy, kind: 'search' | 'call') => {
    try {
      const ack = await relay(policy.admissionName, kind === 'call' ? { kind, operation: policy.operationId } : { kind }) as {
        version?: unknown; actor?: { userId?: unknown; workspaceId?: unknown }; epoch?: unknown; handoff?: unknown;
      };
      if (!ack || ack.version !== 2 || typeof ack.actor?.userId !== 'string' || !ack.actor.userId
        || typeof ack.actor?.workspaceId !== 'string' || !ack.actor.workspaceId || typeof ack.epoch !== 'string'
        || !/^[a-f0-9]{64}$/.test(ack.epoch) || !ack.handoff || typeof ack.handoff !== 'object' || Array.isArray(ack.handoff)) return null;
      const auth = await import('../auth');
      if (!auth.adoptNativeReadSession(ack.handoff as import('../auth').HostSessionHandoff, ack.epoch)) return null;
      const proof = auth.nativeReadSessionEpoch();
      return proof && proof.userId === ack.actor.userId && proof.workspaceId === ack.actor.workspaceId && proof.epoch === ack.epoch
        ? { userId: proof.userId, workspaceId: proof.workspaceId, epoch: proof.epoch, revision: proof.revision } : null;
    } catch { return null; }
  };
  const same = (a: NonNullable<Awaited<ReturnType<typeof admit>>>, b: Awaited<ReturnType<typeof admit>>) =>
    !!b && a.userId === b.userId && a.workspaceId === b.workspaceId && a.epoch === b.epoch && a.revision === b.revision;
  if (name === 'one_app_operations') {
    const base = await relay(name, input);
    if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
    const exact = typeof input.operation === 'string' ? input.operation.trim() : '';
    const area = typeof input.area === 'string' ? input.area.trim() : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const matched = policies.filter(policy => (!exact || exact === policy.operationId) && (!area || area === policy.area));
    if ((!exact && !area && !query) || matched.length !== 1) return base;
    const policy = matched[0]!, proof = await admit(policy, 'search');
    if (!proof || !binding.chatId || !binding.turnRunId || binding.turnRunId !== binding.supervisorReplyRunId) return { ...base, harness_status: 'unavailable' };
    const turn = await import('../turn-tools/control-server');
    const scope = { chatId: binding.chatId, runId: binding.turnRunId, permission: binding.permission ?? 'read', expectedSession: proof };
    if (!exact) {
      const found = await turn.bridgeLiveTurnRead(scope, 'harness_search', { query: query || area, kind: 'tool', limit: 60 }) as { items?: Array<{ id?: unknown }> } | null;
      if (!found?.items?.some(item => item.id === policy.operationId)) return base;
    }
    const detail = await turn.bridgeLiveTurnRead(scope, 'harness_describe', { id: policy.operationId }) as { status?: unknown; data?: Record<string, unknown> } | null;
    if (detail?.status !== 'ok' || !detail.data || !same(proof, await admit(policy, 'search'))) return { ...base, harness_status: 'unavailable' };
    return { ...base, harness_status: 'available', harness_operations: [{ operation: policy.operationId, effect: 'read', status: 'discoverable', executed: false,
      availability: 'unknown', call_tool: 'one_app_call', input_schema: detail.data.inputSchema ?? {}, required: detail.data.required ?? [] }] };
  }
  const policy = name === 'one_app_call' ? policies.find(item => item.operationId === input.operation) : undefined;
  if (policy) {
    const proof = await admit(policy, 'call');
    if (!proof || !binding.chatId || !binding.turnRunId || binding.turnRunId !== binding.supervisorReplyRunId) return { status: 'unavailable', reason: 'turn_capability_unavailable' };
    const raw = (require('../app-control/call-aliases') as typeof import('../app-control/call-aliases')).appCallInputOf(input);
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) return { status: 'refused', reason: 'arguments_invalid' };
    const turn = await import('../turn-tools/control-server');
    const scope = { chatId: binding.chatId, runId: binding.turnRunId, permission: binding.permission ?? 'read', expectedSession: proof };
    const result = await turn.bridgeLiveTurnRead(scope, 'harness_call', { operation: policy.operationId, args: raw ?? {} });
    if (!result || !same(proof, await admit(policy, 'call')) || !(await turn.bridgeLiveTurnRead(scope, 'harness_describe', { id: policy.operationId })))
      return { status: 'unavailable', reason: 'turn_capability_unavailable' };
    return result;
  }
  return relay(name, input);
}
