/**
 * The app's own unexpected exceptions, told apart from everything else by their CLASS and the platform's own fields, never
 * by their message: a TypeError / RangeError / ReferenceError / SyntaxError, a SQLite driver error, a Node system error that
 * names a syscall (ENOENT, EACCES, EMFILE ...). Not these: a process that could not start (spawn ...: the CLI is missing or
 * blocked) and a full / read-only disk (ENOSPC, EDQUOT, EROFS) are facts the owner can act on and keep their own words.
 *
 * Why this exists: invocationFailure (mcp/client.ts) used to put an unexpected exception's own message in the run's error
 * event ("Cannot read properties of undefined (reading 'x')", "SQLITE_READONLY: attempt to write a readonly database",
 * "ENOENT: no such file or directory, open '/Users/...'"). The chat stream drew it as "Reason: <message>" and the phone
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

/**
 * The one sentence the owner reads for an unexpected internal exception: what happened to the request, no cause text, no code, and the true
 * thing about what happens next. `resend` is the forecast of resend-forecast.ts: "now" = the app sends the same message again by itself,
 * "spent" = it already did once and nothing more is sent automatically, "none" = nothing is sent automatically.
 * "spent" and "none" are a separate end reason, not a delivery given up: the effect is unknown (a tool may have run), so sending again blindly could
 * run the same action twice. By then the app has also sent it again with the verify-first line (earlier-attempt.ts), where that applied. The line
 * states facts only: it neither hands the check to the owner nor promises anything the app will not do by itself.
 */
export function hostInternalFailureMessage(locale: "ko" | "en", resend: "now" | "spent" | "none" = "none"): string {
  if (resend === "now") {
    return locale === "ko"
      ? "앱 안에서 예상하지 못한 문제가 생겨 이번 실행을 끝내지 못했습니다. 요청은 저장되어 있고, 앱이 같은 요청을 스스로 한 번 더 보냅니다."
      : "Something unexpected happened inside the app, so this run could not finish. Your request is saved, and the app is sending it again by itself.";
  }
  if (resend === "spent") {
    return locale === "ko"
      ? "앱 안에서 예상하지 못한 문제가 생겨 이번 실행을 끝내지 못했습니다. 요청은 저장되어 있습니다. 앱이 다시 보냈지만 같은 문제가 났습니다. 효과를 확인할 수 없어 더 보내지 않습니다(같은 일이 두 번 실행되지 않도록). 요청과 지금까지의 진행은 이 대화에 남아 있습니다."
      : "Something unexpected happened inside the app, so this run could not finish. Your request is saved. The app already sent it again and it ended the same way. Its effect could not be confirmed, so it is not sent again (so the same action does not run twice). Your request and its progress so far stay in this conversation.";
  }
  return locale === "ko"
    ? "앱 안에서 예상하지 못한 문제가 생겨 이번 실행을 끝내지 못했습니다. 요청은 저장되어 있습니다. 효과를 확인할 수 없어 더 보내지 않습니다(같은 일이 두 번 실행되지 않도록). 요청과 지금까지의 진행은 이 대화에 남아 있습니다."
    : "Something unexpected happened inside the app, so this run could not finish. Your request is saved. Its effect could not be confirmed, so it is not sent again (so the same action does not run twice). Your request and its progress so far stay in this conversation.";
}

/**
 * The sentence for a store that stayed locked by another write (code store_busy), with the true thing about what happens next.
 * `beforeDispatch`: nothing reached the model. `resend` is the forecast of resend-forecast.ts: "now" = the app sends the same message again by
 * itself, "spent" = it already did once, "none" = nothing is sent automatically.
 */
export function storeLockedMessage(locale: "ko" | "en", beforeDispatch: boolean, resend: "now" | "spent" | "none" = "none"): string {
  const ko = locale === "ko";
  if (beforeDispatch) {
    return resend === "now"
      ? ko ? "Agentlas 저장소가 다른 기록으로 잠겨 있어 모델에 보내기 전에 멈췄습니다. 모델에는 아무것도 보내지 않았고, 앱이 같은 요청을 스스로 다시 보냅니다."
        : "The Agentlas store stayed locked by another write, so this turn stopped before anything was sent to the model. Nothing reached the model, and the app is sending it again by itself."
      : ko ? "Agentlas 저장소가 다른 기록으로 잠겨 있어 모델에 보내기 전에 멈췄습니다. 모델에는 아무것도 보내지 않았으니 다시 보내도 됩니다."
        : "The Agentlas store stayed locked by another write, so this turn stopped before anything was sent to the model. Nothing reached the model; it is safe to send again.";
  }
  if (resend === "now") {
    return ko ? "Agentlas 저장소가 다른 기록으로 잠겨 있어 이 턴을 끝까지 기록하지 못했습니다. 이미 실행됐을 수 있어, 앱이 같은 요청을 스스로 한 번 더 보내면서 앞선 시도가 일부 실행됐을 수 있다고 모델에 알립니다."
      : "The Agentlas store was locked by another write, so this turn could not be fully recorded. It may already have run, so the app is sending it once more by itself and telling the model the earlier attempt may have partly happened.";
  }
  if (resend === "spent") {
    return ko ? "Agentlas 저장소가 다른 기록으로 잠겨 있어 이 턴을 끝까지 기록하지 못했습니다. 이미 실행됐을 수 있습니다. 앱이 다시 보냈지만 같은 식으로 끝났습니다. 효과를 확인할 수 없어 더 보내지 않습니다(같은 일이 두 번 실행되지 않도록). 요청과 지금까지의 진행은 이 대화에 남아 있습니다."
      : "The Agentlas store was locked by another write, so this turn could not be fully recorded. It may already have run. The app already sent it again and it ended the same way. Its effect could not be confirmed, so it is not sent again (so the same action does not run twice). Your request and its progress so far stay in this conversation.";
  }
  return ko ? "Agentlas 저장소가 다른 기록으로 잠겨 있어 이 턴을 끝까지 기록하지 못했습니다. 이미 실행됐을 수 있어 자동으로 다시 보내지 않았습니다."
    : "The Agentlas store was locked by another write, so this turn could not be fully recorded. It may already have run, so it was not sent again automatically.";
}

/**
 * A working folder that is gone: a file-system error (ENOENT / ENOTDIR) on a path that is the chat's folder or inside it, while the folder
 * itself no longer exists. The folder was moved or deleted by the owner (a mobile folder under /tmp, a removed project), so the sentence is
 * "the working folder was not found", not "something unexpected happened inside the app" (2 runs). Platform fields only: the error's
 * `code` and `path` (own or on its cause chain) against the folder; no message text is read.
 */
export function isMissingWorkingFolderError(error: unknown, folder: string | null | undefined, exists: (candidate: string) => boolean,
  separator: string = "/"): boolean {
  if (!error || typeof error !== "object" || typeof folder !== "string" || !folder) return false;
  let present: boolean;
  try { present = exists(folder); } catch { return false; }
  if (present) return false;
  const root = folder.length > 1 && folder.endsWith(separator) ? folder.slice(0, -1) : folder;
  return causeChain(error).some((link) => {
    const code = dataProperty(link, "code");
    const where = dataProperty(link, "path");
    return (code === "ENOENT" || code === "ENOTDIR") && typeof where === "string" && (where === root || where.startsWith(root + separator));
  });
}

/** The sentence for a working folder that is gone: what happened, what to do, no path and no code. */
export function workingFolderMissingMessage(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "이 대화의 작업 폴더를 찾을 수 없어 실행하지 못했습니다. 폴더가 옮겨졌거나 지워졌는지 확인하고, 작업 폴더를 다시 지정한 뒤 같은 요청을 보내 주세요. 요청은 저장되어 있습니다."
    : "This chat's working folder was not found, so the run could not start. Check whether the folder was moved or deleted, set the working folder again, then send the same request. Your request is saved.";
}
