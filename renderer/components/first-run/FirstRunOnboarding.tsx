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
 *   AI         → chip grid (components/connect/RuntimeConnect): green only after a live
 *                auth probe; small "연결" → step popup (확인·설치·로그인·확인·완료);
 *                Agentlas → "Upgrade" (plan picker); the black button is always "다음으로".
 *   Pro        → the app-wide plan picker (PlanPickerHost); checkout is asked only after Upgrade
 *   mailbox    → agentMail.status() → shared/agent-mail-offer.ts: sign-in / not open yet /
 *                plan picker / choose address / preparing / active (address + allowance) /
 *                error + retry. The address is shown only after status() returns it.
 *
 * Research (owner rule: look before building):
 *   - Apple HIG, Onboarding: keep it fast and optional; ask for access in context,
 *     when its benefit can be shown — so Chrome/AI are skippable and explained.
 *   - Linear's first run: one idea per screen, a visible skip on each.
 *   - Raycast: skipped setup stays reachable later ("Show Onboarding") — here via
 *     Settings → "Run first-time setup again".
 */
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { IconUser, IconMonitor, IconCpu, IconSettings, IconAtSign } from "@/components/Icon";
import { useT } from "@/lib/i18n";
import type { AuthSession, HubCreditBalance, OneProfile, RuntimeStatus } from "@/lib/types";
import type { AgentMailStatus } from "@shared/agent-mail";
import { openPricing } from "@/components/UpgradeCta";
import { PLAN_CHANGED_EVENT } from "@/components/billing/PlanPickerModal";
import { agentMailOffer } from "@shared/agent-mail-offer";
import { FIRST_RUN_LOCAL_MODEL_KINDS, agentlasServingReady } from "@shared/runtime-connect";
import { BYOK_BACKENDS_ALL, type ByokBackend } from "@shared/models";
import { CredentialImportDialog } from "@/components/connect/CredentialImportDialog";
import { ChipGrid, ConnectChip, RUNTIME_CHIPS, RuntimeChip, RuntimeConnectPopup, connectCopy, useRuntimeAuth, type RuntimeChipSpec } from "@/components/connect/RuntimeConnect";
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
import { AgentMailOfferCard } from "@/components/one/mail/AgentMailOfferCard";
import styles from "./FirstRun.module.css";

const LEGACY_WORK_TOUR_KEY = "agentlas.work.firstRunOnboarding.v3";
/** Same bounds as shared/one-profile.ts validation (profileContext ≤4000, principle ≤500, ≤128 principles). */
const PROFILE_CONTEXT_MAX = 4_000;
const PRINCIPLE_MAX = 500;
const PRINCIPLES_MAX = 128;
/** 로컬 모델로 치는 감지 종류(ollama 는 이관용 투영이라 제외 — RuntimeReadiness 와 같은 규칙). */

/** Decide whether this account sees the flow, and keep that decision. */
async function loadOrClassify(accountFingerprint: string | undefined): Promise<FirstRunRecord> {
  const existing = readFirstRunRecord(window.localStorage, accountFingerprint);
  if (existing) return existing;
  const api = ipc();
  let legacyWorkTourSeen = false;
  try { legacyWorkTourSeen = window.localStorage.getItem(LEGACY_WORK_TOUR_KEY) === "1"; } catch { /* storage optional */ }
  const [profile, origin, chats, projects] = await Promise.all([
    api?.oneProfile?.get().catch(() => null) ?? null,
    api?.oneProfile?.origin?.().catch(() => null) ?? null,
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
  // 계정 하나 = One 하나: 이 기계에서 처음 One 을 갖는 계정은 다른 계정의 대화·프로젝트가
  // 있어도 첫 설정을 본다(자기 One 을 아직 꾸민 적이 없을 때만).
  const profileCustomized = Boolean(profile && (profile.displayName !== "One" || profile.profileContext || profile.operatingPrinciples.length > 0));
  const record = newFirstRunRecord(origin === "fresh" && !profileCustomized ? "new" : audience);
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
    // Account switch: never show the previous account's record/step while the new one loads.
    setChecked(false);
    setRecord(null);
    setOpen(false);
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
        key={fingerprint ?? "anonymous"}
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
    back: "이전", next: "다음으로", skip: "건너뛰기", saving: "저장하는 중…", checking: "확인하는 중…",
    nameTitle: "에이전트 이름을 정해주세요.", nameSub: "One 대신 이 이름으로 불리게 됩니다.",
    nameLabel: "에이전트 이름", namePlaceholder: "예: 루나", namePreview: (n: string) => `안녕하세요, ${n}입니다.`, namePreviewEmpty: "이름을 적으면 여기에서 첫인사를 미리 볼 수 있어요.",
    nameHint: "나중에 프로필에서 언제든 바꿀 수 있어요.",
    browserTitle: "Chrome을 연결할까요?", browserSub: "에이전트가 로그인된 서비스를 쓰며 일하기 쉬워져요.",
    chromeName: "Google Chrome", chromeSub: "이 기기의 Chrome 프로필에서 가져올 사이트를 고릅니다.",
    consent: "선택한 Chrome 프로필의 로그인 세션을 에이전트 전용 브라우저로 가져오는 데 동의합니다.",
    connectChrome: "Chrome 연결", reopenChrome: "더 가져오기",
    chipNone: "연결 전", chipImported: "가져옴", chipConsented: "동의함",
    factConsent: "동의", factImport: "가져오기", factKept: "로그인 유지",
    yes: "했어요", notYet: "아직", sitesKept: (n: number) => `${n}개 사이트`, keptUnknown: "확인 불가",
    browserHint: "건너뛰어도 브라우저 화면에서 나중에 연결할 수 있어요.",
    aiTitle: "어떤 AI를 쓰세요?", aiSub: "이미 로그인된 AI는 설치됨으로 보여요. 필요한 것만 하나씩 연결하세요.",
    aiCaption: "설치됨은 실제로 로그인 상태를 물어 확인한 뒤에만 표시돼요.",
    aiNeedOne: "일을 맡기려면 AI가 하나 이상 필요해요. 지금 건너뛰어도 설정에서 언제든 연결할 수 있어요.",
    localName: "로컬 모델", localSub: "이 기기에서 실행", localNone: "찾은 모델 없음", localHint: "로컬 모델은 앱의 로컬 모델 화면에서 받을 수 있어요.",
    agentlasName: "Agentlas", agentlasSub: "플랜 크레딧으로 실행", agentlasFree: "플랜 없음",
    prefTitle: "에이전트가 지켜야 할 것이 있나요?", prefSub: "선호하는 성격과 말투를 적어 주세요. 비워 두어도 돼요.",
    prefLabel: "성격과 말투 · 선택", prefPlaceholder: "예: 짧고 차분하게, 근거를 먼저 보여줘.",
    principleLabel: "꼭 지켜야 할 원칙 · 한 줄에 하나", principlePlaceholder: "예: 외부로 보내기 전에 꼭 물어봐.",
    prefHint: "원칙은 적은 그대로만 지켜요. 언제든 프로필에서 고칠 수 있어요.",
    mailTitle: "에이전트에게 메일함을 줄까요?", mailSub: "에이전트만 쓰는 고유한 메일 주소예요.",
    mailHint: "실제 주소는 서버에서 발급된 뒤에만 보여 드려요.",
    finish: `${name}에게 가기`, stepsLabel: "진행 단계",
    saveFailed: "저장하지 못했어요. 다시 시도해 주세요.",
  } : {
    back: "Back", next: "Next", skip: "Skip", saving: "Saving…", checking: "Checking…",
    nameTitle: "Name your agent.", nameSub: "Your agent goes by this name instead of One.",
    nameLabel: "Agent name", namePlaceholder: "e.g. Luna", namePreview: (n: string) => `Hi, I'm ${n}.`, namePreviewEmpty: "Type a name to preview its greeting here.",
    nameHint: "You can change it anytime in the profile.",
    browserTitle: "Connect Chrome?", browserSub: "Your agent can work in the services you're already signed in to.",
    chromeName: "Google Chrome", chromeSub: "Pick the sites to bring over from a Chrome profile on this computer.",
    consent: "I agree to copy sign-in sessions from the selected Chrome profile into the agent's own browser.",
    connectChrome: "Connect Chrome", reopenChrome: "Import more",
    chipNone: "Not connected", chipImported: "Imported", chipConsented: "Agreed",
    factConsent: "Consent", factImport: "Import", factKept: "Signed in",
    yes: "Done", notYet: "Not yet", sitesKept: (n: number) => `${n} site${n === 1 ? "" : "s"}`, keptUnknown: "Unknown",
    browserHint: "You can connect later from the Browser screen.",
    aiTitle: "Which AI do you use?", aiSub: "AI you're already signed in to shows as Installed. Connect the ones you need, one at a time.",
    aiCaption: "Installed appears only after we actually ask the AI whether you're signed in.",
    aiNeedOne: "You need at least one AI to run work. You can skip now and connect anytime in Settings.",
    localName: "Local models", localSub: "Runs on this computer", localNone: "No models found", localHint: "Get local models from the Local models screen in the app.",
    agentlasName: "Agentlas", agentlasSub: "Runs on plan credits", agentlasFree: "No plan",
    prefTitle: "Anything your agent should keep in mind?", prefSub: "Describe the personality and tone you like. You can leave it blank.",
    prefLabel: "Personality and tone · optional", prefPlaceholder: "e.g. Short and calm. Show the evidence first.",
    principleLabel: "Must-keep principles · one per line", principlePlaceholder: "e.g. Always ask before sending anything out.",
    prefHint: "Principles are followed exactly as written. Edit them anytime in the profile.",
    mailTitle: "Give your agent a mailbox?", mailSub: "A unique email address only your agent uses.",
    mailHint: "An address is shown only after the server issues it.",
    finish: `Go to ${name}`, stepsLabel: "Progress",
    saveFailed: "Could not save. Please try again.",
  };
}

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

  // AI — 칩 하나 = 연결할 것 하나. 초록은 살아 있는 확인(runtime.probeAuth) 뒤에만.
  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);
  const [credits, setCredits] = useState<HubCreditBalance | null | undefined>(undefined);
  const [connectFor, setConnectFor] = useState<RuntimeChipSpec | null>(null);
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [apiBackend, setApiBackend] = useState<ByokBackend>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [apiModel, setApiModel] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [apiModels, setApiModels] = useState<Array<{ id: string; label: string; tag?: string }>>([]);
  const [apiBusy, setApiBusy] = useState(false);
  const auth = useRuntimeAuth();

  const rootRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({ open: !importOpen && connectFor === null, roots: [rootRef], onDismiss: () => onClose() });

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
    const [nextRuntimes, nextCredits] = await Promise.all([
      api.runtime.detect(force).catch(() => null),
      api.billing?.getCredits().catch(() => null) ?? null,
    ]);
    if (nextRuntimes) setRuntimes(nextRuntimes);
    setCredits(nextCredits ?? null);
  }, [api]);

  useEffect(() => { if (step === "ai") void refreshAi(false); }, [step, refreshAi]);
  useEffect(() => {
    const onPlan = () => { if (step === "ai") void refreshAi(false); };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
  }, [step, refreshAi]);

  const localRuntimes = (runtimes ?? []).filter((r) => FIRST_RUN_LOCAL_MODEL_KINDS.has(r.kind) && (r.model || (r.availableModels?.length ?? 0) > 0));
  const apiRuntimes = (runtimes ?? []).filter((r) => r.kind === "byok"
    && r.credentialAccess?.status === "available" && Boolean(r.model?.trim()));
  const selectedApiRuntime = (runtimes ?? []).find((r) => r.kind === "byok" && r.backend === apiBackend);
  const apiKeyAvailable = selectedApiRuntime?.credentialAccess?.status === "available";
  const apiChoice = apiKeyAvailable && apiModel.trim() ? { backend: apiBackend, model: apiModel.trim() } : undefined;
  useEffect(() => {
    if (step !== "ai" || !api || !apiKeyAvailable) { setApiModels([]); return; }
    let disposed = false;
    void api.runtime.listModels({ kind: "byok", backend: apiBackend, availableModels: selectedApiRuntime?.availableModels })
      .then((models) => { if (!disposed) setApiModels(models); })
      .catch(() => { if (!disposed) setApiModels([]); });
    return () => { disposed = true; };
  }, [api, step, apiBackend, apiKeyAvailable, selectedApiRuntime?.availableModels]);
  useEffect(() => {
    if (apiBackend !== "custom" || !api) return;
    let disposed = false;
    void api.config.getCustomBaseUrl().then((url) => { if (!disposed) setApiEndpoint(url ?? ""); }).catch(() => {});
    return () => { disposed = true; };
  }, [api, apiBackend]);
  const saveFirstRunApi = async () => {
    if (!api || apiBusy || !apiKey.trim()) return;
    setApiBusy(true); setError(null);
    try {
      if (apiBackend === "custom") await api.config.setCustomBaseUrl(apiEndpoint.trim());
      await api.secrets.saveApiKey(apiBackend, apiKey.trim());
      setApiKey("");
      await refreshAi(true);
    } catch {
      setError(ko ? "API 연결을 저장하지 못했습니다. 키와 주소를 확인해 주세요." : "Could not save the API connection. Check the key and endpoint.");
    } finally { setApiBusy(false); }
  };
  const plan = credits?.authenticated && credits.plan && credits.plan.toLowerCase() !== "free" ? credits.plan : null;
  const agentlasReady = agentlasServingReady(credits);

  const checkLocal = async () => {
    if (!api) return;
    setLocalBusy(true); setLocalNote(null);
    const detected = await api.runtime.detect(true).catch(() => null);
    if (detected) setRuntimes(detected);
    const found = (detected ?? []).some((r) => FIRST_RUN_LOCAL_MODEL_KINDS.has(r.kind) && (r.model || (r.availableModels?.length ?? 0) > 0));
    if (!found) setLocalNote(copy.localHint);
    setLocalBusy(false);
  };

  /* ── 06 plans ───────────────────────────── */
  // The one app-wide paywall ("플랜 선택", PlanPickerHost) — owner 2026-09-29: every
  // "see plans" opens the same modal; checkout availability is asked only after Upgrade.
  const openPlans = () => openPricing("first-run");

  /* ── 07 preferences ───────────────────────────── */
  const savePreferences = async () => {
    if (!api) return;
    const context = prefText.trim().slice(0, PROFILE_CONTEXT_MAX).trim();
    // One normal form for compare, save and re-read: a line over the 500-char cap (or
    // one whose 500th char is a space) used to never match its saved copy, so every
    // retry added a duplicate and still reported "save failed" (pre-mortem 2026-09-26).
    const principles = [...new Set(principleText.split("\n").map((line) => line.trim().slice(0, PRINCIPLE_MAX).trim()).filter(Boolean))];
    let current = await api.oneProfile.get().catch(() => null);
    if (!current) { setError(copy.saveFailed); return; }
    if (!context && principles.length === 0 && !current.profileContext) {
      complete("preferences", "skipped");
      return;
    }
    // Refuse before writing anything, so a list over the cap never saves half of itself.
    const existing = new Set(current.operatingPrinciples.map((p) => p.content.trim()));
    const toAdd = principles.filter((content) => !existing.has(content));
    if (toAdd.length > Math.max(0, PRINCIPLES_MAX - current.operatingPrinciples.length)) { setError(copy.saveFailed); return; }
    setBusy(true); setError(null);
    try {
      if (current.profileContext !== context) {
        current = await api.oneProfile.update({ expectedVersion: current.version, patch: { profileContext: context } });
      }
      for (const content of toAdd) {
        current = await api.oneProfile.addPrinciple({
          expectedVersion: current.version,
          content,
          scope: "personal",
          scopeRef: null,
          // The person typed this into the field labelled "must-keep principles".
          approvedByUser: true,
        });
        existing.add(content);
      }
      const reread = await reloadProfile();
      const contents = new Set(reread?.operatingPrinciples.map((p) => p.content.trim()));
      if (!reread || reread.profileContext !== context || !principles.every((p) => contents.has(p))) {
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
  // The server owns entitlement and address (agentMail.status). Every machine state gets its
  // own label and next action (AgentMailOfferCard / shared/agent-mail-offer.ts) — the old
  // single "확인 필요" chip covered sign-out, server-not-open, failed read and no IPC alike.
  const [mail, setMail] = useState<AgentMailStatus | null>(null);
  const loadMail = useCallback(async () => {
    const next = await api?.agentMail?.status().catch(() => null);
    setMail(next ?? { ok: false, code: api?.agentMail ? "network" : "unavailable", message: "", status: null });
    return next ?? null;
  }, [api]);
  useEffect(() => { if (step === "mailbox") void loadMail(); }, [step, loadMail]);
  useEffect(() => {
    const onPlan = () => { if (step === "mailbox") void loadMail(); };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
  }, [step, loadMail]);
  const mailActive = agentMailOffer(mail).kind === "active";

  const finish = () => {
    const withMail = recordStep(recordRef.current, "mailbox", mailActive ? "done" : "skipped");
    persist(recordCompleted(withMail));
    onClose("/one");
  };

  const goBack = () => {
    const index = FIRST_RUN_STEPS.indexOf(step);
    if (index > 0) { setError(null); setStep(FIRST_RUN_STEPS[index - 1]); }
  };

  const anyAiConnected = RUNTIME_CHIPS.some((spec) => auth.probes[spec.kind]?.state === "signed-in") || localRuntimes.length > 0 || apiRuntimes.length > 0 || Boolean(apiChoice) || agentlasReady;
  // What was connected here becomes the first orchestrator and worker (owner 2026-10-06). The main
  // process reads the same facts itself and leaves roles a person already chose alone; a failed
  // seed must be read back before setup reports that the two roles are ready.
  const finishAi = async () => {
    if (busy || apiBusy) return;
    if (!anyAiConnected) { complete("ai", "skipped"); return; }
    setBusy(true); setError(null);
    try {
      const result = await api?.runtime.seedFirstRunRoles?.(apiChoice);
      if (!result || (!result.seeded && result.reason !== "owner-chosen")) throw new Error("first_run_roles_not_ready");
      complete("ai", "done");
    } catch { setError(ko ? "실행 모델을 배정하지 못했습니다. 연결과 모델을 확인하거나 건너뛰세요." : "Could not assign the execution models. Check the connection and model, or skip this step."); }
    finally { setBusy(false); }
  };
  const cc = useMemo(() => connectCopy(ko), [ko]);

  const primary: { label: string; onClick: () => void; disabled?: boolean } = (() => {
    switch (step) {
      case "name": return { label: busy ? copy.saving : copy.next, onClick: () => void saveName(), disabled: busy || !name.trim() };
      case "browser": return importSummary
        ? { label: copy.next, onClick: () => complete("browser", "done") }
        : { label: copy.skip, onClick: () => complete("browser", "skipped") };
      // 오너 2026-09-29: 큰 검정 버튼은 "다음으로" — 연결을 시작하지 않고, 몇 개를 연결했든(0개여도) 넘어간다.
      case "ai": return { label: busy ? copy.saving : copy.next, onClick: () => void finishAi(), disabled: busy || apiBusy };
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
  const popupOpen = Boolean(connectFor);

  return (
    <div ref={rootRef} className={styles.root} role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div className={styles.drag}>
        <span className={styles.brand}><img src="/brand/agentlas-one-mark.png" alt="" />Agentlas</span>
      </div>
      <div className={styles.stage} aria-hidden={popupOpen || undefined} inert={popupOpen || undefined}>
        {/* One fixed-height frame per flow, optically centred in .stage: the title stays put
            from step to step instead of each step re-centring at its own height (owner 2026-09-27). */}
        <div className={styles.frame}>
          <header className={styles.head}><span className={styles.stepMark} aria-hidden="true">{step === "name" ? <IconUser size={24}/> : step === "browser" ? <IconMonitor size={24}/> : step === "ai" ? <IconCpu size={24}/> : step === "preferences" ? <IconSettings size={24}/> : <IconAtSign size={24}/>}</span>
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
                {/* The placeholder "루나" is an example, not a value: with no name typed the
                    preview used it as if the agent were already called that (QA 2026-09-27). */}
                <div className={styles.preview} aria-live="polite" data-empty={name.trim() ? undefined : "true"}>{name.trim() ? copy.namePreview(name.trim()) : copy.namePreviewEmpty}</div>
                <details className={styles.help}><summary>{ko ? "이름 설정 안내" : "Name details"}</summary><p className={styles.hint}>{copy.nameHint}</p></details>
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
                {!importSummary && <details className={styles.help}><summary>{ko ? "브라우저 연결 안내" : "Browser details"}</summary><p className={styles.hint}>{copy.browserHint}</p></details>}
              </>
            )}

            {step === "ai" && (
              <>
                <ChipGrid label={copy.aiTitle}>
                  {RUNTIME_CHIPS.map((spec) => (
                    <RuntimeChip key={spec.kind} spec={spec} probe={auth.probes[spec.kind]} loaded={auth.loaded} copy={cc} onConnect={setConnectFor} />
                  ))}
                  <ConnectChip
                    logo="/brand/llm/ollama.svg"
                    name={copy.localName}
                    sub={copy.localSub}
                    ready={localRuntimes.length > 0}
                    badge={runtimes === null ? cc.checking : localRuntimes.length > 0 ? cc.installed : copy.localNone}
                    badgeTone={localRuntimes.length > 0 ? "ok" : undefined}
                    facts={localRuntimes.length > 0 ? [localRuntimes.map((r) => r.label ?? r.kind).join(" · ")] : []}
                    busy={localBusy}
                    action={localRuntimes.length > 0 ? undefined : { label: localBusy ? cc.checking : cc.connect, onClick: () => void checkLocal() }}
                  />
                  <ConnectChip
                    logo="/brand/agentlas-one-mark.png"
                    name={copy.agentlasName}
                    sub={copy.agentlasSub}
                    ready={agentlasReady}
                    badge={credits === undefined ? cc.checking : agentlasReady ? cc.available : copy.agentlasFree}
                    badgeTone={agentlasReady ? "ok" : undefined}
                    facts={agentlasReady && plan ? [plan] : []}
                    action={agentlasReady ? undefined : { label: cc.upgrade, onClick: openPlans, variant: "upgrade" }}
                  />
                </ChipGrid>
                <div className={styles.field}>
                  <label htmlFor="first-run-api-backend">{ko ? "API 키로 연결" : "Connect with an API key"}</label>
                  <select id="first-run-api-backend" className={styles.input} value={apiBackend} disabled={apiBusy || busy}
                    onChange={(event) => {
                      const backend = event.target.value as ByokBackend;
                      setApiBackend(backend); setApiKey(""); setApiModels([]);
                      setApiModel((runtimes ?? []).find((r) => r.kind === "byok" && r.backend === backend)?.model ?? "");
                    }}>
                    {BYOK_BACKENDS_ALL.map((backend) => <option key={backend} value={backend}>(API) {backend}</option>)}
                  </select>
                  {apiBackend === "custom" && <input aria-label={ko ? "API 주소" : "API endpoint"} className={styles.input}
                    value={apiEndpoint} onChange={(event) => setApiEndpoint(event.target.value)} disabled={apiBusy || busy} placeholder="https://…/v1" />}
                  <input type="password" autoComplete="off" aria-label={ko ? "API 키" : "API key"} className={styles.input}
                    value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={apiBusy || busy}
                    placeholder={apiKeyAvailable ? (ko ? "키 저장됨 · 바꾸려면 입력" : "Key saved · enter to replace") : "API key"} />
                  <button type="button" className={`${styles.secondary} ${styles.inlineAction}`} disabled={apiBusy || busy || !apiKey.trim()}
                    onClick={() => void saveFirstRunApi()}>{apiBusy ? cc.checking : (ko ? "키 연결" : "Connect key")}</button>
                  {apiKeyAvailable && <>
                    {apiModels.length > 0 && <select aria-label={ko ? "API 모델 선택" : "Select an API model"} className={styles.input}
                      value={apiModels.some((model) => model.id === apiModel) ? apiModel : ""} disabled={apiBusy || busy}
                      onChange={(event) => setApiModel(event.target.value)}>
                      <option value="">{ko ? "모델 선택" : "Choose a model"}</option>
                      {apiModels.map((model) => <option key={model.id} value={model.id}>(API) {model.label}</option>)}
                    </select>}
                    <input aria-label={ko ? "API 모델 ID" : "API model ID"} className={styles.input} maxLength={256}
                      value={apiModel} onChange={(event) => setApiModel(event.target.value)} disabled={apiBusy || busy} placeholder="Model ID" />
                    <p className={styles.hint}>{ko ? "목록에서 고르거나 모델 ID를 입력하세요. 다음 단계에서 지휘·작업 모델을 함께 배정합니다." : "Choose from the list or enter a model ID. The next step assigns both Orchestrator and Worker."}</p>
                  </>}
                </div>
                {apiRuntimes.length > 0 && <p className={styles.hint}>
                  {apiRuntimes.map((r) => `(API) ${r.label ?? r.backend} · ${r.model}`).join(" · ")}
                </p>}
                {localNote && <p className={styles.hint} role="status">{localNote}</p>}
                <p className={styles.caption}>{anyAiConnected ? copy.aiCaption : copy.aiNeedOne}</p>
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
                <details className={styles.help}><summary>{ko ? "맞춤 설정 안내" : "Preference details"}</summary><p className={styles.hint}>{copy.prefHint}</p></details>
              </>
            )}

            {step === "mailbox" && (
              <>
                <AgentMailOfferCard locale={ko ? "ko" : "en"} oneName={displayName} status={mail} reload={async () => { await loadMail(); }} />
                <details className={styles.help}><summary>{ko ? "메일함 안내" : "Mailbox details"}</summary><p className={styles.hint}>{copy.mailHint}</p></details>
              </>
            )}

            {error && <p className={styles.error} role="alert">{error}</p>}
          </section>
        </div>
      </div>

      <footer className={styles.foot} aria-hidden={popupOpen || undefined} inert={popupOpen || undefined}>
        <button type="button" className={styles.secondary} onClick={goBack} disabled={stepIndex === 0 || busy} style={{ visibility: stepIndex === 0 ? "hidden" : undefined }}>{copy.back}</button>
        <ol className={styles.dots} aria-label={`${copy.stepsLabel} ${stepIndex + 1}/${FIRST_RUN_STEPS.length}`}>
          {FIRST_RUN_STEPS.map((item, index) => <li key={item} data-current={item === step} data-done={index < stepIndex} />)}
        </ol>
        <div className={styles.footActions}>
          {step === "ai" && error && <button type="button" className={styles.secondary}
            onClick={() => complete("ai", "skipped")} disabled={busy || apiBusy}>
            {ko ? "나중에 연결" : "Connect later"}
          </button>}
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
        <RuntimeConnectPopup
          spec={connectFor}
          copy={cc}
          onClose={() => { setConnectFor(null); void auth.refresh(connectFor.kind); }}
          onDone={() => { setConnectFor(null); void auth.refresh(connectFor.kind); }}
        />
      )}

    </div>
  );
}
