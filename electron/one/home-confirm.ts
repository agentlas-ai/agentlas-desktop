/*
 * The gate for approvals that pass power (Agentlas 2.0 O-M3a follow-up F1; O-M3b's [move here] and claim approval use it too).
 *
 * The owner's window cannot be the last "yes": code that runs in a renderer would count as the owner's press. The renderer can only REQUEST.
 * The request is kept in memory (one at a time, two minutes) and a Main-owned confirmation window is asked to show it. The action runs only
 * from an IPC sent by THAT window's own webContents (isConfirmSender), on channels registered for it. The confirmation number and anything else the
 * owner must compare is given to that window only (`view`), never to the owner window.
 *
 * The window is built by home-confirm-window.ts (like the vault's one-vault-window.ts: Main creates it, own session, no navigation, no popups, its own preload).
 * A build or a process that cannot open one (the background service, no display) keeps the old answer: `openWindow` is false, every request ends
 * `confirm_window_unavailable` and nothing runs by any route.
 */
import { randomBytes } from "node:crypto";

export interface ConfirmHost {
  /** Show the Main-owned confirmation window for this request. False = there is none (this build, or this process cannot open one). */
  openWindow(info: { id: string; kind: string }): boolean;
  /** The request is over. `outcome` is what the yes ran as; the window may stay open to show a refusal (a window with no outcome is closed). */
  closeWindow?(id: string, outcome?: ConfirmOutcome): void;
  /** True only for an IPC event sent by the confirmation window's own webContents, from its main frame. */
  isConfirmSender(event: unknown): boolean;
  /** False while the window is too new to take a yes (contracts/one-home-move.md §7.1). Absent = no wait. A refused press keeps the request. */
  pressReady?(event: unknown): boolean;
}
export const NO_CONFIRM_HOST: ConfirmHost = { openWindow: () => false, isConfirmSender: () => false };

/**
 * Security review N1: the screen-control check lives IN the gate, at the request AND at the yes, for every kind. A kind is checked unless it is named here.
 * These kinds hand no power over: a refusal or a cancel can be done while something operates the screen. A new kind added to the gate is checked by default.
 */
export const SCREEN_CHECK_SKIPPED_KINDS: ReadonlySet<string> = new Set(["rejectClaim", "declineMove", "cancelMove"]);
/** Security review N4 (Q-a): a window that only SHOWS the owner's comparison number (the requesting computer). It has no yes; the owner window never gets the number. */
export const VIEW_ONLY_KINDS: ReadonlySet<string> = new Set(["showCode"]);
/**
 * A kind whose window is a SESSION: the owner answers several times in one window (the list of what waits: [Decline] / [Accept N] over a selection, then the rest of the list). The plain "yes" (`approve`)
 * never runs one (`session_kind`); each answer goes through `session()`, which holds every rule of a yes: the window's own webContents, the live request, the first second, the screen-control check.
 */
export const SESSION_KINDS: ReadonlySet<string> = new Set(["reviewWaiting"]);

export type ConfirmOutcome = { ok: boolean; code?: string; [key: string]: unknown };
type Run = () => Promise<ConfirmOutcome> | ConfirmOutcome;
interface Pending { id: string; kind: string; createdAt: number; view: Record<string, unknown>; run: Run; alt?: Run }
/** How long one request lives; the window host uses the same value for its own close. */
export const CONFIRM_TTL_MS = 2 * 60_000;
const TTL_MS = CONFIRM_TTL_MS;

type ScreenControl = (now: number) => { active: boolean };
/** The product's gate: the screen-control check is REQUIRED (security follow-up: an absent check used to switch it off silently). A missing function throws when the gate is made. */
export function createConfirmGate(deps: { now(): number; host: () => ConfirmHost; screenControl: ScreenControl }) {
  if (typeof deps.screenControl !== "function") throw new Error("confirm_gate_needs_screen_control");
  return buildConfirmGate(deps, deps.screenControl);
}
/** A gate with NO screen-control check. Only a test of the gate's own other rules uses it; the name says what it is. Product code never calls it. */
export function createConfirmGateWithoutScreenCheckForTest(deps: { now(): number; host: () => ConfirmHost }) {
  return buildConfirmGate(deps, null);
}
function buildConfirmGate(deps: { now(): number; host: () => ConfirmHost }, screenControl: ScreenControl | null) {
  const screenBusy = (kind: string): boolean => !SCREEN_CHECK_SKIPPED_KINDS.has(kind) && !VIEW_ONLY_KINDS.has(kind) && screenControl?.(deps.now()).active === true;
  let pending: Pending | null = null;
  /**
   * The one answer already given (the last request's): a second press of the SAME request id with the SAME answer is the first press again (a double click, a re-sent call), so it gets the first press's outcome, the one in flight or the one it ended with.
   * It runs nothing, and a late repeat never turns a success into a refusal. Another id or the other answer is no request (`no_pending_request`). Kept for one request only (the next request and a reset clear it).
   */
  let answered: { id: string; answer: "yes" | "no"; done: Promise<ConfirmOutcome> } | null = null;
  const live = (): Pending | null => { if (pending && deps.now() - pending.createdAt > TTL_MS) drop(); return pending; };
  function drop(): void { const p = pending; pending = null; if (p) { try { deps.host().closeWindow?.(p.id); } catch { /* nothing to close */ } } }
  return {
    /** The owner window's request. Returns a code, never the action's result. */
    request(kind: string, view: Record<string, unknown>, run: Run, alt?: Run): { ok: true; requestId: string } | { ok: false; code: string } {
      drop(); answered = null;
      if (screenBusy(kind)) return { ok: false, code: "screen_control_active" };
      const id = randomBytes(12).toString("base64url");
      pending = { id, kind, createdAt: deps.now(), view, run, ...(alt ? { alt } : {}) };
      let shown = false;
      try { shown = deps.host().openWindow({ id, kind }); } catch { shown = false; }
      if (!shown) { pending = null; return { ok: false, code: "confirm_window_unavailable" }; }
      return { ok: true, requestId: id };
    },
    /** What the confirmation window shows. Anything but that window gets nothing. */
    view(event: unknown): { ok: true; requestId: string; kind: string; view: Record<string, unknown>; screenBusy: boolean } | { ok: false; code: string } {
      if (!deps.host().isConfirmSender(event)) return { ok: false, code: "not_confirm_window" };
      const p = live(); if (!p) return { ok: false, code: "no_pending_request" };
      return { ok: true, requestId: p.id, kind: p.kind, view: p.view, screenBusy: screenBusy(p.kind) };   // read again by the window on focus: it greys the yes while the screen is operated
    },
    /**
     * The only place a pending action runs: the confirmation window's own "yes". `answer: "no"` is the window's "this wasn't me": it runs the request's own refusal (`alt`, given at the request),
     * which hands nothing over, so it waits for neither the first second nor the screen-control check (the same reasoning as SCREEN_CHECK_SKIPPED_KINDS). A request with no refusal answers `no_alternative` and keeps the request.
     */
    async approve(event: unknown, requestId: unknown, answer?: unknown): Promise<ConfirmOutcome> {
      if (!deps.host().isConfirmSender(event)) return { ok: false, code: "not_confirm_window" };
      const said = answer === "no" ? "no" : "yes";
      if (answered && typeof requestId === "string" && answered.id === requestId && answered.answer === said) return answered.done;   // the same press again: the same outcome, nothing runs twice
      const p = live();
      if (!p || typeof requestId !== "string" || p.id !== requestId) return { ok: false, code: "no_pending_request" };
      const closeWith = (outcome?: ConfirmOutcome): void => { try { deps.host().closeWindow?.(p.id, outcome); } catch { /* ignore */ } };
      if (answer === "no") {
        const alt = p.alt;
        if (!alt) return { ok: false, code: "no_alternative" };
        pending = null;
        const done = (async (): Promise<ConfirmOutcome> => {
          let refusal: ConfirmOutcome = { ok: false, code: "confirm_run_failed" };
          try { refusal = await alt(); return refusal; } finally { closeWith(refusal); }
        })();
        answered = { id: p.id, answer: "no", done };
        return done;
      }
      if (SESSION_KINDS.has(p.kind)) return { ok: false, code: "session_kind" };   // a session window answers through `session()`, never through one yes
      if (!VIEW_ONLY_KINDS.has(p.kind)) {
        let ready = true; try { const h = deps.host(); ready = h.pressReady ? h.pressReady(event) : true; } catch { ready = false; }
        if (!ready) return { ok: false, code: "too_early" };   // the window is seconds old: nothing is used up, the owner presses again
      }
      pending = null; // one yes, one run
      if (VIEW_ONLY_KINDS.has(p.kind)) { closeWith(); return { ok: false, code: "view_only" }; }
      const run = p.run, busy = screenBusy(p.kind);
      const done = (async (): Promise<ConfirmOutcome> => {
        if (busy) { const out = { ok: false, code: "screen_control_active" }; closeWith(out); return out; }
        let out: ConfirmOutcome = { ok: false, code: "confirm_run_failed" };
        let kept = false;
        try {
          out = await run();
          // A yes that did nothing and says it may be pressed again (`retry`, e.g. the local disconnect failed: nothing was done, nothing was sent) keeps the request AND the window, inside the request's own two minutes: the owner presses the same button again.
          if (out.ok !== true && out.retry === true && pending === null && deps.now() - p.createdAt <= TTL_MS) { pending = p; answered = null; kept = true; }
          return out;
        } finally { if (!kept) closeWith(out); }
      })();
      answered = { id: p.id, answer: "yes", done };
      return done;
    },
    /**
     * One step of a session window (SESSION_KINDS): `press: false` is a read (the list, one full text) and needs only the window and the live request; `press: true` is an answer that changes something, so it also
     * waits for the first second (`too_early`, nothing is used up) and refuses while something operates the screen (`screen_control_active`). The request stays until the window cancels it, closes, or the two minutes end.
     */
    session(event: unknown, requestId: unknown, kind: string, opts: { press: boolean }): { ok: true; screenBusy: boolean } | { ok: false; code: string } {
      if (!SESSION_KINDS.has(kind)) return { ok: false, code: "not_session_kind" };
      if (!deps.host().isConfirmSender(event)) return { ok: false, code: "not_confirm_window" };
      const p = live();
      if (!p || typeof requestId !== "string" || p.id !== requestId || p.kind !== kind) return { ok: false, code: "no_pending_request" };
      const busy = screenBusy(p.kind);
      if (opts.press) {
        let ready = true; try { const h = deps.host(); ready = h.pressReady ? h.pressReady(event) : true; } catch { ready = false; }
        if (!ready) return { ok: false, code: "too_early" };
        if (busy) return { ok: false, code: "screen_control_active" };
      }
      return { ok: true, screenBusy: busy };
    },
    cancel(event: unknown, requestId: unknown): { ok: boolean; code?: string } {
      if (!deps.host().isConfirmSender(event)) return { ok: false, code: "not_confirm_window" };
      if (pending && pending.id === requestId) drop();
      return { ok: true };
    },
    /** The window went away by itself (closed by the owner, or it could not load, or its two minutes ended): the request it showed is gone. No window to close. */
    windowGone(requestId: unknown): void { if (pending && pending.id === requestId) pending = null; },
    /** Sign-out or another account: nothing pending survives. */
    reset(): void { drop(); answered = null; },
    hasPending: (): boolean => live() !== null,
  };
}
export type ConfirmGate = ReturnType<typeof buildConfirmGate>;
