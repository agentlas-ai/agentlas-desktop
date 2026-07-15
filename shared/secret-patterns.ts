// Credential/secret detection, shared by every write boundary that must never persist or
// transmit a live key. Historically each boundary carried its own inline regex (13+ copies),
// so a key format was caught in one place and stored in plain text in another — the Memory
// Curator, for instance, missed github_pat_/AIza/glpat/JWT while ontology export caught them.
// One list, one behaviour: extend HERE, not at a call site.
//
// Scope rule: match *credential shapes*, not the words around them. Ordinary prose that
// mentions "token" or a hyphenated phrase must not trip this — a false positive silently
// drops a user's memory or blocks a legitimate note, which is its own kind of data loss.

/** Live-credential shapes across the providers this product actually touches. */
const SECRET_SHAPES: RegExp[] = [
  // GitHub: classic PAT (ghp_), OAuth/user/server tokens (gho_/ghu_/ghs_/ghr_), fine-grained PAT.
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  // Slack bot/user/app tokens.
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  // AWS access key ids (long-lived and STS).
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  // Google / Firebase API keys.
  /AIza[0-9A-Za-z_-]{30,}/,
  // Stripe and similar: secret/restricted/publishable, live or test.
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  // OpenAI / Anthropic, including the newer provider-segmented forms (sk-proj-, sk-ant-).
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}/,
  // HuggingFace, GitLab, npm.
  /hf_[A-Za-z0-9]{20,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /npm_[A-Za-z0-9]{20,}/,
  // JWTs (three base64url segments) — bearer tokens frequently land in pasted logs.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // Telegram bot tokens.
  /\b[0-9]{8,}:[A-Za-z0-9_-]{25,}\b/,
  // Private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** `password: hunter2` style assignments, where the value shape alone proves nothing. */
const SECRET_ASSIGNMENT_RE =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer)\b\s*[:=]\s*\S+/i;

/** Single source of truth. Case-insensitive: providers are inconsistent about casing. */
export const SECRET_PATTERNS: RegExp[] = [
  ...SECRET_SHAPES.map((re) => new RegExp(re.source, "i")),
  SECRET_ASSIGNMENT_RE,
];

/** True when the text contains something that looks like a live credential. */
export function looksSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

/** Replace credential-shaped substrings with a marker, preserving the surrounding text.
 *  Use where dropping the whole payload would lose more than it protects. */
export function redactSecrets(content: string, marker = "[redacted-secret]"): string {
  let out = content;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), marker);
  }
  return out;
}
