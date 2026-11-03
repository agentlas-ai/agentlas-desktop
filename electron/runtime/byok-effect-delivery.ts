import { snapshotEffectDelivery } from "./effect-delivery";

type RecordEntry = { result: object; parts: readonly object[]; part: object; correlation: string; projection: unknown; flag?: string };
/** Objects here are Main-held identity references, never provider-controlled authority. */
export class ByokEffectDelivery {
  private readonly anthropic: RecordEntry[] = [];
  private readonly google: RecordEntry[] = [];
  addAnthropic(result: object, parts: object[], part: { type: string; tool_use_id: string; content: unknown; is_error?: boolean }): void {
    this.anthropic.push({ result, parts, part, correlation: part.tool_use_id, flag: JSON.stringify(part.is_error ?? null), projection: JSON.parse(JSON.stringify(part.content)) });
  }
  addGoogle(result: object, parts: object[], part: { functionResponse?: { id?: string; name: string; response: unknown } }): void {
    const response = part.functionResponse;
    if (!response) return;
    this.google.push({ result, parts, part, correlation: JSON.stringify([response.id ?? null, response.name]), projection: JSON.parse(JSON.stringify(response)) });
  }
  anthropicProof(body: string, messages: readonly { role: string; content: unknown }[]): object {
    const wire = JSON.parse(body) as { messages?: Array<{role?: unknown; content?: unknown}> };
    const counts = new Map<string, number>();
    for (const message of wire.messages ?? []) if (message.role === "user" && Array.isArray(message.content)) for (const block of message.content) {
      if (block && block.type === "tool_result" && typeof block.tool_use_id === "string") counts.set(block.tool_use_id, (counts.get(block.tool_use_id) ?? 0) + 1);
    }
    const candidates = this.anthropic.flatMap((r) => {
      const message = messages.findIndex(m => m.content === r.parts), part = r.parts.indexOf(r.part);
      const block = message >= 0 && part >= 0 && Array.isArray(wire.messages?.[message]?.content) ? (wire.messages![message].content as any[])[part] : null;
      if (counts.get(r.correlation) !== 1 || wire.messages?.[message]?.role !== "user" || !block || block.type !== "tool_result" || block.tool_use_id !== r.correlation || JSON.stringify(block.is_error ?? null) !== r.flag) return [];
      return [{ result:r.result, projection:r.projection, path:["messages",message,"content",part,"content"] }];
    });
    return snapshotEffectDelivery(body, candidates);
  }
  googleProof(body: string, messages: readonly { role: string; parts: readonly object[] }[]): object {
    const wire = JSON.parse(body) as {contents?: Array<{role?: unknown; parts?: any[]}>};
    const candidates = this.google.flatMap((r) => {
      const message = messages.findIndex(m => m.parts === r.parts), part = r.parts.indexOf(r.part);
      const wireMessage = wire.contents?.[message];
      const response = message >= 0 && part >= 0 ? wireMessage?.parts?.[part]?.functionResponse : null;
      const key = response ? JSON.stringify([response.id ?? null,response.name]) : "";
      const count = wireMessage?.parts?.filter(p => p?.functionResponse && JSON.stringify([p.functionResponse.id ?? null,p.functionResponse.name]) === r.correlation).length ?? 0;
      if (count !== 1 || wireMessage?.role !== "user" || key !== r.correlation) return [];
      return [{result:r.result,projection:r.projection,path:["contents",message,"parts",part,"functionResponse"]}];
    });
    return snapshotEffectDelivery(body,candidates);
  }
}
