/**
 * The app's own unexpected exceptions, told apart from everything else by their CLASS and the platform's own fields, never
 * by their message: a TypeError / RangeError / ReferenceError / SyntaxError, a SQLite driver error, a Node system error that
 * names a syscall (ENOENT, EACCES, EMFILE ...). Not these: a process that could not start (spawn ...: the CLI is missing or
 * blocked) and a full / read-only disk (ENOSPC, EDQUOT, EROFS) are facts the owner can act on and keep their own words.
 *
 * Why this exists: invocationFailure (mcp/client.ts) used to put an unexpected exception's own message in the run's error
 * event ("Cannot read properties of undefined (reading 'x')", "SQLITE_READONLY: attempt to write a readonly database",
 * "ENOENT: no such file or directory, open '<user path>'"). The chat stream drew it as "Reason: <message>" and the phone
 * received it the same way: system text the owner can do nothing with, with a path in it. The cause stays in the run record
 * (an invoke_error_diagnostic row, bounded and redacted); what the owner reads is one plain sentence.
 *
 * Network failures are NOT host-internal even when Node reports them as a TypeError ("fetch failed" carries the socket's
 * error as its cause): they stay what they were, so a provider outage is still told as one.
 */

const INTERNAL_CLASSES = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError] as const;
/** Socket / DNS / TLS error codes of Node's network stack: an external cause, whatever class carries them. */
const NETWORK_CODE = /^(?:ECONN[A-Z]*|ENET[A-Z]*|EHOST[A-Z]*|EAI_[A-Z]+|ETIMEDOUT|ENOTFOUND|EPIPE|ESOCKET[A-Z]*|UND_ERR_[A-Z_]+|ERR_(?:SSL|TLS|SOCKET)[A-Z_]*|CERT_[A-Z_]+|DEPTH_ZERO_[A-Z_]+|UNABLE_TO_[A-Z_]+)$/;
/** A file-system failure the owner can act on (free disk space, a read-only volume): it keeps its own words. */
const OWNER_ACTIONABLE_FS_CODE = /^(?:ENOSPC|EDQUOT|EROFS)$/;
const CHAIN_LIMIT = 5;

function dataProperty(value: unknown, name: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    let owner: object | null = value as object;
    for (let depth = 0; owner && depth < 3; depth += 1, owner = Object.getPrototypeOf(owner)) {
      const property = Object.getOwnPropertyDescriptor(owner, name);
      if (property) return Object.hasOwn(property, "value") ? property.value : undefined;
    }
  } catch { /* A revoked proxy supplies no trustworthy field. */ }
  return undefined;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current && depth < CHAIN_LIMIT && !seen.has(current); depth += 1) {
    seen.add(current);
    chain.push(current);
    current = dataProperty(current, "cause");
  }
  return chain;
}

function isNetworkFailure(error: unknown): boolean {
  return causeChain(error).some((link) => {
    const code = dataProperty(link, "code");
    return typeof code === "string" && NETWORK_CODE.test(code);
  });
}

/** True for the app's own unexpected exception (class / driver / syscall facts only). False for network, abort and everything typed. */
export function isHostInternalException(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (isNetworkFailure(error)) return false;
  const name = dataProperty(error, "name");
  if (name === "AbortError" || name === "TimeoutError") return false;
  if (INTERNAL_CLASSES.some((type) => error instanceof type)) return true;
  const code = dataProperty(error, "code");
  if (name === "SqliteError" || (typeof code === "string" && /^SQLITE_/.test(code))) return true;
  const syscall = dataProperty(error, "syscall");
  if (typeof syscall !== "string" || !syscall) return false;
  // A process that could not start (spawn ENOENT / EACCES: the CLI is missing or not executable) and a full or read-only disk
  // are environment facts the owner can fix, not the app's own fault: they keep their own words.
  if (/^spawn/.test(syscall) || (typeof code === "string" && OWNER_ACTIONABLE_FS_CODE.test(code))) return false;
  return true;
}

/** The one sentence the owner reads for an unexpected internal exception: what happened to the request, no cause text, no code. */
export function hostInternalFailureMessage(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "앱 안에서 예상하지 못한 문제가 생겨 이번 실행을 끝내지 못했습니다. 요청은 저장되어 있습니다. 같은 요청을 다시 보내 주세요."
    : "Something unexpected happened inside the app, so this run could not finish. Your request is saved. Please send it again.";
}
