"use client";

/*
 * "플랜 선택" / "Choose a plan" — the one paywall (owner 2026-09-29).
 *
 *   - Cards come from GET /api/billing/catalog in catalog order; no price is written here.
 *   - The modal never asks whether checkout is open before it shows. Only "Upgrade"
 *     asks /api/billing/config (billing.checkoutReadiness) and, when open, starts the
 *     web checkout. Closed/failed stays inline on that card; the modal stays open.
 *   - A catalog failure shows retry + web, never an empty modal.
 *   - The current plan (billing.getCredits().plan) gets an outlined card and a
 *     disabled "Current plan" button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { invalidateIpcCache } from "@/lib/ipc-cache";
import { useT } from "@/lib/i18n";
import type { BillingCheckoutReadiness, BillingPlanOffer } from "@/lib/types";
import { markPlanPickerHost, PLAN_PICKER_OPEN_EVENT, type PlanPickerRequest, type PlanPickerSource } from "@/lib/plan-picker";
import styles from "./PlanPickerModal.module.css";

export const PRICING_PAGE_URL = "https://agentlas.cloud/pricing";
/** Fired after a checkout is confirmed so plan-gated surfaces (mail, credits) re-read. */
export const PLAN_CHANGED_EVENT = "agentlas:plan-changed";

type Cycle = "monthly" | "annual";
type CardCheckout =
  | { state: "checking" }
  | { state: "opened" }
  | { state: "verifying" }
  | { state: "confirmed" }
  | { state: "still-same" }
  | { state: "closed"; code: string }
  | { state: "failed"; code: string };

const CHECKOUT_PLANS = new Set(["pro", "max", "wow"]);

function makeCopy(ko: boolean) {
  return ko ? {
    title: "플랜 선택",
    close: "닫기",
    monthly: "월간",
    annual: (months: number) => (months > 0 ? `연간 (${months}개월 무료)` : "연간"),
    perMonth: "/ 월",
    forever: "/ 평생",
    billedYearly: (price: string) => `연 ${price} 청구`,
    current: "현재 플랜",
    freeNote: "무료로 시작, 언제든 업그레이드",
    upgrade: "업그레이드",
    included: "포함됨",
    recommended: "추천",
    soon: "곧 출시",
    everything: (name: string) => `${name}의 모든 기능`,
    credits: (n: string) => `월 ${n} AI 크레딧`,
    cloud: (n: string) => `Cloud 에이전트 ${n}개 보관`,
    mail: (addresses: string, recipients: string) => `에이전트 전용 메일 주소 ${addresses}개 · 월 ${recipients}명 발송`,
    alive: "Alive 에이전트 (스스로 깨어나 일함)",
    byo: "내 AI 구독 연결 · 로컬 실행",
    loading: "요금제를 불러오는 중…",
    loadFailed: "요금제를 불러오지 못했어요.",
    retry: "다시 시도",
    openWeb: "웹에서 보기",
    checking: "결제 준비를 확인하는 중…",
    opened: "브라우저에서 결제를 마친 뒤 돌아와 주세요.",
    verify: "결제 확인",
    verifying: "결제를 확인하는 중…",
    confirmed: (name: string) => `${name} 플랜이 적용됐어요.`,
    stillSame: "아직 바뀐 플랜이 없어요. 결제를 마쳤다면 잠시 뒤 다시 확인해 주세요.",
    closed: "지금은 결제를 열 수 없습니다 — 잠시 후 다시 시도해 주세요.",
    notOffered: "이 플랜은 지금 판매하지 않아요.",
    failed: "결제 상태를 확인하지 못했어요 — 연결을 확인한 뒤 다시 시도해 주세요.",
    taglines: {
      free: "가볍게 시작하기",
      pro: "매일 쓰는 분께",
      max: "많이 돌리는 분께",
      wow: "가장 큰 한도",
    } as Record<string, string>,
  } : {
    title: "Choose a plan",
    close: "Close",
    monthly: "Monthly",
    annual: (months: number) => (months > 0 ? `Yearly (${months} months free)` : "Yearly"),
    perMonth: "/ month",
    forever: "/ forever",
    billedYearly: (price: string) => `${price} billed yearly`,
    current: "Current plan",
    freeNote: "Start free, upgrade anytime",
    upgrade: "Upgrade",
    included: "Included",
    recommended: "Recommended",
    soon: "Coming soon",
    everything: (name: string) => `Everything in ${name}`,
    credits: (n: string) => `${n} AI credits / month`,
    cloud: (n: string) => `Keep ${n} Cloud agents`,
    mail: (addresses: string, recipients: string) => `${addresses} agent mail address · ${recipients} recipients / month`,
    alive: "Alive agent (wakes up and works on its own)",
    byo: "Connect your own AI · local runs",
    loading: "Loading plans…",
    loadFailed: "Could not load plans.",
    retry: "Try again",
    openWeb: "Open on the web",
    checking: "Checking checkout…",
    opened: "Finish checkout in your browser, then come back.",
    verify: "Check payment",
    verifying: "Checking payment…",
    confirmed: (name: string) => `You're on ${name} now.`,
    stillSame: "Your plan has not changed yet. If you finished checkout, check again in a moment.",
    closed: "Checkout can't open right now — please try again shortly.",
    notOffered: "This plan is not on sale right now.",
    failed: "Couldn't check checkout — check your connection and try again.",
    taglines: {
      free: "Get started",
      pro: "For everyday use",
      max: "For heavy workloads",
      wow: "The largest limits",
    } as Record<string, string>,
  };
}

/** Months free when paying yearly, from the catalog's own prices (smallest across paid plans, never overclaimed). */
export function annualMonthsFree(plans: BillingPlanOffer[]): number {
  const values = plans
    .filter((plan) => plan.priceMonthly > 0 && plan.priceAnnual > 0)
    .map((plan) => Math.floor((plan.priceMonthly * 12 - plan.priceAnnual) / plan.priceMonthly + 1e-9));
  if (!values.length) return 0;
  return Math.max(0, Math.min(...values));
}

export function PlanPickerModal({ open, source, onClose }: { open: boolean; source: PlanPickerSource; onClose: () => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const copy = useMemo(() => makeCopy(ko), [ko]);
  const api = ipc();
  const [plans, setPlans] = useState<BillingPlanOffer[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<string | null>(null);
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [checkout, setCheckout] = useState<Record<string, CardCheckout>>({});
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pendingPlanRef = useRef<string | null>(null);

  const loadPlans = useCallback(async () => {
    setLoadFailed(false);
    setPlans(null);
    const catalog = await api?.billing.getPlans?.().catch(() => null);
    if (catalog && catalog.ok && catalog.plans.length) setPlans(catalog.plans);
    else setLoadFailed(true);
  }, [api]);

  const loadCurrent = useCallback(async (fresh = false) => {
    if (fresh) invalidateIpcCache("billing");
    const balance = await api?.billing.getCredits().catch(() => null);
    const plan = balance && balance.authenticated && !balance.error && typeof balance.plan === "string" ? balance.plan : null;
    setCurrentPlan(plan);
    return plan;
  }, [api]);

  useEffect(() => {
    if (!open) return;
    setCheckout({});
    void loadPlans();
    void loadCurrent();
  }, [open, loadPlans, loadCurrent]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const verify = useCallback(async (planId: string) => {
    setCheckout((prev) => ({ ...prev, [planId]: { state: "verifying" } }));
    const plan = await loadCurrent(true);
    if (plan === planId) {
      setCheckout((prev) => ({ ...prev, [planId]: { state: "confirmed" } }));
      pendingPlanRef.current = null;
      window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT, { detail: { plan } }));
    } else {
      setCheckout((prev) => ({ ...prev, [planId]: { state: "still-same" } }));
    }
  }, [loadCurrent]);

  // Coming back from the browser after checkout re-reads the plan once.
  useEffect(() => {
    if (!open) return;
    const onFocus = () => { const planId = pendingPlanRef.current; if (planId) void verify(planId); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, verify]);

  const upgrade = async (plan: BillingPlanOffer) => {
    setCheckout((prev) => ({ ...prev, [plan.id]: { state: "checking" } }));
    const readiness: BillingCheckoutReadiness | null = api?.billing.checkoutReadiness
      ? await api.billing.checkoutReadiness({ plan: plan.id, cycle }).catch(() => null)
      : null;
    if (!readiness || !readiness.ok) {
      setCheckout((prev) => ({ ...prev, [plan.id]: { state: "failed", code: readiness && !readiness.ok ? readiness.error : "unavailable" } }));
      return;
    }
    if (!readiness.open || !CHECKOUT_PLANS.has(plan.id)) {
      setCheckout((prev) => ({ ...prev, [plan.id]: { state: "closed", code: readiness.code ?? "checkout_not_configured" } }));
      return;
    }
    pendingPlanRef.current = plan.id;
    window.open(`${PRICING_PAGE_URL}?checkoutPlan=${encodeURIComponent(plan.id)}&cycle=${cycle}`, "_blank", "noopener,noreferrer");
    setCheckout((prev) => ({ ...prev, [plan.id]: { state: "opened" } }));
  };

  if (!open) return null;

  const num = (n: number) => n.toLocaleString(ko ? "ko-KR" : "en-US");
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const monthsFree = plans ? annualMonthsFree(plans) : 0;
  // Signed out or no plan reported = the free plan (nobody pays by default).
  const effectiveCurrent = currentPlan ?? plans?.find((plan) => plan.priceMonthly === 0 && plan.priceAnnual === 0)?.id ?? null;
  const currentIndex = plans && effectiveCurrent ? plans.findIndex((plan) => plan.id === effectiveCurrent) : -1;

  return (
    <div className={styles.scrim} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} data-plan-picker data-plan-picker-source={source}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="plan-picker-title">
        <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label={copy.close}>×</button>
        <h2 id="plan-picker-title" className={styles.title}>{copy.title}</h2>

        {plans && (
          <div className={styles.cycle} role="radiogroup" aria-label={copy.title}>
            {(["monthly", "annual"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={cycle === value}
                data-selected={cycle === value}
                onClick={() => { setCycle(value); setCheckout({}); }}
              >
                {value === "monthly" ? copy.monthly : copy.annual(monthsFree)}
              </button>
            ))}
          </div>
        )}

        {!plans && !loadFailed && <p className={styles.status} role="status">{copy.loading}</p>}
        {loadFailed && (
          <div className={styles.failed} role="alert" data-plan-picker-failed>
            <p>{copy.loadFailed}</p>
            <div className={styles.failedActions}>
              <button type="button" className={styles.primary} onClick={() => void loadPlans()}>{copy.retry}</button>
              <button type="button" className={styles.secondary} onClick={() => window.open(PRICING_PAGE_URL, "_blank", "noopener,noreferrer")}>{copy.openWeb}</button>
            </div>
          </div>
        )}

        {plans && (
          <div className={styles.grid} style={{ ["--plan-count" as string]: String(plans.length) }}>
            {plans.map((plan, index) => {
              const isCurrent = plan.id === effectiveCurrent;
              const below = currentIndex >= 0 && index < currentIndex;
              const free = plan.priceMonthly === 0 && plan.priceAnnual === 0;
              const soon = new Set(plan.comingSoon ?? []);
              const previous = index > 0 ? plans[index - 1] : null;
              const price = free ? 0 : cycle === "annual" ? plan.priceAnnual / 12 : plan.priceMonthly;
              const state = checkout[plan.id];
              const features: Array<{ key: string; text: string }> = [];
              if (previous) features.push({ key: "everything", text: copy.everything(previous.name) });
              features.push({ key: "credits", text: copy.credits(num(plan.monthlyCredits)) });
              features.push({ key: "cloud", text: copy.cloud(num(plan.cloudAgentLimit)) });
              if ((plan.agentMailAddresses ?? 0) > 0) {
                features.push({ key: "agentMail", text: copy.mail(num(plan.agentMailAddresses ?? 0), num(plan.agentMailMonthlyRecipients ?? 0)) });
              }
              if (plan.aliveAgent) features.push({ key: "aliveAgent", text: copy.alive });
              if (free) features.push({ key: "byo", text: copy.byo });
              return (
                <section
                  key={plan.id}
                  className={styles.card}
                  data-plan={plan.id}
                  data-current={isCurrent || undefined}
                  data-highlighted={plan.highlighted || undefined}
                  aria-label={plan.name}
                >
                  <header className={styles.cardHead}>
                    <h3>{plan.name}</h3>
                    {plan.highlighted && !isCurrent && <span className={styles.badge}>{copy.recommended}</span>}
                  </header>
                  <p className={styles.tagline}>{plan.tagline || copy.taglines[plan.id] || ""}</p>
                  <div className={styles.price}>
                    <strong>{money(Math.round(price * 100) / 100)}</strong>
                    <span>{free ? copy.forever : copy.perMonth}</span>
                  </div>
                  <p className={styles.billed}>{!free && cycle === "annual" ? copy.billedYearly(money(plan.priceAnnual)) : " "}</p>
                  {isCurrent ? (
                    <button type="button" className={styles.currentButton} disabled data-plan-action="current">{copy.current}</button>
                  ) : below || free ? (
                    <button type="button" className={styles.currentButton} disabled data-plan-action="included">{copy.included}</button>
                  ) : (
                    <button
                      type="button"
                      className={styles.upgrade}
                      onClick={() => void upgrade(plan)}
                      disabled={state?.state === "checking" || state?.state === "verifying"}
                      data-plan-action="upgrade"
                    >
                      {copy.upgrade}
                    </button>
                  )}
                  {isCurrent && free && <small className={styles.freeNote}>{copy.freeNote}</small>}
                  {state && (
                    <div
                      className={styles.inline}
                      role={state.state === "closed" || state.state === "failed" ? "alert" : "status"}
                      data-plan-checkout={state.state}
                      data-code={"code" in state ? state.code : undefined}
                      data-tone={state.state === "closed" || state.state === "failed" ? "warn" : state.state === "confirmed" ? "ok" : undefined}
                    >
                      <span>
                        {state.state === "checking" && copy.checking}
                        {state.state === "opened" && copy.opened}
                        {state.state === "verifying" && copy.verifying}
                        {state.state === "confirmed" && copy.confirmed(plan.name)}
                        {state.state === "still-same" && copy.stillSame}
                        {state.state === "closed" && (state.code === "plan_not_offered" ? copy.notOffered : copy.closed)}
                        {state.state === "failed" && copy.failed}
                      </span>
                      {(state.state === "opened" || state.state === "still-same") && (
                        <button type="button" className={styles.linkButton} onClick={() => void verify(plan.id)}>{copy.verify}</button>
                      )}
                      {(state.state === "closed" || state.state === "failed") && (
                        <button type="button" className={styles.linkButton} onClick={() => void upgrade(plan)}>{copy.retry}</button>
                      )}
                    </div>
                  )}
                  <ul className={styles.features}>
                    {features.map((feature) => (
                      <li key={feature.key} data-feature={feature.key}>
                        <span className={styles.check} aria-hidden="true">✓</span>
                        <span>{feature.text}</span>
                        {soon.has(feature.key) && <span className={styles.soon}>{copy.soon}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mounted once (root layout). Opens on PLAN_PICKER_OPEN_EVENT from any entry point. */
export function PlanPickerHost() {
  const [request, setRequest] = useState<PlanPickerRequest | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<PlanPickerRequest>).detail;
      setRequest({ source: detail?.source ?? "other" });
    };
    window.addEventListener(PLAN_PICKER_OPEN_EVENT, onOpen);
    markPlanPickerHost(true);
    return () => {
      window.removeEventListener(PLAN_PICKER_OPEN_EVENT, onOpen);
      markPlanPickerHost(false);
    };
  }, []);
  const close = useCallback(() => setRequest(null), []);
  return <PlanPickerModal open={request !== null} source={request?.source ?? "other"} onClose={close} />;
}
