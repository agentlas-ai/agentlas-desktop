/*
 * The name a person gave their One (first-run step 02 / One profile sheet).
 *
 * "One" stays the product and technical role. Every sentence where One speaks or
 * acts as the person's agent should use the name the person chose instead. The
 * i18n layer applies this only to an explicit key list (ONE_PERSONA_KEYS) so
 * product sentences ("One is where you decide…, Work is where…") keep the
 * product name.
 *
 * Korean particles must agree with the new name: "One이" → "루나가", "One은" →
 * "루나는". A literal substitution would print "루나이", which reads as broken.
 */
import { useSyncExternalStore } from "react";
import { ipc } from "./ipc";

export const DEFAULT_ONE_NAME = "One";

let current = DEFAULT_ONE_NAME;
const listeners = new Set<() => void>();

export function getOnePersonaName(): string {
  return current;
}

export function setOnePersonaName(name: string | null | undefined): void {
  const next = (name ?? "").trim() || DEFAULT_ONE_NAME;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeOnePersonaName(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React hook: the current person-facing name of One (re-renders on change). */
export function useOnePersonaName(): string {
  return useSyncExternalStore(subscribeOnePersonaName, getOnePersonaName, () => DEFAULT_ONE_NAME);
}

let syncStarted = false;
/** Load the saved name once and follow later profile edits. Idempotent. */
export function startOnePersonaNameSync(): void {
  if (syncStarted || typeof window === "undefined") return;
  const api = ipc();
  if (!api?.oneProfile?.get) return;
  syncStarted = true;
  const load = () => { void api.oneProfile.get().then((profile) => setOnePersonaName(profile?.displayName)).catch(() => undefined); };
  load();
  try {
    window.agentlasEvents?.onStoreChanged?.((change) => { if (change.entity === "one-profile") load(); });
  } catch { /* older preload: the name refreshes on the next launch */ }
}

/** Does the last syllable/letter carry a final consonant (받침)? */
export function hasFinalConsonant(word: string): boolean {
  const last = word.trim().slice(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return "013678".includes(last);
  // Latin names: read the way Korean speakers pronounce the final sound.
  return /[bcklmnpt]$/i.test(last) || /(ng)$/i.test(word.trim());
}

const PAIRS: Record<string, [string, string]> = {
  // particle as written after "One" → [after final consonant, after vowel]
  "이": ["이", "가"],
  "가": ["이", "가"],
  "은": ["은", "는"],
  "는": ["은", "는"],
  "을": ["을", "를"],
  "를": ["을", "를"],
  "과": ["과", "와"],
  "와": ["과", "와"],
};

export function personalizeOneText(text: string, name: string, locale: "ko" | "en"): string {
  const clean = name.trim();
  if (!clean || clean === DEFAULT_ONE_NAME) return text;
  if (locale === "en") return text.replace(/\bOne\b(?![-‑])/g, clean);
  const batchim = hasFinalConsonant(clean);
  return text.replace(/One(에게|한테|의|이|가|은|는|을|를|과|와)?/g, (_match, particle?: string) => {
    if (!particle) return clean;
    const pair = PAIRS[particle];
    return clean + (pair ? pair[batchim ? 0 : 1] : particle);
  });
}

/**
 * Keys where "One" names the person's agent. Product-level sentences are left
 * out on purpose (e.g. one.act.distinction, one.feat.mobile_confirm.body).
 */
export const ONE_PERSONA_KEYS: ReadonlySet<string> = new Set([
  "one.sug.auto.title",
  "one.act.body_concern",
  "one.feat.slide.briefing.title",
  "one.feat.slide.work.body",
  "one.mem.basis.suggested",
  "one.mem.aria.close_memory",
  "one.mem.header.title",
  "one.mem.header.body",
  "one.mem.compounding.body",
  "one.mem.saved.body",
  "one.prof.msg.principle_added",
  "one.prof.principles.title",
  "one.prof.principles.desc",
  "one.rec.field.permission",
  "one.rec.explainer",
  "one.res.acceptance_boundary",
  "one.res.prov.generated",
  "one.res.decision.choose_hint",
  "one.rev.loading",
  "one.rev.body.starting_point",
  "one.shell.system_prompt.label.retry_unfinished",
  "one.shell.system_prompt.label.runtime_recovered",
  "one.shell.proactive.project_folder_unreadable.body",
  "one.shell.proactive.project_folder_not_directory.body",
  "one.shell.proactive.project_deadline_conflict.body",
  "one.shell.runtime_recovery.auth_body",
  "one.shell.runtime_recovery.connection_body",
  "one.shell.briefing.review",
  "one.shell.briefing.confirm_title",
  "one.shell.composer.placeholder_conversation",
  "one.shell.composer.request_aria",
  "one.shell.loading",
  "one.shell.firstrun.body",
  "one.autosheet.body",
  "one.autosheet.error_target",
  "one.shell.briefing.reviewing_now",
  "one.shell.thread.working_directly",
  "one.shell.decision.kicker_choice",
  "one.shell.decision.approval_unavailable",
  "one.shell.decision.approval_unavailable_body",
  "one.shell.decision.model_review_pending",
  "one.shell.decision.model_review_pending_body",
  "one.shell.decision.change_scope",
  "one.shell.decision.adjust_conditions",
  "one.shell.receipt.change_mind",
  "one.val.subtitle",
  "one.voice.privacy",
  "one.week.corrections.base",
]);
