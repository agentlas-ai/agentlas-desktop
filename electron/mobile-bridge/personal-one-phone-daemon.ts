import { createHash } from 'node:crypto';
import type { PhoneToolName, PhoneToolResult } from './personal-one-phone-tools';

type Phase = 'start' | 'poll' | 'cancel';
export type DaemonPhoneStep = { phase: Phase; runId: string; chatId: string; inputDigest: string; callId: string;
  name: PhoneToolName; input: Record<string, unknown> };
type Job = { key: string; source: string; abort: AbortController; result?: PhoneToolResult; timer: ReturnType<typeof setTimeout> };
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const unavailable = () => ({ state: 'unavailable' as const });

/** Each short step is bound to the authenticated daemon channel and the exact
 * durable run. Phone data exists only in memory until the result expires. */
export function createDaemonPhoneJobs(options: {
  current(input: DaemonPhoneStep, bootId: string, channelCurrent: () => boolean): Promise<boolean>;
  request(input: DaemonPhoneStep, signal: AbortSignal): Promise<PhoneToolResult>;
  timeoutMs?: number;
}) {
  const jobs = new Map<string, Job>();
  const timeoutMs = options.timeoutMs ?? 65_000;
  async function step(input: DaemonPhoneStep, bootId: string, channelCurrent: () => boolean) {
    if (!input || !['start', 'poll', 'cancel'].includes(input.phase) || !identifier(input.runId) || !identifier(input.chatId)
      || !identifier(input.callId) || !identifier(bootId) || !/^[a-f0-9]{64}$/.test(input.inputDigest)
      || !['phone.location.get', 'phone.device.context'].includes(input.name) || !input.input || typeof input.input !== 'object'
      || Array.isArray(input.input) || JSON.stringify(input.input).length > 2048) return unavailable();
    const key = JSON.stringify([bootId, input.runId, input.callId]);
    const source = createHash('sha256').update(JSON.stringify([input.chatId, input.inputDigest, input.name, input.input])).digest('hex');
    let existing = jobs.get(key);
    if (input.phase === 'cancel') {
      if (existing?.source === source) { existing.abort.abort(); clearTimeout(existing.timer); jobs.delete(key); }
      return unavailable();
    }
    let allowed = false;
    try { allowed = channelCurrent() && await options.current(input, bootId, channelCurrent) && channelCurrent(); } catch { /* unavailable */ }
    if (!allowed) {
      if (existing?.source === source) { existing.abort.abort(); clearTimeout(existing.timer); jobs.delete(key); }
      return unavailable();
    }
    existing = jobs.get(key);
    if (existing) {
      if (existing.source !== source) return unavailable();
      return existing.result ? { state: 'done' as const, result: existing.result } : { state: 'pending' as const };
    }
    if (input.phase !== 'start' || jobs.size >= 64) return unavailable();
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); jobs.delete(key); }, timeoutMs); timer.unref?.();
    const job: Job = { key, source, abort, timer };
    jobs.set(key, job);
    void options.request(input, abort.signal).then(result => {
      if (jobs.get(key) === job && !abort.signal.aborted) job.result = result;
    }, () => { if (jobs.get(key) === job) job.result = { status: 'unavailable', reason: 'phone_no_answer' }; });
    return { state: 'pending' as const };
  }
  function close() { for (const job of jobs.values()) { job.abort.abort(); clearTimeout(job.timer); } jobs.clear(); }
  return { step, close };
}
