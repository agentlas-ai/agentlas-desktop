/*
 * Which wire a BYOK backend speaks (docs/2026-10-13-native-harness/13 §7). Chat Completions is the default everywhere;
 * a backend listed here may also speak another documented wire, chosen only by the owner (harness byok.wire.set from an
 * owner surface). DeepSeek Responses is stateless (deepseek-responses.ts), so choosing it changes the transport only —
 * history, tools and jobs stay Agentlas-owned. No electron import.
 */
import fs from "node:fs";
import path from "node:path";

export type ByokWire = "chat" | "responses";
export const BYOK_WIRES: Readonly<Record<string, readonly ByokWire[]>> = { deepseek: ["chat", "responses"] };

async function wireFile(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath("byok-wire.json");
}

async function readAll(): Promise<Record<string, unknown>> {
  try { return JSON.parse(fs.readFileSync(await wireFile(), "utf8")) as Record<string, unknown>; } catch { return {}; }
}

export async function readByokWire(backend: string): Promise<ByokWire> {
  const allowed = BYOK_WIRES[backend];
  if (!allowed) return "chat";
  const value = (await readAll())[backend];
  return allowed.includes(value as ByokWire) ? value as ByokWire : "chat";
}

export async function readByokWires(): Promise<Record<string, ByokWire>> {
  const out: Record<string, ByokWire> = {};
  for (const backend of Object.keys(BYOK_WIRES)) out[backend] = await readByokWire(backend);
  return out;
}

export async function writeByokWire(backend: string, wire: ByokWire): Promise<ByokWire> {
  const allowed = BYOK_WIRES[backend];
  if (!allowed || !allowed.includes(wire)) throw new Error("byok_wire_unsupported");
  const file = await wireFile();
  const all = await readAll();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ ...all, [backend]: wire }, null, 2), { mode: 0o600 });
  return wire;
}
