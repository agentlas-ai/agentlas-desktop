// 새 자동화 — 개별 에이전트 또는 회사(CEO) 타깃 선택 가능.
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { InstalledAgent, InstalledFirm } from "@/lib/types";
import { IconBuilding, IconSparkles } from "@/components/Icon";

type TargetType = "agent" | "firm";

export default function NewAutomationPage() {
  const router = useRouter();
  const { t, locale } = useT();
  const PRESETS = [
    { label: t("auto.preset.daily9"), value: "daily-09:00" },
    { label: t("auto.preset.weekday9"), value: "weekday-09:00" },
    { label: t("auto.preset.weekly_mon10"), value: "weekly-mon-10:00" },
    { label: t("auto.preset.monthly1"), value: "monthly-1-09:00" },
  ];
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState(PRESETS[0].value);
  const [prompt, setPrompt] = useState("");
  const [targetType, setTargetType] = useState<TargetType>("firm");
  const [targetId, setTargetId] = useState<string>("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void (async () => {
      const [ag, fm] = await Promise.all([api.team.list(), api.firms.list()]);
      const visible = visibleAgents(ag);
      setAgents(visible);
      setFirms(fm);
      // 회사가 있으면 첫 회사 선택, 없으면 첫 에이전트
      if (fm[0]) {
        setTargetType("firm");
        setTargetId(fm[0].id);
      } else if (visible[0]) {
        setTargetType("agent");
        setTargetId(visible[0].id);
      }
    })();
  }, []);

  // targetType 바뀌면 그 타입의 첫 항목 자동 선택
  useEffect(() => {
    setTargetId(targetType === "agent" ? agents[0]?.id ?? "" : firms[0]?.id ?? "");
    setError("");
  }, [targetType, agents, firms]);

  async function submit() {
    const api = ipc();
    if (!api || !name.trim() || busy) return;
    const validTarget = targetType === "firm"
      ? firms.some((f) => f.id === targetId)
      : agents.some((a) => a.id === targetId);
    if (!validTarget) {
      setError(locale === "ko" ? "선택한 대상이 없습니다. 다른 대상 탭을 선택하세요." : "No valid target is selected. Choose another target tab.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.automations.create({
        name: name.trim(),
        scheduleHuman: schedule,
        targetType,
        targetId,
        promptTemplate: prompt.trim() || "오늘 할 일 요약해줘",
      });
      navigate("/automation", "replace");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!name.trim() && !!targetId && !busy;

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          minHeight: 56,
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700 }}>
          {t("auto.new")}
        </h1>
      </header>

      <section
        className="titlebar-nodrag"
        data-tour-id="automation.form"
        style={{ maxWidth: 640, margin: "32px auto", padding: "0 24px" }}
      >
        <Field label={t("auto.field.name")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("auto.field.name.placeholder")}
            autoFocus
            style={inputStyle}
          />
        </Field>

        <Field label={t("auto.field.schedule")}>
          <select value={schedule} onChange={(e) => setSchedule(e.target.value)} style={inputStyle}>
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("auto.field.target")}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <TabBtn
              active={targetType === "firm"}
              onClick={() => setTargetType("firm")}
              icon={<IconBuilding size={13} />}
              label={`${t("auto.target.firm")} (${firms.length})`}
              disabled={firms.length === 0}
            />
            <TabBtn
              active={targetType === "agent"}
              onClick={() => setTargetType("agent")}
              icon={<IconSparkles size={13} />}
              label={`${t("auto.target.agent")} (${agents.length})`}
              disabled={agents.length === 0}
            />
          </div>
          {targetType === "firm" ? (
            firms.length === 0 ? (
              <Empty>{t("auto.empty_firms")}</Empty>
            ) : (
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
                {firms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {pickLocalized(f, locale).name} — CEO
                  </option>
                ))}
              </select>
            )
          ) : agents.length === 0 ? (
            <Empty>{t("auto.empty_agents")}</Empty>
          ) : (
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
              {agents.map((a) => {
                const loc = pickLocalized(a, locale);
                return (
                  <option key={a.id} value={a.id}>
                    {loc.name} — {loc.tagline}
                  </option>
                );
              })}
            </select>
          )}
        </Field>

        <Field label={t("auto.field.prompt")} hint={t("auto.field.prompt.hint")}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            style={{ ...inputStyle, fontFamily: "var(--font-body)", resize: "vertical" }}
            placeholder={
              targetType === "firm"
                ? t("auto.placeholder.firm")
                : t("auto.placeholder.agent")
            }
          />
        </Field>

        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            style={{
              padding: "10px 18px",
              borderRadius: "var(--radius-md)",
              background: canSubmit ? "var(--paper)" : "var(--paper-2)",
              color: canSubmit ? "var(--ink)" : "var(--muted-deep)",
              fontWeight: 600,
              fontSize: 13,
              border: "1px solid var(--paper-edge)",
              boxShadow: canSubmit ? "var(--neu-raised)" : "none",
            }}
          >
            {t("project.btn.create")}
          </button>
          <button
            onClick={() => router.back()}
            style={{
              padding: "10px 18px",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              fontSize: 13,
              color: "var(--ink-soft)",
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </section>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: "10px 14px",
        borderRadius: "var(--radius-md)",
        background: active ? "var(--fill-1)" : disabled ? "var(--paper-2)" : "var(--paper)",
        color: active ? "var(--accent)" : disabled ? "var(--muted)" : "var(--ink-soft)",
        border: active ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        fontWeight: 600,
        fontSize: 13,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.62 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 12,
        background: "var(--paper)",
        border: "1px dashed var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        color: "var(--muted-deep)",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ink-soft)",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <p style={{ fontSize: 11, color: "var(--muted-deep)", margin: "6px 2px 0", lineHeight: 1.5 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 13,
  outline: "none",
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  border: "1px solid color-mix(in srgb, var(--red-deep, #b4533a) 28%, var(--paper-edge))",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--red-deep, #b4533a) 8%, var(--paper))",
  color: "var(--red-deep, #b4533a)",
  padding: "9px 11px",
  fontSize: 12,
  lineHeight: 1.45,
};
