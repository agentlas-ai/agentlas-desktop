// The memory_ticket receiver (Agentlas 2.0 K2b',; decision). PURE: no store, no Electron, no model.
//
// One ticket = one memory write made by the model that is doing the work (add / rewrite / condense / remove). This function answers each ticket ALONE from facts the host
// states (`TicketHostFacts`) and the lines the model was shown; a wrong ticket is corrected when that cannot change its meaning (an alias, a default, the five kind lines)
// and otherwise dropped alone with a counted code. Nothing asks again and nothing stops the turn. It never looks for the words of a request; the only text it reads is
// the secret shapes (shared patterns + Luhn-checked card numbers), the explicit override phrase (patterns.imperative), and the quote-in-the-owner's-text comparison.
//
// Every rule and value comes from the ruleset's `ticket` section (electron/memory/curator-ruleset.json, equal to the engine's system-agents/curator-ruleset.json, 1.14.0).
// The 206 shared vectors of the engine (contracts/test-vectors/memory-ticket-v2-vectors.json) pin the answers; scripts/test-memory-ticket-vectors.cjs runs them here.
// A host that has no `ticket` section (an older ruleset copy) answers nothing: `ticketRulesLoaded()` is false and the caller does not offer the tool.
import { loadCuratorRuleset } from "./curator-rules";

export type TicketAction = "add" | "rewrite" | "condense" | "remove";
export type TicketScope = "user_identity" | "project" | "agent_repo";
export type TicketConversation = "personal_agent" | "server_home" | "work_session" | "outside_window" | "folder_agent" | "guest";
export type TicketTurnSource = "owner" | "chain" | "session_message" | "automation" | "unknown";
export type TicketOriginClass = "user" | "observed" | "result" | "inferred";
export type TicketCertainty = "self_reported" | "run_verified" | "unverified";
export type TicketStore = "personal" | "card" | "project" | "worker" | "agent";

/** One line the model was shown (the id is the one in front of the line in its memory block). */
export interface TicketVisibleLine {
  id: string;
  scope: string;
  kind: string;
  ticket_kind?: string | null;
  text?: string;
  origin_class?: string | null;
  certainty?: string | null;
  forgotten?: boolean;
  superseded?: boolean;
}

/** What the host knows about the turn. Facts only. */
export interface TicketHostFacts {
  conversation?: string;
  turn_source?: string;
  project_bound?: boolean;
  owner_text?: string | null;
  /** Tools, files or pictures put text in the turn. Unknown (absent) is treated as true. */
  outside_text?: boolean;
  tools_ran?: boolean;
  receipt?: boolean;
  visible?: readonly TicketVisibleLine[];
}

export interface TicketLine {
  scope: TicketScope;
  kind: string;
  store_kind: string;
  text: string;
  native: string | null;
  origin_class: TicketOriginClass;
  certainty: TicketCertainty;
  replaces: string[];
  contradicts: string[];
  why: "changed" | "corrected" | null;
  marks: string[];
  context: { ticket_kind: string; boundary?: { type: "no_proactive" | "quiet_hours"; from?: string; to?: string } } | null;
  carry_evidence_from: string[];
  moved_from?: TicketScope;
}

export interface TicketItem {
  status: "ok" | "refused" | "invalid";
  result: "saved" | "merged" | "rewritten" | "condensed" | "removed" | null;
  why: string | null;
  ask_owner: "conflict" | null;
  scope: TicketScope | null;
  kind: string | null;
  store: TicketStore | null;
  line: TicketLine | null;
  targets: string[];
  merge_into: string | null;
  same_as_ticket: number | null;
  fixes: string[];
  index: number;
  /** The numbers of an `invalid` answer that is about a number (ruleset 1.14.0); the answer carries the same object. */
  limit?: Record<string, number>;
}

export interface TicketAnswer {
  status: "ok" | "refused" | "invalid";
  result?: string | null;
  why?: string | null;
  scope?: string | null;
  kind?: string | null;
  id?: string;
  ask_owner?: string;
  /** A refusal about a number carries the numbers (ruleset 1.14.0 ticket.answer.limit): text_too_long {max, chars}, text_too_short {min, chars}, targets_count {min, max, got}, over_limit {max}. */
  max?: number; min?: number; chars?: number; got?: number;
  /** The English wording was over the line limit and the person's own words were kept (set by the host layer, ticket-call.ts; the server's answer carries the same word). */
  english?: "dropped";
}

export interface TicketReceipt {
  schema: "agentlas.memory-ticket-receipt.v2";
  items: TicketItem[];
  answers: TicketAnswer[];
  counts: { received: number; ok: number; refused: number; invalid: number; fixed: number; by_code: Record<string, number> };
  unreadable: string | null;
}

interface TicketSection {
  tool: { maxTickets: number; text: string; name: string; aliases: string[] };
  actions: Record<TicketAction, { targets: [number, number] }>;
  kinds: { user_identity: { kinds: string[]; lineMaxChars: number }; agent_repo: { kinds: string[]; lineMaxChars: number }; project: { kinds: string[]; lineMaxChars: number }; textMinChars: number; nativeMaxChars: number };
  kindFix: Array<{ scope: string; from: string; to: string }>;
  fold: { map: Record<string, string> };
  owners: { conversations: string[]; turnSources: string[]; routes: Record<string, Record<string, string>> };
  refusals: { secret_like: { cardNumber: { regex: string } } };
}

interface Rules {
  tk: TicketSection;
  pattern: (name: string) => RegExp;
  card: RegExp;
}

let cachedRules: { sha: string; rules: Rules | null } | null = null;
function rules(): Rules | null {
  const loaded = loadCuratorRuleset();
  if (cachedRules && cachedRules.sha === loaded.sha) return cachedRules.rules;
  const raw = loaded.ruleset as { ticket?: TicketSection; patterns?: Record<string, { regex?: string; flags?: string }> };
  let result: Rules | null = null;
  try {
    const tk = raw.ticket, patterns = raw.patterns;
    if (tk && patterns && tk.tool && tk.actions && tk.kinds && tk.owners && tk.refusals?.secret_like?.cardNumber?.regex) {
      result = { tk, card: new RegExp(tk.refusals.secret_like.cardNumber.regex, "g"),
        pattern: (name: string) => { const spec = patterns[name]; return new RegExp(spec?.regex ?? "(?!)", spec?.flags ?? ""); } };
    }
  } catch { result = null; }
  cachedRules = { sha: loaded.sha, rules: result };
  return result;
}

/** False when the shipped ruleset copy has no ticket section (an older copy): the tool is then not offered. */
export function ticketRulesLoaded(): boolean { return rules() !== null; }

/** The exact tool text of the loaded ruleset, or null. */
export function ticketToolText(): string | null { return rules()?.tk.tool.text ?? null; }
export function ticketToolName(): string { return rules()?.tk.tool.name ?? "memory_ticket"; }
export function ticketToolAliases(): string[] { return rules()?.tk.tool.aliases ?? ["memory_note"]; }
export function ticketMaxTickets(): number { return rules()?.tk.tool.maxTickets ?? 5; }

const ACTIONS: TicketAction[] = ["add", "rewrite", "condense", "remove"];
const SCOPES: TicketScope[] = ["user_identity", "project", "agent_repo"];
const INSTR = ["preference", "boundary"];
const ACTION_WORDS: Record<TicketAction, string[]> = {
  add: ["add", "new", "create", "save", "write", "store", "insert"], rewrite: ["rewrite", "update", "replace", "edit", "change", "supersede"],
  condense: ["condense", "merge", "consolidate", "combine", "summarize"], remove: ["remove", "delete", "forget", "drop"] };
const ACTION_ALIAS: Record<string, TicketAction> = {};
for (const [action, words] of Object.entries(ACTION_WORDS)) for (const word of words) ACTION_ALIAS[word] = action as TicketAction;
const SCOPE_ALIAS: Record<string, string> = { person: "user_identity", personal: "user_identity", user: "user_identity", owner: "user_identity", agentrepo: "agent_repo", agent: "agent_repo", agents: "agent_repo",
  agent_repository: "agent_repo", craft: "agent_repo", worker: "agent_repo", projects: "project", sessions: "session" };
const KIND_ALIAS: Record<string, string> = { identities: "identity", preferences: "preference", facts: "fact", boundaries: "boundary", decisions: "decision", procedures: "procedure", risks: "risk" };
const SOURCE_WORDS: Record<string, string[]> = { said: ["user", "owner", "owner_said", "told"], seen: ["observed", "saw", "tool", "file", "image", "picture"], did: ["done", "result", "action"], inferred: ["guess", "derived", "assumed"] };
const SOURCE_ALIAS: Record<string, string> = {};
for (const [word, aliases] of Object.entries(SOURCE_WORDS)) { SOURCE_ALIAS[word] = word; for (const alias of aliases) SOURCE_ALIAS[alias] = word; }
const WHY_ALIAS: Record<string, "changed" | "corrected"> = { changed: "changed", change: "changed", update: "changed", updated: "changed", new: "changed", corrected: "corrected", correction: "corrected",
  fix: "corrected", wrong: "corrected", mistake: "corrected", error: "corrected" };
const ORIGIN_OF: Record<string, TicketOriginClass> = { said: "user", seen: "observed", did: "result", inferred: "inferred" };
const WRAPPERS = ["result", "output", "ticket", "response", "answer", "data", "arguments", "args", "input", "params"];
const TICKETS_KEYS = ["tickets", "items", "memories", "entries", "lines", "results"];
const KEYS: Record<string, string[]> = { action: ["op", "operation"], targets: ["target", "target_ids", "ids", "replaces"], why: ["reason"], scope: ["about", "store", "memory"], kind: ["category"],
  text: ["memory", "content", "note", "summary", "statement", "line"], en: ["english", "text_en", "content_en"], source: ["origin", "from"], quote: ["evidence", "owner_quote"],
  permission: ["approval", "without_asking"], boundary: [] };
const EDGE = " \t\r\n.,;:!?\"'`()[]{}*";
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const cps = (s: string): string[] => [...s];
const clen = (s: string): number => cps(s).length;
const strip = (s: string): string => { let a = 0, b = s.length; while (a < b && EDGE.includes(s[a])) a++; while (b > a && EDGE.includes(s[b - 1])) b--; return s.slice(a, b); };
const token = (v: unknown): string | null => typeof v !== "string" ? null : (strip(v).toLowerCase().replace(/[ \t\r\n\f\v-]+/g, "_") || null);
const normalize = (s: string): string => s.replace(/[ \t\r\n\f\v 　]+/g, " ").replace(/^ +| +$/g, "").toLowerCase();
const NONLATIN: Array<[number, number]> = [[0x370, 0x3ff], [0x400, 0x4ff], [0x590, 0x5ff], [0x600, 0x6ff], [0x900, 0x97f], [0xe00, 0xe7f], [0x1100, 0x11ff], [0x3040, 0x30ff], [0x3130, 0x318f],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7a3]];
function nonEnglish(t: string): boolean {
  let lat = 0, oth = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7)) lat++;
    else if (NONLATIN.some(([a, b]) => c >= a && c <= b)) oth++;
  }
  return oth + lat > 0 && oth / (oth + lat) > 0.3;
}
function luhn(d: string): boolean { let t = 0, flip = false; for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (flip) { n *= 2; if (n > 9) n -= 9; } t += n; flip = !flip; } return t % 10 === 0; }
function cardHit(r: Rules, t: string): boolean {
  r.card.lastIndex = 0;
  for (const m of t.matchAll(r.card)) { const d = m[0].replace(/[ -]/g, ""); if (d.length >= 15 && d.length <= 16 && luhn(d)) return true; }
  return false;
}
function secretLike(r: Rules, ...ts: Array<string | null>): boolean {
  return ts.some(t => t && (r.pattern("secretKeyValue").test(t) || r.pattern("secretValueShapes").test(t) || cardHit(r, t)));
}
function extract(raw: unknown): unknown {
  if (isObj(raw) || Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.replace(/^﻿/, "").trim();
  try { const v = JSON.parse(text); if (v !== null && typeof v === "object") return v; } catch { /* next shape */ }
  for (const m of text.matchAll(/```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) { try { const v = JSON.parse(m[1].trim()); if (v !== null && typeof v === "object") return v; } catch { /* next fence */ } }
  const scan = (open: string, close: string, ok: (v: unknown) => boolean): unknown => {
    for (let i = text.indexOf(open); i !== -1; i = text.indexOf(open, i + 1)) for (let j = text.length; j > i; j--) {
      if (text[j - 1] !== close) continue;
      try { const v = JSON.parse(text.slice(i, j)); if (ok(v)) return v; } catch { /* shorter span */ }
    }
    return null;
  };
  return scan("{", "}", isObj) || scan("[", "]", v => Array.isArray(v) && v.length > 0 && v.every(isObj));
}
function keysOf(o: Record<string, unknown>): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  for (const k of Object.keys(o)) { const t = token(k); if (t !== null && !(t in n)) n[t] = o[k]; }
  return n;
}
function ticketsOf(raw: unknown): [unknown[], string | null] {
  let v = extract(raw);
  if (v === null) return [[], "not_json"];
  for (let i = 0; i < 2; i++) if (isObj(v) && Object.keys(v).length === 1) {
    const k = Object.keys(v)[0];
    const inner = (v as Record<string, unknown>)[k];
    if (WRAPPERS.includes(token(k) ?? "") && inner !== null && typeof inner === "object") v = inner;
  }
  if (Array.isArray(v)) return [v, null];
  const n = keysOf(v as Record<string, unknown>);
  for (const name of TICKETS_KEYS) if (name in n) {
    const f = n[name];
    if (f === null) return [[], null];
    if (Array.isArray(f)) return [f, null];
    if (isObj(f)) return [[f], null];
    return [[], "tickets_not_list"];
  }
  if (["scope", "text", "en", "action", "kind"].some(k => k in n) || [...KEYS.text, ...KEYS.scope].some(k => k in n)) return [[v], null];
  return [[], Object.keys(v as object).length ? "unrecognized_shape" : null];
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The structure of a boundary ticket: `no_proactive`, or `quiet_hours` with `from` and `to` (HH:MM). Anything else is not a structure (null). Same shapes as the server's `parseBoundary`. */
export function boundaryOf(raw: unknown): { type: "no_proactive" | "quiet_hours"; from?: string; to?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.type === "no_proactive") return { type: "no_proactive" };
  if (b.type === "quiet_hours" && typeof b.from === "string" && typeof b.to === "string" && HHMM.test(b.from) && HHMM.test(b.to)) return { type: "quiet_hours", from: b.from, to: b.to };
  return null;
}
const field = (n: Record<string, unknown>, name: string): unknown => { if (name in n) return n[name]; for (const a of KEYS[name]) if (a in n) return n[a]; return null; };
const enumOf = (v: unknown, aliases: Record<string, string>, allowed: readonly string[]): string | null => {
  let t = token(v);
  if (t !== null) t = aliases[t] ?? t;
  return t !== null && allowed.includes(t) ? t : null;
};
const textOf = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
function idsOf(v: unknown): [string[], boolean] {
  if (v === null || v === undefined) return [[], false];
  const items = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  let changed = false;
  for (const it of items) {
    let id: string | null = null;
    if (typeof it === "boolean") id = null;
    else if (typeof it === "number" && Number.isInteger(it)) id = String(it);
    else if (typeof it === "string") { const m = it.match(/^\s*\[?\s*([^\s\]\[·|,;]+)/); id = m ? m[1] : null; }
    if (id === null || out.includes(id)) changed = true; else out.push(id);
  }
  return [out, changed];
}
const truthy = (v: unknown): boolean => typeof v === "boolean" ? v : typeof v === "number" ? v === 1 : typeof v === "string" ? ["true", "yes", "y", "1"].includes(v.trim().toLowerCase()) : false;

interface HostView { conversation: TicketConversation; turn_source: TicketTurnSource; project_bound: boolean; owner_text: string | null; outside_text: boolean; tools_ran: boolean; receipt: boolean; visible: Map<string, TicketVisibleLine> }
function hostOf(r: Rules, h: TicketHostFacts | undefined): HostView {
  const s = isObj(h) ? h : {} as TicketHostFacts;
  const visible = new Map<string, TicketVisibleLine>();
  for (const raw of Array.isArray(s.visible) ? s.visible : []) {
    if (!isObj(raw)) continue;
    const l = raw as unknown as TicketVisibleLine;
    if (typeof l.id !== "string" || l.forgotten || l.superseded) continue;
    visible.set(l.id, l);
  }
  return { conversation: (r.tk.owners.conversations.includes(s.conversation as string) ? s.conversation : "guest") as TicketConversation,
    turn_source: (r.tk.owners.turnSources.includes(s.turn_source as string) ? s.turn_source : "unknown") as TicketTurnSource, project_bound: s.project_bound === true,
    owner_text: typeof s.owner_text === "string" ? s.owner_text : null, outside_text: s.outside_text !== false, tools_ran: s.tools_ran === true, receipt: s.receipt === true, visible };
}
function route(r: Rules, h: HostView, scope: TicketScope): [TicketScope, TicketStore] | null {
  const where = r.tk.owners.routes[h.conversation][scope], owner = h.turn_source === "owner";
  if (where === "personal" || where === "card") return owner ? ["user_identity", where] : null;
  if (where === "project_if_bound") return h.project_bound ? ["project", "project"] : null;
  if (where === "project_if_bound_else_worker") return h.project_bound ? ["project", "project"] : ["agent_repo", "worker"];
  if (where === "agent") return ["agent_repo", "agent"];
  return null;
}
function origin(source: string | null, h: HostView, quote: string | null): TicketOriginClass {
  if (source === "said") {
    if (h.turn_source !== "owner") return "inferred";
    if (!h.outside_text) return "user";
    return quote && h.owner_text !== null && normalize(quote) !== "" && normalize(h.owner_text).includes(normalize(quote)) ? "user" : "observed";
  }
  if (source === "seen") return "observed";
  if (source === "did") return h.tools_ran ? "result" : "inferred";
  return "inferred";
}
const certaintyOf = (o: TicketOriginClass, h: HostView): TicketCertainty => o === "user" ? "self_reported" : (o === "result" && h.receipt ? "run_verified" : "unverified");
/** `limit`: the numbers the model needs to write the ticket again once, ruleset 1.14.0 ticket.answer.limit. */
class Stop { constructor(readonly status: "refused" | "invalid", readonly why: string, readonly limit: Record<string, number> | null = null) { } }
const effKind = (l: TicketVisibleLine): string => l.ticket_kind || l.kind;

function one(r: Rules, raw: unknown, h: HostView, batch: Map<string, number>): TicketItem {
  const fixes: string[] = [];
  if (!isObj(raw)) throw new Stop("invalid", "not_an_object");
  const n = keysOf(raw);
  let text = textOf(field(n, "text")), en = textOf(field(n, "en"));
  const quote = textOf(field(n, "quote"));
  const actionRaw = field(n, "action");
  let [ids, changedIds] = idsOf(field(n, "targets"));
  if (changedIds) fixes.push("targets_cleaned");
  let action = enumOf(actionRaw, ACTION_ALIAS, ACTIONS) as TicketAction | null;
  if (action === null) {
    if (actionRaw !== null && !(typeof actionRaw === "string" && !actionRaw.trim())) throw new Stop("invalid", "action_unknown");
    action = !ids.length ? "add" : (ids.length === 1 ? "rewrite" : "condense");
    fixes.push("action_defaulted");
  } else if (action !== actionRaw) fixes.push("action_normalized");
  if (text === null && en === null && action !== "remove") throw new Stop("invalid", "text_missing");
  if (secretLike(r, text, en, quote)) throw new Stop("refused", "secret_like");
  const scopeRaw = field(n, "scope");
  let st = token(scopeRaw);
  if (st !== null) st = SCOPE_ALIAS[st] ?? st;
  if (st === "session") throw new Stop("refused", "not_here");
  const vis = h.visible;
  if (action === "remove") {
    const known = ids.filter(i => vis.has(i)).map(i => vis.get(i)!);
    if (!SCOPES.includes(st as TicketScope) && known.length && new Set(known.map(l => l.scope)).size === 1 && SCOPES.includes(known[0].scope as TicketScope)) { st = known[0].scope; fixes.push("scope_from_target"); }
  }
  if (!SCOPES.includes(st as TicketScope)) throw new Stop("invalid", "scope_unknown");
  if (scopeRaw !== null && st !== scopeRaw) fixes.push("scope_normalized");
  const scope = st as TicketScope;
  if (truthy(field(n, "permission"))) throw new Stop("refused", "needs_approval");
  let final: TicketScope, store: TicketStore | null = null;
  if (action === "remove") { if (h.conversation === "guest") throw new Stop("refused", "not_here"); final = scope; }
  else {
    const where = route(r, h, scope);
    if (where === null) throw new Stop("refused", "not_here");
    [final, store] = where;
    if (final !== scope) fixes.push("moved");
  }
  const source = enumOf(field(n, "source"), SOURCE_ALIAS, ["said", "seen", "did", "inferred"]);
  if (source === null) fixes.push("source_defaulted");
  const org = origin(source, h, quote);
  if (source !== null && org !== ORIGIN_OF[source]) fixes.push("source_lowered");
  const cert = certaintyOf(org, h);
  let given = token(field(n, "kind"));
  if (given !== null) given = KIND_ALIAS[given] ?? given;
  const allKinds = new Set<string>([...r.tk.kinds.user_identity.kinds, ...r.tk.kinds.agent_repo.kinds, ...r.tk.kinds.project.kinds]);
  const kindsOf = (s: TicketScope): string[] => r.tk.kinds[s].kinds;
  let kind: string | null = null;
  const marks: string[] = [];
  if (action !== "remove") {
    if (given === null) { kind = "fact"; fixes.push("kind_defaulted"); }
    else if (!allKinds.has(given)) throw new Stop("invalid", "kind_unknown");
    else if (kindsOf(final).includes(given)) kind = given;
    else {
      const fix = r.tk.kindFix.find(x => x.scope === final && x.from === given);
      kind = fix ? fix.to : null;
      if (kind === null && final === "agent_repo" && h.conversation === "folder_agent" && org === "user" && INSTR.includes(given)) kind = "procedure";
      if (kind === null) throw new Stop("invalid", "kind_not_in_store");
      fixes.push("kind_remapped");
    }
    if (final === "agent_repo" && h.conversation === "folder_agent" && org === "user" && kind === "procedure") marks.push("owner_instruction");
  }
  if (action === "remove" && org !== "user") throw new Stop("refused", "not_said");
  if (action !== "remove") {
    if ((INSTR.includes(given ?? "") || INSTR.includes(kind ?? "")) && org !== "user") throw new Stop("refused", "not_said");
    if (org !== "user" && r.pattern("imperative").test(en || text || "")) throw new Stop("refused", "not_said");
    // 1.11.0: a guess about the person is never stored as a fact about them (Personal identity or fact whose origin is inferred).
    if (final === "user_identity" && org === "inferred" && (kind === "identity" || kind === "fact")) throw new Stop("refused", "not_said");
  }
  let lineText: string | null = null, native: string | null = null;
  if (action !== "remove") {
    if (en !== null && nonEnglish(en)) { fixes.push("en_not_english"); if (text === null) text = en; en = null; }
    if (en !== null && text !== null && normalize(en) === normalize(text)) { text = null; fixes.push("text_same_as_en"); }
    if (en === null) { lineText = text; native = null; } else { lineText = en; native = text; }
    if (native !== null && clen(native) > r.tk.kinds.nativeMaxChars) { native = null; fixes.push("text_dropped_too_long"); }
    if (lineText === null || clen(lineText) < r.tk.kinds.textMinChars) throw new Stop("invalid", "text_too_short", { min: r.tk.kinds.textMinChars, chars: lineText === null ? 0 : clen(lineText) });
    if (clen(lineText) > r.tk.kinds[final].lineMaxChars && en !== null && text !== null && clen(text) <= r.tk.kinds[final].lineMaxChars) {
      // 1.14.0: the English wording is optional and the person's own words are within the limit: the person's line is kept as said and the English is dropped (a Korean line of 150 characters is 230 in English).
      lineText = text; native = null; fixes.push("en_dropped_too_long");
    }
    if (clen(lineText) > r.tk.kinds[final].lineMaxChars) throw new Stop("invalid", "text_too_long", { max: r.tk.kinds[final].lineMaxChars, chars: clen(lineText) });
    if (r.pattern("hostAbsolutePath").test(lineText) || (native !== null && r.pattern("hostAbsolutePath").test(native))) throw new Stop("invalid", "host_path");
  }
  let why: "changed" | "corrected" | null = null;
  if (action === "rewrite") {
    const wr = field(n, "why");
    why = enumOf(wr, WHY_ALIAS, ["changed", "corrected"]) as "changed" | "corrected" | null;
    if (why === null) { why = "changed"; if (wr !== null) fixes.push("why_defaulted"); } else if (why !== wr) fixes.push("why_normalized");
  } else if (field(n, "why") !== null) fixes.push("why_ignored");
  if (action === "add" && ids.length) { ids = []; fixes.push("targets_ignored"); }
  if (action === "condense" && ids.length === 1) { action = "rewrite"; why = "changed"; fixes.push("condense_one_to_rewrite"); }
  const [lo, hi] = r.tk.actions[action].targets;
  if (ids.length < lo || ids.length > hi) throw new Stop("invalid", "targets_count", { min: lo, max: hi, got: ids.length });
  const lines: TicketVisibleLine[] = [];
  for (const id of ids) {
    const l = vis.get(id);
    if (!l) throw new Stop("invalid", "target_unknown");
    if (l.scope !== final) throw new Stop("invalid", "target_scope");
    lines.push(l);
  }
  if (action === "condense" && final === "user_identity" && new Set(lines.map(effKind)).size !== 1) throw new Stop("invalid", "targets_mixed_kind");
  if (action === "condense" && final === "user_identity" && kind !== effKind(lines[0])) { kind = effKind(lines[0]); fixes.push("kind_from_targets"); }
  let storeKind = kind, context: TicketLine["context"] = null;
  if (kind !== null && store === "personal" && kind in r.tk.fold.map) {
    storeKind = r.tk.fold.map[kind]; context = { ticket_kind: kind }; fixes.push("folded");
    // a boundary comes with its structure (the ticket tool's `boundary`); without a readable one it stays a boundary by its kind, as before, and no first-word gate reads it.
    if (kind === "boundary") { const structure = boundaryOf(field(n, "boundary")); if (structure) context = { ticket_kind: kind, boundary: structure }; }
  }
  const res: TicketItem = { status: "ok", result: null, why: null, ask_owner: null, scope: final, kind, store, line: null, targets: ids, merge_into: null, same_as_ticket: null, fixes, index: 0 };
  if (action === "remove") { res.result = "removed"; res.kind = null; return res; }
  const line: TicketLine = { scope: final, kind: kind!, store_kind: storeKind!, text: lineText!, native, origin_class: org, certainty: cert, replaces: [], contradicts: [], why: null, marks, context, carry_evidence_from: [] };
  if (final !== scope) line.moved_from = scope;
  const key = [final, storeKind, normalize(lineText!)].join("\u0000");
  const userTargets = lines.filter(l => l.origin_class === "user").map(l => l.id);
  if ((action === "rewrite" || action === "condense") && org !== "user" && userTargets.length) {
    line.contradicts = userTargets;
    Object.assign(res, { result: "saved", ask_owner: "conflict", targets: [], line });
    fixes.push("replace_refused_owner_line");
    return res;
  }
  if (action === "add") {
    for (const l of vis.values()) if (l.scope === final && l.kind === storeKind && normalize(String(l.text ?? "")) === normalize(lineText!)) { Object.assign(res, { result: "merged", merge_into: l.id, targets: [] }); return res; }
    if (batch.has(key)) { Object.assign(res, { result: "merged", same_as_ticket: batch.get(key), targets: [] }); return res; }
    Object.assign(res, { result: "saved", line });
    return res;
  }
  if (action === "rewrite") {
    const t = lines[0];
    if (t.kind === storeKind && normalize(String(t.text ?? "")) === normalize(lineText!) && effKind(t) === kind) { Object.assign(res, { result: "merged", merge_into: t.id, targets: [] }); return res; }
    line.replaces = ids; line.why = why;
    Object.assign(res, { result: "rewritten", line });
    return res;
  }
  line.replaces = ids;
  if (final === "user_identity") line.carry_evidence_from = ids;
  Object.assign(res, { result: "condensed", line });
  return res;
}

function answerOf(i: TicketItem): TicketAnswer {
  if (i.status !== "ok") return { status: i.status, why: i.why, ...(i.limit ?? {}) };
  const a: TicketAnswer = { status: "ok", result: i.result, scope: i.scope, kind: i.kind };
  if (i.merge_into !== null) a.id = i.merge_into;
  else if (i.result === "removed" && i.targets.length) a.id = i.targets[0];
  if (i.ask_owner) a.ask_owner = i.ask_owner;
  return a;
}

/** Receives one memory_ticket call: raw tool arguments (or any text that holds them) + the host's facts. Never throws; a host with no ticket rules answers `null`. */
export function receiveTickets(raw: unknown, host: TicketHostFacts | undefined): TicketReceipt | null {
  const r = rules();
  if (!r) return null;
  const h = hostOf(r, host);
  const [tickets, unreadable] = ticketsOf(raw);
  const items: TicketItem[] = [];
  const batch = new Map<string, number>();
  tickets.forEach((t, index) => {
    const base: TicketItem = { status: "invalid", result: null, why: null, ask_owner: null, scope: null, kind: null, store: null, line: null, targets: [], merge_into: null, same_as_ticket: null, fixes: [], index };
    let item: TicketItem;
    try {
      if (index >= r.tk.tool.maxTickets) throw new Stop("invalid", "over_limit", { max: r.tk.tool.maxTickets });
      item = one(r, t, h, batch);
      if (item.line !== null) batch.set([item.line.scope, item.line.store_kind, normalize(item.line.text)].join("\u0000"), index);
    } catch (e) {
      item = e instanceof Stop ? Object.assign(base, { status: e.status, why: e.why, ...(e.limit ? { limit: { ...e.limit } } : {}) }) : Object.assign(base, { status: "invalid" as const, why: "not_an_object" });
    }
    item.index = index;
    items.push(item);
  });
  const byCode: Record<string, number> = {};
  for (const i of items) if (i.status !== "ok" && i.why) byCode[i.why] = (byCode[i.why] || 0) + 1;
  const count = (s: string): number => items.filter(i => i.status === s).length;
  return { schema: "agentlas.memory-ticket-receipt.v2", items, answers: items.map(answerOf),
    counts: { received: items.length, ok: count("ok"), refused: count("refused"), invalid: count("invalid"), fixed: items.filter(i => i.status === "ok" && i.fixes.length).length, by_code: byCode }, unreadable };
}
