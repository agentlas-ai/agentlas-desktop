import type { AgentLeasePurchaseInput } from "../../shared/types";

/**
 * Marketplace settlement and paid Hub leases are permanently closed.
 * Keep these exported shapes for installed Desktop and Mobile bridge clients,
 * but never contact the old lease API or authorize a credit charge.
 */
export interface AgentLeaseQuote {
  ok: boolean;
  active: boolean;
  leasedUntil: string | null;
  perDayCredits: number | null;
  leaseOffered: boolean;
  code?: string;
  message?: string;
}

export type AgentLeasePurchaseResult =
  | { ok: true; leasedUntil: string; days: number; perDayCredits: number; chargedCredits: number }
  | { ok: false; code: string; needed?: number; have?: number; message: string };

export interface AgentLeaseRow {
  slug: string;
  leasedUntil: string;
}

export async function getAgentLeaseQuote(_slug: string): Promise<AgentLeaseQuote> {
  return {
    ok: false,
    active: false,
    leasedUntil: null,
    perDayCredits: null,
    leaseOffered: false,
    code: "marketplace_leases_retired",
    message: "Paid Hub leases are retired. Public Hub agents are free to use.",
  };
}

export async function purchaseAgentLease(_input: AgentLeasePurchaseInput): Promise<AgentLeasePurchaseResult> {
  return { ok: false, code: "marketplace_leases_retired", message: "Paid Hub leases are retired." };
}

export async function listAgentLeases(): Promise<AgentLeaseRow[]> {
  return [];
}

export function invalidateAgentLeaseCache(): void {
  // No lease cache remains after marketplace settlement closure.
}

export async function listAgentLeasesCached(): Promise<AgentLeaseRow[]> {
  return [];
}

export async function activeLeasedSlugs(): Promise<Set<string>> {
  return new Set();
}
