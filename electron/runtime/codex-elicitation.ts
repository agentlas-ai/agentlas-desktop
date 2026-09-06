import { askUser, type AskUserOutcome, type AskUserRequest } from "../confirm/ask-user";

export const CODEX_MCP_ELICITATION_METHOD = "mcpServer/elicitation/request" as const;

type ElicitationAction = "accept" | "decline" | "cancel";
type ElicitationReason =
  | "answered"
  | "declined"
  | "timeout"
  | "no-surface"
  | "cancelled"
  | "invalid-request"
  | "invalid-answer"
  | "stale"
  | "unsupported";

export interface CodexMcpElicitationContext {
  chatId: string;
  threadId: string;
  turnId: string;
  unattended?: boolean;
  signal?: AbortSignal;
  /** Rechecked after the last answer, immediately before an accept response. */
  isCurrent: () => boolean;
}

export interface CodexMcpElicitationResult {
  response: { action: ElicitationAction; content?: Record<string, unknown> };
  receipt: {
    serverName: string;
    chatId: string;
    threadId: string;
    turnId: string;
    action: ElicitationAction;
    reason: ElicitationReason;
    fieldCount: number;
  };
}

export type CodexAskUser = (
  request: AskUserRequest,
  opts?: { unattended?: boolean; signal?: AbortSignal },
) => Promise<AskUserOutcome>;

type Choice = { value: string; label: string };
type Field = {
  key: string;
  title: string;
  description?: string;
  kind: "string" | "number" | "integer" | "boolean" | "single" | "multi";
  choices: Choice[];
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

const MAX_FIELDS = 8;
const MAX_CHOICES = 64;
const MAX_ANSWER_LENGTH = 4_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function finiteBound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function choicesFrom(schema: Record<string, unknown>): Choice[] | null {
  const rawEnum = Array.isArray(schema.enum) ? schema.enum : null;
  const rawOneOf = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : record(schema.items) && Array.isArray(record(schema.items)?.anyOf)
      ? record(schema.items)!.anyOf as unknown[]
      : null;
  const itemEnum = record(schema.items) && Array.isArray(record(schema.items)?.enum)
    ? record(schema.items)!.enum as unknown[]
    : null;
  if (rawOneOf) {
    if (rawOneOf.length === 0 || rawOneOf.length > MAX_CHOICES) return null;
    const output: Choice[] = [];
    for (const item of rawOneOf) {
      const option = record(item);
      const value = boundedText(option?.const, 500);
      const label = boundedText(option?.title, 200);
      if (!value || !label || output.some((candidate) => candidate.value === value || candidate.label === label)) return null;
      output.push({ value, label });
    }
    return output;
  }
  const values = rawEnum ?? itemEnum;
  if (!values || values.length === 0 || values.length > MAX_CHOICES || values.some((value) => typeof value !== "string" || !value)) return null;
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return values.map((value, index) => ({ value: String(value), label: typeof names[index] === "string" && names[index] ? String(names[index]) : String(value) }));
}

function parseField(key: string, value: unknown): Field | null {
  if (!key || key.length > 200 || FORBIDDEN_KEYS.has(key)) return null;
  const schema = record(value);
  if (!schema) return null;
  const type = schema.type;
  const title = boundedText(schema.title, 200) ?? key;
  const description = boundedText(schema.description, 500) ?? undefined;
  const common = { key, title, ...(description ? { description } : {}) };
  if (type === "boolean") return { ...common, kind: "boolean", choices: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
  if (type === "number" || type === "integer") {
    if ((schema.minimum != null && finiteBound(schema.minimum) == null) || (schema.maximum != null && finiteBound(schema.maximum) == null)) return null;
    const minimum = finiteBound(schema.minimum);
    const maximum = finiteBound(schema.maximum);
    if (minimum != null && maximum != null && minimum > maximum) return null;
    return { ...common, kind: type, choices: [], minimum, maximum };
  }
  if (type === "array") {
    const choices = choicesFrom(schema);
    if (!choices) return null;
    if ((schema.minItems != null && finiteCount(schema.minItems) == null) || (schema.maxItems != null && finiteCount(schema.maxItems) == null)) return null;
    const minItems = finiteCount(schema.minItems);
    const maxItems = finiteCount(schema.maxItems);
    if (minItems != null && maxItems != null && minItems > maxItems) return null;
    return { ...common, kind: "multi", choices, minItems, maxItems };
  }
  if (type !== "string") return null;
  const choices = choicesFrom(schema);
  if (schema.enum !== undefined || schema.oneOf !== undefined) {
    if (!choices) return null;
    return { ...common, kind: "single", choices };
  }
  if ((schema.minLength != null && finiteCount(schema.minLength) == null) || (schema.maxLength != null && finiteCount(schema.maxLength) == null)) return null;
  const minLength = finiteCount(schema.minLength);
  const maxLength = finiteCount(schema.maxLength);
  const format = schema.format == null ? undefined : schema.format;
  if (format != null && !["email", "uri", "date", "date-time"].includes(String(format))) return null;
  if (minLength != null && maxLength != null && minLength > maxLength) return null;
  return {
    ...common,
    kind: "string",
    choices: [],
    minLength,
    maxLength,
    format: format as Field["format"],
  };
}

function parseForm(params: Record<string, unknown>): { message: string; serverName: string; fields: Field[] } | null {
  if (params.mode !== "form") return null;
  const message = boundedText(params.message, 1_200);
  const serverName = boundedText(params.serverName, 200);
  const schema = record(params.requestedSchema);
  const properties = record(schema?.properties);
  if (!message || !serverName || schema?.type !== "object" || !properties) return null;
  if (Object.keys(schema).some((key) => !["$schema", "type", "properties", "required", "additionalProperties"].includes(key))) return null;
  if (schema.additionalProperties != null && schema.additionalProperties !== false) return null;
  const required = schema.required == null ? [] : schema.required;
  if (!Array.isArray(required) || required.some((key) => typeof key !== "string" || FORBIDDEN_KEYS.has(key))) return null;
  const requiredKeys = [...new Set(required as string[])];
  if (requiredKeys.length > MAX_FIELDS || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return null;
  const fields: Field[] = [];
  for (const key of requiredKeys) {
    const field = parseField(key, properties[key]);
    if (!field) return null;
    fields.push(field);
  }
  // Validate every declared property even though optional values are omitted.
  // This prevents a malformed/prototype-bearing schema from hiding outside the
  // required subset and later being mistaken for accepted structured content.
  const propertyKeys = Object.keys(properties);
  if (propertyKeys.length > MAX_FIELDS || propertyKeys.some((key) => !parseField(key, properties[key]))) return null;
  return { message, serverName, fields };
}

function optionValue(field: Field, raw: string): string | null {
  const direct = field.choices.find((choice) => choice.label === raw || choice.value === raw);
  return direct?.value ?? null;
}

function parseAnswer(field: Field, answer: string): { ok: true; value: unknown } | { ok: false } {
  const raw = answer.trim();
  if (!raw || raw.length > MAX_ANSWER_LENGTH) return { ok: false };
  if (field.kind === "string") {
    if (field.minLength != null && raw.length < field.minLength) return { ok: false };
    if (field.maxLength != null && raw.length > field.maxLength) return { ok: false };
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(raw)) return { ok: false };
    if (field.format === "uri") {
      try { if (!new URL(raw).protocol) return { ok: false }; } catch { return { ok: false }; }
    }
    if (field.format === "date") {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
      const parsed = match ? new Date(`${raw}T00:00:00.000Z`) : null;
      if (!match || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return { ok: false };
    }
    if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || Number.isNaN(Date.parse(raw)))) return { ok: false };
    return { ok: true, value: raw };
  }
  if (field.kind === "number" || field.kind === "integer") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (field.kind === "integer" && !Number.isInteger(value))) return { ok: false };
    if (field.minimum != null && value < field.minimum) return { ok: false };
    if (field.maximum != null && value > field.maximum) return { ok: false };
    return { ok: true, value };
  }
  if (field.kind === "boolean") {
    const value = optionValue(field, raw.toLowerCase() === "yes" ? "Yes" : raw.toLowerCase() === "no" ? "No" : raw.toLowerCase());
    if (value === "true") return { ok: true, value: true };
    if (value === "false") return { ok: true, value: false };
    return { ok: false };
  }
  if (field.kind === "single") {
    const value = optionValue(field, raw);
    return value == null ? { ok: false } : { ok: true, value };
  }
  const tokens = raw.split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
  const values = tokens.map((token) => optionValue(field, token));
  if (values.some((value) => value == null)) return { ok: false };
  const unique = [...new Set(values as string[])];
  if (field.minItems != null && unique.length < field.minItems) return { ok: false };
  if (field.maxItems != null && unique.length > field.maxItems) return { ok: false };
  return { ok: true, value: unique };
}

function questionFor(message: string, field: Field, retry: boolean): AskUserRequest {
  const multiHint = field.kind === "multi" ? " Select multiple values by entering labels separated by commas." : "";
  return {
    question: `${message}\n\n${field.title}${field.description ? ` — ${field.description}` : ""}${multiHint}${retry ? " The previous answer did not match the requested format; please try once more." : ""}`,
    options: field.choices.slice(0, 8).map((choice) => ({ label: choice.label, description: choice.value === choice.label ? undefined : choice.value })),
    allowFreeText: true,
  };
}

function finish(
  context: CodexMcpElicitationContext,
  serverName: string,
  action: ElicitationAction,
  reason: ElicitationReason,
  fieldCount: number,
  content?: Record<string, unknown>,
): CodexMcpElicitationResult {
  return {
    response: { action, ...(action === "accept" && content ? { content } : {}) },
    receipt: { serverName, chatId: context.chatId, threadId: context.threadId, turnId: context.turnId, action, reason, fieldCount },
  };
}

async function askSafely(ask: CodexAskUser, request: AskUserRequest, context: CodexMcpElicitationContext): Promise<AskUserOutcome> {
  try {
    return await ask(request, { unattended: context.unattended, signal: context.signal });
  } catch {
    // A renderer/IPC failure is never permission to invent a form answer.
    return { status: "cancelled" };
  }
}

export async function answerCodexMcpElicitation(
  rawParams: unknown,
  context: CodexMcpElicitationContext,
  ask: CodexAskUser = askUser,
): Promise<CodexMcpElicitationResult> {
  const params = record(rawParams);
  const serverName = boundedText(params?.serverName, 200) ?? "unknown";
  if (!params || params.threadId !== context.threadId || params.turnId !== context.turnId || !context.isCurrent()) {
    return finish(context, serverName, "cancel", "stale", 0);
  }
  if (params.mode === "url" || params.mode === "openai/form" || params.mode === "openaiForm") {
    return finish(context, serverName, "cancel", "unsupported", 0);
  }
  const form = parseForm(params);
  if (!form) return finish(context, serverName, "cancel", "invalid-request", 0);

  const content: Record<string, unknown> = {};
  if (form.fields.length === 0) {
    const outcome = await askSafely(ask, {
      question: form.message,
      options: [{ label: "Accept" }, { label: "Decline" }],
      allowFreeText: false,
      askedBy: form.serverName,
      chatId: context.chatId,
    }, context);
    if (outcome.status !== "answered") {
      const action = outcome.status === "cancelled" ? "cancel" : "decline";
      return finish(context, form.serverName, action, outcome.status, 0);
    }
    if (outcome.answer !== "Accept") return finish(context, form.serverName, "decline", "declined", 0);
  }

  for (const field of form.fields) {
    let accepted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = questionFor(form.message, field, attempt > 0);
      request.askedBy = form.serverName;
      request.chatId = context.chatId;
      const outcome = await askSafely(ask, request, context);
      if (outcome.status !== "answered") {
        const action = outcome.status === "cancelled" ? "cancel" : "decline";
        return finish(context, form.serverName, action, outcome.status, 0);
      }
      const parsed = parseAnswer(field, outcome.answer);
      if (!parsed.ok) continue;
      content[field.key] = parsed.value;
      accepted = true;
      break;
    }
    if (!accepted) return finish(context, form.serverName, "decline", "invalid-answer", 0);
  }

  if (!context.isCurrent() || context.signal?.aborted) return finish(context, form.serverName, "cancel", "stale", 0);
  return finish(context, form.serverName, "accept", "answered", Object.keys(content).length, content);
}
