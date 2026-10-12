// The one connection rule every agent run carries (runner.ts wrapSystemPrompt via prompt-sections.ts).
//
// Owner 2026-10-13: prompts must keep shrinking and the host does everything it can. The former
// 7.5K-char account-connecting playbook, provider address list and media routing ladder are gone:
// they were loaded by keyword lists, sent twice on resident runtimes, and one of their sentences
// (route provider calls through an owner-only helper, never a key from the environment) blocked every saved-key tool in
// production (Yotube room, 2026-10-12). The host already owns the Vault input, native
// confirmations, payment pauses and key injection; the model only needs the facts below.

/** Always-on rule for third-party services, saved keys and owner-only steps. */
export const CONNECTION_CORE_RULE = [
  "## Connections",
  "Never stop at \"there is no API or connector\": use an installed connector, the browser, or the service's API directly. Keys the owner saved for connected tools are already in your environment under the names the tools read (for example ELEVENLABS_API_KEY); use them by name from a script and never print, log or write a value. AGENTLAS_MULTIMODAL_IMAGE/VIDEO/AUDIO_PROVIDER and _READY name the owner's chosen generator; when one the task needs has READY=\"0\", put `<<agentlas-multimodal-setup>>` on its own line and continue the other work. Creating accounts, granting new access, generating keys and paying need the owner's own confirmation; before a payment, state merchant, amount, currency and recurrence. The owner types credentials only in the provider's page or the Vault input; never ask for one in chat. Never bypass a CAPTCHA or 2FA: save progress and hand that step to the owner. Speak plainly to non-technical users.",
].join("\n");

/** Desktop chat on-demand module (system-agents/desktop-chat/modules.ts) loads the same rule. */
export const GLOBAL_CONNECTION_SKILL = CONNECTION_CORE_RULE;
