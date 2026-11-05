/*
 * The plain sentence every harness refusal carries (owner rule: no internal code reaches the owner's screen).
 *
 * Why this exists. A port answers a model with a machine code: `reason` on a refusal, `data.code` / `data.error` when app.call ran the
 * operation and its handler said no, `data.state` on an auth answer. The model quoted them to the owner word for word (production
 * 10-22..11-05: login_may_be_required 11 messages, goal_control_binding_changed 4, one_graph_target_not_in_context 3,
 * one-os-human-active 3, operation-not-allowed 2, device_bridge_disconnected 1, goal_panel_no_plan 1, outcome_unsatisfied 1), because the
 * code was the only thing in the answer that named what happened. The code stays where host logic reads it (`reason`, `data.code`,
 * `data.state`); `tellOwner` sits beside it as one sentence in plain words that says what happened and what to do next.
 *
 * Pure: no Electron, no store, no clock. Idempotent: a result that already carries `tellOwner` is returned as it is. A code this table
 * does not name still gets a sentence, chosen by the status and by the end of the code ("_unavailable", "_missing", "_invalid"), so a
 * code is never the whole answer and a new refusal needs no entry here to be safe. The sentence never contains the code.
 *
 * Prompt composition policy (docs/PROMPT-COMPOSITION-POLICY.md): this is data in a typed response field of a tool result, not a prompt
 * module. It is computed by the host from the typed code (rule 2: a function, not prose in a prompt), no prompt line is added, changed
 * or removed, and a tool result is turn-context stability, below every fixed prefix, so no cache prefix moves. No composition-ledger
 * entry is needed. What stays open: a real-model A/B of whether models relay `tellOwner` instead of the code (see the report).
 */

export const PLAIN_SENTENCE_FIELD = "tellOwner";

/** What a code means for the owner, in one sentence that names no code, tool or file and says what happens next. */
const REASON_SENTENCES: Readonly<Record<string, string>> = {
  // The call itself was malformed: not the owner's problem, and the same call is sent again correctly.
  operation_unknown: "The app has no action by that name, so nothing was done; the right action is looked up again before the request is repeated.",
  id_unknown: "The app has no item by that name, so nothing was done; the right one is looked up again before the request is repeated.",
  feature_unknown: "The app has no feature by that name, so nothing was done; the right one is looked up again before the request is repeated.",
  arguments_missing: "The request was missing a detail the app needs, so nothing was done; it is sent again with that detail.",
  arguments_misplaced: "The request was put together the wrong way, so nothing was done; it is sent again in the right form.",
  arguments_invalid: "The request was put together the wrong way, so nothing was done; it is sent again in the right form.",
  dry_run: "This was a rehearsal, so nothing was changed; the real run makes the change.",
  operation_failed: "The app ran into an unexpected problem and this step may not have finished; check whether the result is there before relying on it, and try once more if it is not.",
  turn_tools_unavailable: "The tools for this turn are no longer connected, so this step was not done; it can be repeated in the next message.",
  "turn-tools-operation-invalid": "That tool is not available in this turn, so the step was not done; it can be repeated in the next message.",
  "turn-tools-capability-invalid": "The tools for this turn are no longer connected, so the step was not done; it can be repeated in the next message.",
  "turn-tools-control-unavailable": "The app's tool connection is not ready, so the step was not done; it can be repeated in a moment.",
  // Seen in production (observed in use, assistant messages).
  goal_control_binding_changed: "The Goal in this chat is not the one that request was about (it was replaced or finished, or this chat has none), so the Goal was not changed; the current Goal is read first and the request is repeated against it.",
  goal_panel_no_plan: "This Goal has no plan yet, so that plan change could not be saved; the plan has to exist before it can be changed.",
  one_graph_target_not_in_context: "That automation does not belong to this conversation, so it could not be changed here; it can be read, or changed from the conversation that created it.",
  "one-os-human-active": "You are using the screen right now, so the app left it alone instead of taking over; it continues when you stop, or you can do that step yourself.",
  "operation-not-allowed": "The app does not allow this action from this kind of conversation, so it was not run; do it from the app's own screen, or ask for it there.",
  device_bridge_disconnected: "The link to the phone or the browser window is not connected right now, so this could not be looked up; reconnect it and try again.",
  outcome_unsatisfied: "The app carried out the clicks, but the change it was meant to cause was not seen on screen, so it is not counted as done; check the app and try again.",
  "worker-capability-selection-unavailable": "A helper could not get the tools it needed for its part, so that part did not run; the rest of the work continues without it.",
  unsupported_capability: "This computer's app cannot do that action, so it was not run; another way to do it is chosen.",
  pending_host: "The app accepted the request and finishes it after this reply; nothing more is needed now.",
  goal_episode_admission_missing: "The Goal could not start this piece of work because the app has not recorded it as part of the Goal; it is started again from the Goal.",
  goal_owner_answer_required: "The Goal is waiting for your answer before it can go on; please answer the open question.",
  prerequisite_evidence_unverified: "The condition this step waits for could not be confirmed yet, so the step was held; it runs when the condition is confirmed.",
  automation_stop_handle_already_bound: "That automation run is already being stopped, so nothing more is needed.",
  // Sign-in and keys.
  connector_not_installed: "That service is not connected to the app yet, so the step was not done; connect it first or pick another way.",
  connector_url_missing: "That connection has no address saved, so it cannot be signed in; it has to be set up again in Settings.",
  vault_input_required: "That service needs a key from you; please save it in the app's key field (never in the chat), then the step can continue.",
  provider_key_missing: "That service needs a key from you; please save it in Settings, then the step can continue.",
  no_transcribe_route: "No speech-to-text service is set up yet, so the audio could not be turned into text; add one in Settings, then try again.",
  credential_store_unavailable: "The computer's saved-key storage did not answer, so saved keys cannot be read right now; unlock it or allow Agentlas to use it, then press Retry access in Settings.",
};

/** What a sign-in or connection state means, for `data.state` (and `data.credentialState`). */
const STATE_SENTENCES: Readonly<Record<string, string>> = {
  login_may_be_required: "This site is not confirmed as signed in yet; open it in the Agentlas browser and sign in there once, then the work can go on.",
  credential_missing: "A key or login this service needs is not saved yet; it has to be added in Settings (never in the chat) before the service can be used.",
  signed_out: "This service was signed out; sign in to it again in Settings, then the work can go on.",
  disabled: "This connection is switched off, so it is not used; switch it on in Settings if you want it.",
  configuration_changed: "This connection's settings changed since it last worked, so it is being checked again before it is used.",
  unobserved: "This connection has not been tried yet, so it is not known whether it works.",
  ready_in_browser: "You are signed in to this site in the Agentlas browser, so the work continues there.",
  ready_via_key: "A saved key already covers this service, so no sign-in is needed.",
};

const REUSED_SENTENCES: Readonly<Record<string, string>> = {
  browser_session: "You are already signed in to this site in the Agentlas browser, so nothing more is needed.",
  oauth_session: "You are already signed in to this service, so nothing more is needed.",
  vault_keys: "The saved keys for this service are in place, so nothing more is needed.",
  none_needed: "This service needs no sign-in, so nothing more is needed.",
  vault_key_route: "A saved key already covers this service, so no sign-in is needed.",
};

const BARE_CODE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/;

/** One sentence for a refusal or an unavailable answer. Always non-empty, never contains the code. */
export function plainSentenceForReason(status: "refused" | "unavailable", reason: string | undefined): string {
  const code = typeof reason === "string" ? reason.trim() : "";
  const known = REASON_SENTENCES[code];
  if (known) return known;
  const state = STATE_SENTENCES[code];
  if (state) return state;
  if (status === "unavailable" || /(?:^|[_-])(?:unavailable|unsupported|not[_-]wired|disconnected|offline)$/.test(code)) {
    return "The app cannot do this right now, so this step was not done; it can be tried again later or done another way.";
  }
  if (/(?:^|[_-])(?:missing|required|needed|not[_-]found|unknown)$/.test(code)) {
    return "Something this step needs is not set up yet, so the step was not done; it can go ahead once that is provided.";
  }
  if (/(?:^|[_-])(?:invalid|mismatch|conflict|changed|stale)$/.test(code)) {
    return "What the request relied on has changed or does not fit, so nothing was done; it can be checked again and retried.";
  }
  return "The app did not do this step, so it is not done yet; it can be tried again in a moment or done another way.";
}

/** One sentence for a sign-in or connection state value, or null when the state needs no words (ready, enabled, an unknown value). */
export function plainSentenceForState(state: unknown, reused?: unknown): string | null {
  if (typeof state === "string" && STATE_SENTENCES[state]) return STATE_SENTENCES[state];
  if (state === "ready" && typeof reused === "string" && REUSED_SENTENCES[reused]) return REUSED_SENTENCES[reused];
  return null;
}

/**
 * The machine code an app.call-style answer carries when its handler said no, or null. app.call sets `code` from the handler's own
 * result and falls back to "operation-refused" when the handler gave none, so the handler's code can sit one level down in `result`.
 */
function failureCodeOf(data: Record<string, unknown>): string | null {
  if (data.ok !== false) return null;
  const inner = data.result && typeof data.result === "object" && !Array.isArray(data.result) ? data.result as Record<string, unknown> : {};
  const candidates: string[] = [];
  for (const source of [data, inner]) {
    for (const key of ["code", "reasonCode", "error"] as const) {
      const value = source[key];
      if (typeof value === "string" && value.trim() && (key !== "error" || BARE_CODE.test(value.trim()))) candidates.push(value.trim());
    }
  }
  return candidates.find((code) => REASON_SENTENCES[code]) ?? candidates.find((code) => code !== "operation-refused") ?? candidates[0] ?? null;
}

interface ResultLike { operationId?: unknown; status?: unknown; reason?: unknown; data?: unknown; tellOwner?: unknown }

/** Only the sign-in and connection ports speak in these states; another port's own `state` word is not read as one. */
const STATE_OPERATIONS = /^(?:auth|connector)\./;

/** The same keys in the same order with `key` placed right after `after` (at the end when `after` is absent), so the sentence is read beside the code. */
function insertAfter<T extends object>(source: T, after: string, key: string, value: unknown): T {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [name, v] of Object.entries(source)) {
    out[name] = v;
    if (name === after) { out[key] = value; placed = true; }
  }
  if (!placed) out[key] = value;
  return out as T;
}

/**
 * The same result with its plain sentence added, or the very same object when it needs none or already has one.
 * refused / unavailable: top-level `tellOwner`. ok whose data says no (`ok:false` with a code) or names a non-ready sign-in state:
 * `data.tellOwner` (the data is copied, never edited).
 */
export function withPlainSentence<T extends object>(result: T): T {
  const r = result as ResultLike;
  if (!result || typeof result !== "object") return result;
  if (r.status === "refused" || r.status === "unavailable") {
    if (typeof r.tellOwner === "string" && r.tellOwner.trim()) return result;
    const reason = typeof r.reason === "string" ? r.reason : undefined;
    return insertAfter(result, "reason", PLAIN_SENTENCE_FIELD, plainSentenceForReason(r.status, reason));
  }
  if (r.status !== "ok" || !r.data || typeof r.data !== "object" || Array.isArray(r.data)) return result;
  const data = r.data as Record<string, unknown>;
  if (typeof data.tellOwner === "string" && data.tellOwner.trim()) return result;
  const code = failureCodeOf(data);
  if (code !== null) return { ...result, data: insertAfter(data, "code" in data ? "code" : "operation", PLAIN_SENTENCE_FIELD, plainSentenceForReason("refused", code)) };
  const sentence = typeof r.operationId === "string" && STATE_OPERATIONS.test(r.operationId) ? plainSentenceForState(data.state, data.reused) : null;
  if (sentence) return { ...result, data: insertAfter(data, "state", PLAIN_SENTENCE_FIELD, sentence) };
  return result;
}

/** A thrown handler message of the form `code: sentence` (failure-copy.ts) split into its two parts, or null for any other text. */
export function splitCodedFailure(message: string): { code: string; sentence: string } | null {
  const match = /^([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+):\s+(\S[\s\S]*)$/.exec(String(message ?? "").trim());
  return match ? { code: match[1], sentence: match[2] } : null;
}
