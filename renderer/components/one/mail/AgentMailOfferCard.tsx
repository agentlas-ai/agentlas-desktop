"use client";

/*
 * "Give this agent a mailbox" card — first-run 08 and Settings → Mail.
 *
 * Owner report 2026-09-29 (1.2.50): the card said "확인 필요" with nothing to press.
 * That chip covered four machine states. Now each state from agentMailOffer()
 * (shared/agent-mail-offer.ts) has its own label and one next action:
 *   sign-in         → "Agentlas 로그인" (auth.signInWithBrowser, then re-read)
 *   not-open        → "곧 열려요" + plain reason (server has not opened mail for the workspace)
 *   plan-required   → "플랜 선택" (the one paywall modal)
 *   choose-address  → permanent address picker (+ this month's allowance)
 *   provisioning    → "준비 중" + "다시 확인"
 *   provisioning-failed → "준비 실패" + retry the same chosen mailbox
 *   active          → address + copy + used/remaining + reset date (exhausted / send-blocked variants)
 *   error           → reason from the error code + "다시 시도"
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { Locale } from "@/lib/i18n";
import type { AgentMailStatus, AgentMailWaitlistReceipt } from "@shared/agent-mail";
import { agentMailOffer, type AgentMailOffer } from "@shared/agent-mail-offer";
import { openPricing } from "@/components/UpgradeCta";
import { PLAN_CHANGED_EVENT } from "@/components/billing/PlanPickerModal";
import { OneMailIdentityPicker } from "./OneMailIdentityPicker";
import { mailErrorText } from "./mailErrorText";
import styles from "./AgentMailOfferCard.module.css";

function makeCopy(ko: boolean) {
  return ko ? {
    name: "에이전트 전용 메일",
    chip: {
      checking: "확인 중", "sign-in": "로그인 필요", "not-open": "곧 열려요", "plan-required": "플랜에 없음",
      "choose-address": "주소 정하기", provisioning: "준비 중", "provisioning-failed": "준비 실패", active: "사용 중", exhausted: "이번 달 한도 소진", error: "불러오기 실패",
    } as Record<string, string>,
    checking: "메일 상태를 확인하고 있어요…",
    signInBody: "Agentlas에 로그인하면 요금제에 포함된 메일 주소를 바로 만들 수 있어요.",
    signIn: "Agentlas 로그인",
    signingIn: "브라우저에서 로그인을 마쳐 주세요…",
    notOpenBody: "이 계정에는 아직 에이전트 메일이 열리지 않았어요. 열리면 여기서 바로 주소를 만들 수 있어요.",
    joinWaitlist: "메일 오픈 알림 신청",
    joiningWaitlist: "신청하는 중…",
    waitlistJoined: "신청했어요. 이 계정의 이메일로 오픈 소식을 알려 드릴게요.",
    waitlistFailed: "신청 결과를 확인하지 못했어요. 다시 시도해 주세요.",
    accountEmailRequired: "로그인 계정의 이메일을 확인한 뒤 다시 신청해 주세요.",
    notOpenUnknown: "서버가 이 계정의 메일 사용 범위를 알려 주지 않았어요. 잠시 뒤 다시 확인해 주세요.",
    planBody: "에이전트 전용 메일은 Pro 이상 플랜에 포함돼요. 플랜을 고르면 바로 주소를 만들 수 있어요.",
    choosePlan: "플랜 선택",
    chooseBody: (left: string, limit: string) => `요금제에 포함돼 있어요. 아래에서 주소를 정해 주세요. 이번 달 보낼 수 있는 받는 사람 ${left}/${limit}명.`,
    provisioningBody: "주소를 준비하고 있어요. 보통 몇 초면 끝나요.",
    provisioningFailedBody: "메일함 준비를 마치지 못했어요. 정해 둔 주소로 다시 시도할 수 있어요.",
    retrying: "다시 준비하는 중…",
    recheck: "다시 확인",
    usage: (used: string, limit: string, left: string, reset: string) => `이번 달 받는 사람 ${used}/${limit}명 사용 · ${left}명 남음 · ${reset} 초기화`,
    exhaustedBody: (limit: string, reset: string) => `이번 달 발송 한도 ${limit}명을 다 썼어요. ${reset}에 다시 채워져요. 받기는 계속돼요.`,
    sendBlockedBody: "받은 메일은 계속 볼 수 있어요. 보내려면 발송이 포함된 플랜이 필요해요.",
    countNote: "메일 1통을 3명에게 보내면 3명으로 셈해요.",
    copy: "복사",
    copied: "복사했어요",
    retry: "다시 시도",
  } : {
    name: "Agent mailbox",
    chip: {
      checking: "Checking", "sign-in": "Sign in", "not-open": "Opening soon", "plan-required": "Not in plan",
      "choose-address": "Choose address", provisioning: "Preparing", "provisioning-failed": "Preparation failed", active: "Active", exhausted: "Limit reached", error: "Couldn't load",
    } as Record<string, string>,
    checking: "Checking your mailbox…",
    signInBody: "Sign in to Agentlas to create the mail address your plan includes.",
    signIn: "Sign in to Agentlas",
    signingIn: "Finish signing in in your browser…",
    notOpenBody: "Agent mail isn't open for this account yet. Once it opens you can create the address right here.",
    joinWaitlist: "Notify me when mail opens",
    joiningWaitlist: "Signing up…",
    waitlistJoined: "Signed up. We'll notify this account's email when mail opens.",
    waitlistFailed: "We couldn't confirm your signup. Please try again.",
    accountEmailRequired: "Check the signed-in account's email, then try again.",
    notOpenUnknown: "The server didn't say what this account includes. Check again in a moment.",
    planBody: "Agent mail is included with Pro and above. Pick a plan and create the address right away.",
    choosePlan: "Choose a plan",
    chooseBody: (left: string, limit: string) => `Included in your plan. Choose the address below. Recipients left this month: ${left}/${limit}.`,
    provisioningBody: "The address is being prepared. This usually takes a few seconds.",
    provisioningFailedBody: "Mailbox preparation failed. You can try again with the address you already chose.",
    retrying: "Preparing again…",
    recheck: "Check again",
    usage: (used: string, limit: string, left: string, reset: string) => `Recipients this month: ${used}/${limit} used · ${left} left · resets ${reset}`,
    exhaustedBody: (limit: string, reset: string) => `You've used this month's ${limit} recipients. It refills on ${reset}. Receiving continues.`,
    sendBlockedBody: "You can still read mail. Sending needs a plan that includes it.",
    countNote: "One email to 3 people counts as 3.",
    copy: "Copy",
    copied: "Copied",
    retry: "Try again",
  };
}

/** Owns the status read so every surface asks the server the same way. */
export function useAgentMailStatus() {
  const api = ipc()?.agentMail;
  const [status, setStatus] = useState<AgentMailStatus | null>(null);
  const reload = useCallback(async () => {
    if (!api) { setStatus({ ok: false, code: "unavailable", message: "", status: null }); return; }
    const next = await api.status().catch(() => null);
    setStatus(next ?? { ok: false, code: "network", message: "", status: null });
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  // A confirmed checkout in the plan picker changes the entitlement: re-read.
  useEffect(() => {
    const onPlan = () => { void reload(); };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
  }, [reload]);
  return { status, reload, offer: status === null ? ({ kind: "checking" } as AgentMailOffer) : agentMailOffer(status) };
}

export function AgentMailOfferCard({
  locale,
  oneName,
  status,
  reload,
  compact = false,
}: {
  locale: Locale;
  oneName: string;
  status: AgentMailStatus | null;
  reload: () => Promise<void> | void;
  compact?: boolean;
}) {
  const ko = locale === "ko";
  const copy = makeCopy(ko);
  const offer = status === null ? ({ kind: "checking" } as AgentMailOffer) : agentMailOffer(status);
  const [copied, setCopied] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<{ code: string } | null>(null);
  useEffect(() => { setRetryError(null); }, [offer.kind]);
  const [joiningWaitlist, setJoiningWaitlist] = useState(false);
  const [waitlistReceipt, setWaitlistReceipt] = useState<AgentMailWaitlistReceipt | null>(null);
  const [waitlistError, setWaitlistError] = useState<{ code: string } | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const waitlistGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; waitlistGeneration.current += 1; }; }, []);
  useEffect(() => { waitlistGeneration.current += 1; setJoiningWaitlist(false); setWaitlistReceipt(null); setWaitlistError(null); }, [status]);
  const num = (n: number) => n.toLocaleString(ko ? "ko-KR" : "en-US");
  const day = (iso: string | null) => {
    if (!iso) return ko ? "다음 달 1일" : "the 1st of next month";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return ko ? "다음 달 1일" : "the 1st of next month";
    return date.toLocaleDateString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };

  const recheck = async () => {
    setBusy(true);
    try { await reload(); } finally { setBusy(false); }
  };

  const retryProvisioning = async () => {
    if (busy || offer.kind !== "provisioning-failed") return;
    const api = ipc()?.agentMail;
    if (!api) { setRetryError({ code: "unavailable" }); return; }
    setBusy(true);
    setRetryError(null);
    try {
      // The server retries this mailbox's permanent address; never choose a new one here.
      const result = await api.issue();
      if (!result.ok) setRetryError({ code: result.code });
      await reload();
    } catch {
      setRetryError({ code: "network" });
    } finally {
      setBusy(false);
    }
  };

  const joinWaitlist = async () => {
    if (joiningWaitlist || waitlistReceipt || offer.kind !== "not-open") return;
    const api = ipc()?.agentMail;
    if (!api?.joinWaitlist) { setWaitlistError({ code: "unavailable" }); return; }
    const requestStatus = statusRef.current;
    const generation = ++waitlistGeneration.current;
    const current = () => mounted.current && waitlistGeneration.current === generation && statusRef.current === requestStatus;
    setJoiningWaitlist(true);
    setWaitlistError(null);
    try {
      const result = await api.joinWaitlist();
      if (!current()) return;
      if (result.ok) setWaitlistReceipt({ plan: result.plan });
      else setWaitlistError({ code: result.code });
    } catch {
      if (current()) setWaitlistError({ code: "network" });
    } finally { if (current()) setJoiningWaitlist(false); }
  };

  const signIn = async () => {
    const auth = ipc()?.auth;
    if (!auth) return;
    setSigningIn(true);
    try { await auth.signInWithBrowser(); } catch { /* the status re-read below tells the truth */ }
    finally { setSigningIn(false); }
    await reload();
  };

  const chipKey = offer.kind === "active" && offer.exhausted ? "exhausted" : offer.kind;
  const tone = offer.kind === "active" ? (offer.exhausted || offer.sendBlocked ? "warn" : "ok") : (offer.kind === "error" || offer.kind === "provisioning-failed") ? "warn" : undefined;

  let body: string | null = null;
  if (offer.kind === "checking") body = copy.checking;
  else if (offer.kind === "sign-in") body = signingIn ? copy.signingIn : copy.signInBody;
  else if (offer.kind === "not-open") body = offer.code === "agent_mail_not_available" ? copy.notOpenBody : copy.notOpenUnknown;
  else if (offer.kind === "plan-required") body = copy.planBody;
  else if (offer.kind === "choose-address") body = copy.chooseBody(num(offer.entitlement.remainingThisMonth), num(offer.entitlement.monthlyRecipientLimit));
  else if (offer.kind === "provisioning") body = copy.provisioningBody;
  else if (offer.kind === "provisioning-failed") body = busy ? copy.retrying : copy.provisioningFailedBody;
  else if (offer.kind === "error") body = mailErrorText(locale, { code: offer.code });
  else if (offer.kind === "active") {
    body = offer.sendBlocked
      ? copy.sendBlockedBody
      : offer.exhausted
        ? copy.exhaustedBody(num(offer.limit), day(offer.resetsAt))
        : copy.usage(num(offer.used), num(offer.limit), num(offer.remaining), day(offer.resetsAt));
  }

  return (
    <div className={styles.card} data-agent-mail-offer={offer.kind} data-compact={compact || undefined}>
      <div className={styles.row}>
        <div className={styles.text}>
          <strong>{copy.name}</strong>
          {body && <small role={offer.kind === "error" || offer.kind === "provisioning-failed" ? "alert" : undefined}>{body}</small>}
        </div>
        <span className={styles.chip} data-tone={tone}>{copy.chip[chipKey]}</span>
      </div>

      {offer.kind === "active" && (
        <>
          <div className={styles.addressRow}>
            <code className={styles.address} title={offer.mailbox.address} data-agent-mail-address>{offer.mailbox.address}</code>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => void navigator.clipboard?.writeText(offer.mailbox.address).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}
            >
              {copied ? copy.copied : copy.copy}
            </button>
          </div>
          {!offer.sendBlocked && offer.limit > 0 && (
            <div
              className={styles.meter}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={offer.limit}
              aria-valuenow={offer.used}
              data-exhausted={offer.exhausted || undefined}
            >
              <div style={{ width: `${Math.min(100, Math.round((offer.used / offer.limit) * 100))}%` }} />
            </div>
          )}
          {!offer.sendBlocked && offer.limit > 0 && <p className={styles.note}>{copy.countNote}</p>}
          {offer.sendBlocked && (
            <button type="button" className={styles.primary} onClick={() => openPricing("agent-mail")} data-agent-mail-action="choose-plan">{copy.choosePlan}</button>
          )}
        </>
      )}

      {offer.kind === "sign-in" && (
        <button type="button" className={styles.primary} onClick={() => void signIn()} disabled={signingIn} data-agent-mail-action="sign-in">{copy.signIn}</button>
      )}
      {offer.kind === "plan-required" && (
        <button type="button" className={styles.primary} onClick={() => openPricing("agent-mail")} data-agent-mail-action="choose-plan">{copy.choosePlan}</button>
      )}
      {(offer.kind === "not-open" || offer.kind === "provisioning" || offer.kind === "error") && (
        <button type="button" className={styles.secondary} onClick={() => void recheck()} disabled={busy} data-agent-mail-action="recheck">
          {offer.kind === "error" ? copy.retry : copy.recheck}
        </button>
      )}
      {offer.kind === "provisioning-failed" && (
        <>
          <button type="button" className={styles.secondary} onClick={() => void retryProvisioning()} disabled={busy} data-agent-mail-action="retry-provisioning">{busy ? copy.retrying : copy.retry}</button>
          {retryError && <p className={styles.note} role="alert">{mailErrorText(locale, retryError)}</p>}
        </>
      )}
      {offer.kind === "not-open" && offer.code === "agent_mail_not_available" && (
        <>
          {waitlistReceipt ? <p className={styles.note} role="status" data-agent-mail-waitlist="confirmed">{copy.waitlistJoined}</p> : (
            <button type="button" className={styles.secondary} onClick={() => void joinWaitlist()} disabled={joiningWaitlist} data-agent-mail-action="join-waitlist">{joiningWaitlist ? copy.joiningWaitlist : copy.joinWaitlist}</button>
          )}
          {waitlistError && <p className={styles.note} role="alert">{waitlistError.code === "account_email_required" ? copy.accountEmailRequired : waitlistError.code === "waitlist_response_invalid" || waitlistError.code === "unavailable" ? copy.waitlistFailed : mailErrorText(locale, waitlistError)}</p>}
        </>
      )}
      {offer.kind === "choose-address" && (
        <OneMailIdentityPicker
          locale={locale}
          oneName={oneName}
          limits={status && status.ok ? status.limits ?? null : null}
          onCreated={() => void reload()}
          compact
        />
      )}
    </div>
  );
}
