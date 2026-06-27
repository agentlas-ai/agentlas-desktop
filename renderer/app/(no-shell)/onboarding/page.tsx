// 첫 실행 4단계 마법사 — 셸 없는 풀스크린.
// 1) 환영        — Agentlas 소개, BYOC 메시지
// 2) 백엔드 연결  — 감지된 CLI 표시 + BYOK 키 입력
// 3) 메뉴 투어    — 사이드바 5섹션 다이어그램 + 짧은 설명
// 4) 시작        — Marketplace로 이동해 첫 에이전트/회사 설치
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type { RuntimeBackend, RuntimeStatus } from "@/lib/types";
import { PawLogo } from "@/components/PawLogo";
import {
  IconApps,
  IconBolt,
  IconBrain,
  IconBuilding,
  IconChat,
  IconCheck,
  IconChevronRight,
  IconFolder,
  IconLayers,
  IconSettings,
  IconSparkles,
} from "@/components/Icon";
import { useT } from "@/lib/i18n";

type Step = 1 | 2 | 3 | 4;

const ONBOARDED_KEY = "agentlas.onboarded";

export default function OnboardingPage() {
  const router = useRouter();
  const { t } = useT();
  const [step, setStep] = useState<Step>(1);

  function next() {
    if (step < 4) setStep((s) => (s + 1) as Step);
    else finish();
  }
  function back() {
    if (step > 1) setStep((s) => (s - 1) as Step);
  }
  function finish() {
    try {
      window.localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      // ignore
    }
    router.replace("/marketplace");
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
      <div
        className="titlebar-drag"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 44,
        }}
      />

      {/* Progress bar */}
      <div
        className="titlebar-nodrag"
        style={{
          marginTop: 56,
          padding: "0 32px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          maxWidth: 720,
          margin: "56px auto 0",
          width: "100%",
        }}
      >
        {[1, 2, 3, 4].map((s) => (
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
          maxWidth: 720,
          margin: "0 auto",
          padding: "32px 32px 24px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {step === 1 && <StepWelcome />}
        {step === 2 && <StepBackend />}
        {step === 3 && <StepTour />}
        {step === 4 && <StepDone />}
      </section>

      <footer
        className="titlebar-nodrag"
        style={{
          maxWidth: 720,
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
          style={{
            fontSize: 12,
            color: "var(--muted-deep)",
            background: "transparent",
            border: "none",
          }}
        >
          {t("onb.step.skip")}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--muted)" }}>
          {step} / 4
        </span>
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
          }}
        >
          {step === 4 ? t("onb.step.start") : t("onb.step.next")}
          <IconChevronRight size={14} />
        </button>
      </footer>
    </main>
  );
}

// ── Step 1: 환영 + 핵심 포지셔닝 3가지 ─────────────────────
function StepWelcome() {
  const { t } = useT();
  return (
    <div style={{ textAlign: "center" }}>
      <PawLogo size={96} style={{ margin: "0 auto 24px" }} />
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-head)",
          fontSize: 36,
          fontWeight: 700,
          letterSpacing: 0,
        }}
      >
        {t("onb.welcome.title")}
      </h1>
      <p
        style={{
          marginTop: 12,
          color: "var(--ink-soft)",
          fontSize: 16,
          lineHeight: 1.6,
          whiteSpace: "pre-line",
        }}
      >
        {t("onb.welcome.tagline")}
      </p>
      <div
        style={{
          marginTop: 32,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          textAlign: "left",
        }}
      >
        <Highlight
          icon={<IconLayers size={18} />}
          title={t("pitch.threeInOne.title")}
          desc={t("pitch.threeInOne.desc")}
        />
        <Highlight
          icon={<IconBrain size={18} />}
          title={t("pitch.hermes.title")}
          desc={t("pitch.hermes.desc")}
        />
        <Highlight
          icon={<IconBuilding size={18} />}
          title={t("pitch.firm.title")}
          desc={t("pitch.firm.desc")}
        />
      </div>
      <p
        style={{
          marginTop: 20,
          fontSize: 11,
          color: "var(--muted-deep)",
        }}
      >
        {t("pitch.opensource")}
      </p>
    </div>
  );
}

function Highlight({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div
      className="glass-strong"
      style={{
        padding: 16,
        borderRadius: "var(--radius-md)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "var(--fill-1)",
          color: "var(--accent)",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 8,
        }}
      >
        {icon}
      </span>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 2, lineHeight: 1.5 }}>
        {desc}
      </div>
    </div>
  );
}

// BYOK는 클라우드 키 3종 (Ollama는 로컬이라 키 입력 없음 — 감지된 LLM 목록에 자동 표시).
type ByokBackend = "anthropic" | "openai" | "google" | "upstage" | "custom";

// ── Step 2: LLM 연결 ───────────────────────────────────────
function StepBackend() {
  const { t } = useT();
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
      <h2
        style={{
          margin: 0,
          fontFamily: "var(--font-head)",
          fontSize: 26,
          fontWeight: 700,
        }}
      >
        {t("onb.backend.title")}
      </h2>
      <p style={{ color: "var(--muted-deep)", fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>
        {t("onb.backend.desc")}
      </p>

      {loading ? (
        <div style={{ marginTop: 24, color: "var(--muted-deep)" }}>
          {t("onb.backend.detecting")}
        </div>
      ) : (
        <>
          {/* 감지된 CLI */}
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
            {t("onb.backend.detected_cli")}{" "}
            {statuses.filter((s) => s.kind !== "byok").length > 0 && "✓"}
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
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "8px 0 0",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
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
                        {labelOf(s.kind)} · {backendLabel(s.backend)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--muted-deep)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
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
              <strong style={{ fontSize: 12, minWidth: 90 }}>{backendLabel(b)}</strong>
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

          <p
            style={{
              marginTop: 14,
              fontSize: 11,
              color: "var(--muted-deep)",
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "var(--ink-soft)" }}>{t("onb.backend.ollama_title")}</strong>{" "}
            — {t("onb.backend.ollama_hint")}
          </p>

          <p
            style={{
              marginTop: 16,
              fontSize: 11,
              color: hasAnyBackend ? "var(--green-deep)" : "var(--muted-deep)",
              fontWeight: hasAnyBackend ? 600 : 400,
            }}
          >
            {hasAnyBackend
              ? t("onb.backend.ready")
              : t("onb.backend.tip")}
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
function backendLabel(b: RuntimeBackend) {
  return {
    anthropic: "Anthropic (Claude)",
    openai: "OpenAI",
    google: "Google",
    ollama: "로컬 모델",
    upstage: "Upstage Solar",
    custom: "Custom OpenAI",
  }[b];
}

// ── Step 3: 메뉴 투어 ─────────────────────────────────────
function StepTour() {
  const { t, locale } = useT();
  const ko = locale === "ko";
  // 상단 네비게이션(Dashboard/Workspace/Agent Forge/Studio/Hub/Environment)과 동일한 IA를 가르친다.
  // 기획안: 온보딩 투어와 앱 셸 투어가 서로 다른 IA를 가르치던 불일치를 제거하고, 소유 생애주기
  // (Build에서 만들고 → Agent에서 보유 → Workspace에서 가동)를 한 멘탈모델로 전달한다.
  const items = [
    {
      icon: <IconApps size={18} />,
      title: ko ? "Dashboard — 내 함대 관제탑" : "Dashboard — your fleet control tower",
      desc: ko ? "내가 소유한 일꾼과 승인 대기·키 상태를 한눈에." : "All your owned workers, pending approvals, and key status at a glance.",
    },
    {
      icon: <IconBolt size={18} />,
      title: ko ? "Agent Forge — 만들기(생산)" : "Agent Forge — build (produce)",
      desc: ko ? "자연어로 에이전트·팀을 만들어 내 폴더에 떨군다." : "Describe an agent or team; it lands as files in your folder.",
    },
    {
      icon: <IconSparkles size={18} />,
      title: ko ? "Agents — 보유·운영" : "Agents — own & operate",
      desc: ko ? "소유한 일꾼을 보고 신뢰·승인·진화시킨다." : "View owned workers; trust, approve, and evolve them.",
    },
    {
      icon: <IconChat size={18} />,
      title: ko ? "Workspace — 일 시키기(가동)" : "Workspace — put them to work",
      desc: ko ? "일꾼과 실제로 일하고 과정·비용을 통제한다." : "Actually work with them and control the process and cost.",
    },
    {
      icon: <IconFolder size={18} />,
      title: ko ? "Hub — 빌려쓰기" : "Hub — borrow",
      desc: ko ? "검증된 남의 에이전트를 빌려와 내 것으로." : "Borrow verified agents from others and make them yours.",
    },
    {
      icon: <IconSettings size={18} />,
      title: ko ? "Environment — 내 키·구독" : "Environment — your keys & subscription",
      desc: ko ? "내 키는 OS 키체인에. Agentlas 마진 ₩0." : "Your keys stay in the OS keychain. Agentlas margin $0.",
    },
  ];
  return (
    <div>
      <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 26, fontWeight: 700 }}>
        {t("onb.tour.title")}
      </h2>
      <p style={{ color: "var(--muted-deep)", fontSize: 14, marginTop: 8 }}>
        {t("onb.tour.desc")}
      </p>
      <div
        style={{
          marginTop: 20,
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
        }}
      >
        {items.map((it) => (
          <div
            key={it.title}
            style={{
              padding: 14,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              display: "flex",
              gap: 12,
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--fill-1)",
                color: "var(--accent)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {it.icon}
            </span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{it.title}</div>
              <div style={{ fontSize: 12, color: "var(--muted-deep)", marginTop: 2, lineHeight: 1.5 }}>
                {it.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 4: 시작 ──────────────────────────────────────────
function StepDone() {
  const { t } = useT();
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: "var(--fill-1)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 24px",
        }}
      >
        <IconCheck size={36} />
      </div>
      <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 28, fontWeight: 700 }}>
        {t("onb.done.title")}
      </h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 15, lineHeight: 1.6, marginTop: 12 }}>
        {t("onb.done.desc")}
        <br />
        {t("onb.done.personas.before")} <strong>{t("persona.shop")}</strong>,{" "}
        <strong>{t("persona.marketer")}</strong>, <strong>{t("persona.creator")}</strong>{" "}
        {t("onb.done.personas.after")}
      </p>
    </div>
  );
}
