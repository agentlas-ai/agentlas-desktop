// "Give this agent a mailbox" — one state per server answer, each with its own
// next step. Owner report 2026-09-29 (desktop 1.2.50): the first-run mailbox
// card said "확인 필요" for four different machine states (not signed in, the
// server has not opened agent mail for the workspace, the status call failed,
// no IPC) and offered nothing to press. Every state below has a concrete label
// and exactly one next action; the kind is decided from machine fields
// (signedIn, unavailableCode, error code, entitlement numbers), never prose.
import type { AgentMailEntitlement, AgentMailMailbox, AgentMailStatus } from "./agent-mail";

export type AgentMailOffer =
  /** Status not read yet. */
  | { kind: "checking" }
  /** No Agentlas session → sign-in button. */
  | { kind: "sign-in" }
  /** Signed in, but the server has not opened agent mail for this workspace (not a plan question). */
  | { kind: "not-open"; code: "agent_mail_not_available" | "entitlement_unavailable" }
  /** Signed in, mail is open, the plan has no address → the plan picker (paywall). */
  | { kind: "plan-required"; entitlement: AgentMailEntitlement }
  /** Plan includes an address and none exists yet → choose the permanent address. */
  | { kind: "choose-address"; entitlement: AgentMailEntitlement }
  /** The server is still preparing the address → recheck. */
  | { kind: "provisioning"; mailbox: AgentMailMailbox; entitlement: AgentMailEntitlement | null }
  /** Preparation failed → retry the existing chosen address. */
  | { kind: "provisioning-failed"; mailbox: AgentMailMailbox; entitlement: AgentMailEntitlement | null }
  /** Address issued. `sendBlocked` = the plan has no recipient allowance (read-only mailbox). */
  | {
      kind: "active";
      mailbox: AgentMailMailbox;
      entitlement: AgentMailEntitlement | null;
      used: number;
      limit: number;
      remaining: number;
      exhausted: boolean;
      sendBlocked: boolean;
      /** Next reset (period end, ISO). null when the server did not say. */
      resetsAt: string | null;
    }
  /** The status call itself failed → reason code + retry. */
  | { kind: "error"; code: string };

export function agentMailOffer(status: AgentMailStatus | null | undefined): AgentMailOffer {
  if (status === undefined || status === null) return { kind: "checking" };
  if (!status.ok) {
    if (status.code === "sign_in_required") return { kind: "sign-in" };
    if (status.code === "agent_mail_not_available") return { kind: "not-open", code: "agent_mail_not_available" };
    return { kind: "error", code: status.code || "unknown" };
  }
  if (!status.signedIn) return { kind: "sign-in" };
  if (status.unavailableCode === "agent_mail_not_available") return { kind: "not-open", code: "agent_mail_not_available" };
  const entitlement = status.entitlement;
  const mailbox = status.mailbox && status.mailbox.status !== "deleted" ? status.mailbox : null;
  if (mailbox?.status === "provisioning-failed") return { kind: "provisioning-failed", mailbox, entitlement };
  if (mailbox?.status === "provisioning") return { kind: "provisioning", mailbox, entitlement };
  if (mailbox?.status === "active") {
    const limit = Math.max(0, entitlement?.monthlyRecipientLimit ?? 0);
    const used = Math.max(0, entitlement?.usedThisMonth ?? 0);
    const remaining = Math.max(0, entitlement?.remainingThisMonth ?? limit - used);
    return {
      kind: "active",
      mailbox,
      entitlement,
      used,
      limit,
      remaining,
      exhausted: limit > 0 && remaining <= 0,
      sendBlocked: !entitlement || !entitlement.mailbox.send || limit <= 0,
      resetsAt: entitlement?.period?.end ?? null,
    };
  }
  // Signed in with an answer that carries no entitlement: the server did not
  // say what the plan includes. Not a paywall (we do not know the plan).
  if (!entitlement) return { kind: "not-open", code: "entitlement_unavailable" };
  if (!entitlement.available) return { kind: "not-open", code: "agent_mail_not_available" };
  if (entitlement.addressLimit > 0) return { kind: "choose-address", entitlement };
  return { kind: "plan-required", entitlement };
}
