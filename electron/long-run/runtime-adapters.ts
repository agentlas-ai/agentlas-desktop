import {
  RUNTIME_ADAPTER_SCHEMA_VERSION,
  defaultRuntimeFeatureMap,
  type RuntimeAdapterDescriptor,
  type RuntimeFeature,
  type RuntimeFeatureSupport,
} from "../../shared/long-run";
import { RUNTIME_CAPABILITIES } from "../../shared/runtime-capabilities";
import type { RuntimeKind, RuntimeSelection } from "../../shared/types";

export interface ResolvedDesktopRuntimeAdapter {
  id: string;
  descriptor: RuntimeAdapterDescriptor;
  recoveryOrder: Array<"resident" | "native_resume" | "portable_resume" | "fresh_retry">;
}

const ALL_RUNTIME_KINDS: readonly RuntimeKind[] = [
  "claude-code",
  "codex",
  "antigravity",
  "kimi",
  "grok",
  "cursor",
  "byok",
  "ollama",
  "lmstudio",
  "mlx",
  "acp",
  "agentlas",
];

function featureMap(
  values: Partial<Record<RuntimeFeature, RuntimeFeatureSupport>>,
): Record<RuntimeFeature, RuntimeFeatureSupport> {
  return { ...defaultRuntimeFeatureMap(), ...values };
}

function descriptor(
  runtimeKind: RuntimeKind,
  features: Partial<Record<RuntimeFeature, RuntimeFeatureSupport>>,
): RuntimeAdapterDescriptor {
  const canonicalResume = RUNTIME_CAPABILITIES[runtimeKind].resume;
  return Object.freeze({
    schemaVersion: RUNTIME_ADAPTER_SCHEMA_VERSION,
    runtimeKind,
    executionLocation: "desktop-local",
    features: Object.freeze(featureMap({
      ...features,
      "session.native_resume": canonicalResume.implemented ? "supported" : "unsupported",
    })),
    limits: Object.freeze({ maxConcurrentTurns: 1 }),
    detectedFrom: "builtin-contract",
  });
}

const RESIDENT_CLI = featureMap({
  "session.resident": "supported",
  "stream.input": "supported",
  "stream.output": "supported",
  "turn.interrupt": "supported",
  "permission.relay": "supported",
  "context.compact": "supported",
  "snapshot.export": "unknown",
  "tool.idempotency": "unknown",
  "worker.child": "supported",
  "worker.message": "supported",
});

const ACP = featureMap({
  "session.resident": "supported",
  "stream.input": "supported",
  "stream.output": "supported",
  "turn.interrupt": "supported",
  "permission.relay": "supported",
  "context.compact": "unknown",
  "snapshot.export": "unknown",
  "tool.idempotency": "unknown",
  "worker.child": "unknown",
  "worker.message": "unknown",
});

const HOST_MANAGED = featureMap({
  "session.resident": "unsupported",
  "stream.input": "unsupported",
  "stream.output": "supported",
  "turn.interrupt": "supported",
  "permission.relay": "supported",
  "context.compact": "supported",
  "snapshot.export": "supported",
  "tool.idempotency": "unknown",
  "worker.child": "unsupported",
  "worker.message": "unsupported",
});

const LEGACY_CLI = featureMap({
  "session.resident": "unknown",
  "stream.input": "unknown",
  "stream.output": "supported",
  "turn.interrupt": "supported",
  "permission.relay": "supported",
  "context.compact": "unknown",
  "snapshot.export": "unknown",
  "tool.idempotency": "unknown",
  "worker.child": "unknown",
  "worker.message": "unknown",
});

const DESCRIPTORS = new Map<RuntimeKind, RuntimeAdapterDescriptor>([
  ["claude-code", descriptor("claude-code", RESIDENT_CLI)],
  ["codex", descriptor("codex", RESIDENT_CLI)],
  ["acp", descriptor("acp", ACP)],
  ["byok", descriptor("byok", HOST_MANAGED)],
  ["ollama", descriptor("ollama", HOST_MANAGED)],
  ["lmstudio", descriptor("lmstudio", HOST_MANAGED)],
  ["mlx", descriptor("mlx", HOST_MANAGED)],
  ["agentlas", descriptor("agentlas", HOST_MANAGED)],
  ["antigravity", descriptor("antigravity", LEGACY_CLI)],
  ["kimi", descriptor("kimi", LEGACY_CLI)],
  ["grok", descriptor("grok", LEGACY_CLI)],
  ["cursor", descriptor("cursor", LEGACY_CLI)],
]);

function recoveryOrderFor(value: RuntimeAdapterDescriptor): ResolvedDesktopRuntimeAdapter["recoveryOrder"] {
  const result: ResolvedDesktopRuntimeAdapter["recoveryOrder"] = [];
  if (value.features["session.resident"] === "supported") result.push("resident");
  if (value.features["session.native_resume"] === "supported") result.push("native_resume");
  result.push("portable_resume", "fresh_retry");
  return result;
}

export function desktopRuntimeAdapterDescriptorId(kind: RuntimeKind): string {
  return `desktop:${kind}:builtin-v1`;
}

export function resolveDesktopRuntimeAdapter(
  selection: Pick<RuntimeSelection, "kind">,
): ResolvedDesktopRuntimeAdapter {
  const value = DESCRIPTORS.get(selection.kind);
  if (!value) throw new Error(`desktop_runtime_adapter_unknown:${selection.kind}`);
  return {
    id: desktopRuntimeAdapterDescriptorId(selection.kind),
    descriptor: value,
    recoveryOrder: recoveryOrderFor(value),
  };
}

export function listDesktopRuntimeAdapterDescriptors(): ResolvedDesktopRuntimeAdapter[] {
  return ALL_RUNTIME_KINDS.map((kind) => resolveDesktopRuntimeAdapter({ kind }));
}
