// 첫 실행 온보딩 — 듀오링고식 learning path 5단계 (셸 없는 풀스크린).
//   1) 환영 + 목표 고르기   — 동기 먼저, 가입/연결을 아직 안 물어 마찰 0
//   2) 내 AI 연결            — 에이전트를 깨우는 "첫 레슨"(자동감지 + 구독/키). 검증된 StepBackend 로직 보존.
//   3) 첫 질문 = 살아있는 가이드 — 방금 연결한 "진짜" AI가 답함. 데모/폴백 응답 0. 미연결이면 연결 유도.
//   4) 첫 에이전트 채용      — 목표 기반 추천을 허브에서 원클릭 채용(team.install). 로그인 불필요(BYOC).
//   5) 졸업 + 스트릭         — 첫 일감 확인 + 스트릭 시작 + 다음 약속(중독 고리).
// 카피는 아래 COPY 상수에 모아 검증본(Gemini 3 Pro 재작성 + 적대적 검증 통과)과 1:1 대응시킨다.
// 전문용어는 제품어(에이전트·스킬·허브·스톰브레이커)만 노출, 엔지니어 용어 배제. 크레딧/퀘스트는 지갑 백엔드가 없어 1차 제외.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { RuntimeBackend, RuntimeStatus } from "@/lib/types";
import { PawLogo } from "@/components/PawLogo";
import {
  IconApps,
  IconBolt,
  IconBrain,
  IconChat,
  IconCheck,
  IconChevronRight,
  IconSparkles,
} from "@/components/Icon";
import { useT } from "@/lib/i18n";

type Step = 1 | 2 | 3 | 4 | 5;
interface L {
  ko: string;
  en: string;
}
const tx = (c: L, ko: boolean) => (ko ? c.ko : c.en);

// ── 검증된 카피 (Gemini 3 Pro 재작성 → 3렌즈 적대적 검증 통과) ──
const COPY = {
  goal: {
    title: { ko: "Agentlas에 오신 걸 환영해요", en: "Welcome to Agentlas" },
    subtitle: {
      ko: "3분이면 첫 에이전트가 준비돼요.\n오늘은 어떤 일을 해보고 싶으세요?",
      en: "In 3 minutes, your first agent will be ready.\nFirst, what do you want to do today?",
    },
    hint: {
      ko: "선택에 맞춰 다음 단계를 안내해 드려요. 나중에 언제든 바꿀 수 있어요.",
      en: "Your choice personalizes the next steps. You can change it anytime.",
    },
  },
  goals: {
    write: { ko: "글쓰기와 콘텐츠 만들기", en: "Writing and content" },
    research: { ko: "자료 조사와 요약", en: "Research and summary" },
    shop: { ko: "쇼핑몰과 판매 운영", en: "Shop and selling" },
    explore: { ko: "가볍게 둘러보기", en: "Just exploring" },
  } as Record<string, L>,
  connect: {
    title: { ko: "에이전트를 깨워주세요", en: "Wake up your agents" },
    subtitle: {
      ko: "에이전트에게는 생각할 두뇌가 필요해요. 원래 쓰던 Claude, ChatGPT, Gemini를 연결해보세요. 추가 요금 없이 내 구독 그대로 사용해요.",
      en: "Agents need a brain to think. Connect the Claude, ChatGPT, or Gemini you already use. There is no extra charge — it uses your own subscription.",
    },
    done: {
      ko: "연결을 마쳤어요. 다음 단계에서 방금 깨운 에이전트에게 바로 말을 걸어보세요.",
      en: "Connected. Next, you can start talking to the agent you just woke up.",
    },
    todo: {
      ko: "지금 연결하면 다음 단계에서 살아있는 가이드를 만날 수 있어요. 건너뛰고 먼저 둘러봐도 괜찮아요.",
      en: "Connect now to meet your live guide in the next step. You can also skip and explore first.",
    },
  },
  guide: {
    title: { ko: "가이드에게 자유롭게 물어보세요", en: "Ask your guide anything" },
    subtitle: {
      ko: "방금 연결된 진짜 AI예요. 궁금한 점을 아무거나 물어보세요. 살아있는 첫 에이전트가 바로 대답해 줄 거예요.",
      en: "This is a real, live AI you just connected. Ask anything. Your first Agentlas agent is right here, ready to answer.",
    },
    noruntime: {
      ko: "가이드를 깨우려면 AI를 먼저 연결해야 해요. '이전'으로 돌아가 한 번만 연결하면, 여기서 살아있는 가이드와 바로 대화할 수 있어요.",
      en: "Connect an AI first to wake your guide. Tap 'Back' and connect once, then you can chat with the live guide right here.",
    },
    error: {
      ko: "가이드를 준비하는 데 문제가 생겼어요. 일단 건너뛰고 계속 진행해도 괜찮아요.",
      en: "We had trouble starting your guide. You can skip for now and keep going.",
    },
    ex1: { ko: "에이전트가 무엇인가요?", en: "What is an agent?" },
    ex2: { ko: "스킬과 허브는 어떻게 쓰나요?", en: "How do I use skills and the Hub?" },
    ex3: { ko: "여기서 뭐부터 해보는 게 좋을까요?", en: "What should I try doing first?" },
    loading: { ko: "가이드를 깨우는 중...", en: "Waking your guide..." },
    empty: { ko: "예시를 선택하거나 직접 질문을 입력해 보세요.", en: "Choose an example or type your own question." },
    placeholder: { ko: "메시지를 적어주세요...", en: "Type a message..." },
    send: { ko: "보내기", en: "Send" },
  },
  hire: {
    title: { ko: "첫 에이전트를 데려오세요", en: "Bring in your first agent" },
    subtitle: {
      ko: "선택한 목표에 맞는 에이전트예요. 마음에 드는 에이전트를 데려오면 바로 일을 맡길 수 있어요. 더 많은 에이전트는 허브에서 언제든 만날 수 있어요.",
      en: "We picked these based on your goal. Bring one in and put it to work right away. You can always discover more in the Hub.",
    },
    loading: { ko: "맞춤 에이전트를 찾는 중이에요...", en: "Finding the best agents for you..." },
    empty: {
      ko: "지금은 추천을 불러오지 못했어요. 시작 후에 허브에서 직접 둘러보세요.",
      en: "We couldn't load recommendations right now. You can explore the Hub after we finish.",
    },
    btnHire: { ko: "데려오기", en: "Hire" },
    btnHired: { ko: "데려왔어요", en: "Hired" },
    btnHiring: { ko: "데려오는 중...", en: "Hiring..." },
  },
  grad: {
    title: { ko: "준비가 끝났어요. 이제 진짜 시작이에요", en: "You are ready. Let's begin" },
    subtitle: {
      ko: "지금까지 아주 잘하셨어요. 이제 대시보드로 이동해서 에이전트에게 일을 맡겨보세요.",
      en: "Great work getting set up. Head to your dashboard to give your agent its first task.",
    },
    check1: { ko: "내 AI를 연결하고 에이전트 깨우기", en: "Connected your AI and woke an agent" },
    check2: { ko: "살아있는 가이드와 첫 대화 나누기", en: "Talked to your live guide" },
    check3: { ko: "내게 필요한 첫 에이전트 데려오기", en: "Brought in your first agent" },
    streak: {
      ko: "오늘부터 1일 차 시작 — 내일도 오면 기록이 이어져요 🔥",
      en: "Day 1 streak started — see you tomorrow to keep it going 🔥",
    },
  },
} as const;

// grad.nudge는 JSX 강조가 섞여 컴포넌트에서 직접 렌더한다.

const ONBOARDED_KEY = "agentlas.onboarded";
const GOAL_KEY = "agentlas.onboarding.goal";
const STREAK_KEY = "agentlas.streak";
const MILESTONE_KEY = "agentlas.milestones";

// 목표 → 추천 에이전트 슬러그(SEED_LISTINGS 기준). 둘러보기(explore)는 빈 목록 → 대표 추천으로 폴백.
interface Goal {
  id: string;
  icon: React.ReactNode;
  slugs: string[];
}
const GOALS: Goal[] = [
  { id: "write", icon: <IconChat size={20} />, slugs: ["marketer-content-writer", "shop-product-writer"] },
  { id: "research", icon: <IconBrain size={20} />, slugs: ["marketer-seo-researcher", "marketer-analytics-reader"] },
  { id: "shop", icon: <IconApps size={20} />, slugs: ["shop-product-writer", "shop-cs-responder"] },
  { id: "explore", icon: <IconSparkles size={20} />, slugs: [] },
];

// 마일스톤 1회성 기록(로컬). 가짜 보상이 아니라 실제 달성 사실만 표시.
function recordMilestone(id: string) {
  try {
    const raw = window.localStorage.getItem(MILESTONE_KEY);
    const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    set.add(id);
    window.localStorage.setItem(MILESTONE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

// 스트릭 = 연속 사용일. 오늘 첫 진입이면 어제 기록 여부로 연속 카운트. 가짜가 아닌 실제 로컬 진행도.
function bumpStreak(): number {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const raw = window.localStorage.getItem(STREAK_KEY);
    const prev = raw ? (JSON.parse(raw) as { count: number; last: string }) : { count: 0, last: "" };
    if (prev.last === today) return prev.count || 1;
    const count = prev.last === yesterday ? (prev.count || 0) + 1 : 1;
    window.localStorage.setItem(STREAK_KEY, JSON.stringify({ count, last: today }));
    return count;
  } catch {
    return 1;
  }
}

export default function OnboardingPage() {
  const router = useRouter();
  const { t } = useT();
  const [step, setStep] = useState<Step>(1);
  const [goalId, setGoalId] = useState<string | null>(null);

  const goal = GOALS.find((g) => g.id === goalId) ?? null;

  function next() {
    if (step < 5) setStep((s) => (s + 1) as Step);
    else finish();
  }
  function back() {
    if (step > 1) setStep((s) => (s - 1) as Step);
  }
  function selectGoal(id: string) {
    setGoalId(id);
    try {
      window.localStorage.setItem(GOAL_KEY, id);
    } catch {
      // ignore
    }
  }
  function finish() {
    try {
      window.localStorage.setItem(ONBOARDED_KEY, "1");
      recordMilestone("onboarded");
      bumpStreak();
    } catch {
      // ignore
    }
    router.replace("/dashboard");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--paper)",
        overflowY: "auto",
      }}
    >
      <div className="titlebar-drag" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 44 }} />

      {/* Progress bar (5 nodes) */}
      <div
        className="titlebar-nodrag"
        style={{
          padding: "0 32px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          maxWidth: 760,
          margin: "56px auto 0",
          width: "100%",
        }}
      >
        {[1, 2, 3, 4, 5].map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 999,
              background: s <= step ? "var(--accent)" : "var(--paper-edge)",
              transition: "background 0.2s",
            }}
          />
        ))}
      </div>

      <section
        className="titlebar-nodrag"
        style={{
          flex: 1,
          maxWidth: 760,
          margin: "0 auto",
          padding: "28px 32px 24px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {step === 1 && <StepGoal goalId={goalId} onSelect={selectGoal} />}
        {step === 2 && <StepConnect />}
        {step === 3 && <StepGuide />}
        {step === 4 && <StepHire goal={goal} />}
        {step === 5 && <StepGraduate />}
      </section>

      <footer
        className="titlebar-nodrag"
        style={{
          maxWidth: 760,
          margin: "0 auto",
          width: "100%",
          padding: "16px 32px 40px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <button
          onClick={back}
          disabled={step === 1}
          style={{
            padding: "10px 20px",
            borderRadius: 999,
            background: "transparent",
            color: step === 1 ? "var(--muted)" : "var(--ink-soft)",
            fontWeight: 600,
            fontSize: 13,
            border: "1px solid var(--paper-edge)",
            cursor: step === 1 ? "default" : "pointer",
          }}
        >
          {t("onb.step.prev")}
        </button>
        <button
          onClick={finish}
          style={{ fontSize: 12, color: "var(--muted-deep)", background: "transparent", border: "none", cursor: "pointer" }}
        >
          {t("onb.step.skip")}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{step} / 5</span>
        <button
          onClick={next}
          style={{
            padding: "10px 24px",
            borderRadius: 999,
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 13,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          {step === 5 ? t("onb.step.start") : t("onb.step.next")}
          <IconChevronRight size={14} />
        </button>
      </footer>
    </main>
  );
}

// ── Step 1: 환영 + 목표 고르기 ─────────────────────────────
function StepGoal({ goalId, onSelect }: { goalId: string | null; onSelect: (id: string) => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  return (
    <div style={{ textAlign: "center" }}>
      <PawLogo size={84} style={{ margin: "0 auto 20px" }} />
      <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 32, fontWeight: 700 }}>{tx(COPY.goal.title, ko)}</h1>
      <p style={{ marginTop: 12, color: "var(--ink-soft)", fontSize: 16, lineHeight: 1.6, whiteSpace: "pre-line" }}>
        {tx(COPY.goal.subtitle, ko)}
      </p>
      <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, textAlign: "left" }}>
        {GOALS.map((g) => {
          const active = goalId === g.id;
          return (
            <button
              key={g.id}
              onClick={() => onSelect(g.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "16px 18px",
                borderRadius: "var(--radius-md)",
                border: active ? "2px solid var(--accent)" : "1px solid var(--paper-edge)",
                background: active ? "var(--fill-1)" : "var(--paper)",
                boxShadow: active ? "none" : "var(--neu-raised)",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
            >
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: "var(--fill-1)",
                  color: "var(--accent)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {g.icon}
              </span>
              <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--ink)" }}>{tx(COPY.goals[g.id], ko)}</span>
              {active && (
                <span style={{ marginLeft: "auto", color: "var(--accent)" }}>
                  <IconCheck size={18} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p style={{ marginTop: 18, fontSize: 11, color: "var(--muted-deep)" }}>{tx(COPY.goal.hint, ko)}</p>
    </div>
  );
}

// BYOK 클라우드 키 3종 + Upstage/Custom (Ollama는 로컬이라 키 입력 없음 — 감지 목록에 자동 표시).
type ByokBackend = "anthropic" | "openai" | "google" | "upstage" | "custom";

// ── Step 2: 내 AI 연결 (에이전트 깨우기) — 검증된 StepBackend 로직 보존 ───
function StepConnect() {
  const { t, locale } = useT();
  const ko = locale === "ko";
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<ByokBackend, string>>({
    anthropic: "",
    openai: "",
    google: "",
    upstage: "",
    custom: "",
  });
  const [savedKey, setSavedKey] = useState<Record<ByokBackend, boolean>>({
    anthropic: false,
    openai: false,
    google: false,
    upstage: false,
    custom: false,
  });
  const [draftCustomBaseUrl, setDraftCustomBaseUrl] = useState("");
  const [saving, setSaving] = useState<ByokBackend | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ ok: boolean; message: string; command?: string } | null>(null);

  async function refresh() {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    const [s, a, o, g, u, c, baseUrl] = await Promise.all([
      api.runtime.detect(),
      api.secrets.hasApiKey("anthropic"),
      api.secrets.hasApiKey("openai"),
      api.secrets.hasApiKey("google"),
      api.secrets.hasApiKey("upstage"),
      api.secrets.hasApiKey("custom"),
      api.config.getCustomBaseUrl(),
    ]);
    setStatuses(s);
    setSavedKey({ anthropic: a, openai: o, google: g, upstage: u, custom: c });
    setDraftCustomBaseUrl(baseUrl);
    setLoading(false);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function saveKey(backend: ByokBackend) {
    const api = ipc();
    if (!api || !draft[backend].trim()) return;
    setSaving(backend);
    try {
      await api.secrets.saveApiKey(backend, draft[backend]);
      if (backend === "custom") {
        await api.config.setCustomBaseUrl(draftCustomBaseUrl);
      }
      setDraft((d) => ({ ...d, [backend]: "" }));
      await refresh();
    } finally {
      setSaving(null);
    }
  }

  async function installClaude() {
    const api = ipc();
    if (!api) return;
    setInstalling(true);
    setInstallResult(null);
    try {
      const r = (await api.runtime.installCli("claude-code")) as { ok: boolean; message: string; command?: string };
      setInstallResult(r);
      if (r?.ok) setTimeout(() => void refresh(), 2500);
    } catch (e) {
      setInstallResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstalling(false);
    }
  }

  const hasAnyBackend =
    statuses.length > 0 || savedKey.anthropic || savedKey.openai || savedKey.google || savedKey.upstage || savedKey.custom;

  return (
    <div>
      <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 26, fontWeight: 700 }}>{tx(COPY.connect.title, ko)}</h2>
      <p style={{ color: "var(--muted-deep)", fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>{tx(COPY.connect.subtitle, ko)}</p>

      {loading ? (
        <div style={{ marginTop: 24, color: "var(--muted-deep)" }}>{t("onb.backend.detecting")}</div>
      ) : (
        <>
          {/* 감지된 LLM */}
          <h3
            style={{
              marginTop: 24,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--muted-deep)",
            }}
          >
            {t("onb.backend.detected_cli")} {statuses.filter((s) => s.kind !== "byok").length > 0 && "✓"}
          </h3>
          {statuses.filter((s) => s.kind !== "byok").length === 0 ? (
            <div
              style={{
                padding: 16,
                background: "var(--paper-2)",
                border: "1px dashed var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                fontSize: 14,
                lineHeight: 1.6,
                color: "var(--ink-soft)",
                marginTop: 8,
              }}
            >
              {t("onb.backend.no_cli")}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <button
                  onClick={() => void installClaude()}
                  disabled={installing}
                  className="titlebar-nodrag"
                  style={{
                    alignSelf: "flex-start",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 18px",
                    borderRadius: 10,
                    border: "none",
                    background: installing ? "var(--fill-3)" : "var(--accent)",
                    color: installing ? "var(--muted)" : "#fff",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: installing ? "default" : "pointer",
                  }}
                >
                  {installing ? t("onb.backend.installing") : t("onb.backend.install_claude")}
                </button>
                {installResult && (
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: installResult.ok ? "var(--green-deep)" : "var(--ink-soft)" }}>
                    {installResult.ok ? t("onb.backend.install_ok") : t("onb.backend.install_fail")}
                    {!installResult.ok && installResult.command && (
                      <code
                        style={{
                          display: "block",
                          marginTop: 6,
                          padding: "8px 10px",
                          background: "var(--fill-2)",
                          borderRadius: 8,
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          userSelect: "all",
                        }}
                      >
                        {installResult.command}
                      </code>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
              {statuses
                .filter((s) => s.kind !== "byok")
                .map((s) => (
                  <li
                    key={s.source}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      background: "var(--paper)",
                      border: "1px solid var(--paper-edge)",
                      borderRadius: "var(--radius-md)",
                    }}
                  >
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        background: "var(--fill-1)",
                        color: "var(--green-deep)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <IconCheck size={14} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {labelOf(s.kind)} · {backendLabel(s.backend, locale)}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted-deep)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.source}
                        {s.version && ` · v${s.version}`}
                      </div>
                    </div>
                  </li>
                ))}
            </ul>
          )}

          {/* BYOK */}
          <h3
            style={{
              marginTop: 28,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--muted-deep)",
            }}
          >
            {t("onb.backend.byok_title")}
          </h3>
          {(["anthropic", "openai", "google", "upstage", "custom"] as ByokBackend[]).map((b) => (
            <div
              key={b}
              style={{
                padding: 12,
                marginTop: 8,
                background: "var(--paper)",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <strong style={{ fontSize: 12, minWidth: 90 }}>{backendLabel(b, locale)}</strong>
              {b === "custom" && (
                <input
                  type="text"
                  value={draftCustomBaseUrl}
                  onChange={(e) => setDraftCustomBaseUrl(e.target.value)}
                  placeholder="Base URL (e.g. https://api.deepseek.com/v1)"
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper-2)",
                    outline: "none",
                  }}
                />
              )}
              <input
                type="password"
                value={draft[b]}
                onChange={(e) => setDraft((d) => ({ ...d, [b]: e.target.value }))}
                placeholder={savedKey[b] ? `✓ ${t("onb.backend.saved")}` : "sk-..."}
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--paper-2)",
                  outline: "none",
                }}
              />
              <button
                onClick={() => void saveKey(b)}
                disabled={!draft[b].trim() || saving === b}
                style={{
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  borderRadius: "var(--radius-md)",
                  background: draft[b].trim() ? "var(--paper)" : "var(--paper-2)",
                  color: draft[b].trim() ? "var(--ink)" : "var(--muted-deep)",
                  border: "1px solid var(--paper-edge)",
                  boxShadow: draft[b].trim() ? "var(--neu-raised)" : "none",
                }}
              >
                {t("onb.backend.byok_save")}
              </button>
            </div>
          ))}

          <p style={{ marginTop: 14, fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--ink-soft)" }}>{t("onb.backend.ollama_title")}</strong> — {t("onb.backend.ollama_hint")}
          </p>

          <p
            style={{
              marginTop: 16,
              fontSize: 12,
              color: hasAnyBackend ? "var(--green-deep)" : "var(--muted-deep)",
              fontWeight: hasAnyBackend ? 600 : 400,
            }}
          >
            {hasAnyBackend ? tx(COPY.connect.done, ko) : tx(COPY.connect.todo, ko)}
          </p>
        </>
      )}
    </div>
  );
}

function labelOf(kind: string) {
  return (
    { "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini", byok: "API", ollama: "Ollama" }[
      kind as "claude-code" | "codex" | "gemini" | "byok" | "ollama"
    ] ?? kind
  );
}
function backendLabel(b: RuntimeBackend, locale: "ko" | "en" = "ko") {
  return {
    anthropic: "Anthropic (Claude)",
    openai: "OpenAI",
    google: "Google",
    ollama: locale === "ko" ? "로컬 모델" : "Local models",
    upstage: "Upstage Solar",
    custom: "Custom OpenAI",
  }[b];
}

// ── Step 3: 첫 질문 = 살아있는 가이드 (진짜 LLM, 폴백/데모 0) ──────
type GuidePhase = "loading" | "ready" | "no-runtime" | "error";
interface GuideMsg {
  role: "user" | "assistant";
  text: string;
}

function StepGuide() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [phase, setPhase] = useState<GuidePhase>("loading");
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<GuideMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const subRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 마운트: 런타임 감지 → 있으면 가이드 채팅 생성. 미연결이면 가짜로 답하지 않고 연결 유도.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = ipc();
      if (!api) {
        if (alive) setPhase("error");
        return;
      }
      try {
        const rt = await api.runtime.detect();
        if (!alive) return;
        if (!rt || rt.length === 0) {
          setPhase("no-runtime");
          return;
        }
        const chat = await api.chats.create({ title: ko ? "온보딩 가이드" : "Onboarding guide" });
        if (!alive) return;
        setChatId(chat.id);
        setPhase("ready");
      } catch {
        if (alive) setPhase("error");
      }
    })();
    return () => {
      alive = false;
      subRef.current?.();
    };
  }, [ko]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const ask = useCallback(
    async (prompt: string) => {
      const api = ipc();
      const events = ipcEvents();
      const text = prompt.trim();
      if (!api || !events || !chatId || busy || !text) return;
      setInput("");
      setMsgs((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }]);
      setBusy(true);
      try {
        const { runId } = await api.invoke.run({ chatId, userPrompt: text, locale });
        const channel = api.invoke.eventChannel(runId);
        subRef.current?.();
        subRef.current = events.on(channel, (ev) => {
          if (ev.kind === "partial" || ev.kind === "final") {
            if (ev.text != null) {
              setMsgs((m) => {
                const c = [...m];
                for (let i = c.length - 1; i >= 0; i--) {
                  if (c[i].role === "assistant") {
                    c[i] = { ...c[i], text: ev.text as string };
                    break;
                  }
                }
                return c;
              });
            }
            if (ev.kind === "final") setBusy(false);
          } else if (ev.kind === "error") {
            setMsgs((m) => {
              const c = [...m];
              for (let i = c.length - 1; i >= 0; i--) {
                if (c[i].role === "assistant") {
                  c[i] = { ...c[i], text: `⚠️ ${ev.error?.message ?? (ko ? "오류가 났어요" : "Something went wrong")}` };
                  break;
                }
              }
              return c;
            });
            setBusy(false);
          }
        });
        recordMilestone("first-guide-question");
      } catch {
        setBusy(false);
      }
    },
    [chatId, busy, locale, ko],
  );

  const examples = [tx(COPY.guide.ex1, ko), tx(COPY.guide.ex2, ko), tx(COPY.guide.ex3, ko)];

  return (
    <div>
      <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 26, fontWeight: 700 }}>{tx(COPY.guide.title, ko)}</h2>
      <p style={{ color: "var(--muted-deep)", fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>{tx(COPY.guide.subtitle, ko)}</p>

      {phase === "no-runtime" && (
        <div
          style={{
            marginTop: 20,
            padding: 18,
            background: "var(--paper-2)",
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--ink-soft)",
          }}
        >
          {tx(COPY.guide.noruntime, ko)}
        </div>
      )}

      {phase === "error" && (
        <div style={{ marginTop: 20, padding: 18, color: "var(--muted-deep)", fontSize: 14 }}>{tx(COPY.guide.error, ko)}</div>
      )}

      {(phase === "loading" || phase === "ready") && (
        <div
          style={{
            marginTop: 18,
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-lg)",
            background: "var(--paper)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            height: 320,
          }}
        >
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.length === 0 && (
              <div style={{ margin: "auto", textAlign: "center", color: "var(--muted-deep)", fontSize: 13 }}>
                {phase === "loading" ? tx(COPY.guide.loading, ko) : tx(COPY.guide.empty, ko)}
              </div>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "82%",
                  padding: "9px 13px",
                  borderRadius: 14,
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  background: m.role === "user" ? "var(--accent)" : "var(--fill-1)",
                  color: m.role === "user" ? "#fff" : "var(--ink)",
                  borderBottomRightRadius: m.role === "user" ? 4 : 14,
                  borderBottomLeftRadius: m.role === "user" ? 14 : 4,
                }}
              >
                {m.text || (busy && m.role === "assistant" ? "…" : "")}
              </div>
            ))}
          </div>

          {/* 예시 칩 */}
          {phase === "ready" && msgs.length === 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 10px" }}>
              {examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => void ask(ex)}
                  disabled={busy}
                  className="titlebar-nodrag"
                  style={{
                    fontSize: 12,
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: "1px solid var(--paper-edge)",
                    background: "var(--paper-2)",
                    color: "var(--ink-soft)",
                    cursor: busy ? "default" : "pointer",
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          {/* 입력바 */}
          <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--paper-edge)", background: "var(--paper-2)" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void ask(input)}
              disabled={phase !== "ready" || busy}
              placeholder={tx(COPY.guide.placeholder, ko)}
              className="titlebar-nodrag"
              style={{
                flex: 1,
                padding: "9px 12px",
                fontSize: 13.5,
                border: "1px solid var(--paper-edge)",
                borderRadius: 10,
                background: "var(--paper)",
                outline: "none",
                color: "var(--ink)",
              }}
            />
            <button
              onClick={() => void ask(input)}
              disabled={phase !== "ready" || busy || !input.trim()}
              className="titlebar-nodrag"
              style={{
                padding: "9px 16px",
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 10,
                border: "none",
                background: phase === "ready" && input.trim() && !busy ? "var(--accent)" : "var(--fill-3)",
                color: phase === "ready" && input.trim() && !busy ? "#fff" : "var(--muted)",
                cursor: phase === "ready" && input.trim() && !busy ? "pointer" : "default",
              }}
            >
              {busy ? "…" : tx(COPY.guide.send, ko)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 4: 첫 에이전트 채용 (team.install — 로그인 불필요/BYOC) ──────
interface RecAgent {
  slug: string;
  name: string;
  tagline: string;
}

function StepHire({ goal }: { goal: Goal | null }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [recs, setRecs] = useState<RecAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [hired, setHired] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = ipc();
      if (!api) {
        if (alive) setLoading(false);
        return;
      }
      try {
        const [listings, installed] = await Promise.all([api.marketplace.search(""), api.team.list()]);
        if (!alive) return;
        setHired(new Set(installed.map((a) => a.slug)));
        const wanted = goal?.slugs ?? [];
        const bySlug = (slug: string) => listings.find((l) => l.slug === slug);
        // 목표 매칭 우선, 부족하면 단일 에이전트 리스팅으로 채움(회사/번들 제외 — 첫 채용은 단일이 쉬움).
        const picked: RecAgent[] = [];
        for (const slug of wanted) {
          const l = bySlug(slug);
          if (l) picked.push({ slug: l.slug, name: ko ? l.name : l.nameEn || l.name, tagline: ko ? l.tagline : l.taglineEn || l.tagline });
        }
        if (picked.length < 3) {
          for (const l of listings) {
            if (picked.length >= 3) break;
            if (picked.some((p) => p.slug === l.slug)) continue;
            if (l.slug.startsWith("firm-")) continue;
            picked.push({ slug: l.slug, name: ko ? l.name : l.nameEn || l.name, tagline: ko ? l.tagline : l.taglineEn || l.tagline });
          }
        }
        setRecs(picked.slice(0, 3));
      } catch {
        // 추천을 못 불러와도 단계는 진행 가능 (채용은 선택).
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [goal, ko]);

  async function hire(slug: string) {
    const api = ipc();
    if (!api || installing) return;
    setInstalling(slug);
    try {
      await api.team.install(slug);
      setHired((h) => new Set(h).add(slug));
      recordMilestone("first-hire");
    } catch {
      // 설치 실패 시 무시 — 다음에 허브에서 다시 시도 가능.
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div>
      <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 26, fontWeight: 700 }}>{tx(COPY.hire.title, ko)}</h2>
      <p style={{ color: "var(--muted-deep)", fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>{tx(COPY.hire.subtitle, ko)}</p>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {loading && <div style={{ color: "var(--muted-deep)", fontSize: 13 }}>{tx(COPY.hire.loading, ko)}</div>}
        {!loading && recs.length === 0 && <div style={{ color: "var(--muted-deep)", fontSize: 13 }}>{tx(COPY.hire.empty, ko)}</div>}
        {recs.map((r) => {
          const isHired = hired.has(r.slug);
          const isInstalling = installing === r.slug;
          return (
            <div
              key={r.slug}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: 16,
                border: isHired ? "1px solid var(--green-deep)" : "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                background: "var(--paper)",
              }}
            >
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: "var(--fill-1)",
                  color: "var(--accent)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <IconBolt size={20} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted-deep)", marginTop: 2, lineHeight: 1.45 }}>{r.tagline}</div>
              </div>
              <button
                onClick={() => void hire(r.slug)}
                disabled={isHired || isInstalling}
                className="titlebar-nodrag"
                style={{
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 999,
                  border: isHired ? "1px solid var(--green-deep)" : "none",
                  background: isHired ? "transparent" : "var(--accent)",
                  color: isHired ? "var(--green-deep)" : "#fff",
                  cursor: isHired || isInstalling ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                {isHired ? (
                  <>
                    <IconCheck size={14} /> {tx(COPY.hire.btnHired, ko)}
                  </>
                ) : isInstalling ? (
                  tx(COPY.hire.btnHiring, ko)
                ) : (
                  tx(COPY.hire.btnHire, ko)
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 5: 졸업 + 스트릭 ──────────────────────────────────
function StepGraduate() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [done, setDone] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MILESTONE_KEY);
      setDone(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      // ignore
    }
  }, []);

  const askedGuide = done.includes("first-guide-question");
  const hired = done.includes("first-hire");

  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          width: 76,
          height: 76,
          borderRadius: "50%",
          background: "var(--fill-1)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 20px",
        }}
      >
        <IconCheck size={34} />
      </div>
      <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 28, fontWeight: 700 }}>{tx(COPY.grad.title, ko)}</h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 15, lineHeight: 1.6, marginTop: 12 }}>{tx(COPY.grad.subtitle, ko)}</p>

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 8, textAlign: "left", maxWidth: 380, margin: "22px auto 0" }}>
        <CheckRow done label={tx(COPY.grad.check1, ko)} />
        <CheckRow done={askedGuide} label={tx(COPY.grad.check2, ko)} />
        <CheckRow done={hired} label={tx(COPY.grad.check3, ko)} />
      </div>

      <div
        style={{
          marginTop: 22,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
          borderRadius: 999,
          background: "var(--fill-1)",
          color: "var(--accent)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <IconSparkles size={16} />
        {tx(COPY.grad.streak, ko)}
      </div>

      <p style={{ marginTop: 18, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.6 }}>
        {ko ? (
          <>
            길을 잃으면 언제든 <IconChat size={12} style={{ verticalAlign: "-1px" }} /> 가이드에게 물어보세요. Agentlas의 에이전트들은{" "}
            <strong style={{ color: "var(--ink-soft)" }}>대화할수록 당신을 기억해요</strong> — 매번 처음부터 다시 설명할 필요가 없어요.
          </>
        ) : (
          <>
            Stuck? Just ask your guide anytime. And remember, these agents{" "}
            <strong style={{ color: "var(--ink-soft)" }}>learn about you the more you talk to them</strong> — you never have to start from zero again.
          </>
        )}
      </p>
    </div>
  );
}

function CheckRow({ done, label }: { done?: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: "var(--radius-md)", background: "var(--paper)", border: "1px solid var(--paper-edge)" }}>
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          background: done ? "var(--fill-1)" : "var(--paper-2)",
          color: done ? "var(--green-deep)" : "var(--muted)",
          border: done ? "none" : "1px solid var(--paper-edge)",
        }}
      >
        {done ? <IconCheck size={13} /> : ""}
      </span>
      <span style={{ fontSize: 13, color: done ? "var(--ink)" : "var(--muted-deep)" }}>{label}</span>
    </div>
  );
}
