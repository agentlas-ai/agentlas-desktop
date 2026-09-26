"use client";

/*
 * Desktop first-run onboarding, screens 02–08 (2026-09-25 redesign).
 * Plan: docs/2026-09-25-onboarding-redesign/PLAN.md.
 *
 *   02 name → 03 Chrome → 04 AI (+05 login guide popup, +06 Free·Pro popup) →
 *   07 personality/tone → 08 mailbox → One home.
 *
 * Each step writes to an existing store and re-reads it before it counts as done:
 *   name/prefs → One profile (displayName, profileContext, operatingPrinciples)
 *   Chrome     → CredentialImportDialog (consent ≠ import ≠ sign-in kept)
 *   AI         → runtime.installCli / openCliLogin / detect + usage (real data only)
 *   Pro        → web checkout, then billing.getCredits re-read before "Pro"
 *   mailbox    → agentMail.status() (server entitlement). Absent = "coming soon";
 *                Pro+ may create an address via agentMail.issue(), shown only after
 *                status() returns it.
 *
 * Research (owner rule: look before building):
 *   - Apple HIG, Onboarding: keep it fast and optional; ask for access in context,
 *     when its benefit can be shown — so Chrome/AI are skippable and explained.
 *   - Linear's first run: one idea per screen, a visible skip on each.
 *   - Raycast: skipped setup stays reachable later ("Show Onboarding") — here via
 *     Settings → "Run first-time setup again".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { AuthSession, BillingPlanOffer, HubCreditBalance, OneProfile, RuntimeStatus, UsageSnapshot } from "@/lib/types";
import type { AgentMailStatus } from "@shared/agent-mail";
import { openPricing, PRICING_URL } from "@/components/UpgradeCta";
import { CredentialImportDialog } from "@/components/connect/CredentialImportDialog";
import { AI_CARDS, aiCardState, usageWindowLabel, type AiCardId, type AiCardSpec, type AiCardState } from "@/lib/ai-connection-state";
import {
  FIRST_RUN_OPEN_EVENT,
  FIRST_RUN_STEPS,
  classifyAudience,
  newFirstRunRecord,
  readFirstRunRecord,
  recordCompleted,
  recordStep,
  resumeStep,
  shouldAutoOpen,
  writeFirstRunRecord,
  type FirstRunOutcome,
  type FirstRunRecord,
  type FirstRunStep,
} from "@/lib/first-run-state";
import { setOnePersonaName } from "@/lib/one-persona-name";
import { mailErrorText } from "@/components/one/mail/mailErrorText";
import styles from "./FirstRun.module.css";

const LEGACY_WORK_TOUR_KEY = "agentlas.work.firstRunOnboarding.v3";
const PAID_PLANS = new Set(["pro", "max", "wow"]);
const ANTIGRAVITY_URL = "https://antigravity.google";

/** Decide whether this account sees the flow, and keep that decision. */
async function loadOrClassify(accountFingerprint: string | undefined): Promise<FirstRunRecord> {
  const existing = readFirstRunRecord(window.localStorage, accountFingerprint);
  if (existing) return existing;
  const api = ipc();
  let legacyWorkTourSeen = false;
  try { legacyWorkTourSeen = window.localStorage.getItem(LEGACY_WORK_TOUR_KEY) === "1"; } catch { /* storage optional */ }
  const [profile, chats, projects] = await Promise.all([
    api?.oneProfile?.get().catch(() => null) ?? null,
    api?.chats?.listRecent(1).catch(() => null) ?? null,
    api?.projects?.list().catch(() => null) ?? null,
  ]);
  const created = profile ? Date.parse(profile.createdAt) : NaN;
  const audience = classifyAudience({
    legacyWorkTourSeen,
    profileCustomized: Boolean(profile && (profile.displayName !== "One" || profile.profileContext || profile.operatingPrinciples.length > 0)),
    profileAgeMs: Number.isFinite(created) ? Date.now() - created : null,
    chatCount: chats ? chats.length : null,
    projectCount: projects ? projects.length : null,
  });
  const record = newFirstRunRecord(audience);
  writeFirstRunRecord(window.localStorage, accountFingerprint, record);
  return record;
}

/**
 * Sits between AuthGate and the app. While the flow is open the app is not
 * mounted behind it, so focus cannot wander into a hidden page.
 */
export function FirstRunGate({ session, children }: { session: AuthSession; children: React.ReactNode }) {
  const fingerprint = session.accountFingerprint;
  const [record, setRecord] = useState<FirstRunRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  // Finishing navigates to One first and unmounts the flow only once the route is
  // there. Closing first would mount "/" whose redirect sends people to Work
  // (real run 2026-09-25 landed on /dashboard).
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!leavingTo) return;
    if (pathname?.startsWith(leavingTo)) { setOpen(false); setLeavingTo(null); return; }
    router.replace(leavingTo);
  }, [leavingTo, pathname, router]);

  useEffect(() => {
    let alive = true;
    void loadOrClassify(fingerprint)
      .then((next) => { if (!alive) return; setRecord(next); setOpen(shouldAutoOpen(next)); })
      .catch(() => undefined)
      .finally(() => { if (alive) setChecked(true); });
    return () => { alive = false; };
  }, [fingerprint]);

  // Settings → "Run first-time setup again": open from the first step, keep old receipts.
  useEffect(() => {
    const onOpen = () => {
      const current = readFirstRunRecord(window.localStorage, fingerprint) ?? newFirstRunRecord("existing");
      const reopened: FirstRunRecord = { ...current, steps: {}, completedAt: null };
      writeFirstRunRecord(window.localStorage, fingerprint, reopened);
      setRecord(reopened);
      setOpen(true);
    };
    window.addEventListener(FIRST_RUN_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(FIRST_RUN_OPEN_EVENT, onOpen);
  }, [fingerprint]);

  if (!checked) return null;
  if (open && record) {
    return (
      <FirstRunOnboarding
        fingerprint={fingerprint}
        record={record}
        onRecord={setRecord}
        onClose={(target) => { if (target) setLeavingTo(target); else setOpen(false); }}
      />
    );
  }
  return <>{children}</>;
}

type Copy = ReturnType<typeof makeCopy>;

function makeCopy(ko: boolean, name: string) {
  return ko ? {
    back: "이전", next: "계속", skip: "건너뛰기", saving: "저장하는 중…",
    nameTitle: "에이전트 이름을 정해주세요.", nameSub: "One 대신 이 이름으로 불리게 됩니다.",
    nameLabel: "에이전트 이름", namePlaceholder: "예: 루나", namePreview: (n: string) => `안녕하세요, ${n}입니다.`,
    nameHint: "나중에 프로필에서 언제든 바꿀 수 있어요.",
    browserTitle: "Chrome을 연결할까요?", browserSub: "에이전트가 로그인된 서비스를 쓰며 일하기 쉬워져요.",
    chromeName: "Google Chrome", chromeSub: "이 기기의 Chrome 프로필에서 가져올 사이트를 고릅니다.",
    consent: "선택한 Chrome 프로필의 로그인 세션을 에이전트 전용 브라우저로 가져오는 데 동의합니다.",
    connectChrome: "Chrome 연결", reopenChrome: "더 가져오기",
    chipNone: "연결 전", chipImported: "가져옴", chipConsented: "동의함",
    factConsent: "동의", factImport: "가져오기", factKept: "로그인 유지",
    yes: "했어요", notYet: "아직", sitesKept: (n: number) => `${n}개 사이트`, keptUnknown: "확인 불가",
    browserHint: "건너뛰어도 브라우저 화면에서 나중에 연결할 수 있어요.",
    aiTitle: "어떤 AI를 자주 쓰세요?", aiSub: "이미 로그인된 AI는 자동으로 보여요. 여러 개를 함께 연결할 수 있어요.",
    aiCaption: "사용량은 공급자가 알려준 값만 보여 드려요.",
    aiName: { gpt: "GPT", claude: "Claude", gemini: "Gemini" } as Record<AiCardId, string>,
    aiSub2: { gpt: "ChatGPT · Codex", claude: "Claude Code", gemini: "Google · Antigravity" } as Record<AiCardId, string>,
    aiFullName: { gpt: "ChatGPT", claude: "Claude", gemini: "Gemini" } as Record<AiCardId, string>,
    notInstalled: "설치 안 됨", noAutoInstall: "자동 설치 미지원", installed: "설치됨", loginUnknown: "로그인 확인 불가",
    signInNeeded: "로그인 필요", signedIn: "로그인됨", usageUnknown: "사용량 확인 불가",
    remaining: (pct: number, window: string) => `남은 ${pct}% · ${window}`,
    loginCta: "로그인 하기", connectedCta: "연결됨", installGuide: "설치 페이지 열기", checking: "확인하는 중…",
    installing: "설치하는 중…", loggingIn: "열린 창에서 로그인", verifying: "로그인 확인 중…",
    notVerified: "로그인 창은 열렸지만 아직 확인되지 않았어요. 로그인을 마쳤다면 다시 눌러 확인하세요.",
    neverUsed: "아무것도 써본 적 없어요", neverUsedSub: "Agentlas 하나로 시작해요.", seePlans: "Free · Pro 보기",
    connectTitle: (n: string) => `${n}에 연결`,
    connectBody: "이 기기에 필요한 도구를 설치하고 공식 로그인 창을 엽니다. 로그인이 확인되면 이 카드만 연결됨으로 바뀌어요. 비밀번호는 Agentlas에 저장되지 않아요.",
    connectBodyInstalled: "공식 로그인 창을 엽니다. 로그인이 확인되면 이 카드만 연결됨으로 바뀌어요. 비밀번호는 Agentlas에 저장되지 않아요.",
    connectGo: "로그인 진행", cancel: "취소", close: "닫기",
    planTitle: "Agentlas로 시작하세요.", planSub: "다른 AI 구독이 없어도 Agentlas 구독 하나면 돼요.",
    planDefault: "기본 선택", planCurrent: "지금 요금제", perMonth: "/ 월", perYear: (p: string) => `/ 월 · 연 ${p}`,
    credits: (n: string) => `월 ${n} credits`, cloud: (n: string) => `비공개 Cloud 에이전트 ${n}개`,
    alive: "Alive Agent 포함",
    byo: "내 AI 연결 · 로컬 실행", planMailSoon: "AI 전용 메일 · 도입 예정",
    freeCta: "Free로 시작", proCta: "구독하기", proActive: (p: string) => `${p} 사용 중`,
    planNote: "가격과 혜택은 agentlas.cloud 상품 정보에서 불러왔어요. 결제는 웹에서 진행돼요.",
    planLoadFailed: "요금 정보를 불러오지 못했어요.", retry: "다시 시도", openWeb: "웹에서 보기", loadingPlans: "요금 정보를 불러오는 중…",
    checkoutOpened: "웹에서 결제를 마치면 여기서 다시 확인해요.", checkPlan: "결제 확인",
    planConfirmed: (p: string) => `${p} 요금제가 확인됐어요.`, planStillFree: "아직 결제가 확인되지 않았어요. Free로 계속 쓸 수 있어요.",
    planCheckFailed: "요금제를 확인하지 못했어요. 잠시 뒤 다시 확인해 주세요.",
    prefTitle: "에이전트가 지켜야 할 것이 있나요?", prefSub: "선호하는 성격과 말투를 적어 주세요. 비워 두어도 돼요.",
    prefLabel: "성격과 말투 · 선택", prefPlaceholder: "예: 짧고 차분하게, 근거를 먼저 보여줘.",
    principleLabel: "꼭 지켜야 할 원칙 · 한 줄에 하나", principlePlaceholder: "예: 외부로 보내기 전에 꼭 물어봐.",
    prefHint: "원칙은 적은 그대로만 지켜요. 언제든 프로필에서 고칠 수 있어요.",
    mailTitle: "에이전트에게 메일함을 줄까요?", mailSub: "에이전트만 쓰는 고유한 메일 주소예요.",
    mailName: "에이전트 전용 메일", mailSoon: "도입 예정", mailSoonBody: "Pro 이상 요금제 혜택으로 준비하고 있어요. 준비되면 설정에서 켤 수 있어요.",
    mailIssued: "발급됨", mailPending: "주소 발급 전", mailPendingBody: "요금제에 포함돼 있어요. 주소를 만들면 여기에 보여요.",
    mailCreate: "메일 주소 만들기", mailCreating: "만드는 중…", mailPreparing: "준비 중", mailPreparingBody: "주소를 준비하고 있어요. 준비가 끝나면 설정에서 쓸 수 있어요.",
    mailPlanOnly: "Pro 이상 요금제에서 쓸 수 있어요.", mailSeePlans: "Free · Pro 보기",
    mailQuota: (left: string, limit: string) => `이번 달 보낼 수 있는 받는 사람 ${left}/${limit}명 (메일 1통을 3명에게 보내면 3명으로 셈)`,
    mailHint: "실제 주소는 서버에서 발급된 뒤에만 보여 드려요.",
    finish: `${name}에게 가기`, stepsLabel: "진행 단계",
    saveFailed: "저장하지 못했어요. 다시 시도해 주세요.",
  } : {
    back: "Back", next: "Continue", skip: "Skip", saving: "Saving…",
    nameTitle: "Name your agent.", nameSub: "Your agent goes by this name instead of One.",
    nameLabel: "Agent name", namePlaceholder: "e.g. Luna", namePreview: (n: string) => `Hi, I'm ${n}.`,
    nameHint: "You can change it anytime in the profile.",
    browserTitle: "Connect Chrome?", browserSub: "Your agent can work in the services you're already signed in to.",
    chromeName: "Google Chrome", chromeSub: "Pick the sites to bring over from a Chrome profile on this computer.",
    consent: "I agree to copy sign-in sessions from the selected Chrome profile into the agent's own browser.",
    connectChrome: "Connect Chrome", reopenChrome: "Import more",
    chipNone: "Not connected", chipImported: "Imported", chipConsented: "Agreed",
    factConsent: "Consent", factImport: "Import", factKept: "Signed in",
    yes: "Done", notYet: "Not yet", sitesKept: (n: number) => `${n} site${n === 1 ? "" : "s"}`, keptUnknown: "Unknown",
    browserHint: "You can connect later from the Browser screen.",
    aiTitle: "Which AI do you use?", aiSub: "AI you're already signed in to shows up here. Connect as many as you like.",
    aiCaption: "Usage is shown only when the provider reports it.",
    aiName: { gpt: "GPT", claude: "Claude", gemini: "Gemini" } as Record<AiCardId, string>,
    aiSub2: { gpt: "ChatGPT · Codex", claude: "Claude Code", gemini: "Google · Antigravity" } as Record<AiCardId, string>,
    aiFullName: { gpt: "ChatGPT", claude: "Claude", gemini: "Gemini" } as Record<AiCardId, string>,
    notInstalled: "Not installed", noAutoInstall: "No auto install", installed: "Installed", loginUnknown: "Sign-in unverified",
    signInNeeded: "Sign-in needed", signedIn: "Signed in", usageUnknown: "Usage unavailable",
    remaining: (pct: number, window: string) => `${pct}% left · ${window}`,
    loginCta: "Sign in", connectedCta: "Connected", installGuide: "Open install page", checking: "Checking…",
    installing: "Installing…", loggingIn: "Sign in in the window", verifying: "Verifying sign-in…",
    notVerified: "The sign-in window opened but sign-in is not confirmed yet. If you finished, press it again to check.",
    neverUsed: "I haven't used any", neverUsedSub: "Start with Agentlas alone.", seePlans: "See Free · Pro",
    connectTitle: (n: string) => `Connect ${n}`,
    connectBody: "We'll install the tool this computer needs and open the official sign-in. Only this card changes once sign-in is confirmed. Agentlas never stores your password.",
    connectBodyInstalled: "We'll open the official sign-in. Only this card changes once sign-in is confirmed. Agentlas never stores your password.",
    connectGo: "Continue to sign in", cancel: "Cancel", close: "Close",
    planTitle: "Start with Agentlas.", planSub: "No other AI subscription needed — one Agentlas plan is enough.",
    planDefault: "Selected", planCurrent: "Current plan", perMonth: "/ month", perYear: (p: string) => `/ month · ${p}/yr`,
    credits: (n: string) => `${n} credits / month`, cloud: (n: string) => `${n} private Cloud agents`,
    alive: "Alive Agent included",
    byo: "Your own AI · local runs", planMailSoon: "Agent mailbox · coming soon",
    freeCta: "Start with Free", proCta: "Subscribe", proActive: (p: string) => `On ${p}`,
    planNote: "Prices and benefits come from the agentlas.cloud catalog. Checkout happens on the web.",
    planLoadFailed: "Could not load plans.", retry: "Retry", openWeb: "Open on the web", loadingPlans: "Loading plans…",
    checkoutOpened: "Finish checkout on the web, then check here.", checkPlan: "Check payment",
    planConfirmed: (p: string) => `Your ${p} plan is confirmed.`, planStillFree: "Payment isn't confirmed yet. You can keep using Free.",
    planCheckFailed: "Could not check your plan. Try again shortly.",
    prefTitle: "Anything your agent should keep in mind?", prefSub: "Describe the personality and tone you like. You can leave it blank.",
    prefLabel: "Personality and tone · optional", prefPlaceholder: "e.g. Short and calm. Show the evidence first.",
    principleLabel: "Must-keep principles · one per line", principlePlaceholder: "e.g. Always ask before sending anything out.",
    prefHint: "Principles are followed exactly as written. Edit them anytime in the profile.",
    mailTitle: "Give your agent a mailbox?", mailSub: "A unique email address only your agent uses.",
    mailName: "Agent mailbox", mailSoon: "Coming soon", mailSoonBody: "Planned as a Pro-and-above benefit. You'll be able to turn it on in Settings.",
    mailIssued: "Issued", mailPending: "Not issued yet", mailPendingBody: "Included in your plan. Create the address and it appears here.",
    mailCreate: "Create mail address", mailCreating: "Creating…", mailPreparing: "Preparing", mailPreparingBody: "The address is being prepared. Use it from Settings once it's ready.",
    mailPlanOnly: "Available on Pro and above.", mailSeePlans: "See Free · Pro",
    mailQuota: (left: string, limit: string) => `Recipients left this month: ${left}/${limit} (one email to 3 people counts as 3)`,
    mailHint: "An address is shown only after the server issues it.",
    finish: `Go to ${name}`, stepsLabel: "Progress",
    saveFailed: "Could not save. Please try again.",
  };
}

type CardBusy = "installing" | "loggingIn" | "verifying";

export function FirstRunOnboarding({
  fingerprint,
  record,
  onRecord,
  onClose,
}: {
  fingerprint: string | undefined;
  record: FirstRunRecord;
  onRecord: (record: FirstRunRecord) => void;
  onClose: (navigateTo?: string) => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const api = ipc();

  const [step, setStep] = useState<FirstRunStep>(() => resumeStep(record) ?? "mailbox");
  const [profile, setProfile] = useState<OneProfile | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chrome
  const [consent, setConsent] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [keptSites, setKeptSites] = useState<number | null | undefined>(undefined);

  // AI
  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [cardBusy, setCardBusy] = useState<Partial<Record<AiCardId, CardBusy>>>({});
  const [cardNote, setCardNote] = useState<Partial<Record<AiCardId, string>>>({});
  const [connectFor, setConnectFor] = useState<AiCardSpec | null>(null);
  const [plansOpen, setPlansOpen] = useState(false);

  // Plans
  const [plans, setPlans] = useState<BillingPlanOffer[] | null>(null);
  const [plansError, setPlansError] = useState(false);
  const [balance, setBalance] = useState<HubCreditBalance | null>(null);
  const [checkoutState, setCheckoutState] = useState<"idle" | "opened" | "checking" | "confirmed" | "still-free" | "failed">("idle");

  // Preferences
  const [prefText, setPrefText] = useState("");
  const [principleText, setPrincipleText] = useState("");

  const displayName = (profile?.displayName ?? "").trim() || "One";
  const copy: Copy = useMemo(() => makeCopy(ko, displayName), [ko, displayName]);

  const persist = useCallback((next: FirstRunRecord) => {
    writeFirstRunRecord(window.localStorage, fingerprint, next);
    onRecord(next);
  }, [fingerprint, onRecord]);

  const recordRef = useRef(record);
  recordRef.current = record;

  const complete = useCallback((which: FirstRunStep, outcome: FirstRunOutcome) => {
    const next = recordStep(recordRef.current, which, outcome);
    persist(next);
    const index = FIRST_RUN_STEPS.indexOf(which);
    const following = FIRST_RUN_STEPS[index + 1];
    setError(null);
    if (following) setStep(following);
  }, [persist]);

  // Profile (name + prefs share one versioned record).
  const reloadProfile = useCallback(async () => {
    const next = await api?.oneProfile.get();
    if (next) {
      setProfile(next);
      setOnePersonaName(next.displayName);
    }
    return next ?? null;
  }, [api]);

  useEffect(() => {
    void reloadProfile().then((p) => {
      if (!p) return;
      setName(p.displayName === "One" ? "" : p.displayName);
      setPrefText(p.profileContext);
    }).catch(() => undefined);
  }, [reloadProfile]);

  // Escape closes the top popup only; the flow itself is left with Back/Skip.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (connectFor) { event.stopPropagation(); setConnectFor(null); return; }
      if (plansOpen) { event.stopPropagation(); setPlansOpen(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [connectFor, plansOpen]);

  /* ── 02 name ───────────────────────────── */
  const saveName = async () => {
    const clean = name.trim();
    if (!clean || !api) return;
    setBusy(true); setError(null);
    try {
      const current = await api.oneProfile.get();
      if (current.displayName !== clean) {
        await api.oneProfile.update({ expectedVersion: current.version, patch: { displayName: clean } });
      }
      const reread = await reloadProfile();
      if (reread?.displayName !== clean) throw new Error("not saved");
      complete("name", "done");
    } catch {
      setError(copy.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /* ── 03 Chrome ───────────────────────────── */
  const refreshKept = useCallback(async () => {
    try {
      const readiness = await api?.browserUi?.readiness();
      setKeptSites(readiness && readiness.state !== "unknown" ? readiness.connectSessionCount : null);
    } catch {
      setKeptSites(null);
    }
  }, [api]);

  useEffect(() => { if (step === "browser") void refreshKept(); }, [step, refreshKept]);

  /* ── 04 AI ───────────────────────────── */
  const refreshAi = useCallback(async (force: boolean) => {
    if (!api) return;
    const [nextRuntimes, nextUsage] = await Promise.all([
      api.runtime.detect(force).catch(() => null),
      api.usage.snapshot({ force }).catch(() => null),
    ]);
    if (nextRuntimes) setRuntimes(nextRuntimes);
    if (nextUsage) setUsage(nextUsage);
    return { runtimes: nextRuntimes, usage: nextUsage };
  }, [api]);

  useEffect(() => { if (step === "ai") void refreshAi(false); }, [step, refreshAi]);

  const cardStates = useMemo(() => {
    const out = {} as Record<AiCardId, AiCardState>;
    for (const spec of AI_CARDS) out[spec.id] = aiCardState(spec, runtimes, usage);
    return out;
  }, [runtimes, usage]);

  const runConnect = async (spec: AiCardSpec) => {
    setConnectFor(null);
    if (!api) return;
    const id = spec.id;
    const setBusyFor = (value: CardBusy | undefined) => setCardBusy((prev) => ({ ...prev, [id]: value }));
    setCardNote((prev) => ({ ...prev, [id]: undefined }));
    try {
      if (cardStates[id].login === "not-installed") {
        if (!spec.installable) return;
        setBusyFor("installing");
        const installed = await api.runtime.installCli(spec.runtime as "claude-code" | "codex");
        if (!installed?.ok) throw new Error(installed?.message || "install failed");
      }
      setBusyFor("loggingIn");
      const opened = await api.runtime.openCliLogin(spec.runtime);
      if (!opened?.ok) throw new Error(opened?.message || "login failed");
      setBusyFor("verifying");
      // Poll the same facts the card shows. Only a real provider answer turns it green.
      const deadline = Date.now() + 180_000;
      let lastUsageAt = 0;
      while (Date.now() < deadline) {
        const detected = await api.runtime.detect(true).catch(() => null);
        if (detected) setRuntimes(detected);
        let snapshot: UsageSnapshot | null = null;
        if (detected?.some((r) => r.kind === spec.runtime) && Date.now() - lastUsageAt > 6_000) {
          lastUsageAt = Date.now();
          snapshot = spec.usageProvider
            ? await api.usage.retry(spec.usageProvider).then((r) => r.snapshot).catch(() => null)
            : null;
          if (snapshot) setUsage(snapshot);
        }
        const state = aiCardState(spec, detected, snapshot);
        if (state.login === "signed-in") return;
        // Gemini/Antigravity has no usage endpoint: once installed and not flagged, stop
        // waiting — the card honestly stays "sign-in unverified".
        if (!spec.usageProvider && state.login === "installed-unverified") return;
        await new Promise((resolve) => window.setTimeout(resolve, 2_500));
      }
      setCardNote((prev) => ({ ...prev, [id]: copy.notVerified }));
    } catch (err) {
      setCardNote((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyFor(undefined);
    }
  };

  const onCardAction = (spec: AiCardSpec) => {
    const state = cardStates[spec.id];
    if (state.login === "signed-in" || cardBusy[spec.id]) return;
    if (state.login === "not-installed" && !spec.installable) {
      window.open(ANTIGRAVITY_URL, "_blank", "noopener,noreferrer");
      return;
    }
    setConnectFor(spec);
  };

  /* ── 06 plans ───────────────────────────── */
  const loadPlans = useCallback(async () => {
    setPlansError(false);
    setPlans(null);
    const catalog = await api?.billing.getPlans?.().catch(() => null);
    if (catalog && catalog.ok) setPlans(catalog.plans);
    else setPlansError(true);
  }, [api]);

  const loadBalance = useCallback(async () => {
    const next = await api?.billing.getCredits().catch(() => null);
    if (next) setBalance(next);
    return next ?? null;
  }, [api]);

  useEffect(() => {
    if (!plansOpen) return;
    void loadPlans();
    void loadBalance();
  }, [plansOpen, loadPlans, loadBalance]);

  const checkPlan = useCallback(async () => {
    setCheckoutState("checking");
    const next = await loadBalance();
    if (!next || !next.authenticated || next.error) { setCheckoutState("failed"); return; }
    setCheckoutState(next.plan && PAID_PLANS.has(next.plan) ? "confirmed" : "still-free");
  }, [loadBalance]);

  // Coming back from the browser after checkout re-reads the entitlement.
  useEffect(() => {
    if (checkoutState !== "opened") return;
    const onFocus = () => { void checkPlan(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkoutState, checkPlan]);

  const subscribePro = () => {
    openPricing();
    setCheckoutState("opened");
  };

  /* ── 07 preferences ───────────────────────────── */
  const savePreferences = async () => {
    if (!api) return;
    const context = prefText.trim();
    const principles = principleText.split("\n").map((line) => line.trim()).filter(Boolean);
    let current = await api.oneProfile.get().catch(() => null);
    if (!current) { setError(copy.saveFailed); return; }
    if (!context && principles.length === 0 && !current.profileContext) {
      complete("preferences", "skipped");
      return;
    }
    setBusy(true); setError(null);
    try {
      if (current.profileContext !== context) {
        current = await api.oneProfile.update({ expectedVersion: current.version, patch: { profileContext: context } });
      }
      const existing = new Set(current.operatingPrinciples.map((p) => p.content.trim()));
      for (const content of principles) {
        if (existing.has(content)) continue;
        current = await api.oneProfile.addPrinciple({
          expectedVersion: current.version,
          content: content.slice(0, 500),
          scope: "personal",
          scopeRef: null,
          // The person typed this into the field labelled "must-keep principles".
          approvedByUser: true,
        });
        existing.add(content);
      }
      const reread = await reloadProfile();
      const contents = new Set(reread?.operatingPrinciples.map((p) => p.content.trim()));
      if (!reread || reread.profileContext !== context || !principles.every((p) => contents.has(p.slice(0, 500)))) {
        throw new Error("not saved");
      }
      setPrincipleText("");
      complete("preferences", context || principles.length > 0 ? "done" : "skipped");
    } catch {
      setError(copy.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /* ── 08 mailbox ───────────────────────────── */
  // The server owns entitlement and address (agentMail.status). Nothing is decided here,
  // and "issued" is shown only after status() itself returns the address.
  const [mail, setMail] = useState<AgentMailStatus | null>(null);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailError, setMailError] = useState<string | null>(null);
  const loadMail = useCallback(async () => {
    const next = await api?.agentMail?.status().catch(() => null);
    setMail(next ?? { ok: false, code: "unavailable", message: "", status: null });
    return next ?? null;
  }, [api]);
  useEffect(() => { if (step === "mailbox") void loadMail(); }, [step, loadMail]);
  const mailOk = mail && mail.ok ? mail : null;
  const mailEntitlement = mailOk?.signedIn ? mailOk.entitlement : null;
  const mailbox = mailOk?.mailbox ?? null;
  const mailAddress = mailbox?.address ?? null;
  const mailActive = mailbox?.status === "active" && Boolean(mailAddress);
  const createMail = async () => {
    if (!api?.agentMail || mailBusy) return;
    setMailBusy(true); setMailError(null);
    try {
      const res = await api.agentMail.issue({ displayName });
      if (!res.ok) { setMailError(mailErrorText(ko ? "ko" : "en", res)); return; }
      await loadMail();
    } catch (err) {
      setMailError(mailErrorText(ko ? "ko" : "en", { code: err instanceof Error && err.name === "AbortError" ? "timeout" : "network" }));
    } finally {
      setMailBusy(false);
    }
  };

  const finish = () => {
    const withMail = recordStep(recordRef.current, "mailbox", mailActive ? "done" : "skipped");
    persist(recordCompleted(withMail));
    onClose("/one");
  };

  const goBack = () => {
    const index = FIRST_RUN_STEPS.indexOf(step);
    if (index > 0) { setError(null); setStep(FIRST_RUN_STEPS[index - 1]); }
  };

  const anyAiConnected = AI_CARDS.some((spec) => cardStates[spec.id].login === "signed-in");
  const aiBusy = Object.values(cardBusy).some(Boolean);

  const primary: { label: string; onClick: () => void; disabled?: boolean } = (() => {
    switch (step) {
      case "name": return { label: busy ? copy.saving : copy.next, onClick: () => void saveName(), disabled: busy || !name.trim() };
      case "browser": return importSummary
        ? { label: copy.next, onClick: () => complete("browser", "done") }
        : { label: copy.skip, onClick: () => complete("browser", "skipped") };
      case "ai": return { label: anyAiConnected ? copy.next : copy.skip, onClick: () => complete("ai", anyAiConnected ? "done" : "skipped"), disabled: aiBusy };
      case "preferences": return {
        label: busy ? copy.saving : (prefText.trim() || principleText.trim() ? copy.next : copy.skip),
        onClick: () => void savePreferences(),
        disabled: busy,
      };
      case "mailbox": return { label: copy.finish, onClick: finish };
    }
  })();

  const heading = {
    name: [copy.nameTitle, copy.nameSub],
    browser: [copy.browserTitle, copy.browserSub],
    ai: [copy.aiTitle, copy.aiSub],
    preferences: [copy.prefTitle, copy.prefSub],
    mailbox: [copy.mailTitle, copy.mailSub],
  }[step];

  const stepIndex = FIRST_RUN_STEPS.indexOf(step);
  const popupOpen = Boolean(connectFor || plansOpen);
  const freePlan = plans?.find((p) => p.id === "free");
  const proPlan = plans?.find((p) => p.id === "pro");
  const num = (n: number) => n.toLocaleString(ko ? "ko-KR" : "en-US");
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const currentPlanId = balance?.authenticated && !balance.error ? balance.plan : undefined;
  const onPaid = Boolean(currentPlanId && PAID_PLANS.has(currentPlanId));
  // Name the plan the server reports; fall back to the catalog name, never guess "Pro".
  const planLabel = (id: string | undefined) => plans?.find((p) => p.id === id)?.name
    ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : "Pro");

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div className={styles.drag}>
        <span className={styles.brand}><img src="/brand/agentlas-one-mark.png" alt="" />Agentlas</span>
      </div>
      <div className={styles.stage} aria-hidden={popupOpen || undefined} inert={popupOpen || undefined}>
        <header className={styles.head}>
          <h1 id="first-run-title">{heading[0]}</h1>
          <p>{heading[1]}</p>
        </header>

        <section className={styles.body}>
          {step === "name" && (
            <>
              <div className={styles.field}>
                <label htmlFor="first-run-name">{copy.nameLabel}</label>
                <input
                  id="first-run-name"
                  className={styles.input}
                  value={name}
                  maxLength={64}
                  autoFocus
                  placeholder={copy.namePlaceholder}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && name.trim()) void saveName(); }}
                />
              </div>
              <div className={styles.preview} aria-live="polite">{copy.namePreview(name.trim() || (ko ? "루나" : "Luna"))}</div>
              <p className={styles.hint}>{copy.nameHint}</p>
            </>
          )}

          {step === "browser" && (
            <>
              <div className={styles.setupCard}>
                <img src="/brand/browser/chrome.png" alt="" />
                <div className={styles.setupCopy}>
                  <strong>{copy.chromeName}</strong>
                  <small>{copy.chromeSub}</small>
                </div>
                <span className={styles.chip} data-tone={importSummary ? "ok" : undefined}>
                  {importSummary ? copy.chipImported : consent ? copy.chipConsented : copy.chipNone}
                </span>
              </div>
              <label className={styles.consent}>
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>{copy.consent}</span>
              </label>
              <button type="button" className={`${styles.secondary} ${styles.inlineAction}`} disabled={!consent} onClick={() => setImportOpen(true)}>
                {importSummary ? copy.reopenChrome : copy.connectChrome}
              </button>
              <ul className={styles.facts} aria-label={copy.chromeName}>
                <li><span>{copy.factConsent}</span><b>{consent ? copy.yes : copy.notYet}</b></li>
                <li><span>{copy.factImport}</span><b>{importSummary ? copy.yes : copy.notYet}</b></li>
                <li><span>{copy.factKept}</span><b>{keptSites === undefined ? copy.checking : keptSites === null ? copy.keptUnknown : copy.sitesKept(keptSites)}</b></li>
              </ul>
              {importSummary && <p className={styles.hint} role="status">{importSummary}</p>}
              {!importSummary && <p className={styles.hint}>{copy.browserHint}</p>}
            </>
          )}

          {step === "ai" && (
            <>
              <div className={styles.cards}>
                {AI_CARDS.map((spec) => {
                  const state = cardStates[spec.id];
                  const busyNow = cardBusy[spec.id];
                  const connected = state.login === "signed-in";
                  const lines: string[] = runtimes === null
                    ? [copy.checking]
                    : state.login === "not-installed"
                      ? [spec.installable ? copy.notInstalled : copy.noAutoInstall]
                      : state.login === "sign-in-required"
                        ? [copy.signInNeeded]
                        : state.login === "installed-unverified"
                          ? [copy.installed, spec.usageProvider ? copy.loginUnknown : copy.usageUnknown]
                          : [copy.signedIn, state.usage ? copy.remaining(state.usage.remainingPercent, usageWindowLabel(state.usage, ko)) : copy.usageUnknown];
                  const label = busyNow
                    ? copy[busyNow]
                    : connected
                      ? copy.connectedCta
                      : state.login === "not-installed" && !spec.installable
                        ? copy.installGuide
                        : copy.loginCta;
                  return (
                    <article key={spec.id} className={styles.aiCard} data-connected={connected}>
                      <img src={spec.logo} alt="" />
                      <strong>{copy.aiName[spec.id]}</strong>
                      <span className={styles.sub}>{copy.aiSub2[spec.id]}</span>
                      <div className={styles.status} data-tone={connected ? "ok" : state.login === "sign-in-required" ? "warn" : undefined} aria-live="polite">
                        {lines.map((line) => <span key={line}>{line}</span>)}
                      </div>
                      <button
                        type="button"
                        data-connected={connected}
                        aria-disabled={connected || undefined}
                        disabled={Boolean(busyNow)}
                        onClick={() => onCardAction(spec)}
                        aria-label={`${copy.aiName[spec.id]} — ${label}`}
                      >{label}</button>
                    </article>
                  );
                })}
                <article className={styles.aiCard}>
                  <img src="/brand/agentlas-one-mark.png" alt="" />
                  <strong>{copy.neverUsed}</strong>
                  <span className={styles.sub}>{copy.neverUsedSub}</span>
                  <div className={styles.status} />
                  <button type="button" onClick={() => setPlansOpen(true)}>{copy.seePlans}</button>
                </article>
              </div>
              {AI_CARDS.map((spec) => cardNote[spec.id] ? <p key={spec.id} className={styles.error} role="status">{`${copy.aiName[spec.id]}: ${cardNote[spec.id]}`}</p> : null)}
              <p className={styles.caption}>{copy.aiCaption}</p>
            </>
          )}

          {step === "preferences" && (
            <>
              <div className={styles.field}>
                <label htmlFor="first-run-pref">{copy.prefLabel}</label>
                <textarea id="first-run-pref" className={styles.textarea} rows={4} maxLength={4000} value={prefText} placeholder={copy.prefPlaceholder} onChange={(event) => setPrefText(event.target.value)} />
              </div>
              <div className={styles.field}>
                <label htmlFor="first-run-principles">{copy.principleLabel}</label>
                <textarea id="first-run-principles" className={styles.textarea} rows={2} value={principleText} placeholder={copy.principlePlaceholder} onChange={(event) => setPrincipleText(event.target.value)} />
              </div>
              <p className={styles.hint}>{copy.prefHint}</p>
            </>
          )}

          {step === "mailbox" && (
            <>
              <div className={styles.mailCard}>
                <div className={styles.mailRow}>
                  <div>
                    <strong>{copy.mailName}</strong>
                    <small>{mail === null
                      ? copy.checking
                      : !mailEntitlement
                        ? copy.mailSoonBody
                        : mailbox
                          ? (mailActive ? copy.mailQuota(num(mailEntitlement.remainingThisMonth), num(mailEntitlement.monthlyRecipientLimit)) : copy.mailPreparingBody)
                          : mailEntitlement.addressLimit > 0
                            ? `${copy.mailPendingBody} ${copy.mailQuota(num(mailEntitlement.monthlyRecipientLimit), num(mailEntitlement.monthlyRecipientLimit))}`
                            : copy.mailPlanOnly}</small>
                  </div>
                  <span className={styles.chip} data-tone={mailActive ? "ok" : undefined}>
                    {mail === null ? copy.checking : !mailEntitlement ? copy.mailSoon : mailbox ? (mailActive ? copy.mailIssued : copy.mailPreparing) : copy.mailPending}
                  </span>
                </div>
                {mailAddress && <div className={styles.mailAddress}>{mailAddress}</div>}
                {mailEntitlement && !mailbox && mailEntitlement.addressLimit > 0 && (
                  <button type="button" className={`${styles.primary} ${styles.inlineAction}`} disabled={mailBusy} onClick={() => void createMail()}>
                    {mailBusy ? copy.mailCreating : copy.mailCreate}
                  </button>
                )}
                {mailEntitlement && !mailbox && mailEntitlement.addressLimit <= 0 && (
                  <button type="button" className={`${styles.secondary} ${styles.inlineAction}`} onClick={() => setPlansOpen(true)}>{copy.mailSeePlans}</button>
                )}
              </div>
              {mailError && <p className={styles.error} role="alert">{mailError}</p>}
              <p className={styles.hint}>{copy.mailHint}</p>
            </>
          )}

          {error && <p className={styles.error} role="alert">{error}</p>}
        </section>
      </div>

      <footer className={styles.foot} aria-hidden={popupOpen || undefined} inert={popupOpen || undefined}>
        <button type="button" className={styles.secondary} onClick={goBack} disabled={stepIndex === 0 || busy} style={{ visibility: stepIndex === 0 ? "hidden" : undefined }}>{copy.back}</button>
        <ol className={styles.dots} aria-label={`${copy.stepsLabel} ${stepIndex + 1}/${FIRST_RUN_STEPS.length}`}>
          {FIRST_RUN_STEPS.map((item, index) => <li key={item} data-current={item === step} data-done={index < stepIndex} />)}
        </ol>
        <div className={styles.footActions}>
          <button type="button" className={styles.primary} onClick={primary.onClick} disabled={primary.disabled}>{primary.label}</button>
        </div>
      </footer>

      {importOpen && (
        <CredentialImportDialog
          ko={ko}
          onClose={() => setImportOpen(false)}
          onDone={(message) => {
            setImportOpen(false);
            setImportSummary(message || (ko ? "가져오기를 마쳤어요." : "Import finished."));
            void refreshKept();
          }}
        />
      )}

      {connectFor && (
        <div className={styles.scrim} role="presentation" onClick={() => setConnectFor(null)}>
          <div className={`${styles.glass} ${styles.connectModal}`} role="dialog" aria-modal="true" aria-labelledby="first-run-connect-title" onClick={(event) => event.stopPropagation()}>
            <button type="button" className={styles.close} onClick={() => setConnectFor(null)} aria-label={copy.close}>×</button>
            <img src={connectFor.logo} alt="" />
            <h2 id="first-run-connect-title">{copy.connectTitle(copy.aiFullName[connectFor.id])}</h2>
            <p>{cardStates[connectFor.id].login === "not-installed" ? copy.connectBody : copy.connectBodyInstalled}</p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.secondary} onClick={() => setConnectFor(null)}>{copy.cancel}</button>
              <button type="button" className={styles.primary} autoFocus onClick={() => void runConnect(connectFor)}>{copy.connectGo}</button>
            </div>
          </div>
        </div>
      )}

      {plansOpen && (
        <div className={styles.scrim} role="presentation">
          <div className={`${styles.glass} ${styles.planModal}`} role="dialog" aria-modal="true" aria-labelledby="first-run-plan-title">
            <button type="button" className={styles.close} onClick={() => setPlansOpen(false)} aria-label={copy.close}>×</button>
            <h2 id="first-run-plan-title">{copy.planTitle}</h2>
            <p>{copy.planSub}</p>
            {!plans && !plansError && <p className={styles.hint} role="status">{copy.loadingPlans}</p>}
            {plansError && (
              <div className={styles.planStatus} role="alert">
                {copy.planLoadFailed}
                <button type="button" className={styles.secondary} onClick={() => void loadPlans()}>{copy.retry}</button>
                <button type="button" className={styles.secondary} onClick={() => window.open(PRICING_URL, "_blank", "noopener,noreferrer")}>{copy.openWeb}</button>
              </div>
            )}
            {freePlan && proPlan && (
              <div className={styles.planGrid}>
                <section className={styles.planCard} data-selected={!onPaid} aria-label={freePlan.name}>
                  <h3>{freePlan.name}<span>{currentPlanId === "free" ? copy.planCurrent : copy.planDefault}</span></h3>
                  <div className={styles.price}>{money(freePlan.priceMonthly)}<small>{copy.perMonth}</small></div>
                  <ul>
                    <li>{copy.credits(num(freePlan.monthlyCredits))}</li>
                    <li>{copy.cloud(num(freePlan.cloudAgentLimit))}</li>
                    {/* projectAgentLimit 는 적지 않는다 — Work 에이전트는 무료라 웹 카탈로그가 모든 요금제에 같은 상한(32)을 준다. 요금제 혜택이 아니다. */}
                    <li>{copy.byo}</li>
                  </ul>
                  <button type="button" className={styles.secondary} autoFocus onClick={() => { setPlansOpen(false); if (step === "ai") complete("ai", anyAiConnected ? "done" : "skipped"); }}>{copy.freeCta}</button>
                </section>
                <section className={styles.planCard} data-kind="pro" data-selected={onPaid} aria-label={proPlan.name}>
                  <h3>{proPlan.name}{currentPlanId && PAID_PLANS.has(currentPlanId) ? <span>{copy.planCurrent}</span> : null}</h3>
                  <div className={styles.price}>{money(proPlan.priceMonthly)}<small>{copy.perYear(money(proPlan.priceAnnual))}</small></div>
                  <ul>
                    <li>{copy.credits(num(proPlan.monthlyCredits))}</li>
                    <li>{copy.cloud(num(proPlan.cloudAgentLimit))}</li>
                    {proPlan.aliveAgent && <li>{copy.alive}</li>}
                    <li>{copy.planMailSoon}</li>
                  </ul>
                  {onPaid
                    ? <button type="button" className={styles.secondary} disabled>{copy.proActive(planLabel(currentPlanId))}</button>
                    : <button type="button" className={styles.primary} onClick={subscribePro}>{copy.proCta}</button>}
                </section>
              </div>
            )}
            {checkoutState !== "idle" && (
              <div className={styles.planStatus} role="status">
                {checkoutState === "opened" && copy.checkoutOpened}
                {checkoutState === "checking" && copy.checking}
                {checkoutState === "confirmed" && copy.planConfirmed(planLabel(currentPlanId))}
                {checkoutState === "still-free" && copy.planStillFree}
                {checkoutState === "failed" && copy.planCheckFailed}
                {(checkoutState === "opened" || checkoutState === "still-free" || checkoutState === "failed") && (
                  <button type="button" className={styles.secondary} onClick={() => void checkPlan()}>{copy.checkPlan}</button>
                )}
              </div>
            )}
            {freePlan && proPlan && <small className={styles.planNote}>{copy.planNote}</small>}
          </div>
        </div>
      )}
    </div>
  );
}
