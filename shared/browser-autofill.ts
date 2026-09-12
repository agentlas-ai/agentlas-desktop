import type { BrowserUiTarget } from "./browser-ui";

export const BROWSER_AUTOFILL_SCHEMA_VERSION = "agentlas.browser-autofill.v1" as const;

export type BrowserAutofillReason =
  | "invalid-request"
  | "vault-unavailable"
  | "vault-corrupt"
  | "item-not-found"
  | "origin-mismatch"
  | "guest-unavailable"
  | "guest-changed"
  | "user-confirmation-required"
  | "operation-failed";

export interface BrowserAutofillResult {
  ok: boolean;
  reason?: BrowserAutofillReason;
}

export interface BrowserCredentialMetadata {
  id: string;
  label: string;
  origin: string;
  maskedUsername: string | null;
  hasPassword: boolean;
  updatedAt: string;
}

export type BrowserContactField =
  | "name"
  | "email"
  | "phone"
  | "organization"
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "region"
  | "postalCode"
  | "country";

export type BrowserContactValues = Partial<Record<BrowserContactField, string>>;

export interface BrowserContactMetadata {
  id: string;
  label: string;
  availableFields: BrowserContactField[];
  maskedEmail: string | null;
  maskedPhone: string | null;
  updatedAt: string;
}

export interface BrowserAutofillSnapshot {
  schemaVersion: typeof BROWSER_AUTOFILL_SCHEMA_VERSION;
  state: "ready" | "unavailable";
  credentials: BrowserCredentialMetadata[];
  contacts: BrowserContactMetadata[];
  reason?: "vault-unavailable" | "vault-corrupt";
}

export interface BrowserAutofillAPI {
  snapshot: () => Promise<BrowserAutofillSnapshot>;
  saveCredential: (input: {
    id?: string;
    origin: string;
    label: string;
    username: string;
    password: string;
  }) => Promise<BrowserAutofillResult & { credential?: BrowserCredentialMetadata }>;
  removeCredential: (input: { id: string }) => Promise<BrowserAutofillResult>;
  saveContact: (input: {
    id?: string;
    label: string;
    fields: BrowserContactValues;
  }) => Promise<BrowserAutofillResult & { contact?: BrowserContactMetadata }>;
  removeContact: (input: { id: string }) => Promise<BrowserAutofillResult>;
  fillCredential: (input: BrowserUiTarget & {
    credentialId: string;
    userConfirmed: true;
  }) => Promise<BrowserAutofillResult & {
    filled?: { username: boolean; password: boolean };
    document?: { webContentsId: number; navigationEpoch: number };
  }>;
  fillContact: (input: BrowserUiTarget & {
    contactId: string;
    userConfirmed: true;
  }) => Promise<BrowserAutofillResult & {
    filledFields?: BrowserContactField[];
    document?: { webContentsId: number; navigationEpoch: number };
  }>;
}
