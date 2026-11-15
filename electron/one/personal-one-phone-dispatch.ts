import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db';
import { getOneProfile } from '../store/one-profile';
import { getInvocationAdmission } from '../store/invocation-admissions';
import { invocationRunOwners } from '../store/invocation-run-owners';
import { phoneOriginForRun } from './personal-one-phone-origin';
import { supervisorRunsInDaemon } from './supervisor';
import { requestPersonalOnePhoneToolForRun, type PhoneToolName, type PhoneToolResult } from '../mobile-bridge/personal-one-phone-tools';
import { daemonDeviceBridge } from '../daemon/device-bridge';

const unavailable = (): PhoneToolResult => ({ status: 'unavailable', reason: 'phone_no_answer' });
/** The original personal turn is established by the supervisor host, never by model arguments. */
export async function personalOnePhoneDispatch(binding: { chatId?: string | null; supervisorReplyRunId?: string; turnRunId?: string },
  name: PhoneToolName, input: Record<string, unknown>): Promise<PhoneToolResult> {
  const {chatId, supervisorReplyRunId:runId, turnRunId} = binding;
  if (!chatId || !runId || turnRunId !== runId || !['phone.location.get','phone.device.context'].includes(name)) return unavailable();
  const db = getDb(), oneId = getOneProfile().oneId;
  const admission = getInvocationAdmission(runId), custody = invocationRunOwners.getRunOwner(chatId,runId);
  const domain = db.prepare("SELECT one_id,owner_epoch,generation,phase,lease_until FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as {one_id:string;owner_epoch:string;generation:number;phase:string;lease_until:number}|undefined;
  const current = () => {
    try {
      const now = invocationRunOwners.getRunOwner(chatId,runId), next = getInvocationAdmission(runId);
      const currentDomain = db.prepare("SELECT one_id,owner_epoch,generation,phase,lease_until FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as typeof domain;
      const rows = db.prepare("SELECT origin_chat_id,state FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind='reply'").all(oneId,runId) as Array<{origin_chat_id:string;state:string}>;
      return getOneProfile().oneId === oneId && rows.length === 1 && rows[0]!.origin_chat_id === chatId && ['dispatching','accepted'].includes(rows[0]!.state)
        && !!phoneOriginForRun(db,oneId,runId) && !!custody && now?.state === 'active' && now.leaseId === custody.leaseId
        && now.ownerId === custody.ownerId && now.ownerKind === custody.ownerKind && !!admission && next?.status === 'admitted'
        && next.chatId === chatId && next.inputDigest === admission.inputDigest && next.ownerProcessEpoch === custody.ownerId
        && !!domain && currentDomain?.one_id === oneId && currentDomain.owner_epoch === domain.owner_epoch && currentDomain.generation === domain.generation
        && currentDomain.phase === 'active' && currentDomain.lease_until > Date.now();
    } catch { return false; }
  };
  if (!current() || !admission) return unavailable();
  const callId = randomUUID(), controller = new AbortController();
  // Leave room for the final native-channel step before ordinary 30 s MCP deadlines.
  const deadline = Date.now() + 18_000;
  const expiry = setTimeout(() => controller.abort(), 18_000); expiry.unref?.();
  const timer = setInterval(() => { if (!current()) controller.abort(); }, 500); timer.unref?.();
  try {
    if (!supervisorRunsInDaemon()) {
      const result = await requestPersonalOnePhoneToolForRun(oneId,runId,callId,name,input,controller.signal);
      return !controller.signal.aborted && current() ? result : unavailable();
    }
    const step = {runId,chatId,inputDigest:admission.inputDigest,callId,name,input};
    const bridge = daemonDeviceBridge();
    try {
      let reply = await bridge.phoneToolStep({...step,phase:'start'});
      while (reply.state === 'pending' && !controller.signal.aborted && Date.now()<deadline) {
        await new Promise<void>(resolve => setTimeout(resolve,400));
        if (!current()) return unavailable();
        reply = await bridge.phoneToolStep({...step,phase:'poll'});
      }
      return reply.state === 'done' && reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result)
        && current() && !controller.signal.aborted ? reply.result as PhoneToolResult : unavailable();
    } finally { void bridge.phoneToolStep({...step,phase:'cancel'}).catch(() => undefined); }
  } catch { return unavailable(); }
  finally { clearTimeout(expiry); clearInterval(timer); controller.abort(); }
}
