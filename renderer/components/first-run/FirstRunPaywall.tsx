"use client";

/*
* First-run paywall (Desktop).
 *
 * Where: right after sign-in, before the first-run steps — AuthGate has already signed the person in when
 * FirstRunGate mounts, so "after sign-in" is "before step 02". FirstRunGate wraps its content in
 * <FirstRunPaywallLayer/>; that is the only wiring.
 *
 * What it does, in the order the person meets it:
 *   1. Reads the account's plan from the server (billing.getCredits). A paid account skips this screen.
 *      A signed-out answer skips it too. A failed read is NOT "Free": the screen says it could not check,
 *      offers "Try again" and "Continue with Free", and records nothing, so a later launch asks again.
 *   2. Free account: shows the server's plan catalog (billing.getPlans) — Pro preselected and marked
 *      "Recommended", Max and WoW as the other rows. No price or allowance is written here.
 *   3. A trial is named only if the server says this account can start it (billing.checkoutReadiness with
 *      withAccountTrial → `trial`). Without the field the screen shows the ordinary monthly price.
 *   4. "Continue with Free" is the same size as the buy button, always visible, and is also what the close
 *      button and Escape do.
 *   5. Buying opens the web checkout in the external browser (the same URL as the plan picker). The screen
 *      then asks the server — on a timer with an upper bound, and again when the window regains focus —
 *      and shows "confirmed" only when the server reports a paid plan. It can be cancelled at any time.
 *
 * Once per account: the outcome is stored under agentlas.desktop.firstRunPaywall.v1:<account>. The plan
 * picker (Settings → Plan, or any "see plans" entry) stays the way back to plans later.
 *
 * No cloud computer / VM wording: that product is paused. Plan value is only what the catalog states.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ipc } from "@/lib/ipc";
import { invalidateIpcCache } from "@/lib/ipc-cache";
import { useT } from "@/lib/i18n";
import type { BillingPlanOffer } from "@/lib/types";
import { PLAN_CHANGED_EVENT, PRICING_PAGE_URL } from "@/lib/plan-picker";
import {
  classifyAccountPlan,
  pollForSubscription,
  readPaywallRecord,
  readTrialField,
  writePaywallRecord,
  type PaywallOutcome,
  type PaywallTrialOffer,
} from "@shared/billing-paywall";
import base from "./FirstRun.module.css";
import styles from "./FirstRunPaywall.module.css";

const CHECKOUT_PLANS = new Set(["pro", "max", "wow"]);
const RECOMMENDED_PLAN = "pro";
const LEGAL_LINKS = {
  manage: `${PRICING_PAGE_URL.replace(/\/pricing$/, "")}/account`,
  terms: `${PRICING_PAGE_URL.replace(/\/pricing$/, "")}/docs/legal/terms`,
  privacy: `${PRICING_PAGE_URL.replace(/\/pricing$/, "")}/docs/legal/privacy`,
  refund: `${PRICING_PAGE_URL.replace(/\/pricing$/, "")}/docs/legal/refund`,
} as const;

type ReadinessInput = { plan: string; cycle: "monthly" | "annual"; withAccountTrial?: boolean };
type ReadinessProbe = (input: ReadinessInput) => Promise<{ ok: boolean; open?: boolean; code?: string | null; error?: string } | null>;

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "choose" }
  | { kind: "waiting"; planId: string; status: "polling" | "timeout"; unreachable: boolean }
  | { kind: "confirmed"; plan: string };

type Inline = null | { kind: "checking" } | { kind: "closed"; code: string } | { kind: "failed" };

function makeCopy(ko: boolean) {
  return ko ? {
    close: "닫고 Free로 계속",
    titleChoose: "플랜 선택",
    titleTrial: (days: number) => `Pro ${days}일 무료 체험`,
    lead: "플랜을 고르거나, 결제 없이 Free로 바로 시작하세요.",
    plansLabel: "플랜",
    recommended: "추천",
    trialTag: (days: number) => `${days}일 무료`,
    perMonth: "/월",
    credits: (n: string) => `월 ${n} AI 크레딧`,
    alive: "Alive 에이전트",
    mail: (n: string) => `에이전트 메일 ${n}개`,
    soon: "곧 출시",
    freeNote: (credits: string | null) => `Free는 결제 없이 쓰는 플랜입니다${credits ? ` (월 ${credits} AI 크레딧)` : ""}. 내 AI 구독 연결과 로컬 실행도 Free에서 그대로 쓸 수 있어요.`,
    scheduleTitle: "무료 체험 일정",
    sToday: "오늘",
    sTodayCard: (zero: string) => `체험 시작 · 카드 등록 필요 · 오늘 결제 금액 ${zero}`,
    sTodayNoCard: "체험 시작 · 카드 없이 시작",
    sEnd: (days: number) => `${days}일 뒤`,
    sEndCharge: (price: string) => `월 ${price} 자동 결제가 시작되고, 이후 매월 갱신됩니다`,
    sEndNoCard: "체험이 끝납니다. 계속 쓰려면 그때 구독을 시작하세요",
    sCancel: "해지",
    sCancelText: (days: number) => `${days}일이 지나기 전에 웹 계정 페이지의 ‘결제 관리 열기’에서 해지하면 결제되지 않습니다`,
    legalTitle: "구독 안내",
    legalBody: "결제는 브라우저에서 Agentlas 웹 결제 페이지로 진행됩니다. 구독은 매월 같은 금액으로 자동 갱신되고, 최종 금액과 세금은 결제 페이지에 표시됩니다. 갱신을 멈추려면 웹 계정 페이지의 ‘결제 관리 열기’에서 해지하세요.",
    lManage: "결제 관리",
    lTerms: "이용약관",
    lPrivacy: "개인정보 처리방침",
    lRefund: "환불 정책",
    ctaTrial: (days: number) => `${days}일 무료로 시작`,
    ctaPaid: (name: string, price: string) => `${name} 시작 · ${price}/월`,
    ctaChecking: "결제 준비 확인 중…",
    ctaFree: "Free로 계속",
    dockTrial: (days: number, price: string) => `${days}일 무료, 이후 월 ${price} 자동 결제. 체험 기간 안에 해지하면 결제되지 않습니다.`,
    dockTrialNoCard: (days: number) => `${days}일 무료, 카드 등록 없이 시작합니다.`,
    dockPaid: (price: string) => `${price}/월 구독이 매월 자동 갱신됩니다. 웹 계정 페이지의 ‘결제 관리 열기’에서 해지할 수 있습니다.`,
    errClosed: "지금은 결제를 열 수 없어요. 잠시 뒤 다시 시도하거나 Free로 계속하세요.",
    errNotOffered: "이 플랜은 지금 판매하지 않아요. 다른 플랜을 고르거나 Free로 계속하세요.",
    errFailed: "결제 준비를 확인하지 못했어요. 연결을 확인하고 다시 시도하세요.",
    loadingTitle: "플랜을 확인하는 중",
    loadingLead: "계정의 구독 상태를 서버에서 읽고 있어요.",
    loadingStatus: "확인하는 중…",
    unavailTitle: "플랜 정보를 불러오지 못했어요",
    unavailLead: "연결을 확인하고 다시 시도하세요. 지금은 Free로 계속 쓸 수 있고, 플랜은 설정에서 나중에 고를 수 있어요.",
    retry: "다시 시도",
    waitTitle: "브라우저에서 결제를 마치세요",
    waitLead: "결제를 마친 뒤 이 창으로 돌아오세요. 서버가 구독을 확인하면 자동으로 이어집니다.",
    waitPolling: "서버에서 구독을 확인하는 중…",
    waitTimeout: "아직 구독이 확인되지 않았어요. 결제를 마쳤다면 잠시 뒤 ‘지금 확인’을 눌러 주세요.",
    waitUnreachable: "서버에 연결하지 못했어요. 연결을 확인한 뒤 ‘지금 확인’을 눌러 주세요.",
    checkNow: "지금 확인",
    pickAgain: "플랜 다시 고르기",
    doneTitle: "구독이 확인됐어요",
    doneLead: (name: string) => `서버가 ${name} 플랜을 확인했어요. 체험 적용 여부와 다음 결제일은 웹 계정 페이지에서 볼 수 있어요.`,
    doneContinue: "계속",
  } : {
    close: "Close and continue with Free",
    titleChoose: "Choose a plan",
    titleTrial: (days: number) => `Try Pro free for ${days} days`,
    lead: "Pick a plan, or start right away with Free and no payment.",
    plansLabel: "Plans",
    recommended: "Recommended",
    trialTag: (days: number) => `${days} days free`,
    perMonth: "/mo",
    credits: (n: string) => `${n} AI credits / month`,
    alive: "Alive agent",
    mail: (n: string) => `${n} agent mail address${n === "1" ? "" : "es"}`,
    soon: "Coming soon",
    freeNote: (credits: string | null) => `Free needs no payment${credits ? ` and includes ${credits} AI credits a month` : ""}. Connecting your own AI subscription and running locally also work on Free.`,
    scheduleTitle: "Your trial schedule",
    sToday: "Today",
    sTodayCard: (zero: string) => `Trial starts · card required · charged today: ${zero}`,
    sTodayNoCard: "Trial starts · no card needed",
    sEnd: (days: number) => `In ${days} days`,
    sEndCharge: (price: string) => `${price} a month is charged automatically, then every month`,
    sEndNoCard: "The trial ends. Start a subscription then if you want to keep going",
    sCancel: "Cancel",
    sCancelText: (days: number) => `Cancel with ‘Open billing portal’ on the web Account page before the ${days} days are over and you are not charged`,
    legalTitle: "Subscription terms",
    legalBody: "Payment happens in your browser on the Agentlas web checkout. The subscription renews automatically each month at the same price, and the final amount and taxes are shown on the checkout page. To stop renewal, cancel with ‘Open billing portal’ on the web Account page.",
    lManage: "Billing portal",
    lTerms: "Terms of Use",
    lPrivacy: "Privacy Policy",
    lRefund: "Refund Policy",
    ctaTrial: (days: number) => `Start ${days} days free`,
    ctaPaid: (name: string, price: string) => `Start ${name} · ${price}/mo`,
    ctaChecking: "Checking checkout…",
    ctaFree: "Continue with Free",
    dockTrial: (days: number, price: string) => `Free for ${days} days, then ${price} a month, charged automatically. Cancel within the trial and you are not charged.`,
    dockTrialNoCard: (days: number) => `Free for ${days} days. No card is needed to start.`,
    dockPaid: (price: string) => `${price} a month, renewing automatically. Cancel with ‘Open billing portal’ on the web Account page.`,
    errClosed: "Checkout can't open right now. Try again shortly, or continue with Free.",
    errNotOffered: "This plan is not on sale right now. Pick another plan or continue with Free.",
    errFailed: "Couldn't check checkout. Check your connection and try again.",
    loadingTitle: "Checking your plan",
    loadingLead: "Reading your account's subscription from the server.",
    loadingStatus: "Checking…",
    unavailTitle: "Couldn't load plan information",
    unavailLead: "Check your connection and try again. You can continue with Free now and choose a plan later in Settings.",
    retry: "Try again",
    waitTitle: "Finish checkout in your browser",
    waitLead: "Come back to this window when you are done. It continues by itself once the server confirms your subscription.",
    waitPolling: "Checking your subscription with the server…",
    waitTimeout: "Your subscription is not confirmed yet. If you finished checkout, press ‘Check now’ in a moment.",
    waitUnreachable: "Couldn't reach the server. Check your connection, then press ‘Check now’.",
    checkNow: "Check now",
    pickAgain: "Choose a plan again",
    doneTitle: "Subscription confirmed",
    doneLead: (name: string) => `The server confirmed your ${name} plan. Whether a trial applies and the next charge date are on the web Account page.`,
    doneContinue: "Continue",
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { window.clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function isFree(plan: BillingPlanOffer) {
  return plan.priceMonthly === 0 && plan.priceAnnual === 0;
}

function FirstRunPaywall({ onFinish }: { onFinish: (outcome: PaywallOutcome | null) => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const copy = useMemo(() => makeCopy(ko), [ko]);
  const api = ipc();
  const ids = useId();
  const titleId = `${ids}-title`;
  const plansId = `${ids}-plans`;

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [plans, setPlans] = useState<BillingPlanOffer[]>([]);
  const [trial, setTrial] = useState<PaywallTrialOffer | null>(null);
  const [selected, setSelected] = useState(RECOMMENDED_PLAN);
  const [inline, setInline] = useState<Inline>(null);
  const [loadEpoch, setLoadEpoch] = useState(0);

  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const pollRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const radioRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const paidPlans = useMemo(() => plans.filter((plan) => !isFree(plan) && CHECKOUT_PLANS.has(plan.id)), [plans]);
  const freePlan = useMemo(() => plans.find(isFree) ?? null, [plans]);
  const selectedPlan = paidPlans.find((plan) => plan.id === selected) ?? paidPlans[0] ?? null;
  const trialOnSelected = Boolean(trial && selectedPlan?.id === RECOMMENDED_PLAN);

  const num = (n: number) => n.toLocaleString(ko ? "ko-KR" : "en-US");
  const money = (n: number) => new Intl.NumberFormat(ko ? "ko-KR" : "en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);

  const stopPolling = useCallback(() => { pollRef.current?.abort(); pollRef.current = null; }, []);
  useEffect(() => stopPolling, [stopPolling]);

  /* ── 1–3: read the account, the catalog and the trial offer ─────────────────────────────── */
  useEffect(() => {
    let alive = true;
    setPhase({ kind: "loading" });
    setInline(null);
    void (async () => {
      const bridge = ipc();
      if (!bridge?.billing) { onFinishRef.current(null); return; }
      invalidateIpcCache("billing");
      const credits = await bridge.billing.getCredits().catch(() => null);
      if (!alive) return;
      const account = classifyAccountPlan(credits);
      if (account.kind === "signed-out") { onFinishRef.current(null); return; }
      if (account.kind === "paid") { onFinishRef.current("already-paid"); return; }
      if (account.kind === "unknown") { setPhase({ kind: "unavailable" }); return; }
      const catalog = await bridge.billing.getPlans?.().catch(() => null);
      if (!alive) return;
      if (!catalog || !catalog.ok || !catalog.plans.some((plan) => !isFree(plan) && CHECKOUT_PLANS.has(plan.id))) {
        setPhase({ kind: "unavailable" });
        return;
      }
      setPlans(catalog.plans);
      setSelected(catalog.plans.some((plan) => plan.id === RECOMMENDED_PLAN && !isFree(plan)) ? RECOMMENDED_PLAN
        : (catalog.plans.find((plan) => !isFree(plan) && CHECKOUT_PLANS.has(plan.id))?.id ?? RECOMMENDED_PLAN));
      // The trial question never gates the screen: a failure just means no trial wording.
      const probe = bridge.billing.checkoutReadiness as unknown as ReadinessProbe | undefined;
      const question: ReadinessInput = { plan: RECOMMENDED_PLAN, cycle: "monthly", withAccountTrial: true };
      const answer = probe ? await probe(question).catch(() => null) : null;
      if (!alive) return;
      setTrial(answer && answer.ok ? readTrialField((answer as { trial?: unknown }).trial) : null);
      setPhase({ kind: "choose" });
    })();
    return () => { alive = false; };
  }, [loadEpoch]);

  /* ── focus: the chosen plan, or the heading when there is no list ───────────────────────── */
  useEffect(() => {
    if (phase.kind === "choose") radioRefs.current[selectedPlan?.id ?? ""]?.focus();
    else headingRef.current?.focus();
    // Focus follows the phase only; selecting a row keeps focus on that row already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  /* ── 4: Continue with Free (button, close, Escape) ───────────────────────────── */
  const continueFree = useCallback(() => {
    stopPolling();
    // Before the server has answered, nothing is recorded: the next launch asks again.
    onFinishRef.current(phase.kind === "loading" || phase.kind === "unavailable" ? null : "free");
  }, [phase.kind, stopPolling]);

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (phase.kind === "confirmed") { onFinishRef.current("subscribed"); return; }
    continueFree();
  };

  /* ── 5: checkout in the browser, then the server decides ───────────────────────── */
  const startWaiting = useCallback((planId: string) => {
    stopPolling();
    const controller = new AbortController();
    pollRef.current = controller;
    setPhase({ kind: "waiting", planId, status: "polling", unreachable: false });
    void pollForSubscription({
      read: async () => {
        invalidateIpcCache("billing");
        return classifyAccountPlan(await ipc()?.billing.getCredits());
      },
      wait: abortableSleep,
      now: () => Date.now(),
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted || pollRef.current !== controller) return;
      if (result.kind === "paid") {
        pollRef.current = null;
        setPhase({ kind: "confirmed", plan: result.plan });
        window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT, { detail: { plan: result.plan } }));
      } else if (result.kind === "timeout") {
        setPhase({ kind: "waiting", planId, status: "timeout", unreachable: result.unreachable });
      }
    });
  }, [stopPolling]);

  // Coming back from the browser: ask the server right away.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const planId = phase.planId;
    const onFocus = () => startWaiting(planId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [phase, startWaiting]);

  const buy = async () => {
    const plan = selectedPlan;
    if (!plan || inline?.kind === "checking") return;
    setInline({ kind: "checking" });
    const probe = ipc()?.billing.checkoutReadiness as unknown as ReadinessProbe | undefined;
    const readiness = probe ? await probe({ plan: plan.id, cycle: "monthly" }).catch(() => null) : null;
    if (!readiness || !readiness.ok) { setInline({ kind: "failed" }); return; }
    if (!readiness.open || !CHECKOUT_PLANS.has(plan.id)) {
      setInline({ kind: "closed", code: readiness.code ?? "checkout_not_configured" });
      return;
    }
    openExternal(`${PRICING_PAGE_URL}?checkoutPlan=${encodeURIComponent(plan.id)}&cycle=monthly`);
    setInline(null);
    startWaiting(plan.id);
  };

  const backToChoose = () => { stopPolling(); setInline(null); setPhase({ kind: "choose" }); };

  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = paidPlans.length - 1;
    let next = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    const target = paidPlans[next];
    if (!target) return;
    setSelected(target.id);
    setInline(null);
    radioRefs.current[target.id]?.focus();
  };

  const link = (url: string, label: string) => (
    <a key={url} className={styles.link} href={url} target="_blank" rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); openExternal(url); }}>{label}</a>
  );

  /* ── rendering ───────────────────────────── */
  const planName = (id: string) => plans.find((plan) => plan.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
  const heading = (() => {
    switch (phase.kind) {
      case "loading": return [copy.loadingTitle, copy.loadingLead] as const;
      case "unavailable": return [copy.unavailTitle, copy.unavailLead] as const;
      case "waiting": return [copy.waitTitle, copy.waitLead] as const;
      case "confirmed": return [copy.doneTitle, copy.doneLead(planName(phase.plan))] as const;
      case "choose": return [trialOnSelected && trial ? copy.titleTrial(trial.days) : copy.titleChoose, copy.lead] as const;
    }
  })();

  const price = selectedPlan ? money(selectedPlan.priceMonthly) : "";
  const buyLabel = inline?.kind === "checking" ? copy.ctaChecking
    : trialOnSelected && trial ? copy.ctaTrial(trial.days)
    : selectedPlan ? copy.ctaPaid(selectedPlan.name, price) : copy.ctaFree;
  const summary = trialOnSelected && trial
    ? (trial.requiresPaymentMethod ? copy.dockTrial(trial.days, price) : copy.dockTrialNoCard(trial.days))
    : price ? copy.dockPaid(price) : "";

  const planLine = (plan: BillingPlanOffer) => {
    const soon = new Set(plan.comingSoon ?? []);
    const parts = [copy.credits(num(plan.monthlyCredits))];
    if (plan.aliveAgent) parts.push(soon.has("aliveAgent") ? `${copy.alive} (${copy.soon})` : copy.alive);
    if ((plan.agentMailAddresses ?? 0) > 0) parts.push(soon.has("agentMail") ? `${copy.mail(num(plan.agentMailAddresses ?? 0))} (${copy.soon})` : copy.mail(num(plan.agentMailAddresses ?? 0)));
    return parts.join(" · ");
  };

  return (
    <div
      className={`${base.root} ${styles.root}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-first-run-paywall={phase.kind}
      onKeyDown={onRootKeyDown}
    >
      <div className={base.drag}>
        <span className={base.brand}><img src="/brand/agentlas-one-mark.png" alt="" />Agentlas</span>
      </div>
      <div className={styles.stage}>
        <div className={styles.frame}>
          {phase.kind !== "confirmed" && (
            <button type="button" className={styles.close} onClick={continueFree} aria-label={copy.close} data-paywall-action="close">×</button>
          )}
          <header className={styles.head}>
            <h1 id={titleId} ref={headingRef} tabIndex={-1}>{heading[0]}</h1>
            <p role={phase.kind === "unavailable" ? "alert" : undefined}>{heading[1]}</p>
          </header>

          {phase.kind === "loading" && (
            <div className={styles.status} role="status"><span className={styles.spinner} aria-hidden="true" />{copy.loadingStatus}</div>
          )}

          {phase.kind === "choose" && selectedPlan && (
            <>
              <section className={styles.section} aria-labelledby={plansId}>
                <h2 id={plansId} className={styles.sectionTitle}>{copy.plansLabel}</h2>
                <div className={styles.plans} role="radiogroup" aria-labelledby={plansId}>
                  {paidPlans.map((plan, index) => {
                    const checked = plan.id === selectedPlan.id;
                    return (
                      <button
                        key={plan.id}
                        ref={(node) => { radioRefs.current[plan.id] = node; }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={checked ? 0 : -1}
                        className={styles.plan}
                        data-plan={plan.id}
                        onClick={() => { setSelected(plan.id); setInline(null); }}
                        onKeyDown={(event) => onRadioKey(event, index)}
                      >
                        <span className={styles.radio} aria-hidden="true" />
                        <span className={styles.planBody}>
                          <span className={styles.planName}>
                            {plan.name}
                            {plan.id === RECOMMENDED_PLAN && <span className={styles.tag}>{copy.recommended}</span>}
                            {plan.id === RECOMMENDED_PLAN && trial && <span className={styles.tagSoft}>{copy.trialTag(trial.days)}</span>}
                          </span>
                          <span className={styles.planLine}>{planLine(plan)}</span>
                        </span>
                        <span className={styles.price}><strong>{money(plan.priceMonthly)}</strong><span>{copy.perMonth}</span></span>
                      </button>
                    );
                  })}
                </div>
                <p className={styles.note} data-paywall-free-note>{copy.freeNote(freePlan ? num(freePlan.monthlyCredits) : null)}</p>
              </section>

              {trialOnSelected && trial && (
                <section className={styles.card} aria-labelledby={`${ids}-schedule`} data-paywall-schedule>
                  <h2 id={`${ids}-schedule`}>{copy.scheduleTitle}</h2>
                  <ul className={styles.schedule}>
                    <li><b>{copy.sToday}</b><span>{trial.requiresPaymentMethod ? copy.sTodayCard(money(0)) : copy.sTodayNoCard}</span></li>
                    <li><b>{copy.sEnd(trial.days)}</b><span>{trial.requiresPaymentMethod ? copy.sEndCharge(price) : copy.sEndNoCard}</span></li>
                    {trial.requiresPaymentMethod && <li><b>{copy.sCancel}</b><span>{copy.sCancelText(trial.days)}</span></li>}
                  </ul>
                </section>
              )}

              {inline && inline.kind !== "checking" && (
                <div className={styles.status} role="alert" data-tone="warn" data-paywall-inline={inline.kind} data-code={inline.kind === "closed" ? inline.code : undefined}>
                  {inline.kind === "closed" ? (inline.code === "plan_not_offered" ? copy.errNotOffered : copy.errClosed) : copy.errFailed}
                </div>
              )}

              <section className={styles.card} aria-labelledby={`${ids}-legal`} data-paywall-legal>
                <h2 id={`${ids}-legal`}>{copy.legalTitle}</h2>
                <p className={styles.legalBody}>{copy.legalBody}</p>
                <div className={styles.links}>
                  {link(LEGAL_LINKS.manage, copy.lManage)}
                  {link(LEGAL_LINKS.terms, copy.lTerms)}
                  {link(LEGAL_LINKS.privacy, copy.lPrivacy)}
                  {link(LEGAL_LINKS.refund, copy.lRefund)}
                </div>
              </section>
            </>
          )}

          {phase.kind === "waiting" && (
            <>
              <div className={styles.status} role="status" aria-live="polite" data-paywall-waiting={phase.status} data-tone={phase.status === "timeout" ? "warn" : undefined}>
                {phase.status === "polling" && <span className={styles.spinner} aria-hidden="true" />}
                {phase.status === "polling" ? copy.waitPolling : phase.unreachable ? copy.waitUnreachable : copy.waitTimeout}
              </div>
              <div className={styles.links}>
                <button type="button" className={styles.linkButton} onClick={backToChoose} data-paywall-action="pick-again">{copy.pickAgain}</button>
              </div>
            </>
          )}
        </div>
      </div>

      <footer className={styles.dock}>
        {phase.kind === "choose" && summary && <p className={styles.summary} data-paywall-summary>{summary}</p>}
        <div className={styles.buttons} style={phase.kind === "loading" || phase.kind === "confirmed" ? { gridTemplateColumns: "1fr" } : undefined}>
          {phase.kind === "choose" && (
            <button type="button" className={styles.buy} onClick={() => void buy()} disabled={inline?.kind === "checking"} data-paywall-action="buy">{buyLabel}</button>
          )}
          {phase.kind === "unavailable" && (
            <button type="button" className={styles.buy} onClick={() => setLoadEpoch((value) => value + 1)} data-paywall-action="retry">{copy.retry}</button>
          )}
          {phase.kind === "waiting" && (
            <button type="button" className={styles.buy} onClick={() => startWaiting(phase.planId)} data-paywall-action="check-now">{copy.checkNow}</button>
          )}
          {phase.kind === "confirmed" && (
            <button type="button" className={styles.buy} onClick={() => onFinishRef.current("subscribed")} data-paywall-action="done">{copy.doneContinue}</button>
          )}
          {phase.kind !== "confirmed" && (
            <button type="button" className={styles.free} onClick={continueFree} data-paywall-action="free">{copy.ctaFree}</button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * Sits inside FirstRunGate. While the first-run flow is about to open for an account that has not met the
 * paywall, it shows the paywall instead of the flow; every other time it renders its children untouched.
 */
export function FirstRunPaywallLayer({ fingerprint, flowOpen, children }: { fingerprint: string | undefined; flowOpen: boolean; children: React.ReactNode }) {
  const [seen, setSeen] = useState<boolean>(() => typeof window === "undefined" ? true : readPaywallRecord(window.localStorage, fingerprint) !== null);
  const [skipped, setSkipped] = useState(false);
  const finish = useCallback((outcome: PaywallOutcome | null) => {
    if (outcome) {
      writePaywallRecord(window.localStorage, fingerprint, outcome);
      setSeen(true);
    } else {
      setSkipped(true);
    }
  }, [fingerprint]);
  if (flowOpen && !seen && !skipped) return <FirstRunPaywall onFinish={finish} />;
  return <>{children}</>;
}
