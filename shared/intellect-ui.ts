/** A platform-neutral, data-only UI contract. Model output never becomes executable code. */
export const INTELLECT_UI_FENCE = 'agentlas-ui';

export const INTELLECT_UI_LIMITS = Object.freeze({
  sourceChars: 65_536,
  nodes: 128,
  depth: 8,
  textChars: 4_000,
  labelChars: 160,
  inputChars: 240,
  tableColumns: 12,
  tableRows: 100,
  chartPoints: 100,
  chartSeries: 6,
  diagramNodes: 32,
  diagramEdges: 64,
  selectOptions: 32,
  expressionNodes: 64,
  expressionDepth: 12,
  totalExpressionNodes: 512,
  magnitude: 1e12,
  errors: 16,
  fences: 16,
});

export type IntellectUiScalar = string | number | boolean | null;
export type IntellectUiValues = Record<string, string | number>;
export type IntellectUiExpression = number | { input: string } | {
  op: 'add' | 'sub' | 'mul' | 'div' | 'pow' | 'min' | 'max' | 'abs' | 'round';
  args: IntellectUiExpression[];
};
export interface IntellectUiFollowupAction {
  type: 'followup';
  prompt: string;
  includeInputs?: string[];
}
interface IntellectUiBase { id?: string }
export type IntellectUiNode =
  | (IntellectUiBase & { type: 'container' | 'card'; title?: string; layout?: 'vertical' | 'horizontal' | 'grid'; children: IntellectUiNode[] })
  | (IntellectUiBase & { type: 'text'; text: string; tone?: 'default' | 'muted' | 'success' | 'warning' })
  | (IntellectUiBase & { type: 'metric'; label: string; value?: string | number; expression?: IntellectUiExpression; unit?: string; description?: string })
  | (IntellectUiBase & { type: 'calculator'; label: string; expression: IntellectUiExpression; precision?: number; unit?: string })
  | (IntellectUiBase & { type: 'table'; title?: string; columns: string[]; rows: IntellectUiScalar[][] })
  | (IntellectUiBase & { type: 'chart'; title?: string; chartType: 'bar' | 'line'; labels: string[]; series: { name: string; values: number[] }[]; yLabel?: string })
  | (IntellectUiBase & { type: 'diagram'; title?: string; nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string; bidirectional?: boolean }[]; layout?: 'horizontal' | 'vertical' })
  | { type: 'input'; id: string; label: string; inputType?: 'number' | 'text'; value?: string | number; min?: number; max?: number; step?: number }
  | { type: 'select'; id: string; label: string; options: { label: string; value: string }[]; value?: string }
  | { type: 'slider'; id: string; label: string; min: number; max: number; step?: number; value?: number }
  | (IntellectUiBase & { type: 'button'; label: string; action: IntellectUiFollowupAction });

export interface IntellectUiDocument { version: 1; id?: string; title?: string; children: IntellectUiNode[] }
export interface IntellectUiError { code: string; path: string; message: string }
export interface IntellectUiValidation { document: IntellectUiDocument | null; errors: IntellectUiError[] }
export interface IntellectUiFenceResult extends IntellectUiValidation { complete: boolean; pending: boolean }
export type IntellectUiMarkdownSegment = { kind: 'markdown'; text: string } | ({ kind: 'ui' } & IntellectUiFenceResult);
export interface IntellectUiMarkdownResult { segments: IntellectUiMarkdownSegment[]; hasUi: boolean }

const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const OPERATORS = new Set(['add', 'sub', 'mul', 'div', 'pow', 'min', 'max', 'abs', 'round']);
type JsonObject = Record<string, unknown>;
interface ValidationContext {
  nodes: number;
  expressionNodes: number;
  ids: Set<string>;
  inputs: Set<string>;
  references: { id: string; path: string }[];
}
class UiValidationFailure extends Error {
  constructor(public readonly issue: IntellectUiError) { super(issue.message); }
}
function fail(code: string, path: string, message: string): never { throw new UiValidationFailure({ code, path, message }); }
function context(): ValidationContext { return { nodes: 0, expressionNodes: 0, ids: new Set(), inputs: new Set(), references: [] }; }
function issue(error: unknown): IntellectUiError {
  return error instanceof UiValidationFailure ? error.issue : { code: 'invalid_document', path: '$', message: 'Invalid UI document.' };
}
function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_field', path, 'Expected an object.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_field', path, 'Expected a plain object.');
  return value as JsonObject;
}
function keys(value: JsonObject, allowed: string[], path: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) if (!allow.has(key)) fail('unknown_property', `${path}.${key}`, 'Unsupported UI property.');
}
function string(value: unknown, path: string, limit: number = INTELLECT_UI_LIMITS.labelChars): string {
  if (typeof value !== 'string' || value.length > limit) fail('invalid_field', path, `Expected text of at most ${limit} characters.`);
  return value;
}
function nonempty(value: unknown, path: string, limit: number = INTELLECT_UI_LIMITS.labelChars): string {
  const result = string(value, path, limit);
  if (!result.trim()) fail('invalid_field', path, 'Expected nonempty text.');
  return result;
}
function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > INTELLECT_UI_LIMITS.magnitude) fail('invalid_field', path, 'Expected a finite number within the supported range.');
  return value;
}
function id(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!ID_PATTERN.test(result) || RESERVED_IDS.has(result)) fail('invalid_field', path, 'Expected a safe component ID.');
  return result;
}
function optionalString(value: unknown, path: string, limit: number = INTELLECT_UI_LIMITS.labelChars): string | undefined { return value === undefined ? undefined : string(value, path, limit); }
function optionalNumber(value: unknown, path: string): number | undefined { return value === undefined ? undefined : number(value, path); }
function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail('invalid_field', path, 'Unsupported field value.');
  return value as T;
}
function array(value: unknown, path: string, limit: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length > limit || value.length < minimum) fail('resource_limit', path, `Expected ${minimum} to ${limit} items.`);
  return value;
}
function componentId(value: unknown, path: string, ctx: ValidationContext, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  const result = id(value, path);
  if (ctx.ids.has(result)) fail('duplicate_id', path, 'Component IDs must be unique within a UI document.');
  ctx.ids.add(result);
  return result;
}
function expression(value: unknown, path: string, ctx: ValidationContext, depth = 0, budget = { nodes: 0 }): IntellectUiExpression {
  if (++budget.nodes > INTELLECT_UI_LIMITS.expressionNodes || ++ctx.expressionNodes > INTELLECT_UI_LIMITS.totalExpressionNodes || depth > INTELLECT_UI_LIMITS.expressionDepth) fail('resource_limit', path, 'Expression complexity limit exceeded.');
  if (typeof value === 'number') return number(value, path);
  const raw = object(value, path);
  if (raw.input !== undefined) {
    keys(raw, ['input'], path);
    const input = id(raw.input, `${path}.input`);
    ctx.references.push({ id: input, path });
    return { input };
  }
  keys(raw, ['op', 'args'], path);
  if (typeof raw.op !== 'string' || !OPERATORS.has(raw.op)) fail('invalid_expression', `${path}.op`, 'Unsupported arithmetic operation.');
  const unary = raw.op === 'abs' || raw.op === 'round';
  const variadic = raw.op === 'min' || raw.op === 'max';
  const args = array(raw.args, `${path}.args`, variadic ? 8 : unary ? 1 : 2, unary ? 1 : 2);
  return { op: raw.op as Exclude<IntellectUiExpression, number | { input: string }>['op'], args: args.map((arg, index) => expression(arg, `${path}.args[${index}]`, ctx, depth + 1, budget)) };
}
function action(value: unknown, path: string, ctx: ValidationContext): IntellectUiFollowupAction {
  const raw = object(value, path);
  keys(raw, ['type', 'prompt', 'includeInputs'], path);
  if (raw.type !== 'followup') fail('invalid_action', `${path}.type`, 'Only an explicit followup action is supported.');
  const prompt = nonempty(raw.prompt, `${path}.prompt`, INTELLECT_UI_LIMITS.textChars);
  let includeInputs: string[] | undefined;
  if (raw.includeInputs !== undefined) {
    includeInputs = array(raw.includeInputs, `${path}.includeInputs`, 32).map((value, index) => id(value, `${path}.includeInputs[${index}]`));
    if (new Set(includeInputs).size !== includeInputs.length) fail('duplicate_id', `${path}.includeInputs`, 'Input selections must be unique.');
    includeInputs.forEach(input => ctx.references.push({ id: input, path: `${path}.includeInputs` }));
  }
  return { type: 'followup', prompt, ...(includeInputs ? { includeInputs } : {}) };
}
function bounds(raw: JsonObject, path: string): { min?: number; max?: number; step?: number } {
  const min = optionalNumber(raw.min, `${path}.min`);
  const max = optionalNumber(raw.max, `${path}.max`);
  const step = optionalNumber(raw.step, `${path}.step`);
  if (min !== undefined && max !== undefined && min > max) fail('invalid_field', path, 'Minimum must not exceed maximum.');
  if (step !== undefined && step <= 0) fail('invalid_field', `${path}.step`, 'Step must be positive.');
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}) };
}
function node(value: unknown, path: string, ctx: ValidationContext, depth: number): IntellectUiNode {
  if (++ctx.nodes > INTELLECT_UI_LIMITS.nodes || depth > INTELLECT_UI_LIMITS.depth) fail('resource_limit', path, 'UI complexity limit exceeded.');
  const raw = object(value, path);
  const type = raw.type;
  if (typeof type !== 'string') fail('unknown_type', `${path}.type`, 'Expected a supported component type.');
  const input = type === 'input' || type === 'select' || type === 'slider';
  const identifier = componentId(raw.id, `${path}.id`, ctx, input);
  const base = identifier === undefined ? {} : { id: identifier };
  const title = () => optionalString(raw.title, `${path}.title`);
  const label = () => nonempty(raw.label, `${path}.label`);
  switch (type) {
    case 'container': case 'card': {
      keys(raw, ['type', 'id', 'title', 'layout', 'children'], path);
      return { type, ...base, title: title(), layout: enumeration(raw.layout, ['vertical', 'horizontal', 'grid'], `${path}.layout`), children: array(raw.children, `${path}.children`, INTELLECT_UI_LIMITS.nodes).map((child, index) => node(child, `${path}.children[${index}]`, ctx, depth + 1)) };
    }
    case 'text':
      keys(raw, ['type', 'id', 'text', 'tone'], path);
      return { type, ...base, text: string(raw.text, `${path}.text`, INTELLECT_UI_LIMITS.textChars), tone: enumeration(raw.tone, ['default', 'muted', 'success', 'warning'], `${path}.tone`) };
    case 'metric': {
      keys(raw, ['type', 'id', 'label', 'value', 'expression', 'unit', 'description'], path);
      if (raw.value === undefined && raw.expression === undefined) fail('invalid_field', path, 'A metric needs a value or an expression.');
      const value = raw.value === undefined ? undefined : typeof raw.value === 'number' ? number(raw.value, `${path}.value`) : string(raw.value, `${path}.value`, INTELLECT_UI_LIMITS.inputChars);
      return { type, ...base, label: label(), value, expression: raw.expression === undefined ? undefined : expression(raw.expression, `${path}.expression`, ctx), unit: optionalString(raw.unit, `${path}.unit`), description: optionalString(raw.description, `${path}.description`, INTELLECT_UI_LIMITS.textChars) };
    }
    case 'calculator': {
      keys(raw, ['type', 'id', 'label', 'expression', 'precision', 'unit'], path);
      const precision = optionalNumber(raw.precision, `${path}.precision`);
      if (precision !== undefined && (!Number.isInteger(precision) || precision < 0 || precision > 8)) fail('invalid_field', `${path}.precision`, 'Precision must be an integer from 0 to 8.');
      return { type, ...base, label: label(), expression: expression(raw.expression, `${path}.expression`, ctx), precision, unit: optionalString(raw.unit, `${path}.unit`) };
    }
    case 'table': {
      keys(raw, ['type', 'id', 'title', 'columns', 'rows'], path);
      const columns = array(raw.columns, `${path}.columns`, INTELLECT_UI_LIMITS.tableColumns, 1).map((value, index) => nonempty(value, `${path}.columns[${index}]`));
      const rows = array(raw.rows, `${path}.rows`, INTELLECT_UI_LIMITS.tableRows).map((value, index) => array(value, `${path}.rows[${index}]`, columns.length, columns.length).map((cell, col): IntellectUiScalar => {
        const cellPath = `${path}.rows[${index}][${col}]`;
        if (cell === null || typeof cell === 'boolean') return cell;
        return typeof cell === 'number' ? number(cell, cellPath) : string(cell, cellPath, INTELLECT_UI_LIMITS.inputChars);
      }));
      return { type, ...base, title: title(), columns, rows };
    }
    case 'chart': {
      keys(raw, ['type', 'id', 'title', 'chartType', 'labels', 'series', 'yLabel'], path);
      const chartType = enumeration(raw.chartType, ['bar', 'line'], `${path}.chartType`);
      if (!chartType) fail('invalid_field', `${path}.chartType`, 'A chart needs a chartType.');
      const labels = array(raw.labels, `${path}.labels`, INTELLECT_UI_LIMITS.chartPoints, 1).map((value, index) => string(value, `${path}.labels[${index}]`));
      const series = array(raw.series, `${path}.series`, INTELLECT_UI_LIMITS.chartSeries, 1).map((value, index) => {
        const entryPath = `${path}.series[${index}]`;
        const entry = object(value, entryPath);
        keys(entry, ['name', 'values'], entryPath);
        return { name: nonempty(entry.name, `${entryPath}.name`), values: array(entry.values, `${entryPath}.values`, labels.length, labels.length).map((value, index) => number(value, `${entryPath}.values[${index}]`)) };
      });
      return { type, ...base, title: title(), chartType, labels, series, yLabel: optionalString(raw.yLabel, `${path}.yLabel`) };
    }
    case 'diagram': {
      keys(raw, ['type', 'id', 'title', 'nodes', 'edges', 'layout'], path);
      const diagramIds = new Set<string>();
      const nodes = array(raw.nodes, `${path}.nodes`, INTELLECT_UI_LIMITS.diagramNodes, 1).map((value, index) => {
        const entryPath = `${path}.nodes[${index}]`;
        const entry = object(value, entryPath);
        keys(entry, ['id', 'label'], entryPath);
        const identifier = id(entry.id, `${entryPath}.id`);
        if (diagramIds.has(identifier)) fail('duplicate_id', `${entryPath}.id`, 'Diagram IDs must be unique.');
        diagramIds.add(identifier);
        return { id: identifier, label: nonempty(entry.label, `${entryPath}.label`) };
      });
      const edges = array(raw.edges, `${path}.edges`, INTELLECT_UI_LIMITS.diagramEdges).map((value, index) => {
        const entryPath = `${path}.edges[${index}]`;
        const entry = object(value, entryPath);
        keys(entry, ['from', 'to', 'label', 'bidirectional'], entryPath);
        const from = id(entry.from, `${entryPath}.from`);
        const to = id(entry.to, `${entryPath}.to`);
        if (!diagramIds.has(from) || !diagramIds.has(to)) fail('invalid_field', entryPath, 'Diagram edges must reference existing nodes.');
        if (entry.bidirectional !== undefined && typeof entry.bidirectional !== 'boolean') fail('invalid_field', `${entryPath}.bidirectional`, 'Expected a boolean.');
        return { from, to, label: optionalString(entry.label, `${entryPath}.label`), ...(entry.bidirectional === undefined ? {} : { bidirectional: entry.bidirectional }) };
      });
      return { type, ...base, title: title(), nodes, edges, layout: enumeration(raw.layout, ['horizontal', 'vertical'], `${path}.layout`) };
    }
    case 'input': {
      keys(raw, ['type', 'id', 'label', 'inputType', 'value', 'min', 'max', 'step'], path);
      const inputType = enumeration(raw.inputType, ['number', 'text'], `${path}.inputType`) ?? 'number';
      const range = bounds(raw, path);
      if (inputType === 'text' && (raw.min !== undefined || raw.max !== undefined || raw.step !== undefined)) fail('invalid_field', path, 'Text inputs do not have numeric bounds.');
      const value = raw.value === undefined ? undefined : inputType === 'number' ? number(raw.value, `${path}.value`) : string(raw.value, `${path}.value`, INTELLECT_UI_LIMITS.inputChars);
      if (typeof value === 'number' && ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max))) fail('invalid_field', `${path}.value`, 'Input value is outside its bounds.');
      ctx.inputs.add(identifier!);
      return { type, id: identifier!, label: label(), inputType, value, ...range };
    }
    case 'select': {
      keys(raw, ['type', 'id', 'label', 'options', 'value'], path);
      const options = array(raw.options, `${path}.options`, INTELLECT_UI_LIMITS.selectOptions, 1).map((value, index) => {
        const entryPath = `${path}.options[${index}]`;
        const entry = object(value, entryPath);
        keys(entry, ['label', 'value'], entryPath);
        return { label: nonempty(entry.label, `${entryPath}.label`), value: string(entry.value, `${entryPath}.value`, INTELLECT_UI_LIMITS.inputChars) };
      });
      if (new Set(options.map(option => option.value)).size !== options.length) fail('invalid_field', `${path}.options`, 'Select values must be unique.');
      const value = optionalString(raw.value, `${path}.value`, INTELLECT_UI_LIMITS.inputChars);
      if (value !== undefined && !options.some(option => option.value === value)) fail('invalid_field', `${path}.value`, 'Select value must match an option.');
      ctx.inputs.add(identifier!);
      return { type, id: identifier!, label: label(), options, value };
    }
    case 'slider': {
      keys(raw, ['type', 'id', 'label', 'min', 'max', 'step', 'value'], path);
      const min = number(raw.min, `${path}.min`);
      const max = number(raw.max, `${path}.max`);
      const range = bounds(raw, path);
      if (min >= max) fail('invalid_field', path, 'A slider needs a positive range.');
      const value = optionalNumber(raw.value, `${path}.value`);
      if (value !== undefined && (value < min || value > max)) fail('invalid_field', `${path}.value`, 'Slider value is outside its bounds.');
      ctx.inputs.add(identifier!);
      return { type, id: identifier!, label: label(), min, max, ...(range.step === undefined ? {} : { step: range.step }), value };
    }
    case 'button':
      keys(raw, ['type', 'id', 'label', 'action'], path);
      return { type, ...base, label: label(), action: action(raw.action, `${path}.action`, ctx) };
    default: fail('unknown_type', `${path}.type`, 'Unsupported UI component type.');
  }
}
function document(value: unknown, ctx: ValidationContext, path = '$'): IntellectUiDocument {
  const raw = object(value, path);
  if (raw.type !== undefined) return { version: 1, children: [node(raw, path, ctx, 0)] };
  keys(raw, ['version', 'id', 'title', 'children'], path);
  if (raw.version !== 1) fail('unsupported_version', `${path}.version`, 'Only UI version 1 is supported.');
  const identifier = raw.id === undefined ? undefined : id(raw.id, `${path}.id`);
  return { version: 1, ...(identifier === undefined ? {} : { id: identifier }), title: optionalString(raw.title, `${path}.title`), children: array(raw.children, `${path}.children`, INTELLECT_UI_LIMITS.nodes).map((value, index) => node(value, `${path}.children[${index}]`, ctx, 0)) };
}
function checkReferences(ctx: ValidationContext): void {
  for (const reference of ctx.references) if (!ctx.inputs.has(reference.id)) fail('unknown_input', reference.path, 'The expression or action references an unknown input.');
}

/** Returns a normalized document, or a machine-readable error; unknown properties fail closed. */
export function validateIntellectUiDocument(value: unknown): IntellectUiValidation {
  try {
    const ctx = context();
    const result = document(value, ctx);
    checkReferences(ctx);
    return { document: result, errors: [] };
  } catch (error) { return { document: null, errors: [issue(error)] }; }
}

// Bound nesting before JSON.parse; strings and escapes cannot alter the depth counter.
function readJson(source: string, path: string): unknown {
  if (source.length > INTELLECT_UI_LIMITS.sourceChars) fail('resource_limit', path, 'UI source size limit exceeded.');
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 48) fail('resource_limit', path, 'JSON nesting limit exceeded.'); }
    else if (char === '}' || char === ']') depth--;
  }
  try { return JSON.parse(source); } catch { fail('invalid_json', path, 'UI data is not valid JSON.'); }
}

/** NDJSON streams a node only after its newline. Pretty JSON is validated once the fence closes. */
export function parseIntellectUiFence(source: string, options: { streaming?: boolean } = {}): IntellectUiFenceResult {
  const complete = !options.streaming;
  if (source.length > INTELLECT_UI_LIMITS.sourceChars) return { document: null, errors: [{ code: 'resource_limit', path: '$', message: 'UI source size limit exceeded.' }], complete, pending: false };
  if (!source.trim()) return { document: null, errors: complete ? [{ code: 'invalid_json', path: '$', message: 'UI data is empty.' }] : [], complete, pending: !complete };
  if (complete) {
    try {
      const raw = readJson(source, '$');
      return { ...validateIntellectUiDocument(raw), complete, pending: false };
    } catch (error) {
      if (issue(error).code !== 'invalid_json') return { document: null, errors: [issue(error)], complete, pending: false };
    }
  }
  const ctx = context();
  const children: IntellectUiNode[] = [];
  const errors: IntellectUiError[] = [];
  let title: string | undefined;
  let identifier: string | undefined;
  let lineStart = 0;
  let lineIndex = 0;
  let parsedLines = 0;
  let pending = false;
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd).trim();
    const path = `$line[${++lineIndex}]`;
    if (newline < 0 && !complete) { pending = !!line; break; }
    if (line) {
      try {
        const fragmentCtx = context();
        const fragment = document(readJson(line, path), fragmentCtx, path);
        if (ctx.nodes + fragmentCtx.nodes > INTELLECT_UI_LIMITS.nodes || ctx.expressionNodes + fragmentCtx.expressionNodes > INTELLECT_UI_LIMITS.totalExpressionNodes) fail('resource_limit', path, 'UI complexity limit exceeded.');
        for (const identifier of fragmentCtx.ids) if (ctx.ids.has(identifier)) fail('duplicate_id', path, 'Component IDs must be unique within a UI document.');
        ctx.nodes += fragmentCtx.nodes;
        ctx.expressionNodes += fragmentCtx.expressionNodes;
        fragmentCtx.ids.forEach(identifier => ctx.ids.add(identifier));
        fragmentCtx.inputs.forEach(identifier => ctx.inputs.add(identifier));
        ctx.references.push(...fragmentCtx.references);
        children.push(...fragment.children);
        title ??= fragment.title;
        identifier ??= fragment.id;
        parsedLines++;
      } catch (error) {
        const failure = issue(error);
        // A multiline document starts with an incomplete JSON line. Keep it out of prose.
        if (!complete && !parsedLines && failure.code === 'invalid_json') { pending = true; break; }
        if (errors.length < INTELLECT_UI_LIMITS.errors) errors.push(failure);
        if (failure.code === 'resource_limit') break;
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (complete && parsedLines) {
    try { checkReferences(ctx); } catch (error) { errors.push(issue(error)); return { document: null, errors, complete, pending: false }; }
  }
  const result = parsedLines ? { version: 1 as const, ...(identifier === undefined ? {} : { id: identifier }), ...(title === undefined ? {} : { title }), children } : null;
  return { document: result, errors, complete, pending: !complete && (pending || !parsedLines) };
}

interface MarkdownFence { char: string; length: number; ui: boolean; skip?: boolean; start: number; contentStart: number }
function openingFence(line: string): { char: string; length: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0], length: match[1].length, info: match[2].trim() };
}
function closesFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.replace(/^ {0,3}/, '').trimEnd();
  if (trimmed.length < fence.length || trimmed[0] !== fence.char) return false;
  for (let index = 0; index < trimmed.length; index++) if (trimmed[index] !== fence.char) return false;
  return true;
}

/** Apply existing prose cleanup without rewriting UI data or its streaming newline. */
export function mapIntellectUiProse(source: string, project: (prose: string) => string): string {
  if (!/agentlas-ui/i.test(source)) return project(source);
  const occupied = new Set<number>();
  for (const match of source.matchAll(/INTELLECT_UI_PROTECTED_BLOCK_(\d+)_/g)) occupied.add(Number(match[1]));
  let nonce = 0;
  while (occupied.has(nonce)) nonce++;
  const tokenPrefix = `INTELLECT_UI_PROTECTED_BLOCK_${nonce}_`;
  const protectedBlocks: string[] = [];
  let masked = '';
  let copied = 0;
  let lineStart = 0;
  let fence: MarkdownFence | null = null;
  const protect = (start: number, end: number) => {
    // Whole-paragraph prose filters must not absorb an adjacent UI block.
    masked += source.slice(copied, start) + `\n\n${tokenPrefix}${protectedBlocks.length}_END\n\n`;
    protectedBlocks.push(source.slice(start, end));
    copied = end;
  };
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const nextLine = newline < 0 ? source.length : newline + 1;
    const line = source.slice(lineStart, lineEnd);
    if (fence) {
      if (closesFence(line, fence)) {
        // Keep the closing newline visible to anchored prose cleanup.
        if (fence.ui) protect(fence.start, lineEnd);
        fence = null;
      }
    } else {
      const opening = openingFence(line);
      if (opening) fence = {
        ...opening, ui: opening.info.toLowerCase() === INTELLECT_UI_FENCE,
        start: lineStart, contentStart: nextLine,
      };
    }
    if (newline < 0) break;
    lineStart = nextLine;
  }
  if (fence?.ui) protect(fence.start, source.length);
  if (!protectedBlocks.length) return project(source);
  masked += source.slice(copied);
  return project(masked).replace(new RegExp(`${tokenPrefix}(\\d+)_END`, 'g'), (_token, index: string) => protectedBlocks[Number(index)] ?? '');
}

/** Recognizes top-level UI fences while leaving examples inside ordinary code fences untouched. */
export function parseIntellectUiMarkdown(source: string, options: { streaming?: boolean } = {}): IntellectUiMarkdownResult {
  const segments: IntellectUiMarkdownSegment[] = [];
  let fence: MarkdownFence | null = null;
  let markdownStart = 0;
  let lineStart = 0;
  let uiCount = 0;
  const markdown = (end: number) => { if (end > markdownStart) segments.push({ kind: 'markdown', text: source.slice(markdownStart, end) }); };
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const nextLine = newline < 0 ? source.length : newline + 1;
    const line = source.slice(lineStart, lineEnd);
    if (fence) {
      if (closesFence(line, fence)) {
        if (fence.ui) {
          if (!fence.skip) segments.push({ kind: 'ui', ...parseIntellectUiFence(source.slice(fence.contentStart, lineStart)) });
          markdownStart = nextLine;
        }
        fence = null;
      }
    } else {
      const opening = openingFence(line);
      if (opening) {
        const info = opening.info.toLowerCase();
        const partialUi = !!options.streaming && newline < 0 && info.startsWith('agentlas') && INTELLECT_UI_FENCE.startsWith(info);
        const ui = info === INTELLECT_UI_FENCE || partialUi;
        if (ui) markdown(lineStart);
        fence = { char: opening.char, length: opening.length, ui, start: lineStart, contentStart: nextLine };
        if (ui && ++uiCount > INTELLECT_UI_LIMITS.fences) {
          if (uiCount === INTELLECT_UI_LIMITS.fences + 1) segments.push({ kind: 'ui', document: null, errors: [{ code: 'resource_limit', path: '$', message: 'Too many UI blocks.' }], complete: false, pending: false });
          // Continue scanning to preserve prose, without compiling additional blocks.
          fence.skip = true;
        }
      } else if (options.streaming && newline < 0 && /^ {0,3}(`{3,}|~{3,})\s*(agentlas(?:-u?i?)?)?$/i.test(line)) {
        markdown(lineStart);
        segments.push({ kind: 'ui', document: null, errors: [], complete: false, pending: true });
        markdownStart = source.length;
      }
    }
    if (newline < 0) break;
    lineStart = nextLine;
  }
  if (fence?.ui) {
    if (!fence.skip) {
      const result = parseIntellectUiFence(source.slice(fence.contentStart), { streaming: true });
      if (!options.streaming) result.errors.push({ code: 'incomplete_payload', path: '$', message: 'The UI block has no closing fence.' });
      segments.push({ kind: 'ui', ...result });
    }
    markdownStart = source.length;
  }
  markdown(source.length);
  return { segments, hasUi: segments.some(segment => segment.kind === 'ui') };
}

function numericInput(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= INTELLECT_UI_LIMITS.magnitude ? value : null;
  if (typeof value !== 'string' || value.length > INTELLECT_UI_LIMITS.inputChars || !DECIMAL_PATTERN.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= INTELLECT_UI_LIMITS.magnitude ? parsed : null;
}

/** Deliberately has no eval, Function, property traversal, calls, or access to host capabilities. */
export function evaluateIntellectUiExpression(expression: IntellectUiExpression, values: IntellectUiValues): number | null {
  let visited = 0;
  const walk = (value: IntellectUiExpression, depth: number): number | null => {
    if (++visited > INTELLECT_UI_LIMITS.expressionNodes || depth > INTELLECT_UI_LIMITS.expressionDepth) return null;
    if (typeof value === 'number') return numericInput(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if ('input' in value) {
      if (typeof value.input !== 'string' || !ID_PATTERN.test(value.input) || RESERVED_IDS.has(value.input) || !Object.prototype.hasOwnProperty.call(values, value.input)) return null;
      return numericInput(values[value.input]);
    }
    if (!OPERATORS.has(value.op) || !Array.isArray(value.args)) return null;
    const unary = value.op === 'abs' || value.op === 'round';
    const variadic = value.op === 'min' || value.op === 'max';
    if (unary ? value.args.length !== 1 : variadic ? value.args.length < 2 || value.args.length > 8 : value.args.length !== 2) return null;
    const args: number[] = [];
    for (const arg of value.args) { const result = walk(arg, depth + 1); if (result === null) return null; args.push(result); }
    let result: number;
    switch (value.op) {
      case 'add': result = args[0] + args[1]; break;
      case 'sub': result = args[0] - args[1]; break;
      case 'mul': result = args[0] * args[1]; break;
      case 'div': if (args[1] === 0) return null; result = args[0] / args[1]; break;
      case 'pow': result = Math.pow(args[0], args[1]); break;
      case 'min': result = Math.min(...args); break;
      case 'max': result = Math.max(...args); break;
      case 'abs': result = Math.abs(args[0]); break;
      case 'round': result = Math.round(args[0]); break;
      default: return null;
    }
    return numericInput(result);
  };
  return walk(expression, 0);
}

export function getIntellectUiInitialValues(document: IntellectUiDocument): IntellectUiValues {
  const values: IntellectUiValues = {};
  let visited = 0;
  const visit = (nodes: IntellectUiNode[], depth: number) => {
    if (depth > INTELLECT_UI_LIMITS.depth) return;
    for (const node of nodes) {
      if (++visited > INTELLECT_UI_LIMITS.nodes) return;
      if (node.type === 'container' || node.type === 'card') visit(node.children, depth + 1);
      else if (node.type === 'input') values[node.id] = node.value ?? (node.inputType === 'text' ? '' : Math.max(node.min ?? -INTELLECT_UI_LIMITS.magnitude, Math.min(node.max ?? INTELLECT_UI_LIMITS.magnitude, 0)));
      else if (node.type === 'slider') values[node.id] = node.value ?? node.min;
      else if (node.type === 'select') values[node.id] = node.value ?? node.options[0]?.value ?? '';
    }
  };
  visit(document.children, 0);
  return values;
}

/** The caller uses this only after an explicit click to prepare a draft in its normal composer. */
export function buildIntellectUiFollowup(action: IntellectUiFollowupAction, values: IntellectUiValues, document?: IntellectUiDocument): string | null {
  try {
    const validated = action && typeof action === 'object' ? action : null;
    if (!validated || validated.type !== 'followup' || typeof validated.prompt !== 'string' || !validated.prompt.trim() || validated.prompt.length > INTELLECT_UI_LIMITS.textChars) return null;
    if (validated.includeInputs !== undefined && (!Array.isArray(validated.includeInputs) || validated.includeInputs.length > 32)) return null;
    const selected: IntellectUiValues = {};
    for (const key of validated.includeInputs ?? []) {
      if (typeof key !== 'string' || !ID_PATTERN.test(key) || RESERVED_IDS.has(key) || !Object.prototype.hasOwnProperty.call(values, key)) return null;
      const value = values[key];
      if (typeof value === 'string') { if (value.length > INTELLECT_UI_LIMITS.inputChars) return null; }
      else if (numericInput(value) === null) return null;
      selected[key] = value;
    }
    const prompt = validated.prompt.trim();
    const controls = new Map<string, Extract<IntellectUiNode, { type: 'input' | 'select' | 'slider' }>>();
    let visited = 0;
    const visit = (nodes: IntellectUiNode[], depth: number) => {
      if (depth > INTELLECT_UI_LIMITS.depth) return;
      for (const node of nodes) {
        if (++visited > INTELLECT_UI_LIMITS.nodes) return;
        if (node.type === 'container' || node.type === 'card') visit(node.children, depth + 1);
        else if (node.type === 'input' || node.type === 'select' || node.type === 'slider') controls.set(node.id, node);
      }
    };
    if (document) visit(document.children, 0);
    const lines = Object.entries(selected).map(([id, value]) => {
      const control = controls.get(id);
      const displayValue = control?.type === 'select'
        ? control.options.find(option => option.value === String(value))?.label ?? String(value)
        : String(value);
      return `${control?.label ?? id}: ${displayValue}`;
    });
    return lines.length ? `${prompt}\n\n${lines.join('\n')}` : prompt;
  } catch { return null; }
}
