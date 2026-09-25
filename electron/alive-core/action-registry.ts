/**
 * Alive action registry — the generalized replacement for Science's single hard-coded action kind
 * (agentlas-science contracts.ts:26-39, lifetime-store.ts validAction/claimAction).
 *
 * Each playground port registers the action kinds it can execute: "<family>.<verb>" (e.g. goal.continue),
 * the domains whose attachments may carry it, and an exact validator for the `expected` fence. The store
 * accepts a model decision only when its action kind is registered and its fence validates; the service
 * offers a capability only to an attachment whose domain registered it. A capability is a proposal route,
 * never a permission grant: the playground re-verifies the fence against current state before any effect.
 */
import type { AliveActionProposal } from "./contracts";

export interface AliveActionRegistration {
  /** "<family>.<verb>", lowercase. */
  kind: string;
  /** Attachment domains that may carry this action (the playground ports that execute it). */
  domains: readonly string[];
  /** Exact key set of the `expected` fence. */
  expectedKeys: readonly string[];
  /** Value validation of the fence; keys were already checked to be exactly expectedKeys. */
  validateExpected(expected: Record<string, unknown>): boolean;
}

const KIND = /^[a-z][a-z0-9_]{1,40}\.[a-z][a-z0-9_]{1,40}$/;
const registrations = new Map<string, AliveActionRegistration>();

export function registerAliveAction(registration: AliveActionRegistration): () => void {
  if (!KIND.test(registration.kind) || registration.domains.length === 0
    || registration.expectedKeys.length === 0 || typeof registration.validateExpected !== "function") {
    throw new Error("alive-action-registration-invalid");
  }
  const existing = registrations.get(registration.kind);
  if (existing && existing !== registration) throw new Error("alive-action-already-registered");
  const frozen = Object.freeze({ ...registration, domains: Object.freeze([...registration.domains]),
    expectedKeys: Object.freeze([...registration.expectedKeys].sort()) });
  registrations.set(registration.kind, frozen);
  return () => { if (registrations.get(registration.kind) === frozen) registrations.delete(registration.kind); };
}

export function aliveActionRegistration(kind: unknown): AliveActionRegistration | null {
  return typeof kind === "string" ? registrations.get(kind) ?? null : null;
}

/** Action kinds an attachment of this domain can propose. */
export function aliveActionKindsForDomain(domain: string): string[] {
  return [...registrations.values()].filter((entry) => entry.domains.includes(domain)).map((entry) => entry.kind).sort();
}

/** Exact structural validation; a model-forged extra key or wrong shape is rejected, never repaired. */
export function validAliveAction(value: unknown): value is AliveActionProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (Object.keys(action).sort().join("|") !== "attachmentId|expected|kind"
    || typeof action.attachmentId !== "string" || !action.attachmentId || action.attachmentId.length > 200) return false;
  const registration = aliveActionRegistration(action.kind);
  if (!registration) return false;
  const expected = action.expected;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const row = expected as Record<string, unknown>;
  if (Object.keys(row).sort().join("|") !== registration.expectedKeys.join("|")) return false;
  try { return registration.validateExpected(row) === true; } catch { return false; }
}

/** Test-only: forget registrations between isolated contract runs. */
export function resetAliveActionRegistryForTest(): void { registrations.clear(); }
