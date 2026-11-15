/** The exact v1 conversation frozen by the Companion service. This parser
 * validates data and order; it does not create a prompt or grant execution. */
export type CompanionWorkContext = Readonly<{
  version: 1;
  accountEpoch: number;
  throughUserSeq: number;
  dropped: 0;
  messages: ReadonlyArray<Readonly<{ id: string; turnId: string; seq: number; role: "user" | "assistant"; text: string }>>;
}>;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const TURN = /^trn_[A-Za-z0-9_-]{8,80}$/;
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
export function parseCompanionWorkContext(value: unknown, binding: { turnId: string; authEpoch: number; contextRevision: number }): CompanionWorkContext | null {
  if (!exact(value, ["version", "accountEpoch", "throughUserSeq", "dropped", "messages"]) || value.version !== 1 ||
      value.accountEpoch !== binding.authEpoch || value.throughUserSeq !== binding.contextRevision || value.dropped !== 0 ||
      !Number.isSafeInteger(value.accountEpoch) || Number(value.accountEpoch) < 0 || !Number.isSafeInteger(value.throughUserSeq) ||
      Number(value.throughUserSeq) < 1 || !TURN.test(binding.turnId) || !Array.isArray(value.messages) ||
      value.messages.length < 1 || value.messages.length > 40 || Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) return null;
  const seen = new Set<string>(); let previous = 0;
  for (let index = 0; index < value.messages.length; index++) {
    const row = value.messages[index];
    if (!exact(row, ["id", "turnId", "seq", "role", "text"]) || typeof row.id !== "string" || !row.id || row.id.length > 256 ||
        seen.has(row.id) || typeof row.turnId !== "string" || !ID.test(row.turnId) || !Number.isSafeInteger(row.seq) || Number(row.seq) < 1 ||
        (row.role !== "user" && row.role !== "assistant") || typeof row.text !== "string" || !row.text.trim() || row.text.length > 8000 ||
        /[\p{Cs}]/u.test(row.text) || Array.from(row.text).length > 4000) return null;
    seen.add(row.id);
    if (index === value.messages.length - 1) {
      if (row.role !== "user" || row.turnId !== binding.turnId || row.id !== `${binding.turnId}:000` || row.seq !== binding.contextRevision) return null;
    } else {
      if (row.turnId === binding.turnId || Number(row.seq) <= previous || (row.role === "user" && Number(row.seq) > binding.contextRevision)) return null;
      previous = Number(row.seq);
    }
  }
  return structuredClone(value) as CompanionWorkContext;
}
