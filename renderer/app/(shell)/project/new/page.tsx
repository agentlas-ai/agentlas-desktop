// 새 프로젝트 만들기 — 이름 + 컨텍스트 노트(선택) + 기본 에이전트(선택).
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { InstalledAgent } from "@/lib/types";

export default function NewProjectPage() {
  const router = useRouter();
  const { t, locale } = useT();
  const [name, setName] = useState("");
  const [contextNote, setContextNote] = useState("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  const [folderPath, setFolderPath] = useState<string>("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.team.list().then((list) => setAgents(visibleAgents(list)));
  }, []);

  async function submit() {
    const api = ipc();
    if (!api || !name.trim() || busy) return;
    setBusy(true);
    try {
      const project = await api.projects.create({
        name: name.trim(),
        contextNote: contextNote.trim() || null,
        defaultAgentId: defaultAgentId || null,
        folderPath: folderPath || null,
      });
      navigate(`/project/detail?id=${project.id}`, "replace");
    } finally {
      setBusy(false);
    }
  }

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
          {t("project.new.title")}
        </h1>
      </header>

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 640, margin: "32px auto", padding: "0 24px" }}
      >
        <Field label={t("project.field.name")} hint={t("project.field.name.hint")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            style={inputStyle}
            placeholder={t("project.field.name")}
          />
        </Field>

        <Field
          label={t("project.field.context")}
          hint={t("project.field.context.hint")}
        >
          <textarea
            value={contextNote}
            onChange={(e) => setContextNote(e.target.value)}
            rows={4}
            style={{ ...inputStyle, fontFamily: "var(--font-body)", resize: "vertical" }}
          />
        </Field>

        <Field label={t("project.field.default_agent")} hint={t("project.field.default_agent.hint")}>
          <select
            value={defaultAgentId}
            onChange={(e) => setDefaultAgentId(e.target.value)}
            style={inputStyle}
          >
            <option value="">{t("common.skip_select")}</option>
            {agents.map((a) => {
              const loc = pickLocalized(a, locale);
              return (
                <option key={a.id} value={a.id}>
                  {loc.name} — {loc.tagline}
                </option>
              );
            })}
          </select>
        </Field>

        <Field
          label={locale === "ko" ? "작업 폴더 (선택)" : "Working folder (optional)"}
          hint={
            locale === "ko"
              ? "이 프로젝트의 채팅은 이 폴더에서 실행되고 .agentlas 메모리와 ontology inbox가 활성화됩니다."
              : "Chats in this project run in this folder; .agentlas memory and ontology inbox activate here."
          }
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              readOnly
              value={folderPath}
              placeholder={locale === "ko" ? "폴더 미선택" : "No folder selected"}
              style={{ ...inputStyle, flex: 1, color: folderPath ? "var(--ink)" : "var(--muted-deep)" }}
            />
            <button
              type="button"
              onClick={async () => {
                const api = ipc();
                if (!api) return;
                const picked = await api.workspace.selectFolder();
                if (picked) setFolderPath(picked);
              }}
              style={pickBtnStyle}
            >
              {locale === "ko" ? "선택…" : "Choose…"}
            </button>
            {folderPath && (
              <button type="button" onClick={() => setFolderPath("")} style={pickBtnStyle}>
                {locale === "ko" ? "지우기" : "Clear"}
              </button>
            )}
          </div>
        </Field>

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button
            onClick={() => void submit()}
            disabled={!name.trim() || busy}
            style={{
              padding: "10px 18px",
              borderRadius: "var(--radius-md)",
              background: name.trim() && !busy ? "var(--paper)" : "var(--paper-2)",
              color: name.trim() && !busy ? "var(--ink)" : "var(--muted-deep)",
              fontWeight: 600,
              fontSize: 13,
              border: "1px solid var(--paper-edge)",
              boxShadow: name.trim() && !busy ? "var(--neu-raised)" : "none",
            }}
          >
            {busy ? t("project.btn.creating") : t("project.btn.create")}
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

const pickBtnStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink-soft)",
  whiteSpace: "nowrap",
  flexShrink: 0,
};
