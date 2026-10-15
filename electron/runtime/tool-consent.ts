import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** Main-only exact material. Values never enter the approval UI or grant row. */
export function mainToolConsentDigest(material: unknown): string {
  return createHash("sha256").update("agentlas-main-tool-consent-v2\0")
    .update(JSON.stringify(canonical(material))).digest("hex");
}

const resources = new WeakMap<object, string>();

/** A serialized ask or caller-supplied consentBinding cannot mint this value. */
export function bindMainToolConsentResource(ask: object, material: unknown): void {
  resources.set(ask, mainToolConsentDigest(material));
}

export function mainToolConsentResource(ask: object): string | undefined {
  return resources.get(ask);
}

const RECIPIENT_KEYS = new Set([
  "to", "cc", "bcc", "recipient", "recipients", "receiver", "email", "address", "phone", "number",
  "channel", "chat_id", "chatid", "user_id", "userid", "payee", "beneficiary", "destination",
  "account", "account_id", "iban", "wallet", "target_user", "reply_to",
]);
const AMOUNT_KEYS = new Set([
  "amount", "price", "total", "cost", "sum", "value_amount", "payment_amount", "quantity", "qty", "currency",
]);

/**
 * The recipient/amount facts of a send/pay-class call, taken from the call's own
 * arguments (top level and one object level down). A different recipient or
 * amount must never reuse an approval, so these enter the resource identity even
 * when the display detail does not mention them. Returns undefined when absent.
 */
export function consentTransactionFacts(args: unknown): { recipient?: unknown; amount?: unknown } | undefined {
  const recipient: Record<string, unknown> = {};
  const amount: Record<string, unknown> = {};
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return;
    for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (item === undefined || item === null) continue;
      if (RECIPIENT_KEYS.has(key)) recipient[`${depth}:${key}`] = item;
      else if (AMOUNT_KEYS.has(key)) amount[`${depth}:${key}`] = item;
      else if (typeof item === "object") visit(item, depth + 1);
    }
  };
  visit(args, 0);
  const hasRecipient = Object.keys(recipient).length > 0;
  const hasAmount = Object.keys(amount).length > 0;
  if (!hasRecipient && !hasAmount) return undefined;
  return { ...(hasRecipient ? { recipient: canonical(recipient) } : {}), ...(hasAmount ? { amount: canonical(amount) } : {}) };
}
