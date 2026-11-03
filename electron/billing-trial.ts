// Paywall helper: "can this signed-in account start the Pro trial?" — asked of the server, never guessed.
//
// `billing:checkoutReadiness` (billing.ts) is a public, cookie-less read of `/api/billing/config`; the web
// leaves `automaticPromotion` out of that answer for Pro monthly because it cannot tell whose request it is.
// The first-run paywall needs the account-aware answer, so this module asks the same URL once more with the
// session cookie and parses only the fields the paywall may state (shared/billing-paywall.ts).
//
// A missing cookie, a failed request, an older web without the field, or a changed shape all give `null`,
// which the screen reads as "no trial wording, ordinary price". It never blocks the readiness answer.
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "./auth";
import { getBillingCheckoutReadiness } from "./billing";
import type { BillingCheckoutReadiness } from "../shared/types";
import { parseAutomaticPromotion, type PaywallTrialOffer } from "../shared/billing-paywall";

const TIMEOUT_MS = 8000;

export async function readAccountTrialOffer(): Promise<PaywallTrialOffer | null> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return null;
  try {
    const res = await fetchWithHubSession(cookie, `${webBaseUrl()}/api/billing/config?plan=pro&cycle=monthly`, { headers: { Accept: "application/json" } }, TIMEOUT_MS);
    if (!res.ok) return null;
    const body = (await res.json()) as { automaticPromotion?: unknown };
    return parseAutomaticPromotion(body?.automaticPromotion);
  } catch {
    return null;
  }
}

/**
 * Handler for `billing:checkoutReadiness`. Without `withAccountTrial` it is exactly getBillingCheckoutReadiness
 * (the plan picker, the app-control route and older renderers see no change). With it — only the first-run
 * paywall sends it — a Pro monthly answer also carries `trial` when the server offered this account one.
 * The declared type stays BillingCheckoutReadiness so the generated app-control contracts do not move.
 */
export async function getBillingCheckoutReadinessForPaywall(input: { plan?: unknown; cycle?: unknown }): Promise<BillingCheckoutReadiness> {
  const base = await getBillingCheckoutReadiness(input);
  const wantsTrial = (input as { withAccountTrial?: unknown } | null | undefined)?.withAccountTrial === true;
  if (!wantsTrial || !base.ok || base.plan !== "pro" || base.cycle !== "monthly") return base;
  const trial = await readAccountTrialOffer();
  return trial ? ({ ...base, trial } as BillingCheckoutReadiness) : base;
}
