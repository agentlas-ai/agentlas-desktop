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
  // Company-only Native device credentials.
  /agcni_v1_[A-Za-z0-9_-]{43}/,
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
  // Keys only ever start a token: without the left boundary the "sk-" inside an
  // ordinary kebab-case code was taken for a key — "task-force-failed" reached
  // the owner as "ta[redacted]" (2026-09-28), "decision-task-..." likewise.
  /(?<![A-Za-z0-9_-])sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}/,
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

/*
 * Credential assignments (`password: hunter22`, `token=…`): ONE rule for every boundary (review 2026-10-16 H4). Before,
 * this list and the mobile bridge sanitizer each had their own: the sanitizer also caught bare token/session/cookie, so
 * `token=<value>` passed the suggestion validator while the phone redacted it, and the phone (which copies the bridge
 * sanitizer verbatim) disagreed with every Desktop write boundary. Measured on the owner's store before choosing the
 * value shape: a plain union of the two key lists newly flagged 3 of 4,571 memory entries, all prose ("session: <word>",
 * "token: <Korean word>") — each of those boundaries drops or rewrites the whole item. So:
 *   - a key that only ever names a credential (password, passwd, secret, api key, access/auth token) counts with any
 *     value of 4+ characters;
 *   - a key that is also an everyday word (token, session, cookie, pwd, bearer, authorization) counts in config syntax
 *     (`token=value`, no space before the value, 4+ characters), or with any separator when the value is
 *     credential-shaped: 6+ characters holding a digit, or a 16+ character run of key characters. Prose such as
 *     "session: Tuesday" stays. An `Authorization: Bearer …` header is still caught by the Bearer shape at the
 *     boundaries that have it.
 * Exported as a source string so the mobile bridge sanitizer builds its pattern from it; the phone ports it verbatim.
 */
const ASSIGNMENT_VALUE_CHAR = String.raw`[^,\s"'}\`\]]`;
export const SECRET_ASSIGNMENT_SOURCE = String.raw`\b(?:(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?${ASSIGNMENT_VALUE_CHAR}{4,}|(?:token|session|cookie|pwd|bearer|authorization)\b(?:=["']?${ASSIGNMENT_VALUE_CHAR}{4,}|\s*[:=]\s*["']?(?:(?=${ASSIGNMENT_VALUE_CHAR}*[0-9])${ASSIGNMENT_VALUE_CHAR}{6,}|[A-Za-z0-9._~+=-]{16,})))`;
const SECRET_ASSIGNMENT_RE = new RegExp(SECRET_ASSIGNMENT_SOURCE, "i");

/** Single source of truth. Case-insensitive: providers are inconsistent about casing. */
export const SECRET_PATTERNS: RegExp[] = [
  ...SECRET_SHAPES.map((re) => new RegExp(re.source, "i")),
  SECRET_ASSIGNMENT_RE,
];

/** True when the text contains something that looks like a live credential. */
export function looksSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

/*
 * Private-key blocks: ONE rule for every masking boundary (owner decision 2026-10-16, option B, "비밀키 안가려도됨":
 * do not over-mask the text around a key; this is not "stop masking keys").
 *   - A complete block (BEGIN header … END line) is masked whole, END line included. It never spans into another
 *     block's BEGIN, so prose between an unterminated header and a later block stays.
 *   - An unterminated header is masked with the body that follows it, and the mask stops at the first token that is
 *     not body. Body tokens: base64 runs of 16+ characters holding a digit, "+" or "/" (a wrapped PEM line), shorter
 *     "="-padded runs (a last line), and the RFC 1421 Proc-Type / DEK-Info lines of a legacy encrypted key. Tokens are
 *     separated by whitespace, CRLF or LF, or the escaped \n / \r of a JSON string. Prose words carry no digit, so a
 *     sentence after a truncated key stays readable.
 *   - Accepted by that decision: a truncated key may expose a short trailing fragment (an unpadded last line under 16
 *     characters, or one with no digit, "+" or "/").
 * Terminal keeps its own copy (agentlas_terminal engine/agentlas-secret-patterns.cjs); the owner is retiring it.
 */
const PRIVATE_KEY_HEADER = "-----BEGIN [A-Z ]*PRIVATE KEY-----";
const PRIVATE_KEY_COMPLETE_RE = new RegExp(`${PRIVATE_KEY_HEADER}(?:(?!-----BEGIN )[\\s\\S])*?-----END [A-Z ]*PRIVATE KEY-----`, "gi");
const PRIVATE_KEY_BODY_SEPARATOR = String.raw`(?:[ \t\r\n]|\\[rn])+`;
const PRIVATE_KEY_BODY_TOKEN = String.raw`(?:(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{16,}={0,2}|[A-Za-z0-9+/]{2,}={1,2}|(?:Proc-Type|DEK-Info):[ \t]*[A-Za-z0-9,-]+)(?![A-Za-z0-9+/=._:@-])`;
const PRIVATE_KEY_UNTERMINATED_RE = new RegExp(`${PRIVATE_KEY_HEADER}(?:${PRIVATE_KEY_BODY_SEPARATOR}${PRIVATE_KEY_BODY_TOKEN})*`, "gi");

/** Mask private-key blocks by the one bounded rule above, keeping every character around them. */
export function maskPrivateKeyBlocks(content: string, marker = "[redacted-secret]"): string {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(content)) return content;
  return content.replace(PRIVATE_KEY_COMPLETE_RE, marker).replace(PRIVATE_KEY_UNTERMINATED_RE, marker);
}

/** Replace credential-shaped substrings with a marker, preserving the surrounding text.
 *  Use where dropping the whole payload would lose more than it protects. */
export function redactSecrets(content: string, marker = "[redacted-secret]"): string {
  // A whole key block, or a truncated one with its body; never the header alone, never the text after it.
  let out = maskPrivateKeyBlocks(content, marker);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), marker);
  }
  return out;
}
