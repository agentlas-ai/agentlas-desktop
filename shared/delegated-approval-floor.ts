import { looksSecret } from "./secret-patterns";

/**
 * Approvals the personal agent may never pass on for the owner (design 2026-10-27 §4.4 "바닥"), whatever basis it
 * cites: the owner taps these cards themselves. Pure and structural: it reads typed fields the host wrote (browser
 * action type, the arbiter's capability class, a host-computed transaction-facts flag) and fixed shapes (credential
 * tool names, secret-shaped text). It never reads a model's judgment. Unknown means floor (fail closed).
 */
export type DelegationFloorCode =
  | "payment"
  | "credential"
  | "transaction_facts"
  | "delete"
  | "external_send"
  | "consent_boundary"
  | "risk_r3_plus"
  | "risk_unjudged";

export type DelegationFloorInput =
  | {
      kind: "tool";
      tool: string;
      /** capabilityClassFor() as the arbiter wrote it on the request (execute|edit|delete|network|other). */
      capability?: string | null;
      detail?: string | null;
      /** consentTransactionFacts() found a recipient or amount in the call (computed by the host caller). */
      transactionFacts?: boolean;
    }
  | {
      kind: "browser";
      /** browserRequestApproval's actionType ("payment" | "unsafe-code" | …). */
      actionType: string;
      summary?: string | null;
      target?: string | null;
    };

const KNOWN_TOOL_CAPABILITIES = new Set(["execute", "edit", "delete", "network", "other", "read"]);
/** Browser approvals that reach a card and are not a floor. Anything else that reaches one is unjudged. */
const DELEGABLE_BROWSER_ACTIONS = new Set(["unsafe-code"]);
/** A tool whose name says it handles credentials or sign-in (MCP names: mcp__server__tool, dotted operations). */
const CREDENTIAL_TOOL =
  /(?:^|[_\-.:/])(?:secret|secrets|credential|credentials|password|passwords|passwd|keychain|vault|api[_-]?keys?|tokens?|oauth|login|signin|sign[_-]in|auth|autofill|cookies?)(?:$|[_\-.:/])/i;
/**
 * A command or path that reads or writes stored credentials. Matched on the detail with `\` folded to `/` (credentialText),
 * so a Windows path (C:\Users\owner\.ssh\id_ed25519, %APPDATA%\Microsoft\Credentials\…) is the same shape as a POSIX one.
 */
const CREDENTIAL_DETAIL =
  /(?:^|[\s/"'=])(?:\.env(?:\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|id_rsa|id_ed25519|id_ecdsa|credentials(?:\.json)?|\.aws\/|\.ssh\/|\.gnupg\/|\.kube\/config|\.docker\/config\.json|keychain|security\s+(?:find|add|delete)-(?:generic|internet)-password)(?:$|[\s/"'])|\bmicrosoft\/(?:credentials|vault|protect)\/|\b(?:cmdkey|vaultcmd|get-storedcredential|get-credential)\b/i;

/** A shell command that removes files, history or data (exact command grammar, not request wording). */
const DELETE_COMMAND =
  /(?:^|[;&|(]\s*|\bsudo\s+|\bxargs\s+)(?:rm|rmdir|unlink|shred|srm|trash)(?:\s|$)|\bgit\s+(?:clean\b|branch\s+-D\b|push\b[^\n]*\s--delete\b|reset\s+--hard\b)|\bfind\b[^\n]*\s-delete\b|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i;
/**
 * The same for Windows (cmd and PowerShell): the cmdlets are unique names; cmd's `del`, `erase`, `rd`, `rmdir` and the
 * PowerShell aliases `ri` and `rm` count where a command can start (line start, after ; & | ( or a shell's /c, /k,
 * -Command switch, a quote). Wider than strictly needed on purpose: a false hit costs the owner one tap.
 */
const WINDOWS_DELETE_COMMAND =
  /\b(?:remove-item|remove-itemproperty|clear-recyclebin|remove-partition|clear-disk|format-volume|remove-localuser)\b|(?:^|[;&|(\s"'`])(?:del|erase|rd|rmdir|ri|rm|format|diskpart|cipher)(?:\s+\/[a-z]|\s|$)(?=[^\n]*(?:[\\/]|\s-?[a-z]|$))|\bcmd(?:\.exe)?\s+\/[ck]\s+(?:del|erase|rd|rmdir)\b/i;

/** The floor this approval falls under, or null when the owner's own message may be passed on for it. */
export function delegationFloor(input: DelegationFloorInput): DelegationFloorCode | null {
  if (input.kind === "browser") {
    const action = typeof input.actionType === "string" ? input.actionType.trim().toLowerCase() : "";
    if (action === "payment") return "payment";
    if (/credential|login|password|sign-?in|autofill/.test(action)) return "credential";
    const text = `${input.summary ?? ""}\n${input.target ?? ""}`;
    if (looksSecret(text)) return "credential";
    return DELEGABLE_BROWSER_ACTIONS.has(action) ? null : "risk_unjudged";
  }
  const tool = typeof input.tool === "string" ? input.tool : "";
  const detail = typeof input.detail === "string" ? input.detail : "";
  if (!tool) return "risk_unjudged";
  const credentialText = detail.replace(/\\/g, "/");
  if (CREDENTIAL_TOOL.test(tool) || looksSecret(detail) || CREDENTIAL_DETAIL.test(credentialText)) return "credential";
  if (input.transactionFacts === true) return "transaction_facts";
  const capability = typeof input.capability === "string" ? input.capability : "";
  if (capability === "delete" || DELETE_COMMAND.test(detail) || WINDOWS_DELETE_COMMAND.test(detail)) return "delete";
  if (!KNOWN_TOOL_CAPABILITIES.has(capability)) return "risk_unjudged";
  return null;
}
