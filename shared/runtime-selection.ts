// The one place a RuntimeSelection is built from a detected runtime, compared
// by identity, or validated at a Main boundary.
//
// ★2026-09-23 감사 — 같은 결함이 여섯 자리에서 따로 났다: 선택을 kind/backend/source 로
//   다시 조립하면서 `acpAgentId`(ACP 좌석의 정확한 신원)를 빠뜨렸다. Work 첫 화면·Work 채팅의
//   모델 변경·자동화 저장·에이전트별 런타임 고정이 ACP 엔진에서 전부 거절되거나(“An ACP chat
//   runtime pin requires acpAgentId”) 조용히 역할 풀로 새어 나갔다. 또 “기본값” 행이 보내는
//   빈 문자열("")을 어떤 검사기는 값으로, 어떤 검사기는 부재로 읽어 같은 핀의 해시가 갈렸다.
//   조립·비교·검사를 이 파일 한 곳으로 모은다. 선택을 손으로 만들지 말고 여기 함수를 쓴다
//   (scripts/local/runtime-selection-single-builder-contract.cjs 가 렌더러를 훑어 막는다).
import { RUNTIME_BACKEND_SET } from "./runtime-backends";
import { RUNTIME_KINDS } from "./runtime-kinds";
import type { RuntimeBackend, RuntimeKind, RuntimeRole, RuntimeSelection, RuntimeStatus } from "./types";

const KIND_SET: ReadonlySet<string> = new Set<string>(RUNTIME_KINDS);

/** Every key RuntimeSelection declares. A validator that knows the type knows the contract. */
export const RUNTIME_SELECTION_KEYS = [
  "kind", "backend", "source", "acpAgentId", "label", "role", "inherit", "model", "longContext", "effort",
] as const satisfies readonly (keyof RuntimeSelection)[];
type _MissingSelectionKey = Exclude<keyof RuntimeSelection, (typeof RUNTIME_SELECTION_KEYS)[number]>;
const _selectionKeysExhaustive: _MissingSelectionKey extends never ? true : never = true;
void _selectionKeysExhaustive;

const KEY_SET: ReadonlySet<string> = new Set<string>(RUNTIME_SELECTION_KEYS);

/** "" / whitespace / null mean "not chosen" — the picker's Default row sends "". */
export function selectionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

type RuntimeIdentity = Pick<RuntimeSelection, "kind" | "backend" | "source" | "acpAgentId">;
type RuntimeLike = Pick<RuntimeStatus, "kind" | "backend" | "source"> & {
  acpAgentId?: string | null;
  label?: string | null;
  model?: string | null;
  effort?: string | null;
  longContextEnabled?: boolean | null;
};

export interface RuntimeSelectionChoice {
  /** undefined keeps the runtime's current value; "" or null means "use the engine default". */
  model?: string | null;
  /** undefined keeps the runtime's current value; "" or null means "default effort". */
  effort?: string | null;
  longContext?: boolean;
  role?: RuntimeRole;
  inherit?: boolean;
  /**
   * CLI paths change on upgrade/reinstall. Surfaces that pin "this engine" rather than
   * "this binary" (Work chat model chip) omit the path. Default: include it.
   */
  includeSource?: boolean;
}

/**
 * Build the exact pin for a detected runtime. ACP seats always carry their
 * `acpAgentId` (and display label); every other kind never does. Empty text is
 * dropped so the object has only keys that carry a value (IPC-safe).
 */
export function selectionForRuntime(runtime: RuntimeLike, choice: RuntimeSelectionChoice = {}): RuntimeSelection {
  const model = choice.model === undefined ? selectionText(runtime.model) : selectionText(choice.model);
  const effort = choice.effort === undefined ? selectionText(runtime.effort) : selectionText(choice.effort);
  const out: RuntimeSelection = { kind: runtime.kind };
  if (runtime.backend) out.backend = runtime.backend;
  const source = choice.includeSource === false ? undefined : selectionText(runtime.source);
  if (source) out.source = source;
  if (runtime.kind === "acp") {
    const acpAgentId = selectionText(runtime.acpAgentId);
    if (acpAgentId) out.acpAgentId = acpAgentId;
    const label = selectionText(runtime.label);
    if (label) out.label = label;
  }
  if (model) out.model = model;
  if (effort) out.effort = effort;
  const longContext = choice.longContext ?? (runtime.kind === "byok" ? Boolean(runtime.longContextEnabled) : undefined);
  if (longContext !== undefined) out.longContext = longContext;
  if (choice.role) out.role = choice.role;
  if (choice.inherit !== undefined) out.inherit = choice.inherit;
  return out;
}

/** Apply a model/effort pick to an existing selection. "" removes the key (engine default). */
export function withSelectionChoice(
  selection: RuntimeSelection,
  patch: { model?: string | null; effort?: string | null },
): RuntimeSelection {
  const next: RuntimeSelection = { ...selection };
  for (const key of ["model", "effort"] as const) {
    if (patch[key] === undefined) continue;
    const value = selectionText(patch[key]);
    if (value) next[key] = value;
    else delete next[key];
  }
  return next;
}

/**
 * Does a detected runtime satisfy a (possibly partial) pin? backend/source are
 * optional narrowing; an ACP pin must name its exact seat.
 */
export function runtimeMatchesSelection(runtime: RuntimeLike, selection: RuntimeIdentity): boolean {
  if (runtime.kind !== selection.kind) return false;
  if (selection.backend && runtime.backend !== selection.backend) return false;
  if (selection.source && runtime.source !== selection.source) return false;
  if (selection.kind === "acp") {
    const wanted = selectionText(selection.acpAgentId);
    return Boolean(wanted) && selectionText(runtime.acpAgentId) === wanted;
  }
  return true;
}

/** Full identity equality between two pins/runtimes (kind, backend, source, ACP seat). */
export function sameRuntimeIdentity(
  left: RuntimeIdentity | null | undefined,
  right: RuntimeIdentity | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return left.kind === right.kind
    && (selectionText(left.backend) ?? null) === (selectionText(right.backend) ?? null)
    && (selectionText(left.source) ?? null) === (selectionText(right.source) ?? null)
    && (selectionText(left.acpAgentId) ?? null) === (selectionText(right.acpAgentId) ?? null);
}

/** Stable option key. Two ACP seats share kind/backend and differ only by acpAgentId. */
export function runtimeIdentityKey(runtime: RuntimeIdentity, options: { includeSource?: boolean } = {}): string {
  return [
    runtime.kind,
    selectionText(runtime.backend) ?? "",
    options.includeSource === false ? "" : selectionText(runtime.source) ?? "",
    selectionText(runtime.acpAgentId) ?? "",
  ].join(":");
}

/**
 * Per-agent runtime overrides (agent_runtime_overrides) have no column for the
 * ACP seat, so an ACP override could never match at run time. Main refuses it
 * with `agent_runtime_override_acp_unsupported`; pickers hide/disable it.
 */
export function runtimeSupportsAgentOverride(runtime: Pick<RuntimeSelection, "kind">): boolean {
  return runtime.kind !== "acp";
}

/** Machine-coded refusal from the Main normalizer. `code` survives IPC via the boundary prefix. */
export class RuntimeSelectionContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeSelectionContractError";
    this.code = code;
  }
}

export interface NormalizeRuntimeSelectionOptions {
  /** Which roles this boundary accepts. Default: both. */
  roles?: readonly RuntimeRole[];
  /** Allow `inherit: true`. Default: true. */
  allowInherit?: boolean;
}

/**
 * The single Main-side shape check for a RuntimeSelection received from any
 * surface (renderer, mobile, stored JSON). "" / null / undefined are absence;
 * unknown keys, wrong types, and an ACP pin without its seat are refused with a
 * machine code. Returns a compact object (only keys with values).
 */
export function normalizeRuntimeSelectionInput(
  value: unknown,
  options: NormalizeRuntimeSelectionOptions = {},
): RuntimeSelection {
  const refuse = (code: string, message: string): never => {
    throw new RuntimeSelectionContractError(code, message);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refuse("runtime_selection_invalid", "Runtime selection must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(input)) {
    if (entry === undefined || entry === null) continue;
    if (!KEY_SET.has(key)) return refuse("runtime_selection_unknown_key", `Unknown runtime selection key: ${key.slice(0, 64)}`);
  }
  const rawKind = input.kind === "gemini" ? "antigravity" : input.kind;
  if (typeof rawKind !== "string" || !KIND_SET.has(rawKind)) {
    return refuse("runtime_selection_kind_invalid", "Unknown runtime kind");
  }
  const kind = rawKind as RuntimeKind;
  const text = (key: string, max: number): string | undefined => {
    const entry = input[key];
    if (entry === undefined || entry === null) return undefined;
    if (typeof entry !== "string" || entry.length > max) {
      return refuse("runtime_selection_field_invalid", `Invalid runtime selection ${key}`);
    }
    return selectionText(entry);
  };
  const flag = (key: string): boolean | undefined => {
    const entry = input[key];
    if (entry === undefined || entry === null) return undefined;
    if (typeof entry !== "boolean") return refuse("runtime_selection_field_invalid", `Invalid runtime selection ${key}`);
    return entry;
  };
  const backend = text("backend", 64);
  if (backend !== undefined && !RUNTIME_BACKEND_SET.has(backend)) {
    return refuse("runtime_selection_backend_invalid", "Unknown runtime backend");
  }
  const legacyGemini = input.kind === "gemini";
  const source = legacyGemini ? undefined : text("source", 2_048);
  const acpAgentId = legacyGemini ? undefined : text("acpAgentId", 256);
  const label = legacyGemini ? undefined : text("label", 256);
  const model = legacyGemini ? undefined : text("model", 512);
  const effort = text("effort", 80);
  const roleText = text("role", 32);
  const longContext = flag("longContext");
  const inherit = flag("inherit");
  if (roleText !== undefined && roleText !== "orchestrator" && roleText !== "worker") {
    return refuse("runtime_selection_role_invalid", "Unknown runtime role");
  }
  const role = roleText as RuntimeRole | undefined;
  if (role && options.roles && !options.roles.includes(role)) {
    return refuse("runtime_selection_role_invalid", `This surface does not accept the ${role} role`);
  }
  if (inherit === true && options.allowInherit === false) {
    return refuse("runtime_selection_inherit_invalid", "This surface does not accept an inherited runtime");
  }
  if (kind === "acp" && !acpAgentId) {
    return refuse("runtime_selection_acp_agent_required", "An ACP runtime selection requires acpAgentId");
  }
  if (kind !== "acp" && acpAgentId !== undefined) {
    return refuse("runtime_selection_acp_agent_forbidden", "Only an ACP runtime selection can include acpAgentId");
  }
  const out: RuntimeSelection = { kind };
  if (backend) out.backend = backend as RuntimeBackend;
  if (source) out.source = source;
  if (acpAgentId) out.acpAgentId = acpAgentId;
  if (label) out.label = label;
  if (role) out.role = role;
  if (inherit !== undefined) out.inherit = inherit;
  if (model) out.model = model;
  if (longContext !== undefined) out.longContext = longContext;
  if (effort) out.effort = effort;
  return out;
}

/** Non-throwing variant for validators that return booleans. */
export function isValidRuntimeSelectionInput(value: unknown, options?: NormalizeRuntimeSelectionOptions): boolean {
  try {
    normalizeRuntimeSelectionInput(value, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a selection persisted by an older build (localStorage drafts, cached pins):
 * unknown keys are dropped instead of refused, `overrides` fix surface-owned
 * fields (role/inherit/source), and anything the Main normalizer would refuse
 * (e.g. an ACP pin without its seat) reads as "no selection".
 */
export function readStoredRuntimeSelection(
  value: unknown,
  overrides: Partial<Record<(typeof RUNTIME_SELECTION_KEYS)[number], unknown>> = {},
): RuntimeSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of RUNTIME_SELECTION_KEYS) if (key in record) picked[key] = record[key];
  for (const [key, entry] of Object.entries(overrides)) picked[key] = entry;
  try {
    return normalizeRuntimeSelectionInput(picked);
  } catch {
    return null;
  }
}
