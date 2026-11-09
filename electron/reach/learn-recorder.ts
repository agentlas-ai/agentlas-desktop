import { describeElement, norm, type LearnElement, type OutcomeCheck, type TraceStep } from "./learn";

// The automatic half of "it learns while the agent works". The computer-use control server (electron/computer-use/control-server.ts) calls three taps for every
// observation and action an agent makes; this turns what passes through into a LearnTrace and hands it to a sink (Reach's learnFromTrace). Nothing here
// touches the screen. No Electron import.
//
// What is kept: roles, captions, neighbours, which text slots. What is thrown away on the spot: typed text, key text, values (a value is only used to
// notice that something changed, and is not stored), pixel positions.
//
// A session is the work on ONE app between two quiet moments (default 25 s without a tap) or until another app is touched. It is learnable only if
//   - every step the agent took was on a control the observation named (a click on a pixel cannot be told apart from a different click later: such a session is dropped),
//   - every step succeeded,
//   - the last observation shows something the first did not: a control whose value changed, or a captioned control that was not there (the outcome check),
//   - the app is not one Reach never learns on (the sink's refusal covers that; this module also drops sessions it cannot name).
// Whether the work is worth keeping is not decided here: learnFromTrace keeps it as a candidate and a second matching success makes it a port.

export interface TapElement { index: number; role?: string; label?: string; value?: string; parent?: number }
export interface TapObservation { app: string; bundleId?: string; observationId: string; elements: TapElement[]; at: number }
export interface TapAction { app: string | null; action: string; observationId?: string; elementIndex?: number; operation?: string; key?: string; modifiers?: readonly string[]; ok: boolean; at: number }

export type RecorderDrop = "pixel_step" | "failed_step" | "no_observation" | "no_change" | "too_short" | "unnameable" | "secret" | "unreplayable_key" | "sink_off";

export interface RecordedSession {
  app: string;
  // The bundle id the native helper reported for the observed app: the app's name is localized ("계산기"), Reach's map is keyed by the bundle id.
  bundleId?: string;
  steps: TraceStep[];
  check: OutcomeCheck;
  checkHeldBefore: boolean;
  name: string;
}

export interface LearnSink {
  // true while the owner allows Reach to learn (the Settings switch); false: nothing is kept, nothing is read
  enabled(): boolean;
  submit(session: RecordedSession): Promise<void>;
  log?(line: string): void;
}

const SECRET_LABEL = /pass(word|code|phrase)|secret|cvv|cvc|security code|card number|ssn|social security|비밀번호|암호|카드 ?번호|인증번호|보안 ?코드|パスワード|密码/i;
const SECRET_ROLE = /secure|password/i;
// Editable value controls only. The check is read again by a replay on the Reach driver's own view of the app, and that view lists fields, text areas and
// combo boxes with their values but not a display label (measured on the real Calculator: its result display is a static text the driver tree does not list).
// A changed static text still shows up through the element-present fallback below when a control appears with it.
const VALUE_BEARING_ROLE = /textfield|textarea|searchfield|combobox|slider|stepper|incrementor/i;
const MENU_FRAME_ROLE = /^(AX)?(Menu|MenuBar|MenuBarItem|MenuItem)$/i;

interface Session {
  app: string;
  bundleId?: string;
  firstObservation: TapObservation | null;
  lastObservation: TapObservation | null;
  steps: TraceStep[];
  droppedFor: RecorderDrop | null;
  lastTapAt: number;
}

const toLearn = (elements: readonly TapElement[]): LearnElement[] => elements.map((element) => ({
  index: element.index, role: element.role ?? "", ...(element.label ? { label: element.label.slice(0, 60) } : {}),
  ...(element.value !== undefined ? { value: element.value.slice(0, 120) } : {}), ...(element.parent !== undefined ? { parent: element.parent } : {}),
}));

export class LearnRecorder {
  private session: Session | null = null;
  private readonly seen = new Map<string, TapObservation>();
  private timer: unknown = null;

  constructor(private readonly sink: LearnSink, private readonly options: { quietMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void; maxObservations?: number } = {}) {}

  private get quietMs(): number { return this.options.quietMs ?? 25_000; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  private rearm(): void {
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    if (this.timer !== null) clear(this.timer);
    const set = this.options.setTimer ?? ((fn: () => void, ms: number) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; });
    this.timer = set(() => { this.timer = null; void this.flush(); }, this.quietMs);
  }

  observed(observation: TapObservation): void {
    if (!this.sink.enabled()) return;
    this.seen.set(observation.observationId, observation);
    const max = this.options.maxObservations ?? 8;
    while (this.seen.size > max) { const oldest = this.seen.keys().next().value as string | undefined; if (oldest === undefined) break; this.seen.delete(oldest); }
    if (this.session && this.session.app !== observation.app) void this.flush();
    this.session ??= { app: observation.app, ...(observation.bundleId ? { bundleId: observation.bundleId } : {}), firstObservation: null, lastObservation: null, steps: [], droppedFor: null, lastTapAt: observation.at };
    this.session.firstObservation ??= observation;
    this.session.lastObservation = observation;
    this.session.lastTapAt = observation.at;
    this.rearm();
  }

  acted(action: TapAction): void {
    if (!this.sink.enabled()) return;
    // looking around and focusing change nothing worth learning
    if (action.action === "status" || action.action === "listApps" || action.action === "move" || action.action === "focusApp") return;
    const app = action.app;
    if (this.session && app && this.session.app !== app) void this.flush();
    if (!this.session) { if (!app) return; this.session = { app, firstObservation: null, lastObservation: null, steps: [], droppedFor: null, lastTapAt: action.at }; }
    const session = this.session;
    session.lastTapAt = action.at;
    this.rearm();
    if (session.droppedFor) return;
    if (!action.ok) { session.droppedFor = "failed_step"; return; }
    if (action.action === "elementAction") {
      const observation = action.observationId ? this.seen.get(action.observationId) : undefined;
      const element = observation && action.elementIndex !== undefined ? observation.elements.find((item) => item.index === action.elementIndex) : undefined;
      if (!observation || !element || !element.role) { session.droppedFor = "no_observation"; return; }
      const learn = toLearn(observation.elements);
      const target = describeElement(learn, element.index);
      if (!target) { session.droppedFor = "no_observation"; return; }
      if (SECRET_ROLE.test(target.role) || SECRET_LABEL.test(target.label ?? "")) { session.droppedFor = "secret"; return; }
      const op = action.operation === "setValue" ? "set_value" : action.operation === "click" || action.operation === undefined ? "click" : null;
      if (!op) { session.droppedFor = "pixel_step"; return; }
      session.steps.push({ op, ok: true, target, ...(op === "set_value" ? { text: "" } : {}) });
      return;
    }
    if (action.action === "typeText") {
      // typing goes into the control the agent last clicked; with none, the work cannot be replayed (a replay has to find the field)
      const field = this.lastFocused(session);
      if (!field) { session.droppedFor = "no_observation"; return; }
      session.steps.push({ op: "type", ok: true, target: field, text: "" });
      return;
    }
    if (action.action === "key") {
      const key = (action.key ?? "").slice(0, 20);
      const modifiers = (action.modifiers ?? []).map((value) => value.toLowerCase());
      // Quitting or closing the app ends the work; it is not part of it (a replay that quit the app would also lose the screen the outcome is read from).
      if (modifiers.some((value) => /^(cmd|command|meta|super)$/.test(value)) && /^[qw]$/i.test(key)) return;
      // A replayed key step carries the key name only. A named key (return, tab, escape) replays as seen; a printable key may be typed text (it must not be kept)
      // and a key with a modifier would replay without it, so the work cannot be replayed faithfully.
      if (modifiers.length > 0 || key.length < 2) { session.droppedFor = "unreplayable_key"; return; }
      session.steps.push({ op: "key", ok: true, key });
      return;
    }
    // a click, drag or scroll on a pixel: the work cannot be told apart from different work on the same pixels
    session.droppedFor = "pixel_step";
  }

  // The control that most recently took a click (a text field the agent then typed into). Typing without one is kept as a bare type step on the focused control.
  private lastFocused(session: Session): TraceStep["target"] | undefined {
    for (let i = session.steps.length - 1; i >= 0; i -= 1) { const step = session.steps[i]; if (step.target && (step.op === "click" || step.op === "set_value")) return step.target; }
    return undefined;
  }

  // Ends the session now (another app was touched, the agent went quiet, or the host is closing).
  async flush(): Promise<RecorderDrop | "submitted"> {
    const session = this.session; this.session = null;
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    if (this.timer !== null) { clear(this.timer); this.timer = null; }
    if (!session) return "too_short";
    const finish = (reason: RecorderDrop): RecorderDrop => { this.sink.log?.(`[reach-learn] dropped a session on ${session.app}: ${reason}`); return reason; };
    if (!this.sink.enabled()) return finish("sink_off");
    if (session.droppedFor) return finish(session.droppedFor);
    if (session.steps.length < 1) return finish("too_short");
    if (!session.firstObservation || !session.lastObservation || session.firstObservation.observationId === session.lastObservation.observationId) return finish("no_observation");
    const check = deriveCheck(session.firstObservation.elements, session.lastObservation.elements);
    if (!check) return finish("no_change");
    const name = nameOf(session);
    if (!name) return finish("unnameable");
    await this.sink.submit({ app: session.app, ...(session.bundleId ? { bundleId: session.bundleId } : {}), steps: session.steps, check: check.check, checkHeldBefore: check.heldBefore, name });
    return "submitted";
  }
}

// What the work changed that a later run can look for. A value that changed on a value-bearing control is the strongest signal; failing that, a captioned
// control that is in the last screen and was not in the first (its caption must be there before and after for a later run to name it). The check is judged on the
// FIRST screen: held-before is true when something with that role and caption was already there.
export function deriveCheck(first: readonly TapElement[], last: readonly TapElement[]): { check: OutcomeCheck; heldBefore: boolean } | null {
  const key = (element: TapElement): string => `${element.role ?? ""}\u0000${norm(element.label)}`;
  const firstByKey = new Map<string, TapElement>();
  for (const element of first) if (!firstByKey.has(key(element))) firstByKey.set(key(element), element);
  for (const element of last) {
    const before = firstByKey.get(key(element));
    if (before && before.value !== undefined && element.value !== undefined && before.value !== element.value && VALUE_BEARING_ROLE.test(element.role ?? "") && !SECRET_ROLE.test(element.role ?? "") && !SECRET_LABEL.test(element.label ?? "")) {
      return { check: { kind: "element-value-changed", role: element.role ?? "", label: element.label ?? "" }, heldBefore: false };
    }
  }
  for (const element of last) {
    // the check is only ever LOOKED AT, never pressed, so a caption like "Clear" or "Delete" is fine here; a secret caption is not
    if (!element.role || !element.label || SECRET_LABEL.test(element.label)) continue;
    if (!/button|checkbox|radio|tab|link|text/i.test(element.role)) continue;
    // The menu bar and its items are the app's own frame, not an effect of pressing a window control. An agent reads the app twice at different depths
    // (dev-app run depth 9 / 160 nodes, then depth 12 / 500), so a menu item only the deeper read reaches looked "new" and became the check
    // ("신용카드…"); no replay can ever see it again and every replay answered outcome_unsatisfied.
    if (MENU_FRAME_ROLE.test(element.role)) continue;
    if (!firstByKey.has(key(element))) return { check: { kind: "element-present", role: element.role, label: element.label }, heldBefore: false };
  }
  return null;
}

// The capability's identity: the app and the captions of the controls pressed, in order. No typed text ever reaches a name.
export function nameOf(session: Pick<Session, "app" | "steps">): string | null {
  const parts: string[] = [];
  for (const step of session.steps) {
    if (step.op === "click" || step.op === "set_value") { if (step.target?.label) parts.push(step.target.label); else parts.push(step.target?.role.replace(/^AX/, "").toLowerCase() ?? "control"); }
    else if (step.op === "type") parts.push("type text");
    else if (step.op === "key") parts.push(`key ${step.key ?? ""}`.trim());
  }
  if (parts.length === 0) return null;
  const head = parts.slice(0, 4).join(" > ") + (parts.length > 4 ? ` +${parts.length - 4}` : "");
  const name = `${session.app}: ${head}`.slice(0, 60);
  return norm(name).length >= 3 ? name : null;
}
