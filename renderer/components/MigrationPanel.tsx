// 설정 > 마이그레이션 — OpenClaw / Hermes에서 가져오기.
// scan으로 디스크 preview(이름/개수만)를 받고, import로 적용. 시크릿 값은 표시 안 함.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  MigrationResult,
  MigrationSourceKind,
  MigrationSourcePreview,
} from "@/lib/types";

export function MigrationPanel() {
  const { t, locale } = useT();
  const [sources, setSources] = useState<MigrationSourcePreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<MigrationSourceKind | null>(null);
  const [results, setResults] = useState<Record<string, MigrationResult>>({});

  const scan = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSources(await api.migration.scan());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function runImport(kind: MigrationSourceKind) {
    const api = ipc();
    if (!api) return;
    setBusy(kind);
    try {
      const res = await api.migration.import({ source: kind, overwrite, importKeys: true, locale });
      setResults((r) => ({ ...r, [kind]: res }));
      await scan();
    } finally {
      setBusy(null);
    }
  }

  const available = sources.filter((s) => s.available);

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 4px" }}>
        {t("migration.title")}
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
        {t("migration.desc")}
      </p>

      {loading ? (
        <div style={{ fontSize: 13, color: "var(--muted-deep)" }}>{t("migration.scanning")}</div>
      ) : available.length === 0 ? (
        <div
          style={{
            padding: 12,
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            color: "var(--muted-deep)",
            fontSize: 13,
          }}
        >
          {t("migration.empty")}
          <br />
          {t("migration.empty.paths")}
        </div>
      ) : (
        <>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--ink-soft)",
              marginBottom: 12,
            }}
          >
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            {t("migration.overwrite")}
          </label>

          {available.map((s) => (
            <div
              key={s.kind}
              style={{
                padding: 14,
                marginBottom: 12,
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                background: "var(--paper)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <strong style={{ fontSize: 14, flexShrink: 0 }}>{s.label}</strong>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--muted-deep)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.rootPath}
                </span>
              </div>

              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "10px 0",
                  fontSize: 12.5,
                  color: "var(--ink-soft)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <li>
                  • {t("migration.agent")}: <strong>{s.agent?.name ?? "—"}</strong>
                  {s.agent ? ` (${Math.round(s.agent.personaBytes / 1024)}KB)` : ""}
                </li>
                <li>
                  • {t("migration.api_keys", { count: s.apiKeys.length })}
                  {s.apiKeys.length > 0 && (
                    <span style={{ color: "var(--muted-deep)" }}>
                      {" "}
                      — {s.apiKeys.map((k) => k.envKey).join(", ")}
                    </span>
                  )}
                </li>
                <li>
                  • {t("migration.automation_memory", {
                    automations: s.automations,
                    memories: s.memories,
                  })}
                </li>
              </ul>

              <button
                onClick={() => void runImport(s.kind)}
                disabled={busy === s.kind}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius-md)",
                  background: busy === s.kind ? "var(--paper-2)" : "var(--paper)",
                  color: busy === s.kind ? "var(--muted-deep)" : "var(--ink)",
                  fontWeight: 600,
                  fontSize: 12.5,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: busy === s.kind ? "none" : "var(--neu-raised)",
                }}
              >
                {busy === s.kind
                  ? t("migration.importing")
                  : t("migration.import_from", { label: s.label })}
              </button>

              {results[s.kind] && <ResultNote result={results[s.kind]} />}
            </div>
          ))}
        </>
      )}
    </>
  );
}

function ResultNote({ result }: { result: MigrationResult }) {
  const { t } = useT();
  const ok = result.agentImported || result.keysImported.length > 0;
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        background: ok ? "rgba(168,217,155,0.16)" : "var(--paper-2)",
        fontSize: 12,
        color: "var(--ink-soft)",
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {ok ? t("migration.complete") : t("migration.no_changes")}
      </div>
      <div style={{ color: "var(--muted-deep)", marginTop: 2 }}>
        {t("migration.result", {
          agents: result.agentImported ? 1 : 0,
          keys: result.keysImported.length,
          automations: result.automationsImported,
        })}
      </div>
      {result.warnings.map((w, i) => (
        <div key={i} style={{ color: "var(--amber-deep, var(--muted-deep))", marginTop: 4 }}>
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}
