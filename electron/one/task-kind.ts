import { createHmac, randomBytes } from "node:crypto";
import type { InstalledAgent } from "../../shared/types";
import { buildEffectiveAgentSystemPrompt } from "../agents/files";
import { getDb } from "../store/db";

const TASK_KIND_SALT_META_KEY = "agentlas.one.task-kind.salt.v1";
const SALT_RE = /^[a-f0-9]{64}$/;
const SAFE_PARTICIPANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_PROMPT_CODE_POINTS = 8_192;
const MAX_PROMPT_UTF8_BYTES = 32_768;
const MAX_RAW_PROMPT_CODE_UNITS = 32_768;
const MAX_INPUT_REFS = 32;
const MAX_INPUT_REF_UTF8_BYTES = 512;
const MAX_INPUT_REFS_UTF8_BYTES = 16_384;
const MAX_PARTICIPANTS = 16;
const MAX_PARTICIPANT_VERSION_MATERIAL_UTF8_BYTES = 1024 * 1024;
const MAX_PARTICIPANT_LIST_ITEMS = 128;
const MAX_PARTICIPANT_ITEM_CODE_UNITS = 512;
const MAX_EFFECTIVE_PROMPT_UTF8_BYTES = 4 * 1024 * 1024;
const MAX_EFFECTIVE_PROMPTS_UTF8_BYTES = MAX_PARTICIPANTS * MAX_EFFECTIVE_PROMPT_UTF8_BYTES;
const EFFECTIVE_PROMPT_REF_RE = /^effective-prompt:[a-f0-9]{64}$/;

export interface OneTaskKindInput {
  userPrompt: string;
  projectId: string | null;
  firmId: string | null;
  agentGroupId: string | null;
  ownerAgentId: string;
  /** Main-derived, content-free input identities. Raw paths and names are forbidden. */
  inputRefs: string[];
}

export interface OneParticipantVersionBinding {
  agentId: string;
  agentSlug: string;
  /** Host-local HMAC over the exact execution-relevant installed definition. */
  versionRef: `participant-version:${string}`;
  /** Host-local opaque HMAC over the exact effective prompt bytes passed to the runner. */
  effectivePromptRef: `effective-prompt:${string}`;
}

/** Main-memory-only bytes. These are never written to run events or Mobile projections. */
export interface OneParticipantEffectivePromptSnapshot {
  agentId: string;
  agentSlug: string;
  effectivePrompt: string;
  effectivePromptRef: `effective-prompt:${string}`;
}

export interface OneParticipantExecutionSnapshot {
  bindings: OneParticipantVersionBinding[];
  effectivePrompts: OneParticipantEffectivePromptSnapshot[];
}

function localSalt(): string {
  const db = getDb();
  const prior = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(TASK_KIND_SALT_META_KEY) as { value?: unknown } | undefined;
  if (typeof prior?.value === "string") {
    if (!SALT_RE.test(prior.value)) throw new Error("Stored One Task-kind salt is corrupt; it was not overwritten");
    return prior.value;
  }
  const generated = randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
    .run(TASK_KIND_SALT_META_KEY, generated);
  const converged = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(TASK_KIND_SALT_META_KEY) as { value?: unknown } | undefined;
  if (typeof converged?.value !== "string" || !SALT_RE.test(converged.value)) {
    throw new Error("Could not initialize the One Task-kind salt");
  }
  return converged.value;
}

function normalizedIntent(prompt: string): string | null {
  if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > MAX_RAW_PROMPT_CODE_UNITS) return null;
  // Comparability must never erase a number, date, URL, email, or path. Only
  // Unicode representation and whitespace layout are normalized before HMAC.
  const normalized = prompt.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > MAX_PROMPT_CODE_POINTS) return null;
  return Buffer.byteLength(normalized, "utf8") <= MAX_PROMPT_UTF8_BYTES ? normalized : null;
}

function normalizedInputRefs(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MAX_INPUT_REFS) return null;
  let totalBytes = 0;
  const refs: string[] = [];
  for (const item of input) {
    if (
      typeof item !== "string"
      || item.length < 1
      || item.length > MAX_INPUT_REF_UTF8_BYTES
      || /[\u0000-\u001f\u007f]/u.test(item)
    ) return null;
    const bytes = Buffer.byteLength(item, "utf8");
    if (bytes > MAX_INPUT_REF_UTF8_BYTES) return null;
    totalBytes += bytes;
    if (totalBytes > MAX_INPUT_REFS_UTF8_BYTES) return null;
    refs.push(item);
  }
  // Input order is not task meaning. Duplicates remain significant, so two
  // identical attachments cannot collapse into one.
  return refs.sort((left, right) => left.localeCompare(right, "en-US"));
}

function boundedOptional(value: string | null | undefined, maxBytes = 512): string | null | undefined {
  if (value == null) return null;
  return typeof value === "string"
    && value.length <= maxBytes
    && Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : undefined;
}

/**
 * Snapshot the exact installed definitions and effective prompt bytes selected
 * by Main immediately before the durable invocation start. Only `bindings` are
 * durable; `effectivePrompts` remain Main-memory-only and feed the executor.
 */
export function snapshotOneParticipantExecution(
  participants: InstalledAgent[],
): OneParticipantExecutionSnapshot | null {
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > MAX_PARTICIPANTS) return null;
  const seen = new Set<string>();
  const salt = Buffer.from(localSalt(), "hex");
  const bindings: OneParticipantVersionBinding[] = [];
  const effectivePrompts: OneParticipantEffectivePromptSnapshot[] = [];
  let effectivePromptBytes = 0;
  for (const participant of participants) {
    if (
      !participant
      || !SAFE_PARTICIPANT_ID_RE.test(participant.id)
      || !SAFE_PARTICIPANT_ID_RE.test(participant.slug)
      || seen.has(participant.id)
      || typeof participant.systemPrompt !== "string"
      || participant.systemPrompt.length > MAX_PARTICIPANT_VERSION_MATERIAL_UTF8_BYTES
      || !Array.isArray(participant.mcpServers)
      || participant.mcpServers.length > MAX_PARTICIPANT_LIST_ITEMS
      || participant.mcpServers.some((item) => typeof item !== "string" || item.length > MAX_PARTICIPANT_ITEM_CODE_UNITS)
      || !Array.isArray(participant.envRequirements)
      || participant.envRequirements.length > MAX_PARTICIPANT_LIST_ITEMS
      || participant.envRequirements.some((item) =>
        !item
        || typeof item.key !== "string"
        || item.key.length > MAX_PARTICIPANT_ITEM_CODE_UNITS
        || typeof item.required !== "boolean")
    ) return null;
    seen.add(participant.id);
    const packageHash = boundedOptional(participant.packageHash);
    const assetSource = boundedOptional(participant.assetSource);
    const runtimeLabel = boundedOptional(participant.runtimeLabel);
    const preferredBackend = boundedOptional(participant.preferredBackend);
    const installedAt = boundedOptional(participant.installedAt, 128);
    const localPath = boundedOptional(participant.localPath, 4_096);
    if (
      packageHash === undefined
      || assetSource === undefined
      || runtimeLabel === undefined
      || preferredBackend === undefined
      || !installedAt
      || localPath === undefined
    ) return null;
    let effectivePrompt: string;
    try {
      // Read canonical prompt and package-owned SKILL.md bytes exactly once.
      // The returned string is both digested below and handed to the executor;
      // later filesystem changes cannot alter this run's prompt.
      effectivePrompt = buildEffectiveAgentSystemPrompt(participant.id, participant.systemPrompt);
    } catch {
      return null;
    }
    const promptBytes = Buffer.byteLength(effectivePrompt, "utf8");
    effectivePromptBytes += promptBytes;
    if (
      promptBytes > MAX_EFFECTIVE_PROMPT_UTF8_BYTES
      || effectivePromptBytes > MAX_EFFECTIVE_PROMPTS_UTF8_BYTES
    ) return null;
    const effectivePromptRef = `effective-prompt:${createHmac("sha256", salt)
      .update("agentlas-one-effective-prompt-v1\u0000", "utf8")
      .update(effectivePrompt, "utf8")
      .digest("hex")}` as const;
    const versionMaterial = JSON.stringify({
      schemaVersion: 2,
      domain: "agentlas-one-participant-version",
      agentId: participant.id,
      agentSlug: participant.slug,
      installedAt,
      packageHash: packageHash ?? null,
      assetSource: assetSource ?? null,
      kind: participant.kind ?? "agent",
      runtimeLabel: runtimeLabel ?? null,
      preferredBackend: preferredBackend ?? null,
      localPath: localPath ?? null,
      systemPrompt: participant.systemPrompt,
      mcpServers: [...participant.mcpServers].sort((left, right) => left.localeCompare(right, "en-US")),
      envRequirements: participant.envRequirements
        .map((item) => ({ key: item.key, required: item.required }))
        .sort((left, right) => left.key.localeCompare(right.key, "en-US")),
      effectivePromptRef,
    });
    if (Buffer.byteLength(versionMaterial, "utf8") > MAX_PARTICIPANT_VERSION_MATERIAL_UTF8_BYTES) return null;
    const versionRef = `participant-version:${createHmac("sha256", salt)
      .update(versionMaterial, "utf8")
      .digest("hex")}` as const;
    bindings.push({
      agentId: participant.id,
      agentSlug: participant.slug,
      versionRef,
      effectivePromptRef,
    });
    effectivePrompts.push({
      agentId: participant.id,
      agentSlug: participant.slug,
      effectivePrompt,
      effectivePromptRef,
    });
  }
  bindings.sort((left, right) => left.agentId.localeCompare(right.agentId, "en-US"));
  effectivePrompts.sort((left, right) => left.agentId.localeCompare(right.agentId, "en-US"));
  return { bindings, effectivePrompts };
}

/** Compatibility helper for receipt-only callers. New execution code must keep the full snapshot. */
export function deriveOneParticipantVersionBindings(
  participants: InstalledAgent[],
): OneParticipantVersionBinding[] | null {
  return snapshotOneParticipantExecution(participants)?.bindings ?? null;
}

/**
 * Revalidate the in-memory snapshot at dispatch and expose only exact agent-id
 * lookups. This prevents a caller from swapping prompt bytes after Main minted
 * the receipt, while keeping all private prompt content out of durable state.
 */
export function validatedOneParticipantEffectivePromptMap(
  value: unknown,
): ReadonlyMap<string, OneParticipantEffectivePromptSnapshot> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "bindings,effectivePrompts") return null;
  if (
    !Array.isArray(root.bindings)
    || !Array.isArray(root.effectivePrompts)
    || root.bindings.length < 1
    || root.bindings.length > MAX_PARTICIPANTS
    || root.effectivePrompts.length !== root.bindings.length
  ) return null;
  const bindingById = new Map<string, OneParticipantVersionBinding>();
  for (const raw of root.bindings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "agentId,agentSlug,effectivePromptRef,versionRef") return null;
    if (
      typeof item.agentId !== "string"
      || !SAFE_PARTICIPANT_ID_RE.test(item.agentId)
      || typeof item.agentSlug !== "string"
      || !SAFE_PARTICIPANT_ID_RE.test(item.agentSlug)
      || typeof item.versionRef !== "string"
      || !/^participant-version:[a-f0-9]{64}$/.test(item.versionRef)
      || typeof item.effectivePromptRef !== "string"
      || !EFFECTIVE_PROMPT_REF_RE.test(item.effectivePromptRef)
      || bindingById.has(item.agentId)
    ) return null;
    bindingById.set(item.agentId, item as unknown as OneParticipantVersionBinding);
  }
  const result = new Map<string, OneParticipantEffectivePromptSnapshot>();
  let totalBytes = 0;
  for (const raw of root.effectivePrompts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "agentId,agentSlug,effectivePrompt,effectivePromptRef") return null;
    const binding = typeof item.agentId === "string" ? bindingById.get(item.agentId) : undefined;
    if (
      !binding
      || typeof item.agentSlug !== "string"
      || item.agentSlug !== binding.agentSlug
      || typeof item.effectivePrompt !== "string"
      || typeof item.effectivePromptRef !== "string"
      || item.effectivePromptRef !== binding.effectivePromptRef
      || result.has(binding.agentId)
    ) return null;
    const bytes = Buffer.byteLength(item.effectivePrompt, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_EFFECTIVE_PROMPT_UTF8_BYTES || totalBytes > MAX_EFFECTIVE_PROMPTS_UTF8_BYTES) return null;
    const actualRef = `effective-prompt:${createHmac("sha256", Buffer.from(localSalt(), "hex"))
      .update("agentlas-one-effective-prompt-v1\u0000", "utf8")
      .update(item.effectivePrompt, "utf8")
      .digest("hex")}`;
    if (actualRef !== binding.effectivePromptRef) return null;
    result.set(binding.agentId, {
      agentId: binding.agentId,
      agentSlug: binding.agentSlug,
      effectivePrompt: item.effectivePrompt,
      effectivePromptRef: binding.effectivePromptRef,
    });
  }
  return result.size === bindingById.size ? result : null;
}

/** The only One dispatcher accessor for private frozen prompt bytes. */
export function exactOneParticipantEffectivePrompt(
  prompts: ReadonlyMap<string, OneParticipantEffectivePromptSnapshot>,
  agentId: string,
  agentSlug: string,
): string | null {
  if (!SAFE_PARTICIPANT_ID_RE.test(agentId) || !SAFE_PARTICIPANT_ID_RE.test(agentSlug)) return null;
  const frozen = prompts.get(agentId);
  return frozen?.agentSlug === agentSlug ? frozen.effectivePrompt : null;
}

/**
 * Main-only, product-owned Task-kind receipt. The raw prompt and normalized
 * intent never leave this call; only a host-salted opaque reference is durable.
 */
export function deriveOneTaskKindRef(input: OneTaskKindInput): string | null {
  if (!input || typeof input !== "object") return null;
  const intent = normalizedIntent(input.userPrompt);
  const inputRefs = normalizedInputRefs(input.inputRefs);
  const projectId = boundedOptional(input.projectId);
  const firmId = boundedOptional(input.firmId);
  const agentGroupId = boundedOptional(input.agentGroupId);
  if (
    !intent
    || !input.ownerAgentId
    || !SAFE_PARTICIPANT_ID_RE.test(input.ownerAgentId)
    || !inputRefs
    || projectId === undefined
    || firmId === undefined
    || agentGroupId === undefined
  ) return null;
  const digest = createHmac("sha256", Buffer.from(localSalt(), "hex"))
    .update(JSON.stringify({
      schemaVersion: 1,
      domain: "agentlas-one-task-kind",
      intent,
      projectId,
      firmId,
      agentGroupId,
      ownerAgentId: input.ownerAgentId,
      inputRefs,
    }), "utf8")
    .digest("hex");
  return `task-kind:${digest}`;
}
