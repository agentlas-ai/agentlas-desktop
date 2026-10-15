import type { MobileBridgeContextSnapshotDto } from "../../shared/mobile-bridge";
import type { ContextSnapshot } from "../harness/context-inspect";

/**
 * Typed phone projection of agentlas.context-snapshot.v1 (docs/2026-10-13-native-harness/20 §6).
 * Field whitelist: run/call/request ids, occurrence digests, attempt, role and mode stay on the Desktop; the snapshot's
 * retained originals never cross (they are read on the Desktop through context.sources.get). Unknown stays null — never 0.
 */
export function projectMobileBridgeContext(snapshot: ContextSnapshot): MobileBridgeContextSnapshotDto {
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const ratio = typeof snapshot.usedRatio === "number" && Number.isFinite(snapshot.usedRatio)
    ? Math.min(1, Math.max(0, snapshot.usedRatio)) : null;
  const cached = count(snapshot.input.cachedTokens);
  const output = count(snapshot.outputTokens);
  const tools = count(snapshot.toolsCount);
  const over = count(snapshot.overAttributedTokens);
  const session = snapshot.views?.sessionCumulative;
  return {
    schemaVersion: 1,
    status: snapshot.status,
    ...(snapshot.request ? {
      observedAt: snapshot.request.ts,
      runtimeKind: snapshot.request.runtimeKind.slice(0, 64),
      model: snapshot.request.model === null ? null : snapshot.request.model.slice(0, 128),
    } : {}),
    capacityTokens: count(snapshot.capacity.tokens),
    inputTokens: count(snapshot.input.tokens),
    inputMeasurement: snapshot.input.measurement,
    ...(cached === null ? {} : { cachedTokens: cached }),
    ...(output === null ? {} : { outputTokens: output }),
    rotationAtTokens: count(snapshot.rotationAtTokens),
    usedRatio: ratio,
    items: snapshot.items.map((item) => ({
      category: item.category, tokens: count(item.tokens), measurement: item.measurement,
    })),
    unattributedTokens: count(snapshot.unattributedTokens),
    ...(tools === null ? {} : { toolsCount: tools }),
    ...(snapshot.capacity.source === "runtime-reported" || snapshot.capacity.source === "model-catalog" ? { capacitySource: snapshot.capacity.source } : {}),
    ...(over === null || over === 0 ? {} : { overAttributedTokens: over }),
    ...(session ? { sessionCumulative: {
      requests: count(session.requests) ?? 0, inputTokens: count(session.inputTokens) ?? 0,
      outputTokens: count(session.outputTokens) ?? 0, unmeasuredRequests: count(session.unmeasuredRequests) ?? 0,
    } } : {}),
  };
}
