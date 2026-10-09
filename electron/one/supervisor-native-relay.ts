/** Private native-source registry. No caller-supplied URL/token can register a
 * relay. The original authenticated issuer owns its complete custody lifetime. */
type Relay = (name: string, input: Record<string, unknown>) => Promise<unknown>;
const relays = new Map<string, { chatId: string; relay: Relay }>();
export function registerSupervisorNativeRelay(chatId: string, runId: string, relay: Relay): () => void {
  if (relays.has(runId)) throw new Error("supervisor_native_relay_already_bound");
  const record = { chatId, relay }; relays.set(runId, record);
  return () => { if (relays.get(runId) === record) relays.delete(runId); };
}
export function supervisorNativeRelay(chatId: string, runId: string): Relay | null {
  const record = relays.get(runId); return record?.chatId === chatId ? record.relay : null;
}
