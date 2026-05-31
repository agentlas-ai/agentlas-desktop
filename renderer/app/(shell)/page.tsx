// 홈 = 새 채팅 composer.
// Codex / Claude Code 데스크톱 스타일 — 중앙 큰 입력창 + 에이전트 셀렉터 + 제안 프롬프트.
// 입력 → 채팅 생성 → /chat?id=... 으로 이동하고 첫 메시지 자동 전송.
//
// 분기:
//   에이전트 0개 → /marketplace로 (페르소나 카드는 거기에 있음)
//   에이전트 있음 → composer 표시. 최근 채팅이 있어도 자동 이동하지 않음 (사용자가 새 채팅 시작하길 원함).
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { InstalledAgent, InstalledFirm } from "@/lib/types";
import { AgentPicker } from "@/components/AgentPicker";
import { PawLogo } from "@/components/PawLogo";
import { IconBuilding, IconSparkles, IconStore } from "@/components/Icon";

const SUGGESTIONS_KO = [
  "오늘 인스타 캡션 3개 만들어줘",
  "신상 제품 설명을 5개 변형으로 써줘",
  "이번 주 콘텐츠 일정 정리해줘",
  "고객 환불 문의 답변 초안",
];
const SUGGESTIONS_EN = [
  "Draft 3 Instagram captions for today",
  "Write 5 product description variants for a new item",
  "Plan this week's content schedule",
  "Draft a refund inquiry reply",
];

type TargetMode = "agent" | "firm";

export default function HomePage() {
  const router = useRouter();
  const { t, locale } = useT();
  const SUGGESTIONS = locale === "en" ? SUGGESTIONS_EN : SUGGESTIONS_KO;
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [mode, setMode] = useState<TargetMode>("agent");
  const [activeAgentId, setActiveAgentId] = useState<string>("");
  const [activeFirmId, setActiveFirmId] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const api = ipc();
    if (!api) {
      setAgents([]);
      return;
    }
    void (async () => {
      // 1) 첫 실행 마법사를 완료하지 않았으면 → /onboarding
      try {
        if (window.localStorage.getItem("agentlas.onboarded") !== "1") {
          router.replace("/onboarding");
          return;
        }
      } catch {
        // localStorage 불가 — 그냥 진행
      }

      // 2) 백엔드 연결 0개면 → /onboarding (백엔드 단계로)
      const runtimes = await api.runtime.detect();
      if (runtimes.length === 0) {
        router.replace("/onboarding");
        return;
      }

      // 3) 에이전트 0개면 → /marketplace
      const list = await api.team.list();
      if (list.length === 0) {
        router.replace("/marketplace");
        return;
      }

      setAgents(list);
      // 회사도 함께 로드
      const installedFirms = await api.firms.list();
      setFirms(installedFirms);
      // 마지막 사용한 에이전트 = 가장 최근 채팅의 에이전트
      const chats = await api.chats.listRecent(1);
      setActiveAgentId(chats[0]?.agentId ?? list[0].id);
      if (installedFirms[0]) setActiveFirmId(installedFirms[0].id);
      // 가장 최근 채팅이 회사 채팅이면 firm 모드로 기본 진입
      if (chats[0]?.firmId) {
        setMode("firm");
        setActiveFirmId(chats[0].firmId);
      }
      setTimeout(() => textareaRef.current?.focus(), 50);
    })();
  }, [router]);

  async function send(initialText?: string) {
    const api = ipc();
    if (!api || busy) return;
    if (mode === "firm" && !activeFirmId) return;
    if (mode === "agent" && !activeAgentId) return;
    const text = (initialText ?? input).trim();
    if (!text) {
      textareaRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const chat =
        mode === "firm"
          ? await api.chats.create({ firmId: activeFirmId })
          : await api.chats.create({ agentId: activeAgentId });
      navigate(`/chat?id=${chat.id}&prompt=${encodeURIComponent(text)}`);
    } finally {
      setBusy(false);
    }
  }

  if (agents === null) return null;
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeFirm = firms.find((f) => f.id === activeFirmId);

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        background: "var(--paper)",
        overflowY: "auto",
      }}
    >
      {/* 가짜 헤더 — 신호등 자리 확보 */}
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

      <div style={{ maxWidth: 720, width: "100%", textAlign: "center" }}>
        <PawLogo size={56} style={{ margin: "0 auto 16px" }} />
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-head)",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: -0.5,
            color: "var(--ink)",
          }}
        >
          {t("home.title")}
        </h1>
        <p
          style={{
            marginTop: 8,
            color: "var(--muted-deep)",
            fontSize: 13,
          }}
        >
          {mode === "firm" && activeFirm
            ? t("home.subtitle.firm", { name: pickLocalized(activeFirm, locale).name })
            : activeAgent
            ? t("home.subtitle.agent", { name: pickLocalized(activeAgent, locale).name })
            : t("home.subtitle.empty")}
        </p>

        {/* 개별 / 회사 모드 토글 */}
        <div
          className="titlebar-nodrag"
          style={{ marginTop: 16, display: "inline-flex", gap: 4, padding: 4, background: "var(--paper-2)", borderRadius: 999 }}
        >
          <button
            onClick={() => setMode("agent")}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: mode === "agent" ? "var(--paper)" : "transparent",
              boxShadow: mode === "agent" ? "var(--shadow-1)" : "none",
              color: mode === "agent" ? "var(--ink)" : "var(--muted-deep)",
              fontWeight: 600,
              fontSize: 12,
              border: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <IconSparkles size={12} />{t("home.mode.agent")}
          </button>
          <button
            onClick={() => setMode("firm")}
            disabled={firms.length === 0}
            title={
              firms.length === 0
                ? locale === "en" ? "Install a firm first" : "회사를 먼저 설치하세요"
                : locale === "en" ? "Command the firm's CEO" : "회사 CEO에게 명령"
            }
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: mode === "firm" ? "var(--paper)" : "transparent",
              boxShadow: mode === "firm" ? "var(--shadow-1)" : "none",
              color: mode === "firm" ? "var(--ink)" : firms.length === 0 ? "var(--muted)" : "var(--muted-deep)",
              fontWeight: 600,
              fontSize: 12,
              border: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              cursor: firms.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            <IconBuilding size={12} />{t("home.mode.firm")} {firms.length > 0 && `· ${firms.length}`}
          </button>
        </div>

        {/* Composer — glass */}
        <div
          className="titlebar-nodrag glass-lift"
          style={{
            marginTop: 32,
            borderRadius: 18,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            textAlign: "left",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t("home.placeholder")}
            rows={4}
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              fontSize: 15,
              lineHeight: 1.5,
              fontFamily: "var(--font-body)",
              resize: "none",
              background: "transparent",
              padding: "4px 6px",
              color: "var(--ink)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {mode === "firm" ? (
              <FirmSelector
                firms={firms}
                activeId={activeFirmId}
                onChange={setActiveFirmId}
              />
            ) : (
              <AgentPicker
                agents={agents}
                activeId={activeAgentId}
                onChange={setActiveAgentId}
                ariaLabel={locale === "en" ? "Agent" : "에이전트"}
                placement="top"
                maxButtonWidth={240}
                buttonStyle={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  boxShadow: "none",
                }}
              />
            )}
            <Link
              href={mode === "firm" ? "/marketplace?tab=firms" : "/marketplace"}
              style={{
                fontSize: 11,
                color: "var(--muted-deep)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid var(--paper-edge)",
              }}
              title={
                mode === "firm"
                  ? locale === "en" ? "More firms" : "더 많은 회사"
                  : locale === "en" ? "More agents" : "더 많은 에이전트"
              }
            >
              <IconStore size={12} />
              {t("home.market_link")}
            </Link>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 16px",
                borderRadius: 999,
                background: busy || !input.trim() ? "var(--paper-2)" : "var(--paper)",
                color: busy || !input.trim() ? "var(--muted-deep)" : "var(--ink)",
                fontWeight: 600,
                fontSize: 12.5,
                border: "1px solid var(--paper-edge)",
                boxShadow: busy || !input.trim() ? "none" : "var(--neu-raised)",
              }}
            >
              {busy ? t("home.starting") : t("home.send")}
              {!busy && input.trim() && (
                <>
                  <span className="kbd">⌘</span>
                  <span className="kbd">↵</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 제안 프롬프트 */}
        <div
          style={{
            marginTop: 16,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: "center",
          }}
          className="titlebar-nodrag"
        >
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => void send(s)}
              disabled={busy}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                background: "var(--paper-2)",
                border: "1px solid var(--paper-edge)",
                fontSize: 12,
                color: "var(--ink-soft)",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function FirmSelector({
  firms,
  activeId,
  onChange,
}: {
  firms: InstalledFirm[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  const { locale } = useT();
  const active = firms.find((f) => f.id === activeId);
  const activeLoc = active ? pickLocalized(active, locale) : null;
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 999,
        border: "1px solid var(--accent-soft)",
        background: "var(--fill-1)",
        fontSize: 12,
        cursor: "pointer",
        position: "relative",
      }}
      title={activeLoc?.tagline}
    >
      <IconBuilding size={12} style={{ color: "var(--accent)" }} />
      <span style={{ fontWeight: 700, color: "var(--accent)" }}>
        {activeLoc?.name ?? (locale === "en" ? "Pick a firm" : "회사 선택")}
      </span>
      <span style={{ fontSize: 10, color: "var(--muted-deep)" }}>CEO</span>
      <select
        value={activeId}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
        aria-label="Firm"
      >
        {firms.map((f) => {
          const loc = pickLocalized(f, locale);
          return (
            <option key={f.id} value={f.id}>
              {loc.name} — {loc.tagline}
            </option>
          );
        })}
      </select>
    </label>
  );
}
